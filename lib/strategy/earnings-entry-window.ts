/**
 * lib/strategy/earnings-entry-window.ts
 *
 * Entry-timing for the earnings sleeve (Strategy v1.5 §8.2). Encodes the rule:
 * enter in the LAST HOUR of regular trading (15:00–16:00 ET, when IV peaks) on
 * the session immediately before the IV-crush event.
 *
 *   AMC on day D  → announcement after the close → enter D's last hour.
 *   BMO on day D  → announcement before D's open → enter D−1's last hour.
 *   DMH on day D  → announcement mid-session → be positioned before D's open → enter D−1.
 *   UNKNOWN       → cautious: cover the worst case (BMO) by entering D−1's last hour.
 *   Friday-close  → AMC on a Friday resolves to "enter Friday afternoon" automatically;
 *                   a report landing on a weekend (data quirk) rolls back to Friday.
 *
 * Pure + deterministic: `now` is injected, all wall-clock reads go through ET.
 * Holiday calendar is NOT modelled — only weekends are skipped. A report the day
 * after a market holiday could therefore name a closed prior day as the entry day;
 * the route should treat that as a manual-review case (see v1.4 scoping §7.5).
 */

import type { EarningsSession } from './earnings-watchlist';

/** Last hour of regular trading (ET). IV peaks here; this is the entry slot. */
export const ENTRY_WINDOW_START_HOUR_ET = 15;
export const MARKET_CLOSE_HOUR_ET = 16;

export type EntryWindowStatus = 'ENTER_NOW' | 'UPCOMING' | 'PAST' | 'NO_DATE';

export type EntryWindowVerdict = {
  status: EntryWindowStatus;
  reportDate: string | null;
  session: EarningsSession;
  /** The trading day whose last hour you enter ('YYYY-MM-DD'); null if no date. */
  entryDate: string | null;
  /** Human label for the card, e.g. "Enter Thu PM (AMC)". */
  label: string;
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function entryWindow(
  reportDate: string | null,
  session: EarningsSession,
  now: Date,
): EntryWindowVerdict {
  if (!reportDate) {
    return { status: 'NO_DATE', reportDate: null, session, entryDate: null, label: 'No earnings date' };
  }

  const entryDate = entryDateFor(reportDate, session);
  const { date: etDate, hour: etHour } = etParts(now);

  const sessionTag = session === 'UNKNOWN' ? 'session TBD' : session;
  const wkdy = weekdayShortOf(entryDate);

  let status: EntryWindowStatus;
  let label: string;

  if (etDate < entryDate) {
    status = 'UPCOMING';
    label = `Enter ${wkdy} PM (${sessionTag})`;
  } else if (etDate === entryDate) {
    if (etHour < ENTRY_WINDOW_START_HOUR_ET) {
      status = 'UPCOMING';
      label = `Enter today PM (${sessionTag})`;
    } else if (etHour < MARKET_CLOSE_HOUR_ET) {
      status = 'ENTER_NOW';
      label = `Enter now — last hour (${sessionTag})`;
    } else {
      status = 'PAST';
      label = 'Entry window passed';
    }
  } else {
    status = 'PAST';
    label = 'Entry window passed';
  }

  return { status, reportDate, session, entryDate, label };
}

/** The session whose last hour you enter, given the report date + session. */
export function entryDateFor(reportDate: string, session: EarningsSession): string {
  if (session === 'AMC') {
    // Enter the report day itself — unless it fell on a weekend (quirk) → prior Friday.
    return isWeekendISO(reportDate) ? previousTradingDayISO(reportDate) : reportDate;
  }
  // BMO / DMH / UNKNOWN → be positioned before the report day opens.
  return previousTradingDayISO(reportDate);
}

// --- ET wall-clock ----------------------------------------------------------

/** Extract ET calendar date ('YYYY-MM-DD') and 24h hour from an instant. */
export function etParts(now: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0; // ICU may emit '24' at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

// --- ISO date helpers (UTC-noon anchored to dodge DST/offset edges) ----------

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function utcDay(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function isWeekendISO(iso: string): boolean {
  const d = utcDay(iso);
  return d === 0 || d === 6;
}

function weekdayShortOf(iso: string): string {
  return WEEKDAY[utcDay(iso)];
}

/** Step back to the most recent prior weekday (Mon→Fri). Holidays not modelled. */
export function previousTradingDayISO(iso: string): string {
  let cur = addDaysISO(iso, -1);
  while (isWeekendISO(cur)) cur = addDaysISO(cur, -1);
  return cur;
}
