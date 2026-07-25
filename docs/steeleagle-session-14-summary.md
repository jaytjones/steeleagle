# SteelEagle — Session 14 Summary

**Date:** July 24–25, 2026
**Milestone:** v2.2 Auto-Exit — BUILT, DEPLOYED, first live sweep verified. Ladder: L1 + adopted-steady-state PASSED · L3, L4 pending.
**Branch:** main
**Test baseline:** **214 passing** (was 148; +34 exit-sweep, +21 exit-ticket, +11 close-from-fill)

---

## What Was Accomplished

### 1. Spec review → FINAL (four findings, all April-accepted)
1. **Rolled trades excluded from placement** (leg source = entry `open` events only; `currentStructure(events)` promoted to v2.3). Sweep flags rolled trades for a manual GTC.
2. **Wholesale order fetch + pre-place guard**: one unfiltered `/orders` call per sweep; never place when a working close exists on the same **underlying+expiration** (closes the ignored-roll-warning and failed-id-write duplicate-GTC holes; sweep acts on Schwab truth, not the column).
3. **Placement guard `dte ≥ 24`** (kills place-today-cancel-tomorrow churn at the boundary; 22–23 is the Monitor's WATCH band, no cron alert).
4. **Exit price rounds DOWN**: `formatOrderPrice` already truncates — $2.23/share net → $1.115 → `"1.11"`, pinned in tests. Sub-$1 formats 4dp ("0.7500"); Schwab acceptance of 4dp NET_DEBIT = open item at first real sub-$1 placement.

### 2. Golden fixture — recovered from EXISTING orders, zero placements needed
April's dump surfaced her four **manually placed** GTC condor closes (plus REPLACED ancestors). Fixture pinned to the real AAPL close (orderId 1006748128062); SPY (1006723418260) as cross-check.
- **Draft-spec guess disproved:** Schwab records `duration: "GOOD_TILL_CANCEL"`, **not** `"GTC"`. Never build from docs — again.
- Exit leg order = entry's TOS-canonical SC, LC, SP, LP with BUY/SELL_TO_CLOSE.
- **Order bodies contain raw `accountNumber`** — one paste went out unredacted (low blast radius, no credentials). Dump script's redaction comment hardened to say so explicitly.

### 3. §6a — Adoption of pre-existing manual GTCs (Session 14 addition to spec)
The four standing manual GTCs were **backfilled** into `trades.exit_order_id` (matched by symbol+current_expiration; migration SQL includes pre/post verification + duplicate check — all ran clean in Neon):
| Order id | Underlying | Exp | LP/SP/SC/LC |
|---|---|---|---|
| 1007258139199 | SPY | 2026-08-21 | 690/710/767/787 |
| 1007195162009 | TLT | 2026-08-21 | 80/82/87/89 |
| 1007074485891 | SPY | 2026-08-14 | 700/720/770/790 |
| 1007074485557 | GLD | 2026-08-21 | 345/355/400/410 |

Consequences: sweep reconciles their fills as its own from day 1; L2/L3 of the ladder = "cancel one adopted GTC → sweep clears → next sweep re-places at floor target." Two SPY condors at different expirations live-validated the guard keying on underlying**+expiration**.

### 4. Build (order §7, all steps DONE)
- **`lib/strategy/exit-sweep.ts` + test (34)** — pure planner `planExitSweep → {toReconcile,toClear,toAlert,toPlace,toFlag}`; `digestOrderForSweep`; `hasRollEvents`. Unknown order statuses fail SAFE (block placement AND flag, never clear). Terminal → clear, re-place next sweep (never clear+place same run). Id absent from fetch → flag+keep (never null on a fetch gap).
- **`lib/schwab/exit-ticket.ts` + golden tests (21)** — `buildCondorExitTicket` (GOOD_TILL_CANCEL/NET_DEBIT/IRON_CONDOR, refuses bad strikes/qty/debit≥wing), `computeExitDebit` (floor pinned), `exitInputFromOpenEvents` (§4.1a refusals: exactly 4 opens, each role once, one expiration). Reuses order-ticket's `buildOccSymbol`+`formatOrderPrice`; order-ticket untouched.
- **`lib/journal/close-from-fill.ts` + test (11)** — FILLED exit → close events; refusal semantics identical to `recordFillAction` (no fabricated prices, partials refuse, all legs *_TO_CLOSE, contracts cross-check done by caller).
- **`lib/schwab/orders.ts`** — `getWorkingAndRecentOrders(hash, 180d)`: unfiltered, **THROWS on failure** (opposite of getFilledOrders — an empty [] would permit duplicate placements); 180d because `fromEnteredTime` filters on *placement* time and GTCs stand for months. `placeOrder` widened to `PlaceableTicket = CondorOrderTicket | CondorExitTicket` (caught by tsc gate).
- **`lib/db/journal.ts`** — `exit_order_id` threaded; `closeTrade` clears it on EVERY close path + optional provenance (`schwab_fill`+order id for reconcile closes); `rollTrade` nulls it and returns `{trade, priorExitOrderId}` (§5.3); `setExitOrderId` guards on NULL and fails loudly ("CHECK THINKORSWIM"); `clearExitOrderId`.
- **Migration** `migrations/2026-07-24-v2-2-exit-order-id.sql` (+ schema file, same commit).
- **Cron** (`snapshot-iv` route): IV loop **byte-identical** (diff-verified); sweep appended, per-item try/catch; abort-before-planning kills the whole sweep on hash/orders/journal fetch failure; placement → immediate status confirm → id stored only if not immediately terminal; confirm-fetch failure → flag "CHECK THINKORSWIM", no store (guard prevents next-run duplication). Response gains `exitSweep:{reconciled,cleared,alerts,placed,flagged,errors}` = the audit record.
- **Surfacing** — Monitor: `GTC @ $X.XX` sky chip (title=order id; **price = computed mechanical target, NOT the standing order's actual price** — differs by cents on adopted GTCs; tooltip says so) · `MANUAL GTC` amber chip on rolled trades · ≤21-DTE reasons gain "cancel standing GTC [id]" via a wrapper (alertFor pure fn untouched). Positions route annotates via a second isolated pass (journal failure → no chips, monitor never drops). Roll path: `rollTradeAction → {trades, exitOrderWarning}`; journal page shows dismissible amber banner naming the pre-roll id (TradeCard contract unchanged).

### 5. Deployment + first live sweep (July 25, ~evening ET, manual trigger)
- GTC chips confirmed rendering on all four condors ("nice contrast" — sky vs amber semantic: **blue = sweep owns it, amber = on the operator**).
- Sweep payload: reconciled/cleared/placed/flagged/errors ALL EMPTY (adopted steady state = pass) **plus one CORRECT alert**: SPY 8/14 at **20 DTE** → "close SPY manually and cancel standing GTC 1007074485891". The 21-DTE path live-validated on run 1.
- **CRON_SECRET was rotated** to enable the manual trigger — the original was a Vercel **Sensitive** env var (write-only forever, no reveal exists in UI/CLI by design). New value in Vercel env + April's `.env.local`; redeploy performed. Zero coordination cost (only consumers: route auth check + Vercel scheduler).

## Key Learnings (repo-wide)
- **`duration: "GOOD_TILL_CANCEL"`** — Schwab's enum, not "GTC". Fixture rule vindicated within hours of drafting.
- **Vercel Sensitive env vars are irrecoverably write-only.** Rotation is the only path; store new secrets in `.env.local` at creation time.
- **`fromEnteredTime` filters on placement time** — any order fetch meant to see standing GTCs needs a months-long lookback (180d chosen).
- **Fetch-failure semantics are a safety property**: reads whose empty result would *permit an action* (getWorkingAndRecentOrders) must throw; reads whose empty result only *degrades enrichment* (getFilledOrders) may soften.
- **Cron `today` is UTC** — a manual run after ~8pm ET writes next-day-dated rows. The July 25 (Saturday) `iv_history` rows are after-hours artifacts: cleanup `DELETE FROM iv_history WHERE snapshot_date='2026-07-25';` (pending).
- **IV log strings double-scale** (Schwab `volatility` is already percent; log does ×100 again → "SPY 903.8%" = 9.04%). Cosmetic, log-only, pre-dates v2.2. Someday-fix.
- VS Code stale-TS-server cascade recurred post-apply; Restart TS Server resolved (Session 13 pattern, now twice-confirmed).

## Open Items Board (post-Session 14)
1. **IMMEDIATE (trade, not code): SPY 8/14 is inside 21-DTE** — close in TOS, **cancel GTC 1007074485891**, journal via Close form (`close_reason='21_dte'`). First live exercise of the stale-GTC mitigation.
2. **L3 pending** (anytime, 2 sweep cycles or 2 manual triggers): cancel one adopted GTC in TOS → sweep `cleared[]` → next sweep `placed[]` at floor target → verify in TOS. Note the re-placed price will be the mechanical floor (may differ cents from the canceled manual price).
3. **L4 pending** (waits for a real GTC fill): reconcile journals the close — the milestone's live validation of the close-journal path. Also still open: **first real ENTRY fill** (§8 #5, gates the at-fill fast-follow only).
4. Saturday `iv_history` cleanup (learning #5 above).
5. Chip-price honesty: computed target vs standing price — acceptable per April; revisit only if it misleads in practice.
6. Sub-$1 4dp NET_DEBIT acceptance — verify at first sub-$1 placement.
7. **Tech Spec/PRD staleness now spans v2.0–v2.2** (execution layer, auth layer, earnings removal, auto-exit). Queue unchanged, growing.
8. `user_settings` still not in the committed schema file. Rate-limit doc reconciliation still open, low priority.
9. **v2.3 scoped**: Monitor close flow (cancel-GTC-then-close sequenced) + `currentStructure(events)` reconstruction (lifts the rolled-trade placement exclusion). Reuses this milestone's fixture.

## Pickup checklist
```
SteelEagle post-v2.2. State: v2.2 SHIPPED + live-verified · 214 tests · 1/2 cron slots ·
exit_order_id migrated + 4 GTCs adopted · CRON_SECRET rotated (in .env.local).

FIRST, ask April:
- Was SPY 8/14 closed + GTC 1007074485891 canceled + journaled ('21_dte')? (was at 20 DTE on 7/25)
- Has L3 been run? Any GTC fills yet (L4)?
- Saturday iv_history rows deleted?

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 214 passing
2. rm -rf .next && npm run build        -> clean (local; sandbox blocked on fonts)
3. ./node_modules/.bin/tsc --noEmit     -> clean (roll-alert TS5097 noise ok)

Next milestone candidates: v2.3 (Monitor close flow + currentStructure) · Tech Spec/PRD refresh.
Manual sweep trigger:
curl -H "Authorization: Bearer $(grep '^CRON_SECRET' .env.local | cut -d= -f2-)" https://steeleagle.vercel.app/api/cron/snapshot-iv
```

**Final state:** v2.2 live in prod, first sweep clean + one correct 21-DTE alert · 214 tests · 1/2 cron slots · 4 manual GTCs adopted · L3/L4 pending.
