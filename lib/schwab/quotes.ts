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
/**
 * Batch live option deltas via /quotes (lighter than a /chains pull).
 * Returns occSymbol → signed delta, or null when missing/after-hours.
 *
 * v2.4 FIX: this built its URL as `/marketdata/v1/quotes?…`, but `marketGet`
 * already prepends `https://api.schwabapi.com/marketdata/v1` — the path segment
 * was duplicated, so every call 404'd. The positions route wraps roll-alert
 * annotation in its own try/catch, so the failure surfaced only as a log line
 * and silently-absent roll badges. `getQuotes` above always used the correct
 * `/quotes` form. Caught while auditing this module as a §5 root-mapping
 * consumer; unrelated to indices, but on the same code path.
 *
 * No symbol translation happens here: these are OCC OPTION symbols, which are
 * root-based and take no `$` prefix. Phase 0 V4 confirmed Schwab accepts
 * `SPXW  260825C07400000` as-is. The `$` form applies only to the UNDERLYING
 * index symbol, which this function never requests.
 */
export async function getOptionDeltas(occSymbols: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (occSymbols.length === 0) return out;
  const data = await marketGet<Record<string, { quote?: { delta?: number } }>>('/quotes', {
    symbols: occSymbols.join(','),
    fields: 'quote',
  });
  for (const sym of occSymbols) {
    const delta = data?.[sym]?.quote?.delta;
    out.set(sym, typeof delta === 'number' && Math.abs(delta) > 1e-9 ? delta : null);
  }
  return out;
}