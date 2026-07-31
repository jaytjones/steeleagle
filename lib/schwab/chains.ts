// ============================================================
// SteelEagle — Schwab Option Chains Service
// Fetches option chains and extracts legs for condor building
// ============================================================

import { marketGet } from './client'
import { apiSymbolFor, getInstrument, preferredRootFor } from '@/lib/strategy/instruments'
import { parseOccSymbol } from '@/lib/strategy/reconstruct-positions'
import type { OptionChain, OptionContract, CondorLeg } from '@/types'

export interface ChainResult {
  underlyingPrice: number
  expiration: string       // YYYY-MM-DD
  dte: number
  calls: OptionContract[]
  puts: OptionContract[]
  atmIv: number           // ATM call IV — used for IV Rank snapshots
}

/**
 * v2.4 — root filter for index chains (spec §6.2, Phase 0 V2).
 *
 * A single `$SPX` chain response carries BOTH the PM root (SPXW) and the AM
 * root (SPX), and at a monthly expiration BOTH land under the SAME
 * `callExpDateMap` key. Unfiltered, `findByDelta` would happily pick a short
 * call from one root and a long call from the other, producing a "condor" whose
 * legs are four contracts of two different instruments.
 *
 * Applied to INDEX instruments ONLY. ETF chains are passed through untouched —
 * root === symbol there, so filtering would be a no-op in the expected case and
 * a live-path regression in any unexpected one (adjusted-option roots like
 * "SPY1" are a separate concern, deliberately out of scope for this milestone).
 *
 * For an index, a contract whose root cannot be determined at all is EXCLUDED:
 * we know indices are multi-root, so "can't tell" is not a safe include.
 */
export function rootFilterFor(symbol: string): ((c: OptionContract) => boolean) | null {
  if (getInstrument(symbol)?.kind !== 'index') return null
  const preferred = preferredRootFor(symbol)
  return (c) => {
    const root =
      c.optionRoot?.trim().toUpperCase() || parseOccSymbol(c.symbol ?? '')?.root || null
    return root === preferred
  }
}

// --------------------------------------------------------
// Fetch option chain for a symbol, filtered to 28–52 DTE
// strikeCount: 200 gives 100 strikes per side — needed for
// SPY (~$740) to reach the 5Δ put ~$100 below ATM
//
// v2.4: `symbol` is the CANONICAL ($-free) symbol throughout. The `$` prefix
// indices require exists only on the outgoing request (Phase 0 V1: /chains
// accepts ONLY `$XSP`; bare and `.X` forms both 400).
// --------------------------------------------------------
/**
 * @param strikeCount  how many strikes to request, centred on ATM. Defaults to
 *   200 (100 per side) — what the CONDOR BUILDER needs to reach a 5Δ put ~$100
 *   below ATM on SPY. v2.6: the IV cron reuses this same function for its daily
 *   snapshot but passes a much smaller count, because it only needs the ATM
 *   contract and runs across ~29 symbols inside one cron invocation, where 29
 *   full-depth chains would be a lot of payload for one function.
 *
 *   This parameter deliberately controls only DEPTH, never WHAT is measured:
 *   the 28–52 DTE window, the delta-0.50 ATM pick and the index root filter are
 *   shared by every caller. That sharing is the whole point — the scanner's
 *   `currentIv` and the stored 52-week range have to be the same measurement,
 *   and before v2.6 they were not.
 */
export async function getOptionChain(
  symbol: string,
  { strikeCount = 200 }: { strikeCount?: number } = {},
): Promise<ChainResult | null> {
  const today = new Date()
  const fromDate = formatDate(addDays(today, 28))
  const toDate   = formatDate(addDays(today, 52))

  const chain = await marketGet<OptionChain>('/chains', {
    symbol: apiSymbolFor(symbol),
    contractType: 'ALL',
    strikeCount:  String(strikeCount),
    includeUnderlyingQuote: 'true',
    optionType: 'S',
    fromDate,
    toDate,
  })

  if (!chain || chain.status !== 'SUCCESS') return null

  const callExpirations = Object.keys(chain.callExpDateMap ?? {})
  if (callExpirations.length === 0) return null

  // Key format: "YYYY-MM-DD:DTE" — nearest first within the 28–52 DTE window
  const parsed = callExpirations
    .map(key => {
      const [date, dteStr] = key.split(':')
      return { key, date, dte: parseInt(dteStr, 10) }
    })
    .filter(e => e.dte >= 28 && e.dte <= 52)
    .sort((a, b) => a.dte - b.dte)

  if (parsed.length === 0) return null

  const keepRoot = rootFilterFor(symbol)
  const contractsAt = (
    map: Record<string, Record<string, OptionContract[]>> | undefined,
    key: string,
  ): OptionContract[] => {
    const all = Object.values(map?.[key] ?? {}).flat()
    return keepRoot ? all.filter(keepRoot) : all
  }

  // Walk nearest-first and take the first expiration that still has contracts
  // on BOTH sides after root filtering. Without this, an index expiration that
  // exists only under the AM root would return an empty chain rather than
  // falling through to the next tradeable one (Phase 0 V2: SPX/NDX/RUT all
  // carry AM-root monthlies inside the 28–52 window).
  for (const candidate of parsed) {
    const calls = contractsAt(chain.callExpDateMap, candidate.key)
    const puts = contractsAt(chain.putExpDateMap, candidate.key)
    if (calls.length === 0 || puts.length === 0) continue

    // ATM call = closest delta to 0.50 — use its IV for the daily snapshot
    const atmCall = calls.reduce((best, curr) =>
      Math.abs(curr.delta - 0.5) < Math.abs(best.delta - 0.5) ? curr : best
    )

    return {
      underlyingPrice: chain.underlyingPrice,
      expiration: candidate.date,
      dte: candidate.dte,
      calls,
      puts,
      // Schwab field is 'volatility' (already a percentage e.g. 14.5 = 14.5%)
      atmIv: atmCall?.volatility ?? atmCall?.impliedVolatility ?? 0,
    }
  }

  return null
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
