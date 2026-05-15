// ============================================================
// SteelEagle — Home Page
// Shows auth status and login button
// ============================================================

import { getAuthStatus } from '@/lib/schwab/auth'
import Link from 'next/link'

export default async function Home({
  searchParams,
}: {
  searchParams: { error?: string }
}) {
  let authStatus = null
  try {
    authStatus = await getAuthStatus()
  } catch {
    // DB not yet seeded — first run
  }

  const errorMessages: Record<string, string> = {
    auth_denied: 'Login was cancelled or denied.',
    no_code: 'No authorization code returned from Schwab.',
    auth_failed: 'Authentication failed. Check server logs.',
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full space-y-8">

        {/* Logo / Title */}
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">🦅 SteelEagle</h1>
          <p className="mt-2 text-gray-400">Iron Condor Scanner</p>
        </div>

        {/* Error banner */}
        {searchParams.error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-sm text-red-300">
            {errorMessages[searchParams.error] ?? 'An error occurred.'}
          </div>
        )}

        {/* Auth status card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          {authStatus?.isAuthenticated ? (
            <>
              <div className="flex items-center gap-2 text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                <span className="font-medium">Connected to Schwab</span>
              </div>

              {authStatus.needsReauth && (
                <div className="text-amber-400 text-sm">
                  ⚠️ Refresh token expired — re-authentication required.
                </div>
              )}

              {!authStatus.needsReauth && (
                <p className="text-gray-400 text-sm">
                  Refresh token valid until:{' '}
                  {authStatus.refreshTokenExpiresAt
                    ? new Date(authStatus.refreshTokenExpiresAt).toLocaleDateString()
                    : '—'}
                </p>
              )}

              <Link
                href="/dashboard"
                className="block w-full text-center bg-blue-600 hover:bg-blue-500 transition-colors rounded-lg py-3 font-medium"
              >
                Open Dashboard →
              </Link>

              {authStatus.needsReauth && (
                <Link
                  href="/api/auth/login"
                  className="block w-full text-center bg-amber-600 hover:bg-amber-500 transition-colors rounded-lg py-3 font-medium"
                >
                  Re-authenticate with Schwab
                </Link>
              )}
            </>
          ) : (
            <>
              <p className="text-gray-400 text-sm">
                Connect your Schwab account to start scanning for iron condor setups.
              </p>
              <Link
                href="/api/auth/login"
                className="block w-full text-center bg-blue-600 hover:bg-blue-500 transition-colors rounded-lg py-3 font-medium"
              >
                Connect Schwab Account
              </Link>
            </>
          )}
        </div>

        <p className="text-center text-gray-600 text-xs">
          SteelEagle v1.0 · Personal use only
        </p>
      </div>
    </main>
  )
}
