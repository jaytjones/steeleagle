// ============================================================
// SteelEagle — Shared TypeScript Types
// ============================================================

// --------------------------------------------------------
// Schwab API
// --------------------------------------------------------

export interface SchwabTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

export interface OptionContract {
  symbol: string
  strikePrice: number
  expirationDate: string
  daysToExpiration: number
  bid: number
  ask: number
  mark: number
  delta: number
  gamma: number
  theta: number
  vega: number
  volatility: number          // Schwab API field — already a percentage (e.g. 14.5 = 14.5%)
  impliedVolatility?: number  // fallback alias
  openInterest: number
  totalVolume: number
  inTheMoney: boolean
}

export interface OptionChain {
  symbol: string
  status: string
  underlyingPrice: number
  putExpDateMap: Record<string, Record<string, OptionContract[]>>
  callExpDateMap: Record<string, Record<string, OptionContract[]>>
}

export interface AccountHash {
  accountNumber: string
  hashValue: string
}

// --------------------------------------------------------
// Strategy / Scanner
// --------------------------------------------------------

/**
 * Any tradable symbol. In v1.0 this was a literal union of three
 * "pillar" tickers (SPY/TLT/GLD); v1.2 widens it to any string since
 * users can configure arbitrary tickers via the cell grid.
 */
export type Pillar = string

export interface IVSnapshot {
  symbol: Pillar
  snapshotDate: string
  atmIv: number
  underlyingPrice: number
}

export interface IVRankResult {
  symbol: Pillar
  currentIv: number
  ivRank: number
  daysOfHistory: number
  passes: boolean
}

export interface CondorLeg {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  delta: number
  bid: number
  ask: number
  mark: number
}

export interface CondorSetup {
  symbol: Pillar
  expiration: string
  dte: number
  underlyingPrice: number
  ivRank: IVRankResult
  shortPut: CondorLeg
  longPut: CondorLeg
  shortCall: CondorLeg
  longCall: CondorLeg
  totalCredit: number  // per-share credit (e.g., 3.39)
  commissionRoundTrip: number  // real dollars per contract (8 fills @ $0.65/contract = $5.20)
  netCreditAfterCommission: number  // real dollars: (totalCredit * 100) - commissionRoundTrip
  wingWidth: number  // per-share (e.g., 18)
  creditToWidthRatio: number
  maxLoss: number  // per-share
  bpr: number  // real dollars: (wingWidth - totalCredit) * 100
  passesFilter: boolean
  filterReasons: string[]
}

// --------------------------------------------------------
// Positions Monitor
// --------------------------------------------------------

export interface OpenPosition {
  symbol: string
  description: string
  quantity: number
  marketValue: number
  averageCost: number
  unrealizedPL: number
  unrealizedPLPercent: number
}

// --------------------------------------------------------
// Scanner API Response
// --------------------------------------------------------

export interface ScannerResult {
  symbol: Pillar
  underlyingPrice: number
  expiration: string
  dte: number
  currentIv: number
  ivRank: IVRankResult
  condor: CondorSetup | null
  error: string | null
}
