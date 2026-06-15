'use client'

// ============================================================
// SteelEagle — Trade Journal page
// Standalone manual-entry journal (v1.5). Lists logical trades with
// their roll/close timelines and drives the create/roll/close actions.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import NewTradeForm from '@/components/journal/NewTradeForm'
import TradeCard from '@/components/journal/TradeCard'
import { createTradeAction, rollTradeAction, closeTradeAction } from './actions'
import type { Trade } from '@/lib/journal/types'

interface JournalResponse {
  trades: Trade[]
  timestamp: string
}

type Filter = 'all' | 'open' | 'closed'

export default function JournalPage() {
  const [trades, setTrades] = useState<Trade[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  const fetchTrades = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/journal')
      if (!res.ok) throw new Error(`Journal API returned ${res.status}`)
      const data = (await res.json()) as JournalResponse
      setTrades(data.trades)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journal')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTrades()
  }, [fetchTrades])

  // Actions return the refreshed list; sync local state from it.
  const handleCreate = useCallback(async (input: Parameters<typeof createTradeAction>[0]) => {
    const updated = await createTradeAction(input)
    setTrades(updated)
    return updated
  }, [])
  const handleRoll = useCallback(async (id: string, input: Parameters<typeof rollTradeAction>[1]) => {
    const updated = await rollTradeAction(id, input)
    setTrades(updated)
    return updated
  }, [])
  const handleClose = useCallback(async (id: string, input: Parameters<typeof closeTradeAction>[1]) => {
    const updated = await closeTradeAction(id, input)
    setTrades(updated)
    return updated
  }, [])

  const visible = useMemo(() => {
    if (!trades) return []
    if (filter === 'all') return trades
    return trades.filter((t) => t.status === filter)
  }, [trades, filter])

  const openCount = trades?.filter((t) => t.status === 'open').length ?? 0

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ── Top Bar ── */}
      <div className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 sm:gap-4">
            <Link href="/dashboard" className="text-lg font-bold font-[family-name:var(--font-display)] tracking-wider hover:text-slate-300">
              🦅 STEELEAGLE
            </Link>
            <span className="text-slate-700 text-xs hidden sm:block">|</span>
            <span className="text-slate-500 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase hidden sm:block">
              Trade Journal
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
            <Link
              href="/dashboard"
              className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700"
            >
              ← Scanner
            </Link>
            <button
              onClick={() => setAdding((v) => !v)}
              className="px-3 py-1.5 text-xs rounded-md font-mono border border-emerald-700 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
            >
              + New Trade
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {error && (
          <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-3 text-red-400 text-sm font-mono">
            {error}
          </div>
        )}

        {adding && (
          <NewTradeForm onCreate={handleCreate} onDone={() => setAdding(false)} />
        )}

        {/* ── Filter tabs ── */}
        <div className="flex items-center gap-2 text-xs font-mono">
          {(['all', 'open', 'closed'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-md border tracking-wider uppercase ${
                filter === f
                  ? 'border-emerald-700 bg-emerald-600/20 text-emerald-300'
                  : 'border-slate-700 text-slate-500 hover:bg-slate-800'
              }`}
            >
              {f}
              {f === 'open' && openCount > 0 ? ` (${openCount})` : ''}
            </button>
          ))}
        </div>

        {/* ── Trade list ── */}
        {loading && !trades ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl h-48 animate-pulse" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-6 py-12 text-center">
            <p className="text-slate-500 text-sm font-mono">
              {trades && trades.length === 0
                ? 'No trades logged yet. Click + New Trade to record your first iron condor.'
                : `No ${filter} trades.`}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map((trade) => (
              <TradeCard key={trade.id} trade={trade} onRoll={handleRoll} onClose={handleClose} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
