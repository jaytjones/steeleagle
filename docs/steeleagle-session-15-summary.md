# SteelEagle — Session 15 Summary

**Date:** July 27, 2026 (evening ET; probe ran 2026-07-28T03:50Z)
**Milestone:** No version shipped. Journal repair + v2.4 **Phase 0 COMPLETE** (probe findings pinned, 25-symbol cron deployed). v2.2.1 scoped (unbuilt). v2.2 ladder: L2 expected on the 7/28 sweep · L3/L4 still pending.
**Branch:** main
**Test baseline:** **214 passing** (unchanged — no test-bearing code touched; cron route edit is constants + a 3-line fetch-boundary shim)

---

## What Was Accomplished

### 1. SPY 8/14 close — journal error repaired (SQL one-off, verified)
April closed SPY 8/14 (trade `e741a5e6-f6bf-4d77-9472-fa57659cd4d7`) but the Close form submitted after only one leg's price was entered — three close events landed at $0.00. Repaired in one guarded transaction (every UPDATE keyed on exact event id + still-zero predicate; totals re-derived from the full event log, not hand-patched):
- Close fills applied (per share): LP 700 STC **$1.56 cr** (was already correct) · SP 720 BTC **$3.31 db** · SC 770 BTC **$0.91 db** · LC 790 STC **$0.06 cr**.
- Trade row: `total_credit_collected` 1106.00 → **1112.00**, `total_debit_paid` 395.00 → **817.00**. Net P&L **$295** before commissions (~53% of the $5.55 net entry credit).
- All four close events upgraded to `source='schwab_fill'` + `schwab_order_id='1007074485891'` — the provenance the sweep's reconcile would have written.
- `close_reason` left as `'21_dte'` (April's call; optional `'profit_target'` UPDATE was provided but not required — the GTC fill *was* the closing mechanism). Either value is harmless to `hadRecentCoreStop`.

### 2. Critical clarification: GTC 1007074485891 FILLED — no stale-GTC hazard
The 7/25 sweep alert said "close manually + cancel GTC." What actually happened: the standing GTC **filled** at $2.60 net debit (~11:00 AM ET) before any manual action. No stale order ever existed.
- **L4 opportunity consumed:** the 4:15 sweep would have reconciled + journaled this close automatically — the ladder's live validation of the close-journal path. Manual journaling beat the cron by ~5 hours; the sweep then correctly no-op'd (filled order, no open trade referencing it). **Standing instruction: on the next GTC fill, do NOT journal manually — let the 4:15 sweep reconcile, then verify. That closes L4.**

### 3. Root-cause finding → v2.2.1 scoped (spec owed, unbuilt)
The real defect is that `closeTradeAction` **accepted a 1-leg submission** (likely implicit Enter-submit in the first price field). Scope agreed:
- **Close-form hardening:** server-side — `CloseTradeSchema` refuses unless exactly 4 legs, each role once, each price an *explicitly entered* number ($0.00 legal — a worthless 5Δ long legitimately closes at zero; the requirement is explicit-not-absent). Client-side — kill implicit Enter-submit on leg-price fields; Close button disabled until all four prices populated.
- **Edit feature (closed trades only):** editable = `close` event `price`/`amount`/`occurred_at` + trade-level `close_reason`/`closed_at`/`notes`. NOT editable = `open`/`roll_open` events (live-data provenance, April's explicit rule), anything `source='schwab_fill'`, structural fields (leg/strike/expiration/contracts). Roll events deferred (editing `roll_close` on an open trade desyncs a standing GTC's 50% target).
- **Mechanism:** new pure `deriveTotals(events)` (exactly the repair's FILTER-sum, as a tested function); edit action rewrites event rows + recomputes both totals from the full log in one transaction. Shared groundwork for v2.3's `currentStructure(events)`.

### 4. New SPY 8/28 position — importer timing resolved
April opened SPY 8/28 in TOS, imported at **23:20 UTC (7:20 PM ET)** — ~3 hours *after* the 4:15 sweep. `exit_order_id` null is therefore correct, nothing declined. Tomorrow's sweep places the GTC (dte ~31, unrolled, no working close on SPY **8/28** — the guard's underlying+expiration keying again doing live work beside the SPY 8/21 standing GTC). **This will be the first sweep-PLACED order = L2.** Noted: two SPY positions = equity block 2/2 (+ 4/5 global) — further equity-pillar candidates will BLOCK, and same-ticker/different-expiration = zero diversification (permitted silently today; the v2.4 same-index WARN case).

### 5. v2.4 Phase 0 — COMPLETE (probe + cron deploy)
- **`scripts/probe-index-symbols.ts`** written (market-data GETs only, SPY control first, errors-are-data per-variant probing, V4 self-driving from harvested chain symbols). April ran it; full output pasted.
- **Findings pinned** → `steeleagle-v2-4-phase0-findings.md` (V1–V5, V8; V6/V7 wait for the build fixture). Headlines:
  - **V1:** `/chains` + `/quotes` accept ONLY `$`-prefixed index symbols; bare and `.X` → 400.
  - **V2:** SPX/NDX/RUT chains return BOTH roots mixed (SPXW+SPX etc.), discriminated by `optionRoot`. **XSP has a single root (no XSPW)** — the tradeable instrument needs zero root disambiguation.
  - **V3:** full field parity with ETF chains. Bonus discriminators: `exerciseType: "E"`, `deliverableNote: "…(Cash)"`.
  - ⚠️ **TRAP:** Schwab's **`settlementType` means AM/PM ("A"/"P"), NOT physical/cash** — SPXW shows "P" identical to SPY. `InstrumentMeta.settlement` must come from config/deliverableNote, never this field. GOOD_TILL_CANCEL-class catch, pre-code.
  - **V4:** `/quotes` accepts root-based OCC symbols (SPXW…) with deltas — roll-alert path needs no format change.
  - **V5:** index underlying quotes carry `lastPrice`/`closePrice` but **no mark/bid/ask**. Cron unaffected (reads `chain.underlyingPrice`, which populates).
  - **V8:** `/expirationchain` accepts all formats (loose); returns `optionRoots` per expiration.
  - **§2 table stale:** XSP 741 / SPX 7,413 / NDX 28,039 / **RUT 2,948** (spec said 2,200); near-ATM increments observed XSP $5 / SPX $10 / NDX $50 / RUT $5 (thin sample; tune at build).
- **Cron deployed:** `app/api/cron/snapshot-iv/route.ts` full-file replacement built by editing the fetched live file — diff-verified to exactly two changes: `DEFAULT_CRON_SYMBOLS` + XSP/SPX/NDX/RUT (25-symbol universe) and the `INDEX_API_SYMBOLS` shim ($ only at the `marketGet` boundary; `iv_history` stores canonical $-free symbols; comment marks absorption into `instruments.ts` at v2.4 build). Gates clean; deployed. **Calibration day 1 = the 7/28 run; completion ~Aug 24–25** — converging with v2.3's likely finish, as the pull-forward intended.

### 6. Housekeeping
- Saturday artifact rows deleted (`DELETE FROM iv_history WHERE snapshot_date='2026-07-25'`) — Session 14 item closed.
- tsc gate note re-confirmed: the single `roll-alert.test.ts` TS5097 is the pinned known-good state, not a failure.

## Key Learnings (repo-wide)
- **Manual journaling races the reconcile sweep.** Any close journaled by hand before 4:15 consumes the sweep's reconcile (it no-ops on a filled order with no open trade). Corollary: L4 validation *requires* leaving the next GTC fill alone until after the sweep.
- **`settlementType` is AM/PM, not physical/cash** (see §5 trap). Third consecutive milestone where the probe/fixture caught a docs-assumption before it became code.
- **`closeTradeAction` accepts partial leg submissions** — refusal postures exist on every Schwab-facing path but not on this manual write path. v2.2.1 closes it.
- **Repair SQL pattern:** guard every UPDATE on exact id + current-value predicate (double-run = no-op); derive totals from the event log inside the transaction; verify with SELECTs before COMMIT.
- Doc-vs-code drift observed in passing: deployed cron skips `atmIv === null` only — docs say "≤ 0." Pre-existing; queued for doc refresh, not changed.

## Open Items Board (post-Session 15)
1. **Tomorrow after 4:15 (one verification pass, two milestones):** (a) **L2** — sweep payload `placed[]` has SPY 8/28 + order id; working GTC visible in TOS at the floored 50% target; `GTC @ $X.XX` chip on the Monitor. (b) **Calibration day 1** — `iv_history` gains XSP/SPX/NDX/RUT rows ($-free symbols, plausible IV, `underlying_price` ≈ 741/7,413/28,039/2,948); calibration banner names all four.
2. **L3** (after L2): cancel the sweep-placed GTC in TOS → next sweep `cleared[]` → following sweep re-places at floor.
3. **L4** (next GTC fill): **hands off until after 4:15** — sweep reconciles, then verify. Also still open: first real ENTRY fill (gates the at-fill fast-follow only).
4. **v2.2.1 spec draft** (Claude owes): Close-form hardening + edit feature per §3 scope. Small, pre-v2.3, touches nothing v2.3 touches.
5. **v2.3 build:** Monitor close flow + `currentStructure(events)`. Design `deriveTotals(events)` (v2.2.1) as its sibling.
6. **v2.4 spec → rev B:** fold `steeleagle-v2-4-phase0-findings.md` (incl. the settlementType trap + §2 corrections). V6/V7 + `trade_events` root question + fee correction remain build-gated.
7. Sub-$1 4dp NET_DEBIT acceptance — unchanged, verify at first sub-$1 placement.
8. Doc-refresh queue grows: Tech Spec/PRD staleness (v2.0–v2.2), `user_settings` schema file, `atm_iv ≤ 0` doc-vs-code note, strategy doc §3 same-index line + §7 1256 sentence (at next revision).
9. Equity block at 2/2 with twin SPY positions — expected BLOCKs on equity candidates until one closes.

## Pickup checklist
```
SteelEagle post-Session 15. State: v2.2 live · 214 tests · 1/2 cron slots ·
25-symbol IV universe (indices added, calibrating since 7/28) · SPY 8/14 closed
via GTC fill + journal repaired · SPY 8/28 imported, GTC placement expected 7/28.

FIRST, ask April:
- Did the 7/28 sweep place the SPY 8/28 GTC? (placed[] + TOS + Monitor chip = L2 closed)
- Did XSP/SPX/NDX/RUT iv_history rows land ($-free symbols)? Banner shows CALIBRATING?
- Has L3 been run? Any GTC fill since (if yes: did the SWEEP journal it — L4)?

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"     -> expect 214 passing
2. ./node_modules/.bin/tsc --noEmit      -> clean (roll-alert TS5097 noise ok)
3. rm -rf .next && npm run build         -> clean

Next work, in order: v2.2.1 spec (Close-form hardening + closed-trade edit;
deriveTotals(events) pure fn) -> v2.3 (Monitor close flow + currentStructure) ->
v2.4 rev B fold-in. Calibration completes ~Aug 24-25.

Standing instruction: next GTC fill = hands off, let the sweep journal it (L4).
```

**Final state:** journal accurate · Phase 0 complete, calibration clock running · L2 queued for tomorrow's sweep · v2.2.1 scoped · 214 tests · 1/2 cron slots.
