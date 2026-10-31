// ============================================================
// SteelEagle — v2.15 auto-roll REPLAY DRY RUN (spec §9.3)
//
// Usage:
//   npx tsx --env-file=.env.local scripts/dry-run-auto-roll.ts
//
// READ-ONLY. Two DB reads (the fill ledger, the journal). No Schwab call, no
// write of any kind — it imports no write function.
//
// For every filled single-ticket ROLL in the ledger, this asks: had the v2.15
// pass run the night that roll filled, what would it have done — and would its
// entry have matched the one JJ typed by hand?
//
// THE REPLAY PROBLEM. Every historical roll is already journaled, so run
// against today's journal the planner skips them all (condition A — exactly
// what it must do live). So each roll is replayed against the journal AS IT
// STOOD JUST BEFORE IT: every trade cut to the events before the earlier of
// (the fill, JJ's hand entry for it), open if it had not yet closed, no GTC on
// record, no hold. The gate is forced OPEN over a 1-ms interval ending at the
// fill — the residual proof is the cron's job, not this script's.
//
// THE COMPARISON. A planned write is diffed against JJ's hand-journaled batch
// by (eventType, leg): strike, expiration, price, credit/debit. The writer must
// reproduce her entries exactly; any mismatch is either a mapper defect or a
// hand-entry error, and both are worth knowing before the first automatic write.
// ============================================================

import { listFillsInInterval } from '../lib/db/fills'
import { listTrades } from '../lib/db/journal'
import { planAutoRolls, type AutoRollTrade } from '../lib/journal/auto-roll'
import { foldStructure } from '../lib/journal/current-structure'
import { matchFill, requiredEventKeys } from '../lib/journal/match-fill'
import type { Trade, TradeEvent } from '../lib/journal/types'

const ct = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }) + ' CT'

const keyOf = (e: Pick<TradeEvent, 'eventType' | 'leg' | 'strike' | 'expiration'>) =>
  `${e.eventType}|${e.leg}|${e.strike}|${e.expiration}`

/** The journal as it stood strictly before `cut`. */
function journalAsOf(trades: Trade[], cut: number): AutoRollTrade[] {
  return trades
    .filter((t) => Date.parse(t.openedAt) < cut)
    .map((t) => {
      const events = t.events.filter((e) => Date.parse(e.occurredAt) < cut)
      let currentExpiration = t.initialExpiration
      try {
        currentExpiration = foldStructure(events).expiration
      } catch {
        /* unfoldable then — the planner will refuse it on 9a and say why */
      }
      return {
        id: t.id,
        symbol: t.symbol,
        status: t.closedAt && Date.parse(t.closedAt) < cut ? ('closed' as const) : ('open' as const),
        currentExpiration,
        contracts: t.contracts,
        exitOrderId: null,
        exitHoldOrderId: null,
        events,
      }
    })
}

async function main() {
  const [fills, trades] = await Promise.all([
    listFillsInInterval(new Date(0), new Date()),
    listTrades(),
  ])
  const rolls = fills.filter(
    (f) => f.classification.shape === 'ROLL' && f.classification.filled && f.classification.status === 'FILLED',
  )

  console.log(`\nLedger: ${fills.length} fills, ${rolls.length} filled single-ticket roll(s). Journal: ${trades.length} trades.\n`)

  const tally = { write: 0, exact: 0, mismatch: 0, refused: 0, skipped: 0 }

  for (const row of rolls) {
    const fill = row.classification
    const fillAt = Date.parse(fill.occurredAt)
    const head = `${fill.orderId}  ${fill.underlying} ${fill.expiration ?? '(mixed)'}  ${fill.contracts}-lot  filled ${ct(fill.occurredAt)}`

    // JJ's hand entry for this roll, if any — found against TODAY's journal.
    const verdict = matchFill(fill, trades)
    const owner = verdict.verdict === 'ALREADY_JOURNALED' ? trades.find((t) => t.id === verdict.tradeId) : undefined
    const required = new Set(requiredEventKeys(fill))
    const batch = (owner?.events ?? [])
      .filter((e) => required.has(keyOf(e)))
      // nearest-in-time event per key, in case a strike recurs across rolls
      .sort((a, b) => Math.abs(Date.parse(a.occurredAt) - fillAt) - Math.abs(Date.parse(b.occurredAt) - fillAt))
      .filter((e, i, all) => all.findIndex((x) => keyOf(x) === keyOf(e)) === i)

    const cut = Math.min(fillAt, ...batch.map((e) => Date.parse(e.occurredAt)))
    const plan = planAutoRolls({
      fills: [{ classification: fill, disposition: 'pending' }],
      trades: journalAsOf(trades, cut),
      interval: { from: new Date(fillAt - 1), to: new Date(fillAt) },
      balanceStatus: 'BALANCED',
    })

    console.log(head)
    if (plan.refused.length > 0) {
      tally.refused++
      console.log(`   REFUSED  ${plan.refused[0].reason}\n`)
      continue
    }
    if (plan.write.length === 0) {
      tally.skipped++
      console.log(`   SKIPPED  no owning open trade in the journal as it stood then (verdict today: ${verdict.verdict})\n`)
      continue
    }

    tally.write++
    const w = plan.write[0]
    console.log(`   WOULD WRITE → trade ${w.tradeId.slice(0, 8)} (${w.events.length} legs), GTC held`)
    if (batch.length === 0) {
      console.log(`   (no hand entry to compare against — this roll is unjournaled)\n`)
      continue
    }

    const problems: string[] = []
    for (const p of w.events) {
      const h = batch.find((e) => e.eventType === p.eventType && e.leg === p.leg)
      if (!h) {
        problems.push(`${p.eventType} ${p.leg}: planned, but no matching hand entry`)
        continue
      }
      if (h.strike !== p.strike) problems.push(`${p.eventType} ${p.leg}: strike ${p.strike} vs hand ${h.strike}`)
      if (h.expiration !== p.expiration) problems.push(`${p.eventType} ${p.leg}: exp ${p.expiration} vs hand ${h.expiration}`)
      if (Math.abs(h.price - p.price) >= 0.005) problems.push(`${p.eventType} ${p.leg}: price ${p.price.toFixed(2)} vs hand ${h.price.toFixed(2)}`)
      if (h.creditDebit !== p.creditDebit) problems.push(`${p.eventType} ${p.leg}: ${p.creditDebit} vs hand ${h.creditDebit}`)
    }
    if (batch.length !== w.events.length) problems.push(`leg count: planned ${w.events.length}, hand ${batch.length}`)

    const skewMin = Math.round((Date.parse(batch[0].occurredAt) - fillAt) / 60_000)
    if (problems.length === 0) {
      tally.exact++
      console.log(`   EXACT MATCH with the hand entry (hand-typed time ${skewMin >= 0 ? '+' : ''}${skewMin} min from the fill)\n`)
    } else {
      tally.mismatch++
      console.log(`   MISMATCH vs the hand entry:`)
      for (const p of problems) console.log(`     - ${p}`)
      console.log('')
    }
  }

  console.log(
    `Summary: ${tally.write} would write (${tally.exact} exact, ${tally.mismatch} mismatched) · ` +
      `${tally.refused} refused · ${tally.skipped} skipped`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
