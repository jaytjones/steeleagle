// ============================================================
// SteelEagle — v2.11 ingestion report (pure — no I/O)
//
// Turns the outcome of one ingestion pass into the block the cron records and
// the flags the operator sees. All the I/O (fetch, classify, upsert, snapshot)
// is the route's job; every DECISION about what any of it MEANS is here, so it
// is unit-testable without a database.
//
// ── Flag severities, and the wallpaper hazard ──
//
// v2.9 stamps severity at the PRODUCER, never inferring it from reason prose,
// and reserves `routine` for things that recur every run BY DESIGN. A red
// banner that is always red stops being read. Applied here:
//
//   critical   INGESTION DID NOT RUN     — an absent check is not a clean bill
//              balance UNRELIABLE        — our own arithmetic is incomplete
//              balance UNEXPLAINED       — an assignment, or missing data
//   routine    UNANCHORED                — expected EXACTLY ONCE, self-resolving
//              balance EXPIRED           — real, but reconcile.ts already voices
//                                          it as PHANTOM, and IT rates an expired
//                                          phantom `warning`. Two reds for one
//                                          event trains the operator to ignore both.
//
// ── UNANCHORED is a status, never an empty balance ──
//
// With no prior snapshot there is nothing to diff. An empty anchor map would
// balance against empty effects and manufacture a false completeness proof —
// the precise failure `checkBalance` refuses to model. So the anchor's absence
// is carried as its own status all the way to the report.
// ============================================================

import { formatQty, type SymbolQty } from './position-delta'
import type { BalanceResult } from './balance'

export type IngestionBalanceStatus = BalanceResult['status'] | 'UNANCHORED'

export interface IngestionFlag {
  severity: 'critical' | 'routine'
  reason: string
}

export interface IngestionReport {
  /** false = the pass threw. NOT "nothing found" — see the flag it produces. */
  ran: boolean
  reason?: string
  /** takenAt of the snapshot this run diffed AGAINST. null = UNANCHORED. */
  anchorAt: string | null
  /** takenAt of the snapshot this run wrote. null when the write did not happen. */
  snapshotAt: string | null
  fills: { inserted: number; updated: number; failed: number }
  /** Ledger rows with disposition 'pending'. Raw count; see `actionable`. */
  pending: number
  /**
   * Fills that actually need the operator, per match-fill. THIS is the inbox
   * depth — `pending` counts every ledgered order including months of history.
   */
  actionable: number
  balance: {
    status: IngestionBalanceStatus
    /** Human-readable residual, '(empty)' when zero. */
    residual: string
    findings: Array<{ kind: string; occSymbol: string; qty: number; detail: string }>
    refusals: string[]
  }
}

/** The pessimistic starting value. Until a pass completes, it did NOT run. */
export function ingestionDidNotRun(reason: string): IngestionReport {
  return {
    ran: false,
    reason,
    anchorAt: null,
    snapshotAt: null,
    fills: { inserted: 0, updated: 0, failed: 0 },
    pending: 0,
    actionable: 0,
    balance: { status: 'UNANCHORED', residual: '(empty)', findings: [], refusals: [] },
  }
}

export function buildIngestionReport(input: {
  anchorAt: string | null
  snapshotAt: string | null
  inserted: number
  updated: number
  failed: number
  pending: number
  actionable?: number
  /** null when UNANCHORED — there was no anchor to check against. */
  balance: BalanceResult | null
  residual?: SymbolQty
}): IngestionReport {
  return {
    ran: true,
    anchorAt: input.anchorAt,
    snapshotAt: input.snapshotAt,
    fills: { inserted: input.inserted, updated: input.updated, failed: input.failed },
    pending: input.pending,
    actionable: input.actionable ?? 0,
    balance: input.balance
      ? {
          status: input.balance.status,
          residual: formatQty(input.balance.residual),
          findings: input.balance.findings.map((f) => ({
            kind: f.kind,
            occSymbol: f.occSymbol,
            qty: f.qty,
            detail: f.detail,
          })),
          refusals: input.balance.refusals,
        }
      : { status: 'UNANCHORED', residual: '(empty)', findings: [], refusals: [] },
  }
}

/**
 * Operator-facing flags for one ingestion pass.
 *
 * Returns [] for a clean, balanced run — silence is correct when the identity
 * closed, because that is a proof and not merely an absence of complaints.
 */
export function ingestionFlags(report: IngestionReport): IngestionFlag[] {
  if (!report.ran) {
    return [
      {
        severity: 'critical',
        reason:
          `INGESTION DID NOT RUN (${report.reason ?? 'unknown'}) — this is NOT a clean bill of ` +
          `health. No fills were ledgered and the position identity was not checked this run, ` +
          `so an unjournaled roll would leave no trace here.`,
      },
    ]
  }

  const flags: IngestionFlag[] = []

  if (report.fills.failed > 0) {
    flags.push({
      severity: 'critical',
      reason:
        `INGESTION — ${report.fills.failed} fill(s) could not be ledgered. Those orders are ` +
        `absent from the inbox and will not be proposed for journaling.`,
    })
  }

  if (report.balance.status === 'UNANCHORED') {
    flags.push({
      severity: 'routine',
      reason:
        `INGESTION — no prior position snapshot, so the account identity could not be checked ` +
        `this run. Expected exactly once, on the first run after v2.11 ships; the snapshot ` +
        `written now becomes the anchor and the next run checks properly. If this repeats, ` +
        `the snapshot write is failing.`,
    })
  }

  if (report.balance.status === 'UNRELIABLE') {
    flags.push({
      severity: 'critical',
      reason:
        `INGESTION — the position identity is UNRELIABLE: ${report.balance.refusals.length} ` +
        `order effect(s) could not be computed, so a zero residual would prove nothing. ` +
        `First refusal: ${report.balance.refusals[0] ?? 'unknown'}`,
    })
  }

  for (const f of report.balance.findings) {
    if (f.kind === 'EXPIRED') {
      flags.push({ severity: 'routine', reason: `INGESTION EXPIRED — ${f.detail}` })
    } else {
      flags.push({ severity: 'critical', reason: `INGESTION UNEXPLAINED — ${f.detail}` })
    }
  }

  // `pending` is still NOT flagged — it counts every ledgered order, including
  // months of already-journaled history (the first live run: 122). `actionable`
  // is match-fill's answer to the question the operator actually asks, and it
  // is what earns a line. On the same live data it was 5, all of them the GLD
  // rejection streak.
  if (report.actionable > 0) {
    flags.push({
      severity: 'routine',
      reason:
        `INGESTION — ${report.actionable} recent fill(s) need journaling or review. ` +
        `See Unjournaled Activity.`,
    })
  }

  return flags
}
