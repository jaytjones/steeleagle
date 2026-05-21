/**
 * Run with:  npx tsx --test position-alerts.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alertFor, summarizeAlerts } from './position-alerts';
import type { ReconstructedPosition } from './reconstruct-positions';

// credit 180 → profit target 90; stop (non-vol) at -360; vol stop at -270.
function p(over: Partial<ReconstructedPosition>): ReconstructedPosition {
  return {
    kind: 'IRON_CONDOR', underlying: 'SPY', expiration: '2026-06-19', legs: [],
    quantity: 1, wingWidth: 1000, credit: 180, bpr: 820,
    openPnl: 0, openPnlReliable: true, dte: 30,
    ...over,
  };
}

describe('alertFor — time (21-DTE rule)', () => {
  it('ACTION (close) at ≤21 DTE', () => {
    const a = alertFor(p({ dte: 20 }));
    assert.equal(a.level, 'ACTION');
    assert.match(a.reasons[0], /21-DTE rule/);
  });
  it('WATCH at 22–23 DTE', () => {
    assert.equal(alertFor(p({ dte: 22 })).level, 'WATCH');
    assert.equal(alertFor(p({ dte: 23 })).level, 'WATCH');
  });
  it('NONE well before 21 DTE', () => {
    assert.equal(alertFor(p({ dte: 30 })).level, 'NONE');
  });
});

describe('alertFor — profit target', () => {
  it('ACTION + positive tone at ≥50% of credit', () => {
    const a = alertFor(p({ dte: 30, openPnl: 100 })); // 100 ≥ 90
    assert.equal(a.level, 'ACTION');
    assert.equal(a.tone, 'positive');
    assert.match(a.reasons[0], /Profit target/);
  });
  it('NONE just under target', () => {
    assert.equal(alertFor(p({ dte: 30, openPnl: 80 })).level, 'NONE');
  });
});

describe('alertFor — stop-loss', () => {
  it('ACTION + negative tone at ≥2× credit loss (non-vol)', () => {
    const a = alertFor(p({ dte: 30, openPnl: -400 })); // 2.22×
    assert.equal(a.level, 'ACTION');
    assert.equal(a.tone, 'negative');
    assert.match(a.reasons[0], /Stop-loss/);
  });
  it('non-vol loss below 2× does not trigger', () => {
    assert.equal(alertFor(p({ dte: 30, openPnl: -300 })).level, 'NONE'); // 1.67×
  });
  it('Volatility pillar trips the stop earlier, at 1.5×', () => {
    const vol = alertFor(p({ underlying: 'VXX', dte: 30, openPnl: -300 })); // 1.67× ≥ 1.5
    assert.equal(vol.level, 'ACTION');
    assert.equal(vol.tone, 'negative');
    // same loss on a non-vol underlying stays NONE
    assert.equal(alertFor(p({ underlying: 'SPY', dte: 30, openPnl: -300 })).level, 'NONE');
  });
});

describe('alertFor — open-P&L reliability guard', () => {
  it('skips profit/stop signals when openPnl is today-only', () => {
    const a = alertFor(p({ dte: 30, openPnl: 1000, openPnlReliable: false }));
    assert.equal(a.level, 'NONE'); // would have been a profit ACTION if reliable
  });
  it('still fires the time-based alert when P&L is unreliable', () => {
    const a = alertFor(p({ dte: 20, openPnl: 1000, openPnlReliable: false }));
    assert.equal(a.level, 'ACTION');
    assert.match(a.reasons[0], /21-DTE/);
  });
});

describe('alertFor — combined signals', () => {
  it('21-DTE + profit: ACTION, positive tone, both reasons (time first)', () => {
    const a = alertFor(p({ dte: 20, openPnl: 120 }));
    assert.equal(a.level, 'ACTION');
    assert.equal(a.tone, 'positive');
    assert.match(a.reasons[0], /21-DTE/);
    assert.match(a.reasons.join(' '), /Profit target/);
  });
  it('21-DTE + stop: negative tone, stop listed first', () => {
    const a = alertFor(p({ dte: 20, openPnl: -400 }));
    assert.equal(a.tone, 'negative');
    assert.match(a.reasons[0], /Stop-loss/);
  });
  it('OTHER bucket never alerts', () => {
    assert.equal(alertFor(p({ kind: 'OTHER', credit: null, dte: 10 })).level, 'NONE');
  });
});

describe('summarizeAlerts', () => {
  it('counts action vs watch across positions', () => {
    const s = summarizeAlerts([
      p({ dte: 20 }),                       // ACTION (time)
      p({ dte: 30, openPnl: 100 }),         // ACTION (profit)
      p({ dte: 22 }),                       // WATCH
      p({ dte: 40 }),                       // NONE
      p({ kind: 'OTHER', credit: null }),   // NONE
    ]);
    assert.equal(s.action, 2);
    assert.equal(s.watch, 1);
  });
});
