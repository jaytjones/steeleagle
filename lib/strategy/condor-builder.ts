// ============================================================
// SteelEagle — Iron Condor Builder
// Given a chain and IV Rank, constructs the condor setup
//
// Wing width logic:
//   1. Find short put (~16Δ) and short call (~16Δ) — these are fixed
//   2. Find ideal long put (~5Δ) and ideal long call (~5Δ) independently
//   3. Calculate natural put wing width and natural call wing width
//   4. The NARROWER wing is the limiting factor — use that as target width
//   5. Adjust the wider side's long strike inward to match target width
//   6. Short legs are always preserved at their natural 16Δ strike
// ============================================================

import { findByDelta, contractToLeg, type ChainResult } from '@/lib/schwab/chains'
import type { OptionContract } from '@/types'
import type { Pillar, CondorSetup, IVRankResult } from '@/types'
import { checkLiquidity } from '@/lib/strategy/liquidity'
import { commissionRoundTrip, minWingWidthFor } from '@/lib/strategy/instruments'

const SHORT_DELTA = 0.16         // target delta for short strikes
const LONG_DELTA  = 0.05         // ideal delta for long strikes (wings)
export const MIN_CREDIT_TO_WIDTH = 0.15 // minimum 15% credit-to-width ratio

// v2.4 §6.3/§6.4 — two hardcoded constants became per-instrument:
//
//   MIN_WING_WIDTH = 10   → minWingWidthFor(symbol). A $10 wing is ~5.8%
//     friction on a $740 ETF and meaningless on a 7,400-point index, so the
//     floor scales with the instrument's level.
//
//   MIN_CREDIT = 150      → DELETED as a separate filter. It was the $10-wing
//     expression of the ratio rule the strategy doc actually states
//     (credit ≥ 15% of wing width): 0.15 × $10 × 100 = $150. Keeping both meant
//     two filter reasons that always fired together and a floor that silently
//     under-gated wide wings. The ratio filter below now reports the derived
//     dollar floor in its message, so nothing is lost from the operator's view.
//
//   COMMISSION_PER_CONTRACT / ROUND_TRIP_FILLS → commissionRoundTrip(symbol).
//     ETFs still compute 8 × $0.65 = $5.20, byte-identical (spec §9).
//
// The 16Δ / 5Δ / 30–45 DTE logic is untouched.
//
// NOT changed, contra spec §6.3: there is no strike-stepping to parameterize.
// Long strikes snap to strikes that actually exist in the fetched chain
// (findNearestStrike), which beats stepping by an assumed increment — so no
// `strikeIncrement` is threaded through. Recorded as a rev-B spec correction.

export function buildCondor(
  symbol: Pillar,
  chain: ChainResult,
  ivRank: IVRankResult
): CondorSetup | null {
  const { calls, puts, underlyingPrice, expiration, dte } = chain

  // --------------------------------------------------------
  // Step 1: Find short legs at ~16Δ — these never move
  // --------------------------------------------------------
  const shortPutContract  = findByDelta(puts,  -SHORT_DELTA)
  const shortCallContract = findByDelta(calls,  SHORT_DELTA)

  if (!shortPutContract || !shortCallContract) return null

  // --------------------------------------------------------
  // Step 2: Find ideal long legs at ~5Δ
  // --------------------------------------------------------
  const idealLongPutContract  = findByDelta(puts,  -LONG_DELTA)
  const idealLongCallContract = findByDelta(calls,  LONG_DELTA)

  if (!idealLongPutContract || !idealLongCallContract) return null

  // --------------------------------------------------------
  // Step 3: Calculate natural wing widths for each side
  // --------------------------------------------------------
  const naturalPutWidth  = shortPutContract.strikePrice  - idealLongPutContract.strikePrice
  const naturalCallWidth = idealLongCallContract.strikePrice - shortCallContract.strikePrice

  if (naturalPutWidth <= 0 || naturalCallWidth <= 0) return null

  // --------------------------------------------------------
  // Step 4: The narrower wing is the limiting factor
  // --------------------------------------------------------
  const targetWidth = Math.min(naturalPutWidth, naturalCallWidth)

  // --------------------------------------------------------
  // Step 5: Find the actual long strikes at exactly targetWidth
  // from each short strike, snapping to nearest available strike
  // --------------------------------------------------------
  const targetLongPutStrike  = shortPutContract.strikePrice  - targetWidth
  const targetLongCallStrike = shortCallContract.strikePrice + targetWidth

  const longPutContract  = findNearestStrike(puts,  targetLongPutStrike)
  const longCallContract = findNearestStrike(calls, targetLongCallStrike)

  if (!longPutContract || !longCallContract) return null

  // Final safety checks
  if (longPutContract.strikePrice  >= shortPutContract.strikePrice)  return null
  if (shortCallContract.strikePrice >= longCallContract.strikePrice)  return null

  // --------------------------------------------------------
  // Step 6: Build legs and calculate metrics
  // --------------------------------------------------------
  const shortPut  = contractToLeg(shortPutContract,  'sell', 'put')
  const longPut   = contractToLeg(longPutContract,   'buy',  'put')
  const shortCall = contractToLeg(shortCallContract, 'sell', 'call')
  const longCall  = contractToLeg(longCallContract,  'buy',  'call')

  // Actual wing widths after snapping (should be equal or ±1 strike)
  const actualPutWidth  = shortPut.strike  - longPut.strike
  const actualCallWidth = longCall.strike  - shortCall.strike
  const wingWidth = Math.min(actualPutWidth, actualCallWidth)

  const totalCredit = (shortPut.mark + shortCall.mark) - (longPut.mark + longCall.mark)
  const commission = commissionRoundTrip(symbol)
  const creditToWidthRatio = wingWidth > 0 ? totalCredit / wingWidth : 0
  const maxLoss = wingWidth - totalCredit
  const bpr = (wingWidth - totalCredit) * 100  // Convert per-share to real dollars
  const netCreditAfterCommission = (totalCredit * 100) - commission

  // --------------------------------------------------------
  // Apply strategy filters
  // --------------------------------------------------------
  const filterReasons: string[] = []

  if (!ivRank.passes) {
    if (ivRank.daysOfHistory < 20) {
      filterReasons.push(`Calibrating — ${ivRank.daysOfHistory}/20 days of IV history`)
    } else {
      filterReasons.push(`IV Rank ${ivRank.ivRank}% is below the 25% threshold`)
    }
  }

  const minWingWidth = minWingWidthFor(symbol)
  if (wingWidth < minWingWidth) {
    filterReasons.push(`Wing width $${wingWidth} is below the $${minWingWidth} minimum`)
  }

  // The credit floor, derived from the wing (v2.4 §6.4). On a $10 wing this is
  // exactly the old $150 constant; on a $50 SPX wing it is $750.
  if (creditToWidthRatio < MIN_CREDIT_TO_WIDTH) {
    const minCreditDollars = MIN_CREDIT_TO_WIDTH * wingWidth * 100
    filterReasons.push(
      `Credit/width ratio ${(creditToWidthRatio * 100).toFixed(1)}% is below the 15% minimum ` +
      `($${(totalCredit * 100).toFixed(0)} credit on a $${wingWidth} wing needs $${minCreditDollars.toFixed(0)})`
    )
  }

  if (totalCredit <= 0) {
    filterReasons.push('Setup produces zero or negative credit')
  }

  // Liquidity (item 7): total 4-leg bid/ask spread must be ≤ 25% of credit.
  if (totalCredit > 0) {
    const liquidity = checkLiquidity([shortPut, longPut, shortCall, longCall], totalCredit)
    if (!liquidity.passes) {
      filterReasons.push(
        `Bid/ask spread is ${Math.round(liquidity.ratio * 100)}% of credit, above the 25% maximum`
      )
    }
  }

  return {
    symbol,
    expiration,
    dte,
    underlyingPrice,
    ivRank,
    shortPut,
    longPut,
    shortCall,
    longCall,
    totalCredit:           Math.round(totalCredit * 100) / 100,
    commissionRoundTrip:   Math.round(commission * 100) / 100,
    netCreditAfterCommission: Math.round(netCreditAfterCommission * 100) / 100,
    wingWidth,
    creditToWidthRatio:    Math.round(creditToWidthRatio * 1000) / 1000,
    maxLoss:               Math.round(maxLoss * 100) / 100,
    bpr:                   Math.round(bpr * 100) / 100,
    passesFilter:          filterReasons.length === 0,
    filterReasons,
  }
}

// --------------------------------------------------------
// Find the contract whose strike is closest to a target price
// (used to snap long strikes to the nearest available strike)
// --------------------------------------------------------
function findNearestStrike(
  contracts: OptionContract[],
  targetStrike: number
): OptionContract | null {
  if (contracts.length === 0) return null
  return contracts.reduce((best, curr) =>
    Math.abs(curr.strikePrice - targetStrike) < Math.abs(best.strikePrice - targetStrike)
      ? curr
      : best
  )
}
