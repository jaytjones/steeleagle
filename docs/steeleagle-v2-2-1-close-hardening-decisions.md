# SteelEagle — v2.2.1 Close-Form Hardening + Closed-Trade Edit: Decision Record

**Version:** v2.2.1 — BUILT (gates green, not yet deployed)
**Date:** July 28, 2026 (Session 16)
**Status:** Code complete. All three gates pass. **No migration** — no table changed shape.
**Test baseline:** 214 → **255 passing** (+41)
**Companion docs:** `steeleagle-session-15-summary.md` (§1 the repair, §3 the scope), `steeleagle-v2-2-auto-exit-spec-FINAL.md`

> **What this is.** The milestone that closes the manual-write hole behind the SPY 8/14
> journal corruption, plus the edit path that replaces hand-written repair SQL. Written
> after the build, so §1 is settled fact, not proposal.

---

## 0. Root cause — corrected against the code

Session 15 §3 records the defect as "`closeTradeAction` **accepted a 1-leg submission**."
**The code says otherwise, and the distinction changes the fix.**

All four legs were submitted. `TradeCard`'s Close form did `price: Number(r.price)`, and
`Number('') === 0` — so three blank fields arrived as three *explicit* `$0.00` close
events, which `positiveMoney` (`.nonnegative()`) correctly accepted. `LegRowsEditor` also
carried no `required` on its inputs (unlike `NewTradeForm`, which has always had them),
which is what let Enter in the first price field submit a half-typed form.

Consequence for the design: the rule could never be "reject zero" — **$0.00 is a legal
close price** (a worthless 5Δ long genuinely closes there). The fix had to make *blank*
distinguishable from *zero on the wire*, which no amount of range-tightening delivers.
Anything that reasons about "the 1-leg bug" will reach for the wrong guard.

## 1. Decisions — settled, don't re-litigate

- **A close records all four condor legs, unconditionally.** Exactly 4 events, each role
  exactly once, every price explicitly entered. The pre-2.2.1 schema accepted 0…4 legs so
  an expired-worthless exit could be filed with no legs at all — the same latitude that
  let a partially-filled form through. *(April, 7/28: chose the unconditional rule over
  "4 legs unless reason = expired".)*
- **An expiry is journaled as four $0.00 legs.** Accounting-identical (amount 0 moves no
  total) but a complete leg record, and it keeps the rule with no soft edge. The Close
  form carries an **"Expired worthless — all $0.00"** button so this costs one click.
  `closeReason` buys no latitude — pinned by test.
- **Blank ≠ zero on the wire.** The forms send `null` for an untouched field.
  `CloseTradeDraft` / `EditClosedTradeDraft` exist *specifically* to carry `price: number
  | null`, separate from `CloseTradeInput`. **Never widen a draft type to the input type**
  — that single edit reintroduces the corruption.
- **Direction is editable in the edit form; structure never is.** A mis-keyed
  credit/debit corrupts totals exactly as badly as a mis-keyed price, and the only other
  repair is SQL. *(April, 7/28: chose price + direction over price + timing only.)*
  `amount` stays derived (`price × 100 × contracts`, contracts from the stored event) and
  is never operator-entered.
- **Editable = `close` event + `source='manual'` + trade already closed. Nothing else.**
  Entry and roll legs carry live-data provenance (April's standing rule); `schwab_fill`
  legs are Schwab's record of a real execution; leg/strike/expiration/contracts are
  structure. An edit repairs what was typed, it does not restate the position.
- **`closeTradeAction` returns `ActionResult<T>`.** Not cosmetic and not optional: a
  *thrown* refusal is redacted to a digest in production, so the hardening would have
  told April "an error occurred" instead of which leg was blank. A refusal nobody can
  read is not a refusal. `ActionResult`/`toResult` now live in `lib/action-result.ts`.
- **Totals are re-derived from the full event log, never patched incrementally.** The
  Session 15 repair's rule, promoted to code as `deriveTotals(events)`.
- **Refusal is all-or-nothing.** One ineligible id rolls back the entire edit; a
  half-applied repair is worse than none. Same posture as every Schwab-facing write.

## 2. Scope

### 2a. Close-form hardening — four independent guards
1. **Wire:** blank → `null` (`numOrNull`), so absent is distinguishable from `$0.00`.
2. **Schema:** `CloseTradeSchema` = exactly 4 legs (`.length(4)`), each role once
   (`superRefine`), `enteredPrice` / `enteredStrike` refusing `null`/`undefined`/`NaN`
   with an operator-readable message. Server is the authority.
3. **Form structure:** fixed four rows driven off `LEGS` — no add, no remove, roles
   rendered as labels. The leg *count* can no longer be wrong.
4. **Input:** `required` on strike/expiration/price; **Enter blocked in every leg field**
   (`blockEnterSubmit`); submit disabled until `CloseTradeSchema.safeParse(draft)` — the
   same schema the server runs — accepts, with the reasons listed inline.

### 2b. Closed-trade edit
- `Edit Close` on closed cards → editable close legs (price + direction), one **Closed
  At** driving `trades.closed_at` and every edited event's `occurred_at`, plus
  `close_reason` and `notes` (clearable — assigned, not `COALESCE`d).
- Schwab-filled close legs render read-only with a `SCHWAB FILL` chip. Entry/roll legs
  aren't shown at all.
- Live P&L preview shares `planCloseEdit` with the write path, so the number shown before
  saving is the number the transaction computes after it.
- `editClosedTrade` is one transaction: every UPDATE guarded on exact id **and**
  eligibility (`event_type='close' AND source='manual' AND trade_id`), `rowCount !== 1`
  aborts, totals re-derived from the full post-edit log, trade UPDATE guarded on
  `status='closed'`.

### Does NOT (v2.2.1)
- No roll-event editing. Editing a `roll_close` on an open trade desyncs a standing GTC's
  50% target — deferred with v2.3.
- No editing of open trades, entry legs, Schwab-filled legs, or any structural field.
- No per-event timestamps in the UI (the schema supports them; the form applies one).
- No audit row for an edit — an edit rewrites `trade_events` in place, so the log is no
  longer strictly append-only for manual close legs. Deliberate; `notes` is where to
  record why.

## 3. Files

| File | Change |
|---|---|
| `lib/journal/types.ts` | `enteredPrice`/`enteredStrike`; hardened `CloseEventSchema` + `CloseTradeSchema`; `CloseTradeDraft`; `EditClosedTradeSchema` + draft types |
| `lib/journal/trade-math.ts` | `deriveTotals(events)` + `AmountedEvent` |
| `lib/journal/edit-close.ts` | **new** — `isEditableCloseEvent`, `planCloseEdit`, `previewCloseEditTotals` (pure; owns every edit refusal) |
| `lib/action-result.ts` | **new** — `ActionResult<T>` / `toResult` extracted from order-actions |
| `lib/db/journal.ts` | `editClosedTrade`, `requireClosedTrade` |
| `app/journal/actions.ts` | `closeTradeAction` → `ActionResult`; `editClosedTradeAction`; `parseOrThrow` label param |
| `app/dashboard/order-actions.ts` | extraction only — import + `order-actions.*` log labels. **No behaviour change.** |
| `components/journal/LegRowsEditor.tsx` | `required`, `blockEnterSubmit`, `lockRows` mode |
| `components/journal/TradeCard.tsx` | hardened `CloseForm`; new `EditCloseForm`; `FormButtons` gains `disabled` |
| `app/journal/page.tsx` | unwrap `ActionResult` (rethrow client-side so forms render the real reason); wire `onEditClose` |

## 4. Testing

- `lib/journal/close-schema.test.ts` (17) — **new.** Pins the exact Session 15 shape
  (one price, three blank) as REFUSED; `$0.00` accepted; blank strike, negative price,
  zero-leg close, partial close, duplicated role, 5 legs all refused; expiry-as-four-zeros
  accepted.
- `lib/journal/edit-close.test.ts` (17) — **new.** Eligibility refusals (entry leg, roll
  leg, `schwab_fill` by order id, foreign id, duplicate id, all-or-nothing), amount from
  stored contracts, direction flip, `$0.00` repair.
- `lib/journal/trade-math.test.ts` (+5) — `deriveTotals`, including the **SPY 8/14
  regression**: entry 950/395 + the four repaired close legs derives exactly
  **1112.00 / 817.00**, net **$295**.
- `lib/journal/close-from-fill.test.ts` (+2) — **the important one.** The live sweep does
  `CloseTradeSchema.parse(closeInputFromFilledExit(order))`, so tightening that schema
  could have silently stopped the 4:15 sweep from journaling real fills. Pinned green
  against the golden AAPL fixture, including a fill that legitimately closed a leg at
  $0.00. **Any future change to `CloseTradeSchema` must keep these passing.**

**Gates at completion:** 255 tests · `tsc --noEmit` clean (pinned `roll-alert.test.ts`
TS5097 only) · clean `rm -rf .next && npm run build` · no `* 2.*` artifacts · no new lint
errors (`app/journal/page.tsx:53` `set-state-in-effect` is pre-existing — reproduces on
stashed HEAD).

**Manual verification owed before push:** (a) closed card → Edit Close → P&L preview
tracks typing, blank price disables Save; (b) open card → Close stays dead until all four
prices entered, Enter no longer submits, "Expired worthless" fills four zeros;
(c) a refused close shows a real reason, not a digest.

## 5. Residual gaps / v2.3 handoff

1. **The Roll form still coerces `Number('') → 0` server-side.** `LegRowsEditor`'s new
   `required` + Enter-block mitigates it in the browser, but `RollTradeSchema` has no
   explicit-price rule and `RollForm` still sends coerced numbers. **Same defect class,
   client-side mitigation only.** Fix alongside v2.3's roll work.
2. **Close-form strikes prefill from `open` events** → stale on a rolled trade (the
   operator can overwrite them; the field is editable). This is the sibling of the
   rolled-trade placement exclusion — v2.3's `currentStructure(events)` fixes both.
   `deriveTotals` was built as its tested sibling, as Session 15 §5 intended.
3. **`createTradeAction` / `rollTradeAction` still throw** → digest-only messages in
   production. Converting them is mechanical now that `lib/action-result.ts` exists.
4. **Doc refresh:** the Close form's "For an expired-worthless exit, remove all legs"
   help text is gone. Any doc repeating it is stale.

## Pickup checklist

```
SteelEagle post-v2.2.1. Close-form hardening + closed-trade edit are BUILT
(255 tests, gates green, no migration). Manual verification + deploy owed.

Decisions on record (do NOT re-litigate — see §1):
- a close = exactly 4 legs, each role once, every price explicit ($0.00 legal)
- an expiry is four $0.00 legs; closeReason buys no latitude
- blank != zero on the wire; never widen a *Draft type to a *Input type
- edit = close events, source='manual', closed trades; price + direction only
- totals always re-derived from the full event log (deriveTotals)

Guard rail: lib/journal/close-from-fill.test.ts pins the LIVE SWEEP's reconcile
payload against CloseTradeSchema. Changing that schema without re-running it can
stop the 4:15 sweep journaling real fills.

Next: v2.3 (Monitor close flow + currentStructure(events)) — lifts the rolled-trade
placement exclusion and the stale close-form prefill (§5.2). Roll-path explicit
prices (§5.1) ride along.
```

**End of v2.2.1 decision record**
