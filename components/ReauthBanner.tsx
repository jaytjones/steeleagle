// ============================================================
// SteelEagle — Reauth Banner
// Shown on the dashboard when the Schwab refresh token (7-day TTL)
// has expired. Links to /api/auth/login to re-run the 3-legged
// OAuth flow.
//
// Uses a plain <a> (not next/link) on purpose: /api/auth/login
// returns a 302 to Schwab's external domain, and a full browser
// navigation follows that redirect cleanly, whereas next/link's
// client-side navigation can misbehave on a redirecting API route.
// ============================================================

export interface ReauthBannerProps {
  /** ISO string of when the refresh token expired, if known. */
  refreshTokenExpiresAt?: string | null
}

export default function ReauthBanner({ refreshTokenExpiresAt }: ReauthBannerProps) {
  const expiredOn = refreshTokenExpiresAt
    ? new Date(refreshTokenExpiresAt).toLocaleString()
    : null

  return (
    <div className="bg-red-950/40 border border-red-900/70 rounded-lg px-4 py-3 flex items-start gap-3">
      <span className="text-red-400 text-sm mt-px shrink-0">⚠</span>
      <div className="flex-1 min-w-0">
        <p className="text-red-300 text-sm font-semibold">Schwab session expired</p>
        <p className="text-red-400/70 text-xs font-mono mt-0.5">
          The 7-day refresh token has expired
          {expiredOn ? ` (as of ${expiredOn})` : ''}. Live scanner and positions data
          can&apos;t load until you reconnect.
        </p>
      </div>
      <a
        href="/api/auth/login"
        className="shrink-0 self-center px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded-md transition-colors font-mono font-semibold text-white whitespace-nowrap"
      >
        Reconnect to Schwab →
      </a>
    </div>
  )
}
