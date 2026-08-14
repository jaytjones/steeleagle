// ============================================================
// SteelEagle — export the journal to a timestamped JSON restore point.
//
// The journal is the ONLY record of PRICES and INTENT (lib/journal/reconcile.ts
// §header). The account is truth for STRUCTURE and can always be re-read from
// Schwab; nothing anywhere can reconstruct what a leg filled at or why a trade
// was closed. That asymmetry is the whole reason this script exists — and the
// reason to run it BEFORE any corrective journaling session, not after.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/export-journal.ts [--with-iv] [outDir]
//
// READ-ONLY against the DB: SELECTs only, no writes, no schema access. Safe to
// run at any time, including while the cron sweep is mid-run.
//
// ── Fidelity notes (these are the reasons for the odd-looking SQL) ──
//
// Rows are serialized SERVER-SIDE with `to_jsonb(t)` rather than fetched as
// driver rows. Two reasons, both about restoring correctly:
//
//   1. node-postgres hydrates a `date` column into a JS Date, and JSON.stringify
//      turns that into a full ISO timestamp — so `current_expiration` would come
//      back as "2026-09-18T00:00:00.000Z" and restore into a date column as a
//      DIFFERENT VALUE in any timezone west of UTC. `to_jsonb` renders it as
//      "2026-09-18", exactly as stored.
//   2. `to_jsonb(t)` is `select *` that survives schema change. A column added
//      by a future migration is captured automatically instead of being silently
//      dropped by a hand-enumerated column list — a backup that quietly omits
//      the field you migrated for is worse than no backup.
//
// ── What is NOT exported, and why ──
//
//   tokens, accounts   — OAuth refresh tokens and the account hash. Deliberately
//                        excluded: this file is plaintext on disk. Re-auth via
//                        the login flow instead of restoring these.
//   sweep_runs         — forensic audit log, not journal state. Large, and its
//                        loss costs history rather than money.
//   iv_history         — EXCLUDED BY DEFAULT BUT NOT SAFELY SO. There is no
//                        backfill: a lost row is a permanent hole in the 52-week
//                        IV range and the 25-symbol universe recalibrates from
//                        zero. Pass --with-iv to include it. The summary says so
//                        loudly on every run, because an omission that looks
//                        identical to a clean backup is how the /quotes 404 hid.
// ============================================================

import { deepStrictEqual } from 'node:assert'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sql } from '../lib/db/client'

/** Journal state proper — what a restore must reproduce exactly. */
const JOURNAL_TABLES = ['trades', 'trade_events', 'user_settings'] as const
/** Irreplaceable but bulky; opt-in via --with-iv. */
const IV_TABLE = 'iv_history'

/**
 * Deterministic ordering per table so two exports taken minutes apart diff
 * cleanly instead of shuffling. Never order by a nullable column alone.
 */
const ORDER_BY: Record<string, string> = {
  trades: 'opened_at, id',
  trade_events: 'trade_id, occurred_at, id',
  user_settings: 'id',
  iv_history: 'symbol, snapshot_date, id',
}

interface TableDump {
  table: string
  rowCount: number
  rows: unknown[]
}

async function dumpTable(table: string): Promise<TableDump> {
  // Table names are from the const lists above, never from input — no injection
  // surface, and `sql.query` is used because @vercel/postgres tagged templates
  // parameterize VALUES, not identifiers.
  const { rows } = await sql.query(
    `select to_jsonb(t) as row from ${table} t order by ${ORDER_BY[table]}`,
  )
  return { table, rowCount: rows.length, rows: rows.map((r) => r.row) }
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
}

async function main() {
  const args = process.argv.slice(2)
  const withIv = args.includes('--with-iv')
  const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'backups')

  const tables = withIv ? [...JOURNAL_TABLES, IV_TABLE] : [...JOURNAL_TABLES]

  const startedAt = new Date()
  const dumps: TableDump[] = []
  for (const table of tables) dumps.push(await dumpTable(table))

  const payload = {
    // Bump when the export SHAPE changes, not when the DB schema does.
    exportFormat: 1,
    exportedAt: startedAt.toISOString(),
    // Recorded so a restore can be matched against the code that wrote it.
    gitCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    includesIvHistory: withIv,
    tables: Object.fromEntries(dumps.map((d) => [d.table, d.rows])),
    rowCounts: Object.fromEntries(dumps.map((d) => [d.table, d.rowCount])),
  }

  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `journal-${utcStamp(startedAt)}.json`)
  const json = JSON.stringify(payload, null, 2)
  writeFileSync(file, json, 'utf8')

  // Read the file back and compare structurally. A backup that was never
  // verified is a backup you find out about during the restore — and a short
  // write or a full disk fails silently otherwise. `deepStrictEqual` rather
  // than string compare for the same reason the sweep-run round-trip test
  // uses it: JSON key order is not a fidelity property.
  const reread = JSON.parse(readFileSync(file, 'utf8'))
  deepStrictEqual(reread, JSON.parse(json))

  const bytes = statSync(file).size
  const trades = dumps.find((d) => d.table === 'trades')?.rows as
    | { status?: string }[]
    | undefined
  const open = trades?.filter((t) => t.status === 'open').length ?? 0
  const closed = trades?.filter((t) => t.status === 'closed').length ?? 0

  console.log('='.repeat(72))
  console.log(`JOURNAL EXPORT — ${startedAt.toISOString()}`)
  console.log('='.repeat(72))
  for (const d of dumps) console.log(`  ${d.table.padEnd(14)} ${String(d.rowCount).padStart(6)} row(s)`)
  console.log(`\n  trades: ${open} open · ${closed} closed`)
  console.log(`  file:   ${file}`)
  console.log(`  size:   ${(bytes / 1024).toFixed(1)} KiB`)
  console.log(`  verify: re-read and compared structurally — OK`)

  console.log('\n' + '-'.repeat(72))
  console.log('NOT INCLUDED')
  console.log('-'.repeat(72))
  if (!withIv) {
    console.log(
      '  !! iv_history — THERE IS NO BACKFILL. A lost row is a permanent hole in\n' +
        '     the 52-week IV range and the 25-symbol universe recalibrates from zero.\n' +
        '     Re-run with --with-iv to include it.',
    )
  }
  console.log('  tokens, accounts — OAuth secrets, excluded deliberately (re-auth instead).')
  console.log('  sweep_runs — forensic audit log; its loss costs history, not money.')
  console.log(
    '\n  This file contains full trading history in plaintext. `backups/` is NOT\n' +
      '  gitignored — decide whether to commit it or ignore it before the next push.',
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('export-journal failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
