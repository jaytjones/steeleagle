// lib/strategy/market-hours.ts
//
// v2.6.1 — US equity/index regular-session clock, in Eastern Time.
//
// PURE: the clock is always an argument. Nothing here reads `new Date()` itself,
// so every branch is testable and the module can run on the server (Vercel = UTC)
// or in the browser (April's local zone) with identical results.
//
// Deliberately NO holiday calendar. On the ~9 market holidays a year — and on the
// 1:00 PM ET early closes — this reports "open". The consumer (the delta-staleness
// marker) then shows an amber "should be live" warning on a day the market was shut.
// That direction is chosen: the wrong-way error is a false alarm on a day April is
// not trading, never a silent miss on a day she is. Same fail-loud posture as
// getWorkingAndRecentOrders throwing instead of degrading to []. A holiday table
// would need annual maintenance to buy back nine cosmetic days, and a stale table
// is a worse failure than the one it fixes.

/** Minutes past ET midnight at the opening bell (09:30). */
export const MARKET_OPEN_MINUTES = 9 * 60 + 30;
/** Minutes past ET midnight at the closing bell (16:00). */
export const MARKET_CLOSE_MINUTES = 16 * 60;

export interface EtWallClock {
  /** 0 = Sunday … 6 = Saturday, in Eastern Time. */
  weekday: number;
  /** Minutes since ET midnight (0–1439). */
  minutes: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// hourCycle 'h23' (not hour12: false) — the latter renders ET midnight as "24"
// in some ICU builds, which would put minutes at 1440 and read as after-hours
// on a technicality. h23 pins 00–23.
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Break an absolute instant into its Eastern-Time weekday + minute-of-day.
 *  Handles EST/EDT transitions via the runtime tz database. */
export function etWallClock(now: Date): EtWallClock {
  const parts = ET_PARTS.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekday = WEEKDAY_INDEX[get('weekday')] ?? -1;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  return {
    weekday,
    minutes: Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : -1,
  };
}

/**
 * Is `now` inside the regular US market session (Mon–Fri, 09:30 ≤ t < 16:00 ET)?
 *
 * Used to decide whether missing option greeks are expected (after hours) or a
 * genuine fault (mid-session). Not a trading gate — nothing places orders off this.
 */
export function isRegularMarketHours(now: Date): boolean {
  const { weekday, minutes } = etWallClock(now);
  if (weekday <= 0 || weekday >= 6) return false; // Sun/Sat, or unparseable
  return minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
}
