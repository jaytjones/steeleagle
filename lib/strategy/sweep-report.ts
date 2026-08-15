// ============================================================
// SteelEagle — Sweep Run Summary (v2.9)
//
// WHY THIS EXISTS (2026-08-07)
//
// Between Aug 4 and Aug 6 the sweep detected a real, live-money fault on
// SPY 2026-09-11 — an unjournaled roll (journal 725/740, account 735/750) —
// and behaved perfectly at every step: reconciliation raised a CRITICAL
// DRIFT, the placement path built the GTC from the stale journal, Schwab
// REJECTED it ("oversold/overbought"), and the route correctly refused to
// store the id (route.ts §place, immediate-status confirm).
//
// It did all of that THREE RUNS IN A ROW and April never saw any of it,
// because `ExitSweepReport` is the HTTP response body of a cron invocation
// and nothing persists or renders it. Detection worked; delivery did not.
//
// That is the v2.6.1 lesson one layer further out. v2.6.1 fixed "healthy and
// no-opinion render identically" INSIDE the app. This fixes "the sweep
// screamed and the app never listened."
//
// THE WALLPAPER HAZARD, and why severity is explicit rather than inferred.
//
// `flagged[]` is not homogeneous. Two of the planner's flag sites are
// permanent steady state by design — a multi-root index (SPX/NDX/RUT) and a
// diagonal BOTH refuse auto-placement on every run, forever, and that is the
// correct, decided behaviour (v2.4). If those counted as critical, the banner
// would be red from the day April opens an SPX condor until the day she
// closes it, and a red banner that is always red is exactly as useful as no
// banner. That is the same failure this module exists to fix, inverted.
//
// The fix is NOT to string-match the reason text — reasons are prose written
// for a human and re-wording one must never silently re-classify it. Severity
// is stamped at the PRODUCER, which knows precisely which branch it took.
// `routine` means "expected steady state, nothing changed"; `critical` means
// "something needs eyes." See SweepFlag.
//
// FAIL-SAFE DIRECTION: `severity` is required, not optional-with-default. A
// new flag site cannot be added without deciding which it is — the compiler
// asks. A default would answer that question by accident.
// ============================================================

import type { IngestionReport } from '../journal/ingest'

/** Run-level verdict. `ok` means the sweep ran and found nothing to say. */
export type SweepSeverity = 'critical' | 'warning' | 'ok'

/**
 * Per-flag severity, stamped where the flag is created.
 *
 * - `critical` — something changed or broke and needs the operator's eyes.
 * - `routine` — a known, decided, permanent refusal (multi-root index,
 *   diagonal). Expected on every run; counted, never escalated.
 */
export type FlagSeverity = 'critical' | 'routine'

export interface SweepFlag {
  tradeId: string | null
  orderId: string | null
  reason: string
  severity: FlagSeverity
}

/**
 * Severity for the planner's "this trade is not priceable" flag.
 *
 * This branch is the one place where routine and critical genuinely mix, and
 * getting it wrong costs something either way:
 *
 *  - A multi-root index (SPX/NDX/RUT) and an unpinned order fixture are
 *    SYMBOL-level refusals. They are permanent, decided (v2.4), and fire on
 *    every run for the life of the trade. Critical would mean a red banner
 *    from the day April opens an SPX condor to the day she closes it.
 *
 *  - Every other refusal is STRUCTURAL — a diagonal, a leg rolled closed and
 *    never reopened, or strikes not ordered LP < SP <= SC < LC. That last one
 *    is the v2.7 defect class: it means the event log describes something the
 *    builder can never price, and before v2.7 it produced `report.errors`
 *    every sweep, forever, with no exit placed. Those must stay critical.
 *
 * Decided by the instrument registry — the single source of truth for
 * symbol-level facts (v2.4) — never by matching the refusal prose, which is
 * written for a human and may be re-worded.
 */
export function unpriceableFlagSeverity(
  symbol: string,
  registry: { ambiguousRoot: boolean; fixturePinned: boolean },
): FlagSeverity {
  return registry.ambiguousRoot || !registry.fixturePinned ? 'routine' : 'critical'
}

/**
 * The sweep's audit record. Moved here from the cron route in v2.9 so the
 * report shape and the rules that read it live together — the route is glue.
 */
export interface ExitSweepReport {
  reconciled: Array<{ tradeId: string; symbol: string; orderId: string }>
  cleared: Array<{ tradeId: string; orderId: string; reason: string }>
  alerts: Array<{ tradeId: string; symbol: string; dte: number; message: string }>
  placed: Array<{ tradeId: string; symbol: string; orderId: string; price: string }>
  flagged: SweepFlag[]
  errors: string[]
  placementPaused: boolean
  wouldHavePlaced: Array<{ tradeId: string; symbol: string; targetDebit: string | null }>
  reconciliation: {
    ran: boolean
    reason?: string
    critical: number
    summary?: Record<string, number>
    findings: Array<{
      status: string
      symbol: string
      expiration: string
      tradeId: string | null
      detail: string
    }>
  }
  /**
   * v2.11 — fill-ledger ingestion and the position identity.
   *
   * Like `reconciliation`, this is OBSERVATION, not control: nothing in the
   * placement path may read it, and `ran: false` is not "nothing found".
   *
   * Reports persisted before v2.11 have no such field, so every read here is
   * optional-chained even though the route always sets it.
   */
  ingestion?: IngestionReport
}

export interface SweepRunSummary {
  severity: SweepSeverity
  criticalCount: number
  warningCount: number
  /** One line for a collapsed banner. Never empty. */
  headline: string
  /** Every critical, verbatim, most-urgent-first. Empty when none. */
  criticalLines: string[]
  /** Non-critical things worth a glance — routine refusals, 21-DTE, pause. */
  warningLines: string[]
}

/**
 * Classify one sweep run.
 *
 * Counting rule, deliberately structural — no reason-string inspection:
 *
 *   CRITICAL   every errors[] entry
 *              every flagged[] entry stamped `critical`
 *              reconciliation.ran === false
 *   WARNING    every flagged[] entry stamped `routine`
 *              every 21-DTE alert
 *              placementPaused === true
 *
 * `reconciliation.critical` is NOT counted here. Those findings are already
 * pushed into `flagged` as `critical` by the route (with the RECONCILIATION
 * prefix); counting both would double every drift.
 */
export function summarizeSweepRun(report: ExitSweepReport): SweepRunSummary {
  const criticalLines: string[] = []
  const warningLines: string[] = []

  // Errors first — a sweep that failed outranks anything it managed to notice.
  for (const e of report.errors) criticalLines.push(`SWEEP ERROR — ${e}`)

  for (const f of report.flagged) {
    if (f.severity === 'critical') criticalLines.push(f.reason)
    else warningLines.push(f.reason)
  }

  // `ran: false` is NOT "nothing found" (v2.8.1, and the /quotes 404 before
  // it). An absent warning must never be indistinguishable from a clean bill.
  // The route also pushes a `critical` flag for this; that flag is the detail
  // line, this is the guarantee — if the push site is ever changed or removed,
  // a non-run still cannot be reported as healthy.
  if (!report.reconciliation.ran && !hasReconciliationDidNotRunFlag(report)) {
    criticalLines.push(
      `RECONCILIATION DID NOT RUN${
        report.reconciliation.reason ? ` (${report.reconciliation.reason})` : ''
      } — this is NOT a clean bill of health.`,
    )
  }

  // v2.11 — the same guarantee, for the same reason. The route pushes an
  // `INGESTION DID NOT RUN` critical flag; this is the backstop if that push
  // site is ever changed or removed. A pass that threw must never be summarised
  // as healthy just because it recorded no findings — it recorded nothing at all.
  //
  // Deliberately NOT triggered by a MISSING `ingestion` block: reports written
  // before v2.11 legitimately have none, and re-summarising history must not
  // retroactively invent a fault.
  if (report.ingestion && !report.ingestion.ran && !hasIngestionDidNotRunFlag(report)) {
    criticalLines.push(
      `INGESTION DID NOT RUN${
        report.ingestion.reason ? ` (${report.ingestion.reason})` : ''
      } — this is NOT a clean bill of health.`,
    )
  }

  for (const a of report.alerts) warningLines.push(a.message)

  // A forgotten pause is a silent state: exits stop being placed and nothing
  // else says so. Surfacing it is the whole point of this module.
  if (report.placementPaused) {
    warningLines.push(
      `Exit placement is PAUSED — ${report.wouldHavePlaced.length} GTC(s) withheld this run.`,
    )
  }

  const criticalCount = criticalLines.length
  const warningCount = warningLines.length
  const severity: SweepSeverity =
    criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'ok'

  return {
    severity,
    criticalCount,
    warningCount,
    headline: buildHeadline(severity, criticalCount, warningCount, report),
    criticalLines,
    warningLines,
  }
}

/**
 * The route already emits a `critical` flag when reconciliation fails. Detect
 * it structurally-enough to avoid a duplicate line without making the guard
 * above depend on that push site still existing.
 */
function hasReconciliationDidNotRunFlag(report: ExitSweepReport): boolean {
  return report.flagged.some(
    (f) => f.severity === 'critical' && f.reason.startsWith('RECONCILIATION DID NOT RUN'),
  )
}

/** The v2.11 twin of the above — same duplicate-line avoidance, same caveat. */
function hasIngestionDidNotRunFlag(report: ExitSweepReport): boolean {
  return report.flagged.some(
    (f) => f.severity === 'critical' && f.reason.startsWith('INGESTION DID NOT RUN'),
  )
}

function buildHeadline(
  severity: SweepSeverity,
  criticalCount: number,
  warningCount: number,
  report: ExitSweepReport,
): string {
  if (severity === 'critical') {
    return `${criticalCount} CRITICAL${warningCount > 0 ? `, ${warningCount} warning` : ''} — needs your eyes`
  }
  if (severity === 'warning') {
    return `${warningCount} warning${warningCount === 1 ? '' : 's'}`
  }
  const did: string[] = []
  if (report.placed.length > 0) did.push(`placed ${report.placed.length}`)
  if (report.reconciled.length > 0) did.push(`journaled ${report.reconciled.length}`)
  if (report.cleared.length > 0) did.push(`cleared ${report.cleared.length}`)
  return did.length > 0 ? `Clean — ${did.join(', ')}` : 'Clean — nothing to do'
}

// --------------------------------------------------------
// Freshness — "did the cron actually fire?"
//
// Vercel Hobby crons are best-effort, not guaranteed. Observed live: the
// Aug 4 run landed 21:17 UTC, Aug 5 and Aug 6 both at 22:05 UTC — 50 minutes
// of drift off the 21:15 schedule. A cron that stops firing entirely produces
// NO report, and "no report" is the one state a report-rendering banner cannot
// show. Freshness is derived from the clock instead, so silence is visible.
//
// NO HOLIDAY CALENDAR, by the same deliberate choice as `isRegularMarketHours`
// (v2.6.1). It needs none: the Vercel cron is weekday-based, not market-based,
// so it fires on Thanksgiving too and a holiday cannot produce a false alarm.
// --------------------------------------------------------

/** vercel.json: "15 21 * * 1-5". Vercel crons are UTC-only. */
export const CRON_HOUR_UTC = 21
export const CRON_MINUTE_UTC = 15

/**
 * Missed runs tolerated before calling the sweep stale.
 *
 * 1 would be correct in principle and false-alarm in practice: with ~50 min of
 * observed Vercel drift, a page loaded shortly after a scheduled instant can
 * legitimately precede that day's run. 2 means "a whole scheduled run came and
 * went with nothing recorded," which drift cannot explain.
 */
export const MISSED_RUNS_BEFORE_STALE = 2

export interface SweepFreshness {
  state: 'fresh' | 'stale' | 'never'
  missedRuns: number
  message: string
}

/**
 * How many weekday cron instants (21:15 UTC, Mon–Fri) fall strictly between
 * `since` and `now`. Weekend-aware by construction, so Friday→Monday is one
 * expected gap rather than three missed runs.
 */
export function expectedRunsBetween(since: Date, now: Date): number {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) return 0
  if (now.getTime() <= since.getTime()) return 0

  let count = 0
  // Walk UTC days from the day of `since` through the day of `now`.
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  )
  const lastDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  while (cursor.getTime() <= lastDay) {
    const dow = cursor.getUTCDay() // 0 Sun … 6 Sat
    if (dow >= 1 && dow <= 5) {
      const instant = Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        CRON_HOUR_UTC,
        CRON_MINUTE_UTC,
      )
      if (instant > since.getTime() && instant <= now.getTime()) count++
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

export function sweepFreshness(lastRanAt: Date | null, now: Date): SweepFreshness {
  if (lastRanAt === null) {
    return {
      state: 'never',
      missedRuns: 0,
      message:
        'No sweep run has ever been recorded. If the cron is deployed, this means it has ' +
        'not fired since sweep-run recording shipped — check the Vercel cron log.',
    }
  }

  const missedRuns = expectedRunsBetween(lastRanAt, now)
  if (missedRuns < MISSED_RUNS_BEFORE_STALE) {
    return { state: 'fresh', missedRuns, message: '' }
  }
  return {
    state: 'stale',
    missedRuns,
    message:
      `The exit sweep has missed ${missedRuns} scheduled runs. Standing GTCs are NOT being ` +
      `reconciled and new exits are NOT being placed — check the Vercel cron log.`,
  }
}
