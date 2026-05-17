// ============================================================
// SteelEagle — Schwab Accounts Service
// Fetches open positions from the Schwab account
// ============================================================

import { traderGet } from './client'
import { sql } from '@/lib/db/client'
import type { OpenPosition } from '@/types'

const PILLARS = ['SPY', 'TLT', 'GLD']

// --------------------------------------------------------
// Get the cached account hash from the database
// --------------------------------------------------------
async function getAccountHash(): Promise<string> {
  const { rows } = await sql`SELECT account_hash FROM accounts WHERE id = 1`
  if (!rows.length) throw new Error('No account hash found — OAuth login required')
  return rows[0].account_hash
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
