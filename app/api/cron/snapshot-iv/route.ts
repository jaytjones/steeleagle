// ============================================================
// SteelEagle — Daily IV Snapshot Cron (+ v2.2 Exit Sweep)
// GET /api/cron/snapshot-iv
// Runs at 21:15 UTC Mon-Fri via Vercel Cron (vercel.json "15 21 * * 1-5").
// Vercel crons are UTC-only. In CT — the operator's timezone — that is
// 4:15 PM CDT (75 min after the close) and 3:15 PM CST (15 min after).
// Docs before 2026-07-31 called this "4:15 PM ET": the LABEL was wrong,
// not the time. See tech-spec v2-3 §4.0 for the DST margin decision owed
// before November.
//
// Duty 1 — IV snapshot: one ATM-IV row per tracked symbol. Runs FIRST
// and is isolated from the sweep — exit failures can never drop IV rows
// (spec §4.3).
//
// v2.6 (2026-07-31) — REWRITTEN. This carried the "v1.0, UNTOUCHED" label
// from v1.0 through v2.5, and the label was part of the problem: the
// scanner later grew a careful 28–52 DTE / delta-0.50 extraction while
// this loop kept measuring the nearest expiration's first strike, so the
// two sides of the IV Rank formula drifted onto different instruments and
// nobody re-read the code that was marked as settled. It now calls the
// same `getOptionChain` the scanner does. See lib/strategy/iv-basis.ts.
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
import { getUserSettings, type UserSettings } from '@/lib/db/settings'
import { getAccountHash, getAccountSnapshot } from '@/lib/schwab/accounts'
import { reconstructPositions } from '@/lib/strategy/reconstruct-positions'
import { reconcileJournal, summarizeReconciliation } from '@/lib/journal/reconcile'
import {
  getOrder,
  getWorkingAndRecentOrders,
  placeOrder,
  type SchwabOrderDetail,
} from '@/lib/schwab/orders'
import {
  digestOrderForSweep,
  planExitSweep,
  type SweepTradeInput,
} from '@/lib/strategy/exit-sweep'
import { buildCondorExitTicket, computeExitDebit } from '@/lib/schwab/exit-ticket'
// v2.3 — one leg-derivation path. currentStructure folds the WHOLE event log
// (rolls included), so same-expiration rolled trades are now placeable; the
// v2.2 `hasRollEvents` exclusion is gone.
import { currentStructure, structureRefusal } from '@/lib/journal/current-structure'
import { closeInputFromFilledExit } from '@/lib/journal/close-from-fill'
// v2.11 — fill ledger + the position identity. Report-only, isolated; nothing
// in the placement path below reads any of it.
import { classifyFill } from '@/lib/journal/classify-fill'
import { diffPositions, positionsToQty } from '@/lib/journal/position-delta'
import { sumEffects } from '@/lib/journal/order-effects'
import { checkBalance } from '@/lib/journal/balance'
import {
  buildIngestionReport,
  ingestionDidNotRun,
  ingestionFlags,
} from '@/lib/journal/ingest'
import {
  countPendingFills,
  getLatestPositionSnapshot,
  recordPositionSnapshot,
  upsertFills,
} from '@/lib/db/fills'
import {
  clearExitOrderId,
  closeTrade,
  listTrades,
  setExitOrderId,
} from '@/lib/db/journal'
import { getOptionChain } from '@/lib/schwab/chains'
import { IV_BASIS_CURRENT, isSnapshotWorthStoring } from '@/lib/strategy/iv-basis'
import { INSTRUMENTS } from '@/lib/strategy/instruments'
import { CloseTradeSchema } from '@/lib/journal/types'
import type { Trade } from '@/lib/journal/types'
// v2.9 — sweep run visibility.
import { summarizeSweepRun, type ExitSweepReport } from '@/lib/strategy/sweep-report'
import { recordSweepRun } from '@/lib/db/sweep-runs'

// Strategic defaults — the v1.4 strategy's five-pillar instrument set plus the
// four v2.4 indices. Derived from the instrument registry rather than restated,
// so a symbol added to lib/strategy/instruments.ts starts its IV calibration
// clock immediately (IV Rank needs ~20 trading days and there is no backfill —
// a registry entry that ISN'T snapshotted is 20 days of dead time).
//
// v2.4: the Phase 0 INDEX_API_SYMBOLS shim is gone — `apiSymbolFor` in the
// registry is now the one place the `$` prefix is applied (probe-verified
// 2026-07-27: /chains accepts ONLY '$SPX'; bare and '.X' forms both 400).
const DEFAULT_CRON_SYMBOLS: string[] = INSTRUMENTS.map((i) => i.symbol)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // One settings read feeds both duties. FAIL-SAFE DIRECTION: a read
  // failure resolves to NOT paused — a transient DB hiccup must never
  // silently disarm exit placement. Pausing requires a successful read
  // of an explicit true.
  let settings: UserSettings | null = null
  try {
    settings = await getUserSettings()
  } catch (err) {
    console.warn(
      'user_settings read failed; defaults + placement NOT paused:',
      err instanceof Error ? err.message : String(err),
    )
  }

  const symbols = resolveSymbols(settings)
  const placementPaused = settings?.pauseExitPlacement ?? false
  const results: Record<string, string> = {}
  const today = new Date().toISOString().split('T')[0]

  // ---- Duty 1: IV snapshot ----
  //
  // v2.6 — this loop no longer extracts IV itself. It calls the SAME
  // `getOptionChain` the scanner uses, so the stored 52-week range and the
  // live `currentIv` it is compared against are the same measurement: ATM call
  // (delta closest to 0.50) 28–52 DTE out, index chains root-filtered.
  //
  // What it used to do — `strikeCount: 1`, nearest expiration, first strike, no
  // delta selection, no root filter — measured near-expiry IV (often 0–2 DTE),
  // which is numerically unstable. That produced 30 zero rows AND implausible
  // highs (QQQ 141%), and IV Rank was computing across the two incompatible
  // bases. See lib/strategy/iv-basis.ts for the full write-up.
  //
  // `$`-translation now happens inside getOptionChain via apiSymbolFor; the
  // canonical ($-free) `symbol` is what gets written and printed here.
  for (const symbol of symbols) {
    try {
      // Depth only — 10 strikes centred on ATM is ample to pick the 0.50-delta
      // call, and keeps ~29 chain fetches inside one cron invocation sane.
      const chain = await getOptionChain(symbol, { strikeCount: 10 })

      if (!chain) {
        results[symbol] = 'skipped — no chain in the 28–52 DTE window'
        continue
      }

      // The guard the v1.2 risk table always claimed existed but never had.
      // `volatility ?? impliedVolatility ?? 0` means a Schwab-returned 0 is NOT
      // absent — it must be rejected explicitly, or it lands in the table and
      // drags low52w to zero.
      if (!isSnapshotWorthStoring(chain.atmIv)) {
        // Logged distinctly from "no chain" so the Vercel record shows which
        // failure mode is actually occurring.
        results[symbol] = `skipped — IV was ${chain.atmIv} (not a usable measurement)`
        continue
      }

      await sql`
        INSERT INTO iv_history (symbol, snapshot_date, atm_iv, underlying_price, iv_basis)
        VALUES (${symbol}, ${today}, ${chain.atmIv}, ${chain.underlyingPrice}, ${IV_BASIS_CURRENT})
        ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
          atm_iv = EXCLUDED.atm_iv,
          underlying_price = EXCLUDED.underlying_price,
          iv_basis = EXCLUDED.iv_basis
      `

      // `volatility` is ALREADY a percentage — the old line multiplied by 100
      // and printed "1500.0%" for a 15% IV. Logs that read as nonsense are logs
      // nobody sanity-checks, which is part of why this went unnoticed.
      results[symbol] =
        // v2.10 — ivDte, NOT the condor's DTE. This log line documents the
        // measurement basis; printing the tradeable tenor here would make the
        // stored series look like it moved when it did not.
        `ok — IV: ${chain.atmIv.toFixed(1)}% @ ${chain.ivDte} DTE, price: ${chain.underlyingPrice}`
    } catch (err) {
      results[symbol] = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  console.log('IV Snapshot results:', results)

  // ---- Duty 2: exit sweep, fully isolated (spec §4.3) ----
  const exitSweep = await runExitSweep(placementPaused)
  console.log('Exit sweep results:', JSON.stringify(exitSweep))

  // ---- v2.9: persist the run so the dashboard can show it ----
  //
  // Deliberately AFTER runExitSweep and outside it. By the time this executes
  // every order decision is already made and executed, so a DB failure here
  // cannot change what was placed — it can only lose the record of it. That is
  // the correct direction: bookkeeping about bookkeeping must never be able to
  // disturb the live-money path.
  //
  // The summary is stored, not recomputed on read, so the banner's query stays
  // a single indexed row fetch. `ranAt` is stamped by the app rather than
  // defaulted by the DB because it is the instant the REPORT describes, and
  // freshness detection compares it against the cron schedule.
  const sweepSummary = summarizeSweepRun(exitSweep)
  try {
    await recordSweepRun({
      ranAt: new Date(),
      severity: sweepSummary.severity,
      criticalCount: sweepSummary.criticalCount,
      warningCount: sweepSummary.warningCount,
      headline: sweepSummary.headline,
      report: exitSweep,
    })
  } catch (err) {
    // Loud in the log, harmless to the sweep. If this keeps failing the banner
    // goes stale, which `sweepFreshness` renders as an explicit warning rather
    // than as silence — the one outcome that would be worse.
    console.error(
      'sweep_runs insert FAILED — the sweep itself was unaffected:',
      err instanceof Error ? err.message : String(err),
    )
  }

  return NextResponse.json({ date: today, results, exitSweep, sweepSummary })
}

// --------------------------------------------------------
// Exit sweep runner — glue only; every decision lives in the pure,
// unit-tested planner. Per-item try/catch throughout: one trade's
// failure never blocks another's reconcile/placement.
// --------------------------------------------------------

// v2.9 — `ExitSweepReport` now lives in lib/strategy/sweep-report.ts alongside
// the rules that classify it. The report is no longer just this route's return
// value: it is persisted to `sweep_runs` and rendered on the dashboard, because
// between Aug 4 and Aug 6 2026 this sweep correctly detected a live mis-pricing
// on SPY 2026-09-11 three runs running and April never saw any of it. Detection
// was never the problem; delivery was.
//
// Notes that used to live on the fields, kept because they are still the rules:
//  - `flagged.tradeId` is nullable (v2.8): an UNIMPORTED reconciliation finding
//    is about a position with NO journal trade, so there is no id to carry.
//  - `flagged.severity` (v2.9) is stamped at the producer, never inferred from
//    the reason prose — see the wallpaper-hazard note in sweep-report.ts.
//  - `reconciliation.ran: false` is NOT "nothing found" and must never be read
//    as one; an absent warning identical to a clean bill is how the /quotes 404
//    stayed hidden for weeks (v2.6.1).
//  - Reconciliation is FLAG-ONLY (April, 2026-08-04). Nothing below consults
//    `report.reconciliation` when deciding what to place, and nothing may read
//    the `sweep_runs` history for that purpose either.

async function runExitSweep(placementPaused: boolean): Promise<ExitSweepReport> {
  const report: ExitSweepReport = {
    reconciled: [],
    cleared: [],
    alerts: [],
    placed: [],
    flagged: [],
    errors: [],
    placementPaused,
    wouldHavePlaced: [],
    // Pessimistic default: until the check actually completes, it did NOT run.
    reconciliation: {
      ran: false,
      reason: 'reconciliation did not execute',
      critical: 0,
      findings: [],
    },
    // Same posture (v2.11): absent is not clean.
    ingestion: ingestionDidNotRun('ingestion did not execute'),
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

  // ---- v2.8 — journal ⇄ account reconciliation (report-only) ----
  //
  // Isolated in its own try/catch and deliberately NOT part of step 0: this
  // check must never be able to abort a sweep. Reconcile, clear, 21-DTE alerts
  // and placement are the sweep's job; this is an observation about bookkeeping.
  // A positions-fetch failure leaves `ran: false` with the reason — never an
  // empty findings list, which would read as a clean bill.
  //
  // FLAG-ONLY (April, 2026-08-04): nothing below consults `report.reconciliation`
  // when deciding what to place. Keep it that way — see the decision note in
  // lib/journal/reconcile.ts for why blocking was rejected.
  try {
    const { positions: rawPositions } = await getAccountSnapshot()
    const findings = reconcileJournal(
      openTrades,
      reconstructPositions(rawPositions, new Date()),
      new Date(),
    )
    const summary = summarizeReconciliation(findings)
    report.reconciliation = {
      ran: true,
      critical: summary.critical,
      summary: { ...summary },
      // Criticals carry their full detail; the rest are counted, not narrated,
      // so a healthy run does not bury the sweep's own output.
      findings: findings
        .filter((f) => f.severity === 'critical')
        .map((f) => ({
          status: f.status,
          symbol: f.symbol,
          expiration: f.expiration,
          tradeId: f.tradeId,
          detail: f.detail,
        })),
    }
    // Surface criticals where the operator already looks. Prefixed so they are
    // never mistaken for a placement/reconcile failure the sweep itself hit.
    for (const f of report.reconciliation.findings) {
      report.flagged.push({
        tradeId: f.tradeId,
        orderId: null,
        reason: `RECONCILIATION ${f.status} — ${f.symbol} ${f.expiration}: ${f.detail}`,
        // Only criticals reach this loop (findings is filtered to them above).
        severity: 'critical',
      })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    report.reconciliation = {
      ran: false,
      reason,
      critical: 0,
      findings: [],
    }
    report.flagged.push({
      tradeId: null,
      orderId: null,
      reason:
        `RECONCILIATION DID NOT RUN (${reason}) — this is NOT a clean bill of health. ` +
        `The journal was not compared against the account this run; run ` +
        `scripts/reconcile-journal.ts manually.`,
      severity: 'critical',
    })
  }

  // ---- v2.11 — fill-ledger ingestion + the position identity (report-only) ----
  //
  // Isolated exactly as v2.8 is, and for the same reason: this is an
  // OBSERVATION about bookkeeping and must never be able to abort a sweep.
  // Placement decisions below do not read `report.ingestion`, and nothing may
  // read `schwab_fills` or `position_snapshots` for that purpose either.
  //
  // Its own getAccountSnapshot() call, matching the reconciliation block. The
  // two could share one fetch, but hoisting it would couple them: a positions
  // failure in one would silently take out the other, and reconciliation is the
  // older, load-bearing check. An extra read is cheap; entangling two
  // independent safety observations is not.
  //
  // ORDER MATTERS: the anchor is read BEFORE the new snapshot is written, or
  // the identity would diff today against itself and balance trivially.
  try {
    const now = new Date()
    const { positions: rawPositions } = await getAccountSnapshot()
    const current = positionsToQty(rawPositions as unknown[])

    // Ledger every fetched order whatever its STATUS — a REJECTED close on legs
    // that were rolled away is the strongest journal-drift signal the account
    // emits, and the GLD streak (Aug 3–13 2026) ran eleven days unseen. But
    // skip NOT_OPTION: equity and cash activity is not a condor lifecycle event,
    // it only dilutes the inbox, and its `filledQuantity` can be fractional
    // (live order 191708603600 reported 4167.68). Their effects are already nil
    // — `orderEffect` counts OPTION legs only — so the identity is unaffected.
    const upserted = await upsertFills(
      rawOrders.map(classifyFill).filter((c) => c.shape !== 'NOT_OPTION'),
    )

    const anchor = await getLatestPositionSnapshot()

    // null anchor is UNANCHORED, NOT an empty map: empty-vs-empty balances and
    // would manufacture a false completeness proof on the very first run.
    const balance = anchor
      ? (() => {
          const window = { from: new Date(anchor.takenAt), to: now }
          // Bounded by EXECUTION time, never enteredTime — a GTC placed months
          // ago can fill inside this interval.
          const effects = sumEffects(rawOrders, window)
          return checkBalance(
            diffPositions(anchor.symbols, current),
            effects.symbols,
            effects.refusals,
            now,
          )
        })()
      : null

    // Written last: if this throws, the anchor simply does not advance and the
    // next run diffs over a wider interval — which the identity handles, since
    // it is not tied to any particular interval length. Self-healing.
    await recordPositionSnapshot({ takenAt: now, symbols: current })

    report.ingestion = buildIngestionReport({
      anchorAt: anchor?.takenAt ?? null,
      snapshotAt: now.toISOString(),
      inserted: upserted.inserted,
      updated: upserted.updated,
      failed: upserted.failed.length,
      pending: await countPendingFills(),
      balance,
    })

    for (const f of ingestionFlags(report.ingestion)) {
      report.flagged.push({
        tradeId: null,
        orderId: null,
        reason: f.reason,
        severity: f.severity,
      })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    report.ingestion = ingestionDidNotRun(reason)
    for (const f of ingestionFlags(report.ingestion)) {
      report.flagged.push({
        tradeId: null,
        orderId: null,
        reason: f.reason,
        severity: f.severity,
      })
    }
  }

  const orderStates = rawOrders.map(digestOrderForSweep)
  const orderById = new Map(rawOrders.map((o) => [String(o.orderId), o]))
  const tradeById = new Map(openTrades.map((t) => [t.id, t]))

  const sweepInputs: SweepTradeInput[] = openTrades.map((t) => {
    // ONE call, not isPriceableStructure + a second lookup for the message:
    // two calls could in principle disagree, and the flag April reads must be
    // the reason the planner actually acted on.
    const refusal = structureRefusal(t.symbol, t.events)
    return {
      id: t.id,
      symbol: t.symbol,
      currentExpiration: t.currentExpiration,
      exitOrderId: t.exitOrderId,
      priceable: refusal === null,
      unpriceableReason: refusal,
    }
  })

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
          // This is the GLD 2026-09-18 shape: a GTC sized from the journal
          // closing fewer contracts than the account holds. Never routine.
          severity: 'critical',
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
  // Operator pause gate: skips PLACEMENT ONLY — the sole Schwab write in
  // the sweep. Reconcile (a), clear, and 21-DTE alerts (b) above always
  // ran. The planner is untouched; this is a route-level filter on its
  // toPlace output. Withheld candidates are reported with their target
  // debits so the audit trail shows what was NOT placed and why.
  if (placementPaused) {
    for (const item of plan.toPlace) {
      const trade = tradeById.get(item.tradeId)
      let targetDebit: string | null = null
      if (trade) {
        try {
          targetDebit = computeExitDebit(
            trade.totalCreditCollected,
            trade.totalDebitPaid,
            trade.contracts,
          )
        } catch {
          /* pricing failure while paused is report-only — leave null */
        }
      }
      report.wouldHavePlaced.push({ tradeId: item.tradeId, symbol: item.symbol, targetDebit })
    }
    return report
  }

  for (const item of plan.toPlace) {
    try {
      const trade = tradeById.get(item.tradeId)
      if (!trade) throw new Error('trade vanished between plan and execution')

      const input = currentStructure(trade.symbol, trade.events)
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
          severity: 'critical',
        })
        continue
      }

      const status = (confirmed.status ?? 'UNKNOWN').toUpperCase()
      if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
        report.flagged.push({
          tradeId: trade.id,
          orderId,
          reason: `GTC ${orderId} on ${trade.symbol} was ${status} immediately after placement — id not stored`,
          // The Aug 5/6 SPY 2026-09-11 signal, exactly. Schwab rejected a GTC
          // built from a stale journal ("oversold/overbought") and this flag
          // fired correctly both runs — into a log nobody read. Never routine.
          severity: 'critical',
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
 * Settings are read ONCE in GET (shared with the placement-pause flag);
 * null here means the read failed — fall back to defaults rather than
 * failing the whole cron (better the strategic set than nothing).
 */
function resolveSymbols(settings: UserSettings | null): string[] {
  if (!settings) return DEFAULT_CRON_SYMBOLS
  return Array.from(new Set([...DEFAULT_CRON_SYMBOLS, ...settings.tickers]))
}
