// ============================================================
// SteelEagle — User Settings DB Access
// Singleton row at id = 1
// ============================================================

import { sql } from '@/lib/db/client'

export interface UserSettings {
  id: 1
  tickers: string[]
  /** When true, the post-close exit sweep skips GTC placement (step c) only.
   *  Reconcile + 21-DTE alerts always run; standing GTCs are untouched. */
  pauseExitPlacement: boolean
  updatedAt: string
}

interface UserSettingsRow {
  id: number
  tickers: string[]
  pause_exit_placement: boolean
  updated_at: string
}

const DEFAULT_TICKERS = ['SPY', 'TLT', 'GLD']
const MAX_TICKERS = 10
const MAX_TICKER_LENGTH = 5

/**
 * Fetches the singleton user settings row. If the row is missing (e.g.
 * the seed insert never ran), this backfills it with defaults — making
 * the function safe to call before any user mutation has occurred.
 */
export async function getUserSettings(): Promise<UserSettings> {
  const { rows } = await sql<UserSettingsRow>`
    SELECT id, tickers, pause_exit_placement, updated_at
    FROM user_settings
    WHERE id = 1
    LIMIT 1
  `

  if (rows.length === 0) {
    // Backfill defaults if the seed insert never ran. pause_exit_placement
    // inherits its column DEFAULT (false) — fail-safe: not paused.
    const { rows: inserted } = await sql.query<UserSettingsRow>(
      `INSERT INTO user_settings (id, tickers)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET tickers = EXCLUDED.tickers
       RETURNING id, tickers, pause_exit_placement, updated_at`,
      [DEFAULT_TICKERS],
    )
    return rowToSettings(inserted[0])
  }

  return rowToSettings(rows[0])
}

/**
 * Partial settings update — pass only the fields being changed.
 * Absent fields are preserved via COALESCE(NULL, current). Validation
 * throws on bad input; callers should catch and surface to the user.
 */
export async function updateUserSettings(input: {
  tickers?: string[]
  pauseExitPlacement?: boolean
}): Promise<UserSettings> {
  const normalized =
    input.tickers !== undefined ? normalizeTickers(input.tickers) : null
  const paused =
    input.pauseExitPlacement !== undefined ? input.pauseExitPlacement : null

  if (normalized === null && paused === null) {
    throw new Error('updateUserSettings called with no fields to update')
  }

  const { rows } = await sql.query<UserSettingsRow>(
    `UPDATE user_settings
     SET tickers = COALESCE($1::text[], tickers),
         pause_exit_placement = COALESCE($2::boolean, pause_exit_placement),
         updated_at = NOW()
     WHERE id = 1
     RETURNING id, tickers, pause_exit_placement, updated_at`,
    [normalized, paused],
  )

  if (rows.length === 0) {
    // Row didn't exist — insert defensively (absent fields → column defaults)
    const { rows: inserted } = await sql.query<UserSettingsRow>(
      `INSERT INTO user_settings (id, tickers, pause_exit_placement)
       VALUES (1, COALESCE($1::text[], '{SPY,TLT,GLD}'), COALESCE($2::boolean, false))
       RETURNING id, tickers, pause_exit_placement, updated_at`,
      [normalized, paused],
    )
    return rowToSettings(inserted[0])
  }

  return rowToSettings(rows[0])
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function rowToSettings(row: UserSettingsRow): UserSettings {
  return {
    id: 1,
    tickers: row.tickers,
    pauseExitPlacement: row.pause_exit_placement,
    updatedAt: row.updated_at,
  }
}

/**
 * Normalizes a ticker list: uppercase, trim, dedupe, validate.
 *
 * Note: this validates *format* only — whether Schwab actually has an
 * options chain for the symbol is determined downstream in the scanner.
 * That's intentional per PRD 11.3 — invalid-symbol cells are saved
 * anyway so the user can edit to fix the typo without re-entering.
 *
 * v2.4 §5.6 (DECIDED, spec §0a.3): a `$`-prefixed index symbol is REJECTED
 * with an explanatory message rather than silently normalized. The app is
 * canonical-symbol-only end to end — `$` is added at the Schwab fetch boundary
 * — and silently stripping it would teach the operator that both forms are
 * equivalent, which they are not (`iv_history` keys on the canonical form, so a
 * `$SPX` row would calibrate a second, permanently-empty history).
 */
export function normalizeTickers(input: string[]): string[] {
  const seen = new Set<string>()
  const cleaned: string[] = []

  for (const raw of input) {
    const ticker = raw.trim().toUpperCase()
    if (!ticker) continue
    if (ticker.startsWith('$')) {
      throw new Error(
        `Invalid ticker "${ticker}" — use ${ticker.slice(1) || 'SPX'}, not ${ticker}; ` +
          `the $ is added internally for index market data`,
      )
    }
    if (ticker.length > MAX_TICKER_LENGTH) {
      throw new Error(
        `Invalid ticker "${ticker}" — exceeds ${MAX_TICKER_LENGTH} characters`,
      )
    }
    if (!/^[A-Z]+$/.test(ticker)) {
      throw new Error(`Invalid ticker "${ticker}" — non-alphabetic characters`)
    }
    if (seen.has(ticker)) continue
    seen.add(ticker)
    cleaned.push(ticker)
  }


  if (cleaned.length > MAX_TICKERS) {
    throw new Error(`Maximum ${MAX_TICKERS} tickers allowed`)
  }

  return cleaned
}