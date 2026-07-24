# SteelEagle — v2.2 Auto-Exit Spec (DRAFT)

**Date:** July 23, 2026 (drafted end of Session 13)
**Status:** DRAFT — reviewed by no one; April reviews at next pickup before any code.
**Supersedes:** the cron-topology portions of `steeleagle-v2-2-pickup-note.md` (its design principles carry over unchanged).
**Baseline:** v2.1.1 live in prod · 148 tests · 1/2 Vercel cron slots used · `trades.sleeve` narrowed to `'core'`.

---

## 1. Scope

One milestone, three duties, **zero new cron slots**:

1. **GTC placement sweep (primary path).** For every open journaled condor lacking a standing exit order, place a **GTC NET_DEBIT buy-to-close at 50% of the journaled net credit** and record the order id.
2. **Reconcile.** Journal confirmed fills of standing GTC exits as `close` events (`close_reason='profit_target'`).
3. **21-DTE alert (alert-only).** Flag positions at ≤21 DTE, including the explicit instruction **"cancel standing GTC order [id]"**.

All three run inside the existing 4:15 PM ET `snapshot-iv` cron, each try/catch-isolated. The freed second cron slot **stays open** — not consumed by v2.2.

### Explicit decisions carried in from Sessions 12–13 (do not re-litigate)
- **Cron-sweep placement is primary; at-fill placement is a fast-follow** gated on the first real fill validating `recordFillAction` (§8 #5 / de-facto L4, still open). The sweep reads *journaled* net credit — operator-confirmed or imported data — so it ships without L4. The sweep's `exit_order_id IS NULL` guard makes later at-fill layering a no-op change.
- **21-DTE is alert-only.** The cron never places the forced close and **never cancels a working order.** Auto-cancel was rejected: a canceled GTC + a forgotten manual close leaves an unprotected position; a stale GTC on a closed position fails safe.
- **Stop-losses stay manual** (per strategy).
- **The dropped 12:00 UTC leg is not replaced.** Its duties were: pre-market reconcile (now happens at 4:15 same-day — fills journal hours later, never wrongly) and pre-open 21-DTE flag (redundant: the Positions Monitor computes DTE alerts on every dashboard load, and the 4:15 sweep flags the day before).
- **v2.3 (not this milestone):** close-position flow from the Positions Monitor — cancel-GTC-then-close as one sequenced action. Eliminates the stale-GTC hazard structurally; reuses this milestone's golden fixture.

## 2. Non-Goals
- No auto-placement of the 21-DTE close. No order cancellation by any cron. No auto-stop-loss. No intraday sweeps (Hobby: once/day). No GTC auto-replace on roll (see §6.3). No at-fill placement (fast-follow). No changes to `lib/schwab/order-ticket.ts` entry-side golden tests.

## 3. Schema

```sql
ALTER TABLE trades ADD COLUMN exit_order_id text;  -- null = no standing exit
```
- Nullable text; set when the sweep places the GTC; **cleared to null on `close` regardless of path** (a closed trade has no standing exit by definition — but see §6.4: clearing the column is bookkeeping, not proof the order is gone).
- Add to the canonical schema file in the same commit as the migration is run in Neon.

## 4. Design

### 4.1 The exit ticket (build from a golden fixture, FIRST implementation task)
Before any builder code: place ONE real GTC NET_DEBIT condor close in TOS on an open position, dump with `scripts/dump-working-orders.ts`, pin the exact shape as a golden fixture — `duration: "GTC"`, `orderType: "NET_DEBIT"`, the `complexOrderStrategyType` Schwab actually records, leg instructions `BUY_TO_CLOSE` / `SELL_TO_CLOSE`. Never build from docs. New pure module `lib/schwab/exit-ticket.ts` + golden tests, structured exactly like `order-ticket.ts` (which stays untouched).

### 4.2 Exit price (resolves pickup-note open question #2)
`debit = journaled net credit per share ÷ 2`, formatted through the existing `formatOrderPrice` semantics (reuse, don't re-derive; pin rounding in unit tests including odd-cent credits, e.g. $2.23 → $1.115 → whatever formatOrderPrice yields — the test pins it, the spec doesn't guess). Net credit per share = `(total_credit_collected − total_debit_paid) / (contracts × 100)` from the trade row at sweep time — so a trade rolled *before* first placement gets a correct target automatically.

### 4.3 The folded sweep (inside `snapshot-iv`)
Order of duties matters — reconcile before placement (a fill today must not look like a missing GTC):

```
snapshot-iv cron:
  1. IV snapshot (existing, untouched, runs first — exit failures can never drop IV rows)
  2. exitSweep(), fully try/catch-isolated, per-item try/catch inside:
     a. RECONCILE: for each open trade with exit_order_id:
        fetch order → FILLED → journal close (profit_target) from real fill legs,
        null exit_order_id · non-FILLED terminal (canceled/rejected/expired) →
        null exit_order_id + flag (GTC vanished; next sweep re-places) ·
        WORKING → no-op · PARTIAL → flag only, journal nothing (§6.2)
     b. 21-DTE: for each open trade with dte ≤ 21:
        alert entry "close manually + cancel standing GTC [exit_order_id]" ·
        placement for this trade is SKIPPED (never place a new GTC at ≤21 DTE)
     c. PLACE: for each open trade with exit_order_id IS NULL and dte > 21:
        build exit ticket at 50% target → place GTC → store returned order id
  3. Response payload: { ivResults, exitSweep: { reconciled[], alerts[], placed[], flagged[], errors[] } }
```

- Every Schwab write in (c) follows placement with an immediate order-status fetch; the id is stored only from a confirmed accepted order. **The cron never assumes.**
- Journal writes in (a) use real fill data via the existing transactional path; identical refusal semantics to `recordFillAction` — no fabricated prices, partial fills refuse and flag.
- Auth failure (refresh token dead): entire exitSweep degrades to a single `errors[]` entry; IV snapshot equally dead (shares the token) — the existing ReauthBanner is the operator-facing surface (resolves open question #6; a persistent "last sweep" status row is future polish, not v2.2).

### 4.4 Surfacing (minimum viable)
- Positions Monitor: open condors matched to journal trades show a small `GTC @ $X.XX` chip when `exit_order_id` is set; the existing 21-DTE CLOSE badge text gains "· cancel GTC [id]" when one is standing.
- The cron response payload is the audit record (visible in Vercel logs). No email/push (out of scope, unchanged).

## 5. Resolved open questions (pickup note §"Open questions" 1–6)
1. **GTC id storage:** `trades.exit_order_id` column. ✔ (April, Session 13)
2. **50% of what:** journaled net credit per share, `formatOrderPrice` rounding, pinned in tests. (§4.2)
3. **Rolls:** manual roll flow (panel/journal) sets a **flag in the roll path's returned data + a Monitor warning** "standing GTC [id] targets pre-roll credit — cancel & let next sweep re-place." No auto-cancel/replace in v2.2. Cheapest correct v2.2 behavior: the roll action **nulls `exit_order_id`** so the next sweep re-places at the new net credit — but the operator must still cancel the old order in TOS (the warning says exactly that, with the id, BEFORE nulling makes it invisible — so the roll response carries the old id).
4. **21-DTE forced close:** alert-only. No auto-place, no auto-cancel. ✔ (April, Session 13)
5. **Partial fill of the closing order:** refuse to journal, flag, leave `exit_order_id` intact, re-inspect next sweep. Manual resolution path: journal Close form.
6. **Cron auth failure:** degrade to errors[] + ReauthBanner. (§4.3)

## 6. Hazards on record
1. **Stale GTC after any manual close** — mitigated by alert text everywhere a close is recommended; structurally eliminated in v2.3.
2. **Partial fills** — refusal + flag posture, same as entry (§4.3a).
3. **Roll leaves a mispriced GTC** — §5.3 mechanism; residual risk is the operator ignoring the cancel warning; acceptable for v2.2, auto-replace is future scope.
4. **`exit_order_id` is bookkeeping, not truth.** Nulling the column does not cancel anything at Schwab. Any code path that nulls it MUST surface the id + "cancel in TOS" in the same response. The reconcile's terminal-order handling (§4.3a) is the only path where null-without-warning is correct (Schwab itself reported the order dead).

## 7. Build order
1. Golden fixture: real GTC NET_DEBIT close in TOS → dump → pin. (April, manual, first task)
2. `lib/schwab/exit-ticket.ts` + golden tests (pure, no credentials).
3. `lib/strategy/exit-sweep.ts` — pure sweep planner: `(openTrades, workingOrderStates, today) → { toReconcile, toAlert, toPlace, toFlag }` + tests. All decision logic testable without I/O.
4. Migration: `exit_order_id` (Neon + schema file).
5. `lib/db/journal.ts`: `setExitOrderId`, `clearExitOrderId`, close-from-fill write path (reuse existing transactional close).
6. Cron integration in `snapshot-iv` route: isolation wrappers, response payload.
7. Roll-path flag (§5.3) + Monitor chip/badge text (§4.4).
8. Manual test ladder (mirrors v2.0 layers): (L1) sweep against empty state, no-ops clean · (L2) one open journaled trade → GTC placed, verify in TOS, id stored · (L3) cancel the GTC in TOS → next sweep flags + re-places · (L4) let a GTC fill for real → reconcile journals correct close — **this is also the milestone's live validation of the close-journal path**.

## 8. Prereq check at pickup
- April reviews this draft; any red lines before code.
- Has the first real ENTRY fill happened yet? (Still gates at-fill placement fast-follow only — not this milestone.)
- Confirm 148-test baseline + clean gates on current main before starting.

**End of v2.2 spec draft**
