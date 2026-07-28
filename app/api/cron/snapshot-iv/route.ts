// ============================================================
// SteelEagle — Daily IV Snapshot Cron (+ v2.2 Exit Sweep)
// GET /api/cron/snapshot-iv
// Runs at 4:15 PM ET Mon–Fri via Vercel Cron.
//
// Duty 1 — IV snapshot (v1.0, UNTOUCHED): one ATM-IV row per tracked
// symbol. Runs FIRST and is isolated from the sweep — exit failures can
// never drop IV rows (spec §4.3).
//
// Duty 2 — Exit sweep (v2.2): reconcile filled GTC exits into the
// journal, clear terminal ones, alert at ≤21 DTE, place missing
// 50%-profit GTC closes. One wholesale /orders fetch per run; all
// decisions come from the pure planner (lib/strategy/exit-sweep, unit-
// tested); this route is glue + per-item isolation only.
//
// The response payload is the audit record (visible in Vercel logs).
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db/client'
import { marketGet } from '@/lib/schwab/client'
import { getUserSettings } from '@/lib/db/settings'
import { getAccountHash } from '@/lib/schwab/accounts'
import {
  getOrder,
  getWorkingAndRecentOrders,
  placeOrder,
  type SchwabOrderDetail,
} from '@/lib/schwab/orders'
import {
  digestOrderForSweep,
  hasRollEvents,
  planExitSweep,
  type SweepTradeInput,
} from '@/lib/strategy/exit-sweep'
import {
  buildCondorExitTicket,
  computeExitDebit,
  exitInputFromOpenEvents,
} from '@/lib/schwab/exit-ticket'
import { closeInputFromFilledExit } from '@/lib/journal/close-from-fill'
import {
  clearExitOrderId,
  closeTrade,
  listTrades,
  setExitOrderId,
} from '@/lib/db/journal'
import { CloseTradeSchema } from '@/lib/journal/types'
import type { Trade } from '@/lib/journal/types'
import type { OptionChain } from '@/types'

// Strategic defaults — the v1.4 strategy's five-pillar instrument set.
// Always included regardless of user settings.
const DEFAULT_CRON_SYMBOLS: string[] = [
  // Equities
  'SPY', 'QQQ', 'IWM', 'DIA', 'EFA', 'EEM',
  // Fixed Income
  'TLT', 'IEF', 'HYG', 'LQD',
  // Commodities
  'GLD', 'SLV', 'USO', 'DBA',
  // Volatility
  'VXX', 'UVXY', 'SVXY',
  // Currencies
  'UUP', 'FXY', 'FXE', 'FXB',
  // Indices (v2.4 Phase 0 — calibration clock; equity block at build time)
  'XSP', 'SPX', 'NDX', 'RUT',
]

// v2.4 Phase 0 shim — canonical ($-free) symbol → Schwab market-data symbol.
// Probe-verified 2026-07-27: /chains and /quotes accept ONLY the $-prefixed
// form for indices (bare 'SPX' and '$SPX.X' both 400). iv_history stores the
// canonical symbol; the $ exists only at this fetch boundary. This map is
// absorbed into lib/strategy/instruments.ts (apiSymbol) in the v2.4 build.
const INDEX_API_SYMBOLS: Record<string, string> = {
  XSP: '$XSP',
  SPX: '$SPX',
  NDX: '$NDX',
  RUT: '$RUT',
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const symbols = await resolveSymbols()
  const results: Record<string, string> = {}
  const today = new Date().toISOString().split('T')[0]

  // ---- Duty 1: IV snapshot (unchanged) ----
  for (const symbol of symbols) {
    try {
      // $-translation happens ONLY here; `symbol` (canonical) is what gets
      // written to iv_history and printed in results.
      const apiSymbol = INDEX_API_SYMBOLS[symbol] ?? symbol
      const chain = await marketGet<OptionChain>('/chains', {
        symbol: apiSymbol,
        contractType: 'ALL',
        strikeCount: '1',
        includeUnderlyingQuote: 'true',
        optionType: 'S',
      })

      const underlyingPrice = chain.underlyingPrice
      let atmIv: number | null = null

      const callExpirations = Object.keys(chain.callExpDateMap)
      if (callExpirations.length > 0) {
        const strikes = Object.values(chain.callExpDateMap[callExpirations[0]])
        if (strikes.length > 0 && strikes[0].length > 0) {
          atmIv =
            strikes[0][0].volatility ??
            strikes[0][0].impliedVolatility ??
            null
        }
      }

      if (atmIv === null) {
        results[symbol] = 'skipped — no IV data'
        continue
      }

      await sql`
        INSERT INTO iv_history (symbol, snapshot_date, atm_iv, underlying_price)
        VALUES (${symbol}, ${today}, ${atmIv}, ${underlyingPrice})
        ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
          atm_iv = EXCLUDED.atm_iv,
          underlying_price = EXCLUDED.underlying_price
      `

      results[symbol] = `ok — IV: ${(atmIv * 100).toFixed(1)}%, price: ${underlyingPrice}`
    } catch (err) {
      results[symbol] = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  console.log('IV Snapshot results:', results)

  // ---- Duty 2: exit sweep, fully isolated (spec §4.3) ----
  const exitSweep = await runExitSweep()
  console.log('Exit sweep results:', JSON.stringify(exitSweep))

  return NextResponse.json({ date: today, results, exitSweep })
}

// --------------------------------------------------------
// Exit sweep runner — glue only; every decision lives in the pure,
// unit-tested planner. Per-item try/catch throughout: one trade's
// failure never blocks another's reconcile/placement.
// --------------------------------------------------------

interface ExitSweepReport {
  reconciled: Array<{ tradeId: string; symbol: string; orderId: string }>
  cleared: Array<{ tradeId: string; orderId: string; reason: string }>
  alerts: Array<{ tradeId: string; symbol: string; dte: number; message: string }>
  placed: Array<{ tradeId: string; symbol: string; orderId: string; price: string }>
  flagged: Array<{ tradeId: string; orderId: string | null; reason: string }>
  errors: string[]
}

async function runExitSweep(): Promise<ExitSweepReport> {
  const report: ExitSweepReport = {
    reconciled: [],
    cleared: [],
    alerts: [],
    placed: [],
    flagged: [],
    errors: [],
  }

  let hash: string
  let rawOrders: SchwabOrderDetail[]
  let openTrades: Trade[]
  try {
    // Step 0 — the single wholesale fetch (spec §4.3). This THROWS on
    // failure rather than degrading to []: an empty set would read as
    // "no working orders" and permit duplicate placements. Auth death
    // lands here too → the whole sweep degrades to one errors[] entry
    // (ReauthBanner is the operator-facing surface, §5.6).
    hash = await getAccountHash()
    rawOrders = await getWorkingAndRecentOrders(hash)
    openTrades = await listTrades({ status: 'open' })
  } catch (err) {
    report.errors.push(
      `sweep aborted before planning: ${err instanceof Error ? err.message : String(err)}`,
    )
    return report
  }

  const orderStates = rawOrders.map(digestOrderForSweep)
  const orderById = new Map(rawOrders.map((o) => [String(o.orderId), o]))
  const tradeById = new Map(openTrades.map((t) => [t.id, t]))

  const sweepInputs: SweepTradeInput[] = openTrades.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    currentExpiration: t.currentExpiration,
    exitOrderId: t.exitOrderId,
    hasRollEvents: hasRollEvents(t.events),
  }))

  const plan = planExitSweep(sweepInputs, orderStates, new Date())

  // Planner-emitted alerts and flags pass straight through to the report.
  report.alerts.push(...plan.toAlert)
  report.flagged.push(...plan.toFlag)

  // ---- (a) RECONCILE: journal confirmed fills, duty order first ----
  for (const item of plan.toReconcile) {
    try {
      const trade = tradeById.get(item.tradeId)
      const order = orderById.get(item.orderId)
      if (!trade || !order) throw new Error('trade/order vanished between plan and execution')

      const fill = closeInputFromFilledExit(order)
      if (fill.contracts !== trade.contracts) {
        report.flagged.push({
          tradeId: trade.id,
          orderId: item.orderId,
          reason:
            `fill contracts (${fill.contracts}) ≠ trade contracts (${trade.contracts}) ` +
            `on ${trade.symbol} — not journaling; resolve via the Close form`,
        })
        continue
      }

      const input = CloseTradeSchema.parse({
        occurredAt: fill.occurredAt,
        closeReason: 'profit_target',
        events: fill.events,
      })
      await closeTrade(trade.id, input, {
        source: 'schwab_fill',
        schwabOrderId: item.orderId,
      })
      report.reconciled.push({ tradeId: trade.id, symbol: trade.symbol, orderId: item.orderId })
    } catch (err) {
      report.errors.push(
        `reconcile ${item.orderId} → trade ${item.tradeId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ---- (a cont.) CLEAR: Schwab reported the order dead ----
  for (const item of plan.toClear) {
    try {
      await clearExitOrderId(item.tradeId)
      report.cleared.push(item)
    } catch (err) {
      report.errors.push(
        `clear ${item.orderId} on trade ${item.tradeId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ---- (c) PLACE: new 50%-target GTC exits ----
  for (const item of plan.toPlace) {
    try {
      const trade = tradeById.get(item.tradeId)
      if (!trade) throw new Error('trade vanished between plan and execution')

      const input = exitInputFromOpenEvents(trade.symbol, trade.events)
      const price = computeExitDebit(
        trade.totalCreditCollected,
        trade.totalDebitPaid,
        trade.contracts,
      )
      const ticket = buildCondorExitTicket(input, {
        quantity: trade.contracts,
        debit: Number(price),
      })

      const { orderId } = await placeOrder(hash, ticket)

      // Immediate status confirm — the id is stored only from an order
      // Schwab reports as live (or already filled). Never assume (§4.3).
      let confirmed: SchwabOrderDetail
      try {
        confirmed = await getOrder(hash, orderId)
      } catch (err) {
        report.flagged.push({
          tradeId: trade.id,
          orderId,
          reason:
            `GTC ${orderId} on ${trade.symbol} placed but status confirm FAILED — id NOT ` +
            `stored. CHECK THINKORSWIM. (Next sweep's pre-place guard will see it and flag, ` +
            `not duplicate.) Confirm error: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }

      const status = (confirmed.status ?? 'UNKNOWN').toUpperCase()
      if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
        report.flagged.push({
          tradeId: trade.id,
          orderId,
          reason: `GTC ${orderId} on ${trade.symbol} was ${status} immediately after placement — id not stored`,
        })
        continue
      }

      await setExitOrderId(trade.id, orderId)
      report.placed.push({ tradeId: trade.id, symbol: trade.symbol, orderId, price: ticket.price })
    } catch (err) {
      report.errors.push(
        `place exit for trade ${item.tradeId} (${item.symbol}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return report
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

/**
 * Strategic defaults ∪ user_settings.tickers, deduplicated.
 *
 * If user_settings can't be read (transient DB error), falls back to
 * defaults rather than failing the whole cron — better to snapshot
 * the strategic set than nothing for a day.
 */
async function resolveSymbols(): Promise<string[]> {
  try {
    const settings = await getUserSettings()
    return Array.from(new Set([...DEFAULT_CRON_SYMBOLS, ...settings.tickers]))
  } catch (err) {
    console.warn(
      'user_settings read failed; using default cron symbols only:',
      err instanceof Error ? err.message : String(err),
    )
    return DEFAULT_CRON_SYMBOLS
  }
}
