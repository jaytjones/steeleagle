// ============================================================
// SteelEagle — Trade Journal domain types + input validation
// One logical trade (the full iron-condor lifecycle) with an
// append-only event log. A roll mutates the trade; it is not a new
// trade. See docs/steeleagle-session-8-addendum.md §A2.
// ============================================================

import { z } from 'zod'

// --------------------------------------------------------
// Enumerations (mirror the SQL check constraints)
// --------------------------------------------------------

// The earnings sleeve was removed in v2.1.1 with zero historical earnings
// rows, so the enum collapses to core outright. If a second sleeve ever
// returns, reintroduce it here + in the trades.sleeve CHECK together.
export const SLEEVES = ['core'] as const
export type Sleeve = (typeof SLEEVES)[number]

export const TRADE_STATUSES = ['open', 'closed'] as const
export type TradeStatus = (typeof TRADE_STATUSES)[number]

export const CLOSE_REASONS = [
  'profit_target',
  'stop_loss',
  '21_dte',
  'manual',
  'expired',
] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]

export const EVENT_TYPES = ['open', 'close', 'roll_close', 'roll_open'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const LEGS = ['long_put', 'short_put', 'short_call', 'long_call'] as const
export type Leg = (typeof LEGS)[number]

export const CREDIT_DEBIT = ['credit', 'debit'] as const
export type CreditDebit = (typeof CREDIT_DEBIT)[number]

export const EVENT_SOURCES = ['manual', 'schwab_fill'] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

// --------------------------------------------------------
// Read models (returned by the DB layer / API)
// --------------------------------------------------------

export interface TradeEvent {
  id: string
  tradeId: string
  eventType: EventType
  leg: Leg
  strike: number
  expiration: string // YYYY-MM-DD
  delta: number | null
  contracts: number
  price: number
  creditDebit: CreditDebit
  amount: number // always positive; sign comes from creditDebit
  source: EventSource
  schwabOrderId: string | null
  occurredAt: string // ISO
  notes: string | null
  createdAt: string // ISO
}

export interface Trade {
  id: string
  symbol: string
  sleeve: Sleeve
  status: TradeStatus
  openedAt: string // ISO
  closedAt: string | null
  initialExpiration: string // YYYY-MM-DD
  currentExpiration: string // YYYY-MM-DD
  initialCredit: number
  totalCreditCollected: number
  totalDebitPaid: number
  initialBpr: number
  contracts: number
  closeReason: CloseReason | null
  notes: string | null
  createdAt: string
  updatedAt: string
  events: TradeEvent[]
}

// --------------------------------------------------------
// Write models — validated with zod at the action boundary.
//
// The operator enters legs by per-share `price` and a credit/debit
// direction; the DB layer derives `amount = price × 100 × contracts`
// and the trade-level credit/debit running totals. We never trust a
// client-supplied amount or total.
// --------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')

const positiveMoney = z.number().nonnegative('Must be zero or positive')

/** One leg of an entry/roll/close, as typed by the operator. */
export const LegInputSchema = z.object({
  leg: z.enum(LEGS),
  strike: z.number().positive('Strike must be positive'),
  expiration: isoDate,
  // Delta is optional metadata; signed (puts negative, calls positive).
  delta: z.number().min(-1).max(1).nullable().default(null),
  price: positiveMoney, // per-share fill price
  creditDebit: z.enum(CREDIT_DEBIT),
  notes: z.string().trim().max(2000).optional(),
})
export type LegInput = z.infer<typeof LegInputSchema>

/** A new four-leg iron-condor entry. */
export const NewTradeSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((s) => s.toUpperCase()),
  sleeve: z.enum(SLEEVES),
  openedAt: z.string().datetime({ offset: true }),
  initialExpiration: isoDate,
  contracts: z.number().int().positive().default(1),
  initialBpr: positiveMoney,
  notes: z.string().trim().max(2000).optional(),
  // Provenance for the resulting `open` events. Optional: the manual form omits
  // both and the DB layer defaults to 'manual' / null. The Schwab importer
  // (Session 10) tags matched candidates as 'schwab_fill' and threads the
  // originating order id.
  source: z.enum(EVENT_SOURCES).optional(),
  schwabOrderId: z.string().nullable().optional(),
  // Exactly the four condor legs, each event_type = 'open'.
  legs: z.array(LegInputSchema).length(4, 'An iron condor needs exactly 4 legs'),
})
export type NewTradeInput = z.infer<typeof NewTradeSchema>

/**
 * A roll: buy back the legs being replaced (roll_close) and open the
 * replacements (roll_open). The operator submits the affected legs with the
 * correct event_type. Typically a one-sided roll touches 2 legs, a full roll
 * touches all 8 — we accept 2…8.
 */
export const RollEventSchema = LegInputSchema.extend({
  eventType: z.enum(['roll_close', 'roll_open']),
})
export type RollEventInput = z.infer<typeof RollEventSchema>

export const RollTradeSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  // The new expiration if the position was rolled out in time; null = same expiry.
  newExpiration: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).optional(),
  events: z
    .array(RollEventSchema)
    .min(2, 'A roll touches at least 2 legs')
    .max(8, 'A roll touches at most 8 legs'),
})
export type RollTradeInput = z.infer<typeof RollTradeSchema>

/** A final close: buy back / let expire the remaining legs. */
export const CloseEventSchema = LegInputSchema.extend({
  eventType: z.literal('close').default('close'),
})
export type CloseEventInput = z.infer<typeof CloseEventSchema>

export const CloseTradeSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  closeReason: z.enum(CLOSE_REASONS),
  notes: z.string().trim().max(2000).optional(),
  // 'expired' worthless closures may carry zero legs (nothing bought back).
  events: z.array(CloseEventSchema).max(4),
})
export type CloseTradeInput = z.infer<typeof CloseTradeSchema>

// ============================================================
// Schwab Position Importer (Session 10 — v1.5.1)
//
// One-time bootstrap that pulls open iron condors from Schwab and
// pre-populates the journal via createTrade(). The types below are the
// importer pipeline's intermediate and response shapes. The grouping /
// matching logic lives in lib/journal/importer.ts (pure, unit-tested).
// ============================================================

/** Fidelity of price data available for an import candidate. */
export type ImportConfidence = 'matched' | 'marks_only'

/**
 * A single option leg as parsed from the Schwab positions response.
 * Intermediate type used only inside the importer pipeline.
 */
export interface RawPositionLeg {
  occSymbol: string // e.g. "SPY   250117C00580000"
  underlying: string // e.g. "SPY"
  putCall: 'PUT' | 'CALL'
  strike: number
  expiration: string // "YYYY-MM-DD"
  longQty: number
  shortQty: number
  averagePrice: number // per-share fill average from the Schwab position
}

export interface ImportLeg {
  action: 'BUY' | 'SELL'
  putCall: 'PUT' | 'CALL'
  strike: number
  /** Per-share price. From order-history fill when matched; averagePrice fallback. */
  price: number
  /** Retained from the source position so enrichWithOrderHistory can match by OCC symbol. */
  occSymbol: string
}

/**
 * A 4-leg iron condor candidate assembled from position legs,
 * optionally enriched with order-history fill data.
 */
export interface ImportCandidate {
  /** Unique key for React rendering and confirmation tracking. e.g. "SPY-2025-01-17". */
  candidateId: string
  underlying: string
  expiration: string // "YYYY-MM-DD"
  contracts: number // quantity (all legs assumed equal)

  longPut: ImportLeg
  shortPut: ImportLeg
  shortCall: ImportLeg
  longCall: ImportLeg

  /**
   * 'matched'    — prices from order history; openDate from order enteredTime.
   * 'marks_only' — prices from averagePrice on position; openDate is null.
   */
  confidence: ImportConfidence
  openDate: string | null // ISO date string (YYYY-MM-DD); null when marks_only
  schwabOrderId: number | null // populated when confidence = 'matched'
  /** True when the condor was opened as two separate spread orders. */
  splitOrder: boolean
  /**
   * Buying-power reduction for the position. Schwab positions don't carry
   * a per-condor BPR, so this defaults to 0 and is set by the operator on the
   * review card before import (feeds position-limit math).
   */
  initialBpr: number
}

export interface IncompletePosition {
  underlying: string
  expiration: string
  legsFound: number // 1, 2, or 3 (or 5+ leftover)
  reason: string // human-readable explanation
}

/** The full response shape of GET /api/journal/import-candidates. */
export interface ImportCandidatesResponse {
  candidates: ImportCandidate[]
  /** Positions that had option legs but didn't form a clean 4-leg condor. */
  incomplete: IncompletePosition[]
  /** Candidates already present in the journal (matched by underlying + expiration). */
  alreadyImported: ImportCandidate[]
  /**
   * True when no order history was available (fetch failed or empty), so every
   * candidate fell back to position averages. Drives the review-panel banner.
   */
  ordersUnavailable: boolean
}

/**
 * Result of importTradesAction. Deviates from the spec's `Trade[]` return so the
 * UI can report partial success (§7: each createTrade is its own transaction, so
 * a mid-batch failure leaves earlier imports committed).
 */
export interface ImportResult {
  /** The refreshed full trade list after the batch. */
  trades: Trade[]
  importedCount: number
  /** Candidates that failed to import, with the error message for the console. */
  failed: { candidateId: string; error: string }[]
}
