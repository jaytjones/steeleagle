/**
 * Run with:  npx tsx --test earnings-gate.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeEarningsGate, summarizeOpenEarnings } from './earnings-gate';
import type { BprUtilization } from './bpr';
import type { ReconstructedPosition, PositionKind } from './reconstruct-positions';

function pos(kind: PositionKind, underlying: string, bpr = 380): ReconstructedPosition {
  const spread = kind !== 'OTHER';
  return {
    kind, underlying, expiration: '2026-07-31', legs: [], quantity: 1,
    wingWidth: spread ? 500 : null, credit: spread ? 120 : null, bpr: spread ? bpr : null,
    openPnl: 0, openPnlReliable: true, dte: 2,
  };
}
const earnCondor = (u: string, bpr = 380) => pos('IRON_CONDOR', u, bpr);

function util(openBpr: number, cap = 15000): BprUtilization {
  return {
    equity: cap * 2, cap, openBpr, remaining: cap - openBpr,
    pctOfCap: cap > 0 ? (openBpr / cap) * 100 : Infinity,
    pctOfEquity: 0, status: 'OK', slotsUsed: 0,
  };
}

const base = {
  positions: [] as ReconstructedPosition[],
  bprUtil: null as BprUtilization | null,
  equity: 30_000,
  prospectiveBprDollars: 380,
  crisisActive: false,
};

describe('summarizeOpenEarnings', () => {
  it('counts only watchlist condors/verticals, excludes ETFs and OTHER', () => {
    const s = summarizeOpenEarnings([
      earnCondor('AAPL', 380),
      pos('IRON_CONDOR', 'SPY', 820), // core pillar — excluded
      pos('OTHER', 'AAPL'),           // not a spread — excluded
    ]);
    assert.equal(s.count, 1);
    assert.equal(s.openBpr, 380);
  });
});

describe('computeEarningsGate — tier & crisis', () => {
  it('BLOCKS Tier 3', () => {
    const g = computeEarningsGate({ ...base, symbol: 'NVDA' });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Tier 3/);
  });
  it('BLOCKS off-watchlist names', () => {
    const g = computeEarningsGate({ ...base, symbol: 'SPY' });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Not on the earnings watchlist/);
  });
  it('BLOCKS when crisis protocol is active', () => {
    const g = computeEarningsGate({ ...base, symbol: 'AAPL', crisisActive: true });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Crisis protocol/);
  });
});

describe('computeEarningsGate — caps', () => {
  it('BLOCKS at 2 concurrent earnings positions', () => {
    const g = computeEarningsGate({
      ...base, symbol: 'AMZN',
      positions: [earnCondor('AAPL'), earnCondor('MSFT'), pos('IRON_CONDOR', 'SPY', 820)],
    });
    assert.equal(g.status, 'BLOCKED');
    assert.equal(g.openEarningsCount, 2);
    assert.match(g.reasons.join(' '), /2 earnings positions already open/);
  });

  it('BLOCKS when a single trade exceeds the 3% per-trade cap', () => {
    const g = computeEarningsGate({ ...base, symbol: 'AAPL', equity: 30_000, prospectiveBprDollars: 1200 });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /3% per-trade cap/);
  });

  it('BLOCKS when open earnings BPR would breach the 10% sub-cap', () => {
    // equity 30k → per-trade cap 900 (380 passes), sub-cap 3000; one large open pos breaches it.
    const g = computeEarningsGate({
      ...base, symbol: 'AAPL', equity: 30_000, prospectiveBprDollars: 380,
      positions: [earnCondor('MSFT', 2800)],
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /10% sub-cap/);
  });

  it('BLOCKS when entering would exceed the 50% total BPR cap', () => {
    const g = computeEarningsGate({
      ...base, symbol: 'AAPL', equity: 30_000, prospectiveBprDollars: 820,
      bprUtil: util(14_500, 15_000), // 14500 + 820 > 15000
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /50% total BPR cap/);
  });

  it('TIGHT when within the total cap but ≥90%', () => {
    const g = computeEarningsGate({
      ...base, symbol: 'AAPL', equity: 30_000, prospectiveBprDollars: 820,
      bprUtil: util(13_000, 15_000), // 13820 / 15000 = 92.1%
    });
    assert.equal(g.status, 'TIGHT');
    assert.match(g.reasons.join(' '), /% of the total BPR cap/);
  });
});

describe('computeEarningsGate — clears', () => {
  it('OK when every gate clears', () => {
    const g = computeEarningsGate({
      ...base, symbol: 'AAPL', equity: 30_000, prospectiveBprDollars: 380,
      bprUtil: util(820, 15_000),
    });
    assert.equal(g.status, 'OK');
    assert.equal(g.reasons.length, 0);
    assert.equal(g.tier, 1);
  });

  it('degrades gracefully with null bprUtil (caps it can evaluate still apply)', () => {
    const g = computeEarningsGate({ ...base, symbol: 'AAPL', bprUtil: null, prospectiveBprDollars: 380 });
    assert.equal(g.status, 'OK');
  });

  it('skips % caps when equity is unknown (0) rather than false-blocking', () => {
    const g = computeEarningsGate({ ...base, symbol: 'AAPL', equity: 0, prospectiveBprDollars: 5000 });
    assert.equal(g.status, 'OK'); // can't evaluate 3%/10% with no equity; not blocked
    assert.equal(g.earningsCapDollars, 0);
  });
});
