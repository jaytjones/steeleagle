/**
 * lib/strategy/bpr.ts
 *
 * Buying-Power-Reduction utilization tracker (PRD v1.3, Strategy v1.4 §4).
 *
 * Strategy rule: never commit more than 50% of account equity as buying power;
 * the rest stays in cash for adjustments and margin spikes. This module turns
 * reconstructed positions + Schwab balances into:
 *
 *   - computeBprUtilization(): the header-chip state (open BPR vs the 50% cap)
 *   - preflightAddTrade():     "would entering this trade breach the cap?" check
 *                              for scanner cards
 *
 * Open BPR is the sum of max-loss BPR across Iron Condors AND Vertical Spreads
 * (a partially-closed condor still ties up its remaining wing's max loss — the
 * Q2 fractional-BPR resolution falls out of reconstruct-positions automatically).
 *
 * Denominator note: the 50% cap is taken against `liquidationValue` (account net
 * liq), the standard "account value" figure. Confirm that field name against a
 * live `securitiesAccount.currentBalances` payload; swap to `equity` if your
 * account reports it there instead.
 */

import {
  type ReconstructedPosition,
  summarizeOpenRisk,
} from './reconstruct-positions';

// --- Tunables ---------------------------------------------------------------

/** Strategy §4: max 50% of equity as buying power. */
export const BPR_CAP_FRACTION = 0.5;
/** Chip turns amber once open BPR reaches this share of the cap. */
export const CHIP_WARN_FRACTION = 0.8;
/** Pre-flight flags "tight" once a prospective entry would land at/above this share of the cap. */
export const PREFLIGHT_TIGHT_FRACTION = 0.9;

// --- Inputs -----------------------------------------------------------------

/** Subset of Schwab `securitiesAccount.currentBalances`. */
export type SchwabBalances = {
  /** Net liquidation value — account equity, the 50%-cap denominator. */
  liquidationValue: number;
  cashBalance?: number;
  buyingPower?: number;
  availableFunds?: number;
};

// --- Outputs ----------------------------------------------------------------

export type BprStatus = 'OK' | 'WARNING' | 'OVER';

export type BprUtilization = {
  /** Account net liq (denominator). */
  equity: number;
  /** Dollar ceiling on aggregate open BPR = BPR_CAP_FRACTION * equity. */
  cap: number;
  /** Summed max-loss BPR across condors + verticals. */
  openBpr: number;
  /** cap - openBpr (negative once over the cap). */
  remaining: number;
  /** openBpr / cap * 100. Primary chip number; 100 = at the 50% ceiling. */
  pctOfCap: number;
  /** openBpr / equity * 100. 50 = the ceiling, for an "X% of account" readout. */
  pctOfEquity: number;
  status: BprStatus;
  /** Slots consumed against the 5-position cap (condors + verticals). */
  slotsUsed: number;
};

export type PreflightStatus = 'FITS' | 'TIGHT' | 'EXCEEDS';

export type AddTradePreflight = {
  prospectiveBpr: number;
  projectedOpenBpr: number;
  projectedPctOfCap: number;
  /** Headroom remaining after this entry (negative => breach). */
  projectedRemaining: number;
  fits: boolean;
  status: PreflightStatus;
};

// --- Core -------------------------------------------------------------------

function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return numerator > 0 ? Infinity : 0;
  }
  return (numerator / denominator) * 100;
}

export function computeBprUtilization(
  positions: ReconstructedPosition[],
  balances: SchwabBalances,
): BprUtilization {
  const equity = balances.liquidationValue ?? 0;
  const cap = Math.max(0, equity * BPR_CAP_FRACTION);
  const { openBpr, slotsUsed } = summarizeOpenRisk(positions);

  const pctOfCap = safePct(openBpr, cap);
  const status: BprStatus =
    openBpr > cap ? 'OVER' : pctOfCap >= CHIP_WARN_FRACTION * 100 ? 'WARNING' : 'OK';

  return {
    equity,
    cap,
    openBpr,
    remaining: cap - openBpr,
    pctOfCap,
    pctOfEquity: safePct(openBpr, equity),
    status,
    slotsUsed,
  };
}

/**
 * Would entering a trade of `prospectiveBpr` (the scanner setup's max loss)
 * breach the 50% cap? Drives the per-card warning on PASS setups.
 */
export function preflightAddTrade(
  current: BprUtilization,
  prospectiveBpr: number,
): AddTradePreflight {
  const projectedOpenBpr = current.openBpr + Math.max(0, prospectiveBpr);
  const projectedPctOfCap = safePct(projectedOpenBpr, current.cap);
  const fits = projectedOpenBpr <= current.cap;

  const status: PreflightStatus = !fits
    ? 'EXCEEDS'
    : projectedPctOfCap >= PREFLIGHT_TIGHT_FRACTION * 100
      ? 'TIGHT'
      : 'FITS';

  return {
    prospectiveBpr,
    projectedOpenBpr,
    projectedPctOfCap,
    projectedRemaining: current.cap - projectedOpenBpr,
    fits,
    status,
  };
}
