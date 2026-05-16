// ============================================================
// SteelEagle — Schwab Quotes Service
// Fetches current underlying prices for SPY, TLT, GLD
// ============================================================

import { marketGet } from './client'

export interface Quote {
  symbol: string
  lastPrice: number
  bidPrice: number
  askPrice: number
  mark: number
  netPercentChangeInDouble: number
}

interface QuotesResponse {
  [symbol: string]: {
    quote: Quote
  }
}

export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const data = await marketGet<QuotesResponse>('/quotes', {
    symbols: symbols.join(','),
    fields: 'quote',
  })

  const result: Record<string, Quote> = {}
  for (const symbol of symbols) {
    if (data[symbol]?.quote) {
      result[symbol] = { ...data[symbol].quote, symbol }
    }
  }
  return result
}
