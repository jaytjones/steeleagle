// ============================================================
// SteelEagle — dump ONE order by id, raw, for fixture pinning.
//
// The Schwab doctrine step: place an unfillable order, read back what
// Schwab ACTUALLY recorded, pin it as a golden fixture, THEN write the
// builder against the fixture. Never from docs.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/dump-order.ts <orderId>
//
// READ-ONLY: a single GET /accounts/{hash}/orders/{orderId} over the
// existing authenticated path. Places nothing, cancels nothing.
//
// Complements dump-working-orders.ts, which scans a window when you do
// NOT know the id. With an id in hand this is exact — no guessing which
// of several working orders is the one you just placed.
//
// NOTE ON SHARING: the order body itself carries no account hash, but
// check for an `accountNumber` field before pasting the output anywhere.
// ============================================================

import { getOrder } from '../lib/schwab/orders'
import { getAccountHash } from '../lib/schwab/accounts'

/** The fields a ticket builder must match exactly. */
const PINNED_FIELDS = [
  'orderStrategyType',
  'complexOrderStrategyType',
  'orderType',
  'duration',
  'session',
  'quantity',
  'price',
  'status',
] as const

async function main() {
  const orderId = process.argv[2]
  if (!orderId) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/dump-order.ts <orderId>')
    process.exit(1)
  }

  const hash = await getAccountHash()
  const order = await getOrder(hash, orderId)
  const raw = order as unknown as Record<string, unknown>

  console.log('\n' + '='.repeat(72))
  console.log('RAW ORDER JSON — this is the fixture. Pin it verbatim.')
  console.log('='.repeat(72))
  console.log(JSON.stringify(order, null, 2))

  console.log('\n' + '='.repeat(72))
  console.log('TOP-LEVEL FIELDS THE BUILDER MUST MATCH')
  console.log('='.repeat(72))
  for (const f of PINNED_FIELDS) {
    console.log(`  ${f.padEnd(26)} ${JSON.stringify(raw[f] ?? null)}`)
  }

  console.log('\n' + '='.repeat(72))
  console.log('LEG ORDER (the sequence is part of the fixture, not incidental)')
  console.log('='.repeat(72))
  const legs = (raw.orderLegCollection ?? []) as Array<Record<string, unknown>>
  legs.forEach((leg, i) => {
    const ins = (leg.instrument ?? {}) as Record<string, unknown>
    console.log(
      `  ${i + 1}. ${String(leg.instruction).padEnd(16)} qty=${leg.quantity}  ${ins.symbol}`,
    )
  })

  console.log('\n' + '='.repeat(72))
  console.log('WHAT TO COMPARE AGAINST')
  console.log('='.repeat(72))
  console.log(`  Condor close  (pinned 2026-07-24): complexOrderStrategyType "IRON_CONDOR"`)
  console.log(`  This order:                        "${String(raw.complexOrderStrategyType)}"`)
  console.log(
    raw.complexOrderStrategyType === 'IRON_CONDOR'
      ? `\n  → SAME as the condor. One shared literal may suffice — but confirm the leg\n` +
          `    order and every field above before relaxing the SP === SC refusal.\n`
      : `\n  → DIFFERENT from the condor's "IRON_CONDOR". The ticket builders' hardcoded\n` +
          `    literal is WRONG for a butterfly. lib/schwab/{order,exit}-ticket.ts type\n` +
          `    complexOrderStrategyType as the literal 'IRON_CONDOR' — that type must widen\n` +
          `    before a butterfly payload can be built. This is exactly why the fixture\n` +
          `    gate exists.\n`,
  )
  console.log('  REMINDER: cancel this order in thinkorswim if it is still working.\n')
}

main().catch((err) => {
  console.error('dump-order failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
