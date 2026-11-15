// ============================================================
// SteelEagle — Access-token refresh: single-flight + loser check
// Pure decision logic; every bit of I/O is injected (see auth.ts).
// ============================================================
//
// THE RACE (2026-11-15). The dashboard fires /api/scanner and /api/positions
// together, and the scanner fans out one Schwab call per symbol. Once the
// 30-minute access token lapsed, every one of those calls refreshed with the
// SAME refresh token. Schwab honoured one and rejected the rest with a 4xx;
// each rejection ran expireRefreshWindow(), stamping the 7-day deadline to
// "now", and the winner's store kept it (a refresh never moves the deadline
// forward). Token row as found: deadline 12:22:08 CT, winning store 12:22:09
// CT — a live grant (accountNumbers → 200) reported as EXPIRED, and the real
// re-login warning destroyed. The loser's 4xx landed BEFORE the winner's
// write, so re-reading once is not enough; it re-reads after a grace delay.
//
// Two layers:
//   1. Single-flight per process — concurrent callers in one instance share
//      ONE refresh. Covers the scanner fan-out.
//   2. A 4xx is not proof the grant is dead until the row is re-read: if
//      another instance has stored a newer token, use it and burn nothing.
//      Only a 4xx with no newer token on file (immediately AND after the
//      grace delay) records the lapse. That rule is unchanged — a genuinely
//      rejected grant still turns the dashboard red at once.
//
// A 5xx never burns the window (Schwab outage), exactly as before.

/** Same margin getAccessToken uses: a token this close to expiry is stale. */
export const ACCESS_TOKEN_MARGIN_MS = 2 * 60 * 1000

/** How long a 4xx loser waits for a concurrent winner's store to land. */
export const LOSER_GRACE_MS = 2_000

export interface TokenRow {
  access_token: string
  refresh_token: string
  /** timestamptz hydrates as a Date from the driver; accept a string too. */
  access_token_expires_at: Date | string
}

export interface RefreshedTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export type TokenEndpointResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; status: number; text: string }

export interface RefreshDeps {
  /** Current token row, or null if there is none. */
  readRow(): Promise<TokenRow | null>
  /** POST grant_type=refresh_token. Network errors may throw. */
  callTokenEndpoint(refreshToken: string): Promise<TokenEndpointResult>
  /** Persist a successful refresh (refresh path — never moves the deadline). */
  store(tokens: RefreshedTokens): Promise<void>
  /** Record that Schwab rejected the grant (LEAST the deadline to now). */
  expire(reason: string): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

export function isFresh(row: TokenRow, nowMs: number): boolean {
  const expiry = new Date(row.access_token_expires_at).getTime()
  return Number.isFinite(expiry) && nowMs + ACCESS_TOKEN_MARGIN_MS < expiry
}

/**
 * Did someone else refresh since we read `usedRefreshToken`? Either the
 * refresh token rotated, or a fresh access token is on file (Schwab may hand
 * back the same refresh token, so the expiry check is what catches that).
 */
export function supersededToken(
  row: TokenRow | null,
  usedRefreshToken: string,
  nowMs: number,
): string | null {
  if (!row) return null
  if (row.refresh_token !== usedRefreshToken || isFresh(row, nowMs)) {
    return row.access_token
  }
  return null
}

export interface TokenProvider {
  getAccessToken(): Promise<string>
}

export function createTokenProvider(deps: RefreshDeps): TokenProvider {
  // Per-process single flight. Reset in `finally` so a failure is never
  // cached — the next caller gets a fresh attempt.
  let inflight: Promise<string> | null = null

  async function refresh(usedRefreshToken: string): Promise<string> {
    const result = await deps.callTokenEndpoint(usedRefreshToken)

    if (result.ok) {
      await deps.store(result.tokens)
      return result.tokens.access_token
    }

    const failure = new Error(
      `Token refresh failed: ${result.status} ${result.text} — re-run the OAuth login (/api/auth/login)`,
    )

    // 5xx (or anything non-4xx): an outage, never evidence the grant is gone.
    if (result.status < 400 || result.status >= 500) throw failure

    // 4xx: we may simply have lost a race to another instance. Check now,
    // then once more after the grace delay, before burning the window.
    const now1 = await deps.readRow()
    const winner1 = supersededToken(now1, usedRefreshToken, deps.now())
    if (winner1) return winner1

    await deps.sleep(LOSER_GRACE_MS)
    const now2 = await deps.readRow()
    const winner2 = supersededToken(now2, usedRefreshToken, deps.now())
    if (winner2) return winner2

    await deps.expire(`${result.status} ${result.text}`)
    throw failure
  }

  return {
    async getAccessToken(): Promise<string> {
      const row = await deps.readRow()
      if (!row) throw new Error('No tokens found — OAuth login required')

      // Our own refresh deadline is NOT consulted here, deliberately: Schwab
      // is the authority on whether a grant is live; the stored deadline
      // exists to WARN JJ, not to gate a live call.
      if (isFresh(row, deps.now())) return row.access_token

      if (!inflight) {
        inflight = refresh(row.refresh_token).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
  }
}
