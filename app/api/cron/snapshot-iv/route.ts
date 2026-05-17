// ============================================================
// SteelEagle — Daily IV Snapshot Cron
// GET /api/cron/snapshot-iv
// Runs at 4:15 PM ET Mon–Fri via Vercel Cron
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db/client'
import { marketGet } from '@/lib/schwab/client'
import type { OptionChain, Pillar } from '@/types'

const PILLARS: Pillar[] = [
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

  const results: Record<string, string> = {}
  const today = new Date().toISOString().split('T')[0]

  for (const symbol of PILLARS) {
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
          atmIv = strikes[0][0].volatility ?? strikes[0][0].impliedVolatility ?? null
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
