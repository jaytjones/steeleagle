// ============================================================
// SteelEagle — Schwab Earnings Chain Service
// Near-dated chains (0–10 DTE) for the Tactical Earnings sleeve.
//
// Distinct from chains.ts::getOptionChain, which is pinned to the
// core's 28–52 DTE window. The earnings sleeve needs the 1–3 DTE
// weekly AFTER an earnings report, so this fetches a short forward
// window and returns ALL expiration slices for the route to pick from.
// ============================================================

import { marketGet } from './client'
import type { OptionChain, OptionContract } from '@/types'

export interface ExpirationSlice {
  date: string // YYYY-MM-DD
  dte: number
  calls: OptionContract[]
  puts: OptionContract[]
}

export interface EarningsChainResult {
  symbol: string
  underlyingPrice: number
  /** All expirations in the near-dated window, ascending by DTE. */
  expirations: ExpirationSlice[]
}

const FORWARD_DAYS = 10

/**
 * Fetch the near-dated option chain for an earnings name and parse every
 * expiration into a slice. Returns null when no chain is available.
 */
export async function getEarningsChain(symbol: string): Promise<EarningsChainResult | null> {
  const today = new Date()
  const fromDate = fmt(today)
  const toDate = fmt(addDays(today, FORWARD_DAYS))

  const chain = await marketGet<OptionChain>('/chains', {
    symbol,
    contractType: 'ALL',
    strikeCount: '200',
    includeUnderlyingQuote: 'true',
    optionType: 'S',
    fromDate,
    toDate,
  })

  if (!chain || chain.status !== 'SUCCESS') return null

  const callKeys = Object.keys(chain.callExpDateMap ?? {})
  if (callKeys.length === 0) return null

  const expirations: ExpirationSlice[] = callKeys
    .map((key) => {
      const [date, dteStr] = key.split(':') // "YYYY-MM-DD:DTE"
      const calls = Object.values(chain.callExpDateMap[key] ?? {}).flat()
      const puts = Object.values(chain.putExpDateMap[key] ?? {}).flat()
      return { date, dte: parseInt(dteStr, 10), calls, puts }
    })
    .filter((e) => e.calls.length > 0 && e.puts.length > 0)
    .sort((a, b) => a.dte - b.dte)

  if (expirations.length === 0) return null

  return {
    symbol: symbol.toUpperCase(),
    underlyingPrice: chain.underlyingPrice,
    expirations,
  }
}

/**
 * ATM straddle mids for a slice: the call + put at the strike nearest spot.
 * Feeds computeExpectedMove. Returns null if a usable pair can't be found.
 */
export function extractAtmStraddle(
  slice: ExpirationSlice,
  underlyingPrice: number,
): { atmCallMid: number; atmPutMid: number } | null {
  const atmCall = nearestStrikeContract(slice.calls, underlyingPrice)
  if (!atmCall) return null

  const atmPut =
    slice.puts.find((p) => p.strikePrice === atmCall.strikePrice) ??
    nearestStrikeContract(slice.puts, underlyingPrice)
  if (!atmPut) return null

  return { atmCallMid: midOf(atmCall), atmPutMid: midOf(atmPut) }
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function nearestStrikeContract(cs: OptionContract[], target: number): OptionContract | null {
  if (cs.length === 0) return null
  return cs.reduce((best, cur) =>
    Math.abs(cur.strikePrice - target) < Math.abs(best.strikePrice - target) ? cur : best,
  )
}

function midOf(c: OptionContract): number {
  return c.mark > 0 ? c.mark : (c.bid + c.ask) / 2
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function fmt(date: Date): string {
  return date.toISOString().split('T')[0]
}
