// ============================================================
// SteelEagle — Scanner API Route
// GET /api/scanner
// Returns IV Rank + condor setup for SPY, TLT, GLD
// Called by the dashboard on load
// ============================================================

import { NextResponse } from 'next/server'
import { getOptionChain } from '@/lib/schwab/chains'
import { calculateIVRank } from '@/lib/strategy/iv-rank'
import { buildCondor } from '@/lib/strategy/condor-builder'
import type { Pillar } from '@/types'

const PILLARS: Pillar[] = ['SPY', 'TLT', 'GLD']

export async function GET() {
  const results = []

  for (const symbol of PILLARS) {
    try {
      // 1. Fetch option chain (filters to 28–52 DTE automatically)
      const chain = await getOptionChain(symbol)

      if (!chain) {
        results.push({ symbol, error: 'No option chain data available' })
        continue
      }

      // 2. Calculate IV Rank from historical snapshots
      const ivRank = await calculateIVRank(symbol, chain.atmIv)

      // 3. Build the condor setup (even if it doesn't pass filters — we show it either way)
      const condor = buildCondor(symbol, chain, ivRank)

      results.push({
        symbol,
        underlyingPrice: chain.underlyingPrice,
        expiration: chain.expiration,
        dte: chain.dte,
        currentIv: parseFloat((chain.atmIv * 100).toFixed(1)),
        ivRank,
        condor,
        error: null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`Scanner error for ${symbol}:`, message)
      results.push({ symbol, error: message })
    }
  }

  return NextResponse.json({
    results,
    timestamp: new Date().toISOString(),
  })
}
