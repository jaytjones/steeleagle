// ============================================================
// SteelEagle — Schwab Token Management
// Handles storing, retrieving, and refreshing OAuth tokens
// ============================================================

import { supabase } from '@/lib/supabase/client'

const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'

// --------------------------------------------------------
// Store tokens after OAuth callback or refresh
// --------------------------------------------------------
export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
) {
  const now = new Date()
  const accessExpiry = new Date(now.getTime() + expiresInSeconds * 1000)
  const refreshExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) // 7 days

  const { error } = await supabase.from('tokens').upsert(
    {
      id: 1,
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: accessExpiry.toISOString(),
      refresh_token_expires_at: refreshExpiry.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: 'id' }
  )

  if (error) throw new Error(`Failed to store tokens: ${error.message}`)
}

// --------------------------------------------------------
// Get a valid access token — refreshes automatically if needed
// --------------------------------------------------------
export async function getAccessToken(): Promise<string> {
  const { data, error } = await supabase
    .from('tokens')
    .select('*')
    .eq('id', 1)
    .single()

  if (error || !data) {
    throw new Error('No tokens found — OAuth login required')
  }

  // Check if refresh token is expired (requires full re-auth)
  const refreshExpiry = new Date(data.refresh_token_expires_at)
  if (new Date() >= refreshExpiry) {
    throw new Error('Refresh token expired — OAuth re-login required')
  }

  // Check if access token is still valid (with 2-min buffer)
  const accessExpiry = new Date(data.access_token_expires_at)
  const twoMinsFromNow = new Date(Date.now() + 2 * 60 * 1000)

  if (twoMinsFromNow < accessExpiry) {
    return data.access_token
  }

  // Access token expired — refresh it
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
    throw new Error(`Token refresh failed: ${response.status} ${text}`)
  }

  const data = await response.json()

  await storeTokens(data.access_token, data.refresh_token, data.expires_in)

  return data.access_token
}

// --------------------------------------------------------
// Check auth status (for UI display)
// --------------------------------------------------------
export async function getAuthStatus(): Promise<{
  isAuthenticated: boolean
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  needsReauth: boolean
}> {
  const { data } = await supabase
    .from('tokens')
    .select('access_token_expires_at, refresh_token_expires_at')
    .eq('id', 1)
    .single()

  if (!data) {
    return {
      isAuthenticated: false,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      needsReauth: true,
    }
  }

  const refreshExpiry = new Date(data.refresh_token_expires_at)
  const needsReauth = new Date() >= refreshExpiry

  return {
    isAuthenticated: true,
    accessTokenExpiresAt: data.access_token_expires_at,
    refreshTokenExpiresAt: data.refresh_token_expires_at,
    needsReauth,
  }
}
