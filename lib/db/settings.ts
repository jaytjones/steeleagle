// ============================================================
// SteelEagle — User Settings DB Access
// Singleton row at id = 1
// ============================================================

import { sql } from '@/lib/db/client'

export interface UserSettings {
  id: 1
  tickers: string[]
  updatedAt: string
}

interface UserSettingsRow {
  id: number
  tickers: string[]
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
    SELECT id, tickers, updated_at
    FROM user_settings
    WHERE id = 1
    LIMIT 1
  `

  if (rows.length === 0) {
    // Backfill defaults if the seed insert never ran
    const { rows: inserted } = await sql.query<UserSettingsRow>(
      `INSERT INTO user_settings (id, tickers)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET tickers = EXCLUDED.tickers
       RETURNING id, tickers, updated_at`,
      [DEFAULT_TICKERS],
    )
    return rowToSettings(inserted[0])
  }

  return rowToSettings(rows[0])
}

/**
 * Replaces the ticker list. Validation throws on bad input; callers
 * should catch and surface validation errors to the user.
 */
export async function updateUserSettings(input: {
  tickers: string[]
}): Promise<UserSettings> {
  const normalized = normalizeTickers(input.tickers)

  const { rows } = await sql.query<UserSettingsRow>(
    `UPDATE user_settings
     SET tickers = $1, updated_at = NOW()
     WHERE id = 1
     RETURNING id, tickers, updated_at`,
    [normalized],
  )

  if (rows.length === 0) {
    // Row didn't exist — insert defensively
    const { rows: inserted } = await sql.query<UserSettingsRow>(
      `INSERT INTO user_settings (id, tickers)
       VALUES (1, $1)
       RETURNING id, tickers, updated_at`,
      [normalized],
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
 */
function normalizeTickers(input: string[]): string[] {
  const seen = new Set<string>()
  const cleaned: string[] = []

  for (const raw of input) {
    const ticker = raw.trim().toUpperCase()
    if (!ticker) continue
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