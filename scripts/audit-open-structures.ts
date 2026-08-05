// ============================================================
// SteelEagle — audit every OPEN trade: what will the sweep do with it?
//
// READ-ONLY. Two SELECTs via listTrades({ status: 'open' }); no writes, no
// Schwab calls, no mutations.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/audit-open-structures.ts
//
// Written for the v2.7 strike-ordering refusal, then generalized in v2.7.1.
// The original version counted butterflies only among REFUSED trades — so
// once v2.7.1 made butterflies priceable it reported "0 butterflies" for a
// journal that contained one. A counter that goes quiet when the thing it
// counts becomes NORMAL is the same failure mode as the exception-only
// RollBadge (v2.6.1): "none" and "not looking" render identically. It now
// classifies every open trade unconditionally.
//
// What it CANNOT see: the pre-place guard, which needs live Schwab order
// state. A trade shown as WOULD PLACE may still be blocked by a standing
// close order the journal does not know about. That guard is fetched-order
// truth and only runs in the cron.
// ============================================================

import { listTrades } from '../lib/db/journal'
import { currentStructure, structureRefusal } from '../lib/journal/current-structure'
import { computeExitDebit } from '../lib/schwab/exit-ticket'
import { netCredit } from '../lib/journal/trade-math'
import { daysToExpiration } from '../lib/strategy/reconstruct-positions'
import { PLACEMENT_MIN_DTE, DTE_ALERT } from '../lib/strategy/exit-sweep'
import type { Trade } from '../lib/journal/types'

/**
 * Current strikes per role, from `currentStructure` itself wherever it
 * succeeds — anything else is a SECOND leg-derivation path, which is what
 * v2.3 deleted `exitInputFromOpenEvents` to avoid. A hand-rolled fold here
 * first reported two healthy trades as having vacant legs: it applied events
 * in createdAt order, while the real fold batches by occurredAt and applies
 * closes BEFORE opens (a roll is atomic, so row order must not matter).
 */
function strikesOf(trade: Trade): { text: string; butterfly: boolean } {
  try {
    const s = currentStructure(trade.symbol, trade.events)
    return {
      text: `${s.longPut.strike} / ${s.shortPut.strike} / ${s.shortCall.strike} / ${s.longCall.strike}`,
      butterfly: s.shortPut.strike === s.shortCall.strike,
    }
  } catch {
    return { text: '(not reconstructible)', butterfly: false }
  }
}

async function main() {
  const open = await listTrades({ status: 'open' })
  const now = new Date()
  console.log(`\nOpen trades: ${open.length}   (now ${now.toISOString()})`)
  console.log(`PLACEMENT_MIN_DTE=${PLACEMENT_MIN_DTE}  DTE_ALERT=${DTE_ALERT}`)
  console.log('='.repeat(78))

  let butterflies = 0
  let refused = 0

  for (const t of open) {
    const dte = daysToExpiration(t.currentExpiration, now)
    const refusal = structureRefusal(t.symbol, t.events)
    const { text, butterfly } = strikesOf(t)
    if (butterfly) butterflies++
    if (refusal) refused++

    const net = netCredit(t)
    let target = '—'
    try {
      target = computeExitDebit(t.totalCreditCollected, t.totalDebitPaid, t.contracts)
    } catch {
      /* unpriceable credit — reported via the verdict below */
    }

    // Mirrors the order of the planner's own checks (lib/strategy/exit-sweep.ts).
    let verdict: string
    if (t.exitOrderId !== null) verdict = `standing GTC ${t.exitOrderId} — no placement`
    else if (dte < PLACEMENT_MIN_DTE) verdict = `NO PLACEMENT — ${dte} DTE is below ${PLACEMENT_MIN_DTE}`
    else if (refusal) verdict = 'FLAG — unpriceable'
    else verdict = `WOULD PLACE @ ${target} (pre-place guard not checked here)`

    console.log(
      `  ${t.symbol.padEnd(5)} ${t.currentExpiration}  ${text.padEnd(28)}` +
        `${butterfly ? ' [BUTTERFLY]' : ''}`,
    )
    console.log(`      dte=${dte}  netCredit=$${net.toFixed(2)}  50% target=${target}  contracts=${t.contracts}`)
    console.log(`      ${verdict}`)
    if (refusal) console.log(`      refusal: ${refusal}`)
    if (dte <= DTE_ALERT) console.log(`      *** ${dte} DTE — at/below the ${DTE_ALERT}-DTE manual-close alert ***`)
  }

  console.log('='.repeat(78))
  console.log(`  iron butterflies: ${butterflies}   unpriceable: ${refused}/${open.length}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
