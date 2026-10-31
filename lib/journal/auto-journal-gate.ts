// ============================================================
// SteelEagle — v2.15 the auto-journal GATE (pure — no I/O)
//
// Extracted verbatim from auto-close.ts (v2.14) when rolls became the second
// consumer. ONE gate predicate, two planners — the `isPriceableStructure`
// doctrine: if the close path and the roll path each carried their own copy of
// "is tonight proven?", the day one is tightened and the other is not is the
// day an unproven interval writes to the journal.
//
// The gate is a ZERO RESIDUAL for the interval, all or nothing — never
// classifier confidence. See auto-close.ts for why, and for what the gate does
// NOT prove (completeness, not correctness).
// ============================================================

/** The interval the residual proof covers, half-open as `(from, to]`. */
export interface AutoJournalInterval {
  from: Date
  to: Date
}

/**
 * The balance status the auto-journal will act on. Anything else — `RESIDUAL`,
 * `UNRELIABLE`, `UNANCHORED`, or a null block because ingestion threw — shuts
 * the gate. Stated as a whitelist so a new status cannot silently open it.
 */
export const GATE_STATUS = 'BALANCED'

export type GateDecision =
  | { gate: 'OPEN'; gateReason: string; interval: AutoJournalInterval }
  | { gate: 'CLOSED'; gateReason: string }

/** Is tonight's interval proven? Always says why, either way. */
export function gateDecision(
  interval: AutoJournalInterval | null,
  balanceStatus: string | null,
): GateDecision {
  if (interval === null) {
    return {
      gate: 'CLOSED',
      gateReason:
        'no interval — the ingestion pass produced no anchored window, so nothing is proven',
    }
  }
  if (balanceStatus !== GATE_STATUS) {
    return {
      gate: 'CLOSED',
      gateReason:
        `the position identity is ${balanceStatus ?? 'UNKNOWN'}, not ${GATE_STATUS} — ` +
        `some contract movement in this interval is unexplained, so EVERYTHING from it ` +
        `goes to the inbox`,
    }
  }
  return {
    gate: 'OPEN',
    gateReason: `the position identity is ${GATE_STATUS} for this interval`,
    interval,
  }
}

/** Executions land in the interval, half-open as `(from, to]` — as sumEffects. */
export function inInterval(occurredAt: string, interval: AutoJournalInterval): boolean {
  const at = Date.parse(occurredAt)
  if (Number.isNaN(at)) return false
  return at > interval.from.getTime() && at <= interval.to.getTime()
}
