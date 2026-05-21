/**
 * Run with:  npx tsx --test entry-gate.test.ts
 * (requires reconstruct-positions.ts, position-limits.ts, bpr.ts in the same dir)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeEntryGate } from './entry-gate';
import type { BprUtilization } from './bpr';
import type { ReconstructedPosition, PositionKind } from './reconstruct-positions';

function pos(kind: PositionKind, underlying: string): ReconstructedPosition {
  const spread = kind !== 'OTHER';
  return {
    kind, underlying, expiration: '2026-06-19', legs: [], quantity: 1,
    wingWidth: spread ? 1000 : null, credit: spread ? 180 : null, bpr: spread ? 820 : null,
    openPnl: 0, openPnlReliable: true, dte: 30,
  };
}
const condor = (u: string) => pos('IRON_CONDOR', u);

function util(openBpr: number, cap = 5000): BprUtilization {
  return {
    equity: cap * 2, cap, openBpr, remaining: cap - openBpr,
    pctOfCap: cap > 0 ? (openBpr / cap) * 100 : Infinity,
    pctOfEquity: 0, status: 'OK', slotsUsed: 0,
  };
}

describe('computeEntryGate', () => {
  it('returns OK for a non-passing setup regardless of caps', () => {
    const g = computeEntryGate({
      positions: [condor('SPY'), condor('QQQ')],
      bprUtil: util(4900),
      symbol: 'IWM',
      passesFilter: false,
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'OK');
    assert.equal(g.reasons.length, 0);
  });

  it('BLOCKED when the equity block is full', () => {
    const g = computeEntryGate({
      positions: [condor('SPY'), condor('QQQ')],
      bprUtil: util(1640),
      symbol: 'IWM',
      passesFilter: true,
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Equity block full/);
  });

  it('BLOCKED when entering would exceed the BPR cap', () => {
    const g = computeEntryGate({
      positions: [condor('TLT')], // no pillar conflict for GLD
      bprUtil: util(4500),
      symbol: 'GLD',
      passesFilter: true,
      prospectiveBprDollars: 820, // 4500 + 820 = 5320 > 5000
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /exceed the 50% BPR cap/);
  });

  it('TIGHT when within the BPR cap but ≥90%', () => {
    const g = computeEntryGate({
      positions: [condor('TLT')],
      bprUtil: util(3700),
      symbol: 'GLD',
      passesFilter: true,
      prospectiveBprDollars: 820, // 4520 / 5000 = 90.4%
    });
    assert.equal(g.status, 'TIGHT');
    assert.match(g.reasons.join(' '), /% of the BPR cap/);
  });

  it('OK when both gates clear', () => {
    const g = computeEntryGate({
      positions: [condor('TLT')],
      bprUtil: util(820),
      symbol: 'GLD',
      passesFilter: true,
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'OK');
    assert.equal(g.reasons.length, 0);
  });

  it('BLOCKED takes precedence over TIGHT and accumulates reasons', () => {
    const g = computeEntryGate({
      positions: [condor('VXX')], // vol pillar full
      bprUtil: util(4500),
      symbol: 'UVXY',
      passesFilter: true,
      prospectiveBprDollars: 820, // also exceeds BPR
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Volatility pillar full/);
    assert.match(g.reasons.join(' '), /exceed the 50% BPR cap/);
  });

  it('handles a null bprUtil (positions loaded, balances not) — limits only', () => {
    const g = computeEntryGate({
      positions: [condor('VXX')],
      bprUtil: null,
      symbol: 'UVXY',
      passesFilter: true,
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'BLOCKED'); // vol pillar still enforced
  });
});
