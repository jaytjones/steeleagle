// ============================================================
// SteelEagle — v2.11 fill ledger DB access
//
// WRITE-ONLY from the cron, READ-ONLY everywhere else.
//
// NOTHING IN THE PLACEMENT PATH MAY READ EITHER TABLE. Same rule as
// sweep-runs.ts and for the same reason: reconciliation FLAGS, it does not
// BLOCK (April, 2026-08-04). schwab_fills is a heuristic's input and must never
// acquire veto power over a live GTC. If a future change wants "don't place
// because an unjournaled roll is pending", that is a decision for April, not a
// helper quietly added here.
// ============================================================

import { sql } from '@/lib/db/client'
import type { FillClassification, FillShape } from '@/lib/journal/classify-fill'
import { qtyFromJson, qtyToJson, type SymbolQty } from '@/lib/journal/position-delta'

// --------------------------------------------------------
// position_snapshots — the identity's anchor
// --------------------------------------------------------

export interface PositionSnapshotRecord {
  id: string
  takenAt: string
  symbols: SymbolQty
  symbolCount: number
}

interface PositionSnapshotRow {
  id: string
  taken_at: string
  symbols: unknown
  symbol_count: number
}

function toSnapshot(row: PositionSnapshotRow): PositionSnapshotRecord {
  return {
    id: row.id,
    takenAt: new Date(row.taken_at).toISOString(),
    symbols: qtyFromJson(row.symbols),
    symbolCount: row.symbol_count,
  }
}

/**
 * Persist one position snapshot.
 *
 * Called from the cron with the SAME raw positions the sweep already fetched —
 * this adds no Schwab call. Stores the derived occSymbol → signed-qty map
 * rather than the raw array: that map is the entire left side of the identity,
 * and an object of integers has nowhere for an account identifier to hide
 * (see the migration's note on F4).
 */
export async function recordPositionSnapshot(input: {
  takenAt: Date
  symbols: SymbolQty
}): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO position_snapshots (taken_at, symbols, symbol_count)
    VALUES (
      ${input.takenAt.toISOString()},
      ${JSON.stringify(qtyToJson(input.symbols))}::jsonb,
      ${input.symbols.size}
    )
    RETURNING id
  `
  return rows[0].id
}

/**
 * The most recent snapshot at or before `before` (default: the latest of all).
 *
 * **null means UNANCHORED, and must NEVER be flattened into an empty map.**
 * An empty map balances against empty effects and would manufacture a false
 * completeness proof — the exact failure `checkBalance` refuses to model, and
 * the same trap as `reconciliation.ran: false` not meaning "nothing found".
 * Callers must branch on null explicitly (spec §6).
 */
export async function getLatestPositionSnapshot(
  before?: Date,
): Promise<PositionSnapshotRecord | null> {
  const { rows } = before
    ? await sql<PositionSnapshotRow>`
        SELECT id, taken_at, symbols, symbol_count
        FROM position_snapshots
        WHERE taken_at <= ${before.toISOString()}
        ORDER BY taken_at DESC
        LIMIT 1
      `
    : await sql<PositionSnapshotRow>`
        SELECT id, taken_at, symbols, symbol_count
        FROM position_snapshots
        ORDER BY taken_at DESC
        LIMIT 1
      `
  return rows.length > 0 ? toSnapshot(rows[0]) : null
}

/** Recent snapshots, newest first. Forensics only. */
export async function listPositionSnapshots(limit = 20): Promise<PositionSnapshotRecord[]> {
  const { rows } = await sql.query<PositionSnapshotRow>(
    `SELECT id, taken_at, symbols, symbol_count
     FROM position_snapshots
     ORDER BY taken_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  )
  return rows.map(toSnapshot)
}

// --------------------------------------------------------
// schwab_fills — the order ledger
// --------------------------------------------------------

export const FILL_DISPOSITIONS = ['pending', 'journaled', 'dismissed'] as const
export type FillDisposition = (typeof FILL_DISPOSITIONS)[number]

export interface StoredFill {
  orderId: string
  enteredTime: string
  occurredAt: string
  status: string
  shape: FillShape
  underlying: string | null
  expiration: string | null
  contracts: number
  filled: boolean
  classification: FillClassification
  disposition: FillDisposition
  tradeId: string | null
  ingestedAt: string
  updatedAt: string
}

interface FillRow {
  order_id: string
  entered_time: string
  occurred_at: string
  status: string
  shape: FillShape
  underlying: string | null
  expiration: string | null
  contracts: number
  filled: boolean
  classification: FillClassification
  disposition: FillDisposition
  trade_id: string | null
  ingested_at: string
  updated_at: string
}

function toFill(row: FillRow): StoredFill {
  return {
    orderId: row.order_id,
    enteredTime: new Date(row.entered_time).toISOString(),
    occurredAt: new Date(row.occurred_at).toISOString(),
    status: row.status,
    shape: row.shape,
    underlying: row.underlying,
    // Already "YYYY-MM-DD" — the SELECT casts it (see FILL_COLUMNS).
    expiration: row.expiration,
    contracts: row.contracts,
    filled: row.filled,
    classification: row.classification,
    disposition: row.disposition,
    tradeId: row.trade_id,
    ingestedAt: new Date(row.ingested_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * Insert or refresh ONE fill, keyed on Schwab's order id.
 *
 * Idempotent by construction: re-ingesting the same order updates its
 * classification (a WORKING order may later read FILLED) but **never touches
 * `disposition` or `trade_id`**. Those record the operator's judgement, and a
 * routine re-fetch must not silently un-dismiss something already judged or
 * detach a fill from the trade it was journaled into.
 *
 * Returns true when the row was newly inserted. `xmax = 0` is Postgres's own
 * way of saying "this tuple was inserted, not updated" in an upsert.
 */
export async function upsertFill(c: FillClassification): Promise<boolean> {
  const { rows } = await sql<{ inserted: boolean }>`
    INSERT INTO schwab_fills (
      order_id, entered_time, occurred_at, status, shape,
      underlying, expiration, contracts, filled, classification
    )
    VALUES (
      ${c.orderId},
      ${new Date(c.enteredTime).toISOString()},
      ${c.occurredAt},
      ${c.status},
      ${c.shape},
      ${c.underlying},
      ${c.expiration},
      ${c.contracts},
      ${c.filled},
      ${JSON.stringify(c)}::jsonb
    )
    ON CONFLICT (order_id) DO UPDATE SET
      entered_time   = EXCLUDED.entered_time,
      occurred_at    = EXCLUDED.occurred_at,
      status         = EXCLUDED.status,
      shape          = EXCLUDED.shape,
      underlying     = EXCLUDED.underlying,
      expiration     = EXCLUDED.expiration,
      contracts      = EXCLUDED.contracts,
      filled         = EXCLUDED.filled,
      classification = EXCLUDED.classification,
      updated_at     = now()
    RETURNING (xmax = 0) AS inserted
  `
  return rows[0].inserted
}

export interface UpsertFillsResult {
  inserted: number
  updated: number
  /** Per-order failures. One bad order never aborts the batch. */
  failed: { orderId: string; error: string }[]
}

/**
 * Ingest a batch of classified orders.
 *
 * Per-item isolation, matching the cron's posture everywhere else: ingestion
 * must never fail a sweep, and one malformed order must not cost us the other
 * forty. Interpretation may refuse freely; ingestion may not.
 */
export async function upsertFills(
  classifications: readonly FillClassification[],
): Promise<UpsertFillsResult> {
  const result: UpsertFillsResult = { inserted: 0, updated: 0, failed: [] }

  for (const c of classifications) {
    try {
      if (await upsertFill(c)) result.inserted += 1
      else result.updated += 1
    } catch (err) {
      result.failed.push({
        orderId: c.orderId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * `expiration::text` is NOT cosmetic. node-postgres hydrates a `date` column
 * into a JS Date, which renders as "Fri Sep 11 2026 00:00:00 GMT-0500" and
 * shifts a day in any timezone west of UTC. Casting in SQL means every caller
 * gets "2026-09-11" verbatim and no JS-side coercion can reintroduce the bug.
 * Caught by the live round-trip 2026-08-14; the same trap export-journal.ts
 * avoids with `to_jsonb`.
 */
const FILL_COLUMNS = `order_id, entered_time, occurred_at, status, shape,
  underlying, expiration::text AS expiration, contracts, filled, classification,
  disposition, trade_id, ingested_at, updated_at`

/** One fill by order id, or null. */
export async function getFill(orderId: string): Promise<StoredFill | null> {
  const { rows } = await sql.query<FillRow>(
    `SELECT ${FILL_COLUMNS} FROM schwab_fills WHERE order_id = $1`,
    [orderId],
  )
  return rows.length > 0 ? toFill(rows[0]) : null
}

/**
 * The Unjournaled Activity inbox, newest first.
 *
 * Defaults to `pending` because that is the only disposition that needs the
 * operator. Pass a disposition explicitly for forensics.
 */
export async function listFills(
  opts: { disposition?: FillDisposition; limit?: number } = {},
): Promise<StoredFill[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))

  const { rows } = opts.disposition
    ? await sql.query<FillRow>(
        `SELECT ${FILL_COLUMNS} FROM schwab_fills
         WHERE disposition = $1 ORDER BY occurred_at DESC LIMIT $2`,
        [opts.disposition, limit],
      )
    : await sql.query<FillRow>(
        `SELECT ${FILL_COLUMNS} FROM schwab_fills
         ORDER BY occurred_at DESC LIMIT $1`,
        [limit],
      )
  return rows.map(toFill)
}

/** Fills whose executions fall in (from, to] — the interval a balance check covers. */
export async function listFillsInInterval(from: Date, to: Date): Promise<StoredFill[]> {
  const { rows } = await sql.query<FillRow>(
    `SELECT ${FILL_COLUMNS} FROM schwab_fills
     WHERE occurred_at > $1 AND occurred_at <= $2
     ORDER BY occurred_at ASC`,
    [from.toISOString(), to.toISOString()],
  )
  return rows.map(toFill)
}

/**
 * Record the operator's judgement on a fill.
 *
 * `tradeId` is required for 'journaled' and refused otherwise — a dismissed
 * fill pointing at a trade would claim an attribution that was never made,
 * and this column is what a future reconciliation would trust.
 */
export async function setFillDisposition(
  orderId: string,
  disposition: FillDisposition,
  tradeId: string | null = null,
): Promise<void> {
  if (disposition === 'journaled' && !tradeId) {
    throw new Error(
      `setFillDisposition(${orderId}): 'journaled' requires the trade id the fill was journaled into`,
    )
  }
  if (disposition !== 'journaled' && tradeId) {
    throw new Error(
      `setFillDisposition(${orderId}): a '${disposition}' fill must not carry a trade id`,
    )
  }

  await sql`
    UPDATE schwab_fills
    SET disposition = ${disposition}, trade_id = ${tradeId}, updated_at = now()
    WHERE order_id = ${orderId}
  `
}

/**
 * How many fills await the operator's judgement.
 *
 * A COUNT rather than `listFills().length`: the listing is capped at 200, and a
 * capped list silently under-reports the inbox depth exactly when it matters
 * most — the run where a backlog builds up.
 */
export async function countPendingFills(): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM schwab_fills WHERE disposition = 'pending'
  `
  return Number(rows[0]?.n ?? 0)
}

/** Order ids already present, so ingestion can report what is genuinely new. */
export async function existingFillIds(orderIds: readonly string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()
  const { rows } = await sql.query<{ order_id: string }>(
    // @vercel/postgres tagged templates take scalars only; an array needs the
    // positional form (CLAUDE.md).
    `SELECT order_id FROM schwab_fills WHERE order_id = ANY($1)`,
    [orderIds as string[]],
  )
  return new Set(rows.map((r) => r.order_id))
}
