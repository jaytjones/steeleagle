/**
 * lib/strategy/position-limits.ts
 *
 * Entry-gate constraints for the scanner cards (PRD v1.3 items 3 & 4 / Strategy v1.4 §4).
 *
 * Given the currently open positions and a prospective symbol, decides whether a new
 * entry is allowed under:
 *   - Global cap:      max 5 concurrent positions.
 *   - Equity block:    SPY/QQQ/IWM/DIA/EFA/EEM + XSP/SPX/NDX/RUT treated as ONE
 *                      block, max 2 simultaneous (v2.4 §7.1 — indices join the
 *                      existing block; the cap itself is unchanged).
 *   - Volatility:      max 1 open at a time.
 *   - Currency:        max 1 open at a time.
 *   - Fixed Income / Commodities: no per-pillar cap (global cap only).
 *
 * v2.4: the symbol→pillar table moved to lib/strategy/instruments.ts (one source
 * of truth for instrument identity). `Pillar` and `pillarOf` are re-exported here
 * so existing importers are unaffected. Positions are counted through the RESOLVED
 * underlying, so an SPXW position counts against the equity block instead of
 * silently bypassing the cap as an unknown-pillar symbol.
 *
 * "Open position" = an Iron Condor or a Vertical Spread (a partial wing still occupies a
 * slot — the Q2 resolution). Everything in the OTHER bucket (equities, money-market funds)
 * is ignored, matching summarizeOpenRisk().slotsUsed.
 *
 * Pure and deterministic — the scanner card runs this alongside the BPR pre-flight.
 */

import type { ReconstructedPosition } from './reconstruct-positions';
import { pillarOf, resolveUnderlying, sameIndexSiblings, type Pillar } from './instruments';

// Re-exported for the modules that imported them from here before v2.4.
export { pillarOf, type Pillar };

export const MAX_CONCURRENT_POSITIONS = 5;

/** Per-pillar concurrent caps. null = no per-pillar cap (global 5-cap still applies). */
export const PILLAR_MAX: Record<Pillar, number | null> = {
  EQUITY: 2,
  VOLATILITY: 1,
  CURRENCY: 1,
  FIXED_INCOME: null,
  COMMODITY: null,
};

const PILLAR_LABEL: Record<Pillar, string> = {
  EQUITY: 'Equity block',
  FIXED_INCOME: 'Fixed Income pillar',
  COMMODITY: 'Commodity pillar',
  VOLATILITY: 'Volatility pillar',
  CURRENCY: 'Currency pillar',
};

export type PositionLimitCheck = {
  symbol: string;
  pillar: Pillar | 'UNKNOWN';
  /** False if any constraint blocks the entry. */
  allowed: boolean;
  /** Human-readable block reasons (empty when allowed). */
  reasons: string[];
  /** Global slot usage. */
  slotsUsed: number;
  slotsMax: number;
  /** Open positions in the prospective symbol's pillar (0 for UNKNOWN). */
  pillarCount: number;
  /** Cap for that pillar; null = no per-pillar cap. */
  pillarMax: number | null;
};

/**
 * v2.4 §7.2 — open positions on a symbol tracking the SAME underlying index as
 * `prospectiveSymbol`, e.g. an open SPY condor when scanning XSP. Returns the
 * distinct sibling symbols already held (canonical, sorted), empty when none.
 *
 * DECIDED (spec §0a.2): this WARNS, it does NOT block. Two S&P positions are a
 * legal, capped entry that happens to carry zero diversification — the operator
 * is told, and decides. Blocking was explicitly rejected.
 */
export function sameIndexOverlaps(
  positions: ReconstructedPosition[],
  prospectiveSymbol: string,
): string[] {
  const siblings = new Set(sameIndexSiblings(prospectiveSymbol));
  if (siblings.size === 0) return [];
  const held = new Set(
    slotPositions(positions)
      .map((p) => resolveUnderlying(p.underlying))
      .filter((u) => siblings.has(u)),
  );
  return [...held].sort();
}

/** Count only slot-occupying positions (condors + verticals). */
function slotPositions(positions: ReconstructedPosition[]): ReconstructedPosition[] {
  return positions.filter(
    (p) => p.kind === 'IRON_CONDOR' || p.kind === 'VERTICAL_SPREAD',
  );
}

export function checkPositionLimits(
  positions: ReconstructedPosition[],
  prospectiveSymbol: string,
): PositionLimitCheck {
  // Resolve on BOTH sides (spec §5): the prospective symbol arrives canonical
  // from the scanner, but an open position's underlying comes from a parsed OCC
  // root. resolveUnderlying is idempotent on canonical symbols, so running it
  // here costs nothing and removes the ordering assumption entirely.
  const symbol = resolveUnderlying(prospectiveSymbol);
  const pillar = pillarOf(symbol);

  const slots = slotPositions(positions);
  const slotsUsed = slots.length;

  const pillarMax = pillar === 'UNKNOWN' ? null : PILLAR_MAX[pillar];
  const pillarCount =
    pillar === 'UNKNOWN'
      ? 0
      : slots.filter((p) => pillarOf(resolveUnderlying(p.underlying)) === pillar).length;

  const reasons: string[] = [];

  if (slotsUsed >= MAX_CONCURRENT_POSITIONS) {
    reasons.push(`${MAX_CONCURRENT_POSITIONS}-position cap reached (${slotsUsed} open)`);
  }

  if (pillarMax !== null && pillarCount >= pillarMax) {
    reasons.push(
      `${PILLAR_LABEL[pillar as Pillar]} full — ${pillarCount} of ${pillarMax} open`,
    );
  }

  return {
    symbol,
    pillar,
    allowed: reasons.length === 0,
    reasons,
    slotsUsed,
    slotsMax: MAX_CONCURRENT_POSITIONS,
    pillarCount,
    pillarMax,
  };
}
