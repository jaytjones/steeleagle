'use client'

// ============================================================
// SteelEagle — Trade Journal card
// One logical trade: header + credit accounting + entry legs + the
// roll/close event timeline. Open trades expose inline Roll / Close
// forms that append events and patch the running totals.
// ============================================================

import { useState } from 'react'
import LegRowsEditor, { type EditableLeg } from './LegRowsEditor'
import { Field, Select, TextInput } from './fields'
import {
  netCredit,
  profitTargetBuyback,
} from '@/lib/journal/trade-math'
import {
  CLOSE_REASONS,
  type CloseReason,
  type CloseTradeInput,
  type Leg,
  type RollTradeInput,
  type Trade,
  type TradeEvent,
} from '@/lib/journal/types'

const LEG_LABEL: Record<Leg, string> = {
  long_put: 'LP',
  short_put: 'SP',
  short_call: 'SC',
  long_call: 'LC',
}
const EVENT_LABEL: Record<TradeEvent['eventType'], string> = {
  open: 'OPEN',
  close: 'CLOSE',
  roll_close: 'ROLL ✕',
  roll_open: 'ROLL +',
}
const REASON_LABEL: Record<CloseReason, string> = {
  profit_target: 'Profit target (50%)',
  stop_loss: 'Stop loss',
  '21_dte': '21 DTE',
  manual: 'Manual',
  expired: 'Expired',
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtExp(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function signed(ev: TradeEvent): string {
  const sign = ev.creditDebit === 'credit' ? '+' : '−'
  return `${sign}$${ev.amount.toFixed(2)}`
}

interface Props {
  trade: Trade
  onRoll: (tradeId: string, input: RollTradeInput) => Promise<Trade[]>
  onClose: (tradeId: string, input: CloseTradeInput) => Promise<Trade[]>
}

export default function TradeCard({ trade, onRoll, onClose }: Props) {
  const [mode, setMode] = useState<'none' | 'roll' | 'close'>('none')

  const isOpen = trade.status === 'open'
  const net = netCredit(trade)
  const target = profitTargetBuyback(net)
  const entryLegs = trade.events.filter((e) => e.eventType === 'open')
  const laterEvents = trade.events.filter((e) => e.eventType !== 'open')
  const rollCount = trade.events.filter((e) => e.eventType === 'roll_open').length

  return (
    <div
      className={`bg-slate-900 border rounded-xl overflow-hidden ${
        isOpen ? 'border-slate-800' : 'border-slate-800/50 opacity-90'
      }`}
    >
      {/* ── Header ── */}
      <div className="px-5 pt-4 pb-3 border-b border-slate-800 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-bold tracking-tight font-[family-name:var(--font-display)]">
              {trade.symbol}
            </span>
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-800 text-slate-400 border border-slate-700 tracking-wider uppercase">
              {trade.sleeve}
            </span>
            {isOpen ? (
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-950 text-emerald-400 border border-emerald-900 tracking-wider">
                OPEN
              </span>
            ) : (
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-800 text-slate-500 border border-slate-700 tracking-wider">
                CLOSED
              </span>
            )}
            {rollCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-sky-950 text-sky-400 border border-sky-900 tracking-wider">
                {rollCount}× ROLLED
              </span>
            )}
          </div>
          <div className="text-slate-500 text-xs font-mono mt-1">
            Opened {fmtDate(trade.openedAt)}
            {trade.closedAt && ` · Closed ${fmtDate(trade.closedAt)}`}
            {trade.closeReason && ` · ${REASON_LABEL[trade.closeReason]}`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-slate-600 text-xs font-mono">exp {fmtExp(trade.currentExpiration)}</div>
          <div className="text-slate-600 text-xs font-mono mt-0.5">{trade.contracts}× contracts</div>
        </div>
      </div>

      {/* ── Credit accounting ── */}
      <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Net Credit" value={`$${net.toFixed(2)}`} tone={net >= 0 ? 'pos' : 'neg'} />
        <Metric label={isOpen ? 'Profit Target' : 'Realized P&L'} value={`$${(isOpen ? target : net).toFixed(2)}`} tone="pos" />
        <Metric label="Collected" value={`$${trade.totalCreditCollected.toFixed(2)}`} />
        <Metric label="Debits Paid" value={`$${trade.totalDebitPaid.toFixed(2)}`} />
      </div>

      {/* ── Entry legs ── */}
      <div className="px-5 pb-3">
        <div className="text-slate-600 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase mb-1.5">
          Entry · {fmtExp(trade.initialExpiration)}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {entryLegs.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-500 w-8">{LEG_LABEL[ev.leg]}</span>
              <span className="text-white">${ev.strike}</span>
              <span className="text-slate-600">
                {ev.delta !== null ? `${ev.delta > 0 ? '+' : ''}${ev.delta.toFixed(3)}Δ` : '—'}
              </span>
              <span className={ev.creditDebit === 'credit' ? 'text-emerald-400' : 'text-slate-400'}>
                {signed(ev)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Event timeline (rolls + close) ── */}
      {laterEvents.length > 0 && (
        <div className="px-5 pb-3 space-y-1">
          <div className="text-slate-600 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase mb-1.5">
            Activity
          </div>
          {laterEvents.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between text-xs font-mono text-slate-400">
              <span className="w-16 text-slate-500">{EVENT_LABEL[ev.eventType]}</span>
              <span className="w-10">{LEG_LABEL[ev.leg]}</span>
              <span className="w-16 text-right text-white">${ev.strike}</span>
              <span className="w-20 text-right text-slate-600">{fmtExp(ev.expiration)}</span>
              <span className={`w-20 text-right ${ev.creditDebit === 'credit' ? 'text-emerald-400' : 'text-slate-300'}`}>
                {signed(ev)}
              </span>
            </div>
          ))}
        </div>
      )}

      {trade.notes && (
        <div className="px-5 pb-3 text-xs font-mono text-slate-500 italic">“{trade.notes}”</div>
      )}

      {/* ── Actions ── */}
      {isOpen && (
        <div className="px-5 py-3 border-t border-slate-800 flex gap-2">
          <button
            onClick={() => setMode(mode === 'roll' ? 'none' : 'roll')}
            className="px-3 py-1.5 text-xs rounded-md font-mono border border-sky-800 bg-sky-600/10 text-sky-300 hover:bg-sky-600/20"
          >
            Roll
          </button>
          <button
            onClick={() => setMode(mode === 'close' ? 'none' : 'close')}
            className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      )}

      {mode === 'roll' && (
        <RollForm trade={trade} onRoll={onRoll} onDone={() => setMode('none')} />
      )}
      {mode === 'close' && (
        <CloseForm trade={trade} entryLegs={entryLegs} onClose={onClose} onDone={() => setMode('none')} />
      )}
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-red-400' : 'text-white'
  return (
    <div className="bg-slate-800/50 rounded-lg p-2.5 border border-slate-700/30">
      <div className="text-slate-500 text-xs mb-1 font-[family-name:var(--font-display)] tracking-wider uppercase">
        {label}
      </div>
      <div className={`font-mono font-semibold text-sm ${color}`}>{value}</div>
    </div>
  )
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// --------------------------------------------------------
// Roll form
// --------------------------------------------------------
function RollForm({
  trade,
  onRoll,
  onDone,
}: {
  trade: Trade
  onRoll: (tradeId: string, input: RollTradeInput) => Promise<Trade[]>
  onDone: () => void
}) {
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()))
  const [newExpiration, setNewExpiration] = useState('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<EditableLeg[]>([
    { eventType: 'roll_close', leg: 'short_call', strike: '', expiration: trade.currentExpiration, delta: '', price: '', creditDebit: 'debit' },
    { eventType: 'roll_open', leg: 'short_call', strike: '', expiration: '', delta: '', price: '', creditDebit: 'credit' },
  ])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const input: RollTradeInput = {
      occurredAt: new Date(occurredAt).toISOString(),
      newExpiration: newExpiration || null,
      notes: notes.trim() || undefined,
      events: rows.map((r) => ({
        eventType: (r.eventType ?? 'roll_open') as 'roll_close' | 'roll_open',
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration || newExpiration || trade.currentExpiration,
        delta: r.delta === '' ? null : Number(r.delta),
        price: Number(r.price),
        creditDebit: r.creditDebit,
      })),
    }
    setSaving(true)
    try {
      await onRoll(trade.id, input)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to roll')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="px-5 py-4 border-t border-sky-900/40 bg-sky-950/10 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Rolled At">
          <TextInput type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} required />
        </Field>
        <Field label="New Expiration (if rolled out)">
          <TextInput type="date" value={newExpiration} onChange={(e) => setNewExpiration(e.target.value)} />
        </Field>
      </div>
      <LegRowsEditor rows={rows} onChange={setRows} withEventType defaultExpiration={newExpiration || trade.currentExpiration} />
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>
      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
      <FormButtons saving={saving} onDone={onDone} label="Record Roll" />
    </form>
  )
}

// --------------------------------------------------------
// Close form
// --------------------------------------------------------
function CloseForm({
  trade,
  entryLegs,
  onClose,
  onDone,
}: {
  trade: Trade
  entryLegs: TradeEvent[]
  onClose: (tradeId: string, input: CloseTradeInput) => Promise<Trade[]>
  onDone: () => void
}) {
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()))
  const [closeReason, setCloseReason] = useState<CloseReason>('profit_target')
  const [notes, setNotes] = useState('')
  // Prefill from the entry legs: buying back shorts = debit, selling longs = credit.
  const [rows, setRows] = useState<EditableLeg[]>(
    entryLegs.map((ev) => ({
      leg: ev.leg,
      strike: String(ev.strike),
      expiration: trade.currentExpiration,
      delta: ev.delta !== null ? String(ev.delta) : '',
      price: '',
      creditDebit: ev.leg.startsWith('short') ? 'debit' : 'credit',
    })),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const input: CloseTradeInput = {
      occurredAt: new Date(occurredAt).toISOString(),
      closeReason,
      notes: notes.trim() || undefined,
      events: rows.map((r) => ({
        eventType: 'close' as const,
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration || trade.currentExpiration,
        delta: r.delta === '' ? null : Number(r.delta),
        price: Number(r.price),
        creditDebit: r.creditDebit,
      })),
    }
    setSaving(true)
    try {
      await onClose(trade.id, input)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="px-5 py-4 border-t border-slate-800 bg-slate-950/40 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Closed At">
          <TextInput type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} required />
        </Field>
        <Field label="Reason">
          <Select value={closeReason} onChange={(e) => setCloseReason(e.target.value as CloseReason)}>
            {CLOSE_REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-slate-600 text-xs font-mono">
        Enter the buy-back price per leg. For an expired-worthless exit, remove all legs.
      </p>
      <LegRowsEditor rows={rows} onChange={setRows} withEventType={false} defaultExpiration={trade.currentExpiration} />
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>
      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
      <FormButtons saving={saving} onDone={onDone} label="Close Trade" />
    </form>
  )
}

function FormButtons({ saving, onDone, label }: { saving: boolean; onDone: () => void; label: string }) {
  return (
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
        {saving ? 'Saving…' : label}
      </button>
    </div>
  )
}
