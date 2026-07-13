// ============================================================
// SteelEagle — v2.0 Order Placement Server Actions
//
// The first Schwab WRITE path. Every action here sits behind the
// operator-confirmed gate in PlaceOrderPanel — nothing auto-submits.
//
// Design rules (spec §3):
// - The ticket is rebuilt SERVER-SIDE from zod-validated primitives via
//   buildCondorOrder (golden-fixture-tested). A client-supplied ticket
//   object is never forwarded to Schwab.
// - Schwab does no server-side review; buildCondorOrder throwing on a
//   structural violation is the last programmatic guardrail.
// - recordFillAction refuses partial fills (spec §8 open question #5:
//   until partial-fill semantics for 4-leg orders are confirmed live,
//   only a fully FILLED order may be journaled).
// ============================================================

'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAccountHash } from '@/lib/schwab/accounts'
import {
  cancelOrder,
  getOrder,
  placeOrder,
  type SchwabOrderDetail,
} from '@/lib/schwab/orders'
import { buildCondorOrder } from '@/lib/schwab/order-ticket'
import { parseOccSymbol } from '@/lib/strategy/reconstruct-positions'
import { createTrade as dbCreateTrade } from '@/lib/db/journal'
import { NewTradeSchema, type Leg, type NewTradeInput } from '@/lib/journal/types'

// --------------------------------------------------------
// Input schema — primitives only, mirrored from the scanner's CondorSetup
// --------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const PlaceCondorSchema = z.object({
  symbol: z.string().trim().min(1).max(6).transform((s) => s.toUpperCase()),
  expiration: isoDate,
  strikes: z.object({
    longPut: z.number().positive(),
    shortPut: z.number().positive(),
    shortCall: z.number().positive(),
    longCall: z.number().positive(),
  }),
  /** Net credit to ask, per share. The operator confirms/edits this in the panel. */
  price: z.number().positive(),
  quantity: z.number().int().min(1).max(10),
  /** Signed deltas at scan time — journal metadata only, never sent to Schwab. */
  deltas: z
    .object({
      longPut: z.number().min(-1).max(1).nullable(),
      shortPut: z.number().min(-1).max(1).nullable(),
      shortCall: z.number().min(-1).max(1).nullable(),
      longCall: z.number().min(-1).max(1).nullable(),
    })
    .optional(),
})
export type PlaceCondorInput = z.infer<typeof PlaceCondorSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid order input — ${msg}`)
  }
  return result.data
}

// --------------------------------------------------------
// Place
// --------------------------------------------------------
export interface PlaceCondorResult {
  orderId: string
  /** Echo of what was actually submitted, for the panel to display. */
  submitted: { symbol: string; price: string; quantity: number }
}

export async function placeCondorOrderAction(raw: unknown): Promise<PlaceCondorResult> {
  const input = parseOrThrow(PlaceCondorSchema, raw)

  const ticket = buildCondorOrder(
    {
      symbol: input.symbol,
      expiration: input.expiration,
      longPut: { strike: input.strikes.longPut },
      shortPut: { strike: input.strikes.shortPut },
      shortCall: { strike: input.strikes.shortCall },
      longCall: { strike: input.strikes.longCall },
    },
    { quantity: input.quantity, price: input.price },
  )

  const hash = await getAccountHash()
  const { orderId } = await placeOrder(hash, ticket)

  return {
    orderId,
    submitted: { symbol: input.symbol, price: ticket.price, quantity: ticket.quantity },
  }
}

// --------------------------------------------------------
// Status / cancel
// --------------------------------------------------------
export interface OrderStatusResult {
  orderId: string
  status: string
  filledQuantity: number
  quantity: number
  cancelable: boolean
}

function toStatusResult(orderId: string, order: SchwabOrderDetail): OrderStatusResult {
  return {
    orderId,
    status: order.status ?? 'UNKNOWN',
    filledQuantity: order.filledQuantity ?? 0,
    quantity: order.quantity ?? 0,
    cancelable: order.cancelable ?? false,
  }
}

export async function getOrderStatusAction(orderId: string): Promise<OrderStatusResult> {
  if (!orderId) throw new Error('Missing order id')
  const hash = await getAccountHash()
  return toStatusResult(orderId, await getOrder(hash, orderId))
}

export async function cancelCondorOrderAction(orderId: string): Promise<OrderStatusResult> {
  if (!orderId) throw new Error('Missing order id')
  const hash = await getAccountHash()
  await cancelOrder(hash, orderId)
  // Read back so the panel shows the terminal state Schwab actually recorded.
  return toStatusResult(orderId, await getOrder(hash, orderId))
}

// --------------------------------------------------------
// Fill → journal (Phase D)
// --------------------------------------------------------
export interface RecordFillResult {
  journaled: boolean
  netCreditDollars: number
}

/** instruction + putCall → journal leg name. */
function legRole(instruction: string, putCall: 'PUT' | 'CALL'): Leg {
  const short = instruction.startsWith('SELL')
  if (putCall === 'PUT') return short ? 'short_put' : 'long_put'
  return short ? 'short_call' : 'long_call'
}

/**
 * Journal a FILLED condor order via the existing createTrade path
 * (source='schwab_fill' + order id — same provenance as the importer).
 *
 * `initialBpr` is computed the strategy way: wingWidth×100×contracts − net
 * credit dollars (wingWidth − credit, in dollars).
 */
export async function recordFillAction(
  orderId: string,
  meta: { sleeve?: 'core' | 'earnings'; deltas?: PlaceCondorInput['deltas'] } = {},
): Promise<RecordFillResult> {
  if (!orderId) throw new Error('Missing order id')
  const hash = await getAccountHash()
  const order = await getOrder(hash, orderId)

  if (order.status !== 'FILLED') {
    throw new Error(
      `Order ${orderId} is ${order.status ?? 'UNKNOWN'}, not FILLED — refusing to journal. ` +
        `(Partial/working orders must resolve at Schwab first.)`,
    )
  }
  const legsRaw = order.orderLegCollection ?? []
  if (legsRaw.length !== 4) {
    throw new Error(`Order ${orderId} has ${legsRaw.length} legs — expected a 4-leg condor.`)
  }
  const filledQty = order.filledQuantity ?? 0
  const orderQty = order.quantity ?? 0
  if (orderQty > 0 && filledQty !== orderQty) {
    throw new Error(
      `Order ${orderId} filled ${filledQty}/${orderQty} — partial fills are not journaled ` +
        `automatically. Resolve at Schwab, then use the importer.`,
    )
  }

  // Per-leg fill prices: quantity-weighted average across execution activities,
  // keyed by legId. Falls back to the order-level net price only if execution
  // detail is absent for a leg (flagged in the trade notes).
  const fills = new Map<number, { paid: number; qty: number }>()
  for (const activity of order.orderActivityCollection ?? []) {
    for (const ex of activity.executionLegs ?? []) {
      const q = ex.quantity ?? 1
      const prev = fills.get(ex.legId) ?? { paid: 0, qty: 0 }
      fills.set(ex.legId, { paid: prev.paid + ex.price * q, qty: prev.qty + q })
    }
  }

  const contracts = filledQty || orderQty || 1
  const openedAt = order.closeTime ?? order.enteredTime

  const legs: NewTradeInput['legs'] = legsRaw.map((raw) => {
    const parsed = parseOccSymbol(raw.instrument.symbol)
    if (!parsed) {
      throw new Error(`Order ${orderId}: unparseable OCC symbol "${raw.instrument.symbol}"`)
    }
    const role = legRole(raw.instruction, parsed.putCall)
    const fill = raw.legId !== undefined ? fills.get(raw.legId) : undefined
    if (!fill || fill.qty <= 0) {
      // Never fabricate a fill price into the journal. The importer's
      // marks-only path is the designed fallback for exactly this case.
      throw new Error(
        `Order ${orderId}: FILLED but Schwab returned no execution detail for leg ` +
          `${raw.instrument.symbol}. Not journaling with invented prices — use ` +
          `"Import from Schwab" on /journal instead.`,
      )
    }
    const price = fill.paid / fill.qty
    const delta = meta.deltas?.[camel(role)] ?? null
    return {
      leg: role,
      strike: parsed.strike,
      expiration: parsed.expiration,
      delta,
      price,
      creditDebit: raw.instruction.startsWith('SELL') ? ('credit' as const) : ('debit' as const),
    }
  })

  const netCreditDollars = legs.reduce(
    (sum, l) => sum + (l.creditDebit === 'credit' ? 1 : -1) * l.price * 100 * contracts,
    0,
  )

  const parsedFirst = parseOccSymbol(legsRaw[0].instrument.symbol)!
  const shortPut = legs.find((l) => l.leg === 'short_put')!
  const longPut = legs.find((l) => l.leg === 'long_put')!
  const shortCall = legs.find((l) => l.leg === 'short_call')!
  const longCall = legs.find((l) => l.leg === 'long_call')!
  const wingWidth = Math.max(
    shortPut.strike - longPut.strike,
    longCall.strike - shortCall.strike,
  )
  const initialBpr = Math.max(0.01, wingWidth * 100 * contracts - netCreditDollars)

  const input = parseOrThrow(NewTradeSchema, {
    symbol: parsedFirst.underlying,
    sleeve: meta.sleeve ?? 'core',
    openedAt,
    initialExpiration: parsedFirst.expiration,
    contracts,
    initialBpr,
    source: 'schwab_fill',
    schwabOrderId: orderId,
    notes: 'v2.0 placement — journaled automatically from the confirmed fill.',
    legs,
  } satisfies Record<string, unknown>)

  await dbCreateTrade(input)
  revalidatePath('/journal')

  return { journaled: true, netCreditDollars }
}

function camel(leg: Leg): 'longPut' | 'shortPut' | 'shortCall' | 'longCall' {
  return leg === 'long_put'
    ? 'longPut'
    : leg === 'short_put'
      ? 'shortPut'
      : leg === 'short_call'
        ? 'shortCall'
        : 'longCall'
}
