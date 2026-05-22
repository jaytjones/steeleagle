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
/** Batch live option deltas via /quotes (lighter than a /chains pull).
 *  Returns occSymbol → signed delta, or null when missing/after-hours. */
export async function getOptionDeltas(occSymbols: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (occSymbols.length === 0) return out;
  const params = new URLSearchParams({ symbols: occSymbols.join(','), fields: 'quote' });
  const data = await marketGet<Record<string, any>>(`/marketdata/v1/quotes?${params}`);
  for (const sym of occSymbols) {
    const delta = data?.[sym]?.quote?.delta;
    out.set(sym, typeof delta === 'number' && Math.abs(delta) > 1e-9 ? delta : null);
  }
  return out;
}