// ============================================================
// SteelEagle — Schwab Accounts Service
// Fetches open positions from the Schwab account
// ============================================================

import { traderGet } from './client'
import { sql } from '@/lib/db/client'
import type { OpenPosition } from '@/types'
// alias — avoids colliding with the local SchwabPosition already declared in this file
import type { SchwabPosition as ReconInputPosition } from '@/lib/strategy/reconstruct-positions'
import type { SchwabBalances } from '@/lib/strategy/bpr'

export type AccountSnapshot = {
  positions: ReconInputPosition[]
  balances: SchwabBalances
}

const PILLARS = ['SPY', 'TLT', 'GLD']

// --------------------------------------------------------
// Get the cached account hash from the database
// --------------------------------------------------------
export async function getAccountHash(): Promise<string> {
  const { rows } = await sql`SELECT account_hash FROM accounts WHERE id = 1`
  if (!rows.length) throw new Error('No account hash found — OAuth login required')
  return rows[0].account_hash
}

type AccountNumbersEntry = { accountNumber: string; hashValue: string }

// --------------------------------------------------------
// Re-pull the hashed account number from Schwab and persist it.
// Single source of truth for writing the accounts row — used by the OAuth
// callback and by the self-healing retry in getAccountSnapshot below.
// Throws if Schwab returns no account hash.
// --------------------------------------------------------
export async function refreshAccountHash(): Promise<string> {
  const entries = await traderGet<AccountNumbersEntry[]>('/accounts/accountNumbers')
  const hashValue = entries?.[0]?.hashValue
  if (!hashValue) {
    throw new Error('Schwab /accounts/accountNumbers returned no account hash')
  }

  const now = new Date().toISOString()
  await sql`
    INSERT INTO accounts (id, account_hash, updated_at)
    VALUES (1, ${hashValue}, ${now})
    ON CONFLICT (id) DO UPDATE SET
      account_hash = EXCLUDED.account_hash,
      updated_at = EXCLUDED.updated_at
  `
  return hashValue
}

// --------------------------------------------------------
// Schwab API position shape
// --------------------------------------------------------
interface SchwabInstrument {
  symbol: string
  description: string
  assetType: 'EQUITY' | 'OPTION' | 'MUTUAL_FUND' | 'FIXED_INCOME' | 'CASH_EQUIVALENT'
  putCall?: 'PUT' | 'CALL'
  underlyingSymbol?: string
  expirationDate?: string
  strikePrice?: number
}

interface SchwabPosition {
  instrument: SchwabInstrument
  longQuantity: number
  shortQuantity: number
  marketValue: number
  averagePrice: number
  currentDayProfitLoss: number
  currentDayProfitLossPercentage: number
  maintenanceRequirement?: number
}

interface SchwabAccount {
  securitiesAccount: {
    positions?: SchwabPosition[]
    currentBalances?: {
      liquidationValue: number
      buyingPower: number
    }
  }
}

// --------------------------------------------------------
// Fetch and normalize open positions for our pillars
// --------------------------------------------------------
export async function getPositions(): Promise<OpenPosition[]> {
  const hash = await getAccountHash()

  const account = await traderGet<SchwabAccount>(`/accounts/${hash}`, {
    fields: 'positions',
  })

  const rawPositions = account?.securitiesAccount?.positions ?? []

  // Filter for option positions on SPY, TLT, or GLD
  return rawPositions
    .filter(p =>
      p.instrument.assetType === 'OPTION' &&
      PILLARS.some(pillar =>
        p.instrument.symbol.startsWith(pillar) ||
        p.instrument.underlyingSymbol === pillar
      )
    )
    .map(p => ({
      symbol: p.instrument.symbol,
      description: p.instrument.description,
      quantity: p.longQuantity > 0 ? p.longQuantity : -p.shortQuantity,
      marketValue: p.marketValue,
      averageCost: p.averagePrice,
      unrealizedPL: p.currentDayProfitLoss,
      unrealizedPLPercent: p.currentDayProfitLossPercentage,
    }))
}
// Raw account fetch — ALL legs (no pillar filter, no lossy flatten) + balances.
// Powers reconstruction + BPR tracker (v1.3). getPositions() is left as-is.
export async function getAccountSnapshot(): Promise<AccountSnapshot> {
  let hash = await getAccountHash()

  let account: SchwabAccount
  try {
    account = await fetchAccountByHash(hash)
  } catch (err) {
    // A stale / mismatched hash makes Schwab return HTTP 200 with an EMPTY body,
    // which client.ts::schwabFetch surfaces as an "empty response body" error
    // (the Session-7 outage signature). Self-heal: re-pull the hash once and
    // retry before surfacing the failure, instead of letting it 500 / render
    // as a falsely-empty account.
    if (isStaleHashError(err)) {
      console.warn(
        'getAccountSnapshot — empty account body (likely stale hash); refreshing hash and retrying once',
      )
      hash = await refreshAccountHash()
      account = await fetchAccountByHash(hash)
    } else {
      throw err
    }
  }

  const sa = account?.securitiesAccount
  // Bridge this file's local SchwabPosition to the strategy module's input shape —
  // same Schwab payload, two declarations (see cleanup note below).
  const positions = (sa?.positions ?? []) as unknown as ReconInputPosition[]
  const liquidationValue =
    (sa as { currentBalances?: { liquidationValue?: number } })
      ?.currentBalances?.liquidationValue ?? 0

  return { positions, balances: { liquidationValue } }
}

async function fetchAccountByHash(hash: string): Promise<SchwabAccount> {
  return traderGet<SchwabAccount>(`/accounts/${hash}`, { fields: 'positions' })
}

/**
 * True when an error is the stale/invalid-hash signature: Schwab returns 200 +
 * empty body, which client.ts::schwabFetch throws as "...empty response body...".
 * Kept deliberately narrow so a 401/403/etc. does NOT trigger a hash-refresh loop.
 * Coupled to schwabFetch's wording — update here if that message changes.
 */
function isStaleHashError(err: unknown): boolean {
  return err instanceof Error && /empty response body/i.test(err.message)
}