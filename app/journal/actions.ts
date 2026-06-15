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
