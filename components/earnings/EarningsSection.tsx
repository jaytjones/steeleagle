'use client'

// ============================================================
// SteelEagle — Tactical Earnings Section
// A separate, collapsible dashboard section (v1.4). Distinct from the
// core scanner grid: different rules, different cadence (clustered
// around the 4 earnings seasons). Surfaces a summary + crisis toggle
// in the header so it stays informative even when collapsed.
// ============================================================

import { useState } from 'react'
import EarningsCard from './EarningsCard'
import type { EarningsScannerCell, EarningsStatus, CrisisState } from '@/lib/earnings/scanner-types'

interface EarningsSectionProps {
  cells: EarningsScannerCell[] | null
  loading: boolean
  error: string | null
  /** The user's manual toggle intent. */
  crisisManual: boolean
  /** Route-returned crisis detail (active = manual || autoCoreStop). Null before first load. */
  crisisInfo: CrisisState | null
  onToggleCrisis: () => void
}

// Most actionable first.
const STATUS_RANK: Record<EarningsStatus, number> = {
  ENTER_NOW: 0,
  UPCOMING: 1,
  BLOCKED: 2,
  NO_EARNINGS_SOON: 3,
  NO_DATA: 4,
  TIER3_BLOCKED: 5,
}

function sortCells(cells: EarningsScannerCell[]): EarningsScannerCell[] {
  return [...cells].sort((a, b) => {
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    const ad = a.daysUntil ?? Number.POSITIVE_INFINITY
    const bd = b.daysUntil ?? Number.POSITIVE_INFINITY
    if (ad !== bd) return ad - bd
    return a.symbol.localeCompare(b.symbol)
  })
}

export default function EarningsSection({ cells, loading, error, crisisManual, crisisInfo, onToggleCrisis }: EarningsSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const crisisOn = crisisInfo?.active ?? crisisManual

  const enterNow = cells?.filter((c) => c.status === 'ENTER_NOW').length ?? 0
  const upcoming = cells?.filter((c) => c.status === 'UPCOMING').length ?? 0

  const summary =
    enterNow > 0
      ? `${enterNow} to enter now`
      : upcoming > 0
        ? `${upcoming} upcoming`
        : loading
          ? 'scanning…'
          : 'nothing actionable'

  const sorted = cells ? sortCells(cells) : []

  return (
    <section className="border border-slate-800 rounded-xl bg-slate-950/40">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-5 py-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2.5 text-left"
          aria-expanded={expanded}
        >
          <span className={`text-slate-500 text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-base font-bold font-[family-name:var(--font-display)] tracking-wider">
            TACTICAL EARNINGS
          </span>
          <span className="text-slate-600 text-xs font-mono">
            {enterNow > 0 && <span className="text-emerald-400">{summary}</span>}
            {enterNow === 0 && summary}
          </span>
        </button>

        <div className="flex items-center gap-2">
          {crisisInfo?.autoCoreStop && (
            <span
              title="A core position is at/over its stop — crisis is enforced automatically, regardless of the toggle."
              className="px-2 py-0.5 text-xs font-mono rounded border bg-red-950 text-red-300 border-red-900"
            >
              auto: core stop
            </span>
          )}
          <button
            onClick={onToggleCrisis}
            title="Crisis protocol: skip all earnings entries the week the core takes a stop. Manual toggle; also auto-enforced when an open core position is at/over its stop (best-effort)."
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors font-mono border ${
              crisisManual
                ? 'bg-red-600/20 hover:bg-red-600/30 border-red-700/70 text-red-300'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-400'
            }`}
          >
            ⚠ Crisis: {crisisManual ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {expanded && (
        <div className="px-4 sm:px-5 pb-5">
          {error && (
            <div className="mb-4 bg-red-950/40 border border-red-900/70 rounded-lg px-4 py-3 text-red-300 text-sm font-mono">
              Earnings scan degraded: {error}
            </div>
          )}

          {crisisOn && (
            <div className="mb-4 bg-red-950/30 border border-red-900/50 rounded-lg px-4 py-2.5 text-red-300 text-xs font-mono flex items-start gap-2">
              <span className="mt-px shrink-0">⚠</span>
              <span>
                Crisis protocol active — all earnings entries are blocked this week.
                {crisisInfo?.autoCoreStop && !crisisManual && ' Auto-detected: a core position is at/over its stop.'}
              </span>
            </div>
          )}

          {loading && !cells ? (
            <p className="text-slate-600 text-sm font-mono py-4">Scanning earnings calendar…</p>
          ) : sorted.length === 0 ? (
            <p className="text-slate-600 text-sm font-mono py-4">No watchlist names to display.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {sorted.map((cell) => (
                <EarningsCard key={cell.symbol} cell={cell} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
