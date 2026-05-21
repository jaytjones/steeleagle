/**
 * Run with:  npx tsx --test liquidity.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { condorBidAskSpread, checkLiquidity, MAX_SPREAD_RATIO } from './liquidity';

// Helper: four legs each with a given (ask − bid) spread.
function legs(spreadEach: number) {
  return [0, 1, 2, 3].map(() => ({ bid: 1.0, ask: 1.0 + spreadEach }));
}

describe('condorBidAskSpread', () => {
  it('sums the four per-leg spreads', () => {
    assert.ok(Math.abs(condorBidAskSpread(legs(0.1)) - 0.4) < 1e-9);
  });
  it('clamps crossed/negative quotes to zero', () => {
    const mixed = [
      { bid: 1.0, ask: 1.1 }, // 0.10
      { bid: 1.2, ask: 1.1 }, // crossed → 0
      { bid: 0.5, ask: 0.55 }, // 0.05
      { bid: 0.3, ask: 0.3 }, // 0
    ];
    assert.ok(Math.abs(condorBidAskSpread(mixed) - 0.15) < 1e-9);
  });
});

describe('checkLiquidity', () => {
  it('passes a liquid condor (spread well under 25% of credit)', () => {
    const c = checkLiquidity(legs(0.1), 1.8); // 0.40 / 1.80 = 22%
    assert.ok(c.passes);
    assert.equal(c.reason, undefined);
  });

  it('fails a wide condor with a "spread too wide" reason', () => {
    const c = checkLiquidity(legs(0.15), 1.8); // 0.60 / 1.80 = 33%
    assert.ok(!c.passes);
    assert.match(c.reason ?? '', /spread too wide/);
    assert.match(c.reason ?? '', /33% of credit/);
  });

  it('passes exactly at the 25% boundary', () => {
    // 0.125 and 2.0 are exact in binary: 4×0.125 / 2.0 = 0.25 exactly
    const c = checkLiquidity(legs(0.125), 2.0);
    assert.equal(c.ratio, 0.25);
    assert.ok(c.passes);
  });

  it('fails with no usable credit', () => {
    const c = checkLiquidity(legs(0.1), 0);
    assert.ok(!c.passes);
    assert.equal(c.ratio, Infinity);
    assert.match(c.reason ?? '', /spread too wide/);
  });

  it('respects a custom maxRatio (e.g. a stricter currency-pillar limit)', () => {
    // 22% spread: passes at 25% default, fails at a 20% override
    assert.ok(checkLiquidity(legs(0.1), 1.8, MAX_SPREAD_RATIO).passes);
    assert.ok(!checkLiquidity(legs(0.1), 1.8, 0.2).passes);
  });
});
