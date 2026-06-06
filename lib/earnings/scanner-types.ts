// ============================================================
// SteelEagle — Earnings Scanner cell types
// Shared by /api/earnings-scanner and the EarningsSection UI so the
// route and the components agree on one shape (v1.4 scoping §3).
// ============================================================

import type { EarningsEvent } from './finnhub'
import type { EarningsCondorSetup } from '@/lib/strategy/earnings-condor'
import type { EarningsGate } from '@/lib/strategy/earnings-gate'
import type { EarningsTier } from '@/lib/strategy/earnings-watchlist'
import type { ExpectedMove } from '@/lib/strategy/expected-move'

export type EarningsStatus =
  | 'NO_EARNINGS_SOON' // have a date, but outside the entry horizon
  | 'UPCOMING' // within horizon, setup built, not yet the entry window
  | 'ENTER_NOW' // in the entry window and the gate is clear
  | 'BLOCKED' // gate failed, or no buildable structure
  | 'TIER3_BLOCKED' // never tradeable
  | 'NO_DATA' // no cached earnings date (cron gap) or chain unavailable

export type EarningsScannerCell = {
  symbol: string
  tier: EarningsTier | null
  status: EarningsStatus
  nextEarnings: EarningsEvent | null
  /** Calendar days from today to the report (null when no date). */
  daysUntil: number | null
  /** Human entry-window label, e.g. "Enter Mon PM (BMO)". */
  entryWindowLabel: string
  expectedMove: ExpectedMove | null
  setup: EarningsCondorSetup | null
  /** Full gate verdict (OK/TIGHT/BLOCKED + diagnostics) when a setup was built. */
  gate: EarningsGate | null
  /** Block / no-trade reasons surfaced on the card. */
  blockReasons: string[]
  /** Non-blocking diagnostic note (chain/account hiccups). */
  note: string | null
}

/** Crisis-protocol state returned by the scanner: manual toggle fused with auto-detect. */
export type CrisisState = {
  /** Effective state used by the gate = manual || autoCoreStop. */
  active: boolean
  /** The user's manual ?crisis toggle. */
  manual: boolean
  /** Auto-detected: an open core position is at/over its stop. */
  autoCoreStop: boolean
}

export type EarningsScanResponse = {
  cells: EarningsScannerCell[]
  crisis: CrisisState
  accountError: string | null
  timestamp: string
}
