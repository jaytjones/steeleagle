// ============================================================
// SteelEagle — Auth Status API Route
// GET /api/auth/status
// Surfaces getAuthStatus() to the client so the dashboard can
// decide whether to show the ReauthBanner. The refresh token has
// a 7-day TTL; once it lapses every Schwab call fails and the
// only fix is re-running the OAuth flow (/api/auth/login).
//
// Always responds 200 — `needsReauth` is the signal, not the HTTP
// status — so the dashboard's fetch never throws on this call.
// ============================================================

import { NextResponse } from 'next/server'
import { getAuthStatus } from '@/lib/schwab/auth'

export async function GET() {
  try {
    const status = await getAuthStatus()
    return NextResponse.json(status)
  } catch {
    // getAuthStatus already swallows DB errors and returns needsReauth:true;
    // this catch is belt-and-suspenders for an unexpected throw.
    return NextResponse.json({
      isAuthenticated: false,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      needsReauth: true,
    })
  }
}
