// ============================================================
// SteelEagle — Sweep Run History DB Access (v2.9)
//
// WRITE-ONLY from the cron, READ-ONLY everywhere else.
//
// Nothing in the placement path may read this table. Reconciliation FLAGS,
// it does not BLOCK (April, 2026-08-04) — and a *history* of flags is even
// weaker evidence than a live one. If a future change wants "don't place
// because yesterday drifted", that is a decision for April, not a helper
// added here.
// ============================================================

import { sql } from '@/lib/db/client'
import type { ExitSweepReport, SweepSeverity } from '@/lib/strategy/sweep-report'

export interface SweepRunRecord {
  id: string
  ranAt: string
  severity: SweepSeverity
  criticalCount: number
  warningCount: number
  headline: string
  report: ExitSweepReport
}

interface SweepRunRow {
  id: string
  ran_at: string
  severity: SweepSeverity
  critical_count: number
  warning_count: number
  headline: string
  report: ExitSweepReport
}

function toRecord(row: SweepRunRow): SweepRunRecord {
  return {
    id: row.id,
    ranAt: new Date(row.ran_at).toISOString(),
    severity: row.severity,
    criticalCount: row.critical_count,
    warningCount: row.warning_count,
    headline: row.headline,
    report: row.report,
  }
}

/**
 * Persist one completed sweep run.
 *
 * Called from the cron AFTER the sweep has finished, inside its own try/catch.
 * A failure here must never affect the sweep — by the time this runs, every
 * order decision is already made and executed. This is bookkeeping about
 * bookkeeping.
 */
export async function recordSweepRun(input: {
  ranAt: Date
  severity: SweepSeverity
  criticalCount: number
  warningCount: number
  headline: string
  report: ExitSweepReport
}): Promise<string> {
  // `report` is jsonb: @vercel/postgres tagged templates take scalars only, so
  // the object is serialized here and cast in SQL rather than passed raw.
  const { rows } = await sql<{ id: string }>`
    INSERT INTO sweep_runs (ran_at, severity, critical_count, warning_count, headline, report)
    VALUES (
      ${input.ranAt.toISOString()},
      ${input.severity},
      ${input.criticalCount},
      ${input.warningCount},
      ${input.headline},
      ${JSON.stringify(input.report)}::jsonb
    )
    RETURNING id
  `
  return rows[0].id
}

/**
 * The most recent run, or null if none has ever been recorded.
 *
 * null is meaningful and must not be flattened into "healthy" — `sweepFreshness`
 * maps it to the distinct `never` state. An empty table after this milestone
 * ships means the cron has not fired, which is precisely the condition a
 * report-rendering banner cannot show on its own.
 */
export async function getLatestSweepRun(): Promise<SweepRunRecord | null> {
  const { rows } = await sql<SweepRunRow>`
    SELECT id, ran_at, severity, critical_count, warning_count, headline, report
    FROM sweep_runs
    ORDER BY ran_at DESC
    LIMIT 1
  `
  return rows.length > 0 ? toRecord(rows[0]) : null
}

/** Recent runs, newest first — forensics for the operator, not used by the banner. */
export async function listSweepRuns(limit = 20): Promise<SweepRunRecord[]> {
  const { rows } = await sql.query<SweepRunRow>(
    `SELECT id, ran_at, severity, critical_count, warning_count, headline, report
     FROM sweep_runs
     ORDER BY ran_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(100, limit))],
  )
  return rows.map(toRecord)
}
