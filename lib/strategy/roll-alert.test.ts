// lib/strategy/roll-alert.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRollAlert,
  summarizeRollAlerts,
  rollBadge,
  ROLL_TRIGGER_DELTA,
  ROLL_TARGET_DELTA,
  type RollInputPosition,
  type ShortDelta,
} from './roll-alert.ts';

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
