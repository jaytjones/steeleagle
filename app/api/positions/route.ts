// ============================================================
// SteelEagle — Positions API Route
// GET /api/positions
// Returns reconstructed positions (condors / verticals / others)
// + account balances for the BPR tracker (v1.3)
// + per-condor roll verdicts (v1.3 item 6)
// ============================================================

import { NextResponse } from 'next/server'
import { getAccountSnapshot } from '@/lib/schwab/accounts'
import {
  reconstructPositions,
  type ReconstructedPosition,
} from '@/lib/strategy/reconstruct-positions'
import { computeRollAlert, type RollInputPosition } from '@/lib/strategy/roll-alert'
import { getOptionDeltas } from '@/lib/schwab/quotes'

/** Adapt a reconstructed condor to roll-alert's structural input shape.
 *  (underlying → symbol, kind → type, signed quantity → BUY/SELL, putCall → type) */
function toRollInput(p: ReconstructedPosition): RollInputPosition {
  return {
    symbol: p.underlying,
    type: p.kind,
    legs: p.legs.map((l) => ({
      action: l.quantity < 0 ? 'SELL' : 'BUY',
      type: l.putCall,
      occSymbol: l.occSymbol,
    })),
  }
}

export async function GET() {
  try {
    const { positions: raw, balances } = await getAccountSnapshot()
    const positions = reconstructPositions(raw)

    // v1.3 Item 6 — annotate open condors with roll verdicts (supplementary).
    // Isolated in its own try/catch so a /quotes hiccup never takes down the
    // positions monitor — a failure here just means no roll badges this load.
    try {
      const condors = positions.filter((p) => p.kind === 'IRON_CONDOR')
      const deltaMap = await getOptionDeltas(
        condors.flatMap((p) =>
          p.legs.filter((l) => l.quantity < 0).map((l) => l.occSymbol),
        ),
      )
      for (const p of condors) {
        const shortDeltas = p.legs
          .filter((l) => l.quantity < 0)
          .map((l) => ({ occSymbol: l.occSymbol, delta: deltaMap.get(l.occSymbol) ?? null }))
        p.rollVerdict = computeRollAlert(toRollInput(p), shortDeltas)
      }
    } catch (rollErr) {
      console.error(
        'Roll-alert annotation failed (positions still returned):',
        rollErr instanceof Error ? rollErr.message : String(rollErr),
      )
    }

    return NextResponse.json({ positions, balances })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Positions error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}