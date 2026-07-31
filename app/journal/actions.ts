// ============================================================
// SteelEagle — Trade Journal Server Actions
// Create / roll / close mutations invoked from the journal UI.
// Each validates with zod, mutates transactionally, then returns the
// refreshed trade list so the client can sync without a round-trip.
// ============================================================

'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { toResult, type ActionResult } from '@/lib/action-result'
import { structureRefusal } from '@/lib/journal/current-structure'
import {
  closeTrade as dbCloseTrade,
  createTrade as dbCreateTrade,
  editClosedTrade as dbEditClosedTrade,
  listTrades,
  rollTrade as dbRollTrade,
} from '@/lib/db/journal'
import {
  CloseTradeSchema,
  EditClosedTradeSchema,
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
function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, label = 'Invalid trade entry'): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ')
    throw new Error(`${label} — ${msg}`)
  }
  return result.data
}

/**
 * v2.3.2 — returns ActionResult (was: threw), completing the conversion of
 * every journal write path. The hardened NewTradeSchema refuses a blank price,
 * strike, BPR or contract count, and those refusals name the offending field —
 * useless to April if Next.js redacts them to a digest in production.
 */
export async function createTradeAction(raw: unknown): Promise<ActionResult<Trade[]>> {
  return toResult('journal-actions.createTrade', async () => {
    const input = parseOrThrow(NewTradeSchema, raw, 'Entry refused')
    await dbCreateTrade(input)
    revalidatePath('/journal')
    return listTrades()
  })
}

/**
 * v2.2 (§5.3): the DB roll nulls the trade's exit_order_id, so the PRIOR id
 * is surfaced here — the only moment it's still visible. Nulling cancels
 * nothing at Schwab; the warning tells the operator to cancel in TOS.
 */
export interface RollActionResult {
  trades: Trade[]
  exitOrderWarning: string | null
}

/**
 * v2.3.1 — returns ActionResult (was: threw) and states what v2.3 actually
 * does with the rolled trade.
 *
 * The old warning said "auto-placement is excluded for rolled trades" — true
 * under v2.2's blunt `hasRollEvents` gate, FALSE since v2.3 replaced it with
 * `isPriceableStructure`. A same-expiration roll is priceable, so the sweep
 * re-places a fresh 50% GTC on its next run; only a diagonal keeps the MANUAL
 * GTC chip. The warning now asks the post-roll event log which case this is
 * rather than asserting the stale one. `structureRefusal` never throws.
 *
 * The refusal messages this action can produce (blank price, unmatched
 * roll_open) are operator-critical, and a THROWN server-action message reaches
 * production as a redacted digest — so they travel as data, exactly as
 * closeTradeAction does.
 */
export async function rollTradeAction(
  tradeId: string,
  raw: unknown,
): Promise<ActionResult<RollActionResult>> {
  return toResult('journal-actions.rollTrade', async () => {
    if (!tradeId) throw new Error('Missing trade id')
    const input = parseOrThrow(RollTradeSchema, raw, 'Roll refused')
    const { trade, priorExitOrderId } = await dbRollTrade(tradeId, input)
    revalidatePath('/journal')

    let exitOrderWarning: string | null = null
    if (priorExitOrderId) {
      const refusal = structureRefusal(trade.symbol, trade.events)
      exitOrderWarning =
        `Standing GTC ${priorExitOrderId} targets the PRE-ROLL credit — cancel it in ` +
        `thinkorswim (rolling severed the record here, it did NOT cancel the order). ` +
        (refusal === null
          ? `The next sweep will place a fresh 50% GTC against the new structure.`
          : `The sweep cannot price the new structure (${refusal}) — place the new 50% GTC manually.`)
    }

    return { trades: await listTrades(), exitOrderWarning }
  })
}

/**
 * v2.2.1 — returns ActionResult instead of throwing.
 *
 * The hardened CloseTradeSchema refuses a blank-priced or partial-leg close,
 * but a THROWN refusal reaches production as a redacted digest — April would
 * see "an error occurred" with no idea which leg was blank. The reason has to
 * travel as data. (rollTradeAction followed in v2.3.1, createTradeAction in
 * v2.3.2 — every journal write path now returns ActionResult.)
 */
export async function closeTradeAction(
  tradeId: string,
  raw: unknown,
): Promise<ActionResult<Trade[]>> {
  return toResult('journal-actions.closeTrade', async () => {
    if (!tradeId) throw new Error('Missing trade id')
    const input = parseOrThrow(CloseTradeSchema, raw, 'Close refused')
    await dbCloseTrade(tradeId, input)
    revalidatePath('/journal')
    return listTrades()
  })
}

/**
 * v2.2.1 — repairs a mis-keyed close on an already-closed trade, replacing the
 * hand-written SQL the SPY 8/14 repair needed (Session 15 §1).
 *
 * Scope is enforced twice: EditClosedTradeSchema on shape, planCloseEdit on
 * eligibility (close legs only, manual source only, structure immutable). The
 * whole edit is one transaction — a single ineligible id rolls back the rest.
 */
export async function editClosedTradeAction(
  tradeId: string,
  raw: unknown,
): Promise<ActionResult<Trade[]>> {
  return toResult('journal-actions.editClosedTrade', async () => {
    if (!tradeId) throw new Error('Missing trade id')
    const input = parseOrThrow(EditClosedTradeSchema, raw, 'Edit refused')
    await dbEditClosedTrade(tradeId, input)
    revalidatePath('/journal')
    return listTrades()
  })
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
