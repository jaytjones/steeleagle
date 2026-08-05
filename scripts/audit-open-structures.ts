// ============================================================
// SteelEagle — Session 20 one-off: audit OPEN trades against the new
// v2.7 strike-ordering refusal before it ships.
//
// READ-ONLY. Two SELECTs via listTrades({ status: 'open' }); no writes,
// no Schwab calls, no mutations of any kind.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/audit-open-structures.ts
//
// Why: `currentStructure` previously compared NO strikes, so every open
// trade passed `isPriceableStructure`. v2.7 adds the LP < SP <= SC < LC
// check. Any open trade that violates it flips from "sweep auto-places a
// 50% GTC" to "flagged, place manually" at the next 4:15 PM CT run. That
// direction is fail-safe, and it cannot disturb a STANDING GTC (the check
// sits after the `exitOrderId !== null` continue) — but it must not be a
// surprise. This prints the verdict for every open trade.
// ============================================================

import { listTrades } from '../lib/db/journal'
import { currentStructure, structureRefusal } from '../lib/journal/current-structure'
import type { Trade } from '../lib/journal/types'

/**
 * Current strikes per role.
 *
 * Uses `currentStructure` itself wherever it succeeds — anything else is a
 * SECOND leg-derivation path, which is precisely what v2.3 deleted
 * `exitInputFromOpenEvents` to avoid. A hand-rolled fold here first reported
 * two healthy trades as having vacant legs: it applied events in createdAt
 * order, while the real fold batches by occurredAt and applies closes BEFORE
 * opens (a roll is atomic, so row insertion order must not matter).
 *
 * The fallback below runs only for trades currentStructure refuses, purely to
 * show what the strikes look like. It carries the same closes-first batching.
 */
function currentStrikes(trade: Trade): Record<string, number | null> {
  try {
    const s = currentStructure(trade.symbol, trade.events)
    return {
      long_put: s.longPut.strike,
      short_put: s.shortPut.strike,
      short_call: s.shortCall.strike,
      long_call: s.longCall.strike,
    }
  } catch {
    // Diagnostic-only path for refused trades.
  }

  const state: Record<string, number | null> = {
    long_put: null,
    short_put: null,
    short_call: null,
    long_call: null,
  }
  for (const e of trade.events.filter((x) => x.eventType === 'open')) {
    state[e.leg] = e.strike
  }
  const rolls = [...trade.events]
    .filter((e) => e.eventType === 'roll_close' || e.eventType === 'roll_open')
    .sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt),
    )

  let i = 0
  while (i < rolls.length) {
    const at = rolls[i].occurredAt
    const batch = []
    while (i < rolls.length && rolls[i].occurredAt === at) batch.push(rolls[i++])
    for (const e of batch) if (e.eventType === 'roll_close') state[e.leg] = null
    for (const e of batch) if (e.eventType === 'roll_open') state[e.leg] = e.strike
  }
  return state
}

async function main() {
  const open = await listTrades({ status: 'open' })
  console.log(`\nOpen trades: ${open.length}\n${'='.repeat(72)}`)

  let refused = 0
  let butterflies = 0
  let ordering = 0

  for (const t of open) {
    const refusal = structureRefusal(t.symbol, t.events)
    const s = currentStrikes(t)
    const strikes = `${s.long_put ?? '—'} / ${s.short_put ?? '—'} / ${s.short_call ?? '—'} / ${s.long_call ?? '—'}`
    const rolls = t.events.filter((e) => e.eventType === 'roll_open').length

    if (refusal === null) {
      console.log(`  OK        ${t.symbol.padEnd(5)} ${t.currentExpiration}  ${strikes}`)
      continue
    }

    refused++
    const isButterfly = /iron BUTTERFLY/.test(refusal)
    const isOrdering = /not ordered LP < SP < SC < LC/.test(refusal)
    if (isButterfly) butterflies++
    if (isOrdering) ordering++

    // NEW = a refusal v2.7 introduced. Everything else (diagonal, vacant leg,
    // multi-root index, unpinned fixture) already refused before this change.
    const tag = isButterfly || isOrdering ? 'NEW' : 'PRE-EXISTING'
    console.log(`  REFUSED   ${t.symbol.padEnd(5)} ${t.currentExpiration}  ${strikes}`)
    console.log(`    [${tag}] exitOrderId=${t.exitOrderId ?? 'null'} rollOpens=${rolls}`)
    console.log(`    ${refusal}`)
  }

  console.log(`${'='.repeat(72)}`)
  console.log(`  refused: ${refused}/${open.length}`)
  console.log(`  NEW refusals introduced by v2.7: ${butterflies + ordering}`)
  console.log(`    iron butterflies (SP == SC): ${butterflies}`)
  console.log(`    other bad ordering:          ${ordering}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
