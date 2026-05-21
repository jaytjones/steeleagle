/**
 * Run with:  npx tsx --test position-limits.test.ts
 * (requires reconstruct-positions.ts in the same directory for the type)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPositionLimits, pillarOf, MAX_CONCURRENT_POSITIONS } from './position-limits';
import type { ReconstructedPosition, PositionKind } from './reconstruct-positions';

/** Minimal ReconstructedPosition factory — only kind + underlying drive the limits. */
function pos(kind: PositionKind, underlying: string): ReconstructedPosition {
  const spread = kind !== 'OTHER';
  return {
    kind,
    underlying,
    expiration: '2026-06-19',
    legs: [],
    quantity: 1,
    wingWidth: spread ? 1000 : null,
    credit: spread ? 180 : null,
    bpr: spread ? 820 : null,
    openPnl: 0,
    openPnlReliable: true,
    dte: 30,
  };
}
const condor = (u: string) => pos('IRON_CONDOR', u);
const vertical = (u: string) => pos('VERTICAL_SPREAD', u);

describe('pillarOf', () => {
  it('maps all six equity names to one EQUITY pillar (incl. IWM, DIA)', () => {
    for (const s of ['SPY', 'QQQ', 'IWM', 'DIA', 'EFA', 'EEM']) {
      assert.equal(pillarOf(s), 'EQUITY');
    }
  });
  it('maps vol, currency, FI, commodity correctly', () => {
    assert.equal(pillarOf('VXX'), 'VOLATILITY');
    assert.equal(pillarOf('UUP'), 'CURRENCY');
    assert.equal(pillarOf('TLT'), 'FIXED_INCOME');
    assert.equal(pillarOf('GLD'), 'COMMODITY');
  });
  it('returns UNKNOWN for off-universe tickers', () => {
    assert.equal(pillarOf('ARKK'), 'UNKNOWN');
  });
});

describe('global 5-position cap', () => {
  it('allows entry below the cap', () => {
    const open = [condor('SPY'), condor('TLT'), condor('GLD')];
    const c = checkPositionLimits(open, 'VXX');
    assert.ok(c.allowed);
    assert.equal(c.slotsUsed, 3);
  });

  it('blocks entry at the 5-position cap regardless of pillar', () => {
    const open = [condor('SPY'), condor('TLT'), condor('GLD'), condor('VXX'), condor('UUP')];
    const c = checkPositionLimits(open, 'DBA');
    assert.ok(!c.allowed);
    assert.match(c.reasons[0], new RegExp(`${MAX_CONCURRENT_POSITIONS}-position cap`));
  });
});

describe('equity block (max 2, IWM/DIA included)', () => {
  it('blocks a third equity entry — IWM counts toward the block', () => {
    const open = [condor('SPY'), condor('QQQ')];
    const c = checkPositionLimits(open, 'IWM');
    assert.ok(!c.allowed);
    assert.equal(c.pillar, 'EQUITY');
    assert.equal(c.pillarCount, 2);
    assert.equal(c.pillarMax, 2);
    assert.match(c.reasons[0], /Equity block full/);
  });

  it('counts DIA and EFA as block members too', () => {
    const open = [condor('DIA'), condor('EFA')];
    assert.ok(!checkPositionLimits(open, 'SPY').allowed);
  });

  it('allows a non-equity entry while the equity block is full', () => {
    const open = [condor('SPY'), condor('QQQ')];
    const c = checkPositionLimits(open, 'TLT'); // FI — not in the equity block
    assert.ok(c.allowed);
    assert.equal(c.pillarCount, 0);
  });

  it('allows the second equity entry', () => {
    const c = checkPositionLimits([condor('SPY')], 'IWM');
    assert.ok(c.allowed);
    assert.equal(c.pillarCount, 1);
  });
});

describe('volatility & currency single-position caps', () => {
  it('blocks a second volatility entry', () => {
    const c = checkPositionLimits([condor('VXX')], 'UVXY');
    assert.ok(!c.allowed);
    assert.match(c.reasons[0], /Volatility pillar full/);
  });
  it('blocks a second currency entry', () => {
    const c = checkPositionLimits([condor('UUP')], 'FXE');
    assert.ok(!c.allowed);
    assert.match(c.reasons[0], /Currency pillar full/);
  });
});

describe('uncapped pillars', () => {
  it('allows multiple Fixed Income positions (no per-pillar cap)', () => {
    const c = checkPositionLimits([condor('TLT'), condor('IEF')], 'HYG');
    assert.ok(c.allowed);
    assert.equal(c.pillarMax, null);
  });
  it('allows multiple Commodity positions', () => {
    const c = checkPositionLimits([condor('GLD'), condor('SLV')], 'USO');
    assert.ok(c.allowed);
  });
});

describe('slot accounting', () => {
  it('counts a vertical (partial wing) toward both the global and pillar caps', () => {
    const open = [vertical('SPY'), condor('QQQ')]; // 2 equity slots
    const c = checkPositionLimits(open, 'DIA');
    assert.ok(!c.allowed);
    assert.equal(c.pillarCount, 2);
    assert.equal(c.slotsUsed, 2);
  });

  it('ignores OTHER-bucket holdings (equities / MMF) in the counts', () => {
    const open = [pos('OTHER', 'SCHB'), pos('OTHER', 'SWVXX')];
    const c = checkPositionLimits(open, 'SPY');
    assert.ok(c.allowed);
    assert.equal(c.slotsUsed, 0);
    assert.equal(c.pillarCount, 0);
  });
});

describe('unknown symbols', () => {
  it('applies only the global cap to off-universe tickers', () => {
    const open = [condor('SPY'), condor('QQQ'), condor('TLT'), condor('GLD')];
    const c = checkPositionLimits(open, 'ARKK');
    assert.ok(c.allowed); // 4 < 5, no pillar cap
    assert.equal(c.pillar, 'UNKNOWN');
    assert.equal(c.pillarMax, null);
  });
  it('still blocks an unknown ticker at the global cap', () => {
    const open = [condor('SPY'), condor('QQQ'), condor('TLT'), condor('GLD'), condor('VXX')];
    assert.ok(!checkPositionLimits(open, 'ARKK').allowed);
  });
});
