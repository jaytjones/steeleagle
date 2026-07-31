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
  /**
   * v2.5 — REPLACES "returns OK for a non-passing setup regardless of caps".
   *
   * The gate used to short-circuit to OK whenever the strategy filters hadn't
   * passed, on the reasoning that FAIL/CALIBRATING cards could never be placed
   * anyway. Every verdict is overridable now, so the capital constraints are
   * the opposite of moot: overriding a FAIL creates neither buying power nor a
   * free position slot, and both must be visible before the operator decides.
   */
  it('evaluates caps independently of the strategy verdict (v2.5)', () => {
    const g = computeEntryGate({
      positions: [condor('SPY'), condor('QQQ')],
      bprUtil: util(4900),
      symbol: 'IWM',
      prospectiveBprDollars: 820,
    });
    // Equity block full AND the BPR cap would be exceeded — both reported,
    // where the pre-v2.5 gate reported neither.
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Equity block full/);
    assert.match(g.reasons.join(' '), /exceed the 50% BPR cap/);
  });

  it('BLOCKED when the equity block is full', () => {
    const g = computeEntryGate({
      positions: [condor('SPY'), condor('QQQ')],
      bprUtil: util(1640),
      symbol: 'IWM',
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
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'BLOCKED'); // vol pillar still enforced
  });
});

// --- v2.4 §7.2 — same-index overlap WARNS, never blocks ----------------------

describe('same-index overlap warning (v2.4 §7.2)', () => {
  it('stays OK but carries the warning when a sibling is open', () => {
    const g = computeEntryGate({
      positions: [condor('SPY')],
      bprUtil: util(500),
      symbol: 'XSP',
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'OK'); // DECIDED §0a.2 — warn, do not block
    assert.equal(g.reasons.length, 0);
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /same-index overlap: SPY position open/);
    assert.match(g.warnings[0], /zero diversification/);
  });

  it('does not downgrade a TIGHT verdict or promote it to BLOCKED', () => {
    const g = computeEntryGate({
      positions: [condor('SPY')],
      bprUtil: util(3800), // + 820 lands in the TIGHT band
      symbol: 'XSP',
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'TIGHT');
    assert.equal(g.warnings.length, 1);
  });

  it('rides alongside a BLOCKED verdict without joining the block reasons', () => {
    const g = computeEntryGate({
      positions: [condor('SPY'), condor('QQQ')], // equity block full
      bprUtil: util(500),
      symbol: 'XSP',
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'BLOCKED');
    assert.match(g.reasons.join(' '), /Equity block full/);
    assert.ok(!g.reasons.some((r) => /same-index/.test(r)));
    assert.equal(g.warnings.length, 1);
  });

  it('emits no warning when no sibling is open', () => {
    const g = computeEntryGate({
      positions: [condor('TLT')],
      bprUtil: util(500),
      symbol: 'XSP',
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'OK');
    assert.deepEqual(g.warnings, []);
  });

  /**
   * v2.5 — REPLACES "emits no warning for a setup that fails the strategy
   * filters". The same-index warning is now surfaced on every card, because a
   * FAIL card can be overridden into a real order: April must see "you already
   * hold SPY" before deciding to place XSP anyway.
   */
  it('warns on a filter-failing setup too, now that it is overridable (v2.5)', () => {
    const g = computeEntryGate({
      positions: [condor('SPY')],
      bprUtil: util(500),
      symbol: 'XSP',
      prospectiveBprDollars: 820,
    });
    assert.equal(g.status, 'OK'); // still never blocks — advisory only
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /same-index overlap: SPY position open/);
  });
});
