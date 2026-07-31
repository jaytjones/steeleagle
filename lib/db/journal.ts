// ============================================================
// SteelEagle — Trade Journal DB Access
//
// Two tables, one logical model: `trades` is the lifecycle row,
// `trade_events` the append-only leg log. Create/roll/close all run in
// a transaction so a trade and its legs never desync. Credit/debit
// running totals are derived from the legs here — never trusted from the
// client. See docs/steeleagle-session-8-addendum.md §A2.
// ============================================================

import { db } from '@vercel/postgres'
import type { VercelPoolClient } from '@vercel/postgres'
import { sql } from '@/lib/db/client'
import { deriveTotals, legAmount, tally } from '@/lib/journal/trade-math'
import { planCloseEdit } from '@/lib/journal/edit-close'
import type {
  CloseTradeInput,
  EditClosedTradeInput,
  NewTradeInput,
  RollTradeInput,
  Trade,
  TradeEvent,
} from '@/lib/journal/types'

// Postgres returns numeric/timestamptz as strings via node-postgres; coerce
// explicitly so the API contract is real numbers and ISO strings.
interface TradeRow {
  id: string
  symbol: string
  sleeve: string
  status: string
  opened_at: string | Date
  closed_at: string | Date | null
  initial_expiration: string
  current_expiration: string
  initial_credit: string
  total_credit_collected: string
  total_debit_paid: string
  initial_bpr: string
  contracts: number
  close_reason: string | null
  exit_order_id: string | null
  notes: string | null
  created_at: string | Date
  updated_at: string | Date
}

interface TradeEventRow {
  id: string
  trade_id: string
  event_type: string
  leg: string
  strike: string
  expiration: string
  delta: string | null
  contracts: number
  price: string
  credit_debit: string
  amount: string
  source: string
  schwab_order_id: string | null
  occurred_at: string | Date
  notes: string | null
  created_at: string | Date
}

// --------------------------------------------------------
// Reads
// --------------------------------------------------------

/**
 * Lists trades (newest first) with their event logs attached. Two queries
 * (trades, then all their events) grouped in memory — fine for a single-user,
 * low-volume journal and avoids an N+1.
 */
export async function listTrades(opts?: {
  status?: 'open' | 'closed'
}): Promise<Trade[]> {
  const { rows: tradeRows } = opts?.status
    ? await sql.query<TradeRow>(`${TRADE_SELECT} WHERE status = $1 ${TRADE_ORDER}`, [
        opts.status,
      ])
    : await sql.query<TradeRow>(`${TRADE_SELECT} ${TRADE_ORDER}`)

  if (tradeRows.length === 0) return []

  const ids = tradeRows.map((t) => t.id)
  const { rows: eventRows } = await sql.query<TradeEventRow>(
    `${EVENT_SELECT} WHERE trade_id = ANY($1) ORDER BY occurred_at ASC, created_at ASC`,
    [ids],
  )

  const eventsByTrade = new Map<string, TradeEvent[]>()
  for (const row of eventRows) {
    const list = eventsByTrade.get(row.trade_id) ?? []
    list.push(rowToEvent(row))
    eventsByTrade.set(row.trade_id, list)
  }

  return tradeRows.map((t) => rowToTrade(t, eventsByTrade.get(t.id) ?? []))
}

/** A single trade with its events, or null if not found. */
export async function getTrade(id: string): Promise<Trade | null> {
  const { rows } = await sql.query<TradeRow>(`${TRADE_SELECT} WHERE id = $1`, [id])
  if (rows.length === 0) return null
  const { rows: eventRows } = await sql.query<TradeEventRow>(
    `${EVENT_SELECT} WHERE trade_id = $1 ORDER BY occurred_at ASC, created_at ASC`,
    [id],
  )
  return rowToTrade(rows[0], eventRows.map(rowToEvent))
}

// --------------------------------------------------------
// Writes (all transactional)
// --------------------------------------------------------

/**
 * Creates a logical trade plus its four `open` legs in one transaction.
 * Trade-level totals are derived from the legs: initial_credit = net of the
 * four opens, total_credit_collected / total_debit_paid = the gross sides.
 */
export async function createTrade(input: NewTradeInput): Promise<Trade> {
  const { credit, debit } = tally(input.legs, input.contracts)
  const net = Math.round((credit - debit) * 100) / 100

  return withTransaction(async (client) => {
    const { rows } = await client.query<TradeRow>(
      `INSERT INTO trades
         (symbol, sleeve, status, opened_at, initial_expiration, current_expiration,
          initial_credit, total_credit_collected, total_debit_paid, initial_bpr, contracts, notes)
       VALUES ($1, $2, 'open', $3, $4, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.symbol,
        input.sleeve,
        input.openedAt,
        input.initialExpiration,
        net,
        credit,
        debit,
        input.initialBpr,
        input.contracts,
        input.notes ?? null,
      ],
    )
    const trade = rows[0]

    for (const leg of input.legs) {
      await insertEvent(client, trade.id, {
        eventType: 'open',
        leg: leg.leg,
        strike: leg.strike,
        expiration: leg.expiration,
        delta: leg.delta,
        contracts: input.contracts,
        price: leg.price,
        creditDebit: leg.creditDebit,
        occurredAt: input.openedAt,
        notes: leg.notes ?? null,
        // Provenance — manual form leaves these at their schema defaults; the
        // Schwab importer threads 'schwab_fill' + the originating order id.
        source: input.source,
        schwabOrderId: input.schwabOrderId,
      })
    }

    return loadTrade(client, trade.id)
  })
}

/**
 * Records a roll: appends the roll_close / roll_open legs and patches the
 * trade's running totals + current_expiration. No new trade row — a roll
 * mutates the existing one (addendum §A2 core principle).
 *
 * v2.2 (§5.3): a roll NULLS exit_order_id — any standing GTC targets the
 * pre-roll credit and structure, so the association is severed here. The
 * PRIOR id is returned so the caller can surface "cancel GTC [id] in TOS"
 * BEFORE nulling makes it invisible. Nulling cancels nothing at Schwab
 * (§6.4); the warning is mandatory wherever this result is consumed.
 *
 * v2.3 (corrected here in v2.3.1): rolled trades are NO LONGER blanket
 * placement-ineligible. Eligibility is `isPriceableStructure` over the
 * post-roll event log, so a same-expiration roll gets a fresh 50% GTC on the
 * next sweep; only a diagonal (or a leg left unreopened) keeps the MANUAL GTC
 * flag. Nulling the column is therefore what ARMS the re-place, not what
 * suppresses it.
 */
export async function rollTrade(
  tradeId: string,
  input: RollTradeInput,
): Promise<{ trade: Trade; priorExitOrderId: string | null }> {
  return withTransaction(async (client) => {
    const existing = await requireOpenTrade(client, tradeId)
    const priorExitOrderId = existing.exit_order_id
    const { credit, debit } = tally(input.events, existing.contracts)

    for (const leg of input.events) {
      await insertEvent(client, tradeId, {
        eventType: leg.eventType,
        leg: leg.leg,
        strike: leg.strike,
        expiration: leg.expiration,
        delta: leg.delta,
        contracts: existing.contracts,
        price: leg.price,
        creditDebit: leg.creditDebit,
        occurredAt: input.occurredAt,
        notes: leg.notes ?? null,
      })
    }

    await client.query(
      `UPDATE trades SET
         total_credit_collected = total_credit_collected + $2,
         total_debit_paid       = total_debit_paid + $3,
         current_expiration     = COALESCE($4, current_expiration),
         notes                  = COALESCE($5, notes),
         exit_order_id          = NULL,
         updated_at             = now()
       WHERE id = $1`,
      [tradeId, credit, debit, input.newExpiration, input.notes ?? null],
    )

    return { trade: await loadTrade(client, tradeId), priorExitOrderId }
  })
}

/**
 * Closes a trade: appends the `close` legs (zero legs allowed for an
 * expired-worthless exit), folds their debits/credits into the totals, and
 * stamps status/closed_at/close_reason.
 *
 * v2.2: EVERY close path clears exit_order_id (a closed trade has no
 * standing exit by definition — but nulling the column cancels nothing at
 * Schwab; see §6.4). Optional `provenance` threads source/order-id onto the
 * close events — the sweep's reconcile passes 'schwab_fill' + the GTC id;
 * the manual Close form omits it (defaults to 'manual').
 */
export async function closeTrade(
  tradeId: string,
  input: CloseTradeInput,
  provenance?: { source?: TradeEvent['source']; schwabOrderId?: string | null },
): Promise<Trade> {
  return withTransaction(async (client) => {
    const existing = await requireOpenTrade(client, tradeId)
    const { credit, debit } = tally(input.events, existing.contracts)

    for (const leg of input.events) {
      await insertEvent(client, tradeId, {
        eventType: 'close',
        leg: leg.leg,
        strike: leg.strike,
        expiration: leg.expiration,
        delta: leg.delta,
        contracts: existing.contracts,
        price: leg.price,
        creditDebit: leg.creditDebit,
        occurredAt: input.occurredAt,
        notes: leg.notes ?? null,
        source: provenance?.source,
        schwabOrderId: provenance?.schwabOrderId,
      })
    }

    await client.query(
      `UPDATE trades SET
         status                 = 'closed',
         closed_at              = $2,
         close_reason           = $3,
         total_credit_collected = total_credit_collected + $4,
         total_debit_paid       = total_debit_paid + $5,
         notes                  = COALESCE($6, notes),
         exit_order_id          = NULL,
         updated_at             = now()
       WHERE id = $1`,
      [tradeId, input.occurredAt, input.closeReason, credit, debit, input.notes ?? null],
    )

    return loadTrade(client, tradeId)
  })
}

/**
 * v2.2.1 — repairs a mis-keyed close on an ALREADY-CLOSED trade.
 *
 * The Session 15 SQL repair, as code. Two rules carried over verbatim:
 *   1. Every UPDATE is guarded on the exact event id AND its eligibility
 *      (close leg, manual source, this trade) — a guard that fails refuses
 *      the whole edit rather than leaving a half-applied repair.
 *   2. Totals are RE-DERIVED from the full post-edit event log, never
 *      patched incrementally, so they cannot drift from the legs.
 *
 * What may be touched is decided by planCloseEdit (pure, tested); this
 * function only executes the plan. Entry/roll legs, Schwab-filled legs and
 * all structural fields are unreachable from here by construction.
 */
export async function editClosedTrade(
  tradeId: string,
  input: EditClosedTradeInput,
): Promise<Trade> {
  return withTransaction(async (client) => {
    await requireClosedTrade(client, tradeId)

    const { rows: beforeRows } = await client.query<TradeEventRow>(
      `${EVENT_SELECT} WHERE trade_id = $1 ORDER BY occurred_at ASC, created_at ASC`,
      [tradeId],
    )
    const updates = planCloseEdit(beforeRows.map(rowToEvent), input.events)

    for (const u of updates) {
      const { rowCount } = await client.query(
        `UPDATE trade_events
            SET price = $3, amount = $4, credit_debit = $5, occurred_at = $6
          WHERE id = $1 AND trade_id = $2 AND event_type = 'close' AND source = 'manual'`,
        [u.id, tradeId, u.price, u.amount, u.creditDebit, u.occurredAt],
      )
      if (rowCount !== 1) {
        throw new Error(
          `editClosedTrade: event ${u.id} was not updated (${rowCount} rows) — the edit is ` +
            `rolled back and the trade is unchanged`,
        )
      }
    }

    const { rows: afterRows } = await client.query<TradeEventRow>(
      `${EVENT_SELECT} WHERE trade_id = $1`,
      [tradeId],
    )
    const { credit, debit } = deriveTotals(afterRows.map(rowToEvent))

    const { rowCount } = await client.query(
      `UPDATE trades SET
         closed_at              = $2,
         close_reason           = $3,
         notes                  = $4,
         total_credit_collected = $5,
         total_debit_paid       = $6,
         updated_at             = now()
       WHERE id = $1 AND status = 'closed'`,
      [tradeId, input.closedAt, input.closeReason, input.notes, credit, debit],
    )
    if (rowCount !== 1) {
      throw new Error(`editClosedTrade: closed trade ${tradeId} not updated — edit rolled back`)
    }

    return loadTrade(client, tradeId)
  })
}

// --------------------------------------------------------
// v2.2 — standing-exit association (spec §3, §4.3)
// --------------------------------------------------------

/**
 * Associates a placed GTC exit with its trade. Guards: the trade must be
 * open and must not already carry an id — the sweep only places on NULL,
 * so a conflict here means a race or double-placement and must surface
 * loudly, never overwrite silently.
 */
export async function setExitOrderId(tradeId: string, orderId: string): Promise<void> {
  const { rowCount } = await sql.query(
    `UPDATE trades SET exit_order_id = $2, updated_at = now()
     WHERE id = $1 AND status = 'open' AND exit_order_id IS NULL`,
    [tradeId, orderId],
  )
  if (rowCount !== 1) {
    throw new Error(
      `setExitOrderId: trade ${tradeId} not updated (not found, closed, or already has a ` +
        `standing exit) — order ${orderId} is LIVE at Schwab but unrecorded. CHECK THINKORSWIM.`,
    )
  }
}

/**
 * Clears the standing-exit association WITHOUT closing the trade — the
 * reconcile's terminal-order path (Schwab reported the order dead; next
 * sweep re-places). Nulling here cancels nothing at Schwab (§6.4);
 * callers on any other path must surface the id + "cancel in TOS".
 */
export async function clearExitOrderId(tradeId: string): Promise<void> {
  const { rowCount } = await sql.query(
    `UPDATE trades SET exit_order_id = NULL, updated_at = now()
     WHERE id = $1 AND status = 'open'`,
    [tradeId],
  )
  if (rowCount !== 1) {
    throw new Error(`clearExitOrderId: open trade ${tradeId} not found`)
  }
}

// --------------------------------------------------------
// Internals
// --------------------------------------------------------

const TRADE_SELECT = `
  SELECT
    id, symbol, sleeve, status,
    opened_at, closed_at,
    to_char(initial_expiration, 'YYYY-MM-DD') AS initial_expiration,
    to_char(current_expiration, 'YYYY-MM-DD') AS current_expiration,
    initial_credit, total_credit_collected, total_debit_paid, initial_bpr,
    contracts, close_reason, exit_order_id, notes, created_at, updated_at
  FROM trades
`
const TRADE_ORDER = 'ORDER BY opened_at DESC, created_at DESC'

const EVENT_SELECT = `
  SELECT
    id, trade_id, event_type, leg, strike,
    to_char(expiration, 'YYYY-MM-DD') AS expiration,
    delta, contracts, price, credit_debit, amount, source, schwab_order_id,
    occurred_at, notes, created_at
  FROM trade_events
`

interface LegWrite {
  eventType: TradeEvent['eventType']
  leg: TradeEvent['leg']
  strike: number
  expiration: string
  delta: number | null
  contracts: number
  price: number
  creditDebit: TradeEvent['creditDebit']
  occurredAt: string
  notes: string | null
  /** Defaults to 'manual' when omitted (roll/close paths). */
  source?: TradeEvent['source']
  /** Defaults to null when omitted. */
  schwabOrderId?: string | null
}

async function insertEvent(client: VercelPoolClient, tradeId: string, leg: LegWrite): Promise<void> {
  await client.query(
    `INSERT INTO trade_events
       (trade_id, event_type, leg, strike, expiration, delta, contracts, price,
        credit_debit, amount, source, schwab_order_id, occurred_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      tradeId,
      leg.eventType,
      leg.leg,
      leg.strike,
      leg.expiration,
      leg.delta,
      leg.contracts,
      leg.price,
      leg.creditDebit,
      legAmount(leg.price, leg.contracts),
      leg.source ?? 'manual',
      leg.schwabOrderId ?? null,
      leg.occurredAt,
      leg.notes,
    ],
  )
}

/** Loads a freshly-mutated trade inside the same transaction. */
async function loadTrade(client: VercelPoolClient, id: string): Promise<Trade> {
  const { rows } = await client.query<TradeRow>(`${TRADE_SELECT} WHERE id = $1`, [id])
  const { rows: eventRows } = await client.query<TradeEventRow>(
    `${EVENT_SELECT} WHERE trade_id = $1 ORDER BY occurred_at ASC, created_at ASC`,
    [id],
  )
  return rowToTrade(rows[0], eventRows.map(rowToEvent))
}

async function requireOpenTrade(client: VercelPoolClient, id: string): Promise<TradeRow> {
  const { rows } = await client.query<TradeRow>(`${TRADE_SELECT} WHERE id = $1 FOR UPDATE`, [id])
  if (rows.length === 0) throw new Error(`Trade ${id} not found`)
  if (rows[0].status === 'closed') throw new Error('Trade is already closed')
  return rows[0]
}

/** v2.2.1 — the edit path's mirror of requireOpenTrade: repairs are for closed trades only. */
async function requireClosedTrade(client: VercelPoolClient, id: string): Promise<TradeRow> {
  const { rows } = await client.query<TradeRow>(`${TRADE_SELECT} WHERE id = $1 FOR UPDATE`, [id])
  if (rows.length === 0) throw new Error(`Trade ${id} not found`)
  if (rows[0].status !== 'closed') {
    throw new Error('Only a closed trade can be edited — close the trade first')
  }
  return rows[0]
}

async function withTransaction<T>(fn: (client: VercelPoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// --------------------------------------------------------
// Row → model mappers
// --------------------------------------------------------

function rowToTrade(row: TradeRow, events: TradeEvent[]): Trade {
  return {
    id: row.id,
    symbol: row.symbol,
    sleeve: row.sleeve as Trade['sleeve'],
    status: row.status as Trade['status'],
    openedAt: toIso(row.opened_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
    initialExpiration: row.initial_expiration,
    currentExpiration: row.current_expiration,
    initialCredit: Number(row.initial_credit),
    totalCreditCollected: Number(row.total_credit_collected),
    totalDebitPaid: Number(row.total_debit_paid),
    initialBpr: Number(row.initial_bpr),
    contracts: row.contracts,
    closeReason: (row.close_reason as Trade['closeReason']) ?? null,
    exitOrderId: row.exit_order_id,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    events,
  }
}

function rowToEvent(row: TradeEventRow): TradeEvent {
  return {
    id: row.id,
    tradeId: row.trade_id,
    eventType: row.event_type as TradeEvent['eventType'],
    leg: row.leg as TradeEvent['leg'],
    strike: Number(row.strike),
    expiration: row.expiration,
    delta: row.delta === null ? null : Number(row.delta),
    contracts: row.contracts,
    price: Number(row.price),
    creditDebit: row.credit_debit as TradeEvent['creditDebit'],
    amount: Number(row.amount),
    source: row.source as TradeEvent['source'],
    schwabOrderId: row.schwab_order_id,
    occurredAt: toIso(row.occurred_at),
    notes: row.notes,
    createdAt: toIso(row.created_at),
  }
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}
