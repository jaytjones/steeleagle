/**
 * Run with:  npx tsx --test earnings-entry-window.test.ts
 *
 * Fixtures use late-July 2026 (EDT = UTC-4), so ET 15:30 == 19:30Z.
 * Verified weekdays: 07-24 Fri, 07-27 Mon, 07-28 Tue, 07-31 Fri, 08-01 Sat.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entryWindow, entryDateFor, previousTradingDayISO, etParts } from './earnings-entry-window';

describe('entryDateFor', () => {
  it('AMC enters the report day', () => {
    assert.equal(entryDateFor('2026-07-28', 'AMC'), '2026-07-28');
  });
  it('BMO enters the prior trading day', () => {
    assert.equal(entryDateFor('2026-07-28', 'BMO'), '2026-07-27');
  });
  it('BMO on a Monday rolls back to Friday (enter Friday afternoon)', () => {
    assert.equal(entryDateFor('2026-07-27', 'BMO'), '2026-07-24');
  });
  it('DMH and UNKNOWN both enter the prior trading day (cautious)', () => {
    assert.equal(entryDateFor('2026-07-28', 'DMH'), '2026-07-27');
    assert.equal(entryDateFor('2026-07-28', 'UNKNOWN'), '2026-07-27');
  });
  it('AMC on a weekend (data quirk) rolls back to Friday', () => {
    assert.equal(entryDateFor('2026-08-01', 'AMC'), '2026-07-31');
  });
});

describe('previousTradingDayISO', () => {
  it('skips the weekend', () => {
    assert.equal(previousTradingDayISO('2026-07-27'), '2026-07-24'); // Mon → Fri
    assert.equal(previousTradingDayISO('2026-07-28'), '2026-07-27'); // Tue → Mon
  });
});

describe('etParts', () => {
  it('reads ET date + hour from a UTC instant (EDT = UTC-4)', () => {
    const p = etParts(new Date('2026-07-28T19:30:00Z'));
    assert.equal(p.date, '2026-07-28');
    assert.equal(p.hour, 15);
  });
});

describe('entryWindow — AMC report Tue 2026-07-28', () => {
  const report = '2026-07-28';
  it('ENTER_NOW during the last hour on the entry day', () => {
    const v = entryWindow(report, 'AMC', new Date('2026-07-28T19:30:00Z')); // ET Tue 15:30
    assert.equal(v.status, 'ENTER_NOW');
    assert.equal(v.entryDate, '2026-07-28');
    assert.match(v.label, /Enter now/);
  });
  it('UPCOMING earlier the same day (before 15:00 ET)', () => {
    const v = entryWindow(report, 'AMC', new Date('2026-07-28T14:00:00Z')); // ET Tue 10:00
    assert.equal(v.status, 'UPCOMING');
    assert.match(v.label, /Enter today PM \(AMC\)/);
  });
  it('PAST after the close on the entry day', () => {
    const v = entryWindow(report, 'AMC', new Date('2026-07-28T20:30:00Z')); // ET Tue 16:30
    assert.equal(v.status, 'PAST');
  });
  it('UPCOMING the day before, labelled with the entry weekday', () => {
    const v = entryWindow(report, 'AMC', new Date('2026-07-27T16:00:00Z')); // ET Mon 12:00
    assert.equal(v.status, 'UPCOMING');
    assert.match(v.label, /Enter Tue PM \(AMC\)/);
  });
});

describe('entryWindow — BMO report Tue 2026-07-28 (entry Mon)', () => {
  const report = '2026-07-28';
  it('ENTER_NOW Monday last hour', () => {
    const v = entryWindow(report, 'BMO', new Date('2026-07-27T19:30:00Z')); // ET Mon 15:30
    assert.equal(v.status, 'ENTER_NOW');
    assert.equal(v.entryDate, '2026-07-27');
  });
  it('PAST once the report day has arrived', () => {
    const v = entryWindow(report, 'BMO', new Date('2026-07-28T13:00:00Z')); // ET Tue 09:00
    assert.equal(v.status, 'PAST');
  });
});

describe('entryWindow — session edge cases', () => {
  it('UNKNOWN labels "session TBD" and uses the prior trading day', () => {
    const v = entryWindow('2026-07-28', 'UNKNOWN', new Date('2026-07-27T19:30:00Z'));
    assert.equal(v.status, 'ENTER_NOW');
    assert.match(v.label, /session TBD/);
  });
  it('AMC Friday → enter Friday afternoon', () => {
    const v = entryWindow('2026-07-31', 'AMC', new Date('2026-07-31T19:30:00Z')); // ET Fri 15:30
    assert.equal(v.status, 'ENTER_NOW');
    assert.equal(v.entryDate, '2026-07-31');
  });
  it('null report date → NO_DATE', () => {
    const v = entryWindow(null, 'AMC', new Date('2026-07-28T19:30:00Z'));
    assert.equal(v.status, 'NO_DATE');
    assert.equal(v.entryDate, null);
  });
});
