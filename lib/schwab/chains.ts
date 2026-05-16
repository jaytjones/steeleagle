// ============================================================
// SteelEagle — Schwab Option Chains Service
// Fetches option chains and extracts legs for condor building
// ============================================================

import { marketGet } from './client'
import type { OptionChain, OptionContract, CondorLeg } from '@/types'

export interface ChainResult {
  underlyingPrice: number
  expiration: string       // YYYY-MM-DD
  dte: number
  calls: OptionContract[]
  puts: OptionContract[]
  atmIv: number           // ATM call IV — used for IV Rank snapshots
}

// --------------------------------------------------------
// Fetch option chain for a symbol, filtered to 28–52 DTE
// strikeCount: 200 gives 100 strikes per side — needed for
// SPY (~$740) to reach the 5Δ put ~$100 below ATM
// --------------------------------------------------------
export async function getOptionChain(symbol: string): Promise<ChainResult | null> {
  const today = new Date()
  const fromDate = formatDate(addDays(today, 28))
  const toDate   = formatDate(addDays(today, 52))

  const chain = await marketGet<OptionChain>('/chains', {
    symbol,
    contractType: 'ALL',
    strikeCount:  '200',
    includeUnderlyingQuote: 'true',
    optionType: 'S',
    fromDate,
    toDate,
  })

  if (!chain || chain.status !== 'SUCCESS') return null

  const callExpirations = Object.keys(chain.callExpDateMap ?? {})
  if (callExpirations.length === 0) return null

  // Key format: "YYYY-MM-DD:DTE" — pick nearest in 28–52 DTE window
  const parsed = callExpirations
    .map(key => {
      const [date, dteStr] = key.split(':')
      return { key, date, dte: parseInt(dteStr, 10) }
    })
    .filter(e => e.dte >= 28 && e.dte <= 52)
    .sort((a, b) => a.dte - b.dte)

  if (parsed.length === 0) return null

  const nearest = parsed[0]

  const calls: OptionContract[] = Object.values(
    chain.callExpDateMap[nearest.key] ?? {}
  ).flat()

  const puts: OptionContract[] = Object.values(
    chain.putExpDateMap[nearest.key] ?? {}
  ).flat()

  if (calls.length === 0 || puts.length === 0) return null

  // ATM call = closest delta to 0.50 — use its IV for the daily snapshot
  const atmCall = calls.reduce((best, curr) =>
    Math.abs(curr.delta - 0.5) < Math.abs(best.delta - 0.5) ? curr : best
  )

  return {
    underlyingPrice: chain.underlyingPrice,
    expiration: nearest.date,
    dte: nearest.dte,
    calls,
    puts,
    // Schwab field is 'volatility' (already a percentage e.g. 14.5 = 14.5%)
    atmIv: atmCall?.volatility ?? atmCall?.impliedVolatility ?? 0,
  }
}

// --------------------------------------------------------
// Find the contract whose delta is closest to a target
// --------------------------------------------------------
export function findByDelta(
  contracts: OptionContract[],
  targetDelta: number
): OptionContract | null {
  if (contracts.length === 0) return null
  return contracts.reduce((best, curr) =>
    Math.abs(curr.delta - targetDelta) < Math.abs(best.delta - targetDelta) ? curr : best
  )
}

// --------------------------------------------------------
// Convert an OptionContract to a CondorLeg
// --------------------------------------------------------
export function contractToLeg(
  contract: OptionContract,
  action: 'buy' | 'sell',
  type: 'call' | 'put'
): CondorLeg {
  const mark = contract.mark > 0 ? contract.mark : (contract.bid + contract.ask) / 2
  return {
    type,
    action,
    strike: contract.strikePrice,
    delta: contract.delta,
    bid: contract.bid,
    ask: contract.ask,
    mark,
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}
