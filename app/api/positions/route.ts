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
import { computeRollAlert, noDeltaVerdict, type RollInputPosition } from '@/lib/strategy/roll-alert'
import { getOptionDeltas } from '@/lib/schwab/quotes'
import { listTrades } from '@/lib/db/journal'
import { buildExitLinks, exitLinksFor } from '@/lib/strategy/exit-links'

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
      const message = rollErr instanceof Error ? rollErr.message : String(rollErr)
      console.error('Roll-alert annotation failed (positions still returned):', message)
      // v2.6.1 — do not let the failure vanish. An unannotated condor renders
      // identically to a healthy one, so a dead /quotes path used to show up as
      // roll badges that quietly never appeared (exactly how the v2.4 duplicated-
      // URL 404 stayed hidden). Stamp NO_DELTA and the monitor shows Δ STALE.
      for (const p of positions) {
        if (p.kind === 'IRON_CONDOR' && !p.rollVerdict) {
          p.rollVerdict = noDeltaVerdict(p.underlying, `Delta fetch failed: ${message}`)
        }
      }
    }

    // v2.2 §4.4 — annotate condors with their journal-trade linkage (standing
    // GTC id / rolled flag / mechanical 50% target). Isolated the same way:
    // a journal read failure just means no GTC chips this load.
    //
    // EVERY matching trade, not one: two same-strike condors are aggregated
    // into a single Schwab row, and the old `new Map(...)` kept only the last
    // trade on a key — so one of the two live GTCs was invisible here. The
    // grouping and pricing now live in lib/strategy/exit-links.ts.
    try {
      const byKey = buildExitLinks(await listTrades({ status: 'open' }))
      for (const p of positions) {
        if (p.kind !== 'IRON_CONDOR' || p.expiration === null) continue
        const links = exitLinksFor(byKey, p.underlying, p.expiration)
        if (links.length === 0) continue
        p.journalExits = links
      }
    } catch (journalErr) {
      console.error(
        'Journal-exit annotation failed (positions still returned):',
        journalErr instanceof Error ? journalErr.message : String(journalErr),
      )
    }

    return NextResponse.json({ positions, balances })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Positions error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}