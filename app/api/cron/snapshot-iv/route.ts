// ============================================================
// SteelEagle — Daily IV Snapshot Cron
// GET /api/cron/snapshot-iv
// Runs at 4:15 PM ET Mon–Fri via Vercel Cron.
//
// Symbol list = strategic defaults ∪ user_settings.tickers.
// The 21-instrument pillar set always snapshots so its calibration
// clock keeps running even if the dashboard isn't showing those
// cells; any custom ticker the user adds also gets snapshotted.
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db/client'
import { marketGet } from '@/lib/schwab/client'
import { getUserSettings } from '@/lib/db/settings'
import type { OptionChain } from '@/types'

// Strategic defaults — the v1.4 strategy's five-pillar instrument set.
// Always included regardless of user settings.
const DEFAULT_CRON_SYMBOLS: string[] = [
  // Equities
  'SPY', 'QQQ', 'IWM', 'DIA', 'EFA', 'EEM',
  // Fixed Income
  'TLT', 'IEF', 'HYG', 'LQD',
  // Commodities
  'GLD', 'SLV', 'USO', 'DBA',
  // Volatility
  'VXX', 'UVXY', 'SVXY',
  // Currencies
  'UUP', 'FXY', 'FXE', 'FXB',
]

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const symbols = await resolveSymbols()
  const results: Record<string, string> = {}
  const today = new Date().toISOString().split('T')[0]

  for (const symbol of symbols) {
    try {
      const chain = await marketGet<OptionChain>('/chains', {
        symbol,
        contractType: 'ALL',
        strikeCount: '1',
        includeUnderlyingQuote: 'true',
        optionType: 'S',
      })

      const underlyingPrice = chain.underlyingPrice
      let atmIv: number | null = null

      const callExpirations = Object.keys(chain.callExpDateMap)
      if (callExpirations.length > 0) {
        const strikes = Object.values(chain.callExpDateMap[callExpirations[0]])
        if (strikes.length > 0 && strikes[0].length > 0) {
          atmIv =
            strikes[0][0].volatility ??
            strikes[0][0].impliedVolatility ??
            null
        }
      }

      if (atmIv === null) {
        results[symbol] = 'skipped — no IV data'
        continue
      }

      await sql`
        INSERT INTO iv_history (symbol, snapshot_date, atm_iv, underlying_price)
        VALUES (${symbol}, ${today}, ${atmIv}, ${underlyingPrice})
        ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
          atm_iv = EXCLUDED.atm_iv,
          underlying_price = EXCLUDED.underlying_price
      `

      results[symbol] = `ok — IV: ${(atmIv * 100).toFixed(1)}%, price: ${underlyingPrice}`
    } catch (err) {
      results[symbol] = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  console.log('IV Snapshot results:', results)
  return NextResponse.json({ date: today, results })
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

/**
 * Strategic defaults ∪ user_settings.tickers, deduplicated.
 *
 * If user_settings can't be read (transient DB error), falls back to
 * defaults rather than failing the whole cron — better to snapshot
 * the strategic set than nothing for a day.
 */
async function resolveSymbols(): Promise<string[]> {
  try {
    const settings = await getUserSettings()
    return Array.from(new Set([...DEFAULT_CRON_SYMBOLS, ...settings.tickers]))
  } catch (err) {
    console.warn(
      'user_settings read failed; using default cron symbols only:',
      err instanceof Error ? err.message : String(err),
    )
    return DEFAULT_CRON_SYMBOLS
  }
}