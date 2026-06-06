// ============================================================
// SteelEagle — OAuth Step 2: Callback
// GET /api/auth/callback
// Schwab redirects here with ?code= after user logs in
// Exchanges code for tokens, stores them, redirects to dashboard
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { storeTokens } from '@/lib/schwab/auth'
import { refreshAccountHash } from '@/lib/schwab/accounts'

const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error) {
    console.error('Schwab OAuth error:', error)
    return NextResponse.redirect(new URL('/?error=auth_denied', request.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?error=no_code', request.url))
  }

  try {
    const clientId = process.env.SCHWAB_CLIENT_ID!
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET!
    const redirectUri = process.env.SCHWAB_REDIRECT_URI!
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text()
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${text}`)
    }

    const tokens = await tokenResponse.json()
    await storeTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in)

    // Re-pull + persist the hashed account number. A failure here no longer
    // silently keeps a stale hash while still reporting success (the Session-7
    // trap): we log it loudly and proceed — the token exchange itself succeeded,
    // and getAccountSnapshot self-heals the hash on the first positions read.
    try {
      await refreshAccountHash()
    } catch (hashErr) {
      console.error(
        'OAuth callback — account hash refresh failed (login still succeeded; ' +
          'positions will self-heal the hash on first load):',
        hashErr instanceof Error ? hashErr.message : String(hashErr),
      )
    }

    return NextResponse.redirect(new URL('/dashboard', request.url))
  } catch (err) {
    console.error('OAuth callback error:', err)
    return NextResponse.redirect(new URL('/?error=auth_failed', request.url))
  }
}
