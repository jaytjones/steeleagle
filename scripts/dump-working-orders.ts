// ============================================================
// SteelEagle — v2.0 one-off: dump WORKING orders as raw JSON
//
// Purpose (spec §8 open question #1): recover the CANONICAL Schwab
// order JSON for an iron condor by placing an unfillable net-credit
// condor in thinkorswim, then reading Schwab's own record of it back
// via GET /accounts/{hash}/orders. The POST payload for the v2.0
// ticket builder is derived from this output — never hand-written.
//
// Usage (locally, where .env.local has POSTGRES_URL etc.):
//   npx tsx --env-file=.env.local scripts/dump-working-orders.ts
//
// Notes:
// - Reuses the existing authenticated read path (traderGet + cached
//   account hash). No new credentials, no writes to Schwab.
// - Fetches the last 2 days with NO status filter (getFilledOrders
//   can't see this order — it filters status=FILLED).
// - Prints every non-FILLED order in the window, prettified. Redact
//   nothing before sharing EXCEPT: the account hash is not in the
//   order body, but double-check for accountNumber fields.
// ============================================================

import { traderGet } from '../lib/schwab/client'
import { getAccountHash } from '../lib/schwab/accounts'

const MS_PER_DAY = 24 * 60 * 60 * 1000

async function main() {
  const hash = await getAccountHash()

  const to = new Date()
  const from = new Date(to.getTime() - 2 * MS_PER_DAY)

  // No `status` param — we want WORKING / QUEUED / ACCEPTED, not fills.
  const orders = await traderGet<unknown[]>(`/accounts/${hash}/orders`, {
    fromEnteredTime: from.toISOString(),
    toEnteredTime: to.toISOString(),
  })

  if (!Array.isArray(orders) || orders.length === 0) {
    console.log('No orders returned in the last 2 days.')
    console.log('Is the unfillable condor still WORKING in thinkorswim?')
    return
  }

  const isRecord = (o: unknown): o is Record<string, unknown> =>
    typeof o === 'object' && o !== null

  const open = orders.filter(
    (o) => isRecord(o) && o.status !== 'FILLED' && o.status !== 'CANCELED',
  )

  const toPrint = open.length > 0 ? open : orders
  if (open.length === 0) {
    console.log(
      `No WORKING orders found — printing all ${orders.length} order(s) in the window instead:\n`,
    )
  } else {
    console.log(`${open.length} non-filled order(s) in the last 2 days:\n`)
  }

  for (const order of toPrint) {
    console.log(JSON.stringify(order, null, 2))
    console.log('\n' + '='.repeat(60) + '\n')
  }
}

main().catch((err) => {
  console.error('dump-working-orders failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
