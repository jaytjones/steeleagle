// ============================================================
// SteelEagle — v2.11 position delta (pure — no I/O)
//
// One half of April's accounting identity (spec §2):
//
//     positions(T₀)  +  Σ order effects in (T₀, T₁]  ==  positions(T₁)
//
// This module produces the LEFT side: what the account actually holds, and
// how it changed between two snapshots.
//
// ── Why this diffs OCC symbols and not condors ──
//
// `groupIntoCondors` bails to `IncompletePosition` on anything non-textbook —
// a partial close, stacked positions, eight legs. That is correct for an
// importer, which must refuse to guess a structure. It is WRONG here: a diff
// that can fail to produce an answer cannot anchor a completeness proof.
//
// A symbol→quantity map has no failure mode. Every option position is one
// entry, every change is a signed number, and nothing needs to be recognised
// as anything. The diff layer is deliberately DUMBER than the grouping layer
// and therefore more reliable (spec §4).
//
// Note that nothing here parses an OCC symbol. Keying on the raw symbol string
// means a symbol this codebase cannot parse still diffs correctly — it simply
// appears on both sides and cancels. Parsing happens later, in balance.ts, and
// only for symbols that actually turn up in a residual.
//
// ── Sign convention ──
//
// Positive = net long, negative = net short. This is the same convention
// `signedQty` uses in reconstruct-positions.ts, and it is what makes order
// effects ADD to positions rather than needing a case analysis: buying
// increases the signed quantity, selling decreases it, whether the leg is
// opening or closing (see order-effects.ts).
// ============================================================

/** occSymbol → signed net contracts. Positive = long, negative = short. */
export type SymbolQty = ReadonlyMap<string, number>

/** Narrow Schwab position shape — only what the map needs. */
interface RawPosition {
  instrument?: {
    assetType?: string
    symbol?: string
  }
  longQuantity?: number
  shortQuantity?: number
}

/**
 * Flatten a raw Schwab positions array to occSymbol → signed net quantity.
 *
 * Non-option rows are skipped (equity assignment residue is real, but it is
 * not an option leg and cannot participate in an option-leg identity).
 *
 * A net-zero option row is OMITTED rather than stored as 0, so that "absent"
 * and "zero" are the same state on both sides of a diff. Without that rule the
 * same holding could compare unequal depending on whether Schwab happened to
 * return a flat row.
 */
export function positionsToQty(rawPositions: readonly unknown[]): SymbolQty {
  const out = new Map<string, number>()

  for (const raw of rawPositions) {
    const p = raw as RawPosition
    const ins = p?.instrument
    if (!ins || ins.assetType !== 'OPTION' || !ins.symbol) continue

    const net = (p.longQuantity ?? 0) - (p.shortQuantity ?? 0)
    if (net === 0) continue

    // Schwab returns one row per symbol, but sum defensively rather than
    // last-wins: a duplicated row would otherwise silently discard quantity.
    out.set(ins.symbol, (out.get(ins.symbol) ?? 0) + net)
  }

  // A summed pair can cancel to zero; drop those so the invariant above holds.
  for (const [symbol, qty] of out) if (qty === 0) out.delete(symbol)

  return out
}

/**
 * `after` − `before`, over the union of both key sets.
 *
 * Entries that did not change are omitted, so an empty result means "the
 * account is structurally identical" — which is the common case on a day with
 * no activity and must be cheap and unambiguous to express.
 */
export function diffPositions(before: SymbolQty, after: SymbolQty): SymbolQty {
  const out = new Map<string, number>()

  for (const symbol of new Set([...before.keys(), ...after.keys()])) {
    const change = (after.get(symbol) ?? 0) - (before.get(symbol) ?? 0)
    if (change !== 0) out.set(symbol, change)
  }

  return out
}

/** Add two symbol maps, dropping entries that cancel to zero. */
export function addQty(a: SymbolQty, b: SymbolQty): SymbolQty {
  const out = new Map<string, number>()

  for (const symbol of new Set([...a.keys(), ...b.keys()])) {
    const sum = (a.get(symbol) ?? 0) + (b.get(symbol) ?? 0)
    if (sum !== 0) out.set(symbol, sum)
  }

  return out
}

/** `a` − `b`, dropping entries that cancel to zero. The residual operator. */
export function subtractQty(a: SymbolQty, b: SymbolQty): SymbolQty {
  const out = new Map<string, number>()

  for (const symbol of new Set([...a.keys(), ...b.keys()])) {
    const diff = (a.get(symbol) ?? 0) - (b.get(symbol) ?? 0)
    if (diff !== 0) out.set(symbol, diff)
  }

  return out
}

/**
 * jsonb round-trip for `position_snapshots.symbols`.
 *
 * A plain object, not an array of pairs: jsonb reorders object keys on storage
 * (confirmed live 2026-08-07 on sweep_runs.report), and a Map rebuilt from an
 * object is order-insensitive by construction — so a stored snapshot and a
 * fresh one compare equal structurally even though their JSON text differs.
 */
export function qtyToJson(q: SymbolQty): Record<string, number> {
  return Object.fromEntries(q)
}

export function qtyFromJson(raw: unknown): SymbolQty {
  const out = new Map<string, number>()
  if (raw === null || typeof raw !== 'object') return out
  for (const [symbol, qty] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof qty === 'number' && Number.isFinite(qty) && qty !== 0) out.set(symbol, qty)
  }
  return out
}

/** Stable, human-readable rendering for reports and test failures. */
export function formatQty(q: SymbolQty): string {
  if (q.size === 0) return '(empty)'
  return [...q.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, qty]) => `${symbol} ${qty > 0 ? '+' : ''}${qty}`)
    .join(', ')
}
