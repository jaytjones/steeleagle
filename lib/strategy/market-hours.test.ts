// lib/strategy/market-hours.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRegularMarketHours,
  etWallClock,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
} from './market-hours';

// All fixtures are UTC instants with their ET equivalent verified against the
// system tz database. EDT = UTC-4, EST = UTC-5.
const at = (iso: string) => new Date(iso);

test('etWallClock resolves ET weekday and minute-of-day (EDT)', () => {
  // 2026-07-31T13:30:00Z === Fri 2026-07-31 09:30 EDT
  const wc = etWallClock(at('2026-07-31T13:30:00Z'));
  assert.equal(wc.weekday, 5); // Friday
  assert.equal(wc.minutes, MARKET_OPEN_MINUTES);
});

test('etWallClock resolves ET weekday and minute-of-day (EST)', () => {
  // 2026-01-05T14:30:00Z === Mon 2026-01-05 09:30 EST
  const wc = etWallClock(at('2026-01-05T14:30:00Z'));
  assert.equal(wc.weekday, 1); // Monday
  assert.equal(wc.minutes, MARKET_OPEN_MINUTES);
});

test('ET midnight is 0 minutes, not 1440 (hourCycle h23 guard)', () => {
  // 2026-07-31T04:00:00Z === Fri 2026-07-31 00:00 EDT
  assert.equal(etWallClock(at('2026-07-31T04:00:00Z')).minutes, 0);
});

test('open at the bell, closed one minute before (EDT)', () => {
  assert.equal(isRegularMarketHours(at('2026-07-31T13:30:00Z')), true); // 09:30 ET
  assert.equal(isRegularMarketHours(at('2026-07-31T13:29:00Z')), false); // 09:29 ET
});

test('open through 15:59, closed at 16:00 exactly (EDT)', () => {
  assert.equal(isRegularMarketHours(at('2026-07-31T19:59:00Z')), true); // 15:59 ET
  assert.equal(isRegularMarketHours(at('2026-07-31T20:00:00Z')), false); // 16:00 ET
});

test('the post-close sweep cron fires outside regular hours', () => {
  // vercel.json "15 21 * * 1-5" → 21:15 UTC = 4:15 PM CDT / 5:15 PM EDT.
  // Greeks are long zeroed by then; NO_DELTA at sweep time is expected.
  assert.equal(isRegularMarketHours(at('2026-07-31T21:15:00Z')), false);
  // Same schedule in winter: 21:15 UTC = 3:15 PM CST / 4:15 PM EST — still closed,
  // but only 15 minutes after the bell. See tech-spec v2-3 §4.0.
  assert.equal(isRegularMarketHours(at('2026-12-15T21:15:00Z')), false);
});

test('boundaries hold across the DST change (EST)', () => {
  assert.equal(isRegularMarketHours(at('2026-01-05T14:30:00Z')), true); // 09:30 ET
  assert.equal(isRegularMarketHours(at('2026-01-05T14:29:00Z')), false); // 09:29 ET
  assert.equal(isRegularMarketHours(at('2026-01-05T20:59:00Z')), true); // 15:59 ET
  assert.equal(isRegularMarketHours(at('2026-01-05T21:00:00Z')), false); // 16:00 ET
});

test('weekends are closed even at mid-session hours', () => {
  assert.equal(isRegularMarketHours(at('2026-08-01T17:00:00Z')), false); // Sat 13:00 ET
  assert.equal(isRegularMarketHours(at('2026-08-02T17:00:00Z')), false); // Sun 13:00 ET
});

test('overnight is closed', () => {
  assert.equal(isRegularMarketHours(at('2026-07-31T06:00:00Z')), false); // 02:00 ET
  assert.equal(isRegularMarketHours(at('2026-07-30T12:00:00Z')), false); // 08:00 ET pre-market
});

test('session window constants are the NYSE bells', () => {
  assert.equal(MARKET_OPEN_MINUTES, 570);
  assert.equal(MARKET_CLOSE_MINUTES, 960);
});

test('DOCUMENTED GAP: market holidays read as open (no calendar by design)', () => {
  // Thu 2026-01-01 12:00 ET — New Year's Day, market shut. This asserts the
  // deliberate fail-loud choice from the spec, so a future holiday table has to
  // update this test consciously rather than silently flipping the direction.
  assert.equal(isRegularMarketHours(at('2026-01-01T17:00:00Z')), true);
});
