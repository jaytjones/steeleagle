// lib/strategy/roll-alert.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRollAlert,
  summarizeRollAlerts,
  rollBadge,
  deltaMarker,
  noDeltaVerdict,
  countStaleDeltas,
  ROLL_TRIGGER_DELTA,
  ROLL_TARGET_DELTA,
  type RollInputPosition,
  type ShortDelta,
} from './roll-alert';

// --- fixtures -------------------------------------------------------------

const SP = 'SPY   260320P00500000';
const SC = 'SPY   260320C00560000';

function condor(): RollInputPosition {
  return {
    symbol: 'SPY',
    type: 'IRON_CONDOR',
    legs: [
      { action: 'BUY', type: 'PUT', occSymbol: 'SPY   260320P00490000' },
      { action: 'SELL', type: 'PUT', occSymbol: SP },
      { action: 'SELL', type: 'CALL', occSymbol: SC },
      { action: 'BUY', type: 'CALL', occSymbol: 'SPY   260320C00570000' },
    ],
  };
}

const d = (put: number | null, call: number | null): ShortDelta[] => [
  { occSymbol: SP, delta: put },
  { occSymbol: SC, delta: call },
];

// --- tests ----------------------------------------------------------------

test('neither short tested → NONE', () => {
  const v = computeRollAlert(condor(), d(-0.16, 0.15));
  assert.equal(v.status, 'NONE');
  assert.equal(v.rollSide, null);
});

test('short put tested → ROLL the untested CALL', () => {
  const v = computeRollAlert(condor(), d(-0.32, 0.15));
  assert.equal(v.status, 'ROLL');
  assert.equal(v.testedSide, 'PUT');
  assert.equal(v.rollSide, 'CALL');
  assert.equal(v.targetDelta, ROLL_TARGET_DELTA);
  assert.ok(Math.abs(v.testedDelta! - 0.32) < 1e-9);
});

test('short call tested → ROLL the untested PUT', () => {
  const v = computeRollAlert(condor(), d(-0.14, 0.34));
  assert.equal(v.status, 'ROLL');
  assert.equal(v.testedSide, 'CALL');
  assert.equal(v.rollSide, 'PUT');
});

test('exact boundary 0.30 counts as tested (>=)', () => {
  const v = computeRollAlert(condor(), d(-0.30, 0.15));
  assert.equal(v.status, 'ROLL');
  assert.equal(v.testedSide, 'PUT');
});

test('both shorts tested → BOTH_TESTED, no roll side', () => {
  const v = computeRollAlert(condor(), d(-0.33, 0.31));
  assert.equal(v.status, 'BOTH_TESTED');
  assert.equal(v.rollSide, null);
  assert.equal(v.testedSide, null);
});

test('watch band [0.27, 0.30) → WATCH', () => {
  const v = computeRollAlert(condor(), d(-0.28, 0.12));
  assert.equal(v.status, 'WATCH');
  assert.equal(v.testedSide, 'PUT');
  assert.equal(v.rollSide, null);
});

test('after-hours zero deltas, none tested → NO_DELTA', () => {
  const v = computeRollAlert(condor(), d(0, 0));
  assert.equal(v.status, 'NO_DELTA');
});

test('one delta missing, none tested → NO_DELTA (cannot confirm safe)', () => {
  const v = computeRollAlert(condor(), d(-0.16, null));
  assert.equal(v.status, 'NO_DELTA');
});

test('tested side present, untested side missing → still ROLL', () => {
  const v = computeRollAlert(condor(), d(-0.35, null));
  assert.equal(v.status, 'ROLL');
  assert.equal(v.testedSide, 'PUT');
  assert.equal(v.rollSide, 'CALL');
  assert.equal(v.untestedDelta, null);
});

test('NaN delta treated as unavailable', () => {
  const v = computeRollAlert(condor(), d(NaN, 0.15));
  assert.equal(v.status, 'NO_DELTA');
});

test('non-condor (vertical) → NONE', () => {
  const vertical: RollInputPosition = {
    symbol: 'TLT',
    type: 'VERTICAL_SPREAD',
    legs: [
      { action: 'SELL', type: 'PUT', occSymbol: 'TLT   260320P00090000' },
      { action: 'BUY', type: 'PUT', occSymbol: 'TLT   260320P00088000' },
    ],
  };
  assert.equal(computeRollAlert(vertical, []).status, 'NONE');
});

test('summarizeRollAlerts returns only ROLL symbols', () => {
  const a = computeRollAlert(condor(), d(-0.32, 0.15)); // ROLL
  const quiet = { ...condor(), symbol: 'GLD' };
  const b = computeRollAlert(quiet, d(-0.12, 0.10)); // NONE
  assert.deepEqual(summarizeRollAlerts([a, b]), ['SPY']);
});

test('rollBadge maps statuses to labels', () => {
  assert.equal(rollBadge(computeRollAlert(condor(), d(-0.32, 0.15))), 'ROLL');
  assert.equal(rollBadge(computeRollAlert(condor(), d(-0.33, 0.31))), 'REVIEW');
  assert.equal(rollBadge(computeRollAlert(condor(), d(-0.28, 0.12))), 'WATCH');
  assert.equal(rollBadge(computeRollAlert(condor(), d(-0.10, 0.10))), null);
});

// --- v2.6.1 delta-staleness marker ---------------------------------------

const IN_HOURS = new Date('2026-07-31T17:00:00Z'); // Fri 13:00 ET
const AFTER_HOURS = new Date('2026-07-31T21:15:00Z'); // Fri 4:15 PM CT — the real cron instant

test('deltaMarker: NO_DELTA during the session is an amber fault', () => {
  const v = computeRollAlert(condor(), d(null, null));
  assert.equal(v.status, 'NO_DELTA');
  const m = deltaMarker(v, IN_HOURS);
  assert.equal(m?.tone, 'STALE_IN_HOURS');
  assert.equal(m?.label, 'Δ STALE');
  assert.match(m!.title, /NOT running/);
});

test('deltaMarker: NO_DELTA after the close is the dim expected state', () => {
  const m = deltaMarker(computeRollAlert(condor(), d(null, null)), AFTER_HOURS);
  assert.equal(m?.tone, 'UNAVAILABLE_CLOSED');
  assert.equal(m?.label, 'Δ —');
  assert.match(m!.title, /Expected, not a fault/);
});

test('deltaMarker: a healthy verdict never shows a marker, in or out of hours', () => {
  const healthy = computeRollAlert(condor(), d(-0.12, 0.11)); // NONE
  assert.equal(deltaMarker(healthy, IN_HOURS), null);
  assert.equal(deltaMarker(healthy, AFTER_HOURS), null);
});

test('deltaMarker: an actionable verdict never shows a marker', () => {
  for (const deltas of [d(-0.32, 0.15), d(-0.33, 0.31), d(-0.28, 0.12)]) {
    assert.equal(deltaMarker(computeRollAlert(condor(), deltas), IN_HOURS), null);
  }
});

test('deltaMarker: undefined verdict (non-condor row) shows nothing', () => {
  assert.equal(deltaMarker(undefined, IN_HOURS), null);
});

test('deltaMarker: the route catch-path verdict marks stale in-hours', () => {
  const stamped = noDeltaVerdict('SPY', 'Delta fetch failed: HTTP 404');
  assert.equal(stamped.status, 'NO_DELTA');
  const m = deltaMarker(stamped, IN_HOURS);
  assert.equal(m?.tone, 'STALE_IN_HOURS');
  assert.match(m!.title, /HTTP 404/); // the real cause reaches the tooltip
});

test('countStaleDeltas counts only in-hours gaps, and only condors', () => {
  const blind = computeRollAlert(condor(), d(null, null));
  const healthy = computeRollAlert(condor(), d(-0.12, 0.11));
  const rows = [blind, healthy, undefined, blind];
  assert.equal(countStaleDeltas(rows, IN_HOURS), 2);
  assert.equal(countStaleDeltas(rows, AFTER_HOURS), 0);
});
