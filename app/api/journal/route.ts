// ============================================================
// SteelEagle — Trade Journal API
// GET /api/journal              — all trades (newest first) with event logs
// GET /api/journal?status=open  — only open / only closed
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { listTrades } from '@/lib/db/journal'

export async function GET(request: NextRequest) {
  try {
    const statusParam = request.nextUrl.searchParams.get('status')
    const status =
      statusParam === 'open' || statusParam === 'closed' ? statusParam : undefined

    const trades = await listTrades({ status })
    return NextResponse.json({ trades, timestamp: new Date().toISOString() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/journal error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
