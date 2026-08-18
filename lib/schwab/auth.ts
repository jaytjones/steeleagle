// ============================================================
// SteelEagle — Schwab Token Management
// Handles storing, retrieving, and refreshing OAuth tokens
// ============================================================

import { sql } from '@/lib/db/client'
import {
  reauthWindow,
  refreshWindowFrom,
  type ReauthWindow,
} from './auth-window'

const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'

// --------------------------------------------------------
// Store tokens after OAuth callback or refresh
// --------------------------------------------------------
/**
 * `newAuthorization` decides who owns the 7-day refresh deadline, and it is
 * REQUIRED so a new call site cannot inherit the wrong answer silently.
 *
 *   true  — the OAuth callback. An interactive login starts the window.
 *   false — a token refresh. It does NOT extend the window; the deadline
 *           already on record stands.
 *
 * Stamping `now + 7 days` on every refresh is what made the deadline slide
 * forward for as long as the cron kept running: on 2026-08-17 the DB claimed
 * the session was good until 08-21 while Schwab had already revoked it, and
 * the sweep aborted before planning. The warning could not fire because the
 * clock it reads was written by the very thing it was meant to warn about.
 */
export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number,
  { newAuthorization }: { newAuthorization: boolean }
) {
  const now = new Date()
  const accessExpiry = new Date(now.getTime() + expiresInSeconds * 1000)
  const refreshExpiry = refreshWindowFrom(now)

  if (newAuthorization) {
    await sql`
      INSERT INTO tokens (id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
      VALUES (1, ${accessToken}, ${refreshToken}, ${accessExpiry.toISOString()}, ${refreshExpiry.toISOString()}, ${now.toISOString()})
      ON CONFLICT (id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
        updated_at = EXCLUDED.updated_at
    `
    return
  }

  // Refresh path. COALESCE, not EXCLUDED: the stored deadline wins, and the
  // fresh 7 days only applies if there is somehow no deadline on record at all
  // (a row that predates this column). A refresh must never move it forward.
  await sql`
    INSERT INTO tokens (id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
    VALUES (1, ${accessToken}, ${refreshToken}, ${accessExpiry.toISOString()}, ${refreshExpiry.toISOString()}, ${now.toISOString()})
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      refresh_token_expires_at = COALESCE(tokens.refresh_token_expires_at, EXCLUDED.refresh_token_expires_at),
      updated_at = EXCLUDED.updated_at
  `
}

// --------------------------------------------------------
// Get a valid access token — refreshes automatically if needed
// --------------------------------------------------------
export async function getAccessToken(): Promise<string> {
  const { rows } = await sql`SELECT * FROM tokens WHERE id = 1`

  if (!rows.length) {
    throw new Error('No tokens found — OAuth login required')
  }

  const data = rows[0]

  // NOTE: our own refresh deadline is NOT consulted here, deliberately.
  //
  // It used to hard-throw before contacting Schwab, and it never once fired —
  // it was written by the refresh path itself. Corrected, it could fire the
  // other way and refuse a token Schwab would still have honoured. Schwab is
  // the authority on whether a grant is live; the stored deadline exists to
  // WARN JJ, not to gate a live call. Same posture as the Schwab-side order
  // validation being the real guard, not our calendar.
  const accessExpiry = new Date(data.access_token_expires_at)
  const twoMinsFromNow = new Date(Date.now() + 2 * 60 * 1000)

  if (twoMinsFromNow < accessExpiry) {
    return data.access_token
  }

  return await refreshAccessToken(data.refresh_token)
}

// --------------------------------------------------------
// Refresh the access token using the refresh token
// --------------------------------------------------------
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.SCHWAB_CLIENT_ID!
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET!
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    // A 4xx from the token endpoint is Schwab saying the GRANT is gone, and
    // that is better evidence than any deadline we hold. Record it so the
    // dashboard turns red now rather than at a date we guessed. A 5xx is a
    // Schwab outage and must NOT burn the window.
    if (response.status >= 400 && response.status < 500) {
      await expireRefreshWindow(`${response.status} ${text}`)
    }
    throw new Error(
      `Token refresh failed: ${response.status} ${text} — re-run the OAuth login (/api/auth/login)`,
    )
  }

  const data = await response.json()
  await storeTokens(data.access_token, data.refresh_token, data.expires_in, {
    newAuthorization: false,
  })
  return data.access_token
}

/**
 * Mark the refresh window as lapsed after Schwab rejected the grant.
 *
 * Bookkeeping only — the refresh has already failed, so this cannot make any
 * Schwab call worse. Its own try/catch: a DB hiccup here must not replace the
 * real refresh error with a database one, which would hide why the sweep died.
 */
async function expireRefreshWindow(reason: string): Promise<void> {
  try {
    await sql`
      UPDATE tokens
      SET refresh_token_expires_at = LEAST(refresh_token_expires_at, ${new Date().toISOString()}),
          updated_at = ${new Date().toISOString()}
      WHERE id = 1
    `
    console.error('Schwab rejected the refresh token — re-login required:', reason)
  } catch (dbErr) {
    console.error(
      'Could not record the rejected refresh token (the refresh failure stands):',
      dbErr instanceof Error ? dbErr.message : String(dbErr),
    )
  }
}

// --------------------------------------------------------
// Check auth status (for UI display)
// --------------------------------------------------------
export interface AuthStatus {
  isAuthenticated: boolean
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  /** state === 'expired'. Kept for the callers that only ask the yes/no. */
  needsReauth: boolean
  /** The window as the operator should read it, including the WARNING state. */
  reauth: ReauthWindow
}

const UNAUTHENTICATED: AuthStatus = {
  isAuthenticated: false,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  needsReauth: true,
  reauth: { state: 'unknown', hoursRemaining: null, deadlineCt: null },
}

export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    const { rows } = await sql`
      SELECT access_token_expires_at, refresh_token_expires_at
      FROM tokens WHERE id = 1
    `

    if (!rows.length) return UNAUTHENTICATED

    const data = rows[0]
    // timestamptz hydrates as a Date here and as a string over HTTP; the
    // window helper takes both rather than making the caller normalise.
    const reauth = reauthWindow(data.refresh_token_expires_at)

    return {
      isAuthenticated: true,
      accessTokenExpiresAt: data.access_token_expires_at,
      refreshTokenExpiresAt: data.refresh_token_expires_at,
      needsReauth: reauth.state === 'expired',
      reauth,
    }
  } catch {
    return UNAUTHENTICATED
  }
}
