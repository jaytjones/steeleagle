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

const SHORT_DELTA = 0.16         // target delta for short strikes
const LONG_DELTA  = 0.05         // ideal delta for long strikes (wings)
const MIN_CREDIT_TO_WIDTH = 0.15 // minimum 15% credit-to-width ratio
const MIN_WING_WIDTH = 10        // minimum wing width in dollars ($10 = 5.8% friction)
const MIN_CREDIT = 150           // minimum total credit in cents ($150 = $1.50)
const COMMISSION_PER_CONTRACT = 0.65  // Schwab rate
const ROUND_TRIP_FILLS = 8       // 4 opens + 4 closes = 8 contract fills

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
  const commissionRoundTrip = ROUND_TRIP_FILLS * COMMISSION_PER_CONTRACT
  const creditToWidthRatio = wingWidth > 0 ? totalCredit / wingWidth : 0
  const maxLoss = wingWidth - totalCredit
  const bpr = (wingWidth - totalCredit) * 100  // Convert per-share to real dollars
  const netCreditAfterCommission = (totalCredit * 100) - commissionRoundTrip

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

  if (wingWidth < MIN_WING_WIDTH) {
    filterReasons.push(`Wing width $${wingWidth} is below the $${MIN_WING_WIDTH} minimum`)
  }

  if (totalCredit * 100 < MIN_CREDIT) {
    filterReasons.push(
      `Total credit $${(totalCredit * 100).toFixed(0)} is below the $${MIN_CREDIT} minimum`
    )
  }

  if (creditToWidthRatio < MIN_CREDIT_TO_WIDTH) {
    filterReasons.push(
      `Credit/width ratio ${(creditToWidthRatio * 100).toFixed(1)}% is below the 15% minimum`
    )
  }

  if (totalCredit <= 0) {
    filterReasons.push('Setup produces zero or negative credit')
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
    commissionRoundTrip:   Math.round(commissionRoundTrip * 100) / 100,
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
