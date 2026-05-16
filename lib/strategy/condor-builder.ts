// ============================================================
// SteelEagle — Iron Condor Builder
// Given a chain and IV Rank, constructs the condor setup
// Strategy: ~16Δ shorts / ~5Δ longs, credit >= 15% of width
// ============================================================

import { findByDelta, contractToLeg, type ChainResult } from '@/lib/schwab/chains'
import type { Pillar, CondorSetup, IVRankResult } from '@/types'

const SHORT_DELTA = 0.16         // target delta for short strikes
const LONG_DELTA = 0.05          // target delta for long strikes (wings)
const MIN_CREDIT_TO_WIDTH = 0.15 // minimum 15% credit-to-width ratio

export function buildCondor(
  symbol: Pillar,
  chain: ChainResult,
  ivRank: IVRankResult
): CondorSetup | null {
  const { calls, puts, underlyingPrice, expiration, dte } = chain

  // --------------------------------------------------------
  // Find the four legs
  // Puts have negative delta; calls have positive delta
  // Short strikes are closer to ATM (16Δ)
  // Long strikes are further OTM (5Δ) — the wings
  // --------------------------------------------------------
  const shortPutContract  = findByDelta(puts,  -SHORT_DELTA)
  const longPutContract   = findByDelta(puts,  -LONG_DELTA)
  const shortCallContract = findByDelta(calls,  SHORT_DELTA)
  const longCallContract  = findByDelta(calls,  LONG_DELTA)

  if (!shortPutContract || !longPutContract || !shortCallContract || !longCallContract) {
    return null
  }

  // Safety: validate leg ordering
  // Long put must be below short put; long call must be above short call
  if (longPutContract.strikePrice >= shortPutContract.strikePrice) return null
  if (shortCallContract.strikePrice >= longCallContract.strikePrice) return null

  const shortPut  = contractToLeg(shortPutContract,  'sell', 'put')
  const longPut   = contractToLeg(longPutContract,   'buy',  'put')
  const shortCall = contractToLeg(shortCallContract, 'sell', 'call')
  const longCall  = contractToLeg(longCallContract,  'buy',  'call')

  // --------------------------------------------------------
  // Calculate trade metrics (using mark / mid prices)
  // --------------------------------------------------------
  const totalCredit = (shortPut.mark + shortCall.mark) - (longPut.mark + longCall.mark)
  const wingWidth   = shortPut.strike - longPut.strike  // put side width (call side ≈ same)
  const creditToWidthRatio = wingWidth > 0 ? totalCredit / wingWidth : 0
  const maxLoss  = wingWidth - totalCredit
  const bpr      = maxLoss  // buying power reduction ≈ max loss for a spread

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
    totalCredit:        Math.round(totalCredit * 100) / 100,
    wingWidth,
    creditToWidthRatio: Math.round(creditToWidthRatio * 1000) / 1000,
    maxLoss:            Math.round(maxLoss * 100) / 100,
    bpr:                Math.round(bpr * 100) / 100,
    passesFilter:       filterReasons.length === 0,
    filterReasons,
  }
}
