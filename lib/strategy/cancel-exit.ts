// ============================================================
// SteelEagle — v2.3 Cancel GTC planner (pure — no I/O)
//
// Decides what the operator-initiated "Cancel GTC" does with a standing
// exit order, from FETCHED Schwab order state. The action is glue; every
// decision — including whether it is safe to null trades.exit_order_id —
// is made here and unit-tested.
//
// Two calls per run: once BEFORE cancelling (is a cancel even the right
// move?) and once AFTER, on the read-back (did it actually die?).
//
// The rules that matter:
//  - `exit_order_id` is nulled ONLY on a status Schwab conclusively reports
//    as dead. Never on a fetch gap, never on PENDING_CANCEL — a pending
//    cancel can still fill, and clearing early lets the next sweep place a
//    duplicate GTC. When uncertain, leave the column and let the sweep's
//    own clear path handle it next run. (v2.2 §6.4)
//  - A FILLED exit is not a failed cancel — it is a CLOSED POSITION. This
//    must be surfaced as its own outcome, or April closes in TOS a position
//    she no longer holds. The sweep's reconcile owns the journaling.
//  - A partial fill refuses outright: cancelling the remainder leaves a
//    half-closed condor, which no automated path can journal.
// ============================================================

import { isPartialFill, isTerminalOrderStatus, type SweepOrderState } from './exit-sweep'

export type CancelExitOutcome =
  /** Live at Schwab — submit the cancel. */
  | 'cancel_required'
  /** Confirmed dead. */
  | 'terminal'
  /** The GTC filled: the position is CLOSED, not cancelled. */
  | 'filled'
  /** Cancel submitted but Schwab has not confirmed death yet. */
  | 'pending'
  /** Do nothing and tell the operator why. */
  | 'refuse'

export interface CancelExitPlan {
  outcome: CancelExitOutcome
  /** Safe to null trades.exit_order_id? True ONLY on a confirmed terminal state. */
  clearColumn: boolean
  /** Operator-facing, travels via ActionResult (never redacted). */
  message: string
}

/**
 * @param state  digested Schwab order state (digestOrderForSweep)
 * @param phase  'before' = pre-cancel inspection, 'after' = post-cancel read-back
 */
export function planCancelExit(
  state: SweepOrderState,
  phase: 'before' | 'after',
): CancelExitPlan {
  const id = state.orderId

  // A partial fill is unresolvable by any automated path — same refusal the
  // sweep makes when it declines to journal one.
  if (isPartialFill(state)) {
    return {
      outcome: 'refuse',
      clearColumn: false,
      message:
        `GTC ${id} is PARTIALLY FILLED (${state.filledQuantity} filled / ` +
        `${state.remainingQuantity} remaining). Cancelling would leave a half-closed ` +
        `condor. Resolve it in thinkorswim, then use Record Close.`,
    }
  }

  if (state.status === 'FILLED') {
    return {
      outcome: 'filled',
      clearColumn: false,
      message:
        `GTC ${id} FILLED — this position is already CLOSED. Do NOT close it in ` +
        `thinkorswim. The post-close sweep will reconcile and journal it automatically.`,
    }
  }

  if (isTerminalOrderStatus(state.status)) {
    return {
      outcome: 'terminal',
      clearColumn: true,
      message:
        phase === 'before'
          ? `GTC ${id} was already ${state.status} at Schwab — nothing to cancel; ` +
            `the standing-exit record has been cleared.`
          : `GTC ${id} cancelled — Schwab reports ${state.status}.`,
    }
  }

  if (phase === 'before') {
    return { outcome: 'cancel_required', clearColumn: false, message: '' }
  }

  // Post-cancel and still alive — most often PENDING_CANCEL. It can still
  // fill, so the record stays put and the sweep clears it once terminal.
  return {
    outcome: 'pending',
    clearColumn: false,
    message:
      `Cancel submitted for GTC ${id}, but Schwab still reports ${state.status}. ` +
      `The standing-exit record was NOT cleared (a pending cancel can still fill). ` +
      `Verify in thinkorswim; the next sweep clears it once Schwab confirms.`,
  }
}
