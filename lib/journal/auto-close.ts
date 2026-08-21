// ============================================================
// SteelEagle — v2.14 gated auto-journal, CLOSES ONLY (pure — no I/O)
//
// v2.11 step 8, discharged for one event type. Decides WHICH filled closes the
// cron may journal without JJ clicking anything. Writes nothing itself; the
// route does the I/O, per the build pattern.
//
// ── What is genuinely new here ──
//
// The sweep has auto-journaled closes since v2.2, but only for a GTC IT placed
// and recorded the id of: `planExitSweep` reaches `toReconcile` solely through
// `trade.exitOrderId`. That is how trade e368b294 closed hands-off on
// 2026-08-19 (L4). Every close JJ did in TOS has always needed a card and a
// click.
//
// This is that second case, and it is the one with no order id to lean on.
//
// SCOPE, decided by JJ 2026-08-20: **closes only.** Rolls to be revisited.
// Entries are structurally impossible to complete — `initialBpr` is not in the
// order payload and `enteredBpr` refuses 0 — so Import remains their path.
//
// ── The gate: a ZERO RESIDUAL for the interval, all or nothing ──
//
// Bounded by the accounting identity, never by classifier confidence. If ANY
// contract movement in the interval is unexplained, NOTHING from that interval
// is written and every candidate falls back to the inbox. That is the whole
// design of v2.11 step 8 and it is not re-litigated here.
//
// ── What the gate does NOT prove, and why that shapes the scope ──
//
// A zero residual proves COMPLETENESS: every contract that moved is explained
// by an order we can see. It proves nothing about whether we LABELLED that
// order correctly — a roll and a close-plus-open have identical position
// arithmetic, so both balance equally well. The gate bounds which orders are
// ELIGIBLE; it never checks the interpretation.
//
// That asymmetry is the argument for closes first. A close is the one shape
// whose misreading announces itself: if the app closes a trade whose legs are
// still held, the very next sweep sees the position and the reconciler reports
// a DRIFT. There is no equivalent self-check for a mislabelled roll.
//
// It is also why the eligibility window is the INTERVAL and not the inbox's
// 7 days (`ACTIONABLE_WINDOW_DAYS`). Today's proof covers (anchor, now]. A
// close from five days ago is a perfectly good inbox card and is NOT covered
// by tonight's residual, so it is never auto-written.
//
// ── Refusals ──
//
// Same posture as everywhere else on a write path: ambiguous or partial data
// refuses and leaves state intact. The refusals here are deliberately narrow
// and each one has a live case behind it:
//
//   MORE THAN ONE OWNING TRADE — key-collision site (c). Two same-strike
//     condors are a supported workflow (GLD 2026-09-18: $455 and $414 credits,
//     separate 50% targets), Schwab aggregates the positions, and nothing in
//     the fill says which lot closed. `matchFill` picks the first and shows a
//     card; a WRITE must not. See `closeOwners`.
//
//   CONTRACT COUNT MISMATCH — the GLD shape from the other direction: a 1-lot
//     close against a 2-lot journal trade. Step (a) has refused this since
//     v2.2 and so does this.
//
// A candidate that refuses is NOT lost — it stays exactly where it already
// was, as an inbox card. Refusals are reported so that "nothing to do" and
// "declined to act" can never render identically (v2.9), but they are not
// flagged a second time: the card is already the delivery surface, and a
// duplicate critical for something already on screen is the wallpaper hazard.
//
// ── The close REASON is `manual`, and that is not a placeholder ──
//
// Step (a) records `profit_target` because it is closing a GTC the sweep
// itself priced at the 50% target. Here the app knows only that JJ closed the
// position; it does not know WHY. The journal is the only record of intent
// (v2.8), so inferring `profit_target` from the numbers would be fabricating
// exactly the field the journal exists to hold. `manual` is the true statement:
// closed by hand, numbers read off the fill.
// ============================================================

import type { FillClassification } from './classify-fill'
import { closeOwners, type MatchTrade } from './match-fill'

/**
 * The ledger row, structurally — so `StoredFill` satisfies it without this
 * module importing the DB layer.
 *
 * `disposition` is carried because it is THE OPERATOR'S JUDGEMENT column, and
 * an automatic write must never override a judgement JJ has already made. Only
 * `pending` is eligible: `journaled` says the work is done, and `dismissed`
 * says she looked at it and decided it needs nothing. Nothing sets it today —
 * `setFillDisposition` has no callers yet — so honouring it costs nothing now
 * and stops a future Dismiss button from silently not working.
 */
export interface AutoCloseFill {
  classification: FillClassification
  disposition: string
}

/** The interval the residual proof covers, half-open as `(from, to]`. */
export interface AutoCloseInterval {
  from: Date
  to: Date
}

export interface AutoCloseWrite {
  orderId: string
  tradeId: string
  symbol: string
  /** Contracts the fill closed — equal to the trade's, or it would have refused. */
  contracts: number
}

export interface AutoCloseRefusal {
  orderId: string
  tradeId: string | null
  reason: string
}

export interface AutoClosePlan {
  /** OPEN = the residual proof holds and the interval is known. */
  gate: 'OPEN' | 'CLOSED'
  /** Always populated — a closed gate must say which condition failed. */
  gateReason: string
  write: AutoCloseWrite[]
  refused: AutoCloseRefusal[]
  /** Filled closes inside the interval that were looked at. Never a task count. */
  considered: number
}

/**
 * The balance status this module will act on. Anything else — `RESIDUAL`,
 * `UNRELIABLE`, `UNANCHORED`, or a null block because ingestion threw — shuts
 * the gate. Stated as a whitelist so a new status cannot silently open it.
 */
const GATE_STATUS = 'BALANCED'

/** Only a fully-filled four-leg close is a candidate. */
function isFilledClose(fill: FillClassification): boolean {
  return (
    fill.shape === 'CONDOR_CLOSE' &&
    fill.filled &&
    fill.status === 'FILLED' &&
    fill.refusals.length === 0
  )
}

/** Executions land in the interval, half-open as `(from, to]` — as sumEffects. */
function inInterval(occurredAt: string, interval: AutoCloseInterval): boolean {
  const at = Date.parse(occurredAt)
  if (Number.isNaN(at)) return false
  return at > interval.from.getTime() && at <= interval.to.getTime()
}

/**
 * Which filled closes may be journaled without the operator.
 *
 * `trades` must be ALL trades, open and closed, and must be read AFTER the
 * exit sweep's own reconcile step — a trade that step (a) just closed is no
 * longer open, so it falls out here with no special case.
 *
 * Never throws. A malformed fill refuses; it cannot take down the batch.
 */
export function planAutoCloses(input: {
  fills: readonly AutoCloseFill[]
  trades: readonly MatchTrade[]
  interval: AutoCloseInterval | null
  balanceStatus: string | null
}): AutoClosePlan {
  const empty = { write: [], refused: [], considered: 0 }

  if (input.interval === null) {
    return {
      ...empty,
      gate: 'CLOSED',
      gateReason:
        'no interval — the ingestion pass produced no anchored window, so nothing is proven',
    }
  }
  if (input.balanceStatus !== GATE_STATUS) {
    return {
      ...empty,
      gate: 'CLOSED',
      gateReason:
        `the position identity is ${input.balanceStatus ?? 'UNKNOWN'}, not ${GATE_STATUS} — ` +
        `some contract movement in this interval is unexplained, so EVERYTHING from it ` +
        `goes to the inbox`,
    }
  }

  const write: AutoCloseWrite[] = []
  const refused: AutoCloseRefusal[] = []
  let considered = 0

  for (const row of input.fills) {
    // The operator's judgement outranks the gate, in both directions.
    if (row.disposition !== 'pending') continue

    const fill = row.classification
    if (!isFilledClose(fill)) continue
    if (!inInterval(fill.occurredAt, input.interval)) continue
    considered++

    const owners = closeOwners(fill, input.trades)

    // No open trade holds these legs. Already journaled, closed under other
    // strikes, or never imported — all inbox questions, none of them ours.
    if (owners.length === 0) continue

    if (owners.length > 1) {
      refused.push({
        orderId: fill.orderId,
        tradeId: null,
        reason:
          `${owners.length} open journal trades hold these legs ` +
          `(${owners.map((t) => t.id.slice(0, 8)).join(', ')}) — nothing in the fill says ` +
          `which one closed. Journal it by hand; auto-journal will not guess between ` +
          `same-strike trades.`,
      })
      continue
    }

    const trade = owners[0]
    if (fill.contracts !== trade.contracts) {
      refused.push({
        orderId: fill.orderId,
        tradeId: trade.id,
        reason:
          `the fill closed ${fill.contracts} contract(s) but trade ${trade.id.slice(0, 8)} ` +
          `(${trade.symbol}) holds ${trade.contracts} — a partial close is never journaled ` +
          `automatically. Use the Close form.`,
      })
      continue
    }

    write.push({
      orderId: fill.orderId,
      tradeId: trade.id,
      symbol: trade.symbol,
      contracts: fill.contracts,
    })
  }

  return {
    gate: 'OPEN',
    gateReason: `the position identity is ${GATE_STATUS} for this interval`,
    write,
    refused,
    considered,
  }
}

/** One line for the sweep report. Never empty, and never silent about a refusal. */
export function summarizeAutoClose(plan: AutoClosePlan): string {
  if (plan.gate === 'CLOSED') return `auto-journal held: ${plan.gateReason}`
  const parts = [`${plan.write.length} close(s) journaled automatically`]
  if (plan.refused.length > 0) parts.push(`${plan.refused.length} refused (left in the inbox)`)
  if (plan.write.length === 0 && plan.refused.length === 0) {
    return `auto-journal ran with nothing to do — ${plan.considered} filled close(s) in the interval`
  }
  return parts.join(' · ')
}
