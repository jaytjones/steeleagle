/**
 * lib/strategy/exit-sweep.ts
 *
 * v2.2 — pure exit-sweep planner (spec §4.3, build order #3).
 *
 * Decides, from journaled open trades + a single wholesale fetch of Schwab
 * order states, what the folded post-close sweep should do: reconcile filled GTC
 * exits, clear terminal ones, alert at ≤21 DTE, place missing GTCs, and flag
 * everything that needs operator eyes. Zero I/O — the cron route performs the
 * fetches/writes; this module only plans.
 *
 * Design decisions carried from the FINAL spec (do not re-litigate here):
 *  - v2.3: placement eligibility is "can `currentStructure(events)` produce a
 *    four-leg, single-expiration condor?", NOT "is this trade unrolled?".
 *    Same-expiration rolls are now placeable; diagonals (a one-sided roll out
 *    in time) still flag for a manual GTC. (v2.3 spec §2b, §5.1)
 *  - The sweep acts on fetched order truth, never on `exit_order_id` alone.
 *    Pre-place guard: never place when ANY working close order already exists
 *    on the same underlying + expiration. (§4.3c / finding 2)
 *  - Placement requires dte ≥ 24 (Monitor WATCH band is 22–23; ≤21 alerts).
 *    22–23 DTE: no placement, no cron alert. (finding 3)
 *  - A terminal exit order (Schwab reported it dead) clears the id; the
 *    RE-placement happens on the NEXT sweep, after the DB write landed —
 *    this run never both clears and places for the same trade. (§4.3a)
 *  - An id absent from the fetched set is a fetch gap, not a dead order:
 *    flag + keep the id. Never null on missing data. (§6.4)
 */
import type { SchwabOrderDetail } from '../schwab/orders'
import { daysToExpiration, parseOccSymbol } from './reconstruct-positions'
import { hasAmbiguousRoot, isOrderFixturePinned } from './instruments'
import { unpriceableFlagSeverity, type FlagSeverity } from './sweep-report'

// --------------------------------------------------------
// Inputs
// --------------------------------------------------------

/**
 * The slice of a journaled trade the planner needs. The cron adapter maps
 * full `Trade` rows (post-migration, carrying `exitOrderId`) into this.
 */
export interface SweepTradeInput {
  id: string
  symbol: string
  /** YYYY-MM-DD — current (post-roll) expiration from the trade row. */
  currentExpiration: string
  /** null = no standing exit on record (never placed, or cleared). */
  exitOrderId: string | null
  /**
   * v2.3 — false when `currentStructure(events)` refuses this trade's event
   * log, i.e. the sweep cannot know which four legs it currently holds
   * (diagonal after a one-sided roll out in time, a leg rolled closed and
   * never reopened, a malformed log). The cron adapter computes it with
   * `isPriceableStructure`. Replaces v2.2's blunt `hasRollEvents` gate.
   *
   * v2.4 widened the refusal set to symbol-level causes (multi-root index,
   * unpinned order fixture) — see `unpriceableReason`.
   */
  priceable: boolean
  /**
   * v2.4 — the refusal message from `structureRefusal`, verbatim, when
   * `priceable` is false. Optional: absent falls back to the generic wording,
   * so callers that predate this field still plan identically.
   */
  unpriceableReason?: string | null
  /**
   * v2.12 — contracts the ACCOUNT holds on this underlying|expiration, or null
   * when it could not be determined (positions unavailable, legs of unequal
   * size, no such position).
   *
   * **null is the fail-safe and reverts the guard to its pre-v2.12 blanket
   * rule.** Optional so callers predating v2.12 plan identically.
   */
  heldContracts?: number | null
  /**
   * v2.12 — contracts this trade would place a close for. Needed to verify
   * there is room for the WHOLE order, not merely some room: with held 2,
   * covered 1 and a 2-lot trade, `held > covered` is true but placing would
   * claim 3 of 2. Absent ⇒ the size cannot be verified ⇒ strict fallback.
   */
  contracts?: number
}

/**
 * A Schwab order digested to exactly what sweep decisions need.
 * Produced from the wholesale working+recent orders fetch by
 * `digestOrderForSweep` below.
 */
export interface SweepOrderState {
  orderId: string
  /** Raw Schwab status string, uppercased; 'UNKNOWN' when absent. */
  status: string
  /**
   * Underlying + expiration shared by ALL option legs, or null when legs are
   * missing, unparseable, or span mixed underlyings/expirations. Null
   * disables underlying-level matching (guard) but id-level matching
   * (reconcile) still works.
   */
  underlying: string | null
  expiration: string | null // YYYY-MM-DD
  /** True when every leg instruction is *_TO_CLOSE (and there is ≥1 leg). */
  isClose: boolean
  filledQuantity: number | null
  remainingQuantity: number | null
  /**
   * v2.12 — contracts this order still CLAIMS, for the quantity-aware guard.
   * The still-live portion: `remainingQuantity` when Schwab reports one, else
   * the order quantity. A partially filled GTC covers only what has not filled.
   * Null when Schwab reported neither — which the guard treats as "unknown" and
   * therefore blocking, never as zero.
   */
  coveredContracts: number | null
}

// --------------------------------------------------------
// Status classification
// --------------------------------------------------------

/** Order is (or may still become) live at Schwab — includes pending states. */
const WORKING_STATUSES = new Set([
  'WORKING',
  'ACCEPTED',
  'QUEUED',
  'PENDING_ACTIVATION',
  'PENDING_CANCEL', // cancel requested but not confirmed — still treat as live
  'PENDING_REPLACE',
  'AWAITING_PARENT_ORDER',
  'AWAITING_CONDITION',
  'AWAITING_STOP_CONDITION',
  'AWAITING_MANUAL_REVIEW',
  'AWAITING_UR_OUT',
  'NEW',
])

/** Schwab reported the order dead. The only null-without-warning path (§6.4). */
const TERMINAL_STATUSES = new Set(['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'])

/**
 * Partially filled — some contracts closed, some still live. Never journaled
 * automatically, never cancelled automatically. Exported so the v2.3 Cancel
 * GTC path classifies orders identically to the sweep.
 */
export function isPartialFill(o: Pick<SweepOrderState, 'filledQuantity' | 'remainingQuantity'>): boolean {
  return (o.filledQuantity ?? 0) > 0 && (o.remainingQuantity ?? 0) > 0
}

const isPartial = isPartialFill

/** Schwab has conclusively reported this order dead. ONE definition (§6.4). */
export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Guard semantics: any order that is not conclusively dead or conclusively
 * fully filled must block placement — unknown statuses fail safe (block).
 */
function blocksPlacement(o: SweepOrderState): boolean {
  if (TERMINAL_STATUSES.has(o.status)) return false
  if (o.status === 'FILLED' && !isPartial(o)) return false
  return true // WORKING-ish, partial, or unrecognized → treat as live
}

// --------------------------------------------------------
// Plan output
// --------------------------------------------------------

export interface SweepPlan {
  /** Standing GTC exits confirmed FILLED → journal close (profit_target). */
  toReconcile: Array<{ tradeId: string; orderId: string }>
  /** Terminal at Schwab → null exit_order_id; next sweep re-places. */
  toClear: Array<{ tradeId: string; orderId: string; reason: string }>
  /** ≤21 DTE alerts, with the explicit cancel-GTC instruction when standing. */
  toAlert: Array<{ tradeId: string; symbol: string; dte: number; message: string }>
  /** Eligible for a new 50%-target GTC placement this run. */
  toPlace: Array<{ tradeId: string; symbol: string }>
  /**
   * Anything needing operator eyes; never mutates state.
   *
   * v2.9 — each flag carries its own severity, stamped HERE where the branch
   * that produced it is known. `routine` is a permanent, decided refusal
   * (multi-root index, unpinned fixture) that recurs every run by design;
   * `critical` is anything that changed or broke. The dashboard banner reads
   * this instead of matching the reason prose, so re-wording a message can
   * never silently re-classify it. See lib/strategy/sweep-report.ts.
   */
  toFlag: Array<{
    tradeId: string
    orderId: string | null
    reason: string
    severity: FlagSeverity
  }>
}

// --------------------------------------------------------
// The planner
// --------------------------------------------------------

export const PLACEMENT_MIN_DTE = 24 // finding 3 — no fresh GTC below this
export const DTE_ALERT = 21 // strategy §5 mechanical exit

export function planExitSweep(
  openTrades: SweepTradeInput[],
  orderStates: SweepOrderState[],
  today: Date,
): SweepPlan {
  const plan: SweepPlan = {
    toReconcile: [],
    toClear: [],
    toAlert: [],
    toPlace: [],
    toFlag: [],
  }

  const byId = new Map(orderStates.map((o) => [o.orderId, o]))

  for (const trade of openTrades) {
    const dte = daysToExpiration(trade.currentExpiration, today)

    // ---- (a) RECONCILE: trades with a standing exit on record ----
    if (trade.exitOrderId !== null) {
      const order = byId.get(trade.exitOrderId)

      if (!order) {
        // Fetch gap, not proof of death — keep the id, demand eyes. (§6.4)
        plan.toFlag.push({
          tradeId: trade.id,
          orderId: trade.exitOrderId,
          reason: `standing exit order ${trade.exitOrderId} not found in fetched orders — verify in TOS`,
          // A GTC that vanished from the fetch is either a fetch gap or a dead
          // order we refused to assume dead. Both need eyes.
          severity: 'critical',
        })
      } else if (isPartial(order)) {
        // Refuse to journal a partial. Keep the id; re-inspect next sweep. (§5.5)
        plan.toFlag.push({
          tradeId: trade.id,
          orderId: order.orderId,
          reason:
            `exit order ${order.orderId} partially filled` +
            ` (${order.filledQuantity} filled / ${order.remainingQuantity} remaining)` +
            ` — nothing journaled; resolve manually (journal Close form if finishing in TOS)`,
          severity: 'critical',
        })
      } else if (order.status === 'FILLED') {
        plan.toReconcile.push({ tradeId: trade.id, orderId: order.orderId })
      } else if (TERMINAL_STATUSES.has(order.status)) {
        plan.toClear.push({
          tradeId: trade.id,
          orderId: order.orderId,
          reason: `exit order ${order.orderId} ${order.status} at Schwab — cleared; next sweep re-places`,
        })
      } else if (WORKING_STATUSES.has(order.status)) {
        // Standing and live — exactly the steady state. No-op.
      } else {
        plan.toFlag.push({
          tradeId: trade.id,
          orderId: order.orderId,
          reason: `exit order ${order.orderId} has unrecognized status "${order.status}" — verify in TOS`,
          // An unmapped Schwab status: the guard fails safe (blocks placement),
          // but a status we do not model is exactly what we want to hear about.
          severity: 'critical',
        })
      }
    }

    // ---- (b) 21-DTE alert (alert-only; the cron never places or cancels) ----
    if (dte <= DTE_ALERT) {
      plan.toAlert.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        dte,
        message:
          trade.exitOrderId !== null
            ? `21-DTE — close ${trade.symbol} manually and cancel standing GTC ${trade.exitOrderId}`
            : `21-DTE — close ${trade.symbol} manually`,
      })
    }

    // ---- (c) PLACE: only trades with no standing exit on record ----
    if (trade.exitOrderId !== null) continue
    if (dte < PLACEMENT_MIN_DTE) continue // ≤23: no placement (≤21 alerted above)

    if (!trade.priceable) {
      plan.toFlag.push({
        tradeId: trade.id,
        orderId: null,
        reason:
          `${trade.symbol} — ` +
          (trade.unpriceableReason ??
            `current structure cannot be reconstructed from the event log ` +
              `(diagonal, or a leg rolled closed and never reopened)`) +
          `; place the GTC manually at 50% of current net credit`,
        // Routine ONLY for the two permanent symbol-level refusals. A
        // structural refusal — diagonal, vacant leg, or strikes not ordered
        // LP < SP <= SC < LC — is the v2.7 defect class and stays critical.
        severity: unpriceableFlagSeverity(trade.symbol, {
          ambiguousRoot: hasAmbiguousRoot(trade.symbol),
          fixturePinned: isOrderFixturePinned(trade.symbol),
        }),
      })
      continue
    }

    // ---- Pre-place guard (finding 2; v2.12 quantity-aware) ----
    //
    // Fetched-order truth beats the null column, as always. What changed in
    // v2.12 is the QUESTION: not "does a working close exist?" but "would
    // placing this OVER-COVER what the account holds?" — which is the hazard
    // the guard was always for.
    //
    //   held > covered  → place
    //   otherwise       → block
    //
    // FAIL-SAFE: `heldContracts == null` means we have no evidence of how much
    // is held (positions unavailable, mixed leg sizes, no such position). That
    // reverts to the pre-v2.12 rule — ANY working close blocks — which has
    // never over-covered. The loosening applies ONLY where held is known.
    const blocking = orderStates.filter(
      (o) =>
        o.isClose &&
        o.underlying === trade.symbol &&
        o.expiration === trade.currentExpiration &&
        blocksPlacement(o),
    )

    if (blocking.length > 0) {
      const held = trade.heldContracts ?? null
      // An order whose remaining size Schwab did not report counts as unknown,
      // and unknown coverage must never read as zero coverage.
      const anyUnknownCoverage = blocking.some((o) => o.coveredContracts == null)
      const covered = blocking.reduce((sum, o) => sum + (o.coveredContracts ?? 0), 0)
      const ids = blocking.map((o) => o.orderId).join(', ')

      // More closes standing than contracts held. Nothing else in the app would
      // notice this, and it is not merely "blocked" — it is wrong.
      if (held !== null && !anyUnknownCoverage && covered > held) {
        plan.toFlag.push({
          tradeId: trade.id,
          orderId: blocking[0].orderId,
          reason:
            `OVER-COVERED — ${trade.symbol} ${trade.currentExpiration}: working close ` +
            `order(s) ${ids} claim ${covered} contract(s) but the account holds only ` +
            `${held}. Cancel the surplus in TOS.`,
          severity: 'critical',
        })
        continue
      }

      // Room for the WHOLE order, not merely some room.
      const wanted = trade.contracts ?? null
      const roomToPlace =
        held !== null && !anyUnknownCoverage && wanted !== null && held - covered >= wanted

      if (!roomToPlace) {
        plan.toFlag.push({
          tradeId: trade.id,
          orderId: blocking[0].orderId,
          reason:
            held === null || anyUnknownCoverage || wanted === null
              ? `working close order(s) ${ids} on ${trade.symbol} ` +
                `${trade.currentExpiration} and the held contract count could not be ` +
                `determined — not placing (backfill exit_order_id if one of these is ` +
                `the intended exit)`
              : `working close order(s) ${ids} on ${trade.symbol} ` +
                `${trade.currentExpiration} already cover ${covered} of ${held} held ` +
                `contract(s); this trade needs ${wanted} — no room to place (backfill ` +
                `exit_order_id if one of these is the intended exit)`,
          // An unexpected working close on a trade we think has none: either an
          // untracked manual GTC or a bookkeeping gap. Always eyes.
          severity: 'critical',
        })
        continue
      }
      // Room remains — fall through and place. This is the GLD fix.
    }

    plan.toPlace.push({ tradeId: trade.id, symbol: trade.symbol })
  }

  return plan
}

// --------------------------------------------------------
// Digest adapter: SchwabOrderDetail → SweepOrderState
// (pure; the cron maps the wholesale fetch through this)
// --------------------------------------------------------

export function digestOrderForSweep(order: SchwabOrderDetail): SweepOrderState {
  const legs = order.orderLegCollection ?? []

  let underlying: string | null = null
  let expiration: string | null = null
  let coherent = legs.length > 0

  for (const leg of legs) {
    const parsed = parseOccSymbol(leg.instrument?.symbol ?? '')
    if (!parsed) {
      coherent = false
      break
    }
    if (underlying === null) {
      underlying = parsed.underlying
      expiration = parsed.expiration
    } else if (parsed.underlying !== underlying || parsed.expiration !== expiration) {
      coherent = false
      break
    }
  }
  if (!coherent) {
    underlying = null
    expiration = null
  }

  const isClose =
    legs.length > 0 && legs.every((l) => (l.instruction ?? '').endsWith('_TO_CLOSE'))

  return {
    orderId: String(order.orderId),
    status: (order.status ?? 'UNKNOWN').toUpperCase(),
    underlying,
    expiration,
    isClose,
    filledQuantity: order.filledQuantity ?? null,
    remainingQuantity: order.remainingQuantity ?? null,
    coveredContracts: order.remainingQuantity ?? order.quantity ?? null,
  }
}
