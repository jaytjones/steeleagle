// ============================================================
// SteelEagle — Daily IV Snapshot Cron
// GET /api/cron/snapshot-iv
// Runs at 4:15 PM ET Mon–Fri via Vercel Cron
// Fetches ATM IV for SPY, TLT, GLD and stores in iv_history
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase/client'
import { marketGet } from '@/lib/schwab/client'
import type { OptionChain, Pillar } from '@/types'

const PILLARS: Pillar[] = ['SPY', 'TLT', 'GLD']

export async function GET(request: NextRequest) {
  // Verify the request is from Vercel Cron (or an authorized caller)
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: Record<string, string> = {}
  const today = new Date().toISOString().split('T')[0]

  for (const symbol of PILLARS) {
    try {
      // Fetch the option chain to extract ATM IV and underlying price
      const chain = await marketGet<OptionChain>('/chains', {
        symbol,
        contractType: 'ALL',
        strikeCount: '1',        // just the ATM strike
        includeUnderlyingQuote: 'true',
        optionType: 'S',         // standard contracts only
      })

      const underlyingPrice = chain.underlyingPrice

      // Extract ATM IV from the nearest expiration call
      let atmIv: number | null = null

      const callExpirations = Object.keys(chain.callExpDateMap)
      if (callExpirations.length > 0) {
        const nearestExpiration = callExpirations[0]
        const strikes = Object.values(chain.callExpDateMap[nearestExpiration])
        if (strikes.length > 0 && strikes[0].length > 0) {
          atmIv = strikes[0][0].impliedVolatility
        }
      }

      if (atmIv === null) {
        results[symbol] = 'skipped — no IV data'
        continue
      }

      // Upsert into iv_history (safe to re-run)
      const { error } = await supabase.from('iv_history').upsert(
        {
          symbol,
          snapshot_date: today,
          atm_iv: atmIv,
          underlying_price: underlyingPrice,
        },
        { onConflict: 'symbol,snapshot_date' }
      )

      if (error) {
        results[symbol] = `error: ${error.message}`
      } else {
        results[symbol] = `ok — IV: ${(atmIv * 100).toFixed(1)}%, price: ${underlyingPrice}`
      }
    } catch (err) {
      results[symbol] = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  console.log('IV Snapshot results:', results)
  return NextResponse.json({ date: today, results })
}
