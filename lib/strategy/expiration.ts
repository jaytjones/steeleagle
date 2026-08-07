// ============================================================
// SteelEagle — Expiration Selection (v2.10, pure — no I/O)
//
// WHY THIS EXISTS (2026-08-07)
//
// `getOptionChain` picked ONE expiration and handed it to two consumers that
// want different things:
//
//   - the SCANNER wants a TRADEABLE tenor — the strategy's 30–45 DTE window,
//     monthly preferred.
//   - the IV CRON wants a STABLE MEASUREMENT — the same tenor rule every day,
//     forever, so today's `currentIv` and the stored 52-week range are the
//     same thing (v2.6; see lib/strategy/iv-basis.ts).
//
// The old rule — "nearest expiration within 28–52 DTE" — served the second
// purpose well and the first badly: on 2026-08-07 it proposed SPY/GLD at
// 2026-09-04, **28 DTE**, below the strategy's 30-day floor.
//
// THE TRAP, and why these are two functions and not one.
//
// `atmIv` is read off whichever expiration is selected. Changing the selection
// therefore changes the IV MEASUREMENT, and iv-basis.ts leaves standing orders
// about that: "if that extraction ever changes in a way that changes what is
// measured, MINT A NEW BASIS VALUE." Minting one resets every symbol to
// CALIBRATING for 20 trading days — on 2026-08-07 that meant discarding 5 days
// × 28 symbols and pushing the first usable IV Rank from ~Aug 27 to ~Sep 10.
//
// It would also make the IV signal WORSE. A monthly-preferred window samples a
// tenor that jumps (42 DTE, then a 30–45 weekly once the monthly ages out),
// and IV term structure means that inconsistency is noise in the 52-week range.
// "Nearest ≥ 28" is tenor-stable, which is exactly what a range wants.
//
// So the two selections are DECOUPLED (April, 2026-08-07). The IV rule below is
// today's rule extracted VERBATIM — `IV_BASIS_CURRENT` stays 'atm_28_52dte' and
// no recalibration is owed. 30–45 ⊂ 28–52, so both picks come out of the SAME
// fetch: no extra Schwab call, and the fetch parameters do not change at all.
//
// DO NOT "simplify" these back into one selection. They agree today by
// coincidence of the window, not by design.
// ============================================================

/** The strategy's tradeable window (§5). Below 30 the trade has too little
 *  runway above PLACEMENT_MIN_DTE = 24 before the 21-DTE exit alert. */
export const CONDOR_DTE_MIN = 30
export const CONDOR_DTE_MAX = 45

/**
 * Where in the window to aim when NO monthly is available.
 *
 * The midpoint (April, 2026-08-07) — a balance between decay rate and runway.
 * A 30-DTE entry sits only 6 days above the 24-DTE GTC-placement floor; a
 * 45-DTE entry gives the most room but the slowest early theta.
 */
export const CONDOR_DTE_TARGET = (CONDOR_DTE_MIN + CONDOR_DTE_MAX) / 2 // 37.5

/**
 * The IV measurement window. **Do not change without minting a new
 * `IV_BASIS_CURRENT`** — see the header and lib/strategy/iv-basis.ts.
 */
export const IV_DTE_MIN = 28
export const IV_DTE_MAX = 52

export interface ExpirationCandidate {
  /** Schwab's `callExpDateMap` key, "YYYY-MM-DD:DTE". */
  key: string
  /** YYYY-MM-DD. */
  date: string
  dte: number
  isMonthly: boolean
}

/**
 * Is this Schwab expirationType the monthly (standard) one?
 *
 * **PROBE-PINNED 2026-08-07: the monthly is `"S"` (standard), NOT `"M"`.**
 * Verified live across ETFs and indices — SPY, GLD, TLT, XSP and SPX all
 * return "S" at 2026-09-18 and "W" at every surrounding weekly. Guessing "M"
 * from the docs would have produced a preference that silently never fires,
 * which is indistinguishable from "no monthly is available". Schwab doctrine:
 * never build from docs alone.
 */
export function isMonthlyExpirationType(expirationType: string | null | undefined): boolean {
  return expirationType === 'S'
}

/**
 * IV-measurement preference order: nearest first within 28–52 DTE.
 *
 * This is the pre-v2.10 rule, extracted unchanged. It is the definition of
 * basis `atm_28_52dte`. Changing it is a live IV-history change, not a
 * refactor.
 *
 * Returns an ORDERED list rather than one pick so the caller can walk it and
 * skip any expiration left empty by the index root filter — the fall-through
 * v2.4 added for AM-root monthlies.
 */
export function orderIvCandidates<T extends ExpirationCandidate>(candidates: T[]): T[] {
  return candidates
    .filter((e) => e.dte >= IV_DTE_MIN && e.dte <= IV_DTE_MAX)
    .sort((a, b) => a.dte - b.dte)
}

/**
 * Condor preference order within 30–45 DTE.
 *
 *   1. MONTHLY WINS ANYWHERE IN RANGE (April, 2026-08-07). A monthly at 31 DTE
 *      beats a weekly at 44 — monthlies carry the deeper book and the tighter
 *      spreads, and one rule is easier to reason about than a tolerance band.
 *   2. Otherwise closest to CONDOR_DTE_TARGET (37.5).
 *   3. Ties break LONGER. Equidistant 35 vs 40 → 40: more runway above the
 *      24-DTE placement floor, and the tie must be deterministic or the
 *      scanner's proposal would wobble between refreshes.
 *
 * Anything outside 30–45 is EXCLUDED, not down-ranked — "only propose condors
 * within that range" (April). An empty result means refuse, not fall back.
 */
export function orderCondorCandidates<T extends ExpirationCandidate>(candidates: T[]): T[] {
  return candidates
    .filter((e) => e.dte >= CONDOR_DTE_MIN && e.dte <= CONDOR_DTE_MAX)
    .sort((a, b) => {
      if (a.isMonthly !== b.isMonthly) return a.isMonthly ? -1 : 1
      const da = Math.abs(a.dte - CONDOR_DTE_TARGET)
      const db = Math.abs(b.dte - CONDOR_DTE_TARGET)
      if (da !== db) return da - db
      return b.dte - a.dte // tie → the longer-dated one
    })
}

/**
 * Why no condor could be proposed — shown to the operator instead of a card
 * that silently renders nothing.
 *
 * A missing proposal and a healthy one must never look the same. That is the
 * v2.6.1 rule, and it applies to the scanner exactly as it applied to the roll
 * badge and the sweep report.
 */
export function noCondorReason(candidates: ExpirationCandidate[]): string {
  const inWindow = candidates.filter(
    (e) => e.dte >= CONDOR_DTE_MIN && e.dte <= CONDOR_DTE_MAX,
  )
  if (inWindow.length > 0) return '' // there WAS one; the builder refused for another reason

  const near = candidates
    .filter((e) => e.dte > 0)
    .sort(
      (a, b) =>
        Math.abs(a.dte - CONDOR_DTE_TARGET) - Math.abs(b.dte - CONDOR_DTE_TARGET),
    )[0]

  return (
    `No expiration in the ${CONDOR_DTE_MIN}–${CONDOR_DTE_MAX} DTE window` +
    (near ? ` (nearest available: ${near.date} at ${near.dte} DTE)` : '') +
    `. Not proposing a condor outside the strategy's tenor.`
  )
}
