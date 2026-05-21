// ============================================================
// SteelEagle — Positions API Route
// GET /api/positions
// Returns reconstructed positions (condors / verticals / others)
// + account balances for the BPR tracker (v1.3)
// ============================================================

import { NextResponse } from 'next/server'
import { getAccountSnapshot } from '@/lib/schwab/accounts'
import { reconstructPositions } from '@/lib/strategy/reconstruct-positions'

export async function GET() {
  try {
    const { positions: raw, balances } = await getAccountSnapshot()
    const positions = reconstructPositions(raw)
    return NextResponse.json({ positions, balances })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Positions error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}