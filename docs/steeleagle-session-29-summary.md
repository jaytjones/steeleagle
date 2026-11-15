# SteelEagle — Session 29 Summary

**Date:** November 15, 2026
**Milestone:** **v2.17.1 token-refresh race fix** · **v2.18 end-of-run reconciliation (the
self-resolving PHANTOM, fixed)** · **v2.18.1 landing-page login links** · live-verification
check and `sweep_runs` audit (Aug 20 – Nov 13)
**Branch:** main
**Test baseline:** 999 (Session 28) → 1004 (v2.17, Nov 12) → 1018 (v2.17.1) → **1032 passing** ·
`tsc --noEmit` silent · build clean · eslint clean on touched files
**Migrations:** none. (v2.17's `dismissed` disposition was already allowed by the
`2026-08-14-fill-ledger.sql` check constraint.)

---

## The shape of this session

1. v2.17 (dismiss Unjournaled Activity cards, `8302590`, Nov 12) had shipped without a summary.
   It is recorded here; CLAUDE.md now reflects it.
2. JJ hit authentication errors and a false "refresh token expired" message right after two
   good logins. Diagnosed and fixed as **v2.17.1**.
3. Read-only check of the owed live verifications and the Nov 9–13 sweeps.
4. That check showed the self-resolving PHANTOM firing on half of all sweeps. **JJ reopened it**
   and it was fixed as **v2.18**.
5. Read-only audit of `sweep_runs` Aug 20 – Oct 30 (the stretch no summary covered).
6. **v2.18.1**: the landing page's login buttons. The proposed 403 change was **dropped** (§6).
7. Automatic split-roll pairing reviewed against the ledger and **declined by JJ** (§7).
8. Entry-leg editing reviewed against the journal and **declined by JJ** (§8).

---

## 1. v2.17.1 — the token-refresh race (`a5eafbd`)

### Symptom
After two good interactive logins, the landing page said "Refresh token expired —
re-authentication required" and the dashboard showed auth errors.

### Evidence (token row, read-only)
- Token stored **12:22:09 PM CT**, a fresh 30-minute access token.
- Re-auth deadline **12:22:08 PM CT**, one second earlier.
- A read-only `accountNumbers` call with the stored token returned **200**. The grant was live.

Only `expireRefreshWindow` (`LEAST(deadline, now)`, run on a token-endpoint 4xx) can write a
deadline of "now".

### Cause
The dashboard fires `/api/scanner` and `/api/positions` together, and the scanner fans out one
Schwab call per symbol. Once the access token had lapsed, each call refreshed with the **same**
refresh token. Schwab honoured one and 4xx'd the rest. Each 4xx burned the deadline, and the
winner's refresh-path store (`COALESCE`) kept the burned value. **The losing 4xx landed before
the winner's write**, so one immediate re-read would not have caught it.

### Fix — `lib/schwab/token-refresh.ts` (pure, injected I/O)
- **Single-flight per process:** concurrent callers share one refresh. A failure is not cached.
- **A 4xx is a lapse only once a lost race is ruled out:** re-read the row now and again after
  `LOSER_GRACE_MS` (2 s). If a newer token is on file (rotated refresh token, or a fresh access
  token), use it and burn nothing.
- **Unchanged:** a genuine 4xx still records the lapse at once; a 5xx never does; the stored
  deadline still never gates a live call.
- 14 tests.

### Verified live
JJ logged in at 12:37 PM CT (deadline → **Sun Nov 22, 12:37 PM CT**). At 1:09 PM CT, after the
access token lapsed, a dashboard load refreshed the token (`updated_at` 1:09:44) and **the
deadline did not move**: the exact condition that caused the race, now handled.

**Residual:** if two instances both 4xx and the winner takes more than ~2 s to store, a false
"expired" is still possible. Much rarer, and it fails in the safe direction.

---

## 2. Live verifications — mostly discharged by real nights

| Owed item | Status | Evidence |
|---|---|---|
| First auto-entry | ✅ | Nov 11 SPY 12-24 (`a23f661e`, order `1008633815721`); Nov 12 QQQ 12-24 (`9503c389`, `1008650628141`) |
| First auto-roll | ✅ | Nov 11 SPY 12-18 (`2148a833`, `1008633815423`), puts 650/680 → 710/740; provenance note on each event |
| Hold → confirm → placement | ✅ ×2 | Both Nov 11 writes confirmed by JJ, GTCs placed Nov 12 (`1008658764690` at 3.09, `1008658764694` at 4.93). `2148a833`'s old GTC (`1008593573266`) was cancelled before the roll and cleared Nov 11 |
| Non-trivial BALANCED night | ✅ | Nov 11 balanced with a cancelled GTC, an auto-roll and an auto-entry; Nov 5, 6, 10, 12 balanced with real fills |
| Auto-journal closes | ✅ | Nov 5 IWM (`1008509613966`), Nov 6 SPY (`1008588977780`) |
| First roll-price edit | ❓ | not visible in sweep data |
| `createTrade` duplicate guard | ❓ | no duplicates exist, which does not prove it ever fired |
| v2.4 step 11 (XSP ladder), L3-in-app, L3 ladder | ❌ | still owed |

**Watch Mon Nov 16:** the QQQ 12-24 hold is cleared and the trade has no `exit_order_id`, so that
sweep should place its GTC.

---

## 3. v2.18 — reconciliation flags from the END of the run (`a8af644`)

### Why it was reopened
Reconciliation flagged from the journal as read in step 0, before the sweep's own writes. Every
reconciliation critical since Aug 20 (**11 of 11**) was the sweep flagging a trade it then closed
or rolled itself, later in the same run:
- Aug 24, Oct 13 (×2), Oct 14, Oct 19, Nov 5, Nov 6, Nov 10, Nov 11 (×2): PHANTOM
- Nov 11: DRIFT (the auto-roll)

Nov 5–11 alone: **5 of 10 sweeps CRITICAL**, all false.

Session 25 parked both fixes as crossing an isolation boundary. Of the two, **letting
reconciliation read fill data stays rejected**. **Re-reading trades after step (d) is safe**:
it runs after every placement decision, the same side of the boundary `runAutoJournal`'s own
re-read sits on (Session 26), and placement still never reads reconciliation.

### As built
- **Step 0** still reconciles, records the result as `reconciliation.atPlacement`, and flags nothing.
- **New step (e)**, after (d) on both the normal and paused paths: re-read open trades, reconcile
  against the **same step-0 positions** (the run is after the close; the account cannot move mid-run;
  a second fetch would only add a way to fail), and flag from that.
- A step-0 critical one of the run's own writes explains (exit fill, auto-close / roll / entry) →
  **NOTE**: "Reconciliation DRIFT on SPY 2026-12-18 resolved in this run by the auto-journaled roll
  (order …)".
- Gone with no write to explain it → **routine** flag ("was the journal edited during the sweep?").
  This was JJ's to decide; the default stood.
- Still wrong at the end → **critical**, exactly as before, including when a write failed.
- Step (e) fails → the step-0 criticals are flagged as before, plus a routine line that they may
  already be resolved.
- Pure logic in `lib/journal/reconcile-in-run.ts` (`resolvedInRun`, `runWritesOf`). New report
  fields (`basis`, `atPlacement`, `resolvedInRun`, `endOfRunError`) are optional; stored pre-v2.18
  reports summarise unchanged (pinned).

### Replay (stored reports; the next night's step 0 stands in for the end-of-run journal)
Nov 5, 6, 10 and 11: CRITICAL → warning plus NOTEs, each attributed to the right order. Oct 30
stays critical in reality: its SPY 11-27 drift was a real unjournaled roll with no write in that
run. The proxy mislabels it only because the journal was fixed between sweeps.

**First live run: Mon Nov 16**, due 3:15 PM CT, recently landing ~4:04 PM CT.

---

## 4. `sweep_runs` audit, Aug 20 – Oct 30

- **51 runs, no weekday missed.** Landed 5:13 PM CT throughout (≈58 min drift on the 4:15 PM CDT
  due time). Since DST ended Nov 1: 4:04 PM CST (≈49 min).
- Ingestion was **BALANCED on every run that reached it**; the auto-journal gate was always OPEN.
- Placements: 2 each on Sep 21, Oct 2, Oct 22.
- **14 of 51 runs aborted before planning on an expired grant:**
  - Aug 31 – Sep 9: 8 in a row, `400 unsupported_token_type`
  - Sep 17: 1, same error
  - Oct 6 – Oct 12: 5 in a row, `400`, then `403 Access Denied` (HTML, Schwab's edge) on Oct 12

  No reconcile, placement or journaling on those nights. Standing GTCs were safe (the cron never
  cancels), but nothing new was placed Sep 10 – Sep 21. The 48-hour warning (v2.13) existed for
  both long outages: **detection is fine, delivery is not**. An alert by email or push from the
  sweep is queued and **deferred by JJ**.
- Aug 25: two GTCs on GLD rejected immediately after placement, consistent with the recorded
  Aug 3–13 GLD journal drift. Not recurring.
- Every reconciliation critical was the self-resolving artifact (§3).

---

## 5. v2.18.1 — landing-page login links

`app/page.tsx`'s "Re-authenticate with Schwab" and "Connect Schwab Account" buttons used
`next/link`. `ReauthBanner` documents why `/api/auth/login` must be a plain `<a>`: the route 302s
to Schwab's external domain, which client-side routing may not follow cleanly. Both are now `<a>`;
"Open Dashboard" stays `Link` (an in-app page). The dashboard header already used `<a>`.

---

## 6. Decision — 4xx handling stays as is (403 change dropped)

Proposed after the audit: count only OAuth-style 400/401 as a lapse, so an edge `403` would not
burn the deadline. **Dropped on closer reading:** the only 403 on record arrived **during a real
lapse**, so a 403 may be how Schwab's edge answers a dead token. Exempting it could render the
banner "ok" while every Schwab call fails, which breaks "cannot tell is never rendered healthy".
What it would prevent is a false "expired" that costs one unnecessary login. The asymmetry
favours the current rule.

---

## 7. Decision — automatic split-roll pairing declined (JJ)

Reviewed before any code. The ledger (`schwab_fills`, all time) holds **27 single-ticket rolls
and one split roll**: SPY 09-11 on Aug 14, `1007598808689` (close) + `1007598809002` (open),
4m28s apart. There has been none in the three months since, so nothing has changed since the
Oct 31 deferral. The v2.16 prefill already pairs the halves into one Roll form, so automation
would save one confirm click about twice a year. The cost would be a new planner branch, a
change to the transactional `rollTrade` (it stamps ONE `schwab_order_id` on every event; a split
roll has two), and a two-order live re-derivation in the route.

**JJ: skip; keep the prefill.** Recorded in case it is ever reopened:
- **Close-then-open only.** Open-then-close stays a prefilled inbox card.
- **The hold names the OPEN half's order id** (the spread the next GTC will close).
- Also seen on Aug 14: a second, unfilled `PARTIAL_OPEN` (`1007598808787`, 0 contracts). The
  pairing's FILLED-only rule already excludes it, so the uniqueness rule holds on live data.

---

## 8. Decision — entry-leg editing declined (JJ)

Reviewed before any code, against all 27 journaled trades (read-only):
- **26 of 27 entries are `source = schwab_fill`** (auto-entry or Import). The 27th is closed
  GLD `9b3f575a` (Aug 7), half of the same-strike pair.
- **All 26 match Schwab's execution prices exactly: 0 mismatches.** Entries are no longer
  hand-typed, so a price edit has nothing to repair.
- Correction of an earlier claim: trade `7dc07054`'s known error is on a ROLL (order
  `1007483420023`), which v2.16's roll-price edit already covers (JJ: leave it).
- The actual gap is that **every entry's delta is null** (fills carry none). Delta is
  display-only (`TradeCard`); nothing computes from it. Cosmetic, not queued.

**JJ: decline.** If ever reopened: price-only on `open` legs, mirroring `planRollEdit`; refuse
under a standing GTC; re-derive totals and `initial_bpr` (`entryBpr`, which depends on the entry
credit) in the same transaction; v2.12 provenance (demote to `manual`, keep the order id).

---

## 9. Owed / queued

- **Mon Nov 16 sweep:** first live v2.18 run (expect NOTEs, not criticals, on any trade the run
  closes or rolls) and the QQQ 12-24 GTC placement.
- **Next re-login:** by **Sun Nov 22, 12:37 PM CT**; the banner turns "soon" about Fri Nov 20,
  12:37 PM CT. That covers every weekday sweep through Fri Nov 20.
- **Still owed:** first roll-price edit · `createTrade` duplicate guard · XSP ladder (v2.4 step 11)
  · L3-in-app · L3 ladder.
- **Deferred (JJ):** re-login alert by email or push from the sweep.
- **Queued:** at-fill exit placement · diagonal exits.
- **Declined (JJ):** automatic split-roll pairing (§7) · entry-leg editing (§8).
- The PRD and tech spec are still v2.16; refresh them at the next milestone, or around Session 33.

---

## 10. Next session — start here

**Session ended by JJ to wait for the Mon Nov 16 sweep** (due 3:15 PM CT; recently landing
~4:04 PM CT). Before building anything, read that run's `sweep_runs` row (read-only) and check:

1. `report.reconciliation.basis === 'end-of-run'`, with `atPlacement` and `resolvedInRun` present:
   v2.18 ran live.
2. Any trade the run closed or rolled shows up as a NOTE ("resolved in this run by …"), not as a
   `RECONCILIATION` critical.
3. No `RECONCILIATION END-OF-RUN RE-CHECK FAILED` line.
4. QQQ 12-24 (`9503c389`) got its GTC (`placed[]`, and `trades.exit_order_id` set).
5. No `sweep aborted before planning`. Auth is good through Sun Nov 22, 12:37 PM CT.

**Then: the at-fill exit placement spec** (analysis and questions for JJ, no code). It must
settle:
- **The trigger.** No Schwab webhook, and the spare Hobby cron slot is held open on purpose.
  Most likely JJ's own action (e.g. Confirm & arm GTC), not polling.
- **The GTC hold.** Today an auto-entry reaches placement only through JJ's confirm. Keep that
  confirm step, or remove it?
- **One placement path.** The same pre-place guard (`held − covered ≥ contracts`),
  `isPriceableStructure`, `orderFixturePinned` and the throwing `getWorkingAndRecentOrders`.
  Never a second copy of the rules.
- **Duplicates.** The sweep and an at-fill placement must never both place a GTC for one trade.
- **Live fixture first:** confirm the exit ticket against a real order before reusing it.
