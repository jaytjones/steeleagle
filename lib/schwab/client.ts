// ============================================================
// SteelEagle — Schwab API Base Client
// All Schwab API calls go through schwabFetch()
// Automatically injects Bearer token + handles 401s
// ============================================================

import { getAccessToken } from '@/lib/schwab/auth'

const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1'
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1'

// --------------------------------------------------------
// Core fetch wrapper — injects auth, handles errors
// --------------------------------------------------------
async function schwabFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const accessToken = await getAccessToken()

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Schwab API error ${response.status}: ${text}`)
  }

  return response.json()
}

// --------------------------------------------------------
// Market Data endpoints
// --------------------------------------------------------
export function marketGet<T>(path: string, params?: Record<string, string>) {
  const url = new URL(`${MARKET_BASE}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  return schwabFetch<T>(url.toString())
}

// --------------------------------------------------------
// Trader (Accounts/Orders) endpoints
// --------------------------------------------------------
export function traderGet<T>(path: string, params?: Record<string, string>) {
  const url = new URL(`${TRADER_BASE}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  return schwabFetch<T>(url.toString())
}

export function traderPost<T>(path: string, body: unknown) {
  return schwabFetch<T>(`${TRADER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
