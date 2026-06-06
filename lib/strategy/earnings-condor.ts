/**
 * lib/strategy/earnings-condor.ts
 *
 * Short-DTE earnings condor builder (Strategy v1.5 §8.2). DELIBERATELY SEPARATE
 * from the core condor-builder.ts — it must NOT inherit the core's rules:
 *
 *   - Wings: $5 standard, $10 for >$300 names (NOT the core's $10 minimum floor).
 *   - Shorts: at — or 1.25× outside — the expected move (NOT ~16Δ).
 *   - Profit target: 25% of credit (NOT 50%).
 *   - No stop loss (gap risk preempts stops), no friction check, no credit/width floor.
 *
 * There are no soft "filters" here: a structurally-built condor is takeable pending
 * the caps in earnings-gate.ts. The builder returns null only when it cannot form a
 * valid structure (missing strikes, collapsed ordering, or non-positive credit).
 *
 * Pure + deterministic: consumes a plain chain snapshot + a precomputed ExpectedMove.
 * Dollar convention matches CondorSetup: credit/wing/maxLoss per-share; bpr in real $.
 */

import type { OptionContract, CondorLeg } from '@/types';
import type { ExpectedMove } from './expected-move';
import { shortStrikeDistance } from './expected-move';
import type { EarningsTier } from './earnings-watchlist';

export const WING_WIDTH_STANDARD = 5;
export const WING_WIDTH_HIGH_PRICE = 10;
export const HIGH_PRICE_THRESHOLD = 300;
export const DEFAULT_SHORT_MOVE_MULTIPLE = 1.25; // §8.2 safety margin
export const EARNINGS_PROFIT_TARGET_PCT = 25 as const;

/** Min/max DTE for the post-earnings weekly (target 1–3; a week out is the ceiling). */
export const POST_EARNINGS_MIN_DTE = 1;
export const POST_EARNINGS_MAX_DTE = 7;

/** Chain snapshot for the chosen post-earnings expiration. Mirrors ChainResult. */
export type EarningsChain = {
  symbol: string;
  underlyingPrice: number;
  expiration: string;
  dte: number;
  calls: OptionContract[];
  puts: OptionContract[];
};

export type EarningsCondorSetup = {
  symbol: string;
  expiration: string;
  dte: number;
  underlyingPrice: number;
  expectedMove: ExpectedMove;
  tier: EarningsTier;
  /** 1.0 = shorts at the EM; 1.25 = at the §8.2 safety margin. */
  shortMoveMultiple: number;
  shortPut: CondorLeg;
  longPut: CondorLeg;
  shortCall: CondorLeg;
  longCall: CondorLeg;
  /** Per-share credit (e.g. 1.10). */
  totalCredit: number;
  /** Per-share wing width ($5 or $10). */
  wingWidth: number;
  /** Per-share max loss = wingWidth - credit. */
  maxLoss: number;
  /** Real dollars per contract = (wingWidth - credit) * 100. */
  bpr: number;
  /** Capture 25% of the credit (not 50%). */
  profitTargetPct: typeof EARNINGS_PROFIT_TARGET_PCT;
  /** Profit to capture in real dollars = credit * 100 * 0.25. */
  profitTargetDollars: number;
  // No stopLoss field — §8.2: gap moves preempt stops; sizing is the only control.
};

export type BuildEarningsCondorArgs = {
  chain: EarningsChain;
  expectedMove: ExpectedMove;
  tier: EarningsTier;
  /** Defaults to 1.25 (safety margin). Pass 1.0 to sit right at the EM. */
  shortMoveMultiple?: number;
  /** Override the price-derived $5/$10 wing width. */
  wingWidthOverride?: number;
};

export function defaultWingWidth(underlyingPrice: number): number {
  return underlyingPrice > HIGH_PRICE_THRESHOLD ? WING_WIDTH_HIGH_PRICE : WING_WIDTH_STANDARD;
}

export function buildEarningsCondor(args: BuildEarningsCondorArgs): EarningsCondorSetup | null {
  const { chain, expectedMove, tier } = args;
  const moveMultiple = args.shortMoveMultiple ?? DEFAULT_SHORT_MOVE_MULTIPLE;
  const wing = args.wingWidthOverride ?? defaultWingWidth(chain.underlyingPrice);

  const { underlyingPrice, calls, puts } = chain;
  if (calls.length === 0 || puts.length === 0) return null;
  if (wing <= 0) return null;

  const distance = shortStrikeDistance(expectedMove, moveMultiple);
  const shortCallTarget = underlyingPrice + distance;
  const shortPutTarget = underlyingPrice - distance;

  // Shorts at or JUST OUTSIDE the expected move (further OTM if no exact strike).
  const shortCallC = nearestStrikeAtLeast(calls, shortCallTarget) ?? nearestStrike(calls, shortCallTarget);
  const shortPutC = nearestStrikeAtMost(puts, shortPutTarget) ?? nearestStrike(puts, shortPutTarget);
  if (!shortCallC || !shortPutC) return null;

  // Longs one wing-width out, snapped to the nearest available strike.
  const longCallC = nearestStrike(calls, shortCallC.strikePrice + wing);
  const longPutC = nearestStrike(puts, shortPutC.strikePrice - wing);
  if (!longCallC || !longPutC) return null;

  // Structural ordering must hold after snapping.
  if (!(longPutC.strikePrice < shortPutC.strikePrice)) return null;
  if (!(shortPutC.strikePrice < shortCallC.strikePrice)) return null;
  if (!(shortCallC.strikePrice < longCallC.strikePrice)) return null;

  const shortPut = toLeg(shortPutC, 'sell', 'put');
  const longPut = toLeg(longPutC, 'buy', 'put');
  const shortCall = toLeg(shortCallC, 'sell', 'call');
  const longCall = toLeg(longCallC, 'buy', 'call');

  const actualWing = Math.min(
    shortPut.strike - longPut.strike,
    longCall.strike - shortCall.strike,
  );
  if (actualWing <= 0) return null;

  const totalCredit = (shortPut.mark + shortCall.mark) - (longPut.mark + longCall.mark);
  if (!(totalCredit > 0)) return null; // a debit structure is not a valid earnings condor

  const maxLoss = actualWing - totalCredit;
  const bpr = maxLoss * 100;
  const profitTargetDollars = totalCredit * 100 * (EARNINGS_PROFIT_TARGET_PCT / 100);

  return {
    symbol: chain.symbol.toUpperCase(),
    expiration: chain.expiration,
    dte: chain.dte,
    underlyingPrice: round2(underlyingPrice),
    expectedMove,
    tier,
    shortMoveMultiple: moveMultiple,
    shortPut,
    longPut,
    shortCall,
    longCall,
    totalCredit: round2(totalCredit),
    wingWidth: actualWing,
    maxLoss: round2(maxLoss),
    bpr: round2(bpr),
    profitTargetPct: EARNINGS_PROFIT_TARGET_PCT,
    profitTargetDollars: round2(profitTargetDollars),
  };
}

/**
 * Sanity-check / pick the post-earnings expiration: the SOONEST expiration strictly
 * after the report within [minDte, maxDte]. Returns null when no qualifying weekly
 * exists (e.g. a holiday-distorted grid) — the route surfaces that as a no-trade cell.
 */
export function selectPostEarningsExpiration(
  expirations: Array<{ date: string; dte: number }>,
  reportDate: string,
  opts?: { minDte?: number; maxDte?: number },
): { date: string; dte: number } | null {
  const minDte = opts?.minDte ?? POST_EARNINGS_MIN_DTE;
  const maxDte = opts?.maxDte ?? POST_EARNINGS_MAX_DTE;

  const qualifying = expirations
    .filter((e) => e.date > reportDate && e.dte >= minDte && e.dte <= maxDte)
    .sort((a, b) => a.date.localeCompare(b.date));

  return qualifying[0] ?? null;
}

// --- helpers ----------------------------------------------------------------

function toLeg(c: OptionContract, action: 'buy' | 'sell', type: 'put' | 'call'): CondorLeg {
  return { type, action, strike: c.strikePrice, delta: c.delta, bid: c.bid, ask: c.ask, mark: c.mark };
}

function nearestStrike(cs: OptionContract[], target: number): OptionContract | null {
  if (cs.length === 0) return null;
  return cs.reduce((best, cur) =>
    Math.abs(cur.strikePrice - target) < Math.abs(best.strikePrice - target) ? cur : best,
  );
}

function nearestStrikeAtLeast(cs: OptionContract[], target: number): OptionContract | null {
  const above = cs.filter((c) => c.strikePrice >= target);
  if (above.length === 0) return null;
  return above.reduce((best, cur) => (cur.strikePrice < best.strikePrice ? cur : best));
}

function nearestStrikeAtMost(cs: OptionContract[], target: number): OptionContract | null {
  const below = cs.filter((c) => c.strikePrice <= target);
  if (below.length === 0) return null;
  return below.reduce((best, cur) => (cur.strikePrice > best.strikePrice ? cur : best));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
