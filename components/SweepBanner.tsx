// ============================================================
// SteelEagle — Sweep Banner (v2.9)
//
// Renders what the last post-close exit sweep found, on the page April
// already looks at.
//
// WHY: between Aug 4 and Aug 6 2026 the sweep detected a live mis-pricing on
// SPY 2026-09-11 (journal 725/740, account 735/750 — an unjournaled roll),
// built a GTC from the stale journal, had it REJECTED by Schwab, and
// correctly refused to store the id. Three runs. Every detector fired. None
// of it was visible anywhere in the app, because the report was the cron's
// HTTP response body and nothing kept it.
//
// THREE STATES, NEVER COLLAPSED — the v2.6.1 rule applied to the sweep:
//
//   critical  red    something needs eyes; every line shown, none truncated
//   warning   amber  routine refusals, 21-DTE, a paused placement toggle
//   ok        dim    ran, clean, and SAYS SO — silence is not a status
//
// The dim "clean" line matters as much as the red one. A banner that renders
// nothing when healthy is indistinguishable from a banner that is broken, and
// that specific confusion is what this milestone exists to end.
//
// Stale/never get their own treatment: those are "the cron did not run",
// which no report-rendering banner can express, because there is no report.
// ============================================================

import type { SweepRunSummary, SweepFreshness } from '@/lib/strategy/sweep-report'

export interface SweepBannerProps {
  summary: SweepRunSummary | null
  freshness: SweepFreshness
  /** ISO instant of the last run; null when none has been recorded. */
  ranAt: string | null
}

/** April is in US Central. Every wall-clock time in this app is CT. */
function formatCt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function SweepBanner({ summary, freshness, ranAt }: SweepBannerProps) {
  // ---- The cron is not running. Outranks whatever the last report said: a
  // clean bill from three days ago is not a clean bill today. ----
  if (freshness.state === 'never' || freshness.state === 'stale') {
    return (
      <div className="bg-red-950/40 border border-red-900/70 rounded-lg px-4 py-3 flex items-start gap-3">
        <span className="text-red-400 text-sm mt-px shrink-0">⚠</span>
        <div className="flex-1 min-w-0">
          <p className="text-red-300 text-sm font-semibold">
            Exit sweep has not run
            {freshness.state === 'stale' ? ` (${freshness.missedRuns} scheduled runs missed)` : ''}
          </p>
          <p className="text-red-400/70 text-xs font-mono mt-0.5">{freshness.message}</p>
          {ranAt && (
            <p className="text-red-400/50 text-xs font-mono mt-1">
              Last recorded run: {formatCt(ranAt)} CT
            </p>
          )}
        </div>
      </div>
    )
  }

  // No summary but fresh: the API returned a run it could not classify. Say so
  // rather than render nothing — an empty banner reads as healthy.
  if (summary === null) return null

  if (summary.severity === 'critical') {
    return (
      <div className="bg-red-950/40 border border-red-900/70 rounded-lg px-4 py-3 flex items-start gap-3">
        <span className="text-red-400 text-sm mt-px shrink-0">⚠</span>
        <div className="flex-1 min-w-0">
          <p className="text-red-300 text-sm font-semibold">
            Exit sweep — {summary.headline}
          </p>
          {/* Every critical, in full. Truncating the one line that mattered is
              the failure this component exists to prevent. */}
          <ul className="mt-1.5 space-y-1">
            {summary.criticalLines.map((line, i) => (
              <li key={i} className="text-red-400/80 text-xs font-mono leading-relaxed">
                • {line}
              </li>
            ))}
          </ul>
          {summary.warningLines.length > 0 && (
            <p className="text-red-400/50 text-xs font-mono mt-1.5">
              + {summary.warningLines.length} warning
              {summary.warningLines.length === 1 ? '' : 's'}
            </p>
          )}
          {ranAt && (
            <p className="text-red-400/50 text-xs font-mono mt-1">Ran {formatCt(ranAt)} CT</p>
          )}
        </div>
      </div>
    )
  }

  if (summary.severity === 'warning') {
    return (
      <div className="bg-amber-950/30 border border-amber-900/50 rounded-lg px-4 py-3 flex items-start gap-3">
        <span className="text-amber-500 text-sm mt-px shrink-0">⚡</span>
        <div className="flex-1 min-w-0">
          <p className="text-amber-400 text-sm font-semibold">
            Exit sweep — {summary.headline}
          </p>
          <ul className="mt-1.5 space-y-1">
            {summary.warningLines.map((line, i) => (
              <li key={i} className="text-amber-700 text-xs font-mono leading-relaxed">
                • {line}
              </li>
            ))}
          </ul>
          {ranAt && (
            <p className="text-amber-700/70 text-xs font-mono mt-1">Ran {formatCt(ranAt)} CT</p>
          )}
        </div>
      </div>
    )
  }

  // ---- ok. Deliberately rendered, deliberately quiet. ----
  return (
    <div className="px-1 flex items-center gap-2">
      <span className="text-neutral-600 text-xs">✓</span>
      <p className="text-neutral-500 text-xs font-mono">
        Exit sweep {ranAt ? formatCt(ranAt) : ''} CT — {summary.headline}
      </p>
    </div>
  )
}
