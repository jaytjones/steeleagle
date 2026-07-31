/**
 * lib/strategy/iv-basis.ts — v2.6 IV measurement basis (pure, no I/O)
 *
 * WHY THIS EXISTS
 *
 * IV Rank compares today's IV against a 52-week range. That comparison is only
 * meaningful if today's number and every historical number measure the SAME
 * THING. Until 2026-07-31 they did not:
 *
 *   - `currentIv` came from the scanner (`getOptionChain`): the ATM call —
 *     delta closest to 0.50 — of an expiration 28–52 DTE out.
 *   - the 52-week range came from the IV cron, which took
 *     `Object.keys(callExpDateMap)[0]` — the NEAREST expiration, whatever its
 *     DTE, often 0–2 days — and its first strike, with no delta selection and
 *     no index root filter.
 *
 * Near-expiry ATM IV is numerically unstable, so the stored series carried both
 * tails of that instability: 30 zero rows (which dragged `low52w` to 0 and
 * inflated ranks) and implausible highs (SPY 60.6%, QQQ 141.1%, against real
 * 30-day vol nowhere near that) which suppressed ranks. The two errors pull in
 * opposite directions, and the suppression dominated — the likeliest reason the
 * scanner has never green-lit an entry.
 *
 * The v1.2 tech-spec risk table predicted the zero half of this ("Schwab returns
 * IV=0 outside market hours") and recorded a guard as the mitigation. The guard
 * was never implemented. It is implemented now — but the guard alone would only
 * have produced a cleaner series of the wrong measurement.
 *
 * THE BASIS COLUMN
 *
 * Rows on the two bases must never share a min/max window, so `iv_history`
 * carries the basis that produced each row and `calculateIVRank` reads only the
 * current one. Legacy rows are retained (not deleted) — they are the forensic
 * record of the defect, and keeping them costs nothing once they are filtered.
 *
 * The consequence is deliberate and was accepted by the operator on 2026-07-31:
 * every symbol reverts to CALIBRATING until it accumulates
 * MIN_IV_HISTORY_DAYS rows on the new basis (~20 trading days, ~4 weeks). This
 * trades a structurally invalid signal for no signal, then a correct one. The
 * v2.5 override on all verdicts is what makes that survivable — every card stays
 * placeable throughout.
 */

/**
 * The measurement every NEW snapshot uses: ATM call (delta closest to 0.50) of
 * an expiration 28–52 DTE out, index chains filtered to the preferred OCC root.
 *
 * Identical by construction to the scanner's `currentIv`, because the cron now
 * calls the very same `getOptionChain`. If that extraction ever changes in a way
 * that changes what is measured, MINT A NEW BASIS VALUE — do not silently
 * redefine this one, or the range and the current reading drift apart again with
 * nothing in the data to show it.
 */
export const IV_BASIS_CURRENT = 'atm_28_52dte'

/**
 * Everything written before 2026-07-31: nearest expiration, first strike, no
 * delta selection, no root filter. Never used for IV Rank. Retained as evidence.
 */
export const IV_BASIS_LEGACY = 'legacy_front_expiry'

/**
 * A snapshot is written only when the IV is a real, positive measurement.
 *
 * This is the guard the v1.2 risk table claimed existed. Note it must test
 * `<= 0` and not merely `!= null`: the extraction chain is
 * `volatility ?? impliedVolatility ?? null`, and `??` does NOT treat a
 * Schwab-returned `0` as absent, so a zero sails through a null check.
 */
export function isSnapshotWorthStoring(atmIv: number | null | undefined): atmIv is number {
  return typeof atmIv === 'number' && Number.isFinite(atmIv) && atmIv > 0
}
