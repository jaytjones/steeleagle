// ============================================================
// SteelEagle — v2.16 auto-entry REPLAY DRY RUN
//
// Usage:
//   npx tsx --env-file=.env.local scripts/dry-run-auto-entry.ts
//
// READ-ONLY. Two DB reads (the fill ledger, the journal). No Schwab call and
// no write function imported.
//
// For every filled four-leg ENTRY in the ledger: had the v2.16 entry pass run
// the night it filled, what would it have done, and would its trade have
// matched the one Import (or JJ) actually recorded — legs, prices, contracts
// and the DERIVED BPR?
//
// Each entry is replayed against the journal as it stood just before it: trades
// WRITTEN (createdAt) before the fill, MINUS the trade that holds this order id (otherwise
// the planner correctly skips it as already journaled). The gate is forced
// OPEN over a 1-ms interval ending at the fill.
//
// A BPR difference is expected on older trades: before Session 27 BPR was
// TYPED on the Import review card. It is reported, not counted as a mapper
// defect.
// ============================================================

import { listFillsInInterval } from '../lib/db/fills'
import { listTrades } from '../lib/db/journal'
import { planAutoEntries } from '../lib/journal/auto-entry'

const ct = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }) + ' CT'

async function main() {
  const [fills, trades] = await Promise.all([listFillsInInterval(new Date(0), new Date()), listTrades()])
  const entries = fills.filter(
    (f) => f.classification.shape === 'CONDOR_OPEN' && f.classification.filled && f.classification.status === 'FILLED',
  )
  console.log(`\nLedger: ${entries.length} filled four-leg entries. Journal: ${trades.length} trades.\n`)

  const tally = { write: 0, exact: 0, bprOnly: 0, mismatch: 0, unjournaled: 0, refused: 0 }

  for (const row of entries) {
    const fill = row.classification
    const at = Date.parse(fill.occurredAt)
    const wanted = fill.legs.map((l) => `${l.role}|${l.strike}|${l.expiration}`)
    const own =
      trades.find((t) =>
        t.events.some((e) => e.eventType === 'open' && e.schwabOrderId === fill.orderId),
      ) ??
      // Fallback: a trade typed by hand LATER (no order id) at these exact legs —
      // the GLD scale-in shape. Compared, so her numbers are checked too.
      trades.find(
        (t) =>
          t.symbol === fill.underlying &&
          Date.parse(t.createdAt) >= at &&
          t.events.some((e) => e.eventType === 'open' && e.schwabOrderId === null) &&
          wanted.every((k) =>
            t.events.some((e) => e.eventType === 'open' && `${e.leg}|${e.strike}|${e.expiration}` === k),
          ),
      )
    // By createdAt — when the row was actually WRITTEN — not openedAt: a trade
    // hand-typed days later carries an openedAt before the fill, but it did not
    // exist the night the sweep would have run.
    const asOf = trades.filter((t) => t !== own && Date.parse(t.createdAt) < at)

    const plan = planAutoEntries({
      fills: [{ classification: fill, disposition: 'pending' }],
      trades: asOf,
      interval: { from: new Date(at - 1), to: new Date(at) },
      balanceStatus: 'BALANCED',
    })

    console.log(`${fill.orderId}  ${fill.underlying} ${fill.expiration}  ${fill.contracts}-lot  filled ${ct(fill.occurredAt)}`)
    if (plan.refused.length > 0) {
      tally.refused++
      console.log(`   REFUSED  ${plan.refused[0].reason}\n`)
      continue
    }
    tally.write++
    const w = plan.write[0]
    console.log(`   WOULD WRITE  BPR $${w.input.initialBpr.toFixed(2)}, GTC held`)
    if (!own) {
      tally.unjournaled++
      console.log(`   (never journaled — this entry has no trade to compare against)\n`)
      continue
    }

    const problems: string[] = []
    if (own.contracts !== w.contracts) problems.push(`contracts ${w.contracts} vs journal ${own.contracts}`)
    for (const l of w.input.legs) {
      const h = own.events.find((e) => e.eventType === 'open' && e.leg === l.leg)
      if (!h) problems.push(`${l.leg}: no journaled entry leg`)
      else {
        if (h.strike !== l.strike) problems.push(`${l.leg}: strike ${l.strike} vs journal ${h.strike}`)
        if (Math.abs(h.price - l.price) >= 0.005) problems.push(`${l.leg}: price ${l.price.toFixed(2)} vs journal ${h.price.toFixed(2)}`)
        if (h.creditDebit !== l.creditDebit) problems.push(`${l.leg}: ${l.creditDebit} vs journal ${h.creditDebit}`)
      }
    }
    const bprDiff = Math.abs(own.initialBpr - w.input.initialBpr) >= 0.005
    if (problems.length === 0 && !bprDiff) {
      tally.exact++
      console.log(`   EXACT MATCH with trade ${own.id.slice(0, 8)}\n`)
    } else if (problems.length === 0) {
      tally.bprOnly++
      console.log(`   legs EXACT; BPR derived $${w.input.initialBpr.toFixed(2)} vs journaled $${own.initialBpr.toFixed(2)}\n`)
    } else {
      tally.mismatch++
      console.log(`   MISMATCH vs trade ${own.id.slice(0, 8)}:`)
      for (const p of problems) console.log(`     - ${p}`)
      if (bprDiff) console.log(`     - BPR derived $${w.input.initialBpr.toFixed(2)} vs journaled $${own.initialBpr.toFixed(2)}`)
      console.log('')
    }
  }

  console.log(
    `Summary: ${tally.write} would write (${tally.exact} exact, ${tally.bprOnly} legs exact / BPR differs, ` +
      `${tally.mismatch} mismatched, ${tally.unjournaled} never journaled) · ${tally.refused} refused`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
