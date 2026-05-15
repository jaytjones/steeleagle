// ============================================================
// SteelEagle — OAuth Step 1: Login
// GET /api/auth/login
// Redirects browser to Schwab's consent + login page
// ============================================================

import { NextResponse } from 'next/server'

const AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize'

export async function GET() {
  const clientId = process.env.SCHWAB_CLIENT_ID
  const redirectUri = process.env.SCHWAB_REDIRECT_URI

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'Missing Schwab credentials in environment variables' },
      { status: 500 }
    )
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
  })

  const authorizationUrl = `${AUTH_URL}?${params.toString()}`

  return NextResponse.redirect(authorizationUrl)
}
