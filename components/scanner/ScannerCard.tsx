'use client'

// ============================================================
// SteelEagle — Scanner Card Component
// Displays IV rank, condor setup, and trade metrics per pillar.
// Symbol header is click-to-edit; × button removes the cell.
// ============================================================

import { useState, useEffect, useRef } from 'react'
import type { ScannerResult } from '@/types'
import type { EntryGate } from '@/lib/strategy/entry-gate'
import PlaceOrderPanel from './PlaceOrderPanel'

// --------------------------------------------------------
// Status badge
// --------------------------------------------------------
function StatusBadge({ result }: { result: ScannerResult }) {
  if (result.error)
    return <span className="px-2 py-0.5 text-xs font-medium rounded bg-red-950 text-red-400 border border-red-900 tracking-wider">ERROR</span>
  if (!result.condor)
    return <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-800 text-slate-500 border border-slate-700 tracking-wider">NO DATA</span>
  if (result.condor.passesFilter)
    return <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-950 text-emerald-400 border border-emerald-900 tracking-wider">✓ PASS</span>
  if (result.ivRank.daysOfHistory < 20)
    return <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-950 text-amber-400 border border-amber-900 tracking-wider">CALIBRATING</span>
  return <span className="px-2 py-0.5 text-xs font-medium rounded bg-red-950 text-red-400 border border-red-900 tracking-wider">✕ FAIL</span>
}

// --------------------------------------------------------
// Click-to-edit symbol header
// --------------------------------------------------------
interface SymbolHeaderProps {
  symbol: string
  onCommit: (newSymbol: string) => void
}

function SymbolHeader({ symbol, onCommit }: SymbolHeaderProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(symbol)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const startEdit = () => {
    setValue(symbol)
    setError(null)
    setIsEditing(true)
  }

  const commit = () => {
    const ticker = value.trim().toUpperCase()
    if (!ticker) {
      setError('Enter a ticker')
      return
    }
    if (!/^[A-Z]+$/.test(ticker) || ticker.length > 5) {
      setError('Invalid')
      return
    }
    if (ticker === symbol) {
      setIsEditing(false)
      setError(null)
      return
    }
    onCommit(ticker)
    setIsEditing(false)
    setError(null)
  }

  const cancel = () => {
    setValue(symbol)
    setIsEditing(false)
    setError(null)
  }

  if (isEditing) {
    return (
      <div className="flex flex-col">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase())
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          maxLength={5}
          className="bg-slate-800 border border-emerald-800 rounded px-2 py-0.5 text-3xl font-bold tracking-tight font-[family-name:var(--font-display)] w-28 text-white outline-none uppercase"
        />
        {error && <span className="text-red-400 text-xs font-mono mt-1">{error}</span>}
      </div>
    )
  }

  return (
    <span
      onClick={startEdit}
      title="Click to edit"
      className="text-3xl font-bold tracking-tight font-[family-name:var(--font-display)] cursor-pointer hover:text-slate-300 transition-colors"
    >
      {symbol}
    </span>
  )
}

// --------------------------------------------------------
// Individual leg row
// --------------------------------------------------------
function LegRow({
  label, strike, delta, mark, action, isShort,
}: {
  label: string
  strike: number
  delta: number
  mark: number
  action: string
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

// --------------------------------------------------------
// Main component
// --------------------------------------------------------
interface ScannerCardProps {
  result: ScannerResult
  onEdit: (newSymbol: string) => void
  onRemove: () => void
  entryGate?: EntryGate
}

export default function ScannerCard({ result, onEdit, onRemove, entryGate }: ScannerCardProps) {
  const { symbol, underlyingPrice, expiration, dte, currentIv, ivRank, condor, error } = result

  const expirationDisplay = expiration
    ? new Date(expiration + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : '—'

  const cardBorderColor = condor?.passesFilter
    ? 'border-emerald-800'
    : ivRank.daysOfHistory < 20
    ? 'border-amber-900/60'
    : 'border-slate-800'

  return (
    <div className={`bg-slate-900 border ${cardBorderColor} rounded-xl overflow-hidden flex flex-col group relative`}>
      {/* ── Remove button (× top-right, visible on hover) ── */}
      <button
        onClick={onRemove}
        className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded text-slate-600 hover:text-red-400 hover:bg-slate-800 opacity-0 group-hover:opacity-100 transition-opacity text-lg leading-none z-10"
        aria-label={`Remove ${symbol}`}
        title="Remove cell"
      >
        ×
      </button>

      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-800 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <SymbolHeader symbol={symbol} onCommit={onEdit} />
            <StatusBadge result={result} />
          </div>
          <span className="text-slate-400 text-sm font-mono">
            ${underlyingPrice.toFixed(2)}
          </span>
        </div>
        {condor && (
          <div className="text-right mt-1 mr-8">
            <div className="text-slate-400 text-xs font-mono">{expirationDisplay}</div>
            <div className="text-slate-600 text-xs mt-0.5 font-mono">{dte} DTE</div>
          </div>
        )}
      </div>

      <div className="px-5 py-4 space-y-4 flex-1">
        {/* ── Error ── */}
        {error && (
          <p className="text-red-400 text-sm font-mono">{error}</p>
        )}

        {/* ── IV Metrics ── */}
        {!error && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
              <div className="text-slate-500 text-xs mb-1.5 font-[family-name:var(--font-display)] tracking-wider uppercase">Current IV</div>
              <div className="font-mono text-base font-medium">
                {currentIv > 0
                  ? `${currentIv.toFixed(1)}%`
                  : <span className="text-slate-600 text-sm">Market closed</span>
                }
              </div>
            </div>

            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
              <div className="text-slate-500 text-xs mb-1.5 font-[family-name:var(--font-display)] tracking-wider uppercase">IV Rank</div>
              <div className="font-mono text-base font-medium">
                {ivRank.daysOfHistory < 20 ? (
                  <span className="text-amber-500 text-sm">{ivRank.daysOfHistory}/20 days</span>
                ) : (
                  <span className={ivRank.passes ? 'text-emerald-400' : 'text-red-400'}>
                    {ivRank.ivRank.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Trade Setup ── */}
        {condor && (
          <>
            {/* ── Entry Gate (position limits + BPR cap) ── */}
            {condor.passesFilter && entryGate && entryGate.status !== 'OK' && (
              <div className={`flex items-start gap-2 text-xs font-mono rounded p-2 border ${
                entryGate.status === 'BLOCKED'
                  ? 'text-red-400 bg-red-950/30 border-red-900/50'
                  : 'text-amber-400 bg-amber-950/30 border-amber-900/50'
              }`}>
                <span className="mt-px shrink-0">{entryGate.status === 'BLOCKED' ? '⛔' : '⚠'}</span>
                <div className="space-y-0.5">
                  <div className="font-semibold">
                    {entryGate.status === 'BLOCKED' ? 'Qualifies, but capped — can’t enter' : 'Qualifies — tight on capacity'}
                  </div>
                  {entryGate.reasons.map((r, i) => <div key={i} className="opacity-90">{r}</div>)}
                </div>
              </div>
            )}

            <div>
              <div className="text-slate-600 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase mb-2">Trade Setup</div>
              <div className="space-y-1">
                <LegRow label="LP" strike={condor.longPut.strike} delta={condor.longPut.delta} mark={condor.longPut.mark} action="buy" isShort={false} />
                <LegRow label="SP" strike={condor.shortPut.strike} delta={condor.shortPut.delta} mark={condor.shortPut.mark} action="sell" isShort={true} />
                <LegRow label="SC" strike={condor.shortCall.strike} delta={condor.shortCall.delta} mark={condor.shortCall.mark} action="sell" isShort={true} />
                <LegRow label="LC" strike={condor.longCall.strike} delta={condor.longCall.delta} mark={condor.longCall.mark} action="buy" isShort={false} />
              </div>
            </div>

            {/* ── Trade Metrics ── */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">Credit</div>
                <div className="font-mono font-semibold text-emerald-400">${condor.totalCredit.toFixed(2)}</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">Wing Width</div>
                <div className="font-mono font-semibold">${condor.wingWidth}</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">Credit / Width</div>
                <div className={`font-mono font-semibold ${condor.creditToWidthRatio >= 0.15 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(condor.creditToWidthRatio * 100).toFixed(1)}%
                </div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">BPR / Max Loss</div>
                <div className="font-mono font-semibold">${condor.bpr.toFixed(2)}</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">Commission</div>
                <div className="font-mono font-semibold text-slate-400">${condor.commissionRoundTrip.toFixed(2)}</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/30">
                <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">Friction</div>
                {(() => {
                  const expectedWin = (condor.totalCredit * 100) * 0.5
                  const frictionPercent = expectedWin > 0 ? (condor.commissionRoundTrip / expectedWin) * 100 : 0
                  return (
                    <div className={`font-mono font-semibold ${frictionPercent > 8 ? 'text-orange-400' : 'text-slate-400'}`}>
                      {frictionPercent.toFixed(1)}%
                    </div>
                  )
                })()}
              </div>
            </div>

            {/* ── Friction Warning ── */}
            {(() => {
              const expectedWin = (condor.totalCredit * 100) * 0.5
              const frictionPercent = expectedWin > 0 ? (condor.commissionRoundTrip / expectedWin) * 100 : 0
              return frictionPercent > 8 ? (
                <div className="flex items-start gap-2 text-xs text-orange-600 font-mono bg-orange-950/30 border border-orange-900/50 rounded p-2">
                  <span className="mt-px shrink-0">⚠</span>
                  <span>Commission friction {frictionPercent.toFixed(1)}% exceeds 8% threshold</span>
                </div>
              ) : null
            })()}

            {/* ── Filter Warnings ── */}
            {condor.filterReasons.length > 0 && (
              <div className="space-y-1.5">
                {condor.filterReasons.map((reason, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-600 font-mono">
                    <span className="mt-px shrink-0">⚠</span>
                    <span>{reason}</span>
                  </div>
                ))}
              </div>
            )}

            {/* ── v2.0: place this condor via the Schwab API (PASS cards only) ── */}
            {condor.passesFilter && <PlaceOrderPanel condor={condor} entryGate={entryGate} />}
          </>
        )}

        {/* ── No setup ── */}
        {!condor && !error && (
          <p className="text-slate-600 text-sm font-mono">No valid setup in the 30–45 DTE window.</p>
        )}
      </div>
    </div>
  )
}