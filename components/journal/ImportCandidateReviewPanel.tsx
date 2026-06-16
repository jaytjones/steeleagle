'use client'

// ============================================================
// SteelEagle — Import Candidate Review Panel (Session 10 — v1.5.1)
// Confirmation step for the Schwab importer. Holds the editable candidate
// set + skip state, renders the read-only already-imported / incomplete
// sections, and hands the non-skipped, validated candidates to the parent
// on confirm. Unidirectional: candidates flow down, edits bubble up.
// ============================================================

import { useMemo, useState } from 'react'
import ImportCandidateCard from './ImportCandidateCard'
import type { ImportCandidate, ImportCandidatesResponse } from '@/lib/journal/types'

interface Props {
  data: ImportCandidatesResponse
  confirming: boolean
  onConfirm: (candidates: ImportCandidate[]) => void
  onCancel: () => void
}

export default function ImportCandidateReviewPanel({ data, confirming, onConfirm, onCancel }: Props) {
  // Editable working copy of the importable candidates.
  const [candidates, setCandidates] = useState<ImportCandidate[]>(data.candidates)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [attempted, setAttempted] = useState(false)

  const active = useMemo(
    () => candidates.filter((c) => !skipped.has(c.candidateId)),
    [candidates, skipped],
  )

  const updateCandidate = (updated: ImportCandidate) =>
    setCandidates((cs) => cs.map((c) => (c.candidateId === updated.candidateId ? updated : c)))

  const toggleSkip = (id: string) =>
    setSkipped((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleConfirm = () => {
    setAttempted(true)
    // Client-side guard: every importable candidate needs an open date (spec §7).
    const missingDate = active.some((c) => !c.openDate || c.openDate.trim() === '')
    if (missingDate || active.length === 0) return
    onConfirm(active)
  }

  const noneFound =
    data.candidates.length === 0 && data.alreadyImported.length === 0 && data.incomplete.length === 0
  const allAlreadyImported = data.candidates.length === 0 && data.alreadyImported.length > 0

  return (
    <div className="bg-slate-900 border border-emerald-900/60 rounded-xl p-5 space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-[family-name:var(--font-display)] tracking-widest uppercase text-emerald-400">
          Import from Schwab
        </h2>
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="px-2 py-1 text-xs rounded font-mono border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
        >
          ✕ Cancel
        </button>
      </div>

      {/* ── Orders-unavailable banner ── */}
      {data.ordersUnavailable && data.candidates.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-900/70 rounded-lg px-3 py-2 text-xs font-mono text-amber-300">
          Order history unavailable — prices shown are position averages. Verify each leg before importing.
        </div>
      )}

      {/* ── Empty states ── */}
      {noneFound && (
        <p className="text-slate-500 text-sm font-mono py-4 text-center">No open condors found.</p>
      )}
      {allAlreadyImported && (
        <p className="text-slate-500 text-sm font-mono">
          All open positions are already in the journal.
        </p>
      )}

      {/* ── Candidate cards ── */}
      {candidates.length > 0 && (
        <>
          <p className="text-slate-400 text-sm font-mono">
            Found {candidates.length} open condor{candidates.length === 1 ? '' : 's'}. Review prices and confirm.
          </p>
          <div className="space-y-3">
            {candidates.map((c) => (
              <ImportCandidateCard
                key={c.candidateId}
                candidate={c}
                skipped={skipped.has(c.candidateId)}
                attempted={attempted}
                onChange={updateCandidate}
                onToggleSkip={() => toggleSkip(c.candidateId)}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Already in journal (read-only) ── */}
      {data.alreadyImported.length > 0 && (
        <div className="border-t border-slate-800 pt-3 space-y-1">
          <div className="text-xs font-mono uppercase tracking-wider text-slate-500">
            Already in journal ({data.alreadyImported.length}):
          </div>
          {data.alreadyImported.map((c) => (
            <div key={c.candidateId} className="text-xs font-mono text-slate-500">
              {c.underlying} · Exp {c.expiration} — skipped (already imported)
            </div>
          ))}
        </div>
      )}

      {/* ── Incomplete positions (read-only) ── */}
      {data.incomplete.length > 0 && (
        <div className="border-t border-slate-800 pt-3 space-y-1">
          <div className="text-xs font-mono uppercase tracking-wider text-slate-500">
            Incomplete positions ({data.incomplete.length}):
          </div>
          {data.incomplete.map((p, i) => (
            <div key={`${p.underlying}-${p.expiration}-${i}`} className="text-xs font-mono text-amber-500/80">
              {p.underlying} · Exp {p.expiration} — {p.reason}
            </div>
          ))}
        </div>
      )}

      {/* ── Confirm ── */}
      {candidates.length > 0 && (
        <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-3">
          {attempted && active.length > 0 && active.some((c) => !c.openDate) && (
            <span className="text-xs font-mono text-red-400">Set an open date on every trade first.</span>
          )}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming || active.length === 0}
            className="px-4 py-2 text-xs rounded-md font-mono border border-emerald-700 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40"
          >
            {confirming
              ? `Importing ${active.length}…`
              : active.length === 0
                ? 'All trades skipped'
                : `Import ${active.length} trade${active.length === 1 ? '' : 's'} →`}
          </button>
        </div>
      )}
    </div>
  )
}
