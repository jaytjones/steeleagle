/**
 * Run with:  npx tsx --test condor-builder.test.ts
 *
 * v2.4 §6.3/§6.4 — the builder's two hardcoded constants became per-instrument.
 * These tests pin the generalization at each width tier and, just as important,
 * pin that the ETF path produces byte-identical numbers to v2.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCondor, MIN_CREDIT_TO_WIDTH } from './condor-builder';
import type { ChainResult } from '@/lib/schwab/chains';
import type { IVRankResult, OptionContract } from '@/types';

// --- Synthetic chain -------------------------------------------------------

/** One chain contract. Spread defaults tight so liquidity never accidentally gates. */
function contract(strike: number, delta: number, mark: number, spread = 0.02): OptionContract {
  return {
    symbol: `TEST  260918${delta < 0 ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`,
    strikePrice: strike,
    expirationDate: '2026-09-18',
    daysToExpiration: 35,
    bid: mark - spread / 2,
    ask: mark + spread / 2,
    mark,
    delta,
    gamma: 0, theta: 0, vega: 0,
    volatility: 18,
    openInterest: 5000,
    totalVolume: 1000,
    inTheMoney: false,
  };
}

/**
 * A four-strike chain that builds a condor of exactly `wing` width.
 * shortPut/shortCall sit at 16Δ, longPut/longCall at 5Δ, `wing` apart.
 */
function chainFor(opts: {
  spot: number;
  wing: number;
  shortPutMark: number;
  shortCallMark: number;
  longMark: number;
  spread?: number;
}): ChainResult {
  const { spot, wing, shortPutMark, shortCallMark, longMark, spread } = opts;
  const shortPutStrike = spot - wing * 2;
  const shortCallStrike = spot + wing * 2;
  return {
    underlyingPrice: spot,
    expiration: '2026-09-18',
    dte: 35,
    puts: [
      contract(shortPutStrike - wing, -0.05, longMark, spread),
      contract(shortPutStrike, -0.16, shortPutMark, spread),
      contract(spot, -0.5, shortPutMark * 6, spread),
    ],
    calls: [
      contract(spot, 0.5, shortCallMark * 6, spread),
      contract(shortCallStrike, 0.16, shortCallMark, spread),
      contract(shortCallStrike + wing, 0.05, longMark, spread),
    ],
    atmIv: 18,
  };
}

const passingIvRank: IVRankResult = {
  symbol: 'TEST', currentIv: 18, ivRank: 55, daysOfHistory: 60, passes: true,
};

const reasons = (r: string[]) => r.join(' | ');

// --- ETF regression: nothing about the shipped path may move -----------------

describe('ETF path is unchanged by the generalization', () => {
  const spyChain = () =>
    chainFor({ spot: 740, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35 });

  it('builds a $10-wing SPY condor that passes every filter', () => {
    const c = buildCondor('SPY', spyChain(), passingIvRank);
    assert.ok(c);
    assert.equal(c.wingWidth, 10);
    assert.equal(c.passesFilter, true, reasons(c.filterReasons));
  });

  it('still charges exactly $5.20 round trip on an ETF', () => {
    const c = buildCondor('SPY', spyChain(), passingIvRank);
    assert.equal(c!.commissionRoundTrip, 5.2);
    assert.equal(c!.netCreditAfterCommission, Math.round((c!.totalCredit * 100 - 5.2) * 100) / 100);
  });

  it('an off-universe ticker also keeps the $5.20 / $10-wing defaults', () => {
    const c = buildCondor('ARKK', spyChain(), passingIvRank);
    assert.equal(c!.commissionRoundTrip, 5.2);
    assert.equal(c!.passesFilter, true, reasons(c!.filterReasons));
  });
});

// --- §6.4: the credit floor is now DERIVED from the wing --------------------

describe('credit floor derived from wing width (§6.4)', () => {
  // 0.15 × wing × 100. One case per width tier, per the spec.
  const tiers: Array<{ symbol: string; wing: number; spot: number; floor: number }> = [
    { symbol: 'SPY', wing: 10, spot: 740, floor: 150 },
    { symbol: 'XSP', wing: 10, spot: 741, floor: 150 },
    { symbol: 'RUT', wing: 25, spot: 2948, floor: 375 },
    { symbol: 'SPX', wing: 50, spot: 7413, floor: 750 },
    { symbol: 'NDX', wing: 200, spot: 28039, floor: 3000 },
  ];

  for (const { symbol, wing, spot, floor } of tiers) {
    it(`${symbol}: a $${wing} wing needs $${floor} of credit`, () => {
      // Credit set just BELOW the 15% ratio → must fail with the derived floor.
      const short = (wing * MIN_CREDIT_TO_WIDTH * 0.9) / 2;
      const below = buildCondor(
        symbol,
        chainFor({ spot, wing, shortPutMark: short, shortCallMark: short, longMark: 0.001 }),
        passingIvRank,
      );
      assert.ok(below);
      assert.equal(below.passesFilter, false);
      assert.match(reasons(below.filterReasons), /Credit\/width ratio/);
      assert.match(reasons(below.filterReasons), new RegExp(`needs \\$${floor}`));

      // Credit just ABOVE the ratio → the credit filter no longer fires.
      const ok = (wing * MIN_CREDIT_TO_WIDTH * 1.2) / 2;
      const above = buildCondor(
        symbol,
        chainFor({ spot, wing, shortPutMark: ok, shortCallMark: ok, longMark: 0.001 }),
        passingIvRank,
      );
      assert.ok(above);
      assert.ok(
        !above.filterReasons.some((r) => /Credit\/width ratio/.test(r)),
        reasons(above.filterReasons),
      );
    });
  }

  it('no longer emits a SEPARATE absolute-credit reason alongside the ratio one', () => {
    const c = buildCondor(
      'SPY',
      chainFor({ spot: 740, wing: 10, shortPutMark: 0.5, shortCallMark: 0.4, longMark: 0.05 }),
      passingIvRank,
    );
    const creditReasons = c!.filterReasons.filter((r) => /credit/i.test(r));
    assert.equal(creditReasons.length, 1, reasons(c!.filterReasons));
  });
});

// --- §6.3: the wing-width floor scales with the instrument ------------------

describe('minimum wing width is per-instrument (§6.3)', () => {
  it('a $10 wing passes for SPY and XSP', () => {
    for (const s of ['SPY', 'XSP']) {
      const c = buildCondor(
        s,
        chainFor({ spot: 740, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35 }),
        passingIvRank,
      );
      assert.ok(!c!.filterReasons.some((r) => /Wing width/.test(r)), s);
    }
  });

  it('a $10 wing FAILS the floor on SPX, NDX and RUT', () => {
    for (const { s, floor } of [
      { s: 'RUT', floor: 25 },
      { s: 'SPX', floor: 50 },
      { s: 'NDX', floor: 200 },
    ]) {
      const c = buildCondor(
        s,
        chainFor({ spot: 7413, wing: 10, shortPutMark: 30, shortCallMark: 30, longMark: 1 }),
        passingIvRank,
      );
      assert.equal(c!.passesFilter, false, s);
      assert.match(reasons(c!.filterReasons), new RegExp(`below the \\$${floor} minimum`), s);
    }
  });

  it('an SPX condor at a $50 wing clears the floor', () => {
    const c = buildCondor(
      'SPX',
      chainFor({ spot: 7413, wing: 50, shortPutMark: 5, shortCallMark: 4.5, longMark: 1 }),
      passingIvRank,
    );
    assert.equal(c!.wingWidth, 50);
    assert.ok(!c!.filterReasons.some((r) => /Wing width/.test(r)), reasons(c!.filterReasons));
  });
});

// --- §9: commissions are per-instrument -------------------------------------

describe('per-instrument commission (§9)', () => {
  it('every index costs more than the ETF round trip', () => {
    const build = (s: string) =>
      buildCondor(
        s,
        chainFor({ spot: 740, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35 }),
        passingIvRank,
      )!;
    const etf = build('SPY').commissionRoundTrip;
    assert.equal(etf, 5.2);
    for (const s of ['XSP', 'SPX', 'NDX', 'RUT']) {
      assert.ok(build(s).commissionRoundTrip > etf, s);
    }
  });

  it('the higher fee flows into netCreditAfterCommission', () => {
    const chain = chainFor({ spot: 740, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35 });
    const spy = buildCondor('SPY', chain, passingIvRank)!;
    const xsp = buildCondor('XSP', chain, passingIvRank)!;
    assert.equal(spy.totalCredit, xsp.totalCredit);
    assert.ok(xsp.netCreditAfterCommission < spy.netCreditAfterCommission);
  });
});

// --- Unchanged behaviour --------------------------------------------------

describe('untouched filters', () => {
  it('still reports calibration when IV history is short', () => {
    const c = buildCondor(
      'XSP',
      chainFor({ spot: 741, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35 }),
      { symbol: 'XSP', currentIv: 18, ivRank: 0, daysOfHistory: 7, passes: false },
    );
    assert.equal(c!.passesFilter, false);
    assert.match(reasons(c!.filterReasons), /Calibrating — 7\/20 days/);
  });

  it('still fails a wide-spread setup on liquidity', () => {
    const c = buildCondor(
      'XSP',
      chainFor({ spot: 741, wing: 10, shortPutMark: 1.3, shortCallMark: 1.2, longMark: 0.35, spread: 0.5 }),
      passingIvRank,
    );
    assert.equal(c!.passesFilter, false);
    assert.match(reasons(c!.filterReasons), /Bid\/ask spread is \d+% of credit/);
  });

  it('returns null when the chain has no usable strikes', () => {
    assert.equal(
      buildCondor('SPY', { ...chainFor({ spot: 740, wing: 10, shortPutMark: 1, shortCallMark: 1, longMark: 0.1 }), puts: [], calls: [] }, passingIvRank),
      null,
    );
  });
});
