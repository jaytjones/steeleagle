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

interface Props {
  rows: EditableLeg[]
  onChange: (rows: EditableLeg[]) => void
  /** Roll rows show an event_type selector; close rows do not. */
  withEventType: boolean
  defaultExpiration: string
}

export default function LegRowsEditor({ rows, onChange, withEventType, defaultExpiration }: Props) {
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

  const cols = withEventType
    ? 'grid-cols-[1.1fr_1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_auto]'
    : 'grid-cols-[1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_auto]'

  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className={`grid ${cols} gap-1.5 items-center`}>
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
          <Select value={r.leg} onChange={(e) => update(i, { leg: e.target.value as Leg })}>
            {LEG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <TextInput
            type="number"
            step="0.01"
            placeholder="strike"
            value={r.strike}
            onChange={(e) => update(i, { strike: e.target.value })}
          />
          <TextInput
            type="date"
            value={r.expiration}
            onChange={(e) => update(i, { expiration: e.target.value })}
          />
          <TextInput
            type="number"
            step="0.001"
            placeholder="delta"
            value={r.delta}
            onChange={(e) => update(i, { delta: e.target.value })}
          />
          <TextInput
            type="number"
            step="0.01"
            placeholder="price"
            value={r.price}
            onChange={(e) => update(i, { price: e.target.value })}
          />
          <Select
            value={r.creditDebit}
            onChange={(e) => update(i, { creditDebit: e.target.value as CreditDebit })}
          >
            <option value="credit">credit</option>
            <option value="debit">debit</option>
          </Select>
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-slate-600 hover:text-red-400 text-lg leading-none px-1"
            aria-label="Remove leg"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs font-mono text-emerald-500 hover:text-emerald-400"
      >
        + add leg
      </button>
    </div>
  )
}
