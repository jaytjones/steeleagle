/**
 * Run with:  npx tsx --test bpr.test.ts
 * (requires reconstruct-positions.ts in the same directory)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructPositions, type SchwabPosition } from './reconstruct-positions';
import {
  computeBprUtilization,
  preflightAddTrade,
  type SchwabBalances,
} from './bpr';

const NOW = new Date('2026-05-20T15:00:00Z');

function occ(underlying: string, exp: string, cp: 'P' | 'C', strike: number): string {
  const [y, m, d] = exp.split('-');
  return `${underlying.padEnd(6, ' ')}${y.slice(2)}${m}${d}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

function leg(u: string, exp: string, cp: 'P' | 'C', strike: number, dir: 'long' | 'short', avg: number): SchwabPosition {
  return {
    instrument: { symbol: occ(u, exp, cp, strike), assetType: 'OPTION', putCall: cp === 'P' ? 'PUT' : 'CALL' },
    longQuantity: dir === 'long' ? 1 : 0,
    shortQuantity: dir === 'short' ? 1 : 0,
    averagePrice: avg,
    longOpenProfitLoss: 0,
    shortOpenProfitLoss: 0,
  };
}

// Standard $10-wing condor: credit 1.80/sh -> bpr 820.
function condor(u: string, exp = '2026-06-19'): SchwabPosition[] {
  return [
    leg(u, exp, 'P', 480, 'long', 0.4),
    leg(u, exp, 'P', 490, 'short', 1.3),
    leg(u, exp, 'C', 530, 'short', 1.2),
    leg(u, exp, 'C', 540, 'long', 0.3),
  ];
}

const recon = (legs: SchwabPosition[]) => reconstructPositions(legs, NOW);
const bal = (liquidationValue: number): SchwabBalances => ({ liquidationValue });

describe('computeBprUtilization', () => {
  it('reports zero utilization on an empty account', () => {
    const u = computeBprUtilization(recon([]), bal(10_000));
    assert.equal(u.cap, 5000);
    assert.equal(u.openBpr, 0);
    assert.equal(u.pctOfCap, 0);
    assert.equal(u.status, 'OK');
    assert.equal(u.slotsUsed, 0);
  });

  it('computes cap, pct-of-cap, and pct-of-equity for one condor', () => {
    const u = computeBprUtilization(recon(condor('SPY')), bal(10_000));
    assert.ok(Math.abs(u.openBpr - 820) < 1e-6);
    assert.equal(u.cap, 5000);
    assert.ok(Math.abs(u.pctOfCap - 16.4) < 1e-9);
    assert.ok(Math.abs(u.pctOfEquity - 8.2) < 1e-9);
    assert.ok(Math.abs(u.remaining - 4180) < 1e-9);
    assert.equal(u.status, 'OK');
    assert.equal(u.slotsUsed, 1);
  });

  it('flips to WARNING at >= 80% of cap', () => {
    // 5 condors x 820 = 4100 of a 5000 cap = 82%.
    const legs = ['SPY', 'TLT', 'GLD', 'IWM', 'QQQ'].flatMap((u) => condor(u));
    const u = computeBprUtilization(recon(legs), bal(10_000));
    assert.ok(Math.abs(u.openBpr - 4100) < 1e-6);
    assert.ok(Math.abs(u.pctOfCap - 82) < 1e-6);
    assert.equal(u.status, 'WARNING');
  });

  it('flips to OVER once open BPR exceeds the cap', () => {
    // One 820 condor against a small account: cap = 750.
    const u = computeBprUtilization(recon(condor('SPY')), bal(1500));
    assert.equal(u.cap, 750);
    assert.equal(u.status, 'OVER');
    assert.ok(u.remaining < 0);
  });

  it('handles zero / missing equity without NaN', () => {
    const u = computeBprUtilization(recon(condor('SPY')), bal(0));
    assert.equal(u.cap, 0);
    assert.equal(u.pctOfCap, Infinity);
    assert.equal(u.status, 'OVER');
  });
});

describe('preflightAddTrade', () => {
  const at = (openBprDollars: number) => {
    // Build N condors to reach a target open BPR (multiples of 820), on a 5000 cap.
    const n = Math.round(openBprDollars / 820);
    const symbols = ['SPY', 'TLT', 'GLD', 'IWM', 'QQQ', 'DIA', 'EFA'].slice(0, n);
    const legs = symbols.flatMap((u) => condor(u));
    return computeBprUtilization(recon(legs), bal(10_000));
  };

  it('FITS when the entry leaves comfortable headroom', () => {
    const p = preflightAddTrade(at(820), 820); // 820 + 820 = 1640 of 5000
    assert.equal(p.status, 'FITS');
    assert.ok(p.fits);
    assert.ok(Math.abs(p.projectedPctOfCap - 32.8) < 1e-9);
  });

  it('TIGHT when the entry lands at >= 90% of cap but still fits', () => {
    // 4 condors = 3280; + 820 = 4100 of 5000 = 82%... bump base to push past 90.
    const base = at(3280); // 4 condors
    const p = preflightAddTrade(base, 1300); // 3280 + 1300 = 4580 of 5000 = 91.6%
    assert.ok(p.fits);
    assert.equal(p.status, 'TIGHT');
  });

  it('EXCEEDS and reports a negative projected headroom when over the cap', () => {
    const base = at(4920); // 6 condors = 4920
    const p = preflightAddTrade(base, 820); // 4920 + 820 = 5740 > 5000
    assert.equal(p.status, 'EXCEEDS');
    assert.ok(!p.fits);
    assert.ok(p.projectedRemaining < 0);
  });

  it('EXCEEDS on a zero-equity account', () => {
    const zero = computeBprUtilization(recon([]), bal(0));
    const p = preflightAddTrade(zero, 820);
    assert.equal(p.status, 'EXCEEDS');
  });
});
