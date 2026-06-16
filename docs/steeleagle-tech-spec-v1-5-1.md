# SteelEagle — Technical Specification
**Version:** Tech Spec v1.5.1 (paired with PRD v1.5.1)
**Status:** Consolidated refresh — reverse-engineered from the deployed build + session summaries 2–10
**Last Updated:** June 15, 2026
**Supersedes:** Tech Spec v1.2 (May 16, 2026)
**Companion PRD:** `steeleagle-prd-v1-5-1.md`

> **Scope of this refresh.** Brings the v1.2 spec current across four shipped milestones: v1.3 (strategy alignment), v1.4 (earnings sleeve), v1.5 (trade journal), v1.5.1 (Schwab importer). The session summary docs remain the authority on *why* each decision was made; this spec documents *what exists now*.

---

## 1. Tech Stack

| Layer | Choice | Notes |
| :--- | :--- | :--- |
| **Framework** | Next.js 16 (App Router, Turbopack) | Server Components + Route Handlers + Server Actions. (v1.2 spec said Next 15; upgraded since.) |
| **Language** | TypeScript (strict) | Pure strategy/math modules are unit-tested with `node:test` via `tsx`. |
| **Styling** | Tailwind CSS v4 | Dark trading-terminal aesthetic; IBM Plex Mono + Barlow Condensed. |
| **State** | React `useState` + Server Actions | Single-user; no Zustand/Redux/React-Query. |
| **Backend** | Next.js Route Handlers + Server Actions | Co-located; no separate server. |
| **Database** | **Neon Postgres via `@vercel/postgres`** | `POSTGRES_URL` auto-injected. `sql` tagged-template for one-shot queries; `db.connect()` (pooled `VercelPoolClient`) for **transactions** (journal writes). |
| **Validation** | **zod** | At the journal action boundary (`NewTradeSchema` / `RollTradeSchema` / `CloseTradeSchema`). |
| **Auth** | Schwab OAuth 2.0 (3-legged) | Required by the Schwab Trader API. |
| **Hosting / Cron** | Vercel (Hobby) | **2 cron jobs** (at free-tier limit): IV + earnings snapshots. |
| **External data** | Schwab Trader API; **Finnhub** | Finnhub `/calendar/earnings` powers the earnings sleeve. |

### External APIs
| API | Auth | Usage | Gotchas |
| :--- | :--- | :--- | :--- |
| **Schwab — Market Data** | OAuth Bearer | `/chains`, `/quotes`, `/expirationchain`, `/pricehistory` | Unthrottled GET; IV=0 after hours; use `strikeCount` to reach 5Δ longs. `/quotes` supplies live deltas for roll alerts. |
| **Schwab — Accounts/Trading** | OAuth Bearer | `/accounts/accountNumbers`, `/accounts/{hash}` (positions+balances), **`/accounts/{hash}/orders`** | Hashed account number required. Positions are **flat legs** (no spread grouping) and do **not** reliably carry `strikePrice`/`expirationDate` — parse the OCC `symbol`. Orders throttled 10/min/account (importer makes 1 call/session). |
| **Finnhub — Earnings** | API key (`FINNHUB_API_KEY`) | `/calendar/earnings` | Free tier; `hour` field maps to BMO/AMC/DMH session. |

### Top Stack Risks
| Risk | Likelihood | Mitigation |
| :--- | :--- | :--- |
| Refresh token expires every 7 days | Certain (by design) | 401-on-refresh → ReauthBanner; `/api/auth/status` exposes expiry. |
| Schwab IV=0 after hours corrupts `iv_history` | High | Skip writes when `atm_iv ≤ 0`; IV Rank ignores `≤ 0`. |
| **Schwab position shape ≠ documented** (no strike/exp fields; signed premium) | High | Parse OCC symbol via `parseOccSymbol`; `abs()` average price. (This bit the importer in prod — see Session 10.) |
| Stale account hash → empty 200 body | Medium | `getAccountSnapshot` self-heals: re-pull hash once on the empty-body signature. |
| Both Vercel cron slots used | At limit | Any third scheduled job needs a paid plan or consolidation. |
| Finnhub free-tier limits / shape drift | Low | Per-symbol try/catch in the cron; partial failures isolated. |

---

## 2. Data Models

### Entity Map
```
   ┌──────────┐   ┌──────────┐   ┌───────────────┐   ┌──────────────────┐
   │ tokens   │   │ accounts │   │ iv_history    │   │ user_settings    │
   │ (id=1)   │   │ (id=1)   │   │ (symbol,date) │   │ (id=1, tickers[])│
   └──────────┘   └──────────┘   └───────────────┘   └──────────────────┘
   ┌────────────────────┐        ┌───────────────────────────────────────┐
   │ earnings_calendar  │        │ trades  1───∞  trade_events           │
   │ (symbol,report_date)│       │ (logical condor)   (append-only legs) │
   └────────────────────┘        └───────────────────────────────────────┘
```
**Seven tables.** Singletons: `tokens`, `accounts`, `user_settings`. Time-series/append: `iv_history`, `earnings_calendar`, `trade_events`. Lifecycle row: `trades`. `trade_events.trade_id → trades.id` is the only FK (cascade delete).

> **Schema-file caveat:** `supabase-schema.sql` (misnamed — the DB is Neon) contains `tokens`, `accounts`, `iv_history`, `earnings_calendar`, `trades`, `trade_events`. **`user_settings` was applied directly in Neon and is not in the committed file** — fold it in (Open Question, PRD §9). The filename + "Supabase Dashboard" header are stale Supabase→Neon leftovers.

### Key TypeScript Types (current)
```typescript
// ── Core scanner (types/index.ts) ──────────────────────────────
type Pillar = string;
interface IVRankResult { symbol: string; currentIv: number|null; ivRank: number|null; daysCalibrated: number }
interface CondorLeg { action: 'BUY'|'SELL'; type: 'PUT'|'CALL'; strike: number; delta: number; mark: number }
interface CondorSetup {
  longPut: CondorLeg; shortPut: CondorLeg; shortCall: CondorLeg; longCall: CondorLeg;
  credit: number; wingWidth: number; creditWidthRatio: number; bpr: number;
  expiration: Date; dte: number; commissionRoundTrip: number; netCreditAfterCommission: number;
}
interface OpenPosition { symbol: string; description: string; quantity: number; marketValue: number;
  averageCost: number; unrealizedPL: number; unrealizedPLPercent: number }

// ── v1.3 reconstruction + risk (lib/strategy/*) ───────────────
type PositionKind = 'IRON_CONDOR'|'VERTICAL_SPREAD'|'OTHER';
interface ReconstructedPosition { kind; underlying; expiration: string|null; legs; quantity;
  wingWidth: number|null; credit: number|null; bpr: number|null; openPnl; openPnlReliable; dte;
  side?: 'PUT'|'CALL'; rollVerdict?: RollVerdict }
// computeBprUtilization / preflightAddTrade (bpr.ts), checkPositionLimits (position-limits.ts),
// computeEntryGate (entry-gate.ts), alertFor / summarizeAlerts (position-alerts.ts),
// computeRollAlert (roll-alert.ts), checkLiquidity (liquidity.ts)

// ── v1.4 earnings (lib/strategy/earnings-*, lib/earnings/*) ────
// tierOf/isTradeable (earnings-watchlist.ts), computeExpectedMove (expected-move.ts),
// entryWindow (earnings-entry-window.ts), buildEarningsCondor (earnings-condor.ts),
// computeEarningsGate (earnings-gate.ts), getEarningsCalendar (finnhub.ts)

// ── v1.5 / v1.5.1 journal (lib/journal/types.ts) ──────────────
interface Trade { id; symbol; sleeve: 'core'|'earnings'; status: 'open'|'closed';
  openedAt; closedAt; initialExpiration; currentExpiration; initialCredit;
  totalCreditCollected; totalDebitPaid; initialBpr; contracts; closeReason; notes; events: TradeEvent[] }
interface TradeEvent { id; tradeId; eventType: 'open'|'close'|'roll_close'|'roll_open';
  leg: 'long_put'|'short_put'|'short_call'|'long_call'; strike; expiration; delta;
  contracts; price; creditDebit: 'credit'|'debit'; amount; source: 'manual'|'schwab_fill';
  schwabOrderId: string|null; occurredAt; notes }
// zod write models: NewTradeSchema / RollTradeSchema / CloseTradeSchema
// importer types: ImportCandidate, ImportLeg, RawPositionLeg, IncompletePosition,
//                 ImportCandidatesResponse, ImportResult
```

### PostgreSQL Schema (current, abbreviated)
```sql
-- Shipped v1.0/1.1
tokens(id=1, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, …)
accounts(id=1, account_hash, …)
iv_history(id uuid, symbol, snapshot_date, atm_iv numeric, underlying_price numeric,
           unique(symbol, snapshot_date))

-- v1.2 (live in Neon; NOT in committed schema file)
user_settings(id=1, tickers text[] default '{SPY,TLT,GLD}', updated_at)

-- v1.4
earnings_calendar(id uuid, symbol, report_date date, session text default 'UNKNOWN',
                  eps_estimate numeric, confirmed bool, fetched_at, unique(symbol, report_date))

-- v1.5 (roll-aware journal; see docs/steeleagle-session-8-addendum.md §A2)
trades(id uuid, symbol, sleeve check in('core','earnings'), status check in('open','closed'),
       opened_at, closed_at, initial_expiration date, current_expiration date,
       initial_credit numeric(10,2), total_credit_collected numeric(10,2),
       total_debit_paid numeric(10,2) default 0, initial_bpr numeric(10,2), contracts int,
       close_reason check in('profit_target','stop_loss','21_dte','manual','expired'), notes, …)
trade_events(id uuid, trade_id uuid references trades on delete cascade,
       event_type check in('open','close','roll_close','roll_open'),
       leg check in('long_put','short_put','short_call','long_call'),
       strike numeric(10,2), expiration date, delta numeric(6,4), contracts int,
       price numeric(10,4), credit_debit check in('credit','debit'), amount numeric(10,2),
       source text default 'manual' check in('manual','schwab_fill'),  -- v1.5.1 importer uses 'schwab_fill'
       schwab_order_id text, occurred_at, notes, …)
```
> **Importer note (v1.5.1):** the `source` CHECK allows only `('manual','schwab_fill')`. The Session-10 spec's proposed `'schwab_import'` was **not** added — matched imports reuse `'schwab_fill'` (no migration). `schwab_order_id` (a forward-compat column since v1.5) now actually gets populated on matched imports.

### Data NOT Stored
- Raw account numbers, Schwab credentials, full option-chain snapshots, personal identity.
- **Correction vs. v1.2 spec:** *trade history IS now stored* (`trades` + `trade_events`). The journal is the deliberate exception to the prior "SteelEagle never sees your trades" stance.

---

## 3. Application Architecture: Routes & Source

### Runtime Routes
| Path | Screen | Notes |
| :--- | :--- | :--- |
| `/` | Home / Login | Redirects to `/dashboard` if a valid refresh token exists. |
| `/dashboard` | Scanner + Positions + Earnings | Client page; fetches settings/scanner/positions/auth-status/earnings. |
| `/journal` | Trade Journal | Client page; list + filters + New Trade + **Import from Schwab**. |

### API Routes (11)
| Method | Path | Auth | Response |
| :--- | :--- | :--- | :--- |
| GET | `/api/auth/login` | — | 302 → Schwab CAG |
| GET | `/api/auth/callback` | OAuth state | 302 → `/dashboard` |
| GET | `/api/auth/status` | — | `{ isAuthenticated, accessTokenExpiresAt, refreshTokenExpiresAt, needsReauth }` |
| GET | `/api/scanner` | Schwab token | `{ results: ScannerResult[] }` (accepts `?symbols=`) |
| GET | `/api/positions` | Schwab token | `{ positions: ReconstructedPosition[], balances }` (+ roll verdicts) |
| GET / PATCH | `/api/settings` | — | `UserSettings` (PATCH validates 1–10 tickers) |
| GET | `/api/cron/snapshot-iv` | `CRON_SECRET` | `{ date, results }` (4:15 PM ET wd) |
| GET | `/api/cron/snapshot-earnings` | `CRON_SECRET` | `{ from, to, snapshotted, failed[], results }` (12:00 UTC wd) |
| GET | `/api/earnings-scanner` | Schwab token | `{ cells: EarningsScannerCell[], … }` (accepts `?crisis=true`) |
| GET | `/api/journal` | — (Neon) | `{ trades, timestamp }` (accepts `?status=`) |
| GET | `/api/journal/import-candidates` | Schwab token | `ImportCandidatesResponse` |

### Server Actions
| File | Actions |
| :--- | :--- |
| `app/dashboard/actions.ts` | `setTickers(tickers)` |
| `app/journal/actions.ts` | `createTradeAction` · `rollTradeAction` · `closeTradeAction` · `importTradesAction` (all zod-validated; return refreshed data) |

### Source File Structure (current)
```
app/
  page.tsx · layout.tsx
  dashboard/page.tsx · dashboard/actions.ts
  journal/page.tsx   · journal/actions.ts
  api/auth/{login,callback,status}/route.ts
  api/{scanner,positions,settings,earnings-scanner}/route.ts
  api/cron/{snapshot-iv,snapshot-earnings}/route.ts
  api/journal/route.ts · api/journal/import-candidates/route.ts
lib/
  db/{client,settings,earnings,journal}.ts           # journal.ts is transactional (db.connect)
  schwab/{client,auth,chains,quotes,accounts,earnings-chain}.ts
  schwab/orders.ts                                   # v1.5.1 filled-orders fetcher
  strategy/{iv-rank,condor-builder,reconstruct-positions,bpr,position-limits,
            entry-gate,position-alerts,roll-alert,liquidity}.ts            # v1.0–v1.3
  strategy/{earnings-watchlist,expected-move,earnings-entry-window,
            earnings-condor,earnings-gate}.ts                              # v1.4
  earnings/{finnhub,scanner-types}.ts
  journal/{types,trade-math,importer}.ts             # pure; trade-math + importer unit-tested
components/
  ReauthBanner.tsx
  scanner/{ScannerCard,AddCellButton,BprChip,PendingCell}.tsx
  positions/PositionsMonitor.tsx
  earnings/{EarningsSection,EarningsCard}.tsx
  journal/{NewTradeForm,TradeCard,LegRowsEditor,fields,
           ImportButton,ImportCandidateReviewPanel,ImportCandidateCard}.tsx
types/index.ts
vercel.json   # 2 crons
```

### Component Notes
- **Dashboard** is one client page orchestrating scanner cards (with entry-gate overlay), the BprChip header, the ReauthBanner, the PositionsMonitor (3 sections + alert/roll banners, responsive table↔stacked), and the collapsible Earnings section.
- **Journal** is a separate client page; `ImportButton` is the self-contained state machine (`idle→loading→review→confirming→done|error`) for the importer flow.
- **Pure logic** lives in `lib/strategy/*` and `lib/journal/{trade-math,importer}.ts` — all unit-tested, no I/O.

---

## 4. State & Data Fetching
- **Server state** (scanner, positions, earnings, journal, settings) fetched client-side via `fetch()` to the routes; refreshed on demand (manual refresh / after a mutation). Journal actions return the refreshed list so the page syncs without a round-trip.
- **Local state** only (edit modes, form inputs, import flow). No global store; no React-Query/SWR (single-user, manual-refresh, tiny mutation count).
- **Mutations:** settings via the `setTickers` server action (optimistic); journal create/roll/close/import via server actions wrapping transactional DB writes.

---

## 5. API Endpoints (selected current detail)

### `GET /api/positions`
Returns `reconstructPositions(getAccountSnapshot())` (condors/verticals/others) plus `balances`. Open condors are annotated with `rollVerdict` via a batched `/quotes` delta fetch, isolated in its own try/catch (a quotes hiccup never drops the monitor). 502 on positions-fetch failure.

### `GET /api/earnings-scanner?crisis=`
Composes watchlist → cached earnings (`getUpcomingEarnings`) → entry-window gate → chain fetch + expected move → `buildEarningsCondor` → `computeEarningsGate`. Crisis = manual `?crisis=true` OR exact `hadRecentCoreStop(7)` (core stop-loss in the journal in the last 7 days).

### `GET /api/journal/import-candidates` (v1.5.1)
Pipeline: `getAccountSnapshot` → `parsePositionLegs` (OCC-parsed) → `groupIntoCondors` → `getFilledOrders(hash, 90)` → `enrichWithOrderHistory` → `deduplicateCandidates` (vs open journal trades). Positions failure → 502; orders failure → graceful marks-only (`ordersUnavailable: true`).

### `POST`-style mutations
Handled as Server Actions, not REST: `setTickers`, `createTradeAction`, `rollTradeAction`, `closeTradeAction`, `importTradesAction` (sequential `createTrade` calls; returns `{ trades, importedCount, failed[] }`).

### Crons
- `GET /api/cron/snapshot-iv` (Bearer `CRON_SECRET`, 4:15 PM ET wd): per-symbol ATM IV → upsert `iv_history`, skip `atm_iv ≤ 0`.
- `GET /api/cron/snapshot-earnings` (Bearer `CRON_SECRET`, 12:00 UTC wd): per-symbol Finnhub fetch (90-day window) → upsert `earnings_calendar`, per-symbol try/catch.

---

## 6. Auth & Permissions
Single-user; "session" = the 7-day refresh-token lifetime. Access token auto-refreshed on 401 through a single `getAccessToken()` path. Permission matrix unchanged from v1.2 plus: `/api/auth/status`, `/api/earnings-scanner`, `/api/journal/import-candidates` require a Schwab token; `/api/journal` and `/api/settings` are public-but-unguessable (single-user, no per-user auth — the multi-user caveat still stands). Crons require `CRON_SECRET`. No row-level permissions (singletons + single-user journal).

---

## 7. Error Handling & Edge Cases (additions since v1.2)
| Area | Edge case | Handling |
| :--- | :--- | :--- |
| Positions | Stale account hash → empty 200 body | `getAccountSnapshot` re-pulls hash once and retries. |
| Positions | `/quotes` deltas missing (after-hours) | Roll alerts self-suppress (NO_DELTA); monitor still renders. |
| Positions | Open P&L unreliable (today-only) | Profit/stop alerts suppressed; "(today)" shown. |
| Earnings | Finnhub symbol fetch fails | Per-symbol try/catch in cron; partial success. |
| Earnings | Entry day after a market holiday | Not modeled — flagged for manual review (weekends handled). |
| Journal | Roll/close on a closed trade | `requireOpenTrade` throws inside the transaction → rolled back. |
| Importer | Real positions lack strike/exp fields | Parse OCC symbol (`parseOccSymbol`); the v1.2-style assumption dropped all legs in prod (Session 10 fix). |
| Importer | Orders endpoint 403/empty | Degrade all candidates to marks-only; `ordersUnavailable` banner. |
| Importer | Zero-fill / partial order match | Candidate stays marks-only with position-average prices. |
| Importer | Mid-batch DB failure | `importTradesAction` reports partial success (`importedCount` / `failed[]`); earlier writes committed (each `createTrade` is its own tx). |

---

## 8. Build Order (history + current)

### ✅ Phases 0–7 — Scanner foundation → v1.2 Configurable Cells (DONE)
OAuth, schema, Schwab service layer, strategy engine, scanner dashboard, IV cron, configurable cells + settings. (See Tech Spec v1.2 for detail.)

### ✅ Phase 8 — Strategy v1.4 Alignment Layer / v1.3 (DONE, sessions 5–7)
`reconstruct-positions` · `bpr` + BprChip · `position-limits` + `entry-gate` · `position-alerts` · `roll-alert` (+ `/quotes` deltas) · `liquidity`. Positions monitor rebuilt (3 sections, alert/roll banners, responsive). ReauthBanner + `/api/auth/status`. **79 strategy tests.**

### ✅ Phase 9 — Tactical Earnings Sleeve / v1.4 (DONE, session 8)
Finnhub client + `earnings_calendar` + snapshot-earnings cron · `earnings-watchlist` · `expected-move` · `earnings-entry-window` · `earnings-condor` · `earnings-gate` · `/api/earnings-scanner` · EarningsSection/EarningsCard. **143 tests total.**

### ✅ Phase 10 — Trade Journal / v1.5 (DONE, session 9)
`trades` + `trade_events` schema · `lib/journal/{types,trade-math}` · transactional `lib/db/journal.ts` · `/api/journal` + journal actions · `/journal` page + NewTradeForm/TradeCard/LegRowsEditor/fields. Crisis auto-detect rewired to `hadRecentCoreStop`. **149 tests.**

### ✅ Phase 11 — Schwab Position Importer / v1.5.1 (DONE, session 10)
`lib/schwab/orders.ts` · `lib/journal/importer.ts` (+ tests) · `/api/journal/import-candidates` · `importTradesAction` · ImportButton/ReviewPanel/Card · Wing Width cell on TradeCard · `source`/`schwab_order_id` threaded through `insertEvent`. **172 tests; `next build` clean; live-verified in prod.**

### 🔭 Pending (Future Scope — PRD §10)
v2.0 execution + continuous fill sync + automated exit cron; journal current-structure reconstruction; earnings holiday calendar + liquidity filter; fold `user_settings` into the committed schema file.

---

## 9. Tech Spec Self-Review
| Check | Status |
| :--- | :--- |
| Every PRD v1.5.1 feature mapped to data/endpoints/phase? | ✅ F1–F20 |
| Internal contradictions? | None — explicitly corrected the v1.2 "no trade history stored" and `'schwab_import'` items |
| Build-order dependencies clear? | ✅ Phases 0–11 sequential; v2.0 deferred |
| Known doc/code gaps flagged? | ✅ `user_settings` not in committed schema file; earnings holiday calendar; journal current-structure view |

---

**End of Tech Spec v1.5.1**
