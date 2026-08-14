// ============================================================
// SteelEagle — dump FILLED option orders in a window, classified.
//
// The v2.11 reconnaissance script. `dump-working-orders.ts` deliberately
// filters FILLED orders OUT (it exists to catch an unfillable order still
// working in TOS); this is its counterpart, and the two do not overlap.
//
// Purpose: recover what Schwab ACTUALLY records for a manually-placed
// roll. The v2.11 fill classifier must be written against these payloads,
// never against the docs — the same doctrine that produced
// `SPY_BUTTERFLY_GOLDEN` and caught `duration: "GOOD_TILL_CANCEL"`.
//
// The one question this answers before any classifier code is written:
// does a TOS roll arrive as ONE mixed ticket (BUY_TO_CLOSE + SELL_TO_OPEN
// in a single orderLegCollection) or as TWO separate orders placed
// seconds apart? One ticket makes ROLL detection exact. Two makes it a
// pairing heuristic, and the heuristic needs a time window and a refusal
// rule. The answer changes the design, so it is established first.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/dump-filled-orders.ts [lookbackDays]
//
// READ-ONLY: one GET /accounts/{hash}/orders over the existing
// authenticated path. Places nothing, cancels nothing, writes nothing.
//
// NOTE ON SHARING: check for an `accountNumber` field before pasting the
// raw output anywhere.
// ============================================================

import { getWorkingAndRecentOrders, type SchwabOrderDetail } from '../lib/schwab/orders'
import { getAccountHash } from '../lib/schwab/accounts'
import { parseOccSymbol } from '../lib/strategy/reconstruct-positions'

/**
 * What the v2.11 classifier will have to decide, computed here by the
 * crudest possible rule so the RAW SHAPE is what we judge, not our
 * interpretation of it. Deliberately not imported from lib/ — there is no
 * classifier yet, and this script exists to inform the one we write.
 */
type Shape = 'ALL_OPEN' | 'ALL_CLOSE' | 'MIXED_ROLL' | 'NO_OPTION_LEGS' | 'UNKNOWN'

function shapeOf(order: SchwabOrderDetail): Shape {
  const legs = order.orderLegCollection ?? []
  const optionLegs = legs.filter((l) => l.instrument?.assetType === 'OPTION')
  if (optionLegs.length === 0) return 'NO_OPTION_LEGS'

  const opens = optionLegs.filter((l) => (l.instruction ?? '').endsWith('_TO_OPEN')).length
  const closes = optionLegs.filter((l) => (l.instruction ?? '').endsWith('_TO_CLOSE')).length

  if (opens === optionLegs.length) return 'ALL_OPEN'
  if (closes === optionLegs.length) return 'ALL_CLOSE'
  if (opens > 0 && closes > 0) return 'MIXED_ROLL'
  return 'UNKNOWN'
}

/** legId → quantity-weighted average execution price, as close-from-fill.ts computes it. */
function execPrices(order: SchwabOrderDetail): Map<number, number> {
  const acc = new Map<number, { paid: number; qty: number }>()
  for (const activity of order.orderActivityCollection ?? []) {
    for (const ex of activity.executionLegs ?? []) {
      const q = ex.quantity ?? 1
      const prev = acc.get(ex.legId) ?? { paid: 0, qty: 0 }
      acc.set(ex.legId, { paid: prev.paid + ex.price * q, qty: prev.qty + q })
    }
  }
  const out = new Map<number, number>()
  for (const [legId, { paid, qty }] of acc) out.set(legId, qty > 0 ? paid / qty : 0)
  return out
}

function summarize(order: SchwabOrderDetail, shape: Shape): void {
  const prices = execPrices(order)
  console.log(
    `\norder ${order.orderId}  ${shape}  status=${order.status ?? '?'}  ` +
      `complex=${order.complexOrderStrategyType ?? '—'}  ` +
      `qty=${order.quantity ?? '?'} filled=${order.filledQuantity ?? '?'}  ` +
      `price=${order.price ?? '—'}`,
  )
  console.log(`  entered ${order.enteredTime}  closed ${order.closeTime ?? '—'}`)

  for (const [idx, leg] of (order.orderLegCollection ?? []).entries()) {
    const sym = leg.instrument?.symbol ?? '?'
    const parsed = parseOccSymbol(sym)
    const legId = leg.legId ?? idx + 1
    const fill = prices.get(legId)
    const desc = parsed
      ? `${parsed.underlying} ${parsed.expiration} ${parsed.strike}${parsed.putCall === 'PUT' ? 'P' : 'C'}`
      : sym
    console.log(
      `    legId=${String(legId).padEnd(3)} ${(leg.instruction ?? '?').padEnd(15)} ` +
        `${desc.padEnd(28)} qty=${leg.quantity ?? '?'}  fill=${fill !== undefined ? fill.toFixed(2) : 'NO EXEC DETAIL'}`,
    )
  }
}

async function main() {
  const lookbackDays = Number(process.argv[2] ?? 14)
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/dump-filled-orders.ts [lookbackDays]')
    process.exit(1)
  }

  const hash = await getAccountHash()
  // Reuses the sweep's fetch: no status filter, so a REJECTED or CANCELED
  // order in the window is visible too. `fromEnteredTime` filters on
  // PLACEMENT, so an old GTC filled recently would fall outside a short
  // window — the same trap documented on getWorkingAndRecentOrders.
  const all = await getWorkingAndRecentOrders(hash, lookbackDays)

  const filled = all.filter((o) => o.status === 'FILLED')
  const withOptions = filled.filter((o) =>
    (o.orderLegCollection ?? []).some((l) => l.instrument?.assetType === 'OPTION'),
  )

  console.log('='.repeat(72))
  console.log(
    `${all.length} order(s) in the last ${lookbackDays} day(s) · ` +
      `${filled.length} FILLED · ${withOptions.length} with option legs`,
  )
  console.log('='.repeat(72))

  const byShape = new Map<Shape, SchwabOrderDetail[]>()
  for (const order of withOptions) {
    const shape = shapeOf(order)
    byShape.set(shape, [...(byShape.get(shape) ?? []), order])
    summarize(order, shape)
  }

  console.log('\n' + '='.repeat(72))
  console.log('SHAPE TALLY — the design question')
  console.log('='.repeat(72))
  for (const shape of ['MIXED_ROLL', 'ALL_CLOSE', 'ALL_OPEN', 'UNKNOWN', 'NO_OPTION_LEGS'] as Shape[]) {
    const n = byShape.get(shape)?.length ?? 0
    if (n > 0) console.log(`  ${shape.padEnd(16)} ${n}`)
  }

  const rolls = byShape.get('MIXED_ROLL') ?? []
  if (rolls.length > 0) {
    console.log('\n' + '='.repeat(72))
    console.log(`RAW JSON — ${rolls.length} MIXED_ROLL order(s). THESE ARE THE FIXTURES.`)
    console.log('='.repeat(72))
    for (const order of rolls) {
      console.log(JSON.stringify(order, null, 2))
      console.log('\n' + '-'.repeat(60) + '\n')
    }
  } else {
    console.log(
      '\nNo single-ticket rolls in the window. If a roll is KNOWN to have happened here, ' +
        'it was placed as two separate orders — pair the ALL_CLOSE and ALL_OPEN entries ' +
        'above by underlying and enteredTime, and dump those instead.',
    )
  }
}

main().catch((err) => {
  console.error('dump-filled-orders failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
