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
import type { ScannerResult } from '@/types'

export async function GET(request: NextRequest) {
  const symbols = await resolveSymbols(request)

  const results: ScannerResult[] = []

  for (const symbol of symbols) {
    try {
      const chain = await getOptionChain(symbol)
      if (!chain) {
        results.push(makeErrorResult(symbol, 'No option chain data available'))
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
        const rawMessage = err instanceof Error ? err.message : String(err)
        console.error(`Scanner error for ${symbol}:`, rawMessage)
        results.push(makeErrorResult(symbol, translateScannerError(rawMessage)))
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
 * Produces a fully-shaped ScannerResult for error/unavailable cases.
 *
 * Downstream consumers (ScannerCard, dashboard's calibration banner)
 * destructure every field on render — partial objects with only
 * {symbol, error} would crash on `ivRank.daysOfHistory` or
 * `underlyingPrice.toFixed()`. We pay a few bytes of placeholder data
 * to preserve a stable contract; the `error` field is the signal
 * consumers use to skip rendering trade-specific fields anyway.
 */
function makeErrorResult(symbol: string, error: string): ScannerResult {
  return {
    symbol,
    underlyingPrice: 0,
    expiration: '',
    dte: 0,
    currentIv: 0,
    ivRank: {
      symbol,
      currentIv: 0,
      ivRank: 0,
      daysOfHistory: 0,
      passes: false,
    },
    condor: null,
    error,
  }
}/**
 * Translates raw API/network error messages into user-facing copy.
 * The original message is still logged via console.error for debugging;
 * this controls what the dashboard shows on the card.
 */
function translateScannerError(rawMessage: string): string {
  // Schwab 400 on /chains is almost always an unknown ticker symbol
  if (rawMessage.includes('Schwab API error 400')) {
    return 'Symbol not recognized by Schwab — remove this cell or check spelling'
  }

  // Auth — refresh token expired or revoked
  if (rawMessage.includes('Schwab API error 401')) {
    return 'Schwab session expired — reconnect to refresh data'
  }

  // Rate limiting (rare on GET endpoints, but possible)
  if (rawMessage.includes('Schwab API error 429')) {
    return 'Rate limited by Schwab — try again in a moment'
  }

  // Anything else from Schwab — generic API failure
  if (rawMessage.includes('Schwab API error')) {
    return 'Schwab market data unavailable — try refreshing'
  }

  // Network-level failures (fetch failed, ECONNREFUSED, timeouts)
  if (rawMessage.includes('fetch failed') || rawMessage.includes('ETIMEDOUT')) {
    return 'Network error — check your connection and try again'
  }

  // Unknown — keep generic to avoid leaking implementation details
  return 'Unable to load market data for this symbol'
}

/**
 * Resolves the symbol list for this request.
 *
 *   1. ?symbols=SPY,QQQ — explicit override.
 *   2. user_settings.tickers — the default driver for full dashboard loads.
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