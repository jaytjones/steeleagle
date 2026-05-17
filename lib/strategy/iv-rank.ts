// ============================================================
// SteelEagle — IV Rank Calculator
// Computes IV Rank from rolling historical window in Neon DB
// Formula: (currentIV - 52w_low) / (52w_high - 52w_low) * 100
// Minimum 20 days of history required before rank is meaningful
// ============================================================

import { sql } from '@/lib/db/client'
import type { Pillar, IVRankResult } from '@/types'

const MIN_DAYS_REQUIRED = 20    // show "calibrating" below this
const IV_RANK_THRESHOLD = 25    // strategy filter: IV Rank must be > 25%

export async function calculateIVRank(
  symbol: Pillar,
  currentIv: number
): Promise<IVRankResult> {
  const { rows } = await sql`
    SELECT atm_iv
    FROM iv_history
    WHERE symbol = ${symbol}
      AND snapshot_date >= CURRENT_DATE - INTERVAL '365 days'
    ORDER BY snapshot_date ASC
  `

  const daysOfHistory = rows.length

  // Not enough history yet — return calibrating state
  if (daysOfHistory < MIN_DAYS_REQUIRED) {
    return {
      symbol,
      currentIv,
      ivRank: 0,
      daysOfHistory,
      passes: false,
    }
  }

  const ivValues = rows.map(r => parseFloat(r.atm_iv))
  const low52w = Math.min(...ivValues)
  const high52w = Math.max(...ivValues)

  // Avoid division by zero if all IVs are identical
  const ivRank =
    high52w === low52w
      ? 0
      : ((currentIv - low52w) / (high52w - low52w)) * 100

  return {
    symbol,
    currentIv,
    ivRank: Math.round(ivRank * 10) / 10,   // one decimal place
    daysOfHistory,
    passes: ivRank >= IV_RANK_THRESHOLD,
  }
}
