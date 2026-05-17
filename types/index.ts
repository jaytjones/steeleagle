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

export type Pillar = 
  | 'SPY' | 'QQQ' | 'IWM' | 'DIA' | 'EFA' | 'EEM'      // Equities
  | 'TLT' | 'IEF' | 'HYG' | 'LQD'                      // Fixed Income
  | 'GLD' | 'SLV' | 'USO' | 'DBA'                      // Commodities
  | 'VXX' | 'UVXY' | 'SVXY'                            // Volatility
  | 'UUP' | 'FXY' | 'FXE' | 'FXB'                      // Currencies

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
  totalCredit: number
  commissionRoundTrip: number  // per-contract round-trip cost (8 fills @ $0.65/contract)
  wingWidth: number
  creditToWidthRatio: number
  maxLoss: number
  bpr: number
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
