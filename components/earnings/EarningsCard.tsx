'use client'

// ============================================================
// SteelEagle — Earnings Card
// One Tactical Earnings sleeve candidate (v1.4). Mirrors ScannerCard's
// dark-terminal styling. Read-only: the watchlist is fixed config, so
// there is no click-to-edit / remove affordance.
// ============================================================

import type { EarningsScannerCell, EarningsStatus } from '@/lib/earnings/scanner-types'
import type { EarningsTier } from '@/lib/strategy/earnings-watchlist'

// --------------------------------------------------------
// Tier badge
// --------------------------------------------------------
function TierBadge({ tier }: { tier: EarningsTier | null }) {
  const cls =
    tier === 1
      ? 'bg-emerald-950 text-emerald-400 border-emerald-900'
      : tier === 2
        ? 'bg-amber-950 text-amber-400 border-amber-900'
        : 'bg-red-950 text-red-400 border-red-900'
  const label = tier === null ? 'OFF' : `TIER ${tier}`
  return <span className={`px-2 py-0.5 text-xs font-medium rounded border tracking-wider ${cls}`}>{label}</span>
}

// --------------------------------------------------------
// Status badge
// --------------------------------------------------------
const STATUS_STYLE: Record<EarningsStatus, { cls: string; label: string }> = {
  ENTER_NOW: { cls: 'bg-emerald-950 text-emerald-400 border-emerald-900', label: '⏱ ENTER NOW' },
  UPCOMING: { cls: 'bg-sky-950 text-sky-400 border-sky-900', label: 'UPCOMING' },
  NO_EARNINGS_SOON: { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: 'NONE SOON' },
  BLOCKED: { cls: 'bg-red-950 text-red-400 border-red-900', label: '⛔ BLOCKED' },
  TIER3_BLOCKED: { cls: 'bg-red-950 text-red-400 border-red-900', label: '✕ TIER 3' },
  NO_DATA: { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: 'NO DATA' },
}

function StatusBadge({ status }: { status: EarningsStatus }) {
  const s = STATUS_STYLE[status]
  return <span className={`px-2 py-0.5 text-xs font-medium rounded border tracking-wider ${s.cls}`}>{s.label}</span>
}

// --------------------------------------------------------
// Leg row (matches ScannerCard's LegRow)
// --------------------------------------------------------
function LegRow({
  label, strike, delta, mark, action, isShort,
}: {
  label: string
  strike: number
  delta: number
  mark: number
  action: 'buy' | 'sell'
  isShort: boolean
}) {
  return (
    <div className={`flex items-center justify-between px-3 py-2 rounded text-xs font-mono border ${
      isShort
        ? 'bg-emerald-950/30 border-emerald-900/50 text-emerald-300'
        : 'bg-slate-800/40 border-slate-700/50 text-slate-400'
    }`}>
      <span className="w-8 font-semibold tracking-wider text-xs opacity-70">{label}</span>
      <span className="w-16 text-right font-semibold text-white">${strike}</span>
      <span className="w-16 text-right opacity-60">{delta > 0 ? '+' : ''}{delta.toFixed(3)}Δ</span>
      <span className="w-14 text-right">${mark.toFixed(2)}</span>
      <span className="w-10 text-right opacity-50 text-xs">{action === 'sell' ? 'STO' : 'BTO'}</span>
    </div>
  )
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
      <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">{label}</div>
      <div className="font-mono font-semibold">{children}</div>
    </div>
  )
}

// --------------------------------------------------------
// Main component
// --------------------------------------------------------
export default function EarningsCard({ cell }: { cell: EarningsScannerCell }) {
  const { symbol, tier, status, nextEarnings, daysUntil, entryWindowLabel, expectedMove, setup, gate, blockReasons, note } = cell

  const reportDisplay = nextEarnings
    ? new Date(nextEarnings.reportDate + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      })
    : '—'

  const borderColor =
    status === 'ENTER_NOW'
      ? 'border-emerald-800'
      : status === 'UPCOMING'
        ? 'border-sky-900/60'
        : status === 'BLOCKED' || status === 'TIER3_BLOCKED'
          ? 'border-red-900/50'
          : 'border-slate-800'

  return (
    <div className={`bg-slate-900 border ${borderColor} rounded-xl overflow-hidden flex flex-col`}>
      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-800 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1 flex-wrap">
            <span className="text-3xl font-bold tracking-tight font-[family-name:var(--font-display)]">{symbol}</span>
            <TierBadge tier={tier} />
            <StatusBadge status={status} />
          </div>
          {setup ? (
            <span className="text-slate-400 text-sm font-mono">${setup.underlyingPrice.toFixed(2)}</span>
          ) : (
            <span className="text-slate-600 text-sm font-mono">{entryWindowLabel || '—'}</span>
          )}
        </div>
        {nextEarnings && (
          <div className="text-right mt-1">
            <div className="text-slate-400 text-xs font-mono">
              {reportDisplay} · {nextEarnings.session}
            </div>
            <div className="text-slate-600 text-xs mt-0.5 font-mono">
              {daysUntil !== null ? (daysUntil === 0 ? 'today' : `in ${daysUntil}d`) : ''}
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-4 space-y-4 flex-1">
        {/* ── Entry window label (when a setup is shown) ── */}
        {setup && entryWindowLabel && (
          <div className="text-xs font-mono text-slate-400">{entryWindowLabel}</div>
        )}

        {/* ── Expected move ── */}
        {expectedMove && (
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Expected Move">
              <span className="text-base">${expectedMove.expectedMoveAbs.toFixed(2)}</span>
            </Metric>
            <Metric label="EM %">
              <span className="text-base">{(expectedMove.expectedMovePct * 100).toFixed(1)}%</span>
            </Metric>
          </div>
        )}

        {/* ── Gate verdict (TIGHT / BLOCKED) ── */}
        {gate && gate.status !== 'OK' && (
          <div className={`flex items-start gap-2 text-xs font-mono rounded p-2 border ${
            gate.status === 'BLOCKED'
              ? 'text-red-400 bg-red-950/30 border-red-900/50'
              : 'text-amber-400 bg-amber-950/30 border-amber-900/50'
          }`}>
            <span className="mt-px shrink-0">{gate.status === 'BLOCKED' ? '⛔' : '⚠'}</span>
            <div className="space-y-0.5">
              <div className="font-semibold">
                {gate.status === 'BLOCKED' ? 'Blocked — can’t enter' : 'Clear, but tight on capacity'}
              </div>
              {gate.reasons.map((r, i) => <div key={i} className="opacity-90">{r}</div>)}
            </div>
          </div>
        )}

        {/* ── Trade setup ── */}
        {setup && (
          <>
            <div>
              <div className="text-slate-600 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase mb-2">
                Trade Setup · {setup.shortMoveMultiple}× EM
              </div>
              <div className="space-y-1">
                <LegRow label="LP" strike={setup.longPut.strike} delta={setup.longPut.delta} mark={setup.longPut.mark} action="buy" isShort={false} />
                <LegRow label="SP" strike={setup.shortPut.strike} delta={setup.shortPut.delta} mark={setup.shortPut.mark} action="sell" isShort={true} />
                <LegRow label="SC" strike={setup.shortCall.strike} delta={setup.shortCall.delta} mark={setup.shortCall.mark} action="sell" isShort={true} />
                <LegRow label="LC" strike={setup.longCall.strike} delta={setup.longCall.delta} mark={setup.longCall.mark} action="buy" isShort={false} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Metric label="Credit">
                <span className="text-emerald-400">${setup.totalCredit.toFixed(2)}</span>
              </Metric>
              <Metric label="Wing Width"><span>${setup.wingWidth}</span></Metric>
              <Metric label="BPR / Max Loss"><span>${setup.bpr.toFixed(2)}</span></Metric>
              <Metric label="Profit Target ·25%">
                <span className="text-emerald-400">${setup.profitTargetDollars.toFixed(2)}</span>
              </Metric>
              <Metric label="DTE"><span>{setup.dte}</span></Metric>
              <Metric label="Stop">
                <span className="text-slate-500 text-sm">none — size is risk</span>
              </Metric>
            </div>
          </>
        )}

        {/* ── Block reasons (no setup) ── */}
        {!setup && blockReasons.length > 0 && (
          <div className="space-y-1.5">
            {blockReasons.map((reason, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-red-400 font-mono">
                <span className="mt-px shrink-0">⛔</span>
                <span>{reason}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Countdown / empty states ── */}
        {status === 'NO_EARNINGS_SOON' && (
          <p className="text-slate-600 text-sm font-mono">
            Next earnings {daysUntil !== null ? `in ${daysUntil} days` : 'unscheduled'} — outside the entry window.
          </p>
        )}
        {status === 'NO_DATA' && (
          <p className="text-slate-600 text-sm font-mono">No earnings date cached yet.</p>
        )}
        {status === 'TIER3_BLOCKED' && (
          <p className="text-slate-600 text-sm font-mono">
            Tier 3 — overnight moves blow through the wings; the IV is fairly priced, so there is no edge to sell.
          </p>
        )}

        {/* ── Diagnostic note ── */}
        {note && <p className="text-slate-700 text-xs font-mono italic">{note}</p>}
      </div>
    </div>
  )
}
