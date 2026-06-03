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

  // Read the body once as text so empty / non-JSON bodies don't blow up with the
  // cryptic "Unexpected end of JSON input" that response.json() throws on an empty
  // 2xx (e.g. a 204, or an empty 200 from a trader endpoint). The URL is included
  // in every error so the failing call is identifiable in logs / the UI.
  const body = await response.text()

  if (!response.ok) {
    throw new Error(`Schwab API error ${response.status} on ${url}: ${body || '(empty body)'}`)
  }

  if (!body.trim()) {
    throw new Error(
      `Schwab API ${response.status} on ${url}: empty response body. The call ` +
        `succeeded HTTP-wise but returned nothing — usual causes are a stale/invalid ` +
        `account hash or the app's "Accounts and Trading" product not being authorized.`,
    )
  }

  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(
      `Schwab API ${response.status} on ${url}: response was not valid JSON: ${body.slice(0, 200)}`,
    )
  }
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
