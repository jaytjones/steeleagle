# SteelEagle — v2.2 Auto-Exit Spec (FINAL)

**Date:** July 24, 2026 (Session 14)
**Status:** SHIPPED — built Session 14, deployed, first live sweep verified July 25, 2026 (steady-state + a correct 21-DTE alert on SPY 8/14 naming GTC 1007074485891). Manual test ladder: L1/adopted-steady-state PASSED · L3, L4 pending.
**Supersedes:** `steeleagle-v2-2-auto-exit-spec-DRAFT.md` in full.
**Baseline:** v2.1.1 live in prod · 148 tests · 1/2 Vercel cron slots used · `trades.sleeve` narrowed to `'core'` · **no real entry fill yet** (§8 #5 / de-facto L4 still open — gates the at-fill fast-follow only).

---

## 0. Changes from DRAFT (review findings, all April-accepted 2026-07-24)

1. **Rolled trades are excluded from placement in v2.2.** The exit ticket's legs come from entry `open` events only. Any trade with roll events (`roll_close`/`roll_open` present) is **skipped by the placement sweep and flagged for manual GTC**. A pure `currentStructure(events)` reconstruction is promoted to **v2.3** alongside the Monitor close flow. (§4.1a, §5.3 revised)
2. **Wholesale order fetch + pre-place guard.** The sweep fetches working/recent orders **once per run** (importer's `getFilledOrders` pattern) and matches locally by `exit_order_id`. Before any placement, the sweep verifies **no unexpected working close exists on the same underlying+expiration** — closing both the ignored-roll-warning duplicate-GTC hole and the failed-id-write duplicate hole. The sweep acts on Schwab truth, not the bookkeeping column. (§4.3, §6.4 revised)
3. **Placement guard raised to `dte ≥ 24`.** Aligns with the Monitor's 22–23 WATCH band; eliminates place-today-cancel-tomorrow churn at the 21-DTE boundary. (§4.3c)
4. **Exit-price rounding direction is a decision, not an accident:** the 50% debit **rounds down** to the nearest valid tick (profit-favorable side; mechanical 50% is already generous). Tests pin the direction, including odd-cent credits. (§4.2)

---

## 1. Scope

One milestone, three duties, **zero new cron slots**:

1. **GTC placement sweep (primary path).** For every open, **unrolled** journaled condor lacking a standing exit order (and passing the pre-place guard), place a **GTC NET_DEBIT buy-to-close at 50% of the journaled net credit** and record the order id.
2. **Reconcile.** Journal confirmed fills of standing GTC exits as `close` events (`close_reason='profit_target'`).
3. **21-DTE alert (alert-only).** Flag positions at ≤21 DTE, including the explicit instruction **"cancel standing GTC order [id]"**.

All three run inside the existing 4:15 PM ET `snapshot-iv` cron, each try/catch-isolated. The freed second cron slot **stays open** — not consumed by v2.2.

### Explicit decisions carried in from Sessions 12–13 (do not re-litigate)
- **Cron-sweep placement is primary; at-fill placement is a fast-follow** gated on the first real fill validating `recordFillAction` (§8 #5 / de-facto L4, still open). The sweep reads *journaled* net credit — operator-confirmed or imported data — so it ships without L4. The sweep's guards make later at-fill layering a no-op change.
- **21-DTE is alert-only.** The cron never places the forced close and **never cancels a working order.** Auto-cancel was rejected: a canceled GTC + a forgotten manual close leaves an unprotected position; a stale GTC on a closed position fails safe.
- **Stop-losses stay manual** (per strategy).
- **The dropped 12:00 UTC leg is not replaced.** Its duties were: pre-market reconcile (now happens at 4:15 same-day — fills journal hours later, never wrongly) and pre-open 21-DTE flag (redundant: the Positions Monitor computes DTE alerts on every dashboard load, and the 4:15 sweep flags the day before).
- **v2.3 (not this milestone):** close-position flow from the Positions Monitor — cancel-GTC-then-close as one sequenced action — **plus `currentStructure(events)` reconstruction** (finding 1), which lifts the rolled-trade placement exclusion. Reuses this milestone's golden fixture.

## 2. Non-Goals
- No auto-placement of the 21-DTE close. No order cancellation by any cron. No auto-stop-loss. No intraday sweeps (Hobby: once/day). No GTC auto-replace on roll (see §6.3). No at-fill placement (fast-follow). No GTC placement on **rolled** trades (v2.3). No changes to `lib/schwab/order-ticket.ts` entry-side golden tests.

## 3. Schema

```sql
ALTER TABLE trades ADD COLUMN exit_order_id text;  -- null = no standing exit
```
- Nullable text; set when the sweep places the GTC; **cleared to null on `close` regardless of path** (a closed trade has no standing exit by definition — but see §6.4: clearing the column is bookkeeping; the sweep verifies against fetched order state, not the column alone).
- Add to the canonical schema file in the same commit as the migration is run in Neon.

## 4. Design

### 4.1 The exit ticket (build from a golden fixture, FIRST implementation task)
Before any builder code: place ONE real GTC NET_DEBIT condor close in TOS on an open position, dump with `scripts/dump-working-orders.ts`, pin the exact shape as a golden fixture — `duration: "GTC"`, `orderType: "NET_DEBIT"`, the `complexOrderStrategyType` Schwab actually records, leg instructions `BUY_TO_CLOSE` / `SELL_TO_CLOSE`. Never build from docs. New pure module `lib/schwab/exit-ticket.ts` + golden tests, structured exactly like `order-ticket.ts` (which stays untouched).

#### 4.1a Leg derivation (finding 1)
- **Source of truth for the four legs: the trade's entry `open` events** (leg, strike, expiration, contracts). This is exact for unrolled trades.
- **Trades with any roll event are ineligible for placement** in v2.2: the current effective structure exists only implicitly in the event log, and reconstruction is unbuilt. The sweep skips them and emits a `flagged[]` entry: `"rolled trade — place GTC manually at 50% of current net credit"`. The Monitor shows a `MANUAL GTC` chip instead of the `GTC @ $X.XX` chip for these.
- Contract count comes from the trade row; leg quantities must agree (they do by construction for entry events; the exit-ticket builder asserts symmetry and refuses on mismatch rather than guessing — same refusal posture as `recordFillAction`).

### 4.2 Exit price (findings 4 + pickup-note open question #2)
`debit = journaled net credit per share ÷ 2`, then **rounded DOWN to the nearest valid price tick** via the existing `formatOrderPrice` semantics with an explicit floor direction (reuse the formatter; the floor is a wrapper decision, not a re-derivation). Rationale: down is the profit-favorable side, and the mechanical 50% target is already generous — do not pay extra cents to fill a day sooner.
- Unit tests pin the direction, including odd-cent credits: e.g. $2.23 net credit → $1.115 raw → **$1.11** target debit.
- Net credit per share = `(total_credit_collected − total_debit_paid) / (contracts × 100)` from the trade row at sweep time. (With finding 1, rolled trades never reach pricing — but the formula stays roll-correct for v2.3 reuse.)

### 4.3 The folded sweep (inside `snapshot-iv`) — finding 2 topology
Order of duties matters — reconcile before placement (a fill today must not look like a missing GTC):

```
snapshot-iv cron:
  1. IV snapshot (existing, untouched, runs first — exit failures can never drop IV rows)
  2. exitSweep(), fully try/catch-isolated, per-item try/catch inside:
     0. FETCH ONCE: getWorkingAndRecentOrders(hash)  — single /orders call
        (importer's getFilledOrders pattern, widened to include WORKING states).
        All subsequent steps match against this local set. Total order-endpoint
        usage per sweep: 1 fetch + K placements + K confirms — bounded, and
        placements are ≤ open-position count.
     a. RECONCILE: for each open trade with exit_order_id, matched locally:
        FILLED → journal close (profit_target) from real fill legs, null exit_order_id ·
        non-FILLED terminal (canceled/rejected/expired) → null exit_order_id + flag
        (GTC vanished; next sweep re-places) ·
        WORKING → no-op · PARTIAL → flag only, journal nothing (§6.2) ·
        id absent from fetched set → flag "order [id] not found — verify in TOS",
        leave exit_order_id intact (never null on a fetch gap)
     b. 21-DTE: for each open trade with dte ≤ 21:
        alert entry "close manually + cancel standing GTC [exit_order_id]"
     c. PLACE: for each open trade where ALL of:
          exit_order_id IS NULL
          AND dte ≥ 24                                   (finding 3)
          AND no roll events                             (finding 1 → flag instead)
          AND PRE-PLACE GUARD: no working close order exists in the fetched set
              for the same underlying+expiration          (finding 2 → flag
              "unexpected working close [id] — resolve in TOS before sweep places")
        → build exit ticket at 50% target → place GTC → immediate status fetch →
          store returned order id only from a confirmed accepted order
        (22–23 DTE: no placement, no alert — Monitor WATCH band covers it)
  3. Response payload: { ivResults, exitSweep: { reconciled[], alerts[], placed[], flagged[], errors[] } }
```

- Every Schwab write in (c) follows placement with an immediate order-status fetch; the id is stored only from a confirmed accepted order. **The cron never assumes.**
- Journal writes in (a) use real fill data via the existing transactional path; identical refusal semantics to `recordFillAction` — no fabricated prices, partial fills refuse and flag.
- Auth failure (refresh token dead): entire exitSweep degrades to a single `errors[]` entry; IV snapshot equally dead (shares the token) — the existing ReauthBanner is the operator-facing surface (a persistent "last sweep" status row is future polish, not v2.2).

### 4.4 Surfacing (minimum viable)
- Positions Monitor: open condors matched to journal trades show a small `GTC @ $X.XX` chip when `exit_order_id` is set; rolled trades show `MANUAL GTC` (§4.1a); the existing 21-DTE CLOSE badge text gains "· cancel GTC [id]" when one is standing.
- The cron response payload is the audit record (visible in Vercel logs). No email/push (out of scope, unchanged).

## 5. Resolved open questions
1. **GTC id storage:** `trades.exit_order_id` column. ✔ (April, Session 13)
2. **50% of what:** journaled net credit per share, **floored** to a valid tick through `formatOrderPrice` semantics, direction pinned in tests. (§4.2, finding 4)
3. **Rolls:** the manual roll flow **nulls `exit_order_id`** and the roll response carries the old id with the warning "standing GTC [id] targets pre-roll credit — cancel in TOS." With finding 1, the next sweep does **not** re-place (rolled trades are placement-ineligible); it flags for a manual GTC instead. With finding 2, even an ignored warning cannot produce a duplicate: the pre-place guard sees the dangling working close and refuses. Auto-cancel/replace remains future scope (v2.3+).
4. **21-DTE forced close:** alert-only. No auto-place, no auto-cancel. ✔ (April, Session 13)
5. **Partial fill of the closing order:** refuse to journal, flag, leave `exit_order_id` intact, re-inspect next sweep. Manual resolution path: journal Close form.
6. **Cron auth failure:** degrade to errors[] + ReauthBanner. (§4.3)

## 6. Hazards on record
1. **Stale GTC after any manual close** — mitigated by alert text everywhere a close is recommended; additionally caught by the pre-place guard if the position ever re-opens on the same underlying+expiration; structurally eliminated in v2.3.
2. **Partial fills** — refusal + flag posture, same as entry (§4.3a).
3. **Roll leaves a mispriced GTC** — §5.3 mechanism; residual risk of an ignored cancel warning is now bounded to "one stale order sits at Schwab" (pre-place guard prevents duplication); acceptable for v2.2.
4. **`exit_order_id` is bookkeeping, not truth — and the sweep now behaves that way.** Working-order truth is fetched fresh every run (§4.3 step 0); the column is an association hint, never the sole basis for placement. Any code path that nulls it MUST still surface the id + "cancel in TOS" in the same response. Terminal-order handling (§4.3a) remains the only null-without-warning path (Schwab itself reported the order dead). A fetch gap (id not in the returned set) flags and leaves the column intact — never null on missing data.
5. **Duplicate GTC via failed id write** — place succeeds, DB write fails, column stays NULL: next sweep's pre-place guard sees the working close and flags rather than duplicating. (Finding 2 closes this.)

### 6a. Adoption of pre-existing manual GTCs (Session 14 addition)
At kickoff, all 4 open condors already carry **manually placed** GTC closes. Without adoption, the first sweep's pre-place guard flags all four forever and never reconciles their fills. Resolution: **one-time backfill** — after the migration, match each working GTC id (from the fixture dump) to its journaled trade and `UPDATE trades SET exit_order_id = '<id>'` for the four. From then on the sweep reconciles them as its own. Side effects: task 1 requires **no new order** (the fixture is dumped from an existing GTC), and the manual test ladder's L2/L3 become "cancel one adopted GTC in TOS → next sweep clears the terminal state → following sweep re-places at the mechanical floor target." Note the adopted GTCs may sit at prices other than the mechanical 50%-floor — irrelevant to reconcile (`close_reason='profit_target'` regardless), and the sweep never re-prices a working order.

### 6b. Rounding note (§4.2 confirmed against source)
`formatOrderPrice` already **truncates** (`Math.floor(price·10^dp + ε)/10^dp`, 2dp ≥ $1, 4dp < $1) — the finding-4 floor is its existing behavior. The exit-ticket builder reuses it directly; no wrapper. Tests pin $2.23 → $1.115 → `"1.11"`. Open item for the fixture: whether Schwab accepts 4dp sub-$1 NET_DEBIT prices on penny-increment options — the dump answers it.

## 7. Build order
1. Golden fixture: dump the **existing** working GTC closes with `scripts/dump-working-orders.ts` → pin one as the fixture; record all four order ids for the §6a backfill. (April, manual, first task — no order placement needed)
2. `lib/schwab/exit-ticket.ts` + golden tests (pure, no credentials). Includes the floor-rounding wrapper + odd-cent pins (§4.2) and the leg-symmetry refusal (§4.1a).
3. ✅ **DONE (Session 14)** — `lib/strategy/exit-sweep.ts` + `exit-sweep.test.ts` (34 tests): pure planner `planExitSweep(openTrades, orderStates, today) → { toReconcile, toClear, toAlert, toPlace, toFlag }`, `digestOrderForSweep` adapter, `hasRollEvents` helper. Pins: rolled-trade exclusion, 23/24 boundary, pre-place guard incl. fail-safe unknown statuses, id-absent-keeps-id, terminal-clears-without-same-run-replace, partial-fill refusal. Reuses `daysToExpiration` + `parseOccSymbol`.
4. `lib/schwab/orders.ts`: widen the fetch to working+recent states (`getWorkingAndRecentOrders`) — reuse the existing filled-orders plumbing.
5. Migration: `exit_order_id` (Neon + schema file, same commit). **Then the §6a backfill of the four existing GTC ids.**
6. `lib/db/journal.ts`: `setExitOrderId`, `clearExitOrderId`, close-from-fill write path (reuse existing transactional close). Roll action nulls `exit_order_id` and returns the old id (§5.3).
7. Cron integration in `snapshot-iv` route: single order fetch, isolation wrappers, response payload.
8. Roll-path warning + Monitor chips/badge text (§4.4, incl. `MANUAL GTC`).
9. Manual test ladder (mirrors v2.0 layers): (L1) sweep against empty state, no-ops clean · (L2) one open journaled trade → GTC placed, verify in TOS, id stored · (L3) cancel the GTC in TOS → next sweep flags via terminal/absent handling + re-places (guard permitting) · (L4) let a GTC fill for real → reconcile journals correct close — **this is also the milestone's live validation of the close-journal path**.

## 8. Prereqs / state at kickoff (Session 14)
- Draft reviewed; findings 1–4 accepted and folded (this document). ✔
- First real ENTRY fill: **has not happened** (no qualifying opportunities yet). Gates the at-fill fast-follow only — not this milestone. Board item stays open.
- Confirm 148-test baseline + clean gates (`rm -rf .next && npm run build`, `./node_modules/.bin/tsc --noEmit`) on current main before starting.
- **Build task 1 is April's:** the golden-fixture GTC requires an open position to close against — see kickoff note below.

**End of v2.2 spec (FINAL)**
