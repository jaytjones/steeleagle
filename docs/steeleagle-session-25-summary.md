# SteelEagle — Session 25 Summary

**Date:** August 20, 2026
**Milestone:** **v2.13.1 — the accounting identity could never have balanced.** FIXED.
**Branch:** main
**Test baseline:** 821 → **828 passing** · `tsc --noEmit` silent · build clean
**Migrations:** none. Nothing in this session changed a table.

---

## The shape of this session

Session 24 owed one thing above all others: *observe the first live cron run of v2.11 +
v2.12*. This session opened by checking whether it had happened.

**It had.** Two runs, Aug 18 and Aug 19. And the observation immediately earned its keep —
the run that was supposed to confirm the identity works instead proved it **could never have
worked at all.**

`sweep_runs`, read newest-last:

| run (CT) | what happened |
|---|---|
| Mon Aug 17, 4:16 PM | `sweep aborted before planning` — the auth death Session 24 documented |
| **Tue Aug 18, 4:34 PM** | **first real v2.11 + v2.12 cron run.** reconciliation `match 4`, `uncomparable 0`. Balance `UNRELIABLE` |
| **Wed Aug 19, 4:34 PM** | second run. GTC filled and self-journaled. Balance `UNRELIABLE` again |

So: **v2.12 is proven in a real cron. v2.11's completeness proof was structurally
unobtainable, and this session is why we know.**

### What the runs confirmed, before the defect

- **v2.13's own proof PASSES.** The stored deadline still reads **Tue, Aug 25, 10:10 AM CT**
  despite a token refresh at 7:02 AM on Aug 20. Session 24 set the test explicitly: *if it has
  moved to the evening of Aug 25, the fix is wrong.* It has not moved. The refresh path no
  longer extends the window it was meant to warn about.
- **v2.12 proven live in a real cron.** Aug 18 reconciliation: `match 4 · drift 0 · phantom 0 ·
  uncomparable 0 · unimported 0` — exactly the Session 24 expectation, on the first try.
- **L4 DISCHARGED, and it discharged itself.** Exit GTC **1007557518040** (SPY 2026-09-18,
  placed by the sweep on Aug 11 @ 2.58) **FILLED Wed Aug 19 at 2:21 PM CT**. The sweep's fill
  reconciliation journaled the close hands-off; trade `e368b294` carries `closed_at` at that
  exact instant. This is the verification that has been owed since v2.2 — the 50% profit
  target hit, and the app recorded it without JJ touching anything.

---

## 1. v2.13.1 — a refusal that meant "out of scope" disarmed the proof it protected

Both real runs returned:

```
balance: UNRELIABLE
refusals: [
  "order 987274880005: execution leg 1 has no matching order leg — contracts moved but the direction is unknown",
  ... x5
]
```

None of those five ids are in `schwab_fills`, and `GET /orders/987274880005` returns **404 Order
not found**. Fetched live from the order list, they are all the same thing:

```
987274880005  FILLED  MARKET  qty 250       MUTUAL_FUND  SWVXX  BUY   2026-08-02
485212765600  FILLED  MARKET  qty 250       MUTUAL_FUND  SWVXX  BUY   2026-07-24
989076314600  FILLED  MARKET  qty 2500      MUTUAL_FUND  SWVXX  BUY   2026-05-28
237054723600  FILLED  MARKET  qty 1641      MUTUAL_FUND  SWVXX  SELL  2026-04-25
191708603600  FILLED  MARKET  qty 4167.68   MUTUAL_FUND  SWVXX  BUY   2026-04-18
```

**SWVXX is Schwab's money-market sweep fund.** Cash management, not trading. Note the shape:
`assetType: MUTUAL_FUND`, a **bare `BUY`** instruction with no `_TO_OPEN` / `_TO_CLOSE` half,
a **fractional** quantity that is not a contract count at all, and an execution timestamped
nearly three days after `enteredTime` — funds settle on the fund's schedule, not the option
market's.

### The mechanism

`orderEffect` built its `legId → leg` map from OPTION legs **only**, and then iterated **every**
execution leg. A non-option execution therefore matched nothing in the map and fell straight
through to the refusal branch — the branch that means *contracts moved but the direction is
unknown*. Any refusal makes the whole interval `UNRELIABLE`.

The cron carried a comment asserting the opposite, and it is worth quoting because it is the
cleanest statement of the wrong model:

> *"Their effects are already nil — `orderEffect` counts OPTION legs only — so the identity is
> unaffected."*

The **effects** were nil. The **refusals** were not. Half of that sentence was true and the
half that mattered was false.

### Why this was permanent, not transient

Schwab's sweep fund trades **continuously** — five orders across four months, and there will
always be more. The window is 180 days. So on any given night at least one SWVXX order stands
inside it, and:

**The accounting identity could not have returned `BALANCED` on any interval, ever.**

That matters far beyond a red banner. **v2.11 step 8 (gated auto-write) is bounded by a ZERO
RESIDUAL** — that is the whole design, chosen precisely because a completeness proof is
categorically stronger than a classifier's confidence. The gate could never open. Step 8 was
blocked on an observation that was itself blocked, and neither end of that could be seen from
inside the code.

### The fix — scope is not the same thing as ignorance

`positionsToQty` already skips every non-OPTION position on the **left** side of the identity.
So this is an **option-leg identity on both sides**, and the right side must apply the same
filter. A MUTUAL_FUND execution is not an unknown quantity; it is **out of scope**, exactly as
the mutual fund holding it produces is out of scope in the snapshot. Its contribution is a
**known zero**.

`orderEffect` now records **every** leg in the map, tagged with its scope:

| execution leg matches… | outcome | reasoning |
|---|---|---|
| an OPTION leg | signed and summed | unchanged |
| a **non-OPTION** leg | contributes zero, **no refusal** | present and out of scope — a known zero |
| **nothing at all** | **still a refusal** | absent, therefore genuinely unknown |

The out-of-scope check runs **before** the window check, deliberately: an out-of-scope execution
contributes nothing whether it lands in the interval or not, and a mutual fund settling days
late straddles intervals constantly.

**The governing rule, now stated in the module:** *a refusal means IN SCOPE BUT UNKNOWN, and it
must never mean out of scope.* Widening what counts as a refusal is not a safe default — it
disarms the proof it was meant to protect. That is the inverse of the usual posture here and
worth holding onto: refuse-don't-guess protects **writes**; over-refusing destroys **proofs**.

Per the Schwab doctrine the real payload is pinned as **`SWVXX_CASH_SWEEP`** in
`golden-fills.fixture.ts` — including `price: 1`, the money-market NAV — with seven tests, one
of which asserts that an **absent** leg still refuses, so the fix cannot later be widened into
a licence to drop genuinely unknown legs.

### Verified live before shipping

The identity was replayed over the stored snapshots with the fixed code, read-only:

```
Fri Aug 14 10:22 PM -> Tue Aug 18 4:34 PM   BALANCED   residual (EMPTY)
Tue Aug 18  4:34 PM -> Wed Aug 19 4:34 PM   BALANCED   residual (EMPTY)
    delta    SPY 260918 C800 +1, C825 -1, P710 -1, P735 +1   (the condor vanished)
    effects  the same four legs, from order 1007557518040
Wed Aug 19  4:34 PM -> live now              BALANCED   residual (EMPTY)
```

The middle interval is the one that counts. The SPY 09-18 condor left the account, and the
residual is **exactly zero** because the sweep's own filled GTC explains all four legs. **That
is the first genuine completeness proof this system has ever produced**, and it is the gate
step 8 is waiting on.

---

## 2. Corrections to the record

**C1 — the ~57 min Vercel drift figure is not a constant.** CLAUDE.md records drift as
"stabilised at ~57 min: Aug 11, 12 and 13 all within 2 seconds of 22:12 UTC ≈ 5:12 PM CT".
Aug 18 and Aug 19 both landed at **21:34 UTC ≈ 4:34 PM CT**, again within seconds of each
other — about **19 minutes**. So drift is stable *within* a stretch and re-baselines *between*
stretches. Quote the DUE time (21:15 UTC) when scheduling; when telling JJ when to look, quote
the most recent observed run rather than a remembered constant. `sweepFreshness`'s
2-missed-run tolerance is unaffected by this and needs no change.

**C2 — the cron's NOT_OPTION filter never protected the identity.** It filters the **inbox**
(`upsertFills`). `sumEffects` reads the **unfiltered** `rawOrders`, by design — the identity
must see every order. Reading the filter as coverage for the identity is what let the false
premise sit in a comment for six days. The comment now says which of the two it guards.

**C3 — a `sweep_runs` row reporting `ingestion.ran: true` is not proof the ingestion worked.**
Session 24's C1 warned that a row is not proof the cron fired, and the tell was reading the
report's contents. The same trap has a second floor: both real runs reported `ran: true` with
a populated balance block, and the balance was structurally incapable of passing. **Read the
STATUS, not just the ran flag.**

---

## 3. Decisions locked this session

| # | Decision |
|---|---|
| D1 | **The accounting identity is an OPTION-leg identity on BOTH sides.** `positionsToQty` skips non-OPTION positions; `orderEffect` skips non-OPTION legs. The two scope filters must always agree. |
| D2 | **A refusal means IN SCOPE BUT UNKNOWN.** It must never mean out of scope. Over-refusing is not a safe default — it disarms the completeness proof. |
| D3 | **An ABSENT leg is still a refusal.** The out-of-scope path is keyed on a leg that is *present and non-option*, never on a lookup miss. |
| D4 | **v2.11 step 8 stays BLOCKED until one real cron run reports `BALANCED` on its own.** The gate has never once opened in production; a local replay is evidence, not the event. |

---

## 4. Owed / queued

- **OWED — one real cron run reporting `balance: BALANCED`.** Expected Thu Aug 20 or Fri Aug 21,
  ~4:34 PM CT on current drift. Nothing has traded since Aug 19, so the residual should be
  empty and the ingestion critical should disappear. **Silence is correct** — a zero residual is
  a proof, not an absence of complaints.
- **v2.11 step 8 — gated auto-write. STILL BLOCKED**, now on the above rather than on the
  observation. One clean run away.
- **OPEN QUESTION for JJ — the self-resolving PHANTOM.** The Aug 19 run flagged
  `RECONCILIATION PHANTOM — SPY 2026-09-18` as **critical**, for the trade **that same run was
  about to close**. `openTrades` is read once in step 0; reconciliation reads it; the sweep's
  fill reconciliation journals the close later in the same run. So a night where the machinery
  worked perfectly end-to-end turned the banner red. That is the "a critical that fires when
  the system works correctly becomes wallpaper" failure mode v2.9 legislated against.
  **Deliberately NOT fixed this session** — both available directions (re-read trades after
  reconcile, or let reconciliation see fill data) cross an isolation boundary that was drawn on
  purpose, and that is JJ's call, not a judgement to make mid-fix.
- **v2.4 step 11** — manual XSP ladder. IV calibration completes ~Aug 24–25.
- L3-in-app (Cancel GTC) · L3 ladder.
- `trades` key sites (b) and (c) — open by decision.
- **L4 is CLOSED** (this session, Aug 19 — order 1007557518040).

### What to expect at the next sweep (~4:34 PM CT)

| | |
|---|---|
| auth | fine — deadline Tue Aug 25, 10:10 AM CT |
| balance | **`BALANCED`, residual empty.** This is the run that matters |
| ingestion flags | the UNRELIABLE critical should be GONE. A routine "N fills need journaling" is expected and correct |
| inbox | the Aug 14 activity ages past the 7-day window ~Aug 21 |
| reconciliation | `match 3` — one fewer trade since SPY 09-18 closed |
| guard | still not exercised; it needs a GTC to clear and re-place while another stands |
