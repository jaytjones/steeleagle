// ============================================================
// SteelEagle — Reauth Banner
//
// Shown on the dashboard when the Schwab refresh token (7-day TTL) has
// expired — OR is about to. Links to /api/auth/login to re-run the 3-legged
// OAuth flow.
//
// The warning state is the point. Until 2026-08-18 this banner could only
// appear AFTER the session died, and against a deadline that slid forward on
// every refresh so it did not appear even then: Monday 08-17's sweep aborted
// before planning with the DB still claiming four days of runway. A warning
// that can only fire after the failure is not a warning.
//
// Uses a plain <a> (not next/link) on purpose: /api/auth/login returns a 302
// to Schwab's external domain, and a full browser navigation follows that
// redirect cleanly, whereas next/link's client-side navigation can misbehave
// on a redirecting API route.
// ============================================================

import type { ReauthWindow } from '@/lib/schwab/auth-window'

export interface ReauthBannerProps {
  /** The window as getAuthStatus reports it. `ok` renders nothing. */
  reauth: ReauthWindow
}

export default function ReauthBanner({ reauth }: ReauthBannerProps) {
  if (reauth.state === 'ok') return null

  const tone =
    reauth.state === 'expired'
      ? {
          box: 'bg-red-950/40 border-red-900/70',
          mark: 'text-red-400',
          title: 'text-red-300',
          body: 'text-red-400/70',
          button: 'bg-red-600 hover:bg-red-500',
        }
      : {
          box: 'bg-amber-950/40 border-amber-900/70',
          mark: 'text-amber-400',
          title: 'text-amber-300',
          body: 'text-amber-400/70',
          button: 'bg-amber-600 hover:bg-amber-500',
        }

  return (
    <div className={`rounded-lg border px-4 py-3 flex items-start gap-3 ${tone.box}`}>
      <span className={`text-sm mt-px shrink-0 ${tone.mark}`}>⚠</span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${tone.title}`}>{headline(reauth)}</p>
        <p className={`text-xs font-mono mt-0.5 ${tone.body}`}>{detail(reauth)}</p>
      </div>
      <a
        href="/api/auth/login"
        className={`shrink-0 self-center px-3 py-1.5 text-xs rounded-md transition-colors font-mono font-semibold text-white whitespace-nowrap ${tone.button}`}
      >
        Reconnect to Schwab →
      </a>
    </div>
  )
}

function headline(reauth: ReauthWindow): string {
  if (reauth.state === 'expired') return 'Schwab session expired'
  if (reauth.state === 'unknown') return 'Schwab session — expiry unknown'
  return `Schwab session lapses in ${roundHours(reauth.hoursRemaining)}`
}

function detail(reauth: ReauthWindow): string {
  if (reauth.state === 'expired') {
    return (
      `The 7-day refresh token has expired${reauth.deadlineCt ? ` (${reauth.deadlineCt})` : ''}. ` +
      'The post-close sweep aborts before planning until you reconnect — no reconcile, ' +
      'no exits placed. Standing GTCs already at Schwab are unaffected and can still fill.'
    )
  }
  if (reauth.state === 'unknown') {
    // "Cannot tell" is not "fine" — the same posture as UNCOMPARABLE.
    return (
      'No refresh-token deadline is on record, so this page cannot say whether the ' +
      'session is live. Reconnect to put a known 7-day window back on the clock.'
    )
  }
  return (
    `Reconnect by ${reauth.deadlineCt ?? 'the deadline'} — refreshing does NOT extend the ` +
    '7-day window, only a login does. A lapsed session costs the whole post-close sweep.'
  )
}

function roundHours(hours: number | null): string {
  if (hours === null) return 'under 48h'
  if (hours < 1) return 'under an hour'
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}
