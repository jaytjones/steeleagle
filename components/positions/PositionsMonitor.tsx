'use client'

// ============================================================
// SteelEagle — Positions Monitor Component
// Displays open iron condor positions with P&L
// ============================================================

import type { OpenPosition } from '@/types'

interface Props {
  positions: OpenPosition[]
  loading: boolean
}

export default function PositionsMonitor({ positions, loading }: Props) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="font-semibold font-[family-name:var(--font-display)] tracking-wider text-sm uppercase text-slate-300">
          Open Positions
        </h2>
        {positions.length > 0 && (
          <span className="text-xs text-slate-500 font-mono">{positions.length} leg{positions.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="px-5 py-4">
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <div key={i} className="h-10 bg-slate-800/50 rounded animate-pulse" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <p className="text-slate-600 text-sm font-mono py-2">
            No open iron condor positions.
          </p>
        ) : (
          <div className="space-y-2">
            {/* Header row */}
            <div className="flex items-center justify-between text-xs text-slate-600 font-[family-name:var(--font-display)] tracking-wider uppercase px-3 mb-1">
              <span className="w-48">Symbol</span>
              <span className="w-16 text-right">Qty</span>
              <span className="w-20 text-right">Mkt Value</span>
              <span className="w-20 text-right">Unrealized P&L</span>
            </div>
            {positions.map((pos, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm font-mono bg-slate-800/30 border border-slate-700/30 rounded-lg px-3 py-2.5"
              >
                <div className="w-48">
                  <div className="text-white text-xs">{pos.symbol}</div>
                  <div className="text-slate-600 text-xs mt-0.5 truncate">{pos.description}</div>
                </div>
                <span className="text-slate-400 text-xs w-16 text-right">{pos.quantity}</span>
                <span className="text-slate-300 text-xs w-20 text-right">${pos.marketValue.toFixed(2)}</span>
                <span className={`text-xs w-20 text-right font-semibold ${pos.unrealizedPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {pos.unrealizedPL >= 0 ? '+' : ''}${pos.unrealizedPL.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
