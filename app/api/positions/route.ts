// ============================================================
// SteelEagle — Positions API Route
// GET /api/positions
// Returns open iron condor positions for SPY, TLT, GLD
// ============================================================

import { NextResponse } from 'next/server'
import { getPositions } from '@/lib/schwab/accounts'

export async function GET() {
  try {
    const positions = await getPositions()
    return NextResponse.json({ positions })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Positions error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
