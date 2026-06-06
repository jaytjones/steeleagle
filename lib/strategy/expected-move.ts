/**
 * lib/strategy/expected-move.ts
 *
 * Expected-move computation for the earnings sleeve (Strategy v1.5 §8.2).
 *
 * The expected move is the market's priced-in 1-event move, read off the ATM
 * straddle of the *post-earnings* expiration: EM ≈ (ATM call mid + ATM put mid).
 * Short strikes are then placed at — or 1.25× outside — this distance.
 *
 * Pure: callers pass the two ATM mids (and the underlying); pulling the ATM
 * straddle off a live chain stays in the route layer (lib/schwab/chains.ts).
 *
 * Convention matches CondorSetup in types/index.ts: prices are PER-SHARE
 * (e.g. an $8.40 straddle on a $190 stock → expectedMoveAbs 8.4, pct 0.0442).
 */

export type ExpectedMove = {
  symbol: string;
  /** Post-earnings expiration used for the straddle (ISO 'YYYY-MM-DD'). */
  expiration: string;
  underlyingPrice: number;
  /** ATM call mid + ATM put mid, per share. */
  straddlePrice: number;
  /** Priced-in 1-event move in dollars per share (≈ straddlePrice). */
  expectedMoveAbs: number;
  /** expectedMoveAbs / underlyingPrice (e.g. 0.05 = 5%). */
  expectedMovePct: number;
};

export type ExpectedMoveInput = {
  symbol: string;
  expiration: string;
  underlyingPrice: number;
  atmCallMid: number;
  atmPutMid: number;
};

/**
 * EM ≈ ATM straddle. We follow the doc's straddle definition directly rather
 * than the ~0.85× straddle refinement some desks use; placing shorts at 1.25×
 * EM (earnings-condor.ts) already supplies the safety margin, and the simpler
 * definition keeps the priced-in move transparent on the card.
 */
export function computeExpectedMove(input: ExpectedMoveInput): ExpectedMove | null {
  const { symbol, expiration, underlyingPrice, atmCallMid, atmPutMid } = input;

  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return null;
  if (!Number.isFinite(atmCallMid) || !Number.isFinite(atmPutMid)) return null;
  if (atmCallMid < 0 || atmPutMid < 0) return null;

  const straddlePrice = atmCallMid + atmPutMid;
  if (straddlePrice <= 0) return null;

  const expectedMoveAbs = straddlePrice;
  const expectedMovePct = expectedMoveAbs / underlyingPrice;

  return {
    symbol: symbol.toUpperCase(),
    expiration,
    underlyingPrice: round2(underlyingPrice),
    straddlePrice: round2(straddlePrice),
    expectedMoveAbs: round2(expectedMoveAbs),
    expectedMovePct: Math.round(expectedMovePct * 10000) / 10000,
  };
}

/**
 * The dollar distance from spot at which to place a short strike, given the
 * expected move and a multiple (1.0 = at the EM, 1.25 = the §8.2 safety margin).
 */
export function shortStrikeDistance(em: ExpectedMove, moveMultiple: number): number {
  return em.expectedMoveAbs * moveMultiple;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
