/**
 * lib/strategy/liquidity.ts
 *
 * Liquidity filter for the scanner (PRD v1.3 item 7 / Strategy v1.4 §4 Currency,
 * §6 Execution). The constructed condor's total bid/ask spread is the sum of the four
 * legs' individual (ask − bid) spreads. If that exceeds 25% of the credit, the setup is
 * too illiquid to trade at a fair fill and fails with reason "spread too wide".
 *
 * All values are per-share (same unit as the leg marks and the credit), so the check is a
 * pure ratio — no ×100 needed.
 *
 * Scope is left to the caller: the strategy doc targets this at the thin pillars (Currency,
 * Volatility), but applying it universally is harmless — liquid names (SPY/TLT/GLD) pass
 * trivially since their per-leg spreads are pennies against a $1.50+ credit.
 */

export const MAX_SPREAD_RATIO = 0.25;

export type SpreadLeg = { bid: number; ask: number };

/** Total bid/ask spread of the 4-leg condor = Σ max(0, ask − bid). */
export function condorBidAskSpread(legs: SpreadLeg[]): number {
  return legs.reduce((sum, l) => sum + Math.max(0, l.ask - l.bid), 0);
}

export type LiquidityCheck = {
  /** Summed per-leg bid/ask spread (per share). */
  spread: number;
  credit: number;
  /** spread / credit. */
  ratio: number;
  passes: boolean;
  /** Filter-chain reason string when failing (undefined when passing). */
  reason?: string;
};

export function checkLiquidity(
  legs: SpreadLeg[],
  credit: number,
  maxRatio: number = MAX_SPREAD_RATIO,
): LiquidityCheck {
  const spread = condorBidAskSpread(legs);

  if (!Number.isFinite(credit) || credit <= 0) {
    return { spread, credit, ratio: Infinity, passes: false, reason: 'spread too wide — no credit to measure against' };
  }

  const ratio = spread / credit;
  const passes = ratio <= maxRatio;
  return {
    spread,
    credit,
    ratio,
    passes,
    reason: passes
      ? undefined
      : `spread too wide — ${Math.round(ratio * 100)}% of credit (max ${Math.round(maxRatio * 100)}%)`,
  };
}
