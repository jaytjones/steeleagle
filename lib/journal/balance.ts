// ============================================================
// SteelEagle — v2.11 balance check (pure — no I/O)
//
// Closes April's accounting identity (spec §2):
//
//     residual  =  Δpositions  −  Σ order effects
//
// A zero residual is a COMPLETENESS PROOF: every structural change in the
// interval is accounted for by an order we have. That is categorically
// stronger than a classifier's confidence, and it is why auto-write is gated
// on this rather than on how sure `classify-fill` feels (spec §7).
//
// ── The residual is the valuable part ──
//
// A non-zero residual is precisely the class of events that produce NO ORDER
// AT ALL — expirations, assignments, exercises. Nothing in the order stream
// can ever reveal those, and this check finds them without reading
// `/transactions` and without a new Schwab fixture.
//
// An expiration is self-identifying: the position vanished and the symbol's
// expiration date is already in the past. Anything else is UNEXPLAINED and is
// the finding that matters — an assignment, a fill outside the fetch window
// (`fromEnteredTime` filters on PLACEMENT, so an old GTC filled yesterday
// falls outside a short window), or a gap in our data.
//
// ── Three statuses, and why UNRELIABLE is not just "unbalanced" ──
//
//   BALANCED    residual empty, no refusals. The interval is fully explained.
//   RESIDUAL    something changed that no order explains. Includes EXPIRED —
//               an expiry is explained as a CAUSE but still needs a journal
//               close, so it must not read as clean.
//   UNRELIABLE  an order's effect could not be computed at all. This is OUR
//               fault, not the account's, and reporting it as a residual would
//               blame the wrong side. It must never be collapsed into
//               BALANCED — an absent warning identical to a clean bill is how
//               the /quotes 404 hid (v2.6.1) and why `reconciliation.ran:
//               false` is not "nothing found" (v2.8).
//
// UNANCHORED — no prior snapshot to diff against — is deliberately NOT a status
// here. This module compares two maps it is given; whether an anchor exists is
// the ingestion layer's question, and it must answer it before calling
// (spec §6). A missing anchor must never reach this function as an empty map,
// because empty-vs-empty balances and would manufacture a false proof.
// ============================================================

import { parseOccSymbol } from '../strategy/reconstruct-positions'
import { subtractQty, type SymbolQty } from './position-delta'

export type BalanceStatus = 'BALANCED' | 'RESIDUAL' | 'UNRELIABLE'

export type ResidualKind =
  /** Position vanished and the contract had already expired. Needs a journal close. */
  | 'EXPIRED'
  /** No order explains this. Assignment, out-of-window fill, or a data gap. */
  | 'UNEXPLAINED'

export interface ResidualFinding {
  kind: ResidualKind
  occSymbol: string
  /** Signed, unexplained contract change. */
  qty: number
  detail: string
}

export interface BalanceResult {
  status: BalanceStatus
  /** True ONLY for a zero residual with no refusals. The auto-write gate. */
  balanced: boolean
  residual: SymbolQty
  findings: ResidualFinding[]
  refusals: string[]
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/**
 * Compare the observed position change against what the interval's orders
 * should have produced.
 *
 * @param delta    diffPositions(snapshot T₀, snapshot T₁)
 * @param effects  sumEffects(orders executed in the interval).symbols
 * @param refusals sumEffects(...).refusals — orders whose effect is unknown
 * @param now      for deciding whether a vanished leg had already expired
 */
export function checkBalance(
  delta: SymbolQty,
  effects: SymbolQty,
  refusals: readonly string[] = [],
  now: Date = new Date(),
): BalanceResult {
  const residual = subtractQty(delta, effects)
  const today = startOfUtcDay(now)

  const findings: ResidualFinding[] = [...residual.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([occSymbol, qty]): ResidualFinding => {
      const parsed = parseOccSymbol(occSymbol)

      if (!parsed) {
        // Cannot read the expiration, so cannot rule out an expiry — and
        // "probably an expiry" is exactly the guess this codebase refuses.
        return {
          kind: 'UNEXPLAINED',
          occSymbol,
          qty,
          detail:
            `${qty > 0 ? '+' : ''}${qty} contracts changed with no order to explain it, and ` +
            `the OCC symbol could not be parsed — the expiry check could not run.`,
        }
      }

      const expired = Date.parse(`${parsed.expiration}T00:00:00Z`) < today
      if (expired) {
        return {
          kind: 'EXPIRED',
          occSymbol,
          qty,
          detail:
            `${parsed.underlying} ${parsed.expiration} ${parsed.strike}` +
            `${parsed.putCall === 'PUT' ? 'P' : 'C'} changed by ${qty > 0 ? '+' : ''}${qty} ` +
            `with no order — the contract expired on ${parsed.expiration}. Expiries produce ` +
            `no Schwab order, so this is the expected trace of one. Journal the exit.`,
        }
      }

      return {
        kind: 'UNEXPLAINED',
        occSymbol,
        qty,
        detail:
          `${parsed.underlying} ${parsed.expiration} ${parsed.strike}` +
          `${parsed.putCall === 'PUT' ? 'P' : 'C'} changed by ${qty > 0 ? '+' : ''}${qty} ` +
          `with no order to explain it and it has NOT expired. Candidates: an assignment or ` +
          `exercise, a fill outside the order-fetch window, or missing data. Compare in ` +
          `thinkorswim before trusting anything derived from this interval.`,
      }
    })

  // Refusal dominates: if an order's effect is unknown, the residual is not
  // evidence about the account — it is evidence about our own arithmetic.
  const status: BalanceStatus =
    refusals.length > 0 ? 'UNRELIABLE' : residual.size === 0 ? 'BALANCED' : 'RESIDUAL'

  return {
    status,
    balanced: status === 'BALANCED',
    residual,
    findings,
    refusals: [...refusals],
  }
}

/** One-line operator summary. Never renders an unbalanced interval as clean. */
export function summarizeBalance(result: BalanceResult): string {
  if (result.status === 'UNRELIABLE') {
    return `UNRELIABLE — ${result.refusals.length} order effect(s) could not be computed; the residual proves nothing`
  }
  if (result.status === 'BALANCED') return 'BALANCED — every position change is explained by a known order'

  const expired = result.findings.filter((f) => f.kind === 'EXPIRED').length
  const unexplained = result.findings.filter((f) => f.kind === 'UNEXPLAINED').length
  const parts: string[] = []
  if (unexplained > 0) parts.push(`${unexplained} UNEXPLAINED`)
  if (expired > 0) parts.push(`${expired} expired`)
  return `RESIDUAL — ${parts.join(', ')}`
}
