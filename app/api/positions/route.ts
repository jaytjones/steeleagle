// ============================================================
// SteelEagle — Positions API Route
// GET /api/positions
// Returns reconstructed positions (condors / verticals / others)
// + account balances for the BPR tracker (v1.3)
// ============================================================

import { NextResponse } from 'next/server'
import { getAccountSnapshot } from '@/lib/schwab/accounts'
import { reconstructPositions } from '@/lib/strategy/reconstruct-positions'
import { computeRollAlert } from '@/lib/strategy/roll-alert';
import { getOptionDeltas } from '@/lib/schwab/quotes';

export async function GET() {
  try {
    const { positions: raw, balances } = await getAccountSnapshot()
    const positions = reconstructPositions(raw)

    // v1.3 Item 6 — annotate open condors with roll verdicts (supplementary).
    // Isolated in its own try/catch so a /quotes hiccup never takes down the
    // positions monitor — a failure here just means no roll badges this load.
    try {
      const condors = positions.filter((p) => p.type === 'IRON_CONDOR')
      const deltaMap = await getOptionDeltas(
        condors.flatMap((p) =>
          p.legs.filter((l) => l.action === 'SELL').map((l) => l.occSymbol),
        ),
      )
      for (const p of condors) {
        const shortDeltas = p.legs
          .filter((l) => l.action === 'SELL')
          .map((l) => ({ occSymbol: l.occSymbol, delta: deltaMap.get(l.occSymbol) ?? null }))
        p.rollVerdict = computeRollAlert(p, shortDeltas)
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