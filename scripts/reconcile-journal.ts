// ============================================================
// SteelEagle — v2.8: does the journal match the account?
//
// Usage:
//   npx tsx --env-file=.env.local scripts/reconcile-journal.ts
//
// READ-ONLY. One SELECT pair (listTrades) + one Schwab GET
// (/accounts/{hash}?fields=positions). No writes, no order actions,
// no journal mutations — ever. See lib/journal/reconcile.ts for why
// this must never auto-repair.
//
// All decisions live in the pure module; this file is fetch + print.
//
// Exit code 1 when anything CRITICAL is found (DRIFT or a live PHANTOM),
// so it can be wired into a check later without reinterpreting the text.
// ============================================================

import { getAccountSnapshot } from '../lib/schwab/accounts'
import { reconstructPositions } from '../lib/strategy/reconstruct-positions'
import { listTrades } from '../lib/db/journal'
import {
  reconcileJournal,
  summarizeReconciliation,
  formatStrikes,
  type ReconcileFinding,
} from '../lib/journal/reconcile'

const MARK: Record<ReconcileFinding['severity'], string> = {
  critical: '!! CRITICAL',
  warning: ' ! WARNING ',
  info: ' · info    ',
  ok: ' ✓ ok      ',
}

async function main() {
  const now = new Date()

  // Fetch both sides BEFORE comparing. If either throws, the whole run fails
  // loudly — a partial read must never render as "no drift found", which is
  // the v2.6.1 lesson (an absent warning that looks identical to a clean bill).
  const [{ positions: raw }, trades] = await Promise.all([
    getAccountSnapshot(),
    listTrades({ status: 'open' }),
  ])
  const positions = reconstructPositions(raw, now)

  const findings = reconcileJournal(trades, positions, now)
  const s = summarizeReconciliation(findings)

  console.log(`\nJOURNAL ⇄ ACCOUNT RECONCILIATION   ${now.toISOString()}`)
  console.log(`open trades: ${trades.length}   account positions: ${positions.length}`)
  console.log('='.repeat(78))

  for (const f of findings) {
    console.log(`${MARK[f.severity]}  ${f.status.padEnd(12)} ${f.symbol} ${f.expiration}`)
    if (f.journalStrikes || f.accountStrikes) {
      console.log(
        `              journal: ${formatStrikes(f.journalStrikes).padEnd(28)}` +
          `contracts ${f.journalContracts ?? '—'}`,
      )
      console.log(
        `              account: ${formatStrikes(f.accountStrikes).padEnd(28)}` +
          `contracts ${f.accountContracts ?? '—'}`,
      )
    }
    console.log(`              ${f.detail}`)
    console.log()
  }

  console.log('='.repeat(78))
  console.log(
    `  match ${s.match} · drift ${s.drift} · phantom ${s.phantom} · ` +
      `uncomparable ${s.uncomparable} · unimported ${s.unimported}`,
  )
  if (s.critical > 0) {
    console.log(`\n  ${s.critical} CRITICAL finding(s) — resolve before the next 4:15 PM CT sweep.`)
    console.log(`  The sweep builds GTC closes from the JOURNAL, not from the account.\n`)
    process.exitCode = 1
  } else {
    console.log(`\n  No critical findings.\n`)
  }
}

main().catch((err) => {
  // Fail loud: a fetch failure must never be mistaken for a clean result.
  console.error('\nRECONCILIATION DID NOT RUN:', err instanceof Error ? err.message : err)
  console.error('This is NOT a clean bill of health — the check did not complete.\n')
  process.exit(2)
})
