// ============================================================
// SteelEagle — Schwab re-authorization window (pure — no I/O)
//
// Schwab's refresh token lives 7 days from the INTERACTIVE authorization, and
// refreshing does not extend it. `storeTokens` used to stamp `now + 7 days` on
// every refresh, so the stored deadline slid forward for as long as the cron
// kept running and the warning it feeds could never fire BEFORE the failure.
//
// Proved live: the last refresh was 2026-08-14, so the DB claimed the session
// was good through 08-21; Schwab revoked it by Monday 08-17 and the sweep
// aborted before planning — no reconcile, no ingestion, no exits placed. That
// is the v2.6.1 / v2.9 failure shape again: the detector existed and was
// structurally incapable of firing.
//
// This module decides only what the clock SAYS. It is deliberately not a
// gate: Schwab is the truth about whether a token still works, and a wrong
// clock must never be the thing that refuses a refresh (see getAccessToken).
// ============================================================

/** Schwab's documented refresh-token lifetime, from the authorization-code exchange. */
export const REFRESH_WINDOW_DAYS = 7

/**
 * How much runway earns a warning.
 *
 * 48 hours covers a Friday lapse seen on Thursday evening — the sweep runs
 * once a weekday, so anything shorter can leave zero runs between the warning
 * and the dead cron.
 */
export const REAUTH_WARN_HOURS = 48

export type ReauthState =
  /** Comfortably inside the window. */
  | 'ok'
  /** Inside REAUTH_WARN_HOURS — reconnect before it costs a sweep. */
  | 'soon'
  /** The window has lapsed by our clock. */
  | 'expired'
  /**
   * No usable deadline on record. NOT "healthy" — the same posture as
   * reconciliation's UNCOMPARABLE: "cannot tell" must never render as fine.
   */
  | 'unknown'

export interface ReauthWindow {
  state: ReauthState
  /** Hours until the window lapses; negative once past. null when unknown. */
  hoursRemaining: number | null
  /** The deadline as JJ reads it — Central, since this is when SHE must act. */
  deadlineCt: string | null
}

const CT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** The deadline in Central time, e.g. `Tue, Aug 25, 10:10 AM CT`. */
export function formatDeadlineCt(expiresAt: Date): string {
  return `${CT.format(expiresAt)} CT`
}

export function reauthWindow(
  refreshTokenExpiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): ReauthWindow {
  if (!refreshTokenExpiresAt) {
    return { state: 'unknown', hoursRemaining: null, deadlineCt: null }
  }

  const expiresAt =
    refreshTokenExpiresAt instanceof Date
      ? refreshTokenExpiresAt
      : new Date(refreshTokenExpiresAt)

  if (Number.isNaN(expiresAt.getTime())) {
    return { state: 'unknown', hoursRemaining: null, deadlineCt: null }
  }

  const hoursRemaining = (expiresAt.getTime() - now.getTime()) / 3_600_000
  const deadlineCt = formatDeadlineCt(expiresAt)

  if (hoursRemaining <= 0) return { state: 'expired', hoursRemaining, deadlineCt }
  if (hoursRemaining <= REAUTH_WARN_HOURS) return { state: 'soon', hoursRemaining, deadlineCt }
  return { state: 'ok', hoursRemaining, deadlineCt }
}

/**
 * The deadline a NEW authorization sets. Only the OAuth callback may use this:
 * a refresh keeps whatever deadline is already on record.
 */
export function refreshWindowFrom(authorizedAt: Date): Date {
  return new Date(authorizedAt.getTime() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
}
