// ============================================================
// SteelEagle — Auth Status API Route
// GET /api/auth/status
// Surfaces getAuthStatus() to the client so the dashboard can
// decide whether to show the ReauthBanner. The refresh token has
// a 7-day TTL measured from the INTERACTIVE login — refreshing does
// not extend it — and once it lapses every Schwab call fails, the
// post-close sweep included. The only fix is re-running the OAuth
// flow (/api/auth/login).
//
// `reauth.state` is the signal the banner reads (ok / soon / expired /
// unknown); `needsReauth` remains as the yes/no for older callers.
//
// Always responds 200 — the payload is the signal, not the HTTP
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
    // Same shape getAuthStatus returns on failure, `reauth` included: a
    // missing window renders as nothing at all on the dashboard, and "could
    // not check" must never look like "fine".
    return NextResponse.json({
      isAuthenticated: false,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      needsReauth: true,
      reauth: { state: 'unknown', hoursRemaining: null, deadlineCt: null },
    })
  }
}
