'use client'

// ============================================================
// SteelEagle — v2.0 Place Order Panel (+ v2.1 leg editing & override)
//
// The operator-confirmed gate for the first Schwab write path.
// Schwab performs NO server-side review — this panel is the last
// human checkpoint before a live order. Flow:
//
//   idle → review (edit credit/qty/STRIKES, see BPR + all 4 legs)
//        → placing → working (poll status every 3s; Cancel available)
//        → filled  (auto-journal via recordFillAction) → journaled
//        | canceled | error
//
//   BLOCKED gate: idle → override (typed reason ≥ 15 chars) → review
//        wrapped in a persistent red banner; the violated rules +
//        reason are stamped into the journal notes on fill.
//
// v2.1 rules (spec, Session 11 decisions — do not re-litigate):
// - Editing a strike ABANDONS the 16Δ/5Δ targeting: the edited leg
//   shows a "custom" marker and its delta is nulled in everything
//   sent to the server (a stale delta is worse than no delta).
// - Client revalidation mirrors the builder: LP < SP < SC < LC and
//   credit < narrower wing. Invalid → red border + submit disabled.
// - Strike-grid existence is NOT pre-validated; a non-existent strike
//   is rejected by Schwab at submit time and surfaces in the error
//   state (accepted v2.1 failure mode).
// - The override must never be frictionless: typed reason, violations
//   listed verbatim, red through the whole flow, self-documenting in
//   the journal.
//
// Same state-machine-in-one-component pattern as ImportButton.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CondorSetup } from '@/types'
import type { EntryGate } from '@/lib/strategy/entry-gate'
import {
  cancelCondorOrderAction,
  getOrderStatusAction,
  placeCondorOrderAction,
  recordFillAction,
  type OrderStatusResult,
} from '@/app/dashboard/order-actions'

type Phase =
  | { kind: 'idle' }
  | { kind: 'override' } // v2.1: typed-reason step before review, BLOCKED gates only
  | { kind: 'review' }
  | { kind: 'placing' }
  | { kind: 'working'; orderId: string; status: string; canceling: boolean }
  | { kind: 'journaling'; orderId: string }
  | { kind: 'journaled'; orderId: string; netCreditDollars: number }
  | { kind: 'canceled'; orderId: string }
  | { kind: 'error'; message: string; orderId?: string }

const TERMINAL_UNFILLED = new Set(['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'])
const POLL_MS = 3000
const MAX_POLLS = 40 // ~2 minutes, then stop polling but keep the order visible
const OVERRIDE_REASON_MIN = 15
const OVERRIDE_REASON_MAX = 500

type LegKey = 'longPut' | 'shortPut' | 'shortCall' | 'longCall'

interface PlaceOrderPanelProps {
  condor: CondorSetup
  entryGate?: EntryGate
}

export default function PlaceOrderPanel({ condor, entryGate }: PlaceOrderPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [price, setPrice] = useState<string>(condor.totalCredit.toFixed(2))
  const [quantity, setQuantity] = useState<string>('1')
  // v2.1 — editable strikes, initialized from the scan.
  const [strikes, setStrikes] = useState<Record<LegKey, string>>({
    longPut: String(condor.longPut.strike),
    shortPut: String(condor.shortPut.strike),
    shortCall: String(condor.shortCall.strike),
    longCall: String(condor.longCall.strike),
  })
  // v2.1 — override sub-state. Active from "Proceed" until reset to idle.
  const [overrideActive, setOverrideActive] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const pollCount = useRef(0)

  const blocked = entryGate?.status === 'BLOCKED'
  const gateViolations =
    entryGate?.reasons && entryGate.reasons.length > 0
      ? entryGate.reasons
      : ['Entry gate BLOCKED']

  // ── strike parsing + validation (mirrors buildCondorOrder's guardrails) ──
  const lp = Number.parseFloat(strikes.longPut)
  const sp = Number.parseFloat(strikes.shortPut)
  const sc = Number.parseFloat(strikes.shortCall)
  const lc = Number.parseFloat(strikes.longCall)

  const finiteStrike = (n: number) => Number.isFinite(n) && n > 0
  const strikesFinite =
    finiteStrike(lp) && finiteStrike(sp) && finiteStrike(sc) && finiteStrike(lc)
  const orderingValid = strikesFinite && lp < sp && sp < sc && sc < lc

  const putWing = sp - lp
  const callWing = lc - sc
  const narrowWing = orderingValid ? Math.min(putWing, callWing) : 0
  const wideWing = orderingValid ? Math.max(putWing, callWing) : 0

  const edited: Record<LegKey, boolean> = {
    longPut: lp !== condor.longPut.strike,
    shortPut: sp !== condor.shortPut.strike,
    shortCall: sc !== condor.shortCall.strike,
    longCall: lc !== condor.longCall.strike,
  }
  const anyEdited = edited.longPut || edited.shortPut || edited.shortCall || edited.longCall

  const priceNum = Number.parseFloat(price)
  const qtyNum = Number.parseInt(quantity, 10)
  const priceSelfValid = Number.isFinite(priceNum) && priceNum > 0
  const priceValid = priceSelfValid && orderingValid && priceNum < narrowWing
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= 10
  const canSubmit = orderingValid && priceValid && qtyValid

  const creditDollars = canSubmit ? priceNum * 100 * qtyNum : 0
  // Max loss uses the WIDER wing (matches recordFillAction's initialBpr).
  const bprDollars = canSubmit ? wideWing * 100 * qtyNum - creditDollars : 0

  /** Delta metadata for the server: edited legs are nulled (stale delta > no delta). */
  const deltaFor = (leg: LegKey): number | null =>
    edited[leg] ? null : (condor[leg].delta ?? null)

  const overrideMeta = overrideActive
    ? { reason: overrideReason.trim(), violations: gateViolations }
    : undefined

  function resetToIdle() {
    setPhase({ kind: 'idle' })
    setPrice(condor.totalCredit.toFixed(2))
    setQuantity('1')
    setStrikes({
      longPut: String(condor.longPut.strike),
      shortPut: String(condor.shortPut.strike),
      shortCall: String(condor.shortCall.strike),
      longCall: String(condor.longCall.strike),
    })
    setOverrideActive(false)
    setOverrideReason('')
  }

  // ── status polling while working ──
  const poll = useCallback(async (orderId: string) => {
    let result: OrderStatusResult
    try {
      result = await getOrderStatusAction(orderId)
    } catch {
      return // transient — next tick retries
    }
    setPhase((p) => {
      if (p.kind !== 'working' || p.orderId !== orderId) return p
      if (result.status === 'FILLED') return { kind: 'journaling', orderId }
      if (TERMINAL_UNFILLED.has(result.status)) return { kind: 'canceled', orderId }
      return { ...p, status: result.status }
    })
  }, [])

  useEffect(() => {
    if (phase.kind !== 'working') return
    if (pollCount.current >= MAX_POLLS) return
    const t = setTimeout(() => {
      pollCount.current += 1
      void poll(phase.orderId)
    }, POLL_MS)
    return () => clearTimeout(t)
  }, [phase, poll])

  // ── auto-journal on fill ──
  useEffect(() => {
    if (phase.kind !== 'journaling') return
    const { orderId } = phase
    recordFillAction(orderId, {
      sleeve: 'core',
      deltas: {
        longPut: deltaFor('longPut'),
        shortPut: deltaFor('shortPut'),
        shortCall: deltaFor('shortCall'),
        longCall: deltaFor('longCall'),
      },
      override: overrideMeta,
    })
      .then((r) =>
        setPhase({ kind: 'journaled', orderId, netCreditDollars: r.netCreditDollars }),
      )
      .catch((err) =>
        setPhase({
          kind: 'error',
          orderId,
          message: `Order FILLED but journaling failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  async function submit() {
    if (!canSubmit) return
    setPhase({ kind: 'placing' })
    pollCount.current = 0
    try {
      const result = await placeCondorOrderAction({
        symbol: condor.symbol,
        expiration: condor.expiration,
        strikes: { longPut: lp, shortPut: sp, shortCall: sc, longCall: lc },
        price: priceNum,
        quantity: qtyNum,
        deltas: {
          longPut: deltaFor('longPut'),
          shortPut: deltaFor('shortPut'),
          shortCall: deltaFor('shortCall'),
          longCall: deltaFor('longCall'),
        },
        override: overrideMeta,
      })
      setPhase({ kind: 'working', orderId: result.orderId, status: 'SUBMITTED', canceling: false })
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function cancel() {
    if (phase.kind !== 'working') return
    const { orderId } = phase
    setPhase({ ...phase, canceling: true })
    try {
      const result = await cancelCondorOrderAction(orderId)
      if (result.status === 'FILLED') {
        // Filled before the cancel landed — journal it.
        setPhase({ kind: 'journaling', orderId })
      } else {
        setPhase({ kind: 'canceled', orderId })
      }
    } catch (err) {
      setPhase({
        kind: 'error',
        orderId,
        message: `Cancel failed — CHECK THINKORSWIM, the order may still be working. ${err instanceof Error ? err.message : ''}`,
      })
    }
  }

  // ── shared render bits ──
  const overrideBanner = overrideActive && (
    <div className="border border-red-800 bg-red-950/40 rounded p-2 space-y-0.5 text-red-400">
      <div className="font-semibold tracking-wide">⚠ GATE OVERRIDE — rules bypassed:</div>
      {gateViolations.map((v) => (
        <div key={v}>• {v}</div>
      ))}
      <div className="text-red-500/80 break-words">
        Reason on record: {overrideReason.trim()}
      </div>
    </div>
  )

  function strikeInput(leg: LegKey, label: string, suffix: 'P' | 'C', disabled: boolean) {
    const n = Number.parseFloat(strikes[leg])
    const invalid = !finiteStrike(n) || (strikesFinite && !orderingValid)
    return (
      <label className="flex items-center gap-1 text-slate-500">
        {label}
        <input
          value={strikes[leg]}
          onChange={(e) => setStrikes((s) => ({ ...s, [leg]: e.target.value }))}
          disabled={disabled}
          className={`w-16 bg-slate-900 border rounded px-1.5 py-0.5 text-right ${
            invalid ? 'border-red-800 text-red-400' : 'border-slate-700 text-slate-200'
          }`}
        />
        {suffix}
        {edited[leg] && !invalid && (
          <span className="text-amber-500/90 text-[10px] uppercase">custom</span>
        )}
      </label>
    )
  }

  // ── render ──
  if (phase.kind === 'idle') {
    return (
      <div className="space-y-1.5">
        <button
          onClick={() => setPhase({ kind: 'review' })}
          disabled={blocked}
          className={`w-full text-xs font-mono rounded border py-1.5 transition-colors ${
            blocked
              ? 'border-slate-800 text-slate-600 cursor-not-allowed'
              : 'border-sky-800 text-sky-400 hover:bg-sky-950/40'
          }`}
          title={blocked ? 'Entry gate: BLOCKED' : 'Review & place this condor via the Schwab API'}
        >
          {blocked ? 'Entry blocked' : 'Place order…'}
        </button>
        {blocked && (
          <button
            onClick={() => setPhase({ kind: 'override' })}
            className="w-full text-xs font-mono rounded border border-red-900/70 text-red-500/90 hover:bg-red-950/30 py-1 transition-colors"
            title="Bypass the entry gate — requires a typed reason; stamped into the journal"
          >
            Override gate…
          </button>
        )}
      </div>
    )
  }

  if (phase.kind === 'override') {
    const trimmedLen = overrideReason.trim().length
    const reasonOk = trimmedLen >= OVERRIDE_REASON_MIN
    return (
      <div className="border border-red-900/60 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
        <div className="text-red-400 font-semibold tracking-wide">
          ⚠ OVERRIDE ENTRY GATE — {condor.symbol}
        </div>
        <div className="text-red-400/90 space-y-0.5">
          {gateViolations.map((v) => (
            <div key={v}>• {v}</div>
          ))}
        </div>
        <div className="text-slate-500">
          This bypasses the strategy's entry rules. The violated rules and your reason
          will be permanently stamped into the trade's journal notes.
        </div>
        <textarea
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          maxLength={OVERRIDE_REASON_MAX}
          rows={3}
          placeholder={`Why is this trade justified anyway? (min ${OVERRIDE_REASON_MIN} chars)`}
          className={`w-full bg-slate-900 border rounded px-2 py-1.5 text-slate-200 placeholder:text-slate-600 resize-none ${
            trimmedLen === 0 || reasonOk ? 'border-slate-700' : 'border-red-800'
          }`}
        />
        <div className={reasonOk ? 'text-slate-600' : 'text-red-500/80'}>
          {trimmedLen}/{OVERRIDE_REASON_MIN} min · {OVERRIDE_REASON_MAX} max
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setOverrideActive(true)
              setPhase({ kind: 'review' })
            }}
            disabled={!reasonOk}
            className="flex-1 rounded border border-red-800 text-red-400 hover:bg-red-950/40 py-1.5 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Proceed to review
          </button>
          <button
            onClick={resetToIdle}
            className="rounded border border-slate-700 text-slate-400 hover:bg-slate-800/50 px-3 py-1.5"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (phase.kind === 'review' || phase.kind === 'placing') {
    const placing = phase.kind === 'placing'
    return (
      <div className="border border-sky-900/60 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
        {overrideBanner}
        <div className="text-slate-400 font-semibold tracking-wide">
          CONFIRM ORDER — {condor.symbol} iron condor · exp {condor.expiration}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            {strikeInput('shortCall', 'SELL', 'C', placing)}
            {strikeInput('longCall', 'BUY', 'C', placing)}
          </div>
          <div className="flex items-center gap-3">
            {strikeInput('shortPut', 'SELL', 'P', placing)}
            {strikeInput('longPut', 'BUY', 'P', placing)}
          </div>
        </div>
        {strikesFinite && !orderingValid && (
          <div className="text-red-400">
            ✗ Strikes must satisfy LP &lt; SP &lt; SC &lt; LC.
          </div>
        )}
        {anyEdited && orderingValid && (
          <div className="text-amber-500/90">
            ⚠ Custom strikes — 16Δ/5Δ targeting abandoned; edited legs journal without
            deltas. A strike not on the chain is rejected by Schwab at submit.
          </div>
        )}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-slate-500">
            credit
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={placing}
              className={`w-16 bg-slate-900 border rounded px-1.5 py-0.5 text-right ${
                !priceSelfValid || (orderingValid && priceNum >= narrowWing)
                  ? 'border-red-800 text-red-400'
                  : 'border-slate-700 text-slate-200'
              }`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-slate-500">
            qty
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={placing}
              className={`w-10 bg-slate-900 border rounded px-1.5 py-0.5 text-right ${
                qtyValid ? 'border-slate-700 text-slate-200' : 'border-red-800 text-red-400'
              }`}
            />
          </label>
        </div>
        {priceSelfValid && orderingValid && priceNum >= narrowWing && (
          <div className="text-red-400">
            ✗ Credit must be below the narrower wing ({narrowWing.toFixed(2)}).
          </div>
        )}
        {canSubmit && (
          <div className="text-slate-500">
            ≈ ${creditDollars.toFixed(0)} credit · ${bprDollars.toFixed(0)} BPR · NET_CREDIT ·
            DAY
            {anyEdited && putWing !== callWing && (
              <span> · wings {putWing.toFixed(0)}P/{callWing.toFixed(0)}C</span>
            )}
          </div>
        )}
        <div className="text-amber-500/90">
          ⚠ Submits immediately — Schwab performs no review step.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={placing || !canSubmit}
            className="flex-1 rounded border border-red-800 text-red-400 hover:bg-red-950/40 py-1.5 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {placing ? 'Submitting…' : 'Submit to Schwab'}
          </button>
          <button
            onClick={resetToIdle}
            disabled={placing}
            className="rounded border border-slate-700 text-slate-400 hover:bg-slate-800/50 px-3 py-1.5"
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  if (phase.kind === 'working') {
    return (
      <div className="border border-amber-900/60 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
        {overrideActive && (
          <div className="text-red-400">⚠ Gate override active — will be stamped into the journal.</div>
        )}
        <div className="text-amber-400">
          ● {phase.status} — order {phase.orderId}
        </div>
        <div className="text-slate-500">Polling status… fills auto-journal.</div>
        <button
          onClick={() => void cancel()}
          disabled={phase.canceling}
          className="w-full rounded border border-slate-700 text-slate-300 hover:bg-slate-800/50 py-1.5 disabled:opacity-50"
        >
          {phase.canceling ? 'Canceling…' : 'Cancel order'}
        </button>
      </div>
    )
  }

  if (phase.kind === 'journaling') {
    return (
      <div className="border border-emerald-900/60 rounded-lg p-3 space-y-1 text-xs font-mono bg-slate-950/60">
        {overrideActive && (
          <div className="text-red-400">⚠ Gate override — stamping into journal notes.</div>
        )}
        <div className="text-emerald-400">✓ FILLED — writing to journal…</div>
      </div>
    )
  }

  if (phase.kind === 'journaled') {
    return (
      <div className="border border-emerald-900/60 rounded-lg p-3 space-y-1 text-xs font-mono bg-slate-950/60">
        {overrideActive && (
          <div className="text-red-400">⚠ OVERRIDE — violations + reason stamped into journal notes.</div>
        )}
        <div className="text-emerald-400">✓ Filled & journaled — order {phase.orderId}</div>
        <div className="text-slate-500">
          Net credit ${phase.netCreditDollars.toFixed(2)} · view on /journal
        </div>
      </div>
    )
  }

  if (phase.kind === 'canceled') {
    return (
      <div className="border border-slate-800 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
        <div className="text-slate-400">Order {phase.orderId} did not fill (canceled/expired).</div>
        <button
          onClick={resetToIdle}
          className="w-full rounded border border-slate-700 text-slate-400 hover:bg-slate-800/50 py-1.5"
        >
          Done
        </button>
      </div>
    )
  }

  // error
  return (
    <div className="border border-red-900/60 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
      <div className="text-red-400 break-words">✗ {phase.message}</div>
      <button
        onClick={resetToIdle}
        className="w-full rounded border border-slate-700 text-slate-400 hover:bg-slate-800/50 py-1.5"
      >
        Dismiss
      </button>
    </div>
  )
}
