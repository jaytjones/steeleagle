// ============================================================
// SteelEagle — one-off backfill: replace $0.00 initial_bpr placeholders
//
// Usage:
//   npx tsx --env-file=.env.local scripts/backfill-entry-bpr.ts           # dry run
//   npx tsx --env-file=.env.local scripts/backfill-entry-bpr.ts --apply   # write
//
// WHY. July 2026 Imports stored initial_bpr = 0 — the ImportCandidate
// placeholder, from before v2.3.2 made 0 unrepresentable ("0 is never a real
// BPR"). The v2.16 entry replay found 11 such trades, every one with entry legs
// that match Schwab's executions exactly. Approved by JJ 2026-10-31.
//
// WHAT. For each trade with initial_bpr = 0, derive BPR with `entryBpr` — the
// same function the New Trade form, Import and auto-entry use — from the
// trade's OWN journaled entry legs and contract count. A trade whose BPR cannot
// be derived is SKIPPED and reported, never guessed.
//
// SAFETY. Nothing in the app reads initial_bpr to make a decision (verified
// 2026-10-31 — no gate consumes it), so this changes stored data only. One
// transaction; every UPDATE guarded on `id AND initial_bpr = 0`, so a re-run is
// a no-op and a row edited meanwhile is left alone. Any row count other than 1
// rolls the whole batch back.
// ============================================================

import { db } from '@vercel/postgres'
import { listTrades } from '../lib/db/journal'
import { entryBpr } from '../lib/journal/trade-math'

async function main() {
  const apply = process.argv.includes('--apply')
  const trades = (await listTrades()).filter((t) => t.initialBpr === 0)

  const plan: { id: string; label: string; bpr: number }[] = []
  for (const t of trades) {
    const legs = t.events.filter((e) => e.eventType === 'open')
    const bpr = entryBpr(legs, t.contracts)
    const label = `${t.id.slice(0, 8)}  ${t.symbol.padEnd(4)} ${t.initialExpiration}  ${t.contracts}-lot  ${t.status}`
    if (bpr === null) {
      console.log(`SKIP   ${label}  — BPR not derivable from its entry legs`)
      continue
    }
    plan.push({ id: t.id, label, bpr })
    console.log(`${apply ? 'WRITE' : 'WOULD'}  ${label}  $0.00 → $${bpr.toFixed(2)}`)
  }
  console.log(`\n${trades.length} trade(s) at $0.00 · ${plan.length} derivable`)

  if (!apply) {
    console.log('Dry run — nothing written. Re-run with --apply to write.')
    return
  }
  if (plan.length === 0) return

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const p of plan) {
      const { rowCount } = await client.query(
        `UPDATE trades SET initial_bpr = $2, updated_at = now() WHERE id = $1 AND initial_bpr = 0`,
        [p.id, p.bpr],
      )
      if (rowCount !== 1) throw new Error(`${p.label}: ${rowCount} rows updated — rolled back`)
    }
    await client.query('COMMIT')
    console.log(`Committed ${plan.length} update(s).`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
