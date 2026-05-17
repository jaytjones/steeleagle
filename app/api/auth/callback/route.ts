// ============================================================
// SteelEagle — OAuth Step 2: Callback
// GET /api/auth/callback
// Schwab redirects here with ?code= after user logs in
// Exchanges code for tokens, stores them, redirects to dashboard
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { storeTokens } from '@/lib/schwab/auth'
import { sql } from '@/lib/db/client'

const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'
const ACCOUNTS_URL = 'https://api.schwabapi.com/trader/v1/accounts/accountNumbers'

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

    // Auto-discover and cache the hashed account number
    const accountsResponse = await fetch(ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })

    if (accountsResponse.ok) {
      const accounts = await accountsResponse.json()
      if (accounts.length > 0) {
        const now = new Date().toISOString()
        await sql`
          INSERT INTO accounts (id, account_hash, updated_at)
          VALUES (1, ${accounts[0].hashValue}, ${now})
          ON CONFLICT (id) DO UPDATE SET
            account_hash = EXCLUDED.account_hash,
            updated_at = EXCLUDED.updated_at
        `
      }
    }

    return NextResponse.redirect(new URL('/dashboard', request.url))
  } catch (err) {
    console.error('OAuth callback error:', err)
    return NextResponse.redirect(new URL('/?error=auth_failed', request.url))
  }
}
