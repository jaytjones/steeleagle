# SteelEagle — v2.3 Spec: Cancel GTC + `currentStructure(events)`

**Version:** Spec v1.0
**Date:** July 28, 2026 (Session 16)
**Status:** **LIVE — deployed 2026-07-28.** §5.1 implemented at its recorded default
(diagonals refuse); §5.2 and §5.3 deferred (see §6). L3-in-app verification still owed.
**Baseline at build:** v2.2 + v2.2.1 live · L2 confirmed · **278 tests** · 1/2 cron slots ·
25-symbol IV universe calibrating · **no migration**
**Companion docs:** `steeleagle-v2-2-auto-exit-spec-FINAL.md`, `steeleagle-v2-2-1-close-hardening-decisions.md`, `steeleagle-session-15-summary.md`

> **⚠️ Supersedes:** the v2.2 spec §1 line *"close-position flow from the Positions
> Monitor — cancel-GTC-then-close as one sequenced action"* and `session-13-summary.md`
> §5. **The app does not place closing orders.** See §1.2.

---

## 1. Decisions — settled 2026-07-28, don't re-litigate

### 1.1 Naming
- **"Cancel GTC"** — the Monitor action that cancels a standing GTC exit at Schwab.
  Names the object it acts on, so it cannot be misread as a journal action.
- **"Record Close"** — the journal form that writes `close` events. Verb-first, matching
  every other button; supersedes today's "Close Trade" submit label, which becomes
  dangerously ambiguous once a Schwab-facing close exists anywhere in the app.
- No button anywhere places a closing order. If a third action is ever added, name it for
  its object too ("Close Position"), never "Close Trade".

### 1.2 The app cancels; the operator closes (Option B)
Rejected: cancel-then-close as one sequenced action (the v2.2/session-13 scope).

**Rationale.** The hazard v2.3 exists to eliminate is the **dangling GTC** — a standing
50%-profit order on a position that has already been closed, which can silently re-open a
short condor. It is not the typing. Option B removes that hazard with one Schwab write
that already exists and is proven on the entry path, and it avoids:
- a second order-placement path with its own price basis and duration,
- a golden-fixture obligation (a DAY-duration close changes the pinned payload —
  `CondorExitTicket.duration` is the literal `'GOOD_TILL_CANCEL'`),
- a partial-failure window where the cancel succeeds, the close rejects, and the position
  sits unprotected — the exact state the 21-DTE auto-cancel rejection was designed to
  prevent.

The flow is therefore: **Cancel GTC (in app) → close in TOS → Record Close (in app).**

### 1.3 No price basis in v2.3
Struck entirely. The sweep's GTC NET_DEBIT at 50% of journaled net credit remains the
**only** app-placed exit. `computeExitDebit` stays profit-target-only and keeps its
deliberate floor direction (v2.2 finding 4); nothing in v2.3 prices an order.

### 1.4 Re-placement after a cancel is accepted behaviour
Cancel at `dte ≥ 24` without closing → the next sweep sees CANCELED and clears
`exit_order_id`; the sweep after that re-places at the floored 50% target. **This is
correct**: a still-open position should carry a profit-target exit. At `dte ≤ 23` the
existing `PLACEMENT_MIN_DTE = 24` guard already prevents re-placement, which is the case
that matters (cancelling in order to close).

Consequently: **no per-trade placement-suppression flag, no new column, no migration.**

### 1.5 `currentStructure(events)` stays in scope
Unchanged from v2.2 finding 1. `deriveTotals(events)` (v2.2.1) was built as its tested
sibling.

## 2. Scope

### 2a. Cancel GTC (Positions Monitor)
Everything needed is already on the Monitor's payload — `p.journalExit` carries
`tradeId`, `exitOrderId`, `rolled`, `targetDebit` (`app/api/positions/route.ts`).

- **Affordance** next to the standing-exit chip, and in the ≤21-DTE alert where
  `withGtcCancel` already appends `"cancel standing GTC {id}"` — the button belongs
  exactly where that instruction is printed today.
- **Operator confirm before submit.** It is a live-money Schwab write; same posture as
  `PlaceOrderPanel`. Nothing one-click.
- **New server action** `cancelStandingExitAction(tradeId, orderId)` → `ActionResult<T>`,
  colocated with the existing order actions. Reuses `cancelOrder` + the read-back that
  `cancelCondorOrderAction` already performs, then `clearExitOrderId(tradeId)`.
- **Refusal postures (non-negotiable, inherited from v2.2 §6.4):**
  - Clear `exit_order_id` **only on a confirmed terminal state read back from Schwab**.
    A fetch gap must leave the column intact — never null it on a failed read.
  - **The FILLED race is a distinct outcome, not an error.** If the GTC filled before the
    cancel landed, Schwab rejects the cancel. The app must say so plainly: *"GTC {id}
    FILLED — the position is closed. Do NOT close in TOS. The 4:15 sweep will reconcile
    and journal it."* Silently reporting a failed cancel invites a double-close.
  - Already CANCELED / REJECTED / EXPIRED → treat as terminal, clear the column, report
    the state Schwab actually returned.
- **After a successful cancel** the chip disappears (the column is null) and the position
  is on the operator to close in TOS, then Record Close.

### 2b. `currentStructure(events)` — pure module
- Folds the event log into the trade's **current effective four legs**: entry `open`
  events, then each `roll_close` (removes a leg) / `roll_open` (adds its replacement) in
  `occurredAt`, `createdAt` order.
- Returns the shape `buildCondorExitTicket` already consumes (`CondorExitInput`: symbol,
  expiration, four strikes), so the ticket builder and its golden tests are untouched.
- **Refusal posture identical to `exitInputFromOpenEvents`**: any ambiguity throws —
  never guess a leg. Refuse on a result that isn't exactly four legs, one per role.
- Lifts the rolled-trade placement exclusion: `planExitSweep`'s `hasRollEvents` gate
  narrows to "structures `currentStructure` refuses" (see §5.1), and the `MANUAL GTC`
  chip narrows with it.
- Replaces `exitInputFromOpenEvents` as the sweep's leg source. Keep the old function
  only if it earns its place as an unrolled fast path; otherwise delete it in the same
  commit so there is one leg-derivation path, not two.

### Does NOT (v2.3)
- **No closing orders placed by the app** (§1.2). No price basis, no new fixture.
- No order cancellation by any cron — the 21-DTE cron stays alert-only (v2.2 decision,
  unchanged). Cancel GTC is operator-initiated only.
- No per-trade placement suppression; no migration; no schema change.
- No stop-loss automation. No at-fill fast-follow (still gated on the first real entry
  fill / L4).
- No changes to `order-ticket.ts` entry-side or `exit-ticket.ts` golden tests.

## 3. Files

| File | Change |
|---|---|
| `lib/journal/current-structure.ts` | **new** — pure `currentStructure(events)` + refusals |
| `lib/schwab/exit-ticket.ts` | consume `currentStructure`; retire or demote `exitInputFromOpenEvents` |
| `lib/strategy/exit-sweep.ts` | narrow the `hasRollEvents` placement gate |
| `app/api/cron/snapshot-iv/route.ts` | switch the sweep's leg derivation |
| `app/dashboard/order-actions.ts` | **new** `cancelStandingExitAction` (cancel + read back + `clearExitOrderId`) |
| `components/positions/PositionsMonitor.tsx` | Cancel GTC affordance + confirm + result/FILLED surface; `GtcChip` / `MANUAL GTC` narrowed |
| `lib/db/journal.ts` | none — `clearExitOrderId` already exists |
| `components/journal/TradeCard.tsx` | rename the close submit label to **Record Close** |

## 4. Testing

**Pure (`currentStructure`), tests first:**
- unrolled trade → identical to `exitInputFromOpenEvents` today (pin the equivalence)
- one-sided roll (put spread rolled down) → rolled side updated, call side untouched
- full four-leg roll to a new expiration
- two sequential rolls → the *last* structure wins
- roll_close with no matching roll_open → refuse (3 legs, never guess)
- duplicate role after folding → refuse
- asymmetric expirations → per §5.1

**Cancel GTC:** FILLED-race → distinct message, column NOT cleared by the action (the
sweep's reconcile owns it) · already-terminal → clear + report · fetch gap → column
intact · successful cancel → column null, chip gone.

**Regression:** the sweep places on a previously-excluded rolled trade at the correct
floored target · `close-from-fill.test.ts` and the exit-ticket golden tests stay green.

**Manual:** L3-in-app — cancel a real sweep-placed GTC from the Monitor, confirm in TOS,
confirm the next sweep does not report it in `cleared[]` (the action already cleared it),
confirm the following sweep re-places when `dte ≥ 24` (§1.4).

**Prerequisite:** **L2 must be confirmed first** — Cancel GTC needs a real sweep-placed
GTC to act on. L3 is the natural validation of this feature.

## 5. Open questions (resolve at pickup)

1. **Asymmetric expirations after a one-sided roll.** If a roll moves only the put side
   out in time, the four legs span two expirations. `CondorExitInput` carries a single
   `expiration`, and `buildCondorExitTicket` emits `complexOrderStrategyType:
   'IRON_CONDOR'` — a two-expiration structure is a diagonal, which Schwab may not accept
   under that strategy type at all.
   **Default: refuse.** `currentStructure` throws on multi-expiration; those trades keep
   the `MANUAL GTC` chip. This lifts the exclusion for same-expiration rolls (the common
   case) with **no fixture obligation**. Supporting them properly means per-leg
   expirations in the ticket — a new payload shape, therefore a new live fixture, and
   its own milestone.
2. Does Cancel GTC also belong on the journal's `TradeCard` (which shows `exitOrderId`),
   or is the Monitor the single home? **Default: Monitor only** — one affordance, one
   place, matching where the 21-DTE instruction already prints.
3. Roll-path explicit prices (`v2.2.1 §5.1`): `RollTradeSchema` still coerces
   `Number('') → 0` server-side, mitigated only by the browser `required`. Fold into
   v2.3's roll work or leave for a v2.3.1? **Default: fold in** — it's the same defect
   class that corrupted SPY 8/14, and v2.3 is already touching roll semantics.

## 6. Build outcome (2026-07-28) — DEPLOYED

Built in the spec's order and **deployed the same day**. **278 tests** (255 → 278), `tsc`
clean but the pinned `roll-alert.test.ts` TS5097, clean build, no new lint errors, no
migration. **Cancel GTC is live on the Positions Monitor.**

**Resolved during the build:**
- **§5.1 → implemented as the default.** `currentStructure` refuses multi-expiration
  legs; those trades keep `MANUAL GTC`. Same-expiration rolls are now auto-placed.
- **§5.2 → Monitor only.** Cancel GTC lives beside the `GTC @ $X.XX` chip; the journal
  card was not given a second affordance.
- **§5.3 → deferred, not folded in.** The roll form's `Number('') → 0` coercion is
  untouched; v2.3 changed roll *reading* (`currentStructure`), not roll *writing*, so
  folding the schema work in would have widened a live-money milestone for no shared
  code. **Still open — carry to v2.3.1.**

**Two decisions taken inside the build, both narrowing what auto-clears:**
1. **`hasRollEvents` is gone.** Placement eligibility is now
   `isPriceableStructure(events)` — the same predicate drives the planner gate AND the
   Monitor chip (`journalExit.manualGtc`), so the chip cannot promise something the
   sweep won't do. `exitInputFromOpenEvents` was deleted rather than deprecated: two
   leg-derivation paths is precisely how a rolled trade gets priced at pre-roll strikes.
   Its golden end-to-end test survives, re-pointed at `currentStructure`.
2. **`PENDING_CANCEL` does not clear `exit_order_id`.** A pending cancel can still fill;
   clearing early would let the next sweep place a second GTC against a live order. The
   action clears only on a confirmed terminal status and otherwise defers to the sweep's
   own clear path. Pinned by a test asserting `clearColumn === false` across every
   non-terminal status.

**Manual verification owed (L3-in-app) — STILL OPEN despite the deploy:** cancel a real
sweep-placed GTC *from the Monitor* → confirm gone in TOS → confirm the chip clears →
confirm the following sweep re-places when `dte ≥ 24` (§1.4). The 7/28 after-hours cancel
was done **in TOS**, which exercises the sweep's clear path, not this action. Also worth
one live look at a `MANUAL GTC` chip if a diagonal ever exists.

**Watch on the first live run:** the sweep gate changed from "is it rolled" to
`isPriceableStructure`. Any rolled, same-expiration trade that previously showed
`MANUAL GTC` is now placement-eligible and will receive an auto-placed GTC on the next
sweep where `dte ≥ 24`. That is the intended lift — but it is the one behaviour change
that places a real order without a further prompt.

## Pickup checklist

```
Starting SteelEagle v2.3 — Cancel GTC + currentStructure(events).

Read first:
- steeleagle-v2-3-spec.md                        (this doc)
- steeleagle-v2-2-auto-exit-spec-FINAL.md        (sweep + refusal postures)
- steeleagle-v2-2-1-close-hardening-decisions.md (§5 residual gaps)

Decisions on record (§1 — do NOT re-litigate):
- naming: "Cancel GTC" (Monitor, Schwab write) + "Record Close" (journal)
- the app CANCELS; April closes in TOS; Record Close journals it.
  Option A (cancel-then-close sequenced) is REJECTED — supersedes v2.2 spec §1
- no price basis in v2.3; the 50% sweep GTC stays the only app-placed exit
- re-placement at dte >= 24 after a cancel is CORRECT; no suppression column
- no migration, no schema change

Prereq: L2 confirmed (a real sweep-placed GTC exists to cancel).

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 255 passing
2. ./node_modules/.bin/tsc --noEmit    -> clean (roll-alert TS5097 noise ok)
3. rm -rf .next && npm run build       -> clean

Build order: currentStructure (pure + tests) -> sweep wiring -> Cancel GTC action
-> Monitor UI -> Record Close rename.
```

**End of v2.3 spec**
