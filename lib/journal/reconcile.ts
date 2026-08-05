// ============================================================
// SteelEagle — v2.8 journal ⇄ account reconciliation (pure — no I/O)
//
// Answers ONE question per open trade: does the structure the journal
// CLAIMS match the legs the account actually HOLDS?
//
// Why this exists (2026-08-04): the SPY 2026-08-28 trade was rolled
// 720/740 → 745/765, turning it into an iron butterfly, and the roll was
// never journaled. The account held the butterfly; the journal still read
// 720/740/765/785. The sweep builds close orders FROM THE JOURNAL, so a
// placement would have carried BUY_TO_CLOSE 740P / SELL_TO_CLOSE 720P —
// legs not held. Those close nothing; they OPEN a short put spread.
//
// Nothing in the app could detect it. Every other lifecycle event has a
// fallback that catches a miss later — a missed entry is picked up by
// "Import from Schwab", a missed close by Record Close. A missed ROLL has
// neither: `deduplicateCandidates` matches on underlying + expiration, so
// a rolled position with an unchanged expiration is filtered out as
// `alreadyImported` and its changed strikes are never compared to what is
// journaled. This module is that missing comparison.
//
// REPORT-ONLY, ALWAYS. It never repairs. Repair would mean deciding which
// side is right, and while the ACCOUNT is truth for STRUCTURE, the JOURNAL
// is the only record of PRICES and INTENT — exactly what repairing a missed
// roll needs and what nothing can reconstruct. Inventing them is the
// failure mode this codebase refuses everywhere else.
//
// DECIDED 2026-08-04 (April): when this is wired into the cron, a DRIFT
// finding FLAGS the trade — it does NOT block placement.
//
// The rejected alternative was blocking, which would have made the SPY
// 2026-08-28 mis-placement structurally impossible. It was rejected because
// this module is a heuristic sitting in front of a mechanical safety chain
// that already works: the pre-place guard, the 24-DTE floor, and the
// refuse-don't-guess posture in every builder. Letting a reconciliation false
// positive suppress a legitimate 50% GTC would trade a known, working
// protection for an unproven one. Flagging keeps the operator informed
// without giving this module veto power over live orders.
//
// Consequence to respect when wiring: a DRIFT the operator cannot fully
// resolve (e.g. two identical-strike condors that cannot be journaled as
// separate trades — see the aggregation note below) will re-flag on EVERY
// run. A permanently-on alert trains the operator to ignore the report, which
// is the same trap `countStaleDeltas` avoids by staying silent after hours.
// Suppression or acknowledgement needs a design before this goes in the cron.
// ============================================================

import { currentStructure, structureRefusal, type StructureEvent } from './current-structure'

// --------------------------------------------------------
// Inputs — structural, so `Trade` and `ReconstructedPosition` satisfy
// them without this module importing either concrete type.
// --------------------------------------------------------

export interface ReconcileTrade {
  id: string
  symbol: string
  currentExpiration: string
  contracts: number
  events: StructureEvent[]
}

/** Only the roles a condor comparison needs; other roles are ignored. */
export type ReconcileLegRole =
  | 'LONG_PUT'
  | 'SHORT_PUT'
  | 'SHORT_CALL'
  | 'LONG_CALL'
  | 'LONG'
  | 'SHORT'

export interface ReconcilePosition {
  kind: string // 'IRON_CONDOR' | 'VERTICAL_SPREAD' | 'OTHER'
  underlying: string
  expiration: string | null
  quantity: number
  legs: { role: ReconcileLegRole; strike: number }[]
}

// --------------------------------------------------------
// Output
// --------------------------------------------------------

export type ReconcileStatus =
  /** Journal and account agree on all four strikes and the contract count. */
  | 'MATCH'
  /** Matched by underlying+expiration, but the structures differ. CRITICAL. */
  | 'DRIFT'
  /** Journal says open; the account holds no such position. CRITICAL. */
  | 'PHANTOM'
  /** One side could not be derived. Never counts as healthy. */
  | 'UNCOMPARABLE'
  /** A condor at Schwab with no open journal trade. Informational. */
  | 'UNIMPORTED'

export type ReconcileSeverity = 'critical' | 'warning' | 'info' | 'ok'

export interface Strikes {
  longPut: number
  shortPut: number
  shortCall: number
  longCall: number
}

export interface ReconcileFinding {
  status: ReconcileStatus
  severity: ReconcileSeverity
  symbol: string
  expiration: string
  tradeId: string | null
  journalStrikes: Strikes | null
  accountStrikes: Strikes | null
  journalContracts: number | null
  accountContracts: number | null
  /** Operator-facing explanation. Always populated. */
  detail: string
}

const SEVERITY_RANK: Record<ReconcileSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  ok: 3,
}

/** Strikes come from OCC parsing (÷1000) on one side and operator entry on
 *  the other. Same decimal literals produce the same double, but compare with
 *  a tolerance rather than `===` so a future formatting change can't turn a
 *  healthy trade into a phantom DRIFT alarm. */
const EPS = 1e-6
const sameStrike = (a: number, b: number) => Math.abs(a - b) < EPS

function strikesEqual(a: Strikes, b: Strikes): boolean {
  return (
    sameStrike(a.longPut, b.longPut) &&
    sameStrike(a.shortPut, b.shortPut) &&
    sameStrike(a.shortCall, b.shortCall) &&
    sameStrike(a.longCall, b.longCall)
  )
}

export function formatStrikes(s: Strikes | null): string {
  return s === null ? '—' : `${s.longPut} / ${s.shortPut} / ${s.shortCall} / ${s.longCall}`
}

/** The four condor legs of a reconstructed position, or null if any role is
 *  absent (a vertical, a fragment, anything not a clean four-leg group). */
function positionStrikes(pos: ReconcilePosition): Strikes | null {
  const at = (role: ReconcileLegRole) => pos.legs.find((l) => l.role === role)?.strike
  const longPut = at('LONG_PUT')
  const shortPut = at('SHORT_PUT')
  const shortCall = at('SHORT_CALL')
  const longCall = at('LONG_CALL')
  if (longPut == null || shortPut == null || shortCall == null || longCall == null) return null
  return { longPut, shortPut, shortCall, longCall }
}

const keyOf = (underlying: string, expiration: string) => `${underlying}|${expiration}`

/**
 * Compare every open journal trade against the account's reconstructed
 * positions.
 *
 * @param trades    OPEN journal trades only — a closed trade has no position
 *                  to match and would report as PHANTOM for all of history.
 * @param positions reconstructPositions() output (all kinds; non-condors are
 *                  used only to explain why a match failed).
 * @param now       for deciding whether a PHANTOM is a live hazard or an
 *                  expired-position bookkeeping reminder.
 */
export function reconcileJournal(
  trades: ReconcileTrade[],
  positions: ReconcilePosition[],
  now: Date = new Date(),
): ReconcileFinding[] {
  const findings: ReconcileFinding[] = []

  // ---- Journal-side key collisions ----
  // Two open trades on the same underlying + expiration. Today this silently
  // last-wins in the positions route's Map, and on the account side the 8 legs
  // group into a single OTHER pile (pinned as a KNOWN LIMITATION in
  // reconstruct-positions.test.ts). Both sides degrade, so the honest answer is
  // "cannot compare" — never pick one and report a confident verdict.
  const countByKey = new Map<string, number>()
  for (const t of trades) {
    const k = keyOf(t.symbol, t.currentExpiration)
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1)
  }

  // reconstructPositions groups by underlying+expiration, so at most ONE
  // position can carry a given key — no collision handling needed here.
  const posByKey = new Map<string, ReconcilePosition>()
  for (const p of positions) {
    if (p.expiration === null) continue
    posByKey.set(keyOf(p.underlying, p.expiration), p)
  }

  const matchedKeys = new Set<string>()

  for (const trade of trades) {
    const key = keyOf(trade.symbol, trade.currentExpiration)
    matchedKeys.add(key)

    const base = {
      symbol: trade.symbol,
      expiration: trade.currentExpiration,
      tradeId: trade.id,
      journalContracts: trade.contracts,
    }

    if ((countByKey.get(key) ?? 0) > 1) {
      findings.push({
        ...base,
        status: 'UNCOMPARABLE',
        severity: 'warning',
        journalStrikes: null,
        accountStrikes: null,
        accountContracts: null,
        detail:
          `${countByKey.get(key)} open journal trades share ${trade.symbol} ${trade.currentExpiration} — ` +
          `the account groups their legs into one pile, so neither side can be attributed ` +
          `to a specific trade. Resolve by closing or re-journaling one.`,
      })
      continue
    }

    // ---- Journal side. currentStructure ONLY — never a second fold. ----
    const refusal = structureRefusal(trade.symbol, trade.events)
    if (refusal !== null) {
      const held = posByKey.get(key)
      findings.push({
        ...base,
        status: 'UNCOMPARABLE',
        severity: 'warning',
        journalStrikes: null,
        accountStrikes: held ? positionStrikes(held) : null,
        accountContracts: held?.quantity ?? null,
        detail: `journal structure cannot be derived: ${refusal}`,
      })
      continue
    }
    const js = currentStructure(trade.symbol, trade.events)
    const journalStrikes: Strikes = {
      longPut: js.longPut.strike,
      shortPut: js.shortPut.strike,
      shortCall: js.shortCall.strike,
      longCall: js.longCall.strike,
    }

    // ---- Account side ----
    const pos = posByKey.get(key)
    if (!pos) {
      const expired = Date.parse(`${trade.currentExpiration}T00:00:00Z`) < startOfUtcDay(now)
      findings.push({
        ...base,
        status: 'PHANTOM',
        severity: expired ? 'warning' : 'critical',
        journalStrikes,
        accountStrikes: null,
        accountContracts: null,
        detail: expired
          ? `the journal still lists this trade as OPEN but it expired on ` +
            `${trade.currentExpiration} and the account holds nothing — journal the exit ` +
            `with Record Close.`
          : `the journal lists this trade as OPEN but the account holds NO ${trade.symbol} ` +
            `${trade.currentExpiration} position. The sweep would build a close from these ` +
            `strikes — on legs that are not held, which OPENS a position instead of closing ` +
            `one. Journal the exit (Record Close) or correct the trade.`,
      })
      continue
    }

    const accountStrikes = positionStrikes(pos)
    if (pos.kind !== 'IRON_CONDOR' || accountStrikes === null) {
      findings.push({
        ...base,
        status: 'UNCOMPARABLE',
        severity: 'warning',
        journalStrikes,
        accountStrikes,
        accountContracts: pos.quantity,
        detail:
          `the account's ${trade.symbol} ${trade.currentExpiration} legs did not reconstruct ` +
          `as a four-leg condor (kind=${pos.kind}) — likely a partial close or stacked ` +
          `positions. Compare manually in thinkorswim.`,
      })
      continue
    }

    const strikeMismatch = !strikesEqual(journalStrikes, accountStrikes)
    const contractMismatch = pos.quantity !== trade.contracts

    if (!strikeMismatch && !contractMismatch) {
      findings.push({
        ...base,
        status: 'MATCH',
        severity: 'ok',
        journalStrikes,
        accountStrikes,
        accountContracts: pos.quantity,
        detail: 'journal matches the account.',
      })
      continue
    }

    // The two mismatches fail in genuinely different ways, so they get
    // genuinely different explanations. The first version of this message
    // blamed "an unjournaled roll" for every DRIFT — and the very first live
    // run hit a contracts-only mismatch (GLD 2026-09-18: journal 1, account 2),
    // where that advice is simply wrong.
    const parts: string[] = []
    if (strikeMismatch) {
      parts.push(
        `strikes differ — journal ${formatStrikes(journalStrikes)}, ` +
          `account ${formatStrikes(accountStrikes)}`,
      )
    }
    if (contractMismatch) {
      parts.push(`contracts differ — journal ${trade.contracts}, account ${pos.quantity}`)
    }

    const consequence = strikeMismatch
      ? `The sweep prices GTC closes from the JOURNAL, so it would build legs the account ` +
        `does not hold — those do not close anything, they OPEN a position. Most likely an ` +
        `unjournaled roll: journal it with the Roll form.`
      : // Contracts-only. The legs are right, so nothing wrong gets OPENED — but
        // part of the position goes MISSING from the app, which is worse than it
        // first looks and is spelled out here because nothing else will say it.
        //
        // Two causes are indistinguishable from here, and that is a fact about
        // Schwab, not a gap in this check: identical-strike condors are
        // AGGREGATED into one position row at the summed quantity. Two 1-lots at
        // the same strikes and expiration look exactly like one 2-lot. (Only
        // DIFFERING strikes produce 8 legs, which reconstructPositions drops to
        // OTHER.) Confirmed live on GLD 2026-09-18, 2026-08-04.
        `The legs are correct, so no wrong position is opened — but a standing GTC is sized ` +
        `from the JOURNAL. It would close only ${trade.contracts} of ${pos.quantity} ` +
        `contracts, and the sweep would then journal that as a FULL close (the fill's ` +
        `contract count matches the trade's). The remainder stays open at Schwab with no ` +
        `journal trade, no standing exit and no 21-DTE alert — invisible to the app. ` +
        `Cause is either a SECOND condor at identical strikes (Schwab aggregates those ` +
        `into one position row, so this check cannot tell them apart) or an unjournaled ` +
        `size change. If it is a second trade, journaling it will collide on ` +
        `underlying+expiration — the sweep's pre-place guard and the Monitor's GTC chip ` +
        `both key on that pair, so the second trade's exit must be placed by hand.`

    findings.push({
      ...base,
      status: 'DRIFT',
      severity: 'critical',
      journalStrikes,
      accountStrikes,
      accountContracts: pos.quantity,
      detail: `${parts.join('; ')}. ${consequence}`,
    })
  }

  // ---- Account condors with no open journal trade ----
  for (const pos of positions) {
    if (pos.kind !== 'IRON_CONDOR' || pos.expiration === null) continue
    const key = keyOf(pos.underlying, pos.expiration)
    if (matchedKeys.has(key)) continue
    findings.push({
      status: 'UNIMPORTED',
      severity: 'info',
      symbol: pos.underlying,
      expiration: pos.expiration,
      tradeId: null,
      journalStrikes: null,
      accountStrikes: positionStrikes(pos),
      journalContracts: null,
      accountContracts: pos.quantity,
      detail: `held at Schwab with no open journal trade — use "Import from Schwab" on /journal.`,
    })
  }

  // Most severe first; stable within a severity so output order is deterministic.
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map(({ f }) => f)
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/** Counts by status, for a one-line summary. */
export function summarizeReconciliation(findings: ReconcileFinding[]): {
  match: number
  drift: number
  phantom: number
  uncomparable: number
  unimported: number
  /** Anything that needs action before the next sweep. */
  critical: number
} {
  const count = (s: ReconcileStatus) => findings.filter((f) => f.status === s).length
  return {
    match: count('MATCH'),
    drift: count('DRIFT'),
    phantom: count('PHANTOM'),
    uncomparable: count('UNCOMPARABLE'),
    unimported: count('UNIMPORTED'),
    critical: findings.filter((f) => f.severity === 'critical').length,
  }
}
