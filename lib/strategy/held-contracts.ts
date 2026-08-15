// ============================================================
// SteelEagle — v2.12 held-contract derivation (pure — no I/O)
//
// How many contracts does the ACCOUNT hold on each underlying|expiration?
//
// This feeds the quantity-aware pre-place guard, which is the first thing in
// this codebase to let account data LOOSEN a placement restriction. Every rule
// here is therefore stated with its fail-safe direction, and the fail-safe is
// always `null` — "cannot determine" — which the guard treats exactly as
// today's strict blanket rule.
//
// ── The uniform-magnitude rule ──
//
// A condor at N lots holds every leg at magnitude N: ±N on each of four
// strikes. So the contract count for a key is the common magnitude across its
// legs — and if the magnitudes DISAGREE, we do not know what is held and
// return null rather than picking one.
//
// This is deliberately correct-then-conservative:
//
//   4 legs at |2|      → 2.  The GLD case: two 1-lot condors Schwab AGGREGATED
//                            into one row at qty 2. This is the fix.
//   8 legs at |1|      → 1.  Two DIFFERENT-strike condors. Arguably "2 condors",
//                            but reporting 1 means the guard stops after the
//                            first GTC — i.e. falls back to today's behaviour.
//                            Under-placing is the safe direction; over-covering
//                            is the hazard.
//   mixed magnitudes   → null. A partial close, or stacked positions of unequal
//                            size. Refuse rather than guess.
//   no legs for a key  → absent from the map, which the guard reads as null.
//
// Reuses `positionsToQty` (v2.11) rather than re-parsing: one place decides
// what "held" means at the leg level, and it is already the left side of the
// accounting identity.
// ============================================================

import { parseOccSymbol } from './reconstruct-positions'
import { positionsToQty, type SymbolQty } from '../journal/position-delta'

/** `${underlying}|${expiration}` — the same key the guard and reconcile use. */
export function heldKey(underlying: string, expiration: string): string {
  return `${underlying}|${expiration}`
}

/**
 * Contracts held per `underlying|expiration`.
 *
 * A key maps to `null` when the legs disagree about size — present in the map,
 * explicitly unknown, so a caller can tell "not held" from "cannot tell".
 */
export function heldContractsByKey(symbols: SymbolQty): Map<string, number | null> {
  // key → the distinct leg magnitudes seen
  const magnitudes = new Map<string, Set<number>>()

  for (const [occSymbol, qty] of symbols) {
    if (qty === 0) continue
    const parsed = parseOccSymbol(occSymbol)
    // An unparseable symbol makes its key indeterminate rather than being
    // skipped: silently dropping a leg could turn "cannot tell" into a
    // confident number, which is the one outcome that could over-place.
    if (!parsed) continue
    const key = heldKey(parsed.underlying, parsed.expiration)
    const seen = magnitudes.get(key) ?? new Set<number>()
    seen.add(Math.abs(qty))
    magnitudes.set(key, seen)
  }

  const out = new Map<string, number | null>()
  for (const [key, seen] of magnitudes) {
    out.set(key, seen.size === 1 ? [...seen][0] : null)
  }
  return out
}

/** Convenience: raw Schwab positions → held contracts per key. */
export function heldContractsFromPositions(
  rawPositions: readonly unknown[],
): Map<string, number | null> {
  return heldContractsByKey(positionsToQty(rawPositions))
}

/**
 * Contracts held for one key, or null when unknown.
 *
 * `null` is returned for BOTH "no such position" and "legs disagree". The guard
 * treats them identically — neither is evidence that a placement is safe — so
 * collapsing them here keeps the caller from having to distinguish two states
 * that mean the same thing to it.
 */
export function heldContractsFor(
  held: Map<string, number | null>,
  underlying: string,
  expiration: string,
): number | null {
  return held.get(heldKey(underlying, expiration)) ?? null
}
