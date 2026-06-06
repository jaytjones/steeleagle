/**
 * Run with:  npx tsx --test earnings-condor.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OptionContract } from '@/types';
import {
  buildEarningsCondor,
  selectPostEarningsExpiration,
  defaultWingWidth,
  type EarningsChain,
} from './earnings-condor';
import { computeExpectedMove } from './expected-move';

// Mark falls off with distance from spot, so shorts (closer) > longs (further) → credit > 0.
function contract(strike: number, underlying: number, type: 'call' | 'put'): OptionContract {
  const mark = Math.max(0.05, Math.round((6 - 0.12 * Math.abs(strike - underlying)) * 100) / 100);
  return {
    symbol: `OPT${strike}${type[0].toUpperCase()}`,
    strikePrice: strike,
    expirationDate: '2026-07-31',
    daysToExpiration: 2,
    bid: Math.max(0.01, Math.round((mark - 0.05) * 100) / 100),
    ask: Math.round((mark + 0.05) * 100) / 100,
    mark,
    delta: type === 'call' ? 0.2 : -0.2,
    gamma: 0, theta: 0, vega: 0, volatility: 30,
    openInterest: 1000, totalVolume: 500, inTheMoney: false,
  };
}

function strikeLadder(from: number, to: number, step: number, underlying: number, type: 'call' | 'put'): OptionContract[] {
  const out: OptionContract[] = [];
  for (let s = from; s <= to; s += step) out.push(contract(s, underlying, type));
  return out;
}

function chain(symbol: string, underlying: number, from: number, to: number, step: number): EarningsChain {
  return {
    symbol,
    underlyingPrice: underlying,
    expiration: '2026-07-31',
    dte: 2,
    calls: strikeLadder(from, to, step, underlying, 'call'),
    puts: strikeLadder(from, to, step, underlying, 'put'),
  };
}

const aaplEM = computeExpectedMove({
  symbol: 'AAPL', expiration: '2026-07-31', underlyingPrice: 190, atmCallMid: 4.2, atmPutMid: 4.2,
})!; // EM abs = 8.4

describe('defaultWingWidth', () => {
  it('$5 standard, $10 for >$300 names', () => {
    assert.equal(defaultWingWidth(190), 5);
    assert.equal(defaultWingWidth(301), 10);
  });
});

describe('buildEarningsCondor — AAPL $190, EM 8.4', () => {
  it('places shorts just outside 1.25× EM with $5 wings', () => {
    const c = chain('AAPL', 190, 160, 220, 1);
    const setup = buildEarningsCondor({ chain: c, expectedMove: aaplEM, tier: 1 });
    assert.ok(setup);
    // distance = 8.4 * 1.25 = 10.5 → call target 200.5 → 201; put target 179.5 → 179
    assert.equal(setup!.shortCall.strike, 201);
    assert.equal(setup!.shortPut.strike, 179);
    assert.equal(setup!.longCall.strike, 206);
    assert.equal(setup!.longPut.strike, 174);
    assert.equal(setup!.wingWidth, 5);
    assert.ok(setup!.totalCredit > 0);
    assert.equal(setup!.maxLoss, Math.round((5 - setup!.totalCredit) * 100) / 100);
    assert.equal(setup!.bpr, Math.round((5 - setup!.totalCredit) * 100 * 100) / 100);
    assert.equal(setup!.profitTargetPct, 25);
    assert.equal(setup!.profitTargetDollars, Math.round(setup!.totalCredit * 100 * 0.25 * 100) / 100);
    // No stop loss field exists on the earnings setup.
    assert.ok(!('stopLoss' in setup!));
  });

  it('1.0× multiple sits the shorts at the EM (closer in)', () => {
    const c = chain('AAPL', 190, 160, 220, 1);
    const setup = buildEarningsCondor({ chain: c, expectedMove: aaplEM, tier: 1, shortMoveMultiple: 1.0 });
    assert.ok(setup);
    // distance 8.4 → call target 198.4 → 199; put target 181.6 → 181
    assert.equal(setup!.shortCall.strike, 199);
    assert.equal(setup!.shortPut.strike, 181);
    assert.equal(setup!.shortMoveMultiple, 1.0);
  });

  it('uses $10 wings on a >$300 name', () => {
    const em = computeExpectedMove({
      symbol: 'MSFT', expiration: '2026-07-31', underlyingPrice: 350, atmCallMid: 10, atmPutMid: 10,
    })!; // EM 20
    const c = chain('MSFT', 350, 280, 420, 5);
    const setup = buildEarningsCondor({ chain: c, expectedMove: em, tier: 1 });
    assert.ok(setup);
    assert.equal(setup!.wingWidth, 10);
    // distance 25 → call target 375 → 375; put target 325 → 325
    assert.equal(setup!.shortCall.strike, 375);
    assert.equal(setup!.shortPut.strike, 325);
    assert.equal(setup!.longCall.strike, 385);
    assert.equal(setup!.longPut.strike, 315);
  });

  it('returns null on an empty chain', () => {
    const c = chain('AAPL', 190, 160, 220, 1);
    assert.equal(buildEarningsCondor({ chain: { ...c, calls: [] }, expectedMove: aaplEM, tier: 1 }), null);
  });

  it('returns null when the structure would be a debit', () => {
    // Flat marks → shorts and longs equal → credit 0 → rejected.
    const flat = (strike: number, type: 'call' | 'put'): OptionContract => ({
      ...contract(strike, 190, type), mark: 1, bid: 0.95, ask: 1.05,
    });
    const calls = [195, 196, 197, 200, 201, 206].map((s) => flat(s, 'call'));
    const puts = [174, 179, 183, 184, 185].map((s) => flat(s, 'put'));
    const c: EarningsChain = { symbol: 'AAPL', underlyingPrice: 190, expiration: '2026-07-31', dte: 2, calls, puts };
    assert.equal(buildEarningsCondor({ chain: c, expectedMove: aaplEM, tier: 1 }), null);
  });
});

describe('selectPostEarningsExpiration', () => {
  const report = '2026-07-28';
  it('picks the soonest expiration after the report within the DTE window', () => {
    const exps = [
      { date: '2026-07-28', dte: 0 }, // same day — excluded
      { date: '2026-07-31', dte: 3 }, // the weekly we want
      { date: '2026-08-07', dte: 10 },
      { date: '2026-08-21', dte: 24 },
    ];
    const pick = selectPostEarningsExpiration(exps, report);
    assert.deepEqual(pick, { date: '2026-07-31', dte: 3 });
  });

  it('returns null when only a far-out monthly exists (no qualifying weekly)', () => {
    const exps = [{ date: '2026-08-21', dte: 24 }];
    assert.equal(selectPostEarningsExpiration(exps, report), null);
  });

  it('respects a custom max DTE', () => {
    const exps = [{ date: '2026-08-04', dte: 7 }];
    assert.equal(selectPostEarningsExpiration(exps, report, { maxDte: 5 }), null);
    assert.deepEqual(selectPostEarningsExpiration(exps, report, { maxDte: 7 }), { date: '2026-08-04', dte: 7 });
  });
});
