# SteelEagle — Session 18 Summary

**Date:** July 30, 2026 · **amended July 31, 2026** (see the Addendum)
**Milestone:** **v2.4 step 8 COMPLETE — XSP golden fixture pinned, `orderFixturePinned` flipped; XSP is trade-ready** (`e3df1ff`, 6 files) · V6/V7 answered by live payload · L3/L4 validation loop closed on real trades
**Branch:** main — committed as `e3df1ff`, local `npm run build` clean, **deploy confirmation pending**
**Test baseline:** 410 → **416 passing**

> ⚠️ **Correction (2026-07-31).** The 416 figure recorded below was never actually observed.
> `e3df1ff` also **moved** `lib/schwab/exit-ticket.test.ts` into `lib/journal/`, where its relative
> import `./exit-ticket` no longer resolved — so the AAPL golden close fixture stopped running in
> the same commit that pinned the XSP one. The real state at `e3df1ff` was **395 tests with 1
> failing**. Restored in `bad4c96`; 416 became true retroactively. Everything else in §3 stands.
> See the Addendum for the full post-summary record.

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

> ⚠️ **The test gate did not actually pass here** — see the correction at the top. `tsx --test`
> reported the misfiled `exit-ticket.test.ts` as a failing test, and the count as 395. The
> lesson is recorded in the Addendum's Key Learnings: read the tsx summary line, not just the
> tail of the output.

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

## Addendum — work completed after this summary was written (2026-07-31)

Five commits landed on top of `1ffad49`. All four gates were run green before each code commit.

### A1. `bad4c96` — baseline repair

`e3df1ff` had moved `lib/schwab/exit-ticket.test.ts` → `lib/journal/`, breaking its relative
import and silently removing the AAPL golden close fixture from the suite. Pure move back, zero
content change. **395 (1 failing) → 416 passing.** The fixture had been dark for the entire step-8
session — including while step 8 flipped XSP to trade-ready.

### A2. `d088f53` — v2.3.1 roll-form explicit prices (F25 ported to the roll path)

- `RollDraftLeg` / `RollTradeDraft` — blank travels as `null`, never `0`. Never widen to
  `RollTradeInput`.
- `RollEventSchema` demands `enteredStrike` + `enteredPrice`: **$0.00 is legal, blank is not.**
- Submit is dead until `RollTradeSchema` — the schema the server enforces — accepts the draft.
- `rollTradeAction` returns `ActionResult<T>`.

**The roll-leg invariant is NOT the close form's rule.** A roll touches 2 legs to 8, so rows stay
dynamic; the invariant comes from `currentStructure`'s fold instead:

| Case | Ruling | Why |
| :--- | :--- | :--- |
| Duplicate `(eventType, leg)` | **Refuse** | Duplicate `roll_close` throws downstream; duplicate `roll_open` silently last-wins |
| `roll_open` with no matching `roll_close` | **Refuse** | The fold overwrites a live leg with no record of the old one closing |
| `roll_close` with no matching `roll_open` | **ALLOW** | Already fail-safe (`currentStructure` refuses → MANUAL GTC chip), and it is the only way to journal a one-sided unwind |

*Decided with April 2026-07-30. Do not tighten to strict pairing without reopening it.*

**Stale operator-facing text corrected.** The roll warning claimed *"auto-placement is excluded
for rolled trades"* — true under v2.2's `hasRollEvents` gate, **false since v2.3** replaced it
with `isPriceableStructure`. It now asks `structureRefusal` what the post-roll structure actually
is: same-expiration roll → the sweep re-places next run; diagonal → place manually. The same
stale claim in `dbRollTrade`'s doc comment was corrected.

`roll-exit-interaction.test.ts` pins the roll → `exit_order_id` → sweep chain as unchanged.

### A3. `42f1a86` — v2.4 spec rev-B status refresh

§8, §11 hazard 7, §12 and §13 no longer describe the milestone as fixture-blocked.

### A4. `8b9ab14` — v2.3.2 entry-form explicit prices (F25, third and last path)

**`NewTradeForm` had the identical defect, and it is the highest-stakes of the three:** a $0.00
entry leg corrupts `initialCredit` → `netCredit` → `profitTargetBuyback` — **and that is the price
the sweep places the standing 50% GTC at.** The close-side corruption mangled history; a blank
here mis-prices a *live working order at Schwab*.

- `NewTradeDraft` / `NewTradeLegDraft`; dead submit; `blockEnterSubmit` on leg fields.
- **`LegInputSchema` hardened at the BASE**, so any future writer inherits "explicitly entered"
  by default instead of opting in.
- The net-credit preview now reads the draft, so it can no longer disagree with what gets filed
  (a blank leg is excluded and labelled *partial*, not counted as $0.00).
- `createTradeAction` returns `ActionResult<T>` — **every** journal write path now does.

**BPR is deliberately stricter than price: 0 is refused.** $0.00 is a legitimate *price*, but a
four-leg condor always reduces buying power, so 0 only ever means "unset". Two places already
assumed this — `recordFillAction` floors it at $0.01, and `ImportCandidate.initialBpr` documents
its 0 default as an operator placeholder. A 0 BPR silently under-counted the position-limit and
BPR gates. **This tightens the importer too** (shared schema); the review panel gained a matching
client-side guard so it names the reason instead of failing per-candidate at import time.

### A5. Doc refresh — the carried queue, resolved

- **`user_settings` + `pause_exit_placement`: was already folded in** at `supabase-schema.sql`
  lines 56–73, matching the migration. The board carried this as open from S15 through S18 after
  it had been done. Closed.
- **Schema-file misname: left alone deliberately.** No code references it; ~10 session summaries
  do, by name, as the decision log. Renaming buys cosmetics and orphans the log.
- Strategy doc §3 gained the **same-index rule** (XSP/SPX ≡ SPY, NDX ≡ QQQ, RUT ≡ IWM — zero
  diversification between an index and its ETF; the app enforces it via `resolveUnderlying`).
- Strategy doc §7 tax treatment split: ETF options stay short-term; **index options are Section
  1256** (60/40 regardless of holding period, year-end mark-to-market).
- PRD §9 / §10 and tech-spec §6 / §7 / §8 refreshed (Phases 17–18, 450 tests).

### A6. 🔴 NEW BUG FOUND — IV Rank zero-row contamination (high, UNFIXED)

Resolving the carried "`atm_iv ≤ 0` doc-vs-code note" showed the docs describe a guard that
**does not exist in the code**:

- The v1.2 tech spec and v1.5.1 PRD both state the cron "skips writes when `atm_iv ≤ 0`" and that
  "the IV Rank query ignores rows with `atm_iv <= 0`". **Neither guard is implemented.**
- `app/api/cron/snapshot-iv/route.ts` skips only on `null` — and `volatility ?? impliedVolatility
  ?? null` does **not** treat a Schwab-returned `0` as absent, so after-hours zeros persist.
- `lib/strategy/iv-rank.ts` selects every row in the 365-day window with no `> 0` filter.
- **Effect:** one zero row drags `low52w` to 0, so `ivRank ≈ currentIv / high52w × 100` —
  systematically **overstated**, biasing toward false PASS. Zero rows also count toward
  `MIN_DAYS_REQUIRED = 20`.
- The v1.2 risk table identified this exact hazard and recorded both guards as its mitigation.
  **The mitigation was documented but never built.**

**Left unfixed on purpose:** adding `WHERE atm_iv > 0` drops contaminated rows out of
`daysOfHistory`, which can revert symbols to CALIBRATING — including the four index symbols
calibrating since 2026-07-28. That is April's call, not a silent code change. Full write-up in
PRD §9a, with this read-only diagnostic to run first:

```sql
SELECT symbol, count(*) FILTER (WHERE atm_iv <= 0) AS bad, count(*) AS total
FROM iv_history GROUP BY symbol ORDER BY bad DESC;
```

### A7. `cd19fed` — v2.5 operator override on ALL verdicts

Shipped as a **prerequisite** for A9, not on its own merits. Resetting IV history
would put every card in CALIBRATING for ~20 trading days, and before this commit a
non-PASS card had **no override path at all**: `ScannerCard` rendered the whole
placement panel behind `{condor.passesFilter && …}`, so there was no button to press.
`computeEntryGate` encoded the same assumption, short-circuiting to OK on any
non-PASS card. Rebuilding first would have been a self-inflicted four-week outage.

April confirmed the scope on 7/31: **the override extends to FAIL as well** — "it
should truly be done as an exception, but I want the option available regardless."

- **`lib/strategy/override-gate.ts` (NEW, pure)** — ONE predicate for "must this be
  overridden, and what exactly is being overridden?", read by both the UI gate and
  the journal stamp so they can never disagree. Same doctrine as
  `isPriceableStructure`. Owns `MIN_IV_HISTORY_DAYS`, previously restated in three
  places; `iv-rank.ts` consumes it (pure module owns the constant, the I/O module
  imports it — not the reverse, or the constant drags SQL into unit tests).
- **`computeEntryGate` no longer short-circuits**, and its `passesFilter` param is
  gone. Overriding a FAIL creates neither buying power nor a free position slot.
- **CALIBRATING is a distinct verdict, not a flavor of FAIL.** The IV Rank tile
  reads `UNKNOWN (n/20 days)` in red rather than a day count that looks like
  progress, and the override step states plainly that there is no IV Rank to be
  above or below the threshold. `calculateIVRank`'s placeholder `0` must never
  surface as "0.0%".
- **The journal stamp records filter reasons AND gate reasons**, filters first.
  `OverrideSchema.violations` cap raised 10 → 16 so a card that is both a FAIL and
  at the position cap cannot blow the array and refuse a legitimate override.
- Ride-along: the **15.0%/14.9% display bug**. `condor-builder` formatted the
  credit/width ratio with `toFixed(1)` while comparing exactly, so a 14.96% ratio
  read "Credit/width ratio 15.0% is below the 15% minimum". Now 2dp, and
  `creditToWidthRatio` returns at 4dp so the card cannot round across the threshold
  either.

**Validated live the same evening.** April placed an override order on a FAIL card
at a deliberately unfillable credit — **order 1007409658646**, accepted by Schwab
(`PENDING_ACTIVATION`, after hours) — then cancelled it from the panel. This proves
the override UI, the typed-reason gate, `placeCondorOrderAction` carrying the
override payload, and `cancelCondorOrderAction`. It also retroactively confirms the
`cd19fed` deploy went green, since the button could not have existed before it.

**NOT proven:** the journal stamp. `composeFillNotes` runs only inside
`recordFillAction`, which fires on a FILL — an unfillable test order never reaches
it. That half remains unit-tested only, and will be validated by the first genuine
entry fill (open item #12), not by another test order.

### A8. `ad2a7ac` — v2.6 IV snapshot tenor correction + `iv_basis` (MIGRATION)

The fix for A6, and it turned out to be far larger than the zero rows. The date and
magnitude diagnostics April ran on 7/31 showed the zeros were a symptom:

**The two halves of IV Rank were measuring different instruments.**
`currentIv` came from the scanner's `getOptionChain` — ATM call, delta ≈ 0.50,
28–52 DTE, index chains root-filtered. The 52-week range came from the cron taking
`callExpDateMap[0]` — the **nearest** expiration, often 0–2 DTE — first strike, no
delta selection, no root filter. Near-expiry ATM IV is numerically unstable, which
produced **both** tails: 30 zero rows *and* implausible highs (SPY low 3.99 / high
60.6; QQQ 3.95 / 141.1 — not plausible 30-day vol for index ETFs).

**Direction, corrected from A6:** the zero-lows inflate a rank, but the garbage
highs *suppress* it, and suppression dominates. Ranks were reading too **LOW** —
systematic false FAIL, not false PASS. This is the likeliest reason the scanner has
never produced an entry (open item #12).

- The cron now calls **the same `getOptionChain` the scanner uses**, so range and
  reading are the same measurement by construction. `getOptionChain` gained a
  `strikeCount` param controlling **depth only** (cron passes 10; 29 full-depth
  chains in one invocation is a lot of payload). Tenor, delta pick and root filter
  are shared by every caller — that sharing *is* the fix.
- **`iv_history.iv_basis`** keeps the eras apart; `calculateIVRank` reads only
  `IV_BASIS_CURRENT`. Legacy rows are **retained** as the forensic record, never
  ranked against. Read side also filters `atm_iv > 0`.
- **`isSnapshotWorthStoring` rejects `<= 0` on write** — the guard the v1.2 risk
  table recorded as its mitigation and which never existed. `??` does not treat `0`
  as absent, so the old `=== null` check passed every zero.
- Fixed the log line printing `atmIv * 100` on an already-percentage value — it read
  "1500.0%" for a 15% IV.
- Dropped the `v1.0, UNTOUCHED` header. **That label was part of the failure**: the
  scanner grew a careful extraction while this loop was treated as settled and never
  re-read.
- Corrected the schema comment claiming `atm_iv` is "decimal, e.g. 0.18 = 18%".

**Migration applied in Neon before deploy** (repo rule: a SELECT gaining a column).
Confirmed working — every card now reads `CALIBRATING · IV RANK: UNKNOWN (0/20
days)`, which is the success signal: the column exists and the basis filter
correctly finds zero rows.

**Consequence, accepted by April:** every symbol recalibrates from 2026-07-31,
completing **~Aug 27–28**. No backfill is possible — Schwab serves no historical IV.
XSP's original ~Aug 24–25 date moved with everyone else's, so v2.4 step 11 is gated
on the same clock. v2.5 is what makes this survivable.

### A9. Key Learnings (Addendum)

- **Read the tsx summary line, not the tail of the output.** The step-8 session recorded "416
  tests" from a run that actually said `pass 394 · fail 1`. The failing entry scrolled above the
  visible tail, and the count was taken on trust. Same failure mode as the S18 lesson about
  redirecting long CLI dumps to a file — terminal scrollback is not evidence.
- **A commit that moves a file can delete a test from the suite without deleting anything.**
  `git show --stat` rendered it honestly as `lib/{schwab => journal}/exit-ticket.test.ts`, but
  nothing failed loudly enough to notice, because the file that broke was the one that would
  have complained. Relative imports make directory moves silent.
- **A documented mitigation is not an implemented one.** The `atm_iv ≤ 0` guard was written into
  the v1.2 risk table as the answer to a High-severity hazard, restated in the v1.5.1 PRD, and
  carried on four consecutive session boards as a "doc-vs-code note" — while never existing in
  code. This repo's own rule caught it: *where a doc and the code disagree, the code wins* —
  but only once someone actually opened the code. A carried doc item is a bug report until
  proven otherwise.
- **Two of three carried doc items were wrong in the same direction as S16's.** `user_settings`
  had already been folded in; the `atm_iv` note was understated (a bug, not a doc drift). Boards
  copy forward faster than anyone re-verifies them.
- **The same defect class hid in three places for three milestones.** F25 (close, v2.2.1) was
  treated as a close-form bug. It was a *wire-shape* bug — `Number('') → 0` — and it lived
  identically in the roll form and the entry form the whole time. Hardening `LegInputSchema` at
  the base is the structural fix: new writers now inherit the rule instead of opting in.
- **"UNTOUCHED" in a comment is a warning label, not a reassurance.** The IV snapshot loop
  carried `v1.0, UNTOUCHED` from v1.0 through v2.5. The scanner meanwhile grew a careful
  28–52 DTE / delta-0.50 extraction, and nobody re-read the loop marked as settled — so the two
  sides of one formula drifted onto different instruments for nine sessions. Code labelled
  stable is code nobody audits.
- **When two code paths must agree, make them the same call, not two correct implementations.**
  The fix for the IV basis was not "reimplement the tenor selection in the cron"; it was to
  delete the cron's copy and call `getOptionChain`. The same reasoning produced
  `override-gate.ts`: the UI's "must I override?" and the journal's "what was overridden?" are
  one function, because a second correct implementation is just a slower divergence.
- **A number on screen is a number the operator can act on.** `calculateIVRank` returns
  `ivRank: 0` as a placeholder while calibrating. Rendering it would have shown "0.0%" — an
  authoritative-looking value for a measurement that does not exist. The absence of data has to
  *look* like absence: `UNKNOWN (n/20 days)`, in red.
- **Sequencing is part of the fix.** The IV rebuild was correct and ready before the override
  existed — and shipping it first would have left April unable to place anything for four weeks.
  She caught it by asking whether the override had landed yet. Ask what a change makes
  impossible, not just what it makes correct.
- **A bounded polling window is a silent data-loss path.** The placement panel auto-journals a
  fill only within ~2 minutes and only while mounted. Nothing warns that closing the tab means
  the fill lands at Schwab and never reaches the journal — where the exit sweep would then never
  see the position. Not fixed; logged as item #14.

---

## Open Items Board (post-Addendum, 2026-07-31)

1. ~~**IV Rank zero-row contamination (A6)**~~ — **CLOSED by v2.6 (`ad2a7ac`)**, and it was
   bigger than reported: the two halves of the formula measured different instruments (A8).
   **Watch the first 4:15 run on the new basis:** IV lines should read a real percentage at a
   28–52 DTE (`ok — IV: 14.5% @ 34 DTE`), any `skipped — IV was 0` lines are the new guard
   working, and **function duration is the one thing untested locally** — 29 chain fetches now
   carry date filters and 10 strikes rather than 1. If it runs long, drop `strikeCount` further
   or split the two duties.
2. **Roll-badge live confirmation — STILL OWED** (carried from S17). One market-hours load of
   a page with an open condor: expect `NONE`/`WATCH`/`ROLL`, not `NO_DELTA`.
3. **Calibration completes ~Aug 27–28** for EVERY symbol (reset 2026-07-31 by v2.6). Until then
   every card is CALIBRATING and every entry goes through the v2.5 override. Confirm with:
   `SELECT iv_basis, count(*), min(atm_iv), max(atm_iv) FROM iv_history GROUP BY iv_basis;`
   — the legacy block should stay frozen while `atm_28_52dte` grows one row per symbol per day,
   with a min/max that look like real 30-day vol rather than 3.99 and 141.
4. **v2.4 step 11 — manual ladder on the first qualifying XSP setup.** Calendar-blocked on the
   same ~Aug 27–28 clock (XSP's original ~Aug 24–25 moved with the reset), then needs IVR > 25%
   + liquidity PASS. **Sanity-check the first XSP liquidity PASS against TOS spreads before
   trusting it** (hazard #4).
5. ~~**Operator override on ALL verdicts**~~ — **CLOSED by v2.5 (`cd19fed`)**, FAIL included,
   validated live on order 1007409658646. The 15.0%/14.9% display bug went with it. Residual:
   the journal STAMP half is unit-tested only — it needs a real fill, not a test order (see #12).
6. **Fee table** — index `perContractFee` values remain estimates; corrected at the first real
   index fill.
7. **`minWingWidth` for indices** — tune against a real full-chain look at XSP once calibrated.
8. **V6 (index positions-endpoint payload)** — technically unpinned until a real XSP fill
   exists; practical risk near zero (positions parse via OCC symbol, format now live-confirmed).
9. **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.
10. **Pre-existing ESLint errors** (4) — carried deliberately. The two `set-state-in-effect`
    errors would change page-load behavior on live pages for a lint-only gain.
11. ~~**Doc-refresh queue**~~ — **CLEARED (A5).**
12. **First real ENTRY fill** — still hasn't occurred, and now carries two dependencies: it
    validates `recordFillAction` live, AND it is the only way to prove the v2.5 override's
    journal stamp (`composeFillNotes`). A deliberately unfillable test order cannot reach either.
    Note A8's finding that suppressed IV Ranks were the likely reason no setup ever passed —
    once calibration completes on the corrected basis, genuine PASS cards may finally appear.
13. **Roll-event editing** — out of scope through v2.3.2 (PRD §7.7); roll ENTRY is now hardened,
    roll REPAIR still has no path but hand-written SQL.
14. **NEW — the placement panel's auto-journal window is a data-loss path.** `MAX_POLLS = 40` ×
    `POLL_MS = 3000` ≈ 2 minutes, and only while the component is mounted. An order that fills
    later, or with the tab closed, lands at Schwab and is never journaled — so the exit sweep
    never sees the position and never places its GTC. The importer is the fallback, but it does
    not carry the override record. Unscheduled; surfaced 2026-07-31 while placing the v2.5 test
    order.

---

## Pickup checklist

```
SteelEagle post-Session 18 + Addendum (2026-07-31). State: v2.4 steps 3-9
COMPLETE — XSP golden fixture pinned (order 1007409658003), XSP TRADE-READY
pending calibration · v2.3.1 + v2.3.2 — the F25 blank-price defect class is
closed on ALL THREE journal write paths (close/roll/entry); every journal
action returns ActionResult · v2.5 — operator override on EVERY verdict
(PASS/FAIL/CALIBRATING), validated live · v2.6 — IV snapshot measured on the
same basis as the scanner, iv_basis migration APPLIED · 471 tests ·
1/2 cron slots · no pending migrations · ALL symbols recalibrating from
2026-07-31, complete ~Aug 27-28.

FIRST, ask April:
- Did the first 4:15 run on the NEW basis look right? IV lines should read
  a real percentage at 28-52 DTE ("ok — IV: 14.5% @ 34 DTE"). Watch cron
  FUNCTION DURATION — 29 chain fetches now carry date filters + 10 strikes
  instead of 1, and that was never tested locally.
- Roll badges: on a market-hours load, real verdict (NONE/WATCH/ROLL)
  rather than NO_DELTA?  (owed since S17 — the getOptionDeltas 404 fix)
- Any real ENTRY fill yet? It is now the ONLY way to validate both
  recordFillAction AND the v2.5 override journal stamp. Any index fill
  (corrects the fee table)?
- Once ~Aug 27-28 arrives: do PASS cards finally appear? A8 suggests
  suppressed IV Ranks were why they never did.

Read first:
- steeleagle-session-18-summary.md + its Addendum   (this doc; A7/A8 are
                                                     the v2.5/v2.6 record)
- lib/strategy/iv-basis.ts                          (why IV history reset)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 471 passing, 0 failing
                                          (READ THE SUMMARY LINE, not the
                                           tail — see the A1 lesson)
2. ./node_modules/.bin/tsc --noEmit    -> clean (roll-alert TS5097 noise ok;
                                          rm -rf .next FIRST)
3. rm -rf .next && npm run build       -> clean
4. find app components lib -name "* 2.*"  -> empty

Decisions locked (do NOT re-litigate):
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
- Roll-leg invariant: refuse duplicate (eventType, leg) and an unmatched
  roll_open; ALLOW an unmatched roll_close (one-sided unwind). 7/30.
- BPR 0 is REFUSED (0 means unset). Prices allow $0.00; BPR does not.
- Never widen a *Draft type to its *Input type. LegInputSchema is hardened
  at the base — do not relax it back to bare z.number().
- supabase-schema.sql keeps its historical (misnamed) filename.
- Override is available on EVERY verdict incl. FAIL (April, 7/31: "truly
  done as an exception, but I want the option available regardless").
  Warnings stay fully visible; the override proceeds PAST them.
- CALIBRATING renders IV RANK: UNKNOWN (n/20), never the placeholder 0.
- The cron and the scanner MUST share getOptionChain. If the extraction
  ever changes what is measured, MINT A NEW iv_basis value — never
  silently redefine atm_28_52dte, or range and reading drift apart again
  with nothing in the data to show it.
- Legacy iv_history rows are RETAINED, never deleted — forensic record.

Next work, in order: watch the first new-basis cron run (duration!) ->
roll-badge check (owed) -> wait out calibration (~Aug 27-28) ->
v2.4 step 11 on the first qualifying XSP setup. Unscheduled: the
auto-journal polling window (#14), roll-event editing, at-fill exit
placement.
```

**Final state (2026-07-31, end of Addendum):** v2.4 steps 3–9 complete · XSP trade-ready, gated
only by the calendar; step 11 is the sole remaining v2.4 item · **v2.3.1 + v2.3.2 — the F25
blank-price defect class is closed on all three journal write paths, and every journal server
action returns `ActionResult<T>`** · **v2.5 — every verdict is overridable (FAIL included),
validated live on order 1007409658646** · **v2.6 — the IV snapshot and the scanner now measure
the same thing; `iv_basis` migration applied and confirmed** · full v2.2 exit loop validated
end-to-end on live trades (TLT fill auto-journaled).

**The high-severity IV Rank bug found in this Addendum (A6) is FIXED (A8)** — and proved larger
than first reported: not just zero rows, but two halves of one formula measuring different
instruments, biasing toward false FAIL. **Every symbol is recalibrating from 2026-07-31,
complete ~Aug 27–28**; the v2.5 override keeps every card placeable throughout.

Still owed: roll-badge market-hours confirmation (since S17) · the first real ENTRY fill, which
alone can validate `recordFillAction` *and* the v2.5 override's journal stamp · the auto-journal
polling window (#14, new).

**471 tests · 1/2 cron slots · no pending migrations.**
