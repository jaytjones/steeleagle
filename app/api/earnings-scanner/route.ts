// ============================================================
// SteelEagle — Earnings Scanner API Route
// GET /api/earnings-scanner
// GET /api/earnings-scanner?crisis=true   → force crisis protocol (manual toggle)
//
// Builds one EarningsScannerCell per watchlist name:
//   cache (soonest future report) → entry window → for names inside the
//   entry horizon: near-dated chain → ATM straddle → expected move →
//   post-earnings expiration → earnings condor → gate.
//
// Tier 3 short-circuits to TIER3_BLOCKED (no fetch). Account context
// (positions + BPR + equity) is fetched once and shared across cells.
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getAccountSnapshot } from '@/lib/schwab/accounts'
import {
  getEarningsChain,
  extractAtmStraddle,
  type ExpirationSlice,
} from '@/lib/schwab/earnings-chain'
import { getUpcomingEarnings } from '@/lib/db/earnings'
import { hadRecentCoreStop } from '@/lib/db/journal'
import {
  reconstructPositions,
  type ReconstructedPosition,
} from '@/lib/strategy/reconstruct-positions'
import { computeBprUtilization, type BprUtilization } from '@/lib/strategy/bpr'
import {
  allWatchlistSymbols,
  tradeableSymbols,
  tierOf,
} from '@/lib/strategy/earnings-watchlist'
import { entryWindow } from '@/lib/strategy/earnings-entry-window'
import { computeExpectedMove } from '@/lib/strategy/expected-move'
import { buildEarningsCondor, selectPostEarningsExpiration } from '@/lib/strategy/earnings-condor'
import { computeEarningsGate } from '@/lib/strategy/earnings-gate'
import type { EarningsEvent } from '@/lib/earnings/finnhub'
import type { EarningsScannerCell, EarningsStatus } from '@/lib/earnings/scanner-types'

// Build a setup + run the gate only when the report is this close (calendar days).
const ENTRY_HORIZON_DAYS = 7

export async function GET(request: NextRequest) {
  const manualCrisis = request.nextUrl.searchParams.get('crisis') === 'true'
  const now = new Date()
  const today = now.toISOString().split('T')[0]

  // --- Account context (fetched once, shared) -------------------------------
  let positions: ReconstructedPosition[] = []
  let bprUtil: BprUtilization | null = null
  let equity = 0
  let accountError: string | null = null
  try {
    const { positions: raw, balances } = await getAccountSnapshot()
    positions = reconstructPositions(raw)
    bprUtil = computeBprUtilization(positions, balances)
    equity = balances.liquidationValue
  } catch (err) {
    accountError = err instanceof Error ? err.message : String(err)
    console.error('Earnings scanner — account snapshot failed:', accountError)
  }

  // Crisis protocol = manual toggle OR exact auto-detect from the trade journal
  // (§8.4): did the core take a stop-loss in the last 7 days? This replaces the
  // old open-stop proxy (detectCoreStop) — a closed-trade event the positions
  // endpoint can't see (addendum §A2). Falls back to false if the query fails so
  // a journal hiccup never silently suppresses the whole earnings scan.
  let autoCoreStop = false
  try {
    autoCoreStop = await hadRecentCoreStop(7)
  } catch (err) {
    console.error(
      'Earnings scanner — crisis journal query failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
  const crisisActive = manualCrisis || autoCoreStop

  // --- Cache (soonest future report per tradeable name) ---------------------
  const eventMap = new Map<string, EarningsEvent>()
  try {
    const events = await getUpcomingEarnings({ symbols: tradeableSymbols(), asOfDate: today })
    for (const ev of events) eventMap.set(ev.symbol, ev)
  } catch (err) {
    console.error('Earnings scanner — cache read failed:', err instanceof Error ? err.message : String(err))
  }

  const cells: EarningsScannerCell[] = []

  for (const symbol of allWatchlistSymbols()) {
    const tier = tierOf(symbol)

    // Defensive: allWatchlistSymbols() never yields an off-watchlist name, but
    // this narrows tier to 1 | 2 | 3 for the type checker.
    if (tier === null) {
      cells.push(blankCell(symbol, 'NO_DATA', { note: 'off watchlist' }))
      continue
    }

    // Tier 3 — never tradeable, no fetch.
    if (tier === 3) {
      cells.push(blankCell(symbol, 'TIER3_BLOCKED', { blockReasons: ['Tier 3 — never tradeable'] }))
      continue
    }

    const event = eventMap.get(symbol) ?? null
    if (!event) {
      cells.push(blankCell(symbol, 'NO_DATA', { note: accountError ? 'account context unavailable' : 'no upcoming earnings cached' }))
      continue
    }

    const daysUntil = daysBetween(today, event.reportDate)
    const ew = entryWindow(event.reportDate, event.session, now)

    // Outside the horizon: countdown only, no chain fetch.
    if (daysUntil > ENTRY_HORIZON_DAYS) {
      cells.push(blankCell(symbol, 'NO_EARNINGS_SOON', {
        nextEarnings: event,
        daysUntil,
        entryWindowLabel: ew.label,
      }))
      continue
    }

    // Within horizon: build a setup and run the gate.
    try {
      const cell = await buildCell({ symbol, tier, event, daysUntil, ew, positions, bprUtil, equity, crisisActive })
      cells.push(cell)
    } catch (err) {
      cells.push(blankCell(symbol, 'NO_DATA', {
        nextEarnings: event,
        daysUntil,
        entryWindowLabel: ew.label,
        note: `scan failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }

  return NextResponse.json({
    cells,
    crisis: { active: crisisActive, manual: manualCrisis, autoCoreStop },
    accountError,
    timestamp: new Date().toISOString(),
  })
}

// --------------------------------------------------------
// Per-cell build (within the entry horizon)
// --------------------------------------------------------

async function buildCell(args: {
  symbol: string
  tier: 1 | 2
  event: EarningsEvent
  daysUntil: number
  ew: ReturnType<typeof entryWindow>
  positions: ReconstructedPosition[]
  bprUtil: BprUtilization | null
  equity: number
  crisisActive: boolean
}): Promise<EarningsScannerCell> {
  const { symbol, tier, event, daysUntil, ew, positions, bprUtil, equity, crisisActive } = args

  const base = {
    symbol,
    tier,
    nextEarnings: event,
    daysUntil,
    entryWindowLabel: ew.label,
  }

  const chain = await getEarningsChain(symbol)
  if (!chain) {
    return blankCell(symbol, 'NO_DATA', { ...base, note: 'option chain unavailable' })
  }

  // Sanity-check: is there a qualifying 1–7 DTE weekly AFTER the report?
  const pick = selectPostEarningsExpiration(
    chain.expirations.map((e: ExpirationSlice) => ({ date: e.date, dte: e.dte })),
    event.reportDate,
  )
  if (!pick) {
    return blankCell(symbol, 'BLOCKED', { ...base, blockReasons: ['No qualifying post-earnings weekly (1–7 DTE)'] })
  }

  const slice = chain.expirations.find((e: ExpirationSlice) => e.date === pick.date)
  if (!slice) {
    return blankCell(symbol, 'BLOCKED', { ...base, blockReasons: ['Post-earnings expiration slice missing'] })
  }

  const straddle = extractAtmStraddle(slice, chain.underlyingPrice)
  if (!straddle) {
    return blankCell(symbol, 'BLOCKED', { ...base, blockReasons: ['ATM straddle unavailable for expected move'] })
  }

  const expectedMove = computeExpectedMove({
    symbol,
    expiration: pick.date,
    underlyingPrice: chain.underlyingPrice,
    atmCallMid: straddle.atmCallMid,
    atmPutMid: straddle.atmPutMid,
  })
  if (!expectedMove) {
    return blankCell(symbol, 'BLOCKED', { ...base, expectedMove: null, blockReasons: ['Could not compute expected move'] })
  }

  const setup = buildEarningsCondor({
    chain: {
      symbol,
      underlyingPrice: chain.underlyingPrice,
      expiration: pick.date,
      dte: pick.dte,
      calls: slice.calls,
      puts: slice.puts,
    },
    expectedMove,
    tier,
  })
  if (!setup) {
    return blankCell(symbol, 'BLOCKED', { ...base, expectedMove, blockReasons: ['Could not construct a valid condor (strikes/credit)'] })
  }

  const gate = computeEarningsGate({
    positions,
    bprUtil,
    symbol,
    equity,
    prospectiveBprDollars: setup.bpr,
    crisisActive,
  })

  let status: EarningsStatus
  if (gate.status === 'BLOCKED') {
    status = 'BLOCKED'
  } else if (ew.status === 'ENTER_NOW') {
    status = 'ENTER_NOW'
  } else {
    status = 'UPCOMING' // UPCOMING or PAST entry window — the label carries the truth
  }

  return {
    ...base,
    status,
    expectedMove,
    setup,
    gate,
    blockReasons: gate.status === 'BLOCKED' ? gate.reasons : [],
    note: null,
  }
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function blankCell(
  symbol: string,
  status: EarningsStatus,
  overrides: Partial<EarningsScannerCell> = {},
): EarningsScannerCell {
  return {
    symbol,
    tier: tierOf(symbol),
    status,
    nextEarnings: null,
    daysUntil: null,
    entryWindowLabel: '',
    expectedMove: null,
    setup: null,
    gate: null,
    blockReasons: [],
    note: null,
    ...overrides,
  }
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO}T12:00:00Z`).getTime()
  const b = new Date(`${toISO}T12:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}
