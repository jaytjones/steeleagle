'use client'

// ============================================================
// SteelEagle — Trade Journal card
// One logical trade: header + credit accounting + entry legs + the
// roll/close event timeline. Open trades expose inline Roll / Record Close
// forms that append events and patch the running totals.
//
// v2.3 naming: "Record Close" JOURNALS a close that already happened — it
// never sends an order to Schwab. The Schwab-facing action is "Cancel GTC"
// on the Positions Monitor. Do not collapse these names back together.
// ============================================================

import { useMemo, useState } from 'react'
import LegRowsEditor, { type EditableLeg } from './LegRowsEditor'
import { Field, Select, TextInput } from './fields'
import {
  entryWingWidth,
  netCredit,
  profitTargetBuyback,
} from '@/lib/journal/trade-math'
import { isEditableCloseEvent, previewCloseEditTotals } from '@/lib/journal/edit-close'
import {
  CLOSE_REASONS,
  CloseTradeSchema,
  LEGS,
  type CloseDraftLeg,
  type CloseReason,
  type CloseTradeDraft,
  type CreditDebit,
  type EditClosedTradeDraft,
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
  /** v2.2.1 — takes the DRAFT (blank price = null), never a coerced number. */
  onClose: (tradeId: string, input: CloseTradeDraft) => Promise<Trade[]>
  onEditClose: (tradeId: string, input: EditClosedTradeDraft) => Promise<Trade[]>
}

export default function TradeCard({ trade, onRoll, onClose, onEditClose }: Props) {
  const [mode, setMode] = useState<'none' | 'roll' | 'close' | 'edit'>('none')

  const isOpen = trade.status === 'open'
  const net = netCredit(trade)
  const target = profitTargetBuyback(net)
  const entryLegs = trade.events.filter((e) => e.eventType === 'open')
  const wing = entryWingWidth(entryLegs, trade.contracts)
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
      <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Metric label="Net Credit" value={`$${net.toFixed(2)}`} tone={net >= 0 ? 'pos' : 'neg'} />
        <Metric label={isOpen ? 'Profit Target' : 'Realized P&L'} value={`$${(isOpen ? target : net).toFixed(2)}`} tone="pos" />
        <Metric label="Collected" value={`$${trade.totalCreditCollected.toFixed(2)}`} />
        <Metric label="Debits Paid" value={`$${trade.totalDebitPaid.toFixed(2)}`} />
        <Metric label="Wing Width" value={wing != null ? `$${wing.toLocaleString('en-US')}` : '—'} />
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
      {isOpen ? (
        <div className="px-5 py-3 border-t border-slate-800 flex gap-2">
          <button
            onClick={() => setMode(mode === 'roll' ? 'none' : 'roll')}
            className="px-3 py-1.5 text-xs rounded-md font-mono border border-sky-800 bg-sky-600/10 text-sky-300 hover:bg-sky-600/20"
          >
            Roll
          </button>
          <button
            onClick={() => setMode(mode === 'close' ? 'none' : 'close')}
            title="Record a close that already happened at Schwab. This journals the trade — it does NOT send an order."
            className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Record Close
          </button>
        </div>
      ) : (
        // v2.2.1 — repair a mis-keyed close without SQL. Only the close legs
        // April typed are reachable; Schwab-filled legs stay read-only.
        <div className="px-5 py-3 border-t border-slate-800 flex gap-2">
          <button
            onClick={() => setMode(mode === 'edit' ? 'none' : 'edit')}
            className="px-3 py-1.5 text-xs rounded-md font-mono border border-slate-700 text-slate-400 hover:bg-slate-800"
          >
            Edit Close
          </button>
        </div>
      )}

      {mode === 'roll' && (
        <RollForm trade={trade} onRoll={onRoll} onDone={() => setMode('none')} />
      )}
      {mode === 'close' && (
        <CloseForm trade={trade} entryLegs={entryLegs} onClose={onClose} onDone={() => setMode('none')} />
      )}
      {mode === 'edit' && (
        <EditCloseForm trade={trade} onEditClose={onEditClose} onDone={() => setMode('none')} />
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
// Close form — v2.2.1 hardened
//
// The Session 15 corruption came from this form: `Number('')` turned three
// blank price fields into three real $0.00 close events, and Enter in the
// first price field submitted before the operator had finished typing.
// Three independent guards now stand in the way:
//   1. blank stays blank on the wire — `null`, not 0, so the schema can tell
//      "not entered" from an explicit (legal) $0.00;
//   2. the four rows are fixed — no add, no remove, roles read-only;
//   3. the submit button is dead until CloseTradeSchema (the same schema the
//      server enforces) accepts the draft, with the reasons shown inline.
// --------------------------------------------------------

/** A blank numeric field is absent, NOT zero. This is the whole fix. */
function numOrNull(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isNaN(n) ? null : n
}

/**
 * datetime-local → ISO, safely. These drafts are built during render now, and
 * `new Date('').toISOString()` throws — a cleared date field would take the
 * whole card down. An empty string fails the schema instead, which is what
 * should happen.
 */
function localToIso(v: string): string {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function CloseForm({
  trade,
  entryLegs,
  onClose,
  onDone,
}: {
  trade: Trade
  entryLegs: TradeEvent[]
  onClose: (tradeId: string, input: CloseTradeDraft) => Promise<Trade[]>
  onDone: () => void
}) {
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()))
  const [closeReason, setCloseReason] = useState<CloseReason>('profit_target')
  const [notes, setNotes] = useState('')
  // Exactly four rows, one per role, prefilled from the entry legs: buying
  // back shorts = debit, selling longs = credit. Driven off LEGS (not the
  // event list) so the row count is right even on an odd event log.
  const [rows, setRows] = useState<EditableLeg[]>(() =>
    LEGS.map((role) => {
      const ev = entryLegs.find((e) => e.leg === role)
      return {
        leg: role,
        strike: ev ? String(ev.strike) : '',
        expiration: trade.currentExpiration,
        delta: ev && ev.delta !== null ? String(ev.delta) : '',
        price: '',
        creditDebit: (role.startsWith('short') ? 'debit' : 'credit') as CreditDebit,
      }
    }),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const draft: CloseTradeDraft = useMemo(
    () => ({
      occurredAt: localToIso(occurredAt),
      closeReason,
      notes: notes.trim() || undefined,
      events: rows.map(
        (r): CloseDraftLeg => ({
          eventType: 'close',
          leg: r.leg,
          strike: numOrNull(r.strike),
          expiration: r.expiration || trade.currentExpiration,
          delta: numOrNull(r.delta),
          price: numOrNull(r.price),
          creditDebit: r.creditDebit,
        }),
      ),
    }),
    [occurredAt, closeReason, notes, rows, trade.currentExpiration],
  )

  // Same schema the action enforces — the button and the server never disagree.
  const parsed = CloseTradeSchema.safeParse(draft)
  const problems = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => i.message))]

  const setAllZero = () =>
    setRows((rs) => rs.map((r) => ({ ...r, price: '0' })))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!parsed.success) {
      setError(problems.join('; '))
      return
    }
    setSaving(true)
    try {
      await onClose(trade.id, draft)
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-slate-600 text-xs font-mono">
          Enter the buy-back price for all four legs — a leg that expired worthless is $0.00.
        </p>
        <button
          type="button"
          onClick={setAllZero}
          className="px-2 py-1 text-xs rounded font-mono border border-slate-700 text-slate-400 hover:bg-slate-800"
        >
          Expired worthless — all $0.00
        </button>
      </div>
      <LegRowsEditor
        rows={rows}
        onChange={setRows}
        withEventType={false}
        defaultExpiration={trade.currentExpiration}
        lockRows
      />
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>
      {problems.length > 0 && (
        <ul className="text-amber-400/80 text-xs font-mono space-y-0.5">
          {problems.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
      <FormButtons
        saving={saving}
        onDone={onDone}
        label="Record Close"
        disabled={!parsed.success}
      />
    </form>
  )
}

// --------------------------------------------------------
// Edit-close form (v2.2.1) — repairs a mis-keyed close
//
// Reachable only on a CLOSED trade, and only over `close` events April
// entered by hand. Schwab-filled legs render read-only; entry and roll legs
// are not shown at all. Structure is immutable — this fixes what was typed,
// it does not restate the position.
// --------------------------------------------------------
function EditCloseForm({
  trade,
  onEditClose,
  onDone,
}: {
  trade: Trade
  onEditClose: (tradeId: string, input: EditClosedTradeDraft) => Promise<Trade[]>
  onDone: () => void
}) {
  const closeEvents = trade.events.filter((e) => e.eventType === 'close')
  const editable = closeEvents.filter(isEditableCloseEvent)

  const [closedAt, setClosedAt] = useState(() =>
    toLocalInput(new Date(trade.closedAt ?? trade.updatedAt)),
  )
  const [closeReason, setCloseReason] = useState<CloseReason>(trade.closeReason ?? 'manual')
  const [notes, setNotes] = useState(trade.notes ?? '')
  const [legs, setLegs] = useState(() =>
    editable.map((ev) => ({
      id: ev.id,
      price: String(ev.price),
      creditDebit: ev.creditDebit,
    })),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const updateLeg = (id: string, patch: Partial<(typeof legs)[number]>) =>
    setLegs((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const occurredAtIso = localToIso(closedAt)
  const draft: EditClosedTradeDraft = {
    closedAt: occurredAtIso,
    closeReason,
    notes: notes.trim() || null,
    events: legs.map((l) => ({
      id: l.id,
      price: numOrNull(l.price),
      creditDebit: l.creditDebit,
      occurredAt: occurredAtIso,
    })),
  }

  const blank = draft.events.filter((e) => e.price === null)
  // Preview shares planCloseEdit with the write path, so what April sees here
  // is what the transaction computes. Only priced when nothing is blank.
  // Cheap enough (≤ 8 events) to recompute per render rather than memoize.
  const preview = ((): number | null => {
    if (blank.length > 0) return null
    try {
      const totals = previewCloseEditTotals(
        trade.events,
        draft.events.map((e) => ({ ...e, price: e.price as number })),
      )
      return netCredit({
        totalCreditCollected: totals.credit,
        totalDebitPaid: totals.debit,
      })
    } catch {
      return null // an ineligible leg — the action will refuse with the reason
    }
  })()

  const incomplete = blank.length > 0 || occurredAtIso === ''

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (blank.length > 0) {
      setError('Every leg needs a price — $0.00 is allowed, blank is not')
      return
    }
    if (occurredAtIso === '') {
      setError('Enter a valid closed-at date/time')
      return
    }
    setSaving(true)
    try {
      await onEditClose(trade.id, draft)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the edit')
    } finally {
      setSaving(false)
    }
  }

  const priorNet = netCredit(trade)

  return (
    <form onSubmit={submit} className="px-5 py-4 border-t border-amber-900/40 bg-amber-950/10 space-y-3">
      <p className="text-amber-500/80 text-xs font-mono">
        Editing a closed trade. Totals are re-derived from the full event log on save —
        entry legs, roll legs and Schwab-filled legs are not editable.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Closed At">
          <TextInput
            type="datetime-local"
            value={closedAt}
            onChange={(e) => setClosedAt(e.target.value)}
            required
          />
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

      {closeEvents.length === 0 ? (
        <p className="text-slate-500 text-xs font-mono">
          This trade has no close legs on record — only the fields above can be edited.
        </p>
      ) : (
        <div className="space-y-1.5">
          {closeEvents.map((ev) => {
            const row = legs.find((l) => l.id === ev.id)
            if (!row) {
              return (
                <div
                  key={ev.id}
                  className="grid grid-cols-[1.4fr_0.9fr_0.9fr_1.1fr] gap-1.5 items-center text-xs font-mono text-slate-500"
                >
                  <span>{LEG_LABEL[ev.leg]} · ${ev.strike}</span>
                  <span>${ev.price.toFixed(2)}</span>
                  <span>{ev.creditDebit}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500 text-center tracking-wider">
                    SCHWAB FILL
                  </span>
                </div>
              )
            }
            return (
              <div key={ev.id} className="grid grid-cols-[1.4fr_0.9fr_0.9fr_1.1fr] gap-1.5 items-center">
                <span className="text-xs font-mono text-slate-400">
                  {LEG_LABEL[ev.leg]} · ${ev.strike}
                </span>
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="price"
                  value={row.price}
                  onChange={(e) => updateLeg(ev.id, { price: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.preventDefault()
                  }}
                  required
                />
                <Select
                  value={row.creditDebit}
                  onChange={(e) => updateLeg(ev.id, { creditDebit: e.target.value as CreditDebit })}
                >
                  <option value="credit">credit</option>
                  <option value="debit">debit</option>
                </Select>
                <span className="text-xs font-mono text-slate-600">was ${ev.price.toFixed(2)}</span>
              </div>
            )
          })}
        </div>
      )}

      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>

      {preview !== null && (
        <p className="text-xs font-mono text-slate-400">
          Realized P&amp;L{' '}
          <span className="text-slate-500">${priorNet.toFixed(2)}</span> →{' '}
          <span className={preview >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            ${preview.toFixed(2)}
          </span>
        </p>
      )}
      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
      <FormButtons saving={saving} onDone={onDone} label="Save Edit" disabled={incomplete} />
    </form>
  )
}

function FormButtons({
  saving,
  onDone,
  label,
  disabled = false,
}: {
  saving: boolean
  onDone: () => void
  label: string
  disabled?: boolean
}) {
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
        disabled={saving || disabled}
        className="px-3 py-1.5 text-xs rounded-md font-mono border border-emerald-700 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : label}
      </button>
    </div>
  )
}
