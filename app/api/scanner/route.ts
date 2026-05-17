// ============================================================
// SteelEagle — Scanner API Route
// GET /api/scanner                  → uses user_settings.tickers
// GET /api/scanner?symbols=SPY,QQQ  → explicit override
// Returns IV Rank + condor setup for each requested symbol.
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getOptionChain } from '@/lib/schwab/chains'
import { calculateIVRank } from '@/lib/strategy/iv-rank'
import { buildCondor } from '@/lib/strategy/condor-builder'
import { getUserSettings } from '@/lib/db/settings'

export async function GET(request: NextRequest) {
  const symbols = await resolveSymbols(request)

  const results = []

  for (const symbol of symbols) {
    try {
      const chain = await getOptionChain(symbol)
      if (!chain) {
        results.push({ symbol, error: 'No option chain data available' })
        continue
      }

      const ivRank = await calculateIVRank(symbol, chain.atmIv)
      const condor = buildCondor(symbol, chain, ivRank)

      results.push({
        symbol,
        underlyingPrice: chain.underlyingPrice,
        expiration: chain.expiration,
        dte: chain.dte,
        // Schwab returns volatility already as a percentage (e.g. 14.5 = 14.5%).
        // Do NOT multiply by 100.
        currentIv: parseFloat(chain.atmIv.toFixed(2)),
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

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

/**
 * Resolves the symbol list for this request.
 *
 *   1. ?symbols=SPY,QQQ — explicit override. Used in Step 5 by the
 *      single-cell refresh path (when a user edits one ticker) and as
 *      a debug escape hatch.
 *   2. user_settings.tickers — the default driver for full dashboard
 *      loads. Singleton row; safe to call on every request.
 *
 * Per-symbol validation (legal format, options chain availability) is
 * done downstream during the chain fetch — we don't filter here, so
 * a typo'd ticker round-trips as a NO_DATA result on its own card.
 */
async function resolveSymbols(request: NextRequest): Promise<string[]> {
  const symbolsParam = request.nextUrl.searchParams.get('symbols')

  if (symbolsParam) {
    return symbolsParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  }

  const settings = await getUserSettings()
  return settings.tickers
}