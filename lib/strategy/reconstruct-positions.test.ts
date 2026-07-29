/**
 * Run with:  npx tsx --test reconstruct-positions.test.ts
 * (Vitest users: swap the import line for `import { describe, it } from 'vitest'`
 *  and `assert.*` for `expect`; the structure is identical.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOccSymbol,
  reconstructPositions,
  summarizeOpenRisk,
  type SchwabPosition,
} from './reconstruct-positions';

// Fixed "now" so DTE assertions are deterministic.
const NOW = new Date('2026-05-20T15:00:00Z');

// --- Helpers to build Schwab-shaped legs --------------------------------------

function occ(underlying: string, exp: string, cp: 'P' | 'C', strike: number): string {
  const [y, m, d] = exp.split('-');
  const dateStr = `${y.slice(2)}${m}${d}`;
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  const pad = underlying.padEnd(6, ' ');
  return `${pad}${dateStr}${cp}${strikeStr}`;
}

function optLeg(
  underlying: string,
  exp: string,
  cp: 'P' | 'C',
  strike: number,
  dir: 'long' | 'short',
  avg: number,
): SchwabPosition {
  return {
    instrument: { symbol: occ(underlying, exp, cp, strike), assetType: 'OPTION', putCall: cp === 'P' ? 'PUT' : 'CALL' },
    longQuantity: dir === 'long' ? 1 : 0,
    shortQuantity: dir === 'short' ? 1 : 0,
    marketValue: dir === 'long' ? avg * 100 : -avg * 100,
    averagePrice: avg,
    longOpenProfitLoss: dir === 'long' ? 5 : 0,
    shortOpenProfitLoss: dir === 'short' ? 10 : 0,
  };
}

// A clean SPY condor: LP 480 / SP 490 / SC 530 / LC 540, ~$10 wings.
// credit/sh = (1.30 + 1.20) - (0.40 + 0.30) = 1.80 -> credit 180, wing 1000, bpr 820.
function spyCondor(exp = '2026-06-19'): SchwabPosition[] {
  return [
    optLeg('SPY', exp, 'P', 480, 'long', 0.4),
    optLeg('SPY', exp, 'P', 490, 'short', 1.3),
    optLeg('SPY', exp, 'C', 530, 'short', 1.2),
    optLeg('SPY', exp, 'C', 540, 'long', 0.3),
  ];
}

// --- OCC parsing --------------------------------------------------------------

describe('parseOccSymbol', () => {
  it('parses 6-char padded form', () => {
    assert.deepEqual(parseOccSymbol('SPY   260619P00480000'), {
      root: 'SPY',
      underlying: 'SPY',
      expiration: '2026-06-19',
      putCall: 'PUT',
      strike: 480,
    });
  });

  // --- v2.4: root ≠ underlying for index options (spec §5) ---
  it('keeps the raw root and resolves the underlying for a PM index root', () => {
    assert.deepEqual(parseOccSymbol('SPXW  260918P06500000'), {
      root: 'SPXW',
      underlying: 'SPX',
      expiration: '2026-09-18',
      putCall: 'PUT',
      strike: 6500,
    });
  });

  it('resolves the AM index root to the same underlying', () => {
    const am = parseOccSymbol('SPX   260918C07500000');
    assert.equal(am?.root, 'SPX');
    assert.equal(am?.underlying, 'SPX');
  });

  it('maps NDXP → NDX and RUTW → RUT', () => {
    assert.equal(parseOccSymbol('NDXP  260918P28000000')?.underlying, 'NDX');
    assert.equal(parseOccSymbol('RUTW  260918C03000000')?.underlying, 'RUT');
  });

  it('XSP has a single root — root and underlying agree (Phase 0 V2)', () => {
    const xsp = parseOccSymbol('XSP   260918P00730000');
    assert.equal(xsp?.root, 'XSP');
    assert.equal(xsp?.underlying, 'XSP');
    assert.equal(xsp?.strike, 730);
  });

  it('leaves an unmapped root as its own underlying (passthrough)', () => {
    const p = parseOccSymbol('ARKK  260619P00040000');
    assert.equal(p?.root, 'ARKK');
    assert.equal(p?.underlying, 'ARKK');
  });

  it('tolerates single-space and no-space forms', () => {
    assert.equal(parseOccSymbol('SPY 260619C00540000')?.strike, 540);
    assert.equal(parseOccSymbol('SPY260619C00540000')?.putCall, 'CALL');
  });

  it('handles fractional strikes (x1000 encoding)', () => {
    assert.equal(parseOccSymbol('SLV   260619P00024500')?.strike, 24.5);
  });

  it('returns null for non-option tickers', () => {
    assert.equal(parseOccSymbol('SCHB'), null);
    assert.equal(parseOccSymbol('SWVXX'), null);
  });
});

// --- Iron condor --------------------------------------------------------------

describe('iron condor reconstruction', () => {
  it('classifies a clean 4-leg condor and derives BPR from max loss', () => {
    const [p] = reconstructPositions(spyCondor(), NOW);
    assert.equal(p.kind, 'IRON_CONDOR');
    assert.equal(p.underlying, 'SPY');
    assert.equal(p.wingWidth, 1000);
    assert.ok(Math.abs(p.credit! - 180) < 1e-9);
    assert.ok(Math.abs(p.bpr! - 820) < 1e-9);
    assert.equal(p.dte, 30); // 2026-05-20 -> 2026-06-19
    assert.equal(p.legs.length, 4);
  });

  it('keeps two condors on the same underlying but different expirations separate', () => {
    const result = reconstructPositions([...spyCondor('2026-06-19'), ...spyCondor('2026-07-17')], NOW);
    const condors = result.filter((r) => r.kind === 'IRON_CONDOR');
    assert.equal(condors.length, 2);
    assert.deepEqual(condors.map((c) => c.dte).sort((a, b) => a! - b!), [30, 58]);
  });

  // --- v2.4 §5: the split-pile failure this milestone exists to prevent ---
  it('assembles a MIXED-root SPX condor into ONE position, not two OTHER piles', () => {
    // Phase 0 V2: one /chains response carries both SPXW (PM) and SPX (AM)
    // roots, and a monthly expiration can hold legs of each. Before the
    // mapping, this grouped as "SPXW" (2 legs) + "SPX" (2 legs) → two OTHERs.
    const exp = '2026-06-19';
    const mixed = [
      optLeg('SPXW', exp, 'P', 6500, 'long', 4.0),
      optLeg('SPX', exp, 'P', 6600, 'short', 13.0),
      optLeg('SPXW', exp, 'C', 7800, 'short', 12.0),
      optLeg('SPX', exp, 'C', 7900, 'long', 3.0),
    ];
    const result = reconstructPositions(mixed, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'IRON_CONDOR');
    assert.equal(result[0].underlying, 'SPX');
    assert.equal(result[0].legs.length, 4);
    // Each leg still remembers the root it actually trades under.
    assert.deepEqual(result[0].legs.map((l) => l.root), ['SPXW', 'SPX', 'SPXW', 'SPX']);
  });

  it('reconstructs a single-root XSP condor with root === underlying', () => {
    const exp = '2026-06-19';
    const xsp = [
      optLeg('XSP', exp, 'P', 700, 'long', 0.4),
      optLeg('XSP', exp, 'P', 710, 'short', 1.3),
      optLeg('XSP', exp, 'C', 770, 'short', 1.2),
      optLeg('XSP', exp, 'C', 780, 'long', 0.3),
    ];
    const [p] = reconstructPositions(xsp, NOW);
    assert.equal(p.kind, 'IRON_CONDOR');
    assert.equal(p.underlying, 'XSP');
    assert.ok(p.legs.every((l) => l.root === 'XSP'));
  });
});

// --- Vertical spread (partial close = one wing) -------------------------------

describe('vertical spread reconstruction', () => {
  it('classifies a remaining put wing as a PUT vertical, separate from condors', () => {
    // Only the put spread remains (call side was closed).
    const legs = [optLeg('TLT', '2026-06-19', 'P', 85, 'long', 0.3), optLeg('TLT', '2026-06-19', 'P', 90, 'short', 1.1)];
    const [p] = reconstructPositions(legs, NOW);
    assert.equal(p.kind, 'VERTICAL_SPREAD');
    assert.equal(p.side, 'PUT');
    assert.equal(p.wingWidth, 500);
    assert.ok(Math.abs(p.credit! - 80) < 1e-9);
    assert.ok(Math.abs(p.bpr! - 420) < 1e-9); // fractional BPR vs the full condor
  });

  it('classifies a remaining call wing as a CALL vertical', () => {
    const legs = [optLeg('GLD', '2026-06-19', 'C', 320, 'short', 1.0), optLeg('GLD', '2026-06-19', 'C', 330, 'long', 0.25)];
    const [p] = reconstructPositions(legs, NOW);
    assert.equal(p.kind, 'VERTICAL_SPREAD');
    assert.equal(p.side, 'CALL');
  });
});

// --- Others -------------------------------------------------------------------

describe('other positions', () => {
  it('routes equities and money-market funds to OTHER', () => {
    const positions: SchwabPosition[] = [
      { instrument: { symbol: 'SCHB', assetType: 'EQUITY' }, longQuantity: 100, shortQuantity: 0, marketValue: 2200, averagePrice: 21 },
      { instrument: { symbol: 'SWVXX', assetType: 'CASH_EQUIVALENT' }, longQuantity: 3000, shortQuantity: 0, marketValue: 3000, averagePrice: 1 },
    ];
    const result = reconstructPositions(positions, NOW);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.kind === 'OTHER'));
    assert.ok(result.every((r) => r.bpr === null && r.expiration === null));
  });

  it('routes an unrecognized 3-leg option fragment to OTHER with a note', () => {
    const legs = [
      optLeg('IWM', '2026-06-19', 'P', 200, 'long', 0.4),
      optLeg('IWM', '2026-06-19', 'P', 210, 'short', 1.2),
      optLeg('IWM', '2026-06-19', 'C', 240, 'short', 1.1),
    ];
    const [p] = reconstructPositions(legs, NOW);
    assert.equal(p.kind, 'OTHER');
    assert.match(p.note ?? '', /Unrecognized option group \(3 legs\)/);
  });

  it('KNOWN LIMITATION: two condors on the SAME underlying+expiration fall to OTHER', () => {
    // 8 legs in one (underlying, expiration) group — not auto-split. Flagged, not crashed.
    const eight = [
      ...spyCondor('2026-06-19'),
      optLeg('SPY', '2026-06-19', 'P', 470, 'long', 0.2),
      optLeg('SPY', '2026-06-19', 'P', 485, 'short', 0.9),
      optLeg('SPY', '2026-06-19', 'C', 545, 'short', 0.8),
      optLeg('SPY', '2026-06-19', 'C', 555, 'long', 0.15),
    ];
    const result = reconstructPositions(eight, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'OTHER');
  });
});

// --- Summary seam -------------------------------------------------------------

describe('summarizeOpenRisk', () => {
  it('counts a condor + a vertical as 2 slots and sums their BPR', () => {
    const positions = [
      ...spyCondor('2026-06-19'),
      optLeg('TLT', '2026-06-19', 'P', 85, 'long', 0.3),
      optLeg('TLT', '2026-06-19', 'P', 90, 'short', 1.1),
      { instrument: { symbol: 'SWVXX', assetType: 'CASH_EQUIVALENT' }, longQuantity: 3000, shortQuantity: 0, marketValue: 3000, averagePrice: 1 } as SchwabPosition,
    ];
    const s = summarizeOpenRisk(reconstructPositions(positions, NOW));
    assert.equal(s.slotsUsed, 2);
    assert.equal(s.condorCount, 1);
    assert.equal(s.verticalCount, 1);
    assert.equal(s.otherCount, 1);
    assert.ok(Math.abs(s.openBpr - (820 + 420)) < 1e-9);
  });
});
