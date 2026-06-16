// ============================================================
// SteelEagle — Import Candidates API (Session 10 — v1.5.1)
// GET /api/journal/import-candidates
//
// Orchestrates the one-time Schwab → journal bootstrap pipeline:
//   1. fetch open positions (existing accounts snapshot, self-healing hash)
//   2. parse + group into 4-leg iron-condor candidates
//   3. enrich with real fill prices / open dates from filled orders (90d)
//   4. drop condors already present in the journal
//
// The orders step degrades gracefully: a fetch failure (or genuinely empty
// history) leaves every candidate in marks-only mode and sets
// `ordersUnavailable` so the UI can warn. A positions-fetch failure is fatal
// (502) — without positions there is nothing to import.
// ============================================================

import { NextResponse } from 'next/server'
import { getAccountHash, getAccountSnapshot } from '@/lib/schwab/accounts'
import { getFilledOrders } from '@/lib/schwab/orders'
import {
  deduplicateCandidates,
  enrichWithOrderHistory,
  groupIntoCondors,
  parsePositionLegs,
} from '@/lib/journal/importer'
import { listTrades } from '@/lib/db/journal'
import type { ImportCandidatesResponse } from '@/lib/journal/types'

export async function GET() {
  // ── Positions (fatal on failure) ──────────────────────────────
  let rawPositions: unknown[]
  try {
    const snapshot = await getAccountSnapshot()
    rawPositions = snapshot.positions as unknown[]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/journal/import-candidates — positions fetch failed:', message)
    return NextResponse.json(
      { error: `Could not fetch positions from Schwab: ${message}` },
      { status: 502 },
    )
  }

  try {
    const legs = parsePositionLegs(rawPositions)
    const { candidates, incomplete } = groupIntoCondors(legs)

    // ── Order history (graceful — degrades to marks-only) ────────
    let orders: Awaited<ReturnType<typeof getFilledOrders>> = []
    try {
      const hash = await getAccountHash()
      orders = await getFilledOrders(hash, 90)
    } catch (err) {
      // getFilledOrders already swallows its own errors; this only guards a
      // hash-lookup failure. Either way → marks-only, never fatal.
      console.error(
        'import-candidates — order history unavailable:',
        err instanceof Error ? err.message : String(err),
      )
      orders = []
    }

    const enriched = enrichWithOrderHistory(candidates, orders)

    // ── Dedupe against open journal trades ───────────────────────
    const openTrades = await listTrades({ status: 'open' })
    const { fresh, alreadyImported } = deduplicateCandidates(
      enriched,
      openTrades.map((t) => ({ underlying: t.symbol, currentExpiration: t.currentExpiration })),
    )

    const body: ImportCandidatesResponse = {
      candidates: fresh,
      incomplete,
      alreadyImported,
      // No order history means every candidate fell back to position averages.
      ordersUnavailable: orders.length === 0 && (fresh.length > 0 || alreadyImported.length > 0),
    }
    return NextResponse.json(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/journal/import-candidates error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
