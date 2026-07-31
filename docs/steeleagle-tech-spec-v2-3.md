# SteelEagle — Technical Specification
**Version:** Tech Spec v2.3 (paired with PRD v2.3)
**Status:** Consolidated refresh — reverse-engineered from the deployed build + session summaries 11–16
**Last Updated:** July 28, 2026 (Session 16)
**Supersedes:** Tech Spec v1.5.1 (June 15, 2026)
**Companion PRD:** `steeleagle-prd-v2-3.md`

> **Scope of this refresh.** Brings the v1.5.1 spec current across six milestones: v2.0
> (placement), v2.1 (panel editing + override), **v2.1.1 (earnings sleeve deleted)**, v2.2
> (auto-exit sweep), v2.2.1 (close hardening + closed-trade edit), v2.3 (Cancel GTC +
> `currentStructure`). Session summaries remain the authority on *why*; this documents *what
> exists now*. **Test baseline: 471 passing** (was 278 at the v2.3 refresh; see Phases 17–20).

---

## 1. Tech Stack

| Layer | Choice | Notes |
| :--- | :--- | :--- |
| **Framework** | Next.js 16 (App Router, Turbopack) | Server Components + Route Handlers + Server Actions. |
| **Language** | TypeScript (strict) | Pure modules unit-tested with `node:test` via `tsx`. **`tsx --test` does NOT type-check — `tsc --noEmit` is the gate.** |
| **Styling** | Tailwind CSS v4 | Dark terminal aesthetic; IBM Plex Mono + Barlow Condensed. **Class names must appear as literal strings** — a name assembled from interpolated fragments is never generated. |
| **State** | React `useState` + Server Actions | Single-user; no global store. |
| **Database** | Neon Postgres via `@vercel/postgres` | `sql` tagged template for one-shot queries; `db.connect()` (pooled client) for transactions. **Tagged templates take scalars only — arrays need `sql.query(text, [arr])`.** |
| **Validation** | **zod v4** | At every action boundary. Note v4's unified `error` param: `z.number({ error: '…' })` covers null/undefined/NaN. |
| **Auth** | Schwab OAuth 2.0 + **app session cookie** | v2.0 added a signed `se_session` cookie (30-day TTL) enforced by middleware. |
| **Hosting / Cron** | Vercel (Hobby) | **1 of 2 cron slots used**; the free slot is deliberately held open. |
| **External data** | Schwab Trader API | **Finnhub removed** with the earnings sleeve (v2.1.1). |

### The Schwab doctrine — never build from docs alone
Schwab's documentation is unreliable. Every Schwab interaction path is built **from a live fixture
first, code second**: place-and-cancel a real order, dump it, pin the payload as a golden fixture,
then write the builder against the fixture. Traps caught this way:

| Trap | Reality |
| :--- | :--- |
| `duration` | `"GOOD_TILL_CANCEL"`, **not** `"GTC"` |
| `volatility` | already a percentage |
| `fromEnteredTime` | needs a **180-day** lookback to see standing GTCs |
| `settlementType` | means **AM/PM** ("A"/"P"), **NOT** physical/cash — must never source `settlement` |
| positions | flat legs with no reliable strike/expiration — **parse the OCC symbol** |
| index symbols | `/chains` and `/quotes` accept **only** the `$`-prefixed form |

### External APIs
| API | Auth | Usage | Gotchas |
| :--- | :--- | :--- | :--- |
| **Schwab — Market Data** | OAuth Bearer | `/chains`, `/quotes`, `/expirationchain` | Unthrottled GET; IV=0 after hours; `$` prefix required for indices (`iv_history` stores the canonical `$`-free symbol — `$` exists only at the fetch boundary). |
| **Schwab — Accounts/Trading** | OAuth Bearer | `/accounts/{hash}` (positions+balances), `/accounts/{hash}/orders` (GET/POST/DELETE) | **Order endpoints 10/min/account.** The sweep makes ONE wholesale orders fetch per run. Schwab performs no server-side ticket review — the builder is the last guardrail. |

### Top Stack Risks
| Risk | Likelihood | Mitigation |
| :--- | :--- | :--- |
| Refresh token expires every 7 days | Certain (by design) | 401-on-refresh → ReauthBanner; `/api/auth/status` exposes expiry. |
| **Duplicate GTC placement** | Catastrophic if it happens | `getWorkingAndRecentOrders` **throws** rather than degrading to `[]`; pre-place guard on underlying+expiration; `exit_order_id IS NULL` guard; clear-and-place never happen for the same trade in one run. |
| Schwab IV=0 after hours corrupts `iv_history` | High | Cron skips writes on null ATM IV. |
| Position shape ≠ documented | High | `parseOccSymbol` everywhere. |
| Thrown server-action messages redacted in prod | Certain | Actions **return `ActionResult<T>`**; never throw from an exported action on an operator-critical path. |
| Both cron slots consumed | At limit if used | v2.2 folded the sweep into the existing cron rather than taking the free slot. |

---

## 2. Data Models

### Entity Map
```
   ┌──────────┐   ┌──────────┐   ┌───────────────┐   ┌──────────────────────────────┐
   │ tokens   │   │ accounts │   │ iv_history    │   │ user_settings                │
   │ (id=1)   │   │ (id=1)   │   │ (symbol,date) │   │ (id=1, tickers[], pause_…)   │
   └──────────┘   └──────────┘   └───────────────┘   └──────────────────────────────┘
                        ┌───────────────────────────────────────┐
                        │ trades  1───∞  trade_events           │
                        │ (logical condor)   (leg-level log)    │
                        └───────────────────────────────────────┘
```
**Six tables** (was seven — `earnings_calendar` **dropped** in v2.1.1). Singletons: `tokens`,
`accounts`, `user_settings`. Time-series/append: `iv_history`, `trade_events`. Lifecycle row:
`trades`. `trade_events.trade_id → trades.id` is the only FK (cascade delete).

> **Schema-file caveat (RESOLVED 2026-07-31):** `supabase-schema.sql` remains misnamed — the DB is
> Neon — and that is now deliberate: no code references the filename, but ~10 session summaries
> do, by name, as the decision log. The claim that `user_settings` (including
> `pause_exit_placement`) is **not** in the committed file was **wrong** — it is there, at lines
> 56–73, and had been for four sessions while the boards carried it as open. Verified, not
> assumed.

### Schema changes since v1.5.1
```sql
-- v2.1.1 — earnings sleeve removal
DROP TABLE earnings_calendar;
-- trades.sleeve CHECK narrowed to ('core')   [zero historical earnings rows existed]

-- v2.2 — standing-exit association       migrations/2026-07-24-v2-2-exit-order-id.sql
ALTER TABLE trades ADD COLUMN exit_order_id text;   -- null = no standing exit on record
--   Bookkeeping, NOT truth: the sweep verifies against fetched order state every run.
--   Cleared on close by every path. Nulling it cancels nothing at Schwab.

-- v2.2 — placement pause                 migrations/2026-07-28-pause-exit-placement.sql
ALTER TABLE user_settings ADD COLUMN pause_exit_placement boolean NOT NULL DEFAULT false;

-- v2.6 — IV measurement basis            migrations/2026-07-31-iv-basis.sql
ALTER TABLE iv_history ADD COLUMN iv_basis text NOT NULL DEFAULT 'legacy_front_expiry';
CREATE INDEX iv_history_symbol_basis_date ON iv_history (symbol, iv_basis, snapshot_date DESC);
--   'legacy_front_expiry' — nearest expiration, first strike, no delta pick, no root filter.
--                           RETAINED as the forensic record; NEVER ranked against.
--   'atm_28_52dte'        — ATM call (delta ~0.50) 28–52 DTE, root-filtered. Identical by
--                           construction to the scanner's currentIv (both call getOptionChain).
--   Applied in Neon 2026-07-31 BEFORE deploy — calculateIVRank's SELECT gains the column.
```
**v2.2.1, v2.3, v2.3.1, v2.3.2 and v2.5 required no migration.**

### Key TypeScript Types (current)
```typescript
// ── journal (lib/journal/types.ts) ─────────────────────────────
interface Trade { id; symbol; sleeve: 'core'; status: 'open'|'closed';
  openedAt; closedAt; initialExpiration; currentExpiration; initialCredit;
  totalCreditCollected; totalDebitPaid; initialBpr; contracts; closeReason;
  exitOrderId: string|null;            // v2.2
  notes; createdAt; updatedAt; events: TradeEvent[] }
interface TradeEvent { id; tradeId; eventType: 'open'|'close'|'roll_close'|'roll_open';
  leg; strike; expiration; delta; contracts; price; creditDebit; amount;
  source: 'manual'|'schwab_fill'; schwabOrderId; occurredAt; notes; createdAt }

// zod write models — NewTradeSchema · RollTradeSchema · CloseTradeSchema
//                    EditClosedTradeSchema (v2.2.1)
// v2.2.1 draft types (blank price travels as null, NOT 0):
//   CloseTradeDraft / CloseDraftLeg · EditClosedTradeDraft / EditCloseDraftLeg
//   *** Never widen a *Draft type to its *Input type. ***

// ── exits (v2.2 / v2.3) ────────────────────────────────────────
interface CondorExitTicket { orderStrategyType:'SINGLE'; complexOrderStrategyType:'IRON_CONDOR';
  orderType:'NET_DEBIT'; price: string; duration:'GOOD_TILL_CANCEL'; session:'NORMAL';
  quantity: number; orderLegCollection: [leg,leg,leg,leg] }
interface CondorStructure { symbol; expiration; longPut:{strike}; shortPut:{strike};
  shortCall:{strike}; longCall:{strike} }            // currentStructure output (v2.3)
interface SweepTradeInput { id; symbol; currentExpiration; exitOrderId; priceable }  // v2.3
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }
```

---

## 3. Application Architecture: Routes & Source

### Runtime Routes
| Path | Screen |
| :--- | :--- |
| `/` | Home / redirect |
| `/login` | Session login (the only cookie-exempt page) |
| `/dashboard` | Scanner + Positions Monitor (+ placement panel, pause toggle, Cancel GTC) |
| `/journal` | Trade Journal (New Trade · Import · Record Close · Edit Close) |

### API Routes (8 — was 11; earnings routes deleted)
| Method | Path | Auth | Response |
| :--- | :--- | :--- | :--- |
| GET | `/api/auth/login` | session | 302 → Schwab CAG |
| GET | `/api/auth/callback` | session + OAuth state | 302 → `/dashboard` |
| GET | `/api/auth/status` | session | token expiry / `needsReauth` |
| GET | `/api/scanner` | session + Schwab | `{ results }` (accepts `?symbols=`) |
| GET | `/api/positions` | session + Schwab | `{ positions, balances }` + roll verdicts + `journalExit` annotation |
| GET / PATCH | `/api/settings` | session | `UserSettings` |
| GET | `/api/journal` | session | `{ trades, timestamp }` |
| GET | `/api/journal/import-candidates` | session + Schwab | `ImportCandidatesResponse` |
| GET | `/api/cron/snapshot-iv` | **`CRON_SECRET`** | `{ date, results, exitSweep }` — 21:15 UTC weekdays (4:15 PM CT now) |

### Server Actions
| File | Actions |
| :--- | :--- |
| `app/login/actions.ts` | `loginAction` |
| `app/dashboard/actions.ts` | `setTickers` · `setPauseExitPlacement` |
| `app/dashboard/order-actions.ts` | `placeCondorOrderAction` · `getOrderStatusAction` · `cancelCondorOrderAction` · **`cancelStandingExitAction`** (v2.3) · `recordFillAction` — **all return `ActionResult<T>`** |
| `app/journal/actions.ts` | `createTradeAction` · `rollTradeAction` · **`closeTradeAction`** (ActionResult, v2.2.1) · **`editClosedTradeAction`** (v2.2.1) · `importTradesAction` |

### Source File Structure (current)
```
app/
  page.tsx · layout.tsx · login/{page,actions}.ts
  dashboard/{page.tsx,actions.ts,order-actions.ts}
  journal/{page.tsx,actions.ts}
  api/auth/{login,callback,status}/route.ts
  api/{scanner,positions,settings}/route.ts
  api/journal/route.ts · api/journal/import-candidates/route.ts
  api/cron/snapshot-iv/route.ts        # IV snapshot + the whole exit sweep
lib/
  action-result.ts                     # ActionResult<T> / toResult  (v2.2.1)
  auth/session.ts                      # signed cookie, 30-day TTL
  db/{client,settings,journal}.ts      # journal.ts transactional
  schwab/{client,auth,chains,quotes,accounts,orders}.ts
  schwab/order-ticket.ts               # ENTRY ticket  (golden-fixture tested)
  schwab/exit-ticket.ts                # EXIT ticket   (golden-fixture tested)
  journal/{types,trade-math,importer,compose-fill-notes}.ts
  journal/close-from-fill.ts           # filled GTC → CloseTradeInput   (v2.2)
  journal/edit-close.ts                # closed-trade edit planner       (v2.2.1)
  journal/current-structure.ts         # event log → current 4 legs      (v2.3)
  strategy/{iv-rank,condor-builder,reconstruct-positions,bpr,position-limits,
            entry-gate,position-alerts,roll-alert,liquidity}.ts
  strategy/exit-sweep.ts               # pure sweep planner              (v2.2)
  strategy/cancel-exit.ts              # Cancel GTC planner              (v2.3)
components/
  ReauthBanner.tsx
  scanner/{ScannerCard,AddCellButton,BprChip,PendingCell,PlaceOrderPanel}.tsx
  positions/PositionsMonitor.tsx       # + GtcChip / CancelGtcButton
  journal/{NewTradeForm,TradeCard,LegRowsEditor,fields,
           ImportButton,ImportCandidateReviewPanel,ImportCandidateCard}.tsx
middleware.ts · migrations/*.sql · scripts/{dump-working-orders,probe-index-symbols}.ts
vercel.json                            # ONE cron
```

### The build pattern (enforced)
1. **Pure module in `lib/` with unit tests FIRST** — no I/O. All decisions live here.
2. Wire to route / server action — glue and per-item try/catch isolation only.
3. Wire to UI last.
4. Migrations: dated file in `migrations/`, applied in Neon **before** code deploys when a SELECT
   gains a column, folded into the canonical schema file in the same commit.

---

## 4. The Exit Sweep (v2.2 / v2.3) — the highest-risk path

### 4.0 The cron schedule — read this before quoting a time

**`vercel.json` is the only truth: `"schedule": "15 21 * * 1-5"` → 21:15 UTC, Mon–Fri.
Vercel crons are UTC-only; there is no project timezone.** The operator is in **US Central**,
and every wall-clock time in this repo's docs should be stated in **CT**.

| Period | Cron fires | Market close (CT) | Margin after close |
|---|---|---|---|
| **CDT** (Mar–Nov, *now*) | **4:15 PM CT** (5:15 PM ET) | 3:00 PM CT | **75 min** |
| **CST** (Nov–Mar) | **3:15 PM CT** (4:15 PM ET) | 3:00 PM CT | **15 min** |

**Every doc written before 2026-07-31 said "4:15 PM ET". The label was wrong, not the time** —
`4:15` was always **Central**. The schedule never changed; only the timezone suffix was
mistaken, and it survived 19 sessions because the *number* looked right for a post-close job.
Corrected repo-wide on 2026-07-31 (14 docs + 8 source files). **`vercel.json` was deliberately
NOT touched** — nothing about the actual behavior was wrong, only its description.

**The DST swing — reviewed and DECIDED, do not reopen.** Because the schedule is pinned to
UTC while the market close moves with DST, the gap between the close and the sweep changes by
an hour at each transition: 75 minutes in CDT, 15 minutes in CST. A UTC cron cannot hold a
fixed local time year-round, so the only choice available is which season to favor.

**Decision (April, 2026-07-31): leave `15 21 * * 1-5` as-is. The only requirement is that the
sweep runs after the close — the size of the margin beyond that is not a real constraint.**
Both seasons satisfy it. No change to `vercel.json`.

Consistent with what the sweep actually needs: Schwab reports a fill's terminal status at fill
time (there is no settlement lag to wait out), and the IV snapshot wants a chain that is still
readable, which argues mildly *for* the earlier winter slot rather than against it.

Runs inside `/api/cron/snapshot-iv` after the IV snapshot. One wholesale
`getWorkingAndRecentOrders` fetch (180-day `fromEnteredTime`), then `planExitSweep` — a **pure**
planner — produces `{ toReconcile, toClear, toAlert, toPlace, toFlag }`. The route executes the
plan with per-item try/catch and returns `ExitSweepReport { reconciled, cleared, alerts, placed,
flagged, wouldHavePlaced, errors }`.

**Invariants that must not be "simplified" away:**
- `getWorkingAndRecentOrders` **throws** on failure rather than returning `[]` — an empty result
  would read as "no working orders" and permit duplicate GTC placement.
- The sweep acts on **fetched order state**, never on `trades.exit_order_id` alone.
- A standing id absent from the fetched set is a **fetch gap, not a dead order**: flag and keep it.
- Terminal → clear only; the **re-place happens on the next run**, after the DB write landed.
- Pre-place guard: refuse when any working close exists on the same underlying + expiration.
- Placement requires `dte ≥ 24` (`PLACEMENT_MIN_DTE`); 21-DTE is alert-only; **the cron never
  cancels**.
- Exit price floors (`formatOrderPrice` truncates) — the profit-favorable direction, pinned by test.
- Pause affects **step (c) only**; a settings-read failure means **not paused**.

**v2.3 change.** Placement eligibility moved from `hasRollEvents` (blunt: any rolled trade
excluded) to `isPriceableStructure(events)` — can `currentStructure` reconstruct a four-leg,
single-expiration condor? The **same predicate** feeds the planner gate and the Monitor's
`MANUAL GTC` chip, so the UI cannot promise what the sweep won't do. `exitInputFromOpenEvents` was
**deleted, not deprecated** — two leg-derivation paths is exactly how a rolled trade gets priced
at pre-roll strikes.

---

## 5. Error Handling & Edge Cases (additions since v1.5.1)
| Area | Edge case | Handling |
| :--- | :--- | :--- |
| Server actions | Thrown message redacted to a digest in prod | Return `ActionResult<T>`; `toResult` logs server-side for Vercel. |
| Placement | Ticket structurally invalid | `buildCondorOrder` throws — Schwab does not validate. |
| Placement | Order placed but status confirm fails | Id **not** stored; flagged "CHECK THINKORSWIM". The next sweep's pre-place guard sees the order and flags rather than duplicating. |
| Fill → journal | Partial fill | Refused. Never journaled automatically. |
| Sweep | GTC filled but Schwab returns no execution detail | Refuses to journal invented prices; flags for the manual form. |
| Sweep | Fill contracts ≠ trade contracts | Not journaled; flagged. |
| Journal | Blank price field | Travels as `null`; schema refuses. **$0.00 is legal, blank is not.** |
| Journal | Close missing legs / duplicate role | Refused — exactly four, each role once. |
| Edit | Ineligible event id (entry leg, roll leg, `schwab_fill`) | Whole edit rolls back; totals re-derived from the full log. |
| Cancel GTC | Order already FILLED | Reported as a **closed position** with "do NOT close in TOS"; record not cleared (the sweep reconciles). |
| Cancel GTC | `PENDING_CANCEL` after the cancel | Record **not** cleared — a pending cancel can still fill. |
| Cancel GTC | Partial fill | Refuses; cancelling would leave a half-closed condor. |
| Cancel GTC | Read-back fails | Record not cleared; "CHECK THINKORSWIM". |

---

## 6. Build Order (history + current)

### ✅ Phases 0–11 — Scanner → v1.5.1 Importer (DONE)
See Tech Spec v1.5.1. **172 tests** at that point.

### ✅ Phase 12 — Order Placement / v2.0 (sessions 11–12)
`lib/schwab/order-ticket.ts` (golden fixture first) · `orders.ts` place/get/cancel ·
`order-actions.ts` with the `ActionResult` contract · `PlaceOrderPanel` · `recordFillAction` ·
**app auth layer** (`lib/auth/session.ts` + `middleware.ts` + `/login`).

### ✅ Phase 13 — Panel Editing + Logged Override / v2.1 (session 11–12)
Editable strikes (delta nulled on edit) · override with typed reason · `composeFillNotes`.

### ✅ Phase 13.1 — Earnings Sleeve Removal / v2.1.1
18 files deleted, 8 modified, −2,416 lines. `earnings_calendar` dropped; `sleeve` narrowed to
`'core'`; second cron slot freed **and held open**; Finnhub dependency removed.

### ✅ Phase 14 — Auto-Exit Sweep / v2.2 (sessions 13–14)
`exit-ticket.ts` (golden fixture first) · `exit-sweep.ts` pure planner · `close-from-fill.ts` ·
`exit_order_id` migration + manual-GTC adoption backfill · sweep folded into the post-close cron ·
`GTC @ $X.XX` / `MANUAL GTC` chips. Later: placement pause toggle + migration.

### ✅ Phase 15 — Close Hardening + Closed-Trade Edit / v2.2.1 (session 16)
`deriveTotals(events)` · hardened `CloseTradeSchema` (4 legs, explicit prices) · draft types ·
`edit-close.ts` planner · `editClosedTrade` transaction · `lib/action-result.ts` extraction ·
`closeTradeAction` → `ActionResult`. **255 tests.**

### ✅ Phase 16 — Cancel GTC + currentStructure / v2.3 (session 16, DEPLOYED 2026-07-28)
`current-structure.ts` · sweep gate switched to `isPriceableStructure` ·
`exitInputFromOpenEvents` + `hasRollEvents` deleted · `cancel-exit.ts` planner ·
`cancelStandingExitAction` · Monitor Cancel GTC affordance · **Record Close** rename.
**278 tests; no migration.**

### ✅ Phase 17 — Index Options / v2.4 steps 3–9 (sessions 17–18, `989dfc8` + `e3df1ff`)
`lib/strategy/instruments.ts` as the single source of truth (registry, `resolveUnderlying`,
pillars, fees, `minWingWidth`, `apiSymbolFor`); `parseOccSymbol` returns `root` AND resolved
`underlying`; symbol-level refusals folded into `structureRefusal` so `isPriceableStructure`
stays ONE predicate. XSP golden fixture pinned 2026-07-30 (order 1007409658003) and
`orderFixturePinned` flipped for XSP only — SPX/NDX/RUT still refuse. Step 11 (manual ladder)
is calendar-blocked on calibration (~Aug 24–25).

### ✅ Phase 18 — Roll + Entry Hardening / v2.3.1 + v2.3.2 (session 19)
Completes the F25 defect class across all three journal write paths. `RollTradeDraft` /
`NewTradeDraft` carry `null` for blank; `RollTradeSchema` adds the roll-leg invariant (refuse
duplicate `(eventType, leg)` and an unmatched `roll_open`; ALLOW an unmatched `roll_close`);
`LegInputSchema` is hardened at the base so future writers inherit it; `initialBpr` must be
positive (0 means unset, not free capital — this also tightens the importer).
`createTradeAction` and `rollTradeAction` now return `ActionResult<T>`, so **every** journal
write path does.

**450 tests; no migration.**

### ✅ Phase 19 — Override on all verdicts / v2.5 (`cd19fed`, session 19)
`lib/strategy/override-gate.ts` is ONE predicate for "must this be overridden, and what is being
overridden?", read by both the UI gate and the journal stamp. Every verdict is overridable —
FAIL included (April, 2026-07-31). `computeEntryGate` no longer short-circuits on a non-PASS
card. CALIBRATING renders `IV RANK: UNKNOWN (n/20)`, never the placeholder `0`. Validated live
on order 1007409658646 (override placed on a FAIL, then cancelled); the journal-stamp half
awaits a real fill.

### ✅ Phase 20 — IV basis correction / v2.6 (`ad2a7ac`, session 19) — **MIGRATION**
The IV cron and the scanner were measuring different instruments on the two sides of the IV Rank
formula. The cron now calls the same `getOptionChain`; `iv_history.iv_basis` separates the eras;
writes refuse `atm_iv <= 0`. `migrations/2026-07-31-iv-basis.sql` applied in Neon before deploy.
All symbols recalibrate from 2026-07-31 (~Aug 27–28).

**471 tests.**

### 🔭 Pending
v2.4 step 11 (calendar-blocked ~Aug 27–28) · roll-badge market-hours confirmation (owed since
S17) · first real ENTRY fill — validates `recordFillAction` AND the v2.5 override journal stamp ·
the placement panel's ~2-minute auto-journal window (a fill outside it is never journaled) ·
at-fill exit placement · roll-event editing · diagonal exits.

---

## 7. Gates — run before ANY push, in this order
```bash
npx tsx --test "lib/**/*.test.ts"     # unit tests — currently 471 passing
./node_modules/.bin/tsc --noEmit      # THE type gate (tsx does NOT type-check)
rm -rf .next && npm run build         # required especially after deleting routes
find app components lib -name "* 2.*" # macOS Finder collision sweep
```
Known-good noise: `roll-alert.test.ts` emits one TS5097 error — pinned, not a failure.
Pre-existing lint: `set-state-in-effect` on both client pages. Use the repo-local toolchain
(`./node_modules/.bin/…`), never `npx --yes`.

---

## 8. Tech Spec Self-Review
| Check | Status |
| :--- | :--- |
| Every PRD v2.3 feature mapped to data/endpoints/phase? | ✅ F1–F28 (F18 explicitly REMOVED) |
| Internal contradictions? | None — corrects v1.5.1's earnings sleeve, 7 tables, 2 crons, 11 routes |
| Build-order dependencies clear? | ✅ Phases 0–18; v2.4 step 11 calendar-blocked |
| Known doc/code gaps flagged? | ✅ **IV Rank zero-row contamination (PRD §9a — real bug, unfixed)**; sub-$1 4dp acceptance. ~~`user_settings` schema file~~ (was already folded in — the boards carried it wrongly through S15–S18); ~~roll-form coercion~~ (v2.3.1); ~~entry-form coercion~~ (v2.3.2) |

---

**End of Tech Spec v2.3**
