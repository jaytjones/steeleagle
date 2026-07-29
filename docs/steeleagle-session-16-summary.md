# SteelEagle — Session 16 Summary

**Date:** July 28, 2026
**Milestone:** **v2.2.1 and v2.3 both BUILT + DEPLOYED** · **L2 CLOSED** · L3 in flight · PRD + Tech Spec refreshed to v2.3
**Branch:** main
**Test baseline:** 214 → **278 passing** (+64, no migrations in either milestone)

---

## What Was Accomplished

### 1. v2.2.1 — Close-form hardening + closed-trade edit (BUILT → DEPLOYED)
**Root cause corrected against the code.** Session 15 §3 recorded the defect as
"`closeTradeAction` accepted a 1-leg submission." It didn't. All four legs were submitted — the
form did `price: Number(r.price)`, and `Number('') === 0`, so three blank fields became three
*explicit* `$0.00` close events that `.nonnegative()` correctly accepted. `LegRowsEditor` also had
no `required` on its inputs (unlike `NewTradeForm`), which is what let Enter submit a half-typed
form. **This changes the fix**: the rule can never be "reject zero" — `$0.00` is a legal close
price — it has to be "reject *absent*", which means blank must be distinguishable from zero on
the wire.

Shipped:
- **Four independent guards.** Blank travels as `null`, not `0` · `CloseTradeSchema` demands
  exactly 4 legs, each role once, every price explicit · fixed four rows (no add/remove, roles
  read-only) · submit disabled until the *same schema the server runs* accepts the draft.
- **`closeTradeAction` → `ActionResult<T>`.** Not cosmetic: a thrown refusal is redacted to a
  digest in production, so the hardening would have told April "an error occurred" instead of
  which leg was blank. `ActionResult`/`toResult` extracted to `lib/action-result.ts`.
- **Closed-trade edit** — `close` events with `source='manual'` on a closed trade: price,
  direction, timing, plus trade-level reason/closed-at/notes. Totals **re-derived from the full
  event log** (`deriveTotals`), never patched. One ineligible leg rolls back the whole edit.
- **Sweep pinned.** The reconcile does `CloseTradeSchema.parse(closeInputFromFilledExit(order))`,
  so tightening that schema could have silently stopped the live 4:15 sweep from journaling real
  fills. Two tests against the golden AAPL fixture now guard it, including a `$0.00` leg.

Decisions (April, this session): **always four legs + a `$0.00` quick-fill** (an expiry is
journaled as four zero legs, not zero rows) · **direction editable** alongside price.

### 2. v2.3 — spec written, built, and deployed
No v2.3 spec existed; scope was scattered across five docs, and two of them contradicted what
April actually wanted.

**The fork that mattered.** The recorded scope (v2.2 spec §1, session 13 §5) was
"cancel-GTC-then-**close** as one sequenced action" — the app placing a closing order. That's
where the price-basis question came from: the sweep's 50%-profit GTC cannot express "I want out
now" (`computeExitDebit` throws outright on a non-positive net credit, and `formatOrderPrice`
floors, which is backwards for a debit you're paying to exit). April's own naming proposal —
"Cancel GTC" + "Record Close", with no name for a third order-placing action — surfaced that she
didn't want one. **Option B adopted: the app cancels, April closes in TOS, Record Close journals
it.** Price basis struck entirely; no new order shape, therefore no new golden fixture, and no
window where the cancel succeeds, the close rejects, and the position sits unprotected.

Built in the spec's order:
- **`currentStructure(events)`** — folds the whole event log into the four legs currently held.
- **Sweep gate switched** from `hasRollEvents` to `isPriceableStructure(events)`: same-expiration
  rolls now auto-place; diagonals keep `MANUAL GTC`.
- **`cancel-exit.ts`** pure planner + `cancelStandingExitAction` + a two-step confirm on the
  Monitor beside the `GTC @ $X.XX` chip.
- **Record Close** rename on the journal card.

**Deployed 2026-07-28.** Cancel GTC is live on the Positions Monitor. Note the one
behaviour change that acts without a further prompt: the sweep gate moved from
`hasRollEvents` to `isPriceableStructure`, so any rolled, same-expiration trade that
previously showed `MANUAL GTC` is now placement-eligible and will receive an auto-placed
GTC on the next sweep where `dte ≥ 24`.

### 3. L2 CLOSED, L3 in flight
April confirmed the 7/28 sweep placed the SPY 8/28 GTC — **the first sweep-PLACED order**, which
closes session 15's open item #1(a) and validates the placement path end to end.

A GTC was then **cancelled in TOS after hours on 7/28**. Expected ladder: the **7/29** sweep
reports it in `cleared[]`; the **7/30** sweep re-places at the floored 50% target. SPY 8/28 gives
dte 30 and 29 on those days, both clear of `PLACEMENT_MIN_DTE = 24`, so nothing blocks the
re-place. **L3 completes when that re-placement lands.**

### 4. PRD + Tech Spec refreshed (v1.5.1 → v2.3)
Six milestones of staleness cleared. **The single largest correction: F18, the Tactical Earnings
Sleeve, no longer exists** — the old PRD documented a whole product surface deleted in v2.1.1.
Also corrected: seven tables → six (`earnings_calendar` dropped), two crons → one, eleven API
routes → eight, Finnhub removed as a dependency, and the execution line moved (SteelEagle now
places entry orders and standing profit-target exits).

New: `steeleagle-prd-v2-3.md`, `steeleagle-tech-spec-v2-3.md`, `steeleagle-v2-3-spec.md`,
`steeleagle-v2-2-1-close-hardening-decisions.md`.

---

## Key Learnings (repo-wide)

- **Session summaries are evidence, not truth.** Two documented "facts" were wrong this session:
  the 1-leg close (actually blank-price coercion) and the v2.3 scope (a sequenced close April
  didn't want). Both were caught by reading the code and by asking, not by trusting the doc.
  Corollary: when a summary and the code disagree, the code wins and the summary gets a
  correction note.
- **`Number('') === 0` is a live-money defect class, not a UI nit.** It also still exists on the
  **roll** path (`RollTradeSchema`), mitigated only by the browser `required`. Queued as v2.3.1.
- **A refusal nobody can read is not a refusal.** Next.js redacts thrown server-action messages
  in production. Any new refusal on an operator path must return `ActionResult`, or the guard is
  invisible exactly when it fires.
- **Two derivation paths for the same fact is a bug waiting to happen.** `exitInputFromOpenEvents`
  was deleted rather than deprecated, and the Monitor chip now shares the planner's exact
  predicate — a chip that says `MANUAL GTC` while the sweep auto-places (or vice versa) is a lie
  the operator acts on.
- **A pending cancel can still fill.** `PENDING_CANCEL` must not clear `exit_order_id`, or the
  next sweep places a second GTC against a live order. Pinned by a test asserting
  `clearColumn === false` across every non-terminal status.
- **Naming is a safety feature here.** "Close Trade" meaning *journal a close* on the same app
  where a button cancels a real order is how an operator cancels a GTC believing they wrote a
  row. Hence Cancel GTC (acts at Schwab) vs Record Close (journals only).
- **Ask before building when the doc and the person may differ.** The single question about price
  basis deleted a fixture obligation, an order-placement path, and an unprotected-position window.

---

## Open Items Board (post-Session 16)

1. **v2.3 DEPLOYED** (2026-07-28) — done. Verification still owed (#2, #3).
2. **L3 completion:** confirm the 7/29 sweep reports the cancelled GTC in `cleared[]` and the
   7/30 sweep re-places at the floored 50% target.
3. **L3-in-app (v2.3 verification) — STILL OPEN:** cancel a real sweep-placed GTC *from the
   Monitor* → gone in TOS → chip clears → following sweep re-places when `dte ≥ 24`. The 7/28
   after-hours cancel was done **in TOS**, which exercises the sweep's clear path, not the new
   action. Also worth confirming on the first post-deploy sweep that no rolled trade received an
   unexpected GTC (see §2).
4. **L4 still open** (next GTC **fill**): **hands off** — let the 4:15 sweep reconcile and journal
   it, then verify. Also still open: the first real ENTRY fill (gates the at-fill fast-follow only).
5. **v2.3.1** — roll-form explicit prices (`RollTradeSchema` still coerces `Number('') → 0`).
6. **v2.4 spec → rev B:** fold in `steeleagle-v2-4-phase0-findings.md` (incl. the `settlementType`
   AM/PM trap). Calibration for XSP/SPX/NDX/RUT completes **~Aug 24–25**.
7. **Operator override on ALL verdicts** (April, 7/27) — unscheduled. Plus the display bug it
   surfaced: a card shows "15.0%" while its FAIL reason says "14.9%" (display rounds, filter
   compares exact).
8. **Doc-refresh queue (much reduced):** `user_settings` + `pause_exit_placement` still absent
   from the committed schema file · the `atm_iv ≤ 0` doc-vs-code note · strategy doc §3 same-index
   line + §7 1256 sentence.
9. **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.
10. Equity block at 2/2 with twin SPY positions — expected BLOCKs on equity candidates until one
    closes.

---

## Pickup checklist

```
SteelEagle post-Session 16. State: v2.2.1 + v2.3 BOTH LIVE (deployed 7/28) ·
278 tests · 1/2 cron slots · 25-symbol IV universe calibrating since 7/28 ·
L2 CLOSED · L3 in flight (cancelled 7/28 -> expect cleared[] 7/29, re-place 7/30).

FIRST, ask April:
- Did the 7/29 sweep report the cancelled GTC in cleared[]?
- Did the 7/30 sweep re-place it at the floored 50% target?  (= L3 closed)
- Has L3-in-app been run (Cancel GTC from the MONITOR, not TOS)?
- On the first post-deploy sweep, did any rolled trade get an auto-placed GTC?
  (expected: same-expiration rolls are now eligible -- confirm it was intended)
- Any GTC FILL since? (if yes: did the SWEEP journal it -- L4)

Read first:
- steeleagle-v2-3-spec.md                        (decisions §1, build outcome §6)
- steeleagle-v2-2-1-close-hardening-decisions.md (§0 root cause, §5 residual gaps)
- steeleagle-prd-v2-3.md / steeleagle-tech-spec-v2-3.md   (current-state reference)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 278 passing
2. ./node_modules/.bin/tsc --noEmit    -> clean (roll-alert TS5097 noise ok)
3. rm -rf .next && npm run build       -> clean

Decisions locked this session (do NOT re-litigate):
- a close = exactly 4 legs, each role once, every price explicit ($0.00 legal, blank not)
- an expiry is journaled as four $0.00 legs; closeReason buys no latitude
- closed-trade edit covers price + DIRECTION; structure immutable; totals re-derived
- v2.3 = the app CANCELS; April closes in TOS; Record Close journals it.
  Sequenced cancel-then-close REJECTED (supersedes v2.2 spec §1 + session 13 §5)
- no price basis in v2.3; the 50% sweep GTC stays the only app-placed exit
- re-placement at dte >= 24 after a cancel is CORRECT; no suppression column
- placement eligibility = isPriceableStructure(events), NOT "is it rolled"

Next work, in order: verify v2.3 live (L3-in-app) -> v2.3.1 (roll-form prices) ->
v2.4 rev B fold-in. Calibration completes ~Aug 24-25.

Standing instruction: next GTC fill = hands off, let the sweep journal it (L4).
```

**Final state:** v2.2.1 and v2.3 both live · L2 closed, L3 mid-ladder, L3-in-app owed · PRD/Tech
Spec current for the first time since June 15 · 278 tests · 1/2 cron slots.
