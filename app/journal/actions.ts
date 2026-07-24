// ============================================================
// SteelEagle — Trade Journal Server Actions
// Create / roll / close mutations invoked from the journal UI.
// Each validates with zod, mutates transactionally, then returns the
// refreshed trade list so the client can sync without a round-trip.
// ============================================================

'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  closeTrade as dbCloseTrade,
  createTrade as dbCreateTrade,
  listTrades,
  rollTrade as dbRollTrade,
} from '@/lib/db/journal'
import {
  CloseTradeSchema,
  NewTradeSchema,
  RollTradeSchema,
  type ImportCandidate,
  type ImportLeg,
  type ImportResult,
  type Leg,
  type NewTradeInput,
  type Trade,
} from '@/lib/journal/types'

/** Flattens a ZodError into a single human-readable message. */
function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid trade entry — ${msg}`)
  }
  return result.data
}

export async function createTradeAction(raw: unknown): Promise<Trade[]> {
  const input = parseOrThrow(NewTradeSchema, raw)
  await dbCreateTrade(input)
  revalidatePath('/journal')
  return listTrades()
}

export async function rollTradeAction(tradeId: string, raw: unknown): Promise<Trade[]> {
  if (!tradeId) throw new Error('Missing trade id')
  const input = parseOrThrow(RollTradeSchema, raw)
  await dbRollTrade(tradeId, input)
  revalidatePath('/journal')
  return listTrades()
}

export async function closeTradeAction(tradeId: string, raw: unknown): Promise<Trade[]> {
  if (!tradeId) throw new Error('Missing trade id')
  const input = parseOrThrow(CloseTradeSchema, raw)
  await dbCloseTrade(tradeId, input)
  revalidatePath('/journal')
  return listTrades()
}

// --------------------------------------------------------
// Schwab importer (Session 10) — bulk-create confirmed candidates.
// --------------------------------------------------------

/** Map an ImportLeg's BUY/SELL action to the journal's credit/debit convention. */
function legDirection(leg: ImportLeg): 'credit' | 'debit' {
  // Selling an option collects premium (credit); buying pays it (debit).
  return leg.action === 'SELL' ? 'credit' : 'debit'
}

/** Build a validated NewTradeInput from one confirmed import candidate. */
function candidateToNewTrade(c: ImportCandidate): NewTradeInput {
  // marks-only candidates have no order open date; the review card requires the
  // operator to set one, but fall back to today as a final guard (spec §5.4).
  const openYmd = c.openDate ?? new Date().toISOString().slice(0, 10)
  const openedAt = new Date(`${openYmd}T00:00:00.000Z`).toISOString()

  // Matched candidates carry real Schwab fills → tag the provenance as a Schwab
  // fill and thread the order id; marks-only stays 'manual' (decision: reuse the
  // existing 'schwab_fill' source value, no migration).
  const source = c.confidence === 'matched' ? 'schwab_fill' : 'manual'
  const schwabOrderId = c.schwabOrderId !== null ? String(c.schwabOrderId) : null

  const toLeg = (name: Leg, leg: ImportLeg) => ({
    leg: name,
    strike: leg.strike,
    expiration: c.expiration,
    delta: null,
    price: leg.price,
    creditDebit: legDirection(leg),
  })

  const raw = {
    symbol: c.underlying,
    sleeve: 'core', // earnings sleeve removed (v2.1.1); all imports are core
    openedAt,
    initialExpiration: c.expiration,
    contracts: c.contracts,
    initialBpr: c.initialBpr,
    source,
    schwabOrderId,
    legs: [
      toLeg('long_put', c.longPut),
      toLeg('short_put', c.shortPut),
      toLeg('short_call', c.shortCall),
      toLeg('long_call', c.longCall),
    ],
  }

  return parseOrThrow(NewTradeSchema, raw)
}

/**
 * Bulk-import confirmed candidates into the journal. Each candidate maps to
 * exactly one createTrade() call, run sequentially (not parallel) to avoid
 * transaction contention on the Neon WebSocket pool.
 *
 * Each createTrade is its own transaction, so a mid-batch failure leaves the
 * earlier imports committed — we report partial success rather than rolling
 * back (spec §7). Returns the refreshed trade list plus the failure detail.
 */
export async function importTradesAction(candidates: ImportCandidate[]): Promise<ImportResult> {
  const failed: ImportResult['failed'] = []
  let importedCount = 0

  for (const candidate of candidates) {
    try {
      await dbCreateTrade(candidateToNewTrade(candidate))
      importedCount++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`importTradesAction — failed to import ${candidate.candidateId}:`, message)
      failed.push({ candidateId: candidate.candidateId, error: message })
    }
  }

  revalidatePath('/journal')
  const trades = await listTrades()
  return { trades, importedCount, failed }
}
