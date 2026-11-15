// ============================================================
// SteelEagle — v2.18 end-of-run reconciliation (pure — no I/O)
//
// THE SELF-RESOLVING PHANTOM (open since Session 25, reopened by JJ
// 2026-11-15). Reconciliation used to flag from the journal as read in step 0,
// before the sweep's own writes: (a) journals filled GTCs, (d) auto-journals
// entries, rolls and closes. So a night where everything worked flagged the
// very trade the run was about to close (PHANTOM) or roll (DRIFT). Nov 5–11:
// 5 of 10 sweeps CRITICAL, every one of them that artifact.
//
// The fix: the FLAGS come from a second reconciliation run after step (d),
// against trades re-read then and the SAME positions snapshot (the sweep runs
// after the close; positions cannot move mid-run). That is past every
// placement decision — the same side of the boundary runAutoJournal already
// re-reads trades on — so reconciliation still cannot influence placement.
//
// Nothing goes silent:
//  - the step-0 result is kept on the report (`atPlacement`): what placement saw;
//  - a step-0 critical this run's OWN write explains becomes a NOTE, naming it;
//  - a step-0 critical that vanished with NO write to explain it is a WARNING
//    (JJ edited the journal mid-run, or something we do not understand);
//  - anything still wrong at the end is flagged critical exactly as before,
//    including when a write failed.
// ============================================================

import type { ReconcileFinding, ReconcileStatus } from './reconcile'

/** Every way the sweep itself changes the journal within one run. */
export type RunWriteKind = 'exit-fill' | 'auto-close' | 'auto-roll' | 'auto-entry'

export interface RunWrite {
  tradeId: string
  orderId: string
  kind: RunWriteKind
}

export interface ResolvedFinding {
  status: ReconcileStatus
  symbol: string
  expiration: string
  tradeId: string | null
  /** The step-0 detail, verbatim — what the journal looked like before. */
  detail: string
  /** The write that explains it, or null when nothing in this run does. */
  resolvedBy: { kind: RunWriteKind; orderId: string } | null
}

const sameSubject = (a: ReconcileFinding, b: ReconcileFinding) =>
  a.symbol === b.symbol && a.expiration === b.expiration && a.tradeId === b.tradeId

/**
 * Step-0 criticals that are no longer critical at the end of the run.
 *
 * "No longer critical" is per SUBJECT (symbol + expiration + trade), not per
 * status: if the end-of-run check still has ANY critical on that subject it is
 * flagged from there, and this does not also call it resolved.
 */
export function resolvedInRun(
  atPlacement: ReconcileFinding[],
  final: ReconcileFinding[],
  writes: RunWrite[],
): ResolvedFinding[] {
  const finalCriticals = final.filter((f) => f.severity === 'critical')
  return atPlacement
    .filter((p) => p.severity === 'critical')
    .filter((p) => !finalCriticals.some((f) => sameSubject(p, f)))
    .map((p) => {
      // A null tradeId (a finding about a position with no trade) can never be
      // attributed: no write names it. That is a warning, not a note.
      const w = p.tradeId === null ? undefined : writes.find((x) => x.tradeId === p.tradeId)
      return {
        status: p.status,
        symbol: p.symbol,
        expiration: p.expiration,
        tradeId: p.tradeId,
        detail: p.detail,
        resolvedBy: w ? { kind: w.kind, orderId: w.orderId } : null,
      }
    })
}

/** The report fields that record the sweep's own journal writes. Structural, so
 *  this module need not import the report type. */
export interface RunWriteSources {
  reconciled: Array<{ tradeId: string; orderId: string }>
  autoJournal?: {
    written: Array<{ tradeId: string; orderId: string }>
    rolls?: { written: Array<{ tradeId: string; orderId: string }> }
    entries?: { written: Array<{ tradeId: string; orderId: string }> }
  }
}

export function runWritesOf(report: RunWriteSources): RunWrite[] {
  const aj = report.autoJournal
  return [
    ...report.reconciled.map((w) => ({ tradeId: w.tradeId, orderId: w.orderId, kind: 'exit-fill' as const })),
    ...(aj?.entries?.written ?? []).map((w) => ({ tradeId: w.tradeId, orderId: w.orderId, kind: 'auto-entry' as const })),
    ...(aj?.rolls?.written ?? []).map((w) => ({ tradeId: w.tradeId, orderId: w.orderId, kind: 'auto-roll' as const })),
    ...(aj?.written ?? []).map((w) => ({ tradeId: w.tradeId, orderId: w.orderId, kind: 'auto-close' as const })),
  ]
}

const WRITE_LABEL: Record<RunWriteKind, string> = {
  'exit-fill': 'journaling its filled GTC',
  'auto-close': 'the auto-journaled close',
  'auto-roll': 'the auto-journaled roll',
  'auto-entry': 'the auto-journaled entry',
}

/** The NOTE for a resolution this run's own write explains. */
export function resolvedNote(r: ResolvedFinding): string | null {
  if (!r.resolvedBy) return null
  return (
    `Reconciliation ${r.status} on ${r.symbol} ${r.expiration} resolved in this run by ` +
    `${WRITE_LABEL[r.resolvedBy.kind]} (order ${r.resolvedBy.orderId}) — journal and account agree.`
  )
}

/** The WARNING for a resolution nothing in this run explains. */
export function unexplainedResolutionReason(r: ResolvedFinding): string {
  return (
    `RECONCILIATION ${r.status} — ${r.symbol} ${r.expiration} was critical before this run's ` +
    `writes and is gone after them, but no write in this run explains it (was the journal ` +
    `edited during the sweep?). At placement: ${r.detail}`
  )
}
