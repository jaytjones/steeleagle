# SteelEagle — Technical Specification
**Version:** Tech Spec v2.16 (paired with PRD v2.16)
**Status:** Consolidated refresh — from the code, the deployed build, and session summaries 17–28
**Last Updated:** October 31, 2026 (Session 28)
**Supersedes:** Tech Spec v2.3 (July 28, 2026; amended through August 18)
**Companion PRD:** `steeleagle-prd-v2-16.md`

> **Scope of this refresh.** Brings v2.3 current across v2.6.1 → v2.16. Session summaries and the
> per-milestone specs in `docs/` remain the authority on *why*; this documents *what exists now*.
> **Test baseline: 999 passing.** Where this and the code disagree, the code wins.

---

## 1. Tech Stack

| Layer | Choice | Notes |
| :--- | :--- | :--- |
| **Framework** | Next.js 16 (App Router, Turbopack) | Server Components + Route Handlers + Server Actions. **A page that must show live state needs a request-time signal** (e.g. `await searchParams`) — DB I/O alone does not stop prerendering (Session 27). |
| **Language** | TypeScript (strict) | `node:test` via `tsx`. **`tsx --test` does NOT type-check — `tsc --noEmit` is the gate**, and it is expected to be completely silent. |
| **Styling** | Tailwind CSS v4 | Class names must appear as literal strings. |
| **Database** | Neon Postgres via `@vercel/postgres` | Tagged templates take scalars only — arrays need `sql.query(text, [arr])`. `jsonb` reorders keys: compare stored reports structurally. |
| **Validation** | zod v4 | At every action boundary. |
| **Auth** | Schwab OAuth 2.0 + signed `se_session` cookie (30 days) | |
| **Hosting / Cron** | Vercel Hobby | **1 of 2 cron slots used**; the free slot is held open. |

### The Schwab doctrine — never build from docs alone
Every Schwab path is built from a **live fixture first**. Traps caught this way:

| Trap | Reality |
| :--- | :--- |
| `duration` | `"GOOD_TILL_CANCEL"`, not `"GTC"` |
| `volatility` | already a percentage |
| `fromEnteredTime` | 180-day lookback to see standing GTCs |
| `settlementType` | AM/PM (`"A"`/`"P"`), NOT physical/cash |
| positions | flat legs, AGGREGATED across identical strikes — parse the OCC symbol |
| index symbols | `/chains` and `/quotes` accept only the `$` form |
| `expirationType` | a monthly is `"S"`, not `"M"` (v2.10) |
| `complexOrderStrategyType` | **never read** — rolls came back `CONDOR` ×5 and `CUSTOM` ×1, structurally identical (v2.11) |
| a cancellation | filed as `activityType: "EXECUTION"`, `executionType: "CANCELED"`, full legs at price 0 — **`executionType` is the only discriminator** (v2.13.2) |
| money-market sweeps | `assetType: MUTUAL_FUND`, bare `BUY`, fractional quantity — out of scope for the option identity, never a refusal (v2.13.1) |
| re-auth window | 7 days from the INTERACTIVE login; a refresh does not extend it (v2.13) |
| a butterfly close | recorded identically to a condor (`IRON_CONDOR`, same leg order) — v2.7.1 |

### Top Stack Risks
| Risk | Mitigation |
| :--- | :--- |
| Duplicate GTC placement | `getWorkingAndRecentOrders` throws (never `[]`); quantity-aware pre-place guard; `exit_order_id IS NULL` guard; clear and place never in one run. |
| Over-covering a position | `held − covered ≥ contracts`; every unknown → strict blanket rule; `covered > held` is critical. |
| A misread auto-journal write mis-prices a GTC | The zero-residual gate + narrow conditions + the **GTC hold** until JJ confirms. |
| Duplicate journal entry | `createTrade` refuses an entry order id already journaled (v2.16). |
| Silent failure | "did not run" is critical everywhere; freshness from the clock; severity stamped at the producer. |
| Thrown server-action messages redacted in prod | Actions return `ActionResult<T>` via `toResult`. |

---

## 2. Data Models

### Entity Map
```
 tokens(1) · accounts(1) · user_settings(1) · iv_history(symbol,date,basis)
 trades 1───∞ trade_events                     ← the journal
 schwab_fills (order_id PK) ──trade_id──▶ trades   ← the account's order record (v2.11)
 position_snapshots (taken_at)                 ← the identity's anchors (v2.11)
 sweep_runs (ran_at)                           ← every sweep report, verbatim (v2.9)
```
**Nine tables.** FKs: `trade_events.trade_id → trades` (cascade), `schwab_fills.trade_id →
trades` (set null). `schwab_fills`, `position_snapshots` and `sweep_runs` are **write-only from the
cron and read-only elsewhere; nothing in the placement path reads them.**

### Schema changes since v2.3
```sql
-- v2.6 — IV basis                         migrations/2026-07-31-iv-basis.sql
ALTER TABLE iv_history ADD COLUMN iv_basis text NOT NULL DEFAULT 'legacy_front_expiry';

-- v2.9 — sweep run visibility             migrations/2026-08-07-sweep-runs.sql
CREATE TABLE sweep_runs (id uuid PK, ran_at timestamptz, severity text CHECK (critical|warning|ok),
  critical_count int, warning_count int, headline text, report jsonb, created_at timestamptz);

-- v2.11 — fill ledger + anchors           migrations/2026-08-14-fill-ledger.sql
CREATE TABLE position_snapshots (id uuid PK, taken_at timestamptz, symbols jsonb, -- occ → net qty
  symbol_count int, created_at timestamptz);
CREATE TABLE schwab_fills (order_id text PK, entered_time, occurred_at, status, shape,
  underlying, expiration, contracts, filled, classification jsonb,
  disposition text CHECK (pending|journaled|dismissed) DEFAULT 'pending',
  trade_id uuid REFERENCES trades ON DELETE SET NULL, ingested_at, updated_at);

-- v2.15 — GTC hold after an automatic write   migrations/2026-10-31-exit-hold.sql
ALTER TABLE trades ADD COLUMN exit_hold_order_id text;   -- the Schwab order the write came from
ALTER TABLE trades ADD COLUMN exit_hold_at timestamptz;  -- drives the 3-run escalation
ALTER TABLE trades ADD CONSTRAINT trades_exit_hold_pair_chk
  CHECK ((exit_hold_order_id IS NULL) = (exit_hold_at IS NULL));
```
All applied in Neon **before** their code deployed. v2.6.1, v2.7–v2.8, v2.10, v2.12–v2.14 and
v2.16 needed no migration (v2.13 reuses `tokens.refresh_token_expires_at` as the deadline;
v2.16 reuses the v2.15 hold). **Session 28 data backfill:** 11 `trades.initial_bpr = 0`
placeholders replaced with the derived BPR (`scripts/backfill-entry-bpr.ts`).

### Key TypeScript Types (current)
```typescript
interface Trade { id; symbol; sleeve: 'core'; status; openedAt; closedAt; initialExpiration;
  currentExpiration; initialCredit; totalCreditCollected; totalDebitPaid; initialBpr; contracts;
  closeReason; exitOrderId: string|null;
  exitHoldOrderId: string|null; exitHoldAt: string|null;      // v2.15
  notes; createdAt; updatedAt; events: TradeEvent[] }
interface TradeEvent { …; eventType: 'open'|'close'|'roll_close'|'roll_open';
  source: 'manual'|'schwab_fill'; schwabOrderId; … }

// zod write models: NewTradeSchema · RollTradeSchema · CloseTradeSchema · EditClosedTradeSchema
//                   EditRollPricesSchema (v2.16)
// Draft types carry null for blank — never widen a *Draft to its *Input.

// fills (v2.11)
type FillShape = 'CONDOR_OPEN'|'CONDOR_CLOSE'|'ROLL'|'PARTIAL_OPEN'|'PARTIAL_CLOSE'|'NOT_OPTION'|'AMBIGUOUS'
interface FillClassification { orderId; shape; status; underlying; expiration; occurredAt;
  contracts; filled; legs: ClassifiedLeg[]; refusals: string[]; … }
type BalanceStatus = 'BALANCED'|'RESIDUAL'|'UNRELIABLE'   // null balance = UNANCHORED

// sweep
interface SweepTradeInput { id; symbol; currentExpiration; exitOrderId; priceable;
  unpriceableReason?; heldContracts?; contracts?; exitHoldOrderId?; exitHoldAt? }
interface SweepFlag { tradeId|null; orderId|null; reason; severity: 'critical'|'routine' }
interface ExitSweepReport { reconciled; cleared; alerts; placed; flagged; errors; placementPaused;
  wouldHavePlaced; reconciliation; ingestion?;
  autoJournal?: { ran; gate; gateReason; written; refused; failed;   // closes (v2.14)
                  rolls?: AutoRollReport; entries?: AutoEntryReport } }
```

---

## 3. Application Architecture

### Runtime Routes
`/` (landing, per-request) · `/login` · `/dashboard` (sweep banner, scanner, Monitor, placement
panel, pause toggle, Cancel GTC) · `/journal` (trades, Unjournaled Activity deep links, New Trade,
Import, Roll, Record Close, Edit Close, **Edit Roll Prices**, **Confirm & arm GTC**).

### API Routes (10)
| Method | Path | Auth | Response |
| :--- | :--- | :--- | :--- |
| GET | `/api/auth/login` · `/api/auth/callback` | session | OAuth redirects |
| GET | `/api/auth/status` | session | token + **re-auth window** (`ok/soon/expired/unknown`, deadline CT) |
| GET | `/api/scanner` | session + Schwab | `{ results }` |
| GET | `/api/positions` | session + Schwab | `{ positions, balances }` + roll verdicts + `journalExits[]` (one link per trade, incl. `heldByOrderId`) |
| GET/PATCH | `/api/settings` | session | `UserSettings` |
| GET | `/api/journal` | session | `{ trades, timestamp }` |
| GET | `/api/journal/import-candidates` | session + Schwab | `ImportCandidatesResponse` |
| GET | `/api/journal/unjournaled` | session | actionable fills + `prefill` (split halves paired, v2.16) |
| GET | `/api/sweep-runs` | session | `{ latest, summary, freshness }` |
| GET | `/api/cron/snapshot-iv` | **`CRON_SECRET`** | `{ date, results, exitSweep, sweepSummary }` |

### Server Actions (all return `ActionResult<T>`)
| File | Actions |
| :--- | :--- |
| `app/dashboard/actions.ts` | `setTickers` · `setPauseExitPlacement` |
| `app/dashboard/order-actions.ts` | `placeCondorOrderAction` · `getOrderStatusAction` · `cancelCondorOrderAction` · `cancelStandingExitAction` · `recordFillAction` |
| `app/journal/actions.ts` | `createTradeAction` · `rollTradeAction` · `closeTradeAction` · `editClosedTradeAction` · **`editRollPricesAction`** (v2.16) · **`confirmAutoRollAction`** (v2.15; lifts any hold) · `importTradesAction` |

### Source (pure modules in `lib/` unless noted)
```
lib/journal/
  types · trade-math (deriveTotals, entryBpr) · importer · compose-fill-notes
  current-structure     foldStructure (structure only) + currentStructure (symbol checks + fold)
  close-from-fill · edit-close · edit-roll (v2.16)
  classify-fill · order-effects · position-delta · balance · ingest
  match-fill (matchFill, closeOwners<T>) · fill-to-draft · reconcile
  auto-journal-gate (shared gate) · auto-close (v2.14) · auto-roll + roll-from-fill (v2.15)
  auto-entry + entry-from-fill (v2.16) · split-roll (v2.16)
  golden-fills.fixture  (12 real payloads)
lib/strategy/
  instruments · expiration (v2.10) · exit-sweep · exit-links · held-contracts · sweep-report
  cancel-exit · condor-builder · iv-basis · iv-rank · reconstruct-positions · roll-alert …
lib/schwab/  client · auth · auth-window (v2.13) · chains · quotes · accounts · orders
             executions (executionScope / movedNothing) · order-ticket · exit-ticket
lib/db/      client · settings · journal · fills · sweep-runs
components/  SweepBanner · UnjournaledActivity · ReauthBanner · positions/PositionsMonitor
             journal/{TradeCard,NewTradeForm,LegRowsEditor,Import*} · scanner/*
scripts/     dump-order · dump-filled-orders · dump-working-orders · reconcile-journal
             dry-run-auto-roll · dry-run-auto-entry · backfill-entry-bpr · export-journal …
```

### The build pattern (enforced)
1. Pure module + tests first. 2. Route/action glue with per-item isolation. 3. UI last.
4. Migrations dated, applied in Neon before deploy, folded into `supabase-schema.sql` same commit.

---

## 4. The Post-Close Sweep — the highest-risk path

### 4.0 Schedule
`vercel.json`: `"15 21 * * 1-5"` — 21:15 UTC weekdays = **4:15 PM CDT / 3:15 PM CST**. DST margin
decision closed (JJ, 2026-07-31). 21:15 is when it is **due**; observed Vercel drift has run in
stretches of ~57, ~19 and ~12 minutes. Quote the due time when scheduling; quote the latest
observed run when telling JJ when to look.

### 4.1 Order of operations (`app/api/cron/snapshot-iv/route.ts`)
| Step | What | Isolation |
| :--- | :--- | :--- |
| Duty 1 | IV snapshot (25 symbols) | before the sweep; cannot be dropped by it |
| 0 | `getWorkingAndRecentOrders` (throws on failure) + open trades | failure aborts the sweep to one error |
| R | **Reconciliation** (own positions fetch) → criticals into `flagged` | try/catch; `ran:false` critical; **never consulted for placement** |
| I | **Ingestion**: ledger fills (non-option skipped) → read anchor → `sumEffects` + `checkBalance` → write new snapshot | try/catch; sets the auto-journal gate |
| H | Held contracts (own positions fetch) → v2.12 guard input | failure → strict rule, routine flag |
| P | `planExitSweep` (pure) → toReconcile / toClear / toAlert / toPlace / toFlag | |
| (a) | journal filled GTCs (`close-from-fill`), clear terminal ones | per-item |
| (b) | 21-DTE alerts | alert-only |
| (c) | place 50% GTCs — **skipped when paused** | per-item; id stored only after Schwab confirms live |
| (d) | **`runAutoJournal`**: d0 entries → d1 rolls → d2 closes, trades re-read between | each pass own try/catch; **runs when paused too** (Session 28 fix) |
| — | persist `sweep_runs` | after the sweep; cannot change what was placed |

### 4.2 Planner invariants (do not "simplify")
- Acts on fetched order state; `exit_order_id` is bookkeeping. A missing id is a fetch gap.
- Terminal → clear; re-place next run. `dte ≥ 24` to place; ≤ 21 alert-only; the cron never cancels.
- Placement eligibility = `isPriceableStructure` (one predicate shared with the Monitor chip).
- Guard: `held − covered ≥ contracts`; unknown held / coverage / size → blanket rule.
- **Hold (v2.15):** a trade with `exitHoldOrderId` is not placed; flag `routine`, `critical` once
  `expectedRunsBetween(exitHoldAt, now) ≥ 3` (clock-counted, never from `sweep_runs`), `critical`
  if the age is unreadable. Checked before `priceable`, after the DTE floor.

### 4.3 The auto-journal (v2.14 – v2.16)
**Gate** (`auto-journal-gate.ts`, shared): interval `(anchor, now]` exists AND balance is
`BALANCED` — whitelist. Otherwise nothing is written from any pass. The gate proves
completeness, not correctness, so each pass narrows interpretation:

| Pass | Candidate | Key conditions (refusal = stays an inbox card) | Write |
| :--- | :--- | :--- | :--- |
| d0 entries | `CONDOR_OPEN` | dedup by **order id**; same-strike trade with null id → refuse; BPR derivable; no butterfly entry; live order re-mapped and must match (`entryDisagreement`) | `createTrade(…, { holdExitPlacement })` — hold set in the INSERT |
| d1 rolls | `ROLL` | not already journaled (`matchFill`); exactly one owner; contracts equal; no standing GTC / prior hold; one roll per trade per interval (accepted rolls carried forward in-plan); same expiration; 2+2 one putCall or 4+4; every leg priced; closing legs = current fold; post-roll `structureOnlyRefusal` (index rolls journalable); live order must match (`rollDisagreement`) | `rollTrade(…, { source:'schwab_fill', schwabOrderId, holdExitPlacement })` — hold in the same UPDATE; provenance note on each EVENT |
| d2 closes | `CONDOR_CLOSE` | exactly one owner; contracts equal | `closeTrade(…, manual)`; clears any hold |

All: only `disposition = 'pending'`; a successful write stamps `journaled`; a write that throws is
critical; refusals recorded, not flagged; writes are NOTES. `ran:false` per pass is critical
with its own prefix. **Confirm** = `confirmAutoRoll(tradeId, orderId)`, guarded on the order id
shown. `rollTrade` re-checks exit/hold columns under the row lock.

### 4.4 Duplicate-entry guard (v2.16)
`createTrade` refuses inside its transaction when any `open` event already carries the input's
`schwabOrderId` — covering Import, `recordFillAction` and auto-entry. `recordFillAction` also now
skips cancellation records and counts a missing execution quantity as 0.

---

## 5. Error Handling & Edge Cases (additions since v2.3)
| Area | Edge case | Handling |
| :--- | :--- | :--- |
| Identity | A non-option order in the window | Known zero, not a refusal (v2.13.1) |
| Identity | A cancelled/replaced order's EXECUTION record | Known zero via `executionScope`; an UNKNOWN scope refuses the proof (v2.13.2) |
| Identity | No anchor yet | UNANCHORED — never an empty-vs-empty false balance |
| Reconciliation | Positions fetch fails | `ran:false`, critical `RECONCILIATION DID NOT RUN` |
| Guard | More closes working than contracts held | `OVER-COVERED` critical |
| Auth | Token endpoint 4xx | Records the lapse (`LEAST`); a 5xx does not burn the window |
| Auto-journal | Two same-strike trades own the legs | Refuse — never guess (GLD) |
| Auto-journal | Roll's closing legs ≠ the journal's current strikes | Refuse — the journal is already behind |
| Auto-journal | Live order differs from the ledger row at write time | Refuse + critical |
| Auto-entry | Same-strike trade with no order id | Refuse (hand copy vs scale-in indistinguishable) |
| Auto-entry | Same-day entry then roll | Roll refuses on the entry's hold; inbox card |
| Roll edit | GTC standing | Refuse — cancel first; sweep re-places at the corrected price |
| Roll edit | Entry or close leg submitted | Whole edit refused |
| Split prefill | Two possible partner tickets | No pairing; each half alone |
| Landing page | Prerendered at build | Request-time signal (`await searchParams`) |

---

## 6. Build Order (history)
Phases 0–20 (scanner → v2.6): see Tech Spec v2.3. 471 tests at v2.6.

| Phase | Milestone | Migration |
| :--- | :--- | :--- |
| 21 | **v2.6.1** delta-staleness marker | — |
| 22 | **v2.7 / v2.7.1** butterfly recognition; ordering check moved into the one predicate; butterfly exit fixture (1007469542479) | — |
| 23 | **v2.8** reconciliation (`reconcile.ts`), wired into the cron | — |
| 24 | **v2.9** sweep run visibility (`sweep-report.ts`, `SweepBanner`) | `sweep_runs` |
| 25 | **v2.10** expiration selection (`expiration.ts`; IV rule extracted verbatim) | — |
| 26 | **v2.11** fill ledger + identity + Unjournaled Activity | `schwab_fills`, `position_snapshots` |
| 27 | **v2.12** quantity-aware guard; multiset reconciliation; editable sweep closes; one Monitor chip per trade | — |
| 28 | **v2.13 / .1 / .2** re-auth window; SWVXX scope fix; cancellation-as-execution fix | — |
| 29 | **v2.14** auto-journal closes | — |
| 30 | **Session 27** landing page per-request; `entryBpr` | — |
| 31 | **v2.15** auto-journal rolls + GTC hold + confirm; pause-branch fix; 3 roll fixtures pinned. **958 tests** | `exit_hold_*` |
| 32 | **v2.16** roll-price edit; auto-journal entries; duplicate-entry guard; split-roll prefill; `initial_bpr` backfill. **999 tests** | — |

**Pending:** see PRD §10 (owed live verifications; v2.4 step 11).

---

## 7. Gates — run before ANY push, in this order
```bash
npx tsx --test "lib/**/*.test.ts"     # 999 passing
./node_modules/.bin/tsc --noEmit      # THE type gate — expected completely silent
rm -rf .next && npm run build
find app components lib -name "* 2.*" # Finder collision sweep
```
Pre-existing lint: `set-state-in-effect` in `app/journal/page.tsx` (`fetchTrades` effect). Use the
repo-local toolchain; never `npx --yes`.

---

## 8. Self-Review
| Check | Status |
| :--- | :--- |
| Every PRD v2.16 feature mapped? | ✅ F1–F34 (F18 removed) |
| Contradictions with v2.3 corrected? | ✅ tables 6→9, routes 8→10, guard rule, roll editing no longer out of scope, TS5097 note retired |
| Isolation rules stated? | ✅ §2, §4.1 — ledger/sweep_runs never read by placement; hold only withholds |

---

**End of Tech Spec v2.16**
