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
import { createTokenProvider, type TokenRow } from './token-refresh'

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
// The decisions (single-flight, the 4xx race-loser check, the 5xx posture)
// live in ./token-refresh, pure and tested; this is the I/O wiring. Our own
// refresh deadline is NOT consulted before a live call — Schwab is the
// authority on whether a grant is live; the stored deadline WARNS JJ.
const tokenProvider = createTokenProvider({
  async readRow() {
    const { rows } = await sql`
      SELECT access_token, refresh_token, access_token_expires_at
      FROM tokens WHERE id = 1
    `
    return rows.length ? (rows[0] as TokenRow) : null
  },
  async callTokenEndpoint(refreshToken) {
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
      return { ok: false, status: response.status, text: await response.text() }
    }
    return { ok: true, tokens: await response.json() }
  },
  async store(tokens) {
    await storeTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in, {
      newAuthorization: false,
    })
  },
  expire: expireRefreshWindow,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

export async function getAccessToken(): Promise<string> {
  return tokenProvider.getAccessToken()
}

/**
 * Mark the refresh window as lapsed after Schwab rejected the grant — called
 * only once token-refresh has ruled out a lost race (no newer token on file,
 * immediately or after the grace delay).
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
