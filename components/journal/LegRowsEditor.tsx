'use client'

// ============================================================
// SteelEagle — dynamic leg-row editor shared by the roll & close forms.
// Each row is one trade_event leg. Roll rows expose the event_type
// (roll_close / roll_open); close rows are implicitly `close`.
// ============================================================

import { Select, TextInput } from './fields'
import type { CreditDebit, Leg } from '@/lib/journal/types'

export interface EditableLeg {
  eventType?: 'roll_close' | 'roll_open'
  leg: Leg
  strike: string
  expiration: string
  delta: string
  price: string
  creditDebit: CreditDebit
}

const LEG_OPTIONS: { value: Leg; label: string }[] = [
  { value: 'long_put', label: 'Long Put' },
  { value: 'short_put', label: 'Short Put' },
  { value: 'short_call', label: 'Short Call' },
  { value: 'long_call', label: 'Long Call' },
]

/**
 * v2.2.1 — Enter must never submit from inside a leg field.
 *
 * An implicit Enter-submit from the first price field is how a close reached
 * the DB with three blank prices (Session 15). Blocking it here covers the
 * roll editor too — the same coercion hazard lives on that path.
 */
function blockEnterSubmit(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter') e.preventDefault()
}

interface Props {
  rows: EditableLeg[]
  onChange: (rows: EditableLeg[]) => void
  /** Roll rows show an event_type selector; close rows do not. */
  withEventType: boolean
  defaultExpiration: string
  /**
   * v2.2.1 — fixed four-leg mode (the Close form): the leg role is rendered
   * as a label and add/remove are gone, so the leg COUNT cannot be wrong.
   */
  lockRows?: boolean
}

const LEG_SHORT: Record<Leg, string> = {
  long_put: 'LP · Long Put',
  short_put: 'SP · Short Put',
  short_call: 'SC · Short Call',
  long_call: 'LC · Long Call',
}

export default function LegRowsEditor({
  rows,
  onChange,
  withEventType,
  defaultExpiration,
  lockRows = false,
}: Props) {
  const update = (i: number, patch: Partial<EditableLeg>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () =>
    onChange([
      ...rows,
      {
        ...(withEventType ? { eventType: 'roll_open' as const } : {}),
        leg: 'short_call',
        strike: '',
        expiration: defaultExpiration,
        delta: '',
        price: '',
        creditDebit: 'credit',
      },
    ])

  // Written out in full: Tailwind scans source text, so a class name
  // assembled from interpolated fragments never gets generated.
  const cols = withEventType
    ? lockRows
      ? 'grid-cols-[1.1fr_1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr]'
      : 'grid-cols-[1.1fr_1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_auto]'
    : lockRows
      ? 'grid-cols-[1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr]'
      : 'grid-cols-[1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_auto]'

  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={lockRows ? r.leg : i} className={`grid ${cols} gap-1.5 items-center`}>
          {withEventType && (
            <Select
              value={r.eventType}
              onChange={(e) =>
                update(i, { eventType: e.target.value as 'roll_close' | 'roll_open' })
              }
            >
              <option value="roll_close">roll close</option>
              <option value="roll_open">roll open</option>
            </Select>
          )}
          {lockRows ? (
            <span className="text-xs font-mono text-slate-400">{LEG_SHORT[r.leg]}</span>
          ) : (
            <Select value={r.leg} onChange={(e) => update(i, { leg: e.target.value as Leg })}>
              {LEG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
          <TextInput
            type="number"
            step="0.01"
            placeholder="strike"
            value={r.strike}
            onChange={(e) => update(i, { strike: e.target.value })}
            onKeyDown={blockEnterSubmit}
            required
          />
          <TextInput
            type="date"
            value={r.expiration}
            onChange={(e) => update(i, { expiration: e.target.value })}
            onKeyDown={blockEnterSubmit}
            required
          />
          <TextInput
            type="number"
            step="0.001"
            placeholder="delta"
            value={r.delta}
            onChange={(e) => update(i, { delta: e.target.value })}
            onKeyDown={blockEnterSubmit}
          />
          <TextInput
            type="number"
            step="0.01"
            placeholder="price"
            value={r.price}
            onChange={(e) => update(i, { price: e.target.value })}
            onKeyDown={blockEnterSubmit}
            required
          />
          <Select
            value={r.creditDebit}
            onChange={(e) => update(i, { creditDebit: e.target.value as CreditDebit })}
          >
            <option value="credit">credit</option>
            <option value="debit">debit</option>
          </Select>
          {!lockRows && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-slate-600 hover:text-red-400 text-lg leading-none px-1"
              aria-label="Remove leg"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!lockRows && (
        <button
          type="button"
          onClick={add}
          className="text-xs font-mono text-emerald-500 hover:text-emerald-400"
        >
          + add leg
        </button>
      )}
    </div>
  )
}
