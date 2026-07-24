'use client'

// ============================================================
// SteelEagle — New Trade entry form (manual, v1.5)
// Records a four-leg iron condor: one trades row + four `open` events.
// Standalone — the operator types the legs (no scanner pre-population
// in this phase). Server-side zod is the authoritative validator.
// ============================================================

import { useState } from 'react'
import { Field, Select, TextInput } from './fields'
import type { Leg, NewTradeInput, Trade } from '@/lib/journal/types'
import { tally } from '@/lib/journal/trade-math'

interface LegRow {
  leg: Leg
  label: string
  strike: string
  delta: string
  price: string
  creditDebit: 'credit' | 'debit'
}

// Display order matches the scanner card: LP, SP, SC, LC. Default direction is
// the standard short condor (sell the inner strikes, buy the wings).
const DEFAULT_LEGS: LegRow[] = [
  { leg: 'long_put', label: 'LP · Long Put', strike: '', delta: '', price: '', creditDebit: 'debit' },
  { leg: 'short_put', label: 'SP · Short Put', strike: '', delta: '', price: '', creditDebit: 'credit' },
  { leg: 'short_call', label: 'SC · Short Call', strike: '', delta: '', price: '', creditDebit: 'credit' },
  { leg: 'long_call', label: 'LC · Long Call', strike: '', delta: '', price: '', creditDebit: 'debit' },
]

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface Props {
  onCreate: (input: NewTradeInput) => Promise<Trade[]>
  onDone: () => void
}

export default function NewTradeForm({ onCreate, onDone }: Props) {
  const [symbol, setSymbol] = useState('')

  const [openedAt, setOpenedAt] = useState(() => toLocalInput(new Date()))
  const [expiration, setExpiration] = useState('')
  const [contracts, setContracts] = useState('1')
  const [initialBpr, setInitialBpr] = useState('')
  const [notes, setNotes] = useState('')
  const [legs, setLegs] = useState<LegRow[]>(DEFAULT_LEGS)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const updateLeg = (i: number, patch: Partial<LegRow>) =>
    setLegs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  // Live net-credit preview so the operator can sanity-check before saving.
  const preview = (() => {
    const c = Number(contracts) || 0
    const priced = legs
      .filter((l) => l.price !== '' && !Number.isNaN(Number(l.price)))
      .map((l) => ({ price: Number(l.price), creditDebit: l.creditDebit }))
    if (priced.length === 0 || c <= 0) return null
    const { credit, debit } = tally(priced, c)
    return { credit, debit, net: Math.round((credit - debit) * 100) / 100 }
  })()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const input: NewTradeInput = {
      symbol: symbol.trim().toUpperCase(),
      sleeve: 'core', // earnings sleeve removed (v2.1.1); journal write path only accepts core
      openedAt: new Date(openedAt).toISOString(),
      initialExpiration: expiration,
      contracts: Number(contracts),
      initialBpr: Number(initialBpr),
      notes: notes.trim() || undefined,
      legs: legs.map((l) => ({
        leg: l.leg,
        strike: Number(l.strike),
        expiration,
        delta: l.delta === '' ? null : Number(l.delta),
        price: Number(l.price),
        creditDebit: l.creditDebit,
      })),
    }

    setSaving(true)
    try {
      await onCreate(input)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save trade')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-emerald-900/60 rounded-xl p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-[family-name:var(--font-display)] tracking-widest uppercase text-emerald-400">
          New Trade
        </h2>
        <button
          type="button"
          onClick={onDone}
          className="text-slate-500 hover:text-slate-300 text-lg leading-none"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Field label="Symbol">
          <TextInput
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={10}
            placeholder="SPY"
            required
          />
        </Field>
        <Field label="Contracts">
          <TextInput
            type="number"
            min={1}
            value={contracts}
            onChange={(e) => setContracts(e.target.value)}
            required
          />
        </Field>
        <Field label="Opened At">
          <TextInput
            type="datetime-local"
            value={openedAt}
            onChange={(e) => setOpenedAt(e.target.value)}
            required
          />
        </Field>
        <Field label="Expiration">
          <TextInput
            type="date"
            value={expiration}
            onChange={(e) => setExpiration(e.target.value)}
            required
          />
        </Field>
        <Field label="Initial BPR ($)">
          <TextInput
            type="number"
            min={0}
            step="0.01"
            value={initialBpr}
            onChange={(e) => setInitialBpr(e.target.value)}
            placeholder="1800"
            required
          />
        </Field>
      </div>

      {/* ── Legs ── */}
      <div>
        <div className="text-slate-600 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase mb-2">
          Legs · per-share fill price
        </div>
        <div className="space-y-1.5">
          {legs.map((l, i) => (
            <div key={l.leg} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1.1fr] gap-2 items-center">
              <span className="text-xs font-mono text-slate-400">{l.label}</span>
              <TextInput
                type="number"
                step="0.01"
                placeholder="strike"
                value={l.strike}
                onChange={(e) => updateLeg(i, { strike: e.target.value })}
                required
              />
              <TextInput
                type="number"
                step="0.001"
                placeholder="delta"
                value={l.delta}
                onChange={(e) => updateLeg(i, { delta: e.target.value })}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="price"
                value={l.price}
                onChange={(e) => updateLeg(i, { price: e.target.value })}
                required
              />
              <Select
                value={l.creditDebit}
                onChange={(e) => updateLeg(i, { creditDebit: e.target.value as 'credit' | 'debit' })}
              >
                <option value="credit">credit</option>
                <option value="debit">debit</option>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>

      {preview && (
        <div className="text-xs font-mono text-slate-400 flex gap-4">
          <span>credit <span className="text-emerald-400">${preview.credit.toFixed(2)}</span></span>
          <span>debit <span className="text-slate-300">${preview.debit.toFixed(2)}</span></span>
          <span>
            net credit{' '}
            <span className={preview.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              ${preview.net.toFixed(2)}
            </span>
          </span>
        </div>
      )}

      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 text-slate-400 hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded-md font-mono border border-emerald-700 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Log Trade'}
        </button>
      </div>
    </form>
  )
}
