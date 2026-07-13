'use client'

// ============================================================
// SteelEagle — v2.0 Place Order Panel
//
// The operator-confirmed gate for the first Schwab write path.
// Schwab performs NO server-side review — this panel is the last
// human checkpoint before a live order. Flow:
//
//   idle → review (edit credit/qty, see BPR + all 4 legs)
//        → placing → working (poll status every 3s; Cancel available)
//        → filled  (auto-journal via recordFillAction) → journaled
//        | canceled | error
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

interface PlaceOrderPanelProps {
  condor: CondorSetup
  entryGate?: EntryGate
}

export default function PlaceOrderPanel({ condor, entryGate }: PlaceOrderPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [price, setPrice] = useState<string>(condor.totalCredit.toFixed(2))
  const [quantity, setQuantity] = useState<string>('1')
  const pollCount = useRef(0)

  const blocked = entryGate?.status === 'BLOCKED'

  const priceNum = Number.parseFloat(price)
  const qtyNum = Number.parseInt(quantity, 10)
  const priceValid = Number.isFinite(priceNum) && priceNum > 0 && priceNum < condor.wingWidth
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= 10

  const creditDollars = priceValid && qtyValid ? priceNum * 100 * qtyNum : 0
  const bprDollars =
    priceValid && qtyValid ? condor.wingWidth * 100 * qtyNum - creditDollars : 0

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
        longPut: condor.longPut.delta ?? null,
        shortPut: condor.shortPut.delta ?? null,
        shortCall: condor.shortCall.delta ?? null,
        longCall: condor.longCall.delta ?? null,
      },
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
  }, [phase, condor])

  async function submit() {
    if (!priceValid || !qtyValid) return
    setPhase({ kind: 'placing' })
    pollCount.current = 0
    try {
      const result = await placeCondorOrderAction({
        symbol: condor.symbol,
        expiration: condor.expiration,
        strikes: {
          longPut: condor.longPut.strike,
          shortPut: condor.shortPut.strike,
          shortCall: condor.shortCall.strike,
          longCall: condor.longCall.strike,
        },
        price: priceNum,
        quantity: qtyNum,
        deltas: {
          longPut: condor.longPut.delta ?? null,
          shortPut: condor.shortPut.delta ?? null,
          shortCall: condor.shortCall.delta ?? null,
          longCall: condor.longCall.delta ?? null,
        },
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

  // ── render ──
  if (phase.kind === 'idle') {
    return (
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
    )
  }

  if (phase.kind === 'review' || phase.kind === 'placing') {
    const placing = phase.kind === 'placing'
    return (
      <div className="border border-sky-900/60 rounded-lg p-3 space-y-2 text-xs font-mono bg-slate-950/60">
        <div className="text-slate-400 font-semibold tracking-wide">
          CONFIRM ORDER — {condor.symbol} iron condor · exp {condor.expiration}
        </div>
        <div className="text-slate-500 space-y-0.5">
          <div>SELL {condor.shortCall.strike}C / BUY {condor.longCall.strike}C</div>
          <div>SELL {condor.shortPut.strike}P / BUY {condor.longPut.strike}P</div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-slate-500">
            credit
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={placing}
              className={`w-16 bg-slate-900 border rounded px-1.5 py-0.5 text-right ${
                priceValid ? 'border-slate-700 text-slate-200' : 'border-red-800 text-red-400'
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
        {priceValid && qtyValid && (
          <div className="text-slate-500">
            ≈ ${creditDollars.toFixed(0)} credit · ${bprDollars.toFixed(0)} BPR · NET_CREDIT ·
            DAY
          </div>
        )}
        <div className="text-amber-500/90">
          ⚠ Submits immediately — Schwab performs no review step.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={placing || !priceValid || !qtyValid}
            className="flex-1 rounded border border-red-800 text-red-400 hover:bg-red-950/40 py-1.5 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {placing ? 'Submitting…' : 'Submit to Schwab'}
          </button>
          <button
            onClick={() => setPhase({ kind: 'idle' })}
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
      <div className="border border-emerald-900/60 rounded-lg p-3 text-xs font-mono text-emerald-400 bg-slate-950/60">
        ✓ FILLED — writing to journal…
      </div>
    )
  }

  if (phase.kind === 'journaled') {
    return (
      <div className="border border-emerald-900/60 rounded-lg p-3 space-y-1 text-xs font-mono bg-slate-950/60">
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
          onClick={() => setPhase({ kind: 'idle' })}
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
        onClick={() => setPhase({ kind: 'idle' })}
        className="w-full rounded border border-slate-700 text-slate-400 hover:bg-slate-800/50 py-1.5"
      >
        Dismiss
      </button>
    </div>
  )
}
