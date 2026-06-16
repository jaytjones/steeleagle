'use client'

// ============================================================
// SteelEagle — Import Candidate Card (Session 10 — v1.5.1)
// One reviewable iron-condor candidate from the Schwab importer.
// Prices, open date, and BPR are editable; everything emits upward via
// onChange so the review panel keeps the authoritative candidate set.
// Mirrors NewTradeForm's per-share / credit-debit conventions.
// ============================================================

import { useMemo } from 'react'
import { Field, TextInput } from './fields'
import { tally } from '@/lib/journal/trade-math'
import type { ImportCandidate, ImportLeg } from '@/lib/journal/types'

type LegKey = 'longPut' | 'shortPut' | 'shortCall' | 'longCall'

const LEG_ROWS: { key: LegKey; label: string }[] = [
  { key: 'longPut', label: 'LP · Long Put' },
  { key: 'shortPut', label: 'SP · Short Put' },
  { key: 'shortCall', label: 'SC · Short Call' },
  { key: 'longCall', label: 'LC · Long Call' },
]

interface Props {
  candidate: ImportCandidate
  skipped: boolean
  /** True once the operator has attempted to confirm — surfaces field errors. */
  attempted: boolean
  onChange: (updated: ImportCandidate) => void
  onToggleSkip: () => void
}

function fmtDate(ymd: string): string {
  // Render YYYY-MM-DD without timezone drift (parse as UTC midnight).
  const d = new Date(`${ymd}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export default function ImportCandidateCard({ candidate, skipped, attempted, onChange, onToggleSkip }: Props) {
  const matched = candidate.confidence === 'matched'
  const openDate = candidate.openDate ?? ''
  const openDateMissing = attempted && !skipped && openDate.trim() === ''

  // Live net-credit preview — same direction convention as the manual form
  // (SELL = credit, BUY = debit).
  const preview = useMemo(() => {
    const legs: ImportLeg[] = [candidate.longPut, candidate.shortPut, candidate.shortCall, candidate.longCall]
    const priced = legs
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({ price: l.price, creditDebit: (l.action === 'SELL' ? 'credit' : 'debit') as 'credit' | 'debit' }))
    if (priced.length === 0 || candidate.contracts <= 0) return null
    const { credit, debit } = tally(priced, candidate.contracts)
    const net = Math.round((credit - debit) * 100) / 100
    return { net, perContract: Math.round(net * 100) / candidate.contracts }
  }, [candidate])

  const setLegPrice = (key: LegKey, raw: string) => {
    const price = raw === '' ? 0 : Number(raw)
    onChange({ ...candidate, [key]: { ...candidate[key], price } })
  }

  return (
    <div
      className={`rounded-lg border p-4 space-y-3 transition-opacity ${
        skipped ? 'border-slate-800 bg-slate-900/40 opacity-50' : 'border-slate-700 bg-slate-900'
      }`}
    >
      {/* ── Header: symbol · expiration · contracts ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-sm text-white">
            <span className="font-bold">{candidate.underlying}</span>
            <span className="text-slate-600"> · </span>
            Exp {candidate.expiration}
            <span className="text-slate-600"> · </span>
            {candidate.contracts} contract{candidate.contracts === 1 ? '' : 's'}
          </div>
          {/* Confidence badge */}
          {matched ? (
            <div className="mt-1 text-xs font-mono text-emerald-400">
              ✓ MATCHED{' '}
              <span className="text-slate-500">
                (order #{candidate.schwabOrderId}
                {candidate.splitOrder ? ' · 2 orders' : ''}
                {candidate.openDate ? ` · ${fmtDate(candidate.openDate)}` : ''})
              </span>
            </div>
          ) : (
            <div className="mt-1 text-xs font-mono text-amber-400">
              ⚠ MARKS ONLY <span className="text-amber-500/70">(no order history match — prices are position averages, verify)</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleSkip}
          className={`shrink-0 px-2 py-1 text-xs rounded font-mono border ${
            skipped
              ? 'border-emerald-700 text-emerald-300 hover:bg-emerald-600/20'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800'
          }`}
        >
          {skipped ? '↺ Restore' : '✕ Skip'}
        </button>
      </div>

      {/* ── Legs ── */}
      <div className="space-y-1">
        <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr_1.2fr] gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-600">
          <span>Leg</span>
          <span>Strike</span>
          <span>Action</span>
          <span>Price ($/sh)</span>
        </div>
        {LEG_ROWS.map(({ key, label }) => {
          const leg = candidate[key]
          return (
            <div key={key} className="grid grid-cols-[1.5fr_0.8fr_0.8fr_1.2fr] gap-2 items-center">
              <span className="text-xs font-mono text-slate-400">{label}</span>
              <span className="text-xs font-mono text-slate-300">{leg.strike}</span>
              <span className={`text-xs font-mono ${leg.action === 'SELL' ? 'text-emerald-400' : 'text-slate-400'}`}>
                {leg.action}
              </span>
              <TextInput
                type="number"
                step="0.01"
                min={0}
                value={String(leg.price)}
                disabled={skipped}
                onChange={(e) => setLegPrice(key, e.target.value)}
              />
            </div>
          )
        })}
      </div>

      {/* ── Net credit preview ── */}
      {preview && (
        <div className="text-xs font-mono text-slate-400">
          Net credit{' '}
          <span className={preview.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>${preview.net.toFixed(2)}</span>
          <span className="text-slate-600"> · ${preview.perContract.toFixed(0)} per contract</span>
        </div>
      )}

      {/* ── Open date + BPR ── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Field label="Open Date">
            <TextInput
              type="date"
              value={openDate}
              disabled={skipped}
              onChange={(e) => onChange({ ...candidate, openDate: e.target.value || null })}
              className={
                openDateMissing
                  ? 'border-red-700'
                  : !matched
                    ? 'border-amber-700/70'
                    : ''
              }
              title={matched ? undefined : 'No order history match — enter the actual trade date.'}
            />
          </Field>
          {openDateMissing && <p className="mt-1 text-[11px] font-mono text-red-400">Open date is required.</p>}
        </div>
        <Field label="Initial BPR ($)">
          <TextInput
            type="number"
            step="0.01"
            min={0}
            value={String(candidate.initialBpr)}
            disabled={skipped}
            placeholder="1800"
            onChange={(e) => onChange({ ...candidate, initialBpr: e.target.value === '' ? 0 : Number(e.target.value) })}
          />
        </Field>
      </div>
    </div>
  )
}
