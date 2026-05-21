/**
 * lib/strategy/position-limits.ts
 *
 * Entry-gate constraints for the scanner cards (PRD v1.3 items 3 & 4 / Strategy v1.4 §4).
 *
 * Given the currently open positions and a prospective symbol, decides whether a new
 * entry is allowed under:
 *   - Global cap:      max 5 concurrent positions.
 *   - Equity block:    SPY/QQQ/IWM/DIA/EFA/EEM treated as ONE block, max 2 simultaneous.
 *   - Volatility:      max 1 open at a time.
 *   - Currency:        max 1 open at a time.
 *   - Fixed Income / Commodities: no per-pillar cap (global cap only).
 *
 * "Open position" = an Iron Condor or a Vertical Spread (a partial wing still occupies a
 * slot — the Q2 resolution). Everything in the OTHER bucket (equities, money-market funds)
 * is ignored, matching summarizeOpenRisk().slotsUsed.
 *
 * Pure and deterministic — the scanner card runs this alongside the BPR pre-flight.
 */

import type { ReconstructedPosition } from './reconstruct-positions';

export type Pillar = 'EQUITY' | 'FIXED_INCOME' | 'COMMODITY' | 'VOLATILITY' | 'CURRENCY';

export const MAX_CONCURRENT_POSITIONS = 5;

/** Symbol → pillar for the 21-instrument strategy universe. */
export const SYMBOL_PILLAR: Record<string, Pillar> = {
  // Equity block (all six count toward the max-2 cap)
  SPY: 'EQUITY', QQQ: 'EQUITY', IWM: 'EQUITY', DIA: 'EQUITY', EFA: 'EQUITY', EEM: 'EQUITY',
  // Fixed income
  TLT: 'FIXED_INCOME', IEF: 'FIXED_INCOME', HYG: 'FIXED_INCOME', LQD: 'FIXED_INCOME',
  // Commodities
  GLD: 'COMMODITY', SLV: 'COMMODITY', USO: 'COMMODITY', DBA: 'COMMODITY',
  // Volatility
  VXX: 'VOLATILITY', UVXY: 'VOLATILITY', SVXY: 'VOLATILITY',
  // Currencies
  UUP: 'CURRENCY', FXY: 'CURRENCY', FXE: 'CURRENCY', FXB: 'CURRENCY',
};

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

export function pillarOf(symbol: string): Pillar | 'UNKNOWN' {
  return SYMBOL_PILLAR[symbol.toUpperCase()] ?? 'UNKNOWN';
}

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
  const symbol = prospectiveSymbol.toUpperCase();
  const pillar = pillarOf(symbol);

  const slots = slotPositions(positions);
  const slotsUsed = slots.length;

  const pillarMax = pillar === 'UNKNOWN' ? null : PILLAR_MAX[pillar];
  const pillarCount =
    pillar === 'UNKNOWN'
      ? 0
      : slots.filter((p) => pillarOf(p.underlying) === pillar).length;

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
