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
import ImportButton from '@/components/journal/ImportButton'
import {
  createTradeAction,
  rollTradeAction,
  closeTradeAction,
  editClosedTradeAction,
} from './actions'
import type {
  CloseTradeDraft,
  EditClosedTradeDraft,
  NewTradeDraft,
  RollTradeDraft,
  Trade,
} from '@/lib/journal/types'

interface JournalResponse {
  trades: Trade[]
  timestamp: string
}

type Filter = 'all' | 'open' | 'closed'

export default function JournalPage() {
  const [trades, setTrades] = useState<Trade[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rollWarning, setRollWarning] = useState<string | null>(null)
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
  // v2.3.2 — the entry form takes the DRAFT (blank = null) and the action
  // returns ActionResult, matching roll/close/edit below.
  const handleCreate = useCallback(async (input: NewTradeDraft) => {
    const res = await createTradeAction(input)
    if (!res.ok) throw new Error(res.error)
    setTrades(res.data)
    return res.data
  }, [])
  // v2.3.1 — the roll takes the DRAFT (blank price = null) and returns
  // ActionResult, same contract as close/edit below.
  const handleRoll = useCallback(async (id: string, input: RollTradeDraft) => {
    const res = await rollTradeAction(id, input)
    if (!res.ok) throw new Error(res.error)
    setTrades(res.data.trades)
    setRollWarning(res.data.exitOrderWarning)
    return res.data.trades
  }, [])
  // v2.2.1 — close/edit return ActionResult (a thrown server-action message is
  // redacted to a digest in production). Rethrowing client-side hands the real
  // refusal reason to the form's own catch, which renders it inline.
  const handleClose = useCallback(async (id: string, input: CloseTradeDraft) => {
    const res = await closeTradeAction(id, input)
    if (!res.ok) throw new Error(res.error)
    setTrades(res.data)
    return res.data
  }, [])
  const handleEditClose = useCallback(async (id: string, input: EditClosedTradeDraft) => {
    const res = await editClosedTradeAction(id, input)
    if (!res.ok) throw new Error(res.error)
    setTrades(res.data)
    return res.data
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

        {rollWarning && (
          <div className="flex items-start justify-between gap-3 bg-amber-950/40 border border-amber-900 rounded-lg px-4 py-3 text-amber-300 text-sm font-mono">
            <span>⚠ {rollWarning}</span>
            <button
              onClick={() => setRollWarning(null)}
              className="shrink-0 text-amber-500 hover:text-amber-300"
              aria-label="Dismiss roll warning"
            >
              ✕
            </button>
          </div>
        )}

        {/* Schwab importer — owns its own collapsible flow; refreshes the list on import. */}
        <ImportButton onImported={(updated) => setTrades(updated)} />

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
              <TradeCard
                key={trade.id}
                trade={trade}
                onRoll={handleRoll}
                onClose={handleClose}
                onEditClose={handleEditClose}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
