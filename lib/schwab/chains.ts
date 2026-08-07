// ============================================================
// SteelEagle — Schwab Option Chains Service
// Fetches option chains and extracts legs for condor building
// ============================================================

import { marketGet } from './client'
import { apiSymbolFor, getInstrument, preferredRootFor } from '@/lib/strategy/instruments'
import { parseOccSymbol } from '@/lib/strategy/reconstruct-positions'
// v2.10 — expiration selection is pure and unit-tested; this file is I/O + glue.
import {
  isMonthlyExpirationType,
  noCondorReason,
  orderCondorCandidates,
  orderIvCandidates,
} from '@/lib/strategy/expiration'
import type { OptionChain, OptionContract, CondorLeg } from '@/types'

/**
 * The tradeable slice — everything `buildCondor` needs, at the expiration the
 * STRATEGY wants (30–45 DTE, monthly preferred).
 *
 * Deliberately a separate type from the IV measurement. See lib/strategy/
 * expiration.ts for why these must not be merged back together.
 */
export interface CondorChain {
  underlyingPrice: number
  expiration: string       // YYYY-MM-DD
  dte: number
  calls: OptionContract[]
  puts: OptionContract[]
}

export interface ChainResult {
  underlyingPrice: number

  // ---- IV measurement. The ONLY fields the IV cron may read. ----
  /** ATM call IV at the IV-basis expiration. Defines basis `atm_28_52dte`. */
  atmIv: number
  /** The expiration `atmIv` was measured at — NEAREST within 28–52 DTE. */
  ivExpiration: string
  ivDte: number

  // ---- Tradeable selection. NULL when nothing qualifies. ----
  /**
   * v2.10 — null when no expiration falls in 30–45 DTE. That is a REFUSAL to
   * propose, not an error: the IV fields above are still populated and still
   * get stored, because dropping a symbol from `iv_history` would punch an
   * unrecoverable hole in its 52-week range (Schwab serves no historical IV).
   */
  condor: CondorChain | null
  /**
   * Operator-facing reason `condor` is null; '' when a condor WAS selected.
   *
   * Computed here, beside the decision, so the message and the decision can
   * never drift apart. A card that simply renders nothing would make "outside
   * the tenor window" indistinguishable from "healthy" — the v2.6.1 rule.
   */
  condorRefusal: string
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
 *
 * v2.10 — this now performs TWO INDEPENDENT selections over ONE response:
 *
 *   `atmIv` / `ivExpiration` — nearest within 28–52 DTE. UNCHANGED, and it is
 *     the definition of basis `atm_28_52dte`. Touching it is a live IV-history
 *     change requiring a new basis value, not a refactor (see iv-basis.ts).
 *
 *   `condor` — 30–45 DTE, monthly preferred. The strategy's tradeable tenor.
 *     Null when nothing qualifies, which is a refusal, not an error.
 *
 * 30–45 ⊂ 28–52, so both come out of the SAME fetch and the request parameters
 * below are untouched. The two selections agree today only by coincidence of
 * the window — never collapse them back into one. lib/strategy/expiration.ts
 * holds the rules and the reasoning.
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

  const keepRoot = rootFilterFor(symbol)
  const contractsAt = (
    map: Record<string, Record<string, OptionContract[]>> | undefined,
    key: string,
  ): OptionContract[] => {
    const all = Object.values(map?.[key] ?? {}).flat()
    return keepRoot ? all.filter(keepRoot) : all
  }

  // Resolve every expiration ONCE, dropping any left empty by the index root
  // filter. That drop is the v2.4 fall-through: an expiration existing only
  // under the AM root must not shadow the next tradeable one (Phase 0 V2 —
  // SPX/NDX/RUT all carry AM-root monthlies inside the 28–52 window).
  //
  // Key format: "YYYY-MM-DD:DTE".
  const resolved = callExpirations
    .map((key) => {
      const [date, dteStr] = key.split(':')
      const calls = contractsAt(chain.callExpDateMap, key)
      const puts = contractsAt(chain.putExpDateMap, key)
      return {
        key,
        date,
        dte: parseInt(dteStr, 10),
        // Monthliness comes from the ROOT-FILTERED contracts: for an index the
        // monthly key carries both roots, and the flag must describe what we
        // would actually trade.
        isMonthly: isMonthlyExpirationType(calls[0]?.expirationType),
        calls,
        puts,
      }
    })
    .filter((e) => Number.isFinite(e.dte) && e.calls.length > 0 && e.puts.length > 0)

  // ---- Selection 1: the IV measurement (basis `atm_28_52dte`) ----
  //
  // Nearest within 28–52 DTE — the pre-v2.10 rule, unchanged. This runs FIRST
  // and independently: whether a tradeable condor expiration exists must never
  // affect whether a snapshot is taken.
  const ivPick = orderIvCandidates(resolved)[0]
  if (!ivPick) return null

  const atmCall = ivPick.calls.reduce((best, curr) =>
    Math.abs(curr.delta - 0.5) < Math.abs(best.delta - 0.5) ? curr : best,
  )

  // ---- Selection 2: the tradeable condor expiration ----
  //
  // 30–45 DTE, monthly preferred. Independent of the above by design — see the
  // header of lib/strategy/expiration.ts. A null here is a refusal to propose,
  // NOT a failure, and it leaves the IV fields fully populated.
  const condorPick = orderCondorCandidates(resolved)[0] ?? null

  return {
    underlyingPrice: chain.underlyingPrice,
    // Schwab field is 'volatility' (already a percentage e.g. 14.5 = 14.5%)
    atmIv: atmCall?.volatility ?? atmCall?.impliedVolatility ?? 0,
    ivExpiration: ivPick.date,
    ivDte: ivPick.dte,
    condor: condorPick
      ? {
          underlyingPrice: chain.underlyingPrice,
          expiration: condorPick.date,
          dte: condorPick.dte,
          calls: condorPick.calls,
          puts: condorPick.puts,
        }
      : null,
    condorRefusal: condorPick ? '' : noCondorReason(resolved),
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
