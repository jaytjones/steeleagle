// ============================================================
// SteelEagle — Auth Middleware
//
// Every request must carry a valid signed session cookie, with two
// deliberate exemptions:
//
//   /login       — the door itself (page + its server action POST).
//   /api/cron/*  — Vercel cron invocations arrive with the
//                  CRON_SECRET Bearer header and NO browser cookie;
//                  gating them here would silently kill both snapshot
//                  jobs. Those routes enforce their own auth.
//
// Server actions are POSTs to the page routes, so they pass through
// this middleware too — the v2.0 order-placement actions are covered.
//
// The Schwab OAuth callback (/api/auth/callback) is intentionally NOT
// exempt: Schwab redirects the operator's own browser there, which
// carries the session cookie. An unauthenticated hit gets a 401.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Exemptions (see header comment).
  if (pathname === '/login' || pathname.startsWith('/api/cron/')) {
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const authed = await verifySessionToken(token)
  if (authed) return NextResponse.next()

  // API routes get a machine answer; pages get the login door.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  return NextResponse.redirect(login)
}

export const config = {
  // Skip Next internals and static assets entirely.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)'],
}
