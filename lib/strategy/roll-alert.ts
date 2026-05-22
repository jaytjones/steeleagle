// lib/strategy/roll-alert.ts
//
// v1.3 — Item 6: Roll Alert.
//
// Strategy §5 (Adjustments): "If one side is tested (price touches your 16Δ short
// strike), roll the untested side closer to the money (e.g. from 16Δ to 30Δ). This
// collects more premium and moves your break-even point further out on the tested side."
//
// Operative definition (per Session 5): a short leg is "tested" once its live |delta|
// drifts up to ~30Δ (it was opened at ~16Δ). When exactly one short is tested, we
// recommend rolling the *untested* short up toward ~30Δ.
//
// This module is PURE: it decides given already-fetched deltas. The live `/quotes`
// fetch lives in lib/schwab/quotes.ts and is invoked by the positions route.

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Tested short |delta| at/above this → recommend rolling the untested side. */
export const ROLL_TRIGGER_DELTA = 0.30;
/** Approaching the trigger: surface a WATCH (no action yet). */
export const ROLL_WATCH_DELTA = 0.27;
/** Suggested target |delta| to roll the untested short toward. */
export const ROLL_TARGET_DELTA = 0.30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RollSide = 'PUT' | 'CALL';

export type RollStatus =
  | 'ROLL' // exactly one side tested → roll the other
  | 'WATCH' // a short is approaching the trigger
  | 'BOTH_TESTED' // both shorts tested → no clean roll; manual review
  | 'NO_DELTA' // missing/stale/after-hours deltas → cannot decide
  | 'NONE'; // nothing to do

/**
 * Structural shape of the position fields this module needs. A
 * `ReconstructedPosition` (lib/strategy/reconstruct-positions.ts) satisfies this
 * structurally — its legs already carry `occSymbol` from OCC parsing, which is the
 * key used to match live deltas back to legs.
 */
export interface RollInputLeg {
  action: 'BUY' | 'SELL';
  type: RollSide;
  occSymbol: string;
}

export interface RollInputPosition {
  symbol: string;
  /** Reconstruction type. Roll logic only applies to four-leg condors. */
  type: 'IRON_CONDOR' | 'VERTICAL_SPREAD' | 'OTHER' | string;
  legs: RollInputLeg[];
}

/** Live delta for one short leg, keyed by OCC symbol. null when unavailable. */
export interface ShortDelta {
  occSymbol: string;
  /** Signed delta from /quotes; null/0/NaN when unavailable (after-hours/stale). */
  delta: number | null;
}

export interface RollVerdict {
  symbol: string;
  status: RollStatus;
  /** Side that breached the trigger. */
  testedSide: RollSide | null;
  /** Side to roll (the untested short). */
  rollSide: RollSide | null;
  /** |delta| of the tested short, for display. */
  testedDelta: number | null;
  /** |delta| of the untested short, for display. */
  untestedDelta: number | null;
  /** Suggested target |delta| for the rolled side. */
  targetDelta: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A delta is usable only if it's a finite, non-zero number. Schwab returns 0 for
 * greeks after hours (same class as the IV=0 bug), so treat 0 as unavailable. */
function usable(delta: number | null | undefined): delta is number {
  return typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) > 1e-9;
}

function absDelta(
  legs: RollInputLeg[],
  side: RollSide,
  deltas: Map<string, number | null>,
): number | null {
  const leg = legs.find((l) => l.action === 'SELL' && l.type === side);
  if (!leg) return null;
  const d = deltas.get(leg.occSymbol);
  return usable(d) ? Math.abs(d) : null;
}

function none(symbol: string, status: RollStatus, note: string): RollVerdict {
  return {
    symbol,
    status,
    testedSide: null,
    rollSide: null,
    testedDelta: null,
    untestedDelta: null,
    targetDelta: ROLL_TARGET_DELTA,
    note,
  };
}

const fmt = (d: number | null) => (d === null ? '—' : `${(d * 100).toFixed(0)}Δ`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether an open condor needs a roll, given freshly-fetched short deltas.
 *
 * @param position  reconstructed open position (only condors are actionable)
 * @param shortDeltas live deltas for the position's short legs (by OCC symbol)
 */
export function computeRollAlert(
  position: RollInputPosition,
  shortDeltas: ShortDelta[],
): RollVerdict {
  // Roll mechanics only apply to a full four-leg condor (two shorts).
  if (position.type !== 'IRON_CONDOR') {
    return none(position.symbol, 'NONE', 'Roll logic applies to iron condors only.');
  }

  const deltas = new Map<string, number | null>(
    shortDeltas.map((s) => [s.occSymbol, s.delta]),
  );

  const putAbs = absDelta(position.legs, 'PUT', deltas);
  const callAbs = absDelta(position.legs, 'CALL', deltas);

  const testedPut = putAbs !== null && putAbs >= ROLL_TRIGGER_DELTA;
  const testedCall = callAbs !== null && callAbs >= ROLL_TRIGGER_DELTA;

  // Both shorts tested — the underlying has whipsawed through both. Rolling the
  // "untested" side is undefined; flag for manual review rather than guess.
  if (testedPut && testedCall) {
    return {
      symbol: position.symbol,
      status: 'BOTH_TESTED',
      testedSide: null,
      rollSide: null,
      testedDelta: Math.max(putAbs, callAbs),
      untestedDelta: Math.min(putAbs, callAbs),
      targetDelta: ROLL_TARGET_DELTA,
      note: `Both shorts tested (P ${fmt(putAbs)}, C ${fmt(callAbs)}) — no clean roll; review/close.`,
    };
  }

  // One side tested → roll the other. This holds even if the untested side's delta
  // is missing: we still know which side to roll.
  if (testedPut || testedCall) {
    const testedSide: RollSide = testedPut ? 'PUT' : 'CALL';
    const rollSide: RollSide = testedPut ? 'CALL' : 'PUT';
    const testedDelta = testedPut ? putAbs : callAbs;
    const untestedDelta = testedPut ? callAbs : putAbs;
    return {
      symbol: position.symbol,
      status: 'ROLL',
      testedSide,
      rollSide,
      testedDelta,
      untestedDelta,
      targetDelta: ROLL_TARGET_DELTA,
      note: `Short ${testedSide} tested at ${fmt(testedDelta)} — roll untested ${rollSide} toward ${fmt(ROLL_TARGET_DELTA)} for more premium and a wider break-even on the tested side.`,
    };
  }

  // Neither tested. If a delta is missing we can't confirm "safe" — defer.
  if (putAbs === null || callAbs === null) {
    return none(
      position.symbol,
      'NO_DELTA',
      'Live deltas unavailable (after-hours/stale) — no roll alert.',
    );
  }

  // Approaching the trigger?
  const watchPut = putAbs >= ROLL_WATCH_DELTA;
  const watchCall = callAbs >= ROLL_WATCH_DELTA;
  if (watchPut || watchCall) {
    const side: RollSide = putAbs >= callAbs ? 'PUT' : 'CALL';
    const d = side === 'PUT' ? putAbs : callAbs;
    return {
      symbol: position.symbol,
      status: 'WATCH',
      testedSide: side,
      rollSide: null,
      testedDelta: d,
      untestedDelta: side === 'PUT' ? callAbs : putAbs,
      targetDelta: ROLL_TARGET_DELTA,
      note: `Short ${side} approaching trigger at ${fmt(d)} (roll at ${fmt(ROLL_TRIGGER_DELTA)}).`,
    };
  }

  return none(
    position.symbol,
    'NONE',
    `Both shorts within range (P ${fmt(putAbs)}, C ${fmt(callAbs)}).`,
  );
}

/** Symbols whose positions currently warrant a roll (for the alert banner). */
export function summarizeRollAlerts(verdicts: RollVerdict[]): string[] {
  return verdicts.filter((v) => v.status === 'ROLL').map((v) => v.symbol);
}

/** Short badge label for a position row, or null when no badge should show. */
export function rollBadge(verdict: RollVerdict): string | null {
  switch (verdict.status) {
    case 'ROLL':
      return 'ROLL';
    case 'BOTH_TESTED':
      return 'REVIEW';
    case 'WATCH':
      return 'WATCH';
    default:
      return null;
  }
}
