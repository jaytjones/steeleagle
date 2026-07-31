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
  /**
   * v2.2 — Schwab order id of the standing GTC 50%-profit exit; null = no
   * standing exit on record. Bookkeeping, not truth: the sweep verifies
   * against fetched order state every run (spec §6.4). Cleared on close.
   */
  exitOrderId: string | null
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

/**
 * v2.2.1 — a value the operator must have EXPLICITLY entered.
 *
 * The Session 15 journal corruption came from `Number('') === 0`: three blank
 * price fields reached the DB as three real $0.00 close events. $0.00 is a
 * legitimate close price (a worthless 5Δ long genuinely closes at zero), so
 * the rule can't be "reject zero" — it's "reject absent". The forms therefore
 * put `null` on the wire for a blank field, and these schemas refuse it
 * (z.number rejects null / undefined / NaN alike).
 */
const enteredPrice = z
  .number({ error: 'Enter a fill price for every leg — $0.00 is allowed, blank is not' })
  .nonnegative('Must be zero or positive')

const enteredStrike = z
  .number({ error: 'Enter a strike for every leg' })
  .positive('Strike must be positive')

/**
 * v2.3.2 — buying-power reduction, which must be explicitly entered AND
 * positive. Note the deliberate asymmetry with `enteredPrice`: $0.00 is a
 * legitimate PRICE (a worthless long really does close at zero), but a
 * four-leg condor always reduces buying power, so 0 is never a real BPR — it
 * only ever means "not filled in yet".
 *
 * Two places already treated it that way before this rule existed: the at-fill
 * path floors it at $0.01 (`recordFillAction`), and `ImportCandidate.initialBpr`
 * documents its 0 default as a placeholder the operator sets on the review card.
 * A 0 here silently under-counts capital in the position-limit and BPR gates.
 */
const enteredBpr = z
  .number({ error: 'Enter the buying-power reduction — 0 is not a real BPR' })
  .positive('BPR must be greater than zero')

/**
 * One leg of an entry/roll/close, as typed by the operator.
 *
 * v2.3.2 — `strike` and `price` are HARDENED HERE, at the base, so any future
 * writer that extends this schema inherits "explicitly entered" by default
 * rather than opting in. CloseEventSchema and RollEventSchema restate the same
 * two fields; that redundancy is intentional (each carries its own milestone's
 * documentation) and is pinned by close-schema/roll-schema tests.
 *
 * Do NOT relax these back to bare `z.number()` — all three journal write paths
 * (entry, roll, close) depend on `Number('') → 0` being unrepresentable.
 */
export const LegInputSchema = z.object({
  leg: z.enum(LEGS),
  strike: enteredStrike,
  expiration: isoDate,
  // Delta is optional metadata; signed (puts negative, calls positive).
  delta: z.number().min(-1).max(1).nullable().default(null),
  price: enteredPrice, // per-share fill price
  creditDebit: z.enum(CREDIT_DEBIT),
  notes: z.string().trim().max(2000).optional(),
})
export type LegInput = z.infer<typeof LegInputSchema>

/**
 * A new four-leg iron-condor entry.
 *
 * v2.3.2 hardening — the last of the three journal write paths to get it. The
 * entry form coerced `Number('') → 0` exactly as the close and roll forms did,
 * and this one is the highest-stakes of the three: a $0.00 entry leg corrupts
 * `initialCredit` -> `netCredit` -> `profitTargetBuyback`, and that is the price
 * the sweep places the standing 50% GTC at. A blank here mis-prices a LIVE
 * working order at Schwab, not just the history.
 *
 * `strike`/`price` are hardened by LegInputSchema; `initialBpr` and `contracts`
 * are hardened here.
 */
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
  contracts: z
    .number({ error: 'Enter the number of contracts' })
    .int('Contracts must be a whole number')
    .positive('Contracts must be at least 1')
    .default(1),
  initialBpr: enteredBpr,
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
 * v2.3.2 — the New Trade form's wire shape, deliberately NOT NewTradeInput.
 *
 * Every numeric the operator types is null while its field is blank, so
 * NewTradeSchema can tell "absent" from an explicit value. Never widen this to
 * NewTradeInput: doing so reintroduces the `Number('') → 0` coercion the
 * hardening exists to prevent. Same posture as CloseDraftLeg / RollDraftLeg —
 * one pattern, now covering all three journal write paths.
 */
export interface NewTradeLegDraft {
  leg: Leg
  strike: number | null
  expiration: string
  delta: number | null
  price: number | null
  creditDebit: CreditDebit
}

export interface NewTradeDraft {
  symbol: string
  sleeve: Sleeve
  openedAt: string
  initialExpiration: string
  contracts: number | null
  initialBpr: number | null
  notes?: string
  legs: NewTradeLegDraft[]
}

/**
 * A roll: buy back the legs being replaced (roll_close) and open the
 * replacements (roll_open). The operator submits the affected legs with the
 * correct event_type. Typically a one-sided roll touches 2 legs, a full roll
 * touches all 8 — we accept 2…8.
 *
 * v2.3.1 hardening — strike and price must be explicitly entered, exactly as
 * the close path demands (see `enteredPrice`). The roll form coerced
 * `Number('') → 0` on the same wire the Close form did, so a blank price filed
 * a $0.00 roll leg silently. $0.00 is legal, blank is not.
 */
export const RollEventSchema = LegInputSchema.extend({
  eventType: z.enum(['roll_close', 'roll_open']),
  strike: enteredStrike,
  price: enteredPrice,
})
export type RollEventInput = z.infer<typeof RollEventSchema>

/**
 * v2.3.1 — the roll-leg invariant, derived from `currentStructure`'s fold.
 *
 * The close form's rule (exactly four legs, each role once) does NOT map to a
 * roll: a one-sided roll touches 2 legs and a full roll touches 8, so the rows
 * stay dynamic. The right invariant comes from what the fold in
 * lib/journal/current-structure.ts does with one atomic batch — closes vacate a
 * role, then opens fill it:
 *
 *  1. Duplicate (eventType, leg) inside one roll. A second `roll_close` on a
 *     role throws downstream ("already closed"); a second `roll_open` silently
 *     LAST-WINS, quietly discarding a leg the operator entered. Both are
 *     ambiguous — refuse at entry rather than discover it at GTC-placement time.
 *
 *  2. A `roll_open` with no matching `roll_close` in the same roll. The fold
 *     overwrites a live leg with no record of the old one being closed, so the
 *     reconstructed structure silently loses a position. Refuse.
 *
 *  3. A `roll_close` with no matching `roll_open` is ALLOWED (decided 2026-07-30
 *     with April). It leaves the role vacant, which `currentStructure` refuses
 *     loudly and the sweep degrades to a MANUAL GTC chip — already fail-safe —
 *     and it is the only way to journal a one-sided unwind, since Record Close
 *     closes the whole trade.
 */
export const RollTradeSchema = z
  .object({
    occurredAt: z.string().datetime({ offset: true }),
    // The new expiration if the position was rolled out in time; null = same expiry.
    newExpiration: isoDate.nullable().default(null),
    notes: z.string().trim().max(2000).optional(),
    events: z
      .array(RollEventSchema)
      .min(2, 'A roll touches at least 2 legs')
      .max(8, 'A roll touches at most 8 legs'),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>()
    const closed = new Set<Leg>()
    for (const ev of val.events) {
      if (ev.eventType === 'roll_close') closed.add(ev.leg)
    }

    val.events.forEach((ev, i) => {
      const key = `${ev.eventType}:${ev.leg}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'leg'],
          message: `Duplicate ${ev.eventType} on ${ev.leg} — a roll records each leg once per side`,
        })
      }
      seen.add(key)

      if (ev.eventType === 'roll_open' && !closed.has(ev.leg)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'leg'],
          message:
            `Opening ${ev.leg} without closing it in the same roll would overwrite the ` +
            `live leg — add the matching roll_close row`,
        })
      }
    })
  })
export type RollTradeInput = z.infer<typeof RollTradeSchema>

/**
 * v2.3.1 — the Roll form's wire shape, deliberately NOT RollTradeInput.
 *
 * `strike`/`price` are null while a field is blank so RollTradeSchema can tell
 * "absent" from an explicit (legal) $0.00. Never widen this to RollTradeInput:
 * doing so reintroduces the `Number('') → 0` coercion the hardening exists to
 * prevent. Identical posture to CloseDraftLeg — one pattern, two paths.
 */
export interface RollDraftLeg {
  eventType: 'roll_close' | 'roll_open'
  leg: Leg
  strike: number | null
  expiration: string
  delta: number | null
  price: number | null
  creditDebit: CreditDebit
}

export interface RollTradeDraft {
  occurredAt: string
  newExpiration: string | null
  notes?: string
  events: RollDraftLeg[]
}

/**
 * A final close: buy back / let expire the remaining legs.
 *
 * v2.2.1 hardening — strike and price must be explicitly entered (see
 * `enteredPrice`). A worthless leg is recorded at $0.00, never as a blank.
 */
export const CloseEventSchema = LegInputSchema.extend({
  eventType: z.literal('close').default('close'),
  strike: enteredStrike,
  price: enteredPrice,
})
export type CloseEventInput = z.infer<typeof CloseEventSchema>

/**
 * v2.2.1 — a close records ALL FOUR condor legs, each role exactly once.
 *
 * The pre-2.2.1 schema accepted 0…4 legs so an expired-worthless exit could
 * be filed with no legs at all; that same latitude let a partially-filled
 * form through. An expiry is now journaled as four $0.00 close events —
 * accounting-identical (amount 0 moves no total) but a complete leg record,
 * and it collapses the rule to one unconditional shape with no soft edge.
 *
 * Both writers satisfy this: closeInputFromFilledExit already refuses
 * anything but 4 uniquely-roled legs, and the Close form has fixed rows.
 */
export const CloseTradeSchema = z
  .object({
    occurredAt: z.string().datetime({ offset: true }),
    closeReason: z.enum(CLOSE_REASONS),
    notes: z.string().trim().max(2000).optional(),
    events: z
      .array(CloseEventSchema)
      .length(
        4,
        'A close records all four condor legs — a leg that expired worthless is $0.00, not a missing row',
      ),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<Leg>()
    val.events.forEach((ev, i) => {
      if (seen.has(ev.leg)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'leg'],
          message: `Duplicate ${ev.leg} leg — a close records each condor leg exactly once`,
        })
      }
      seen.add(ev.leg)
    })
  })
export type CloseTradeInput = z.infer<typeof CloseTradeSchema>

/**
 * v2.2.1 — the Close form's wire shape, deliberately NOT CloseTradeInput.
 *
 * `strike`/`price` are null while a field is blank so CloseTradeSchema can
 * tell "absent" from "$0.00". Never widen this to CloseTradeInput: doing so
 * reintroduces the coercion the hardening exists to prevent.
 */
export interface CloseDraftLeg {
  eventType: 'close'
  leg: Leg
  strike: number | null
  expiration: string
  delta: number | null
  price: number | null
  creditDebit: CreditDebit
}

export interface CloseTradeDraft {
  occurredAt: string
  closeReason: CloseReason
  notes?: string
  events: CloseDraftLeg[]
}

// --------------------------------------------------------
// v2.2.1 — closed-trade edit
//
// Repairs a mis-keyed close WITHOUT hand-written SQL. Deliberately narrow:
// only `close` events whose source is 'manual', only on a trade already
// closed. Entry and roll legs carry live-data provenance and are never
// editable here; neither is anything Schwab filled (source 'schwab_fill').
// Structure (leg / strike / expiration / contracts) is immutable — an edit
// fixes what was typed wrong, it does not restate the position.
// --------------------------------------------------------

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Malformed event id',
  )

export const EditCloseEventSchema = z.object({
  id: uuid,
  price: enteredPrice,
  creditDebit: z.enum(CREDIT_DEBIT),
  occurredAt: z.string().datetime({ offset: true }),
})
export type EditCloseEventInput = z.infer<typeof EditCloseEventSchema>

export const EditClosedTradeSchema = z.object({
  closedAt: z.string().datetime({ offset: true }),
  closeReason: z.enum(CLOSE_REASONS),
  // Nullable (not optional): an edit may deliberately clear the notes, so the
  // DB layer assigns rather than COALESCEs.
  notes: z.string().trim().max(2000).nullable(),
  // 0…4: a legacy close may have fewer than four legs, and an edit may touch
  // only some of them. Which ids are actually editable is decided by
  // planCloseEdit against the live event log, never by the client.
  events: z.array(EditCloseEventSchema).max(4, 'A close has at most four legs'),
})
export type EditClosedTradeInput = z.infer<typeof EditClosedTradeSchema>

/** The edit form's wire shape — `price` is null while the field is blank. */
export interface EditCloseDraftLeg {
  id: string
  price: number | null
  creditDebit: CreditDebit
  occurredAt: string
}

export interface EditClosedTradeDraft {
  closedAt: string
  closeReason: CloseReason
  notes: string | null
  events: EditCloseDraftLeg[]
}

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
