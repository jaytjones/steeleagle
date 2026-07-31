/**
 * lib/strategy/override-gate.ts — v2.5 operator override on ALL verdicts (pure, no I/O)
 *
 * April's standing request (7/27, sharpened 7/30, FAIL confirmed 7/31): every
 * scanner card offers the logged override, no matter what blocked it — strategy
 * filters (FAIL), missing IV history (CALIBRATING), position/pillar caps, or the
 * BPR ceiling. The warnings are never hidden; the override proceeds PAST them.
 *
 * Before v2.5 the placement panel rendered only on a PASS card
 * (`{condor.passesFilter && <PlaceOrderPanel …>}`), so FAIL and CALIBRATING had
 * no override path at all — there was no button to press. `computeEntryGate`
 * encoded the same assumption by short-circuiting to OK whenever the filters
 * hadn't passed.
 *
 * THE POINT OF THIS MODULE: the UI's "do I have to type a reason?" and the
 * journal's "what rules did she override?" must be the same answer, computed
 * once. Same doctrine as `isPriceableStructure` — ONE predicate, so the gate and
 * the audit record can never disagree about what was overridden.
 */

import type { EntryGateStatus } from './entry-gate';

/**
 * Trading days of IV history required before IV Rank means anything.
 *
 * Owned HERE, by a pure module, rather than in `iv-rank.ts` — that file imports
 * the DB client, so anything importing the constant from there would drag SQL
 * into a unit test. `iv-rank.ts` consumes this instead.
 */
export const MIN_IV_HISTORY_DAYS = 20;

/** What the scanner concluded about a card, before any override. */
export type ScanVerdict = 'PASS' | 'FAIL' | 'CALIBRATING';

export interface OverrideRequirement {
  verdict: ScanVerdict;
  /** True when placing this setup requires the typed-reason override flow. */
  required: boolean;
  /**
   * Every rule being overridden, verbatim and in the order the operator sees
   * them: strategy-filter reasons first, then entry-gate blocks. Stamped into
   * the journal exactly as-is — the v2.1 contract is that an override records
   * what was violated in the system's own words, not a summary.
   */
  violations: string[];
  /**
   * True when the verdict rests on ABSENT data rather than data that failed.
   *
   * CALIBRATING differs in kind from FAIL and drives different UI: a FAIL has a
   * real IV Rank that lost to the threshold, while CALIBRATING has no IV Rank at
   * all. The card must say "UNKNOWN (n days)" rather than render a number that
   * does not exist — overriding this one means placing genuinely blind on IV.
   */
  dataMissing: boolean;
}

export function overrideRequirement(args: {
  /** `condor.passesFilter` — all strategy filters cleared. */
  passesFilter: boolean;
  /** `condor.filterReasons` — verbatim, already operator-readable. */
  filterReasons: string[];
  /** `ivRank.daysOfHistory` — distinguishes CALIBRATING from a real FAIL. */
  daysOfHistory: number;
  /** Position-limit / BPR verdict. Absent on a card with no setup. */
  entryGate?: { status: EntryGateStatus; reasons: string[] } | null;
}): OverrideRequirement {
  const { passesFilter, filterReasons, daysOfHistory, entryGate } = args;

  const verdict: ScanVerdict = passesFilter
    ? 'PASS'
    : daysOfHistory < MIN_IV_HISTORY_DAYS
      ? 'CALIBRATING'
      : 'FAIL';

  const gateBlocked = entryGate?.status === 'BLOCKED';

  // A TIGHT gate is a caution, not a block — it never forces the override flow
  // (it is surfaced on the card either way). Only BLOCKED does.
  const required = verdict !== 'PASS' || gateBlocked;

  const violations = [
    ...filterReasons,
    ...(gateBlocked ? (entryGate?.reasons ?? []) : []),
  ];

  return {
    verdict,
    required,
    // Never let an override be recorded with an empty violation list: the
    // journal entry would say "override" with nothing overridden. If we somehow
    // require one without a reason to hand, say so rather than stamp silence.
    violations:
      required && violations.length === 0
        ? ['Entry blocked — no specific reason reported']
        : violations,
    dataMissing: verdict === 'CALIBRATING',
  };
}

/**
 * How the IV Rank tile reads for a given card.
 *
 * CALIBRATING deliberately returns UNKNOWN rather than the `0` that
 * `calculateIVRank` returns as a placeholder — showing "0.0%" would be a number
 * April could act on, and it is not a measurement. Decided 2026-07-31 alongside
 * the IV-history rebuild, where every card is CALIBRATING for ~20 trading days.
 */
export function ivRankDisplay(ivRank: {
  ivRank: number;
  daysOfHistory: number;
}): { kind: 'unknown'; days: number } | { kind: 'value'; pct: number } {
  return ivRank.daysOfHistory < MIN_IV_HISTORY_DAYS
    ? { kind: 'unknown', days: ivRank.daysOfHistory }
    : { kind: 'value', pct: ivRank.ivRank };
}
