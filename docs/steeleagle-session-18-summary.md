# SteelEagle — Session 18 Summary

**Date:** July 30, 2026
**Milestone:** **v2.4 step 8 COMPLETE — XSP golden fixture pinned, `orderFixturePinned` flipped; XSP is trade-ready** (`e3df1ff`, 6 files) · V6/V7 answered by live payload · L3/L4 validation loop closed on real trades
**Branch:** main — committed as `e3df1ff`, local `npm run build` clean, **deploy confirmation pending**
**Test baseline:** 410 → **416 passing**

---

## What Was Accomplished

### 1. Session 17 carryover — all four open confirmations resolved (or nearly)

- **`989dfc8` deployed green.** First sweep after it looked normal.
- **L3 ladder CLOSED:** the 7/29 sweep cleared, the 7/30 sweep re-placed. Clear-then-re-place-next-run behaves as designed on live data.
- **Cancel GTC from the Monitor CLOSED:** exercised in-app (not TOS), worked.
- **L4 CLOSED:** a real GTC exit **filled on TLT this week and the sweep journaled it hands-off.** This was the last unvalidated link — the full v2.2 loop (place → stand → fill → auto-journal) has now completed end-to-end on a live trade.
- **Roll-badge fix: STILL UNVERIFIED.** No market-hours load was done this session. One check remains owed: an open condor should show `NONE`/`WATCH`/`ROLL`, not `NO_DELTA`.

### 2. Step 7 — the XSP place-and-cancel golden fixture (April, manual)

An unfillable XSP condor (LP 700 / SP 710 / SC 770 / LC 780, exp 2026-08-27, NET_CREDIT
$9.00, DAY, qty 1) was placed in TOS after hours, read back via
`scripts/dump-working-orders.ts` as **order 1007409658003**, and cancelled.

**V7 answered:** XSP option symbols are **standard OCC, byte-identical in form to the ETF
convention** — `XSP   260827P00700000` (3-char root padded to 6 with spaces, yymmdd, C/P,
strike×1000 in 8 digits). `buildOccSymbol` reproduced every live leg symbol with zero
changes. Root is `XSP` on all legs (single root, confirming Phase 0 V2). The order envelope
(`SINGLE` / `IRON_CONDOR` / `NET_CREDIT` / four `OPTION` legs) is identical to the SPY entry
fixture. No `$` appears anywhere in the option symbols; the only `$XSP` in the payload is in
`optionDeliverables`, which nothing consumes.

**Readback quirks recorded in the fixture (so nobody "fixes" them later):**
- **Leg order differed** from the SPY fixture (LP/SP/SC/LC vs SC/LC/SP/LP). Both accepted by
  Schwab; the app's POSTed order is proven live by the shipped ETF path. Leg order is a TOS
  emission artifact, not a contract — the golden test asserts the leg **set** + exact symbols.
- **`price` echoes as a NUMBER** (`9`) in the GET readback; the POST sends a formatted
  string, proven live.
- **`enteredTime`** uses `+0000` offset format.

**Decision — no second XSP place-and-cancel for the close shape.** The NET_DEBIT/GTC
envelope is pinned by the ETF close fixture (2026-07-24) and proven live by the TLT GTC fill;
the index-specific unknown — symbol format — is pinned by this entry fixture. The two compose.

### 3. Step 8 — flip + golden tests (`e3df1ff`, 6 files)

- **`lib/strategy/instruments.ts`** — XSP `orderFixturePinned: true` with provenance comment
  (order id, date, what it pinned). SPX/NDX/RUT remain `false`. The only source-file change.
- **`lib/schwab/order-ticket.test.ts`** — new **XSP golden fixture** block: all four live leg
  symbols byte-for-byte, envelope, instruction-per-symbol mapping, readback quirks documented
  in the header. Gate tests split: XSP builds; SPX/NDX/RUT refuse.
- **`lib/schwab/exit-ticket.test.ts`** — XSP close builds; composition argument recorded in a
  comment; SPX/NDX/RUT refuse.
- **`lib/journal/current-structure.test.ts`** — XSP flips to fully priceable
  (`isPriceableStructure` true, `structureRefusal` null); SPX remains the multi-root refusal
  example; NDX covers the still-refusing-index case.
- **`lib/strategy/instruments.test.ts`** — gate split: XSP pinned, other three unpinned.
- **`lib/strategy/exit-sweep.test.ts`** — fixture-truthfulness fix: the fabricated
  `unpriceableReason` used an XSP wording that became false at the flip; switched to SPX with
  the real multi-root message so the test describes something the live system produces.

**Gates:** 416 tests · `tsc --noEmit` clean (pinned TS5097 noise only) · collision sweep
empty · `npm run build` clean **locally** (the sandbox build failed only on Google Fonts
network access — environmental, noted for future sandbox runs).

### 4. Incidental confirmations

- **`PENDING_ACTIVATION` is already handled.** The after-hours XSP order surfaced the
  question of whether the sweep's pre-place guard sees not-yet-WORKING orders. It does:
  `WORKING_STATUSES` includes `PENDING_ACTIVATION`, `QUEUED`, and the `AWAITING_*` family,
  and the blocking predicate **fails safe** — anything not terminal and not fully filled
  blocks placement, including unrecognized statuses. No change needed.
- **`dump-working-orders.ts` is read-only** (GET only; cancels/places nothing) — confirmed
  before running against a live standing order.
- The XSP order in the terminal output was a **display/scrollback issue**, not a fetch gap —
  redirecting the dump to a file (`> /tmp/orders-dump.json`) is the pattern going forward.

---

## What This Changes Live (post-deploy)

**XSP is trade-ready end-to-end:** the scanner can build it, the entry path can place it, and
the sweep can auto-place its 50% GTC. In practice **nothing fires** until calibration
completes (~Aug 24–25) and XSP produces a PASS — and the liquidity filter is expected to
FAIL it often even then (that is the filter working, hazard #4).

---

## Key Learnings (repo-wide)

- **A GET readback is not a POST contract.** The XSP readback differed from the SPY fixture
  in leg order and price type; neither difference is meaningful because the shipped POST path
  is proven live. Pin what you POST; document what echoes back; never let echo variance
  trigger a builder "fix."
- **The fail-safe status predicate paid off unprompted.** After-hours placement produced a
  status (`PENDING_ACTIVATION`) nobody had tested against — and the guard already handled it
  because unknown statuses block by design. Fail-safe defaults absorb the cases you didn't
  enumerate.
- **Two pinned fixtures compose.** The XSP close needed no second place-and-cancel: envelope
  pinned by the ETF close fixture + live TLT fill, symbol format pinned by the XSP entry
  fixture. The doctrine gates on *unknowns*, not on ceremony — when every unknown in a path
  is pinned by some fixture, the path is pinned.
- **Redirect long CLI dumps to a file.** Terminal scrollback silently truncated a JSON dump
  and nearly sent the session chasing a phantom fetch bug.
- **When a gate flips, sweep the test suite for fixture text that stated the old world.** The
  exit-sweep planner test fabricated an "XSP has no pinned order fixture" reason that became
  counterfactual at the flip — harmless to gates, misleading to readers. Fixture data should
  describe something the live system can actually produce.

---

## Operator Request Logged This Session (April, 7/30)

**Override gate on EVERY blocker — re-confirmed and sharpened.** (Extends the 7/27 request,
Session 17 item 11 / PRD §9.) Every ticker's card should offer the logged override even when
blocked by: **diversification/position gates** (equity block full, pillar caps, 5-position
cap), **BPR**, or **calibration**. The warnings themselves are critical and must stay fully
visible — override proceeds *past* them, never hides them. Journaling per the v2.1 pattern
(typed reason, violated rules stamped verbatim).

*Design note for the building session (flagged, not decided):* calibration differs in kind
from the other blockers. Overriding a position or BPR gate is "I know the rule, proceed";
overriding CALIBRATING is "place with **no IV Rank data at all**" — the card has no ivRank to
show. The review step should probably render "IV RANK: UNKNOWN (X days of history)" in red
rather than nothing. Also related: the pre-existing display bug where a card shows "15.0%"
while its FAIL reason says "14.9%" (display rounds, filter compares exact) should be fixed in
the same milestone. **Still unscheduled** — currently behind v2.3.1.

---

## Open Items Board (post-Session 18)

1. **`e3df1ff` pushed — verify the Vercel deploy went green.** Then watch the first 4:15 sweep.
   Expected: identical to yesterday's (XSP changes nothing until it PASSes).
2. **Roll-badge live confirmation — STILL OWED** (carried from S17). One market-hours load of
   a page with an open condor: expect `NONE`/`WATCH`/`ROLL`, not `NO_DELTA`.
3. **v2.4 step 11 — manual ladder on the first qualifying XSP setup.** Calendar-blocked:
   calibration completes ~Aug 24–25, then needs IVR > 25% + liquidity PASS. **Sanity-check the
   first XSP liquidity PASS against TOS spreads before trusting it** (hazard #4).
4. **v2.3.1 — roll-form explicit prices. NEXT BUILD MILESTONE.** `RollTradeSchema` still
   coerces `Number('') → 0` — the same defect class F25 fixed for closes; the close-side
   hardening (draft types, null-for-blank, dead submit) is the template. Extra care: a roll
   touches an **open** trade with a possibly-standing GTC — verify the hardening changes
   nothing about roll ↔ `exit_order_id` ↔ sweep re-place interaction before shipping.
5. **Operator override on ALL verdicts** — sharpened this session (see above). Unscheduled,
   queued behind v2.3.1. Includes the 15.0%/14.9% display bug.
6. **Fee table** — index `perContractFee` values remain estimates; corrected at the first real
   index fill.
7. **`minWingWidth` for indices** — tune against a real full-chain look at XSP once calibrated.
8. **V6 (index positions-endpoint payload)** — technically unpinned until a real XSP fill
   exists; practical risk near zero (positions parse via OCC symbol, format now live-confirmed).
9. **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.
10. **Pre-existing ESLint errors** (4, untouched files) — carried.
11. **Doc-refresh queue** — carried: `user_settings` + `pause_exit_placement` absent from the
    committed schema file · `atm_iv ≤ 0` doc-vs-code note · strategy doc §3 same-index line +
    §7 1256 sentence · **PRD/spec §12 status tables now stale** (step 8 complete, XSP pinned).
12. **First real ENTRY fill** (validates `recordFillAction` live; gates at-fill exit placement)
    — still hasn't occurred.

---

## Pickup checklist

```
SteelEagle post-Session 18. State: v2.4 step 8 COMPLETE (e3df1ff) — XSP
golden fixture pinned (order 1007409658003, 2026-07-30), orderFixturePinned
flipped, XSP TRADE-READY pending calibration · 416 tests · deploy of e3df1ff
unconfirmed · 1/2 cron slots · no pending migrations · calibration completes
~Aug 24-25.

FIRST, ask April:
- Did e3df1ff deploy green? Did the first sweep after it look normal
  (expected: identical to before — XSP changes nothing until it PASSes)?
- Roll badges: on a market-hours load, real verdict (NONE/WATCH/ROLL)
  rather than NO_DELTA?  (owed since S17 — the getOptionDeltas 404 fix)
- Has XSP calibrated / produced its first PASS? If PASS: was the spread
  sanity-checked against TOS before trusting it? (hazard #4)
- Any real ENTRY fill yet? Any index fill (corrects the fee table)?

Read first:
- steeleagle-session-18-summary.md              (this doc)
- steeleagle-v2-4-index-options-spec-revB.md    (S12 table now stale: step 7 ✅
                                                 step 8 ✅; step 11 remains)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 416 passing
2. ./node_modules/.bin/tsc --noEmit    -> clean (roll-alert TS5097 noise ok;
                                          rm -rf .next FIRST)
3. rm -rf .next && npm run build       -> clean
4. find app components lib -name "* 2.*"  -> empty

Decisions locked this session (do NOT re-litigate):
- XSP orderFixturePinned: TRUE — pinned by live order 1007409658003.
  SPX/NDX/RUT stay FALSE until each gets its own place-and-cancel.
- NO second XSP place-and-cancel for the close shape: ETF close fixture +
  live TLT fill pin the NET_DEBIT/GTC envelope; the XSP entry fixture pins
  the symbol format; the two compose.
- Golden test asserts the leg SET + byte-exact symbols, NOT leg order —
  readback leg order is a TOS emission artifact (SPY and XSP readbacks
  differed; both accepted; the app's POSTed order is proven live).
- price echoes numeric in GET; POST stays a formatted string (proven live).
- PENDING_ACTIVATION needs no code change — WORKING_STATUSES covers it and
  unknown statuses fail safe (block).

Next work, in order: confirm deploy -> roll-badge check (owed) ->
v2.3.1 roll-form explicit prices (close-side hardening is the template;
verify roll<->exit_order_id<->sweep interaction) -> operator override on
all verdicts (sharpened 7/30: every blocker incl. BPR + calibration;
warnings stay visible; calibration case needs the IV-RANK-UNKNOWN design
note resolved) -> v2.4 step 11 when XSP calibrates (~Aug 24-25).
```

**Final state:** v2.4 steps 3–9 complete (`e3df1ff`), deploy unconfirmed · XSP trade-ready,
gated only by the calendar (calibration ~Aug 24–25) · step 11 is the sole remaining v2.4 item ·
full v2.2 exit loop validated end-to-end on live trades (TLT fill auto-journaled) · roll-badge
confirmation still owed · 416 tests · 1/2 cron slots · no pending migrations.
