'use client'

// ============================================================
// SteelEagle — Import Button + flow (Session 10 — v1.5.1)
// The single stateful owner of the Schwab import flow:
//   idle → loading → review → confirming → done | error
// Fetches candidates from /api/journal/import-candidates, drives the
// review panel, calls importTradesAction on confirm, and bubbles the
// refreshed trade list up so the journal list re-syncs.
//
// Rendered inline at the top of the /journal content area as a collapsible
// panel — same pattern as the + New Trade toggle (the trigger sits here
// rather than the sticky header so the expanding panel keeps clean flow).
// ============================================================

import { useState } from 'react'
import ImportCandidateReviewPanel from './ImportCandidateReviewPanel'
import { importTradesAction } from '@/app/journal/actions'
import type { ImportCandidate, ImportCandidatesResponse, Trade } from '@/lib/journal/types'

type Status = 'idle' | 'loading' | 'review' | 'confirming' | 'done' | 'error'

interface Props {
  onImported: (trades: Trade[]) => void
}

export default function ImportButton({ onImported }: Props) {
  const [status, setStatus] = useState<Status>('idle')
  const [data, setData] = useState<ImportCandidatesResponse | null>(null)
  const [message, setMessage] = useState<string>('')
  const [error, setError] = useState<string>('')

  const reset = () => {
    setStatus('idle')
    setData(null)
    setMessage('')
    setError('')
  }

  const openImport = async () => {
    setStatus('loading')
    setError('')
    try {
      const res = await fetch('/api/journal/import-candidates')
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error || `Import API returned ${res.status}`)
      setData(body as ImportCandidatesResponse)
      setStatus('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch positions from Schwab.')
      setStatus('error')
    }
  }

  const handleConfirm = async (candidates: ImportCandidate[]) => {
    setStatus('confirming')
    try {
      const result = await importTradesAction(candidates)
      onImported(result.trades)
      setMessage(
        result.failed.length === 0
          ? `${result.importedCount} trade${result.importedCount === 1 ? '' : 's'} imported successfully.`
          : `${result.importedCount} imported, ${result.failed.length} failed — see console.`,
      )
      setData(null)
      setStatus('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setStatus('error')
    }
  }

  // ── Idle: just the trigger ──
  if (status === 'idle') {
    return (
      <div className="flex justify-end">
        <button
          onClick={openImport}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-600 bg-slate-800/60 text-slate-300 hover:bg-slate-700"
        >
          ↓ Import from Schwab
        </button>
      </div>
    )
  }

  // ── Loading ──
  if (status === 'loading') {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-6 flex items-center gap-3">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
        <span className="text-sm font-mono text-slate-400">Fetching open positions from Schwab…</span>
      </div>
    )
  }

  // ── Review / Confirming ──
  if ((status === 'review' || status === 'confirming') && data) {
    return (
      <ImportCandidateReviewPanel
        data={data}
        confirming={status === 'confirming'}
        onConfirm={handleConfirm}
        onCancel={reset}
      />
    )
  }

  // ── Done ──
  if (status === 'done') {
    return (
      <div className="bg-emerald-950/40 border border-emerald-900/70 rounded-xl px-5 py-3 flex items-center justify-between gap-3">
        <span className="text-sm font-mono text-emerald-300">✓ {message}</span>
        <button
          onClick={reset}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-emerald-700 text-emerald-300 hover:bg-emerald-600/20"
        >
          Done
        </button>
      </div>
    )
  }

  // ── Error ──
  return (
    <div className="bg-red-950/40 border border-red-900/70 rounded-xl px-5 py-3 flex items-center justify-between gap-3">
      <span className="text-sm font-mono text-red-300">{error}</span>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={openImport}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-red-700 text-red-300 hover:bg-red-600/20"
        >
          Retry
        </button>
        <button
          onClick={reset}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 text-slate-400 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
