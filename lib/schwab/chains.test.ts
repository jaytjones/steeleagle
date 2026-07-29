/**
 * Run with:  npx tsx --test chains.test.ts
 *
 * v2.4 §6.2 — index chain root filtering. Phase 0 V2 pinned that ONE `$SPX`
 * chain response carries both the PM root (SPXW) and the AM root (SPX), and
 * that at a monthly expiration both land under the SAME callExpDateMap key.
 * Unfiltered, findByDelta picks whichever contract is closest to the target
 * delta regardless of root — producing a "condor" of two different instruments.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rootFilterFor, findByDelta } from './chains';
import type { OptionContract } from '@/types';

function c(root: string | undefined, occ: string, delta = 0.16): OptionContract {
  return {
    symbol: occ,
    optionRoot: root,
    strikePrice: 7400,
    expirationDate: '2026-09-18',
    daysToExpiration: 35,
    bid: 9.9, ask: 10.1, mark: 10,
    delta,
    gamma: 0, theta: 0, vega: 0,
    volatility: 18,
    openInterest: 1000, totalVolume: 100,
    inTheMoney: false,
  };
}

describe('rootFilterFor — applies to indices only', () => {
  it('returns null (no filtering) for ETFs and unknown tickers', () => {
    assert.equal(rootFilterFor('SPY'), null);
    assert.equal(rootFilterFor('TLT'), null);
    assert.equal(rootFilterFor('ARKK'), null);
  });

  it('returns a filter for every index', () => {
    for (const s of ['XSP', 'SPX', 'NDX', 'RUT']) {
      assert.notEqual(rootFilterFor(s), null, s);
    }
  });
});

describe('rootFilterFor — SPX keeps SPXW, drops SPX (AM)', () => {
  const keep = rootFilterFor('SPX')!;

  it('keeps the PM root and drops the AM root', () => {
    assert.equal(keep(c('SPXW', 'SPXW  260918C07400000')), true);
    assert.equal(keep(c('SPX', 'SPX   260918C07400000')), false);
  });

  it('falls back to the OCC symbol when optionRoot is absent', () => {
    assert.equal(keep(c(undefined, 'SPXW  260918C07400000')), true);
    assert.equal(keep(c(undefined, 'SPX   260918C07400000')), false);
  });

  it('EXCLUDES a contract whose root cannot be determined at all', () => {
    // Indices are known to be multi-root, so "can't tell" is not a safe include.
    assert.equal(keep(c(undefined, 'not-an-occ-symbol')), false);
  });

  it('tolerates casing and padding in optionRoot', () => {
    assert.equal(keep(c(' spxw ', 'SPXW  260918C07400000')), true);
  });
});

describe('rootFilterFor — the other indices', () => {
  it('NDX keeps NDXP, RUT keeps RUTW', () => {
    assert.equal(rootFilterFor('NDX')!(c('NDXP', 'NDXP  260918C28000000')), true);
    assert.equal(rootFilterFor('NDX')!(c('NDX', 'NDX   260918C28000000')), false);
    assert.equal(rootFilterFor('RUT')!(c('RUTW', 'RUTW  260918C03000000')), true);
    assert.equal(rootFilterFor('RUT')!(c('RUT', 'RUT   260918C03000000')), false);
  });

  it('XSP keeps its single root and admits nothing else', () => {
    const keep = rootFilterFor('XSP')!;
    assert.equal(keep(c('XSP', 'XSP   260918C00740000')), true);
    assert.equal(keep(c('XSPW', 'XSPW  260918C00740000')), false);
  });
});

describe('the mixed-root pick this filter prevents', () => {
  it('unfiltered, findByDelta can select an AM-root contract', () => {
    const mixed = [
      c('SPX', 'SPX   260918C07400000', 0.161), // AM root, closest to 16Δ
      c('SPXW', 'SPXW  260918C07400000', 0.17),
    ];
    assert.equal(findByDelta(mixed, 0.16)?.optionRoot, 'SPX');

    // Filtered first, the same call can only return a PM-root contract.
    const filtered = mixed.filter(rootFilterFor('SPX')!);
    assert.equal(findByDelta(filtered, 0.16)?.optionRoot, 'SPXW');
  });
});
