# SteelEagle — Technical Specification
**Version:** Tech Spec v1.2 (paired with PRD v1.2)
**Status:** Reverse-engineered from deployed build (v1.0/1.1) + Foundation Patch + v1.2 Configurable Cells
**Last Updated:** May 16, 2026
**Companion PRD:** `steeleagle-prd-v1-2.md`

---

## 1. Tech Stack

### Stack Summary

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| **Frontend framework** | Next.js 15 (App Router) | Server Components reduce client JS for a mostly-read dashboard; built-in API routes co-locate backend; Vercel deploys with zero config |
| **Language** | TypeScript | Strict typing for option chain math and Schwab API contracts where field shape errors are silent and expensive |
| **Styling** | Tailwind CSS | No external CSS framework needed for a single dashboard; utility classes keep the trading-terminal aesthetic consistent |
| **State management** | React `useState` + Server Actions | Single-user, low-complexity app — no Zustand/Redux/Context needed |
| **Backend / API layer** | Next.js API Route Handlers | Same repo as frontend; no separate server to deploy or auth |
| **Database** | Neon Postgres (via Vercel integration) | Free tier sufficient for current volume; SQL strength matches time-series IV history queries; `POSTGRES_URL` auto-injected by Vercel |
| **Authentication** | Schwab OAuth 2.0 (3-legged) | Required by Schwab Trader API — no alternative |
| **File storage** | None | No user uploads or generated files |
| **Hosting** | Vercel (Hobby plan) | Free, native Next.js, includes HTTPS callback URL for OAuth, includes Cron |
| **Cron** | Vercel Cron | 2 free jobs sufficient; native to project; `vercel.json` config |
| **Source control** | GitHub (private repo) | Auto-deploys on `git push` to main |
| **Fonts** | IBM Plex Mono + Barlow Condensed (Google Fonts) | Trading-terminal aesthetic without custom font hosting |

### External APIs

| API | Auth | Usage | Rate Limits / Gotchas |
| :--- | :--- | :--- | :--- |
| **Schwab Trader API — Market Data** | OAuth 2.0 (Bearer) | `/chains`, `/quotes`, `/expirationchain`, `/pricehistory` | Unthrottled on GET. Returns IV=0 outside market hours. Strike grids vary by underlying — use `strikeCount: 200` to ensure 5Δ longs are reachable. |
| **Schwab Trader API — Accounts/Trading** | OAuth 2.0 (Bearer) | `/accounts/accountNumbers`, `/accounts/{hash}` | Requires hashed account number, not raw account ID. Order endpoints throttled at 10/min/account (not used in v1.x). |

### Top Stack Risks

| Risk | Likelihood | Mitigation |
| :--- | :--- | :--- |
| **Schwab refresh token expires every 7 days, requiring manual re-auth** | Certain (by design) | Detect 401 on refresh attempt → surface clear re-auth banner on dashboard; do not silently fail. |
| **Schwab returns IV=0 outside market hours, corrupting `iv_history`** | High | Cron writes are skipped when `atm_iv <= 0`; daily run scheduled at 4:15 PM ET (post-close); IV Rank query ignores rows with `atm_iv <= 0`. |
| **Strike grid sparsity causes 5Δ longs to be unavailable** | Medium | Use `strikeCount: 200` parameter on `/chains`; condor builder falls back to nearest valid strike if true 5Δ unavailable. |
| **Neon free tier sleeps the database on inactivity** | Low | Connection pooling via `@neondatabase/serverless` handles wake-up transparently; first request of the day may be ~500ms slower. |
| **Vercel Hobby function timeout (10s default, 60s on cron)** | Low | Scanner endpoint completes in <8s for 10 cells; cron completes in <30s for 21 symbols. |

---

## 2. Data Models

### Entity Map

```
                        ┌─────────────┐
                        │  tokens     │ (singleton, id=1)
                        │  - Schwab   │
                        │    OAuth    │
                        └─────────────┘
                              │
                              │ (auth context)
                              ▼
   ┌─────────────┐      ┌─────────────┐      ┌──────────────────┐
   │  accounts   │      │ iv_history  │      │  user_settings   │
   │  - hashed   │      │ - daily IV  │      │ - tickers array  │
   │    account  │      │   snapshots │      │ - singleton, id=1│
   │  - singleton│      │ - per       │      │   (v1.2)         │
   └─────────────┘      │   symbol    │      └──────────────────┘
                        └─────────────┘
```

Three tables exist in production (v1.0/1.1). A fourth (`user_settings`) is added in v1.2. All four tables follow a singleton pattern except `iv_history`, which is a time-series append table.

### TypeScript Types

```typescript
// =========================================================================
// Database row types — mirror Neon schema (snake_case → camelCase mapping)
// =========================================================================

/** Schwab OAuth tokens. Singleton row (id=1). */
type SchwabTokens = {
  id: 1;
  accessToken: string;
  refreshToken: string;
  /** Access token expires 30 min after issuance. */
  accessExpiresAt: Date;
  /** Refresh token expires 7 days after issuance. Triggers manual re-auth. */
  refreshExpiresAt: Date;
  updatedAt: Date;
};

/** Cached Schwab account info. Singleton row (id=1) — single-user app. */
type Account = {
  id: 1;
  /** Hashed account number — required by Schwab for trading endpoints. */
  accountHash: string;
  updatedAt: Date;
};

/** Daily ATM IV snapshot. One row per (symbol, date). Time-series append-only. */
type IvSnapshot = {
  id: number;
  symbol: string;
  /** Trading date (no timezone — date column). */
  date: Date;
  /** At-the-money implied volatility, as a decimal (e.g., 0.18 = 18%). */
  atmIv: number;
  /** Underlying price at time of snapshot. */
  underlyingPrice: number | null;
  createdAt: Date;
};

/** User-configurable dashboard settings. Singleton row (id=1) — single-user app. */
type UserSettings = {
  id: 1;
  /** Active ticker list driving the scanner cells. Default: ['SPY','TLT','GLD']. */
  tickers: string[];
  updatedAt: Date;
};

// =========================================================================
// Domain types — derived/computed, not stored
// =========================================================================

type LegType = 'PUT' | 'CALL';
type LegAction = 'BUY' | 'SELL';
type ScannerStatus = 'PASS' | 'CALIBRATING' | 'FAIL' | 'NO_DATA' | 'INVALID_SYMBOL';

type CondorLeg = {
  action: LegAction;
  type: LegType;
  strike: number;
  /** Signed delta. Puts negative, calls positive. */
  delta: number;
  /** Mark price (mid of bid/ask). */
  mark: number;
};

type CondorSetup = {
  longPut: CondorLeg;
  shortPut: CondorLeg;
  shortCall: CondorLeg;
  longCall: CondorLeg;
  /** Total credit per contract, in dollars (e.g., 180 = $180 credit on $10 wing). */
  credit: number;
  /** Symmetric wing width per contract, in dollars (e.g., 1000 = $10 wide). */
  wingWidth: number;
  /** Credit / wing width ratio. 0.18 = 18% of wing width as credit. */
  creditWidthRatio: number;
  /** Max loss per contract = wingWidth - credit. */
  bpr: number;
  expiration: Date;
  dte: number;
  /** Foundation Patch: $5.20 round-trip per contract. */
  commissionRoundTrip: number;
  /** Foundation Patch: credit - commissionRoundTrip. */
  netCreditAfterCommission: number;
};

type ScannerCell = {
  symbol: string;
  currentIv: number | null;
  ivRank: number | null;
  status: ScannerStatus;
  /** Number of trading days of IV history collected. */
  daysCalibrated: number;
  setup: CondorSetup | null;
  /** Reasons the setup failed filtering (e.g., "IV Rank below 25%"). */
  failureReasons: string[];
};

type Position = {
  symbol: string;
  legs: CondorLeg[];
  openDate: Date;
  /** Days remaining until expiration. */
  dte: number;
  /** Current mark P&L per contract. */
  currentPnl: number;
  /** Credit received at open. */
  openCredit: number;
};

// =========================================================================
// Input types — for create/update operations
// =========================================================================

type UserSettingsUpdate = {
  tickers: string[];
};

type IvSnapshotInsert = {
  symbol: string;
  date: Date;
  atmIv: number;
  underlyingPrice: number | null;
};
```

### PostgreSQL Schema

```sql
-- =========================================================================
-- SHIPPED (v1.0/1.1)
-- =========================================================================

create table if not exists tokens (
  id                  integer       primary key default 1,
  access_token        text          not null,
  refresh_token       text          not null,
  access_expires_at   timestamptz   not null,
  refresh_expires_at  timestamptz   not null,
  updated_at          timestamptz   not null default now(),
  check (id = 1)  -- singleton enforcement
);

create table if not exists accounts (
  id            integer       primary key default 1,
  account_hash  text          not null,
  updated_at    timestamptz   not null default now(),
  check (id = 1)
);

create table if not exists iv_history (
  id                serial        primary key,
  symbol            text          not null,
  date              date          not null,
  atm_iv            numeric(8,6)  not null,
  underlying_price  numeric(12,4),
  created_at        timestamptz   not null default now(),
  unique (symbol, date)
);

-- Index for IV Rank computation — fetch recent history per symbol fast
create index if not exists iv_history_symbol_date_idx
  on iv_history (symbol, date desc);

-- =========================================================================
-- v1.2 (Configurable Cells)
-- =========================================================================

create table if not exists user_settings (
  id          integer       primary key default 1,
  tickers     text[]        not null default '{SPY,TLT,GLD}',
  updated_at  timestamptz   not null default now(),
  check (id = 1)
);

-- One-time backfill on first deploy of v1.2
insert into user_settings (id, tickers)
  values (1, '{SPY,TLT,GLD}')
  on conflict (id) do nothing;
```

### Data NOT Stored

- **Raw account numbers** — Schwab requires hashed values for trading endpoints. Only the hash is persisted.
- **Schwab credentials (`client_secret`, login passwords)** — Live only in Vercel environment variables. Never written to DB.
- **Option chain snapshots** — Fetched fresh per request. Storing full chains would 100× the DB volume with no analytical benefit for v1.x.
- **Personal user identity** — No name, email, IP. Single-user app, no user table.
- **Trade history** — Trades are placed manually in Schwab/TOS; SteelEagle never sees them. Position state is fetched live from `/accounts/{hash}`.

---

## 3. Application Architecture: Routes & Source

### Runtime Routes

| Path | Screen | Auth Required | Loading Strategy | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `/` | Home / Login | No | Server-rendered | If `tokens` table has valid refresh token → redirect to `/dashboard`; otherwise show "Login with Schwab" button. |
| `/dashboard` | Main Dashboard | Yes | Server Component + client islands | Renders scanner cells from server-side fetch of `/api/scanner` + `/api/settings`. Refresh button triggers client-side re-fetch. |

### API Routes

| Method | Path | Auth Required | Trigger | Response Type |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/auth/login` | No | User clicks Login | 302 redirect to Schwab CAG |
| `GET` | `/api/auth/callback` | Implicit (OAuth) | Schwab redirect | 302 redirect to `/dashboard` on success; error page on failure |
| `GET` | `/api/scanner` | Yes (Schwab token) | Dashboard load + manual refresh | `ScannerCell[]` |
| `GET` | `/api/positions` | Yes (Schwab token) | Dashboard load | `{ positions: Position[]; accountHash: string }` |
| `GET` | `/api/settings` | None (single-user) | Dashboard load | `UserSettings` |
| `PATCH` | `/api/settings` | None (single-user) | Cell add/remove/edit | `UserSettings` (echoes new state) |
| `GET` | `/api/cron/snapshot-iv` | `CRON_SECRET` Bearer | Vercel Cron (4:15 PM ET weekdays) | `{ snapshotted: number; failed: string[] }` |

> **Note:** "Auth Required" for the settings endpoint is "None" because this is a single-user app behind a Schwab OAuth gate that the operator already passed for the scanner/positions calls. There is no separate user identity layer. When multi-user becomes scope, settings will need to be keyed by user ID and the endpoints will need their own auth check.

### Component Breakdown

Components grouped by their location in the app.

#### Page Components
| Component | Screen | Local State | Props |
| :--- | :--- | :--- | :--- |
| `HomePage` | `/` | None | Server-rendered |
| `Dashboard` | `/dashboard` | None (Server Component) | Initial data fetched server-side and passed to children |

#### Layout / Header
| Component | Reused | Local State | Props |
| :--- | :--- | :--- | :--- |
| `DashboardHeader` | One screen | `refreshing: boolean` | `marketOpen: boolean`, `onRefresh: () => void` |
| `CalibrationBanner` | One screen | None | `calibratingSymbols: { symbol: string; days: number }[]` |
| `ReauthBanner` | One screen | None | Shown only when refresh token expired |

#### Scanner Grid
| Component | Reused | Local State | Props |
| :--- | :--- | :--- | :--- |
| `ScannerGrid` | One screen | None | `cells: ScannerCell[]`, `onAddCell: () => void`, `onRemoveCell: (symbol: string) => void`, `onEditCell: (oldSymbol: string, newSymbol: string) => void` |
| `ScannerCard` | Many instances | `isEditing: boolean`, `inputValue: string` | `cell: ScannerCell`, `onRemove: () => void`, `onSymbolChange: (newSymbol: string) => void` |
| `AddCellButton` | One instance | None | `disabled: boolean` (when at 10-cell max), `onClick: () => void` |
| `TradeSetupTable` | Inside each `ScannerCard` | None | `setup: CondorSetup` |
| `FilterFailureList` | Inside each `ScannerCard` | None | `reasons: string[]` |

#### Positions
| Component | Reused | Local State | Props |
| :--- | :--- | :--- | :--- |
| `PositionsMonitor` | One screen | None | `positions: Position[]` |
| `PositionRow` | Many instances | None | `position: Position` |
| `EmptyPositionsState` | Inside `PositionsMonitor` | None | — |

#### Reusable Primitives
- `StatusBadge` — colored pill for PASS / CALIBRATING / FAIL / NO_DATA / INVALID_SYMBOL
- `IconButton` — close affordance on cells, refresh button in header

---

### Source File Structure

This section documents the actual source files and their purposes. Files marked **[Exists]** are in the current codebase; **[Planned]** indicates future work mentioned in the tech spec but not yet implemented.

#### Pages & Routing
| File | Purpose | Status |
| :--- | :--- | :--- |
| `app/page.tsx` | Landing page — redirects to `/dashboard` or shows login CTA | [Exists] |
| `app/layout.tsx` | Root layout — fonts, global styles, auth gate | [Exists] |
| `app/dashboard/page.tsx` | Main dashboard server component | [Exists] |

#### Authentication Endpoints
| File | Purpose | Status |
| :--- | :--- | :--- |
| `app/api/auth/login/route.ts` | Initiates Schwab OAuth 3-legged flow | [Exists] |
| `app/api/auth/callback/route.ts` | Handles Schwab auth code callback, exchanges for tokens, caches account hash | [Exists] |

#### Scanner & API Routes
| File | Purpose | Status |
| :--- | :--- | :--- |
| `app/api/scanner/route.ts` | Fetches option chains for user's ticker list, constructs condor setups, returns scanner results | [Exists] |
| `app/api/positions/route.ts` | Fetches open positions from Schwab accounts endpoint | [Exists] |
| `app/api/settings/route.ts` | GET/PATCH user settings (configurable ticker list) | [Planned] |
| `app/api/cron/snapshot-iv/route.ts` | Vercel Cron job — runs 4:15 PM ET Mon–Fri, snapshots ATM IV for all 21 pillars into `iv_history` table | [Exists] |

#### Strategy / Filtering Logic
| File | Purpose | Status |
| :--- | :--- | :--- |
| `lib/strategy/condor-builder.ts` | Core iron condor construction: finds short legs (~16Δ), finds long legs (~5Δ), calculates symmetric wing widths, applies all strategy filters (IV Rank, min wing width, min credit, credit-to-width ratio), returns `CondorSetup` or null | [Exists] |
| `lib/strategy/iv-rank.ts` | Computes IV Rank percentile from historical snapshots; filters setups when IV Rank < 25% or < 20 days history collected | [Exists] |
| `lib/strategy/filters.ts` | [Planned extraction] Currently: filtering logic is embedded in `condor-builder.ts`. Future refactor will extract to separate module for reusability | [Planned] |

#### Schwab API Client
| File | Purpose | Status |
| :--- | :--- | :--- |
| `lib/schwab/client.ts` | Base HTTP client with Bearer auth, auto-refresh on 401, error handling | [Exists] |
| `lib/schwab/auth.ts` | OAuth token exchange, refresh token flow, expires-at calculation | [Exists] |
| `lib/schwab/chains.ts` | `/chains` endpoint wrapper; finds contracts by delta; structures chain data into `ChainResult` | [Exists] |
| `lib/schwab/quotes.ts` | `/quotes` endpoint wrapper — fetches real-time mark prices | [Exists] |
| `lib/schwab/accounts.ts` | `/accounts/accountNumbers` endpoint wrapper; returns hashed account number | [Exists] |

#### Database / Supabase
| File | Purpose | Status |
| :--- | :--- | :--- |
| `lib/supabase/client.ts` | Neon Postgres client (via `@neondatabase/serverless`); connection pooling; exports `sql` tagged template | [Exists] |

#### Components — Scanner & Grid
| File | Component(s) | Purpose | Status |
| :--- | :--- | :--- | :--- |
| `components/scanner/ScannerCard.tsx` | `ScannerCard`, `LegRow`, `StatusBadge` | Displays one scanner result card per symbol; shows IV rank, condor legs, metrics (credit, wing width, BPR, commission, friction %), filter reasons | [Exists] |
| (inline in ScannerCard.tsx) | Trade setup display | Renders leg table and metrics — not a separate file | [Exists] |
| (inline in ScannerCard.tsx) | Filter failure list | Renders filter rejection reasons — not a separate file | [Exists] |

#### Components — Positions
| File | Component(s) | Purpose | Status |
| :--- | :--- | :--- | :--- |
| `components/positions/PositionsMonitor.tsx` | `PositionsMonitor`, `PositionRow` | Fetches and displays open positions table from `/api/positions` | [Exists] |

#### Shared Types
| File | Purpose | Status |
| :--- | :--- | :--- |
| `types/index.ts` | Shared TypeScript interfaces: `Pillar`, `CondorSetup`, `CondorLeg`, `IVRankResult`, `OptionContract`, `OptionChain`, `ScannerResult`, etc. | [Exists] |

#### Configuration & Build
| File | Purpose | Status |
| :--- | :--- | :--- |
| `tsconfig.json` | TypeScript compiler options | [Exists] |
| `next.config.ts` | Next.js build config | [Exists] |
| `tailwind.config.ts` | Tailwind CSS config | [Exists] |
| `postcss.config.mjs` | PostCSS config | [Exists] |
| `eslint.config.mjs` | ESLint rules | [Exists] |
| `vercel.json` | Vercel deployment config; defines Cron jobs | [Exists] |
| `package.json` | Dependencies, scripts | [Exists] |
| `.env.local` | Runtime secrets: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `CRON_SECRET`, `POSTGRES_URL` | [Exists] |

### Component Architecture Notes

**ScannerCard is a unified component:**  
The tech spec references `TradeSetupTable` and `FilterFailureList` as separate child components, but they are currently rendered inline within [components/scanner/ScannerCard.tsx](components/scanner/ScannerCard.tsx) for simplicity. If the dashboard grows to display these in other contexts, extract them to separate files.

**No filters.ts yet:**  
All strategy filtering (MIN_WING_WIDTH, MIN_CREDIT, credit-to-width ratio, IV Rank checks) lives in [lib/strategy/condor-builder.ts](lib/strategy/condor-builder.ts). A future refactor can extract these to `lib/strategy/filters.ts` for modularity.

**Server Components:**  
Pages are Server Components that fetch data on render. Client-side refresh is driven by the Refresh button, which calls `fetch()` to re-run `/api/scanner` and `/api/positions`. No automatic polling or WebSocket subscriptions.

---

## 4. State Management & Data Fetching

### State Categorization

| State Type | Examples | Where it Lives |
| :--- | :--- | :--- |
| **Server state** | Scanner results, positions, user settings, IV history | Fetched server-side in Server Components; client refresh via `fetch()` calls |
| **Global client state** | None | — (single-user app with no cross-screen shared state) |
| **Local component state** | Cell edit mode, input value during edit, refresh in-progress | `useState` within each component |
| **URL state** | None | — (no filters, pagination, or selected IDs in URL) |
| **Form state** | Ticker symbol input during edit, new cell creation | Local component state with optimistic UI |

### Data Fetching Strategy

| Data | First Fetch | Refresh | Cache | Loading UI | Error UI | Empty UI |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Scanner cells** | Server Component on `/dashboard` mount | Manual via Refresh button | None (always fresh) | Skeleton cards during initial load; per-card spinner during refresh | Per-card error state with retry | "No cells configured — add one with `+`" |
| **Positions** | Server Component on `/dashboard` mount | Manual via Refresh button | None | Skeleton row | Inline error message | `EmptyPositionsState` with explanatory text |
| **User settings** | Server Component on `/dashboard` mount | Optimistic UI on mutation | Local component state until PATCH confirms | None (loaded with page) | Toast on save failure | — (always has default row) |
| **IV history** | Inside `/api/scanner` per-symbol | N/A (computed server-side) | None (fresh each scan) | — | — | "CALIBRATING — X days collected" |

### Why No React Query / SWR

The app has three characteristics that make external state libraries unnecessary:

1. **Single-user, single-tab typical usage.** No multi-tab sync, no realtime updates, no presence indicators.
2. **Manual refresh model.** The operator clicks Refresh when they want fresh data; no automatic polling, no stale-while-revalidate windows.
3. **Mutation count is tiny.** Add/remove/edit a cell happens a few times per week, not per minute. Server Actions handle this cleanly.

If realtime IV updates or multi-user sync become scope (v1.3+), SWR or React Query become reasonable additions at that time.

### Server Actions

The settings mutation uses a Next.js Server Action rather than a traditional client→API fetch pattern:

```typescript
// app/dashboard/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { updateUserSettings } from '@/lib/db/settings';

export async function setTickers(tickers: string[]) {
  await updateUserSettings({ tickers });
  revalidatePath('/dashboard');
}
```

This avoids a separate `/api/settings` PATCH endpoint for the dashboard UI flow (the PATCH endpoint still exists for completeness and for potential future programmatic access).

---

## 5. API Endpoints

### `GET /api/auth/login`
- **Description:** Initiates Schwab OAuth flow.
- **Auth:** None.
- **Request:** No body. No params.
- **Response:** `302` redirect to `https://api.schwabapi.com/v1/oauth/authorize?...` with required params (`response_type=code`, `client_id`, `redirect_uri`, `scope`).
- **Side effects:** None.

### `GET /api/auth/callback`
- **Description:** Receives Schwab auth code, exchanges for tokens, fetches account hash.
- **Auth:** Implicit via OAuth state param.
- **Request params:** `code` (string), `state` (string).
- **Response:** `302` redirect to `/dashboard` on success; HTML error page on failure.
- **Side effects:** 
  - Writes `tokens` table.
  - Calls `GET /accounts/accountNumbers` to fetch hash.
  - Writes `accounts` table.
- **Possible errors:** Invalid auth code (Schwab returns 401 on exchange); state mismatch (CSRF protection); Neon write failure.

### `GET /api/scanner`
- **Description:** Returns scanner results for the configured ticker list.
- **Auth:** Schwab access token (auto-refreshed).
- **Request params (Foundation Patch):** Optional `symbols=SPY,TLT,GLD` — comma-separated. If absent, falls back to `user_settings.tickers`.
- **Response (200):**
  ```typescript
  ScannerCell[]
  ```
- **Possible errors:**
  - `401` — Schwab refresh failed → frontend triggers re-auth flow.
  - `500` — Database connection failure.
- **Side effects:** None (read-only).

### `GET /api/positions`
- **Description:** Returns currently open option positions on the Schwab account.
- **Auth:** Schwab access token.
- **Request:** No params.
- **Response (200):**
  ```typescript
  { positions: Position[]; accountHash: string }
  ```
- **Possible errors:** `401`, `500` (same as scanner).
- **Side effects:** None.

### `GET /api/settings`
- **Description:** Returns the singleton `user_settings` row.
- **Auth:** None.
- **Request:** No params.
- **Response (200):**
  ```typescript
  UserSettings
  ```
- **Side effects:** None.

### `PATCH /api/settings`
- **Description:** Updates the ticker list.
- **Auth:** None.
- **Request body:**
  ```typescript
  { tickers: string[] }
  ```
- **Response (200):** Echoes the updated `UserSettings` row.
- **Validation:**
  - `tickers` array length: 1–10.
  - Each ticker is a non-empty uppercase string ≤ 5 chars.
  - Duplicates rejected.
- **Possible errors:** `400` (validation), `500` (DB).
- **Side effects:** Writes `user_settings` row.

### `GET /api/cron/snapshot-iv`
- **Description:** Daily IV snapshot for all tracked symbols.
- **Auth:** `Authorization: Bearer ${CRON_SECRET}` header.
- **Request:** No params.
- **Response (200):**
  ```typescript
  { snapshotted: number; failed: string[] }
  ```
- **Logic:**
  - Symbol list = union of `user_settings.tickers` and a hardcoded default fallback (so a Foundation Patch deploy can pre-seed the 21-instrument cron list even before v1.2 ships).
  - For each symbol: call `/quotes` to get underlying price + ATM IV. Skip write if `atm_iv <= 0`.
  - Upsert into `iv_history` on conflict `(symbol, date)`.
- **Possible errors:** `401` (missing/wrong cron secret), partial failures returned in `failed` array.
- **Side effects:** Writes 1 row per successful symbol to `iv_history`.

---

## 6. Auth & Permissions Model

### What's in a Session
Sessions are not used. SteelEagle is a single-user, single-instance app. The "session" effectively spans the lifetime of the Schwab refresh token (7 days). When the refresh token expires, the user re-authenticates via the OAuth flow.

### Token Handling
- **Access token (30 min):** Cached in `tokens` table. Auto-refreshed when any Schwab API call returns 401.
- **Refresh token (7 days):** Cached in `tokens` table. When a refresh attempt itself returns 401, the user is prompted to re-authenticate via the OAuth flow.
- **Refresh race condition mitigation:** All refreshes go through a single function (`lib/schwab/auth.ts:getValidAccessToken()`) that handles the case where two parallel requests both encounter an expired token simultaneously.

### Endpoint Permission Matrix

| Endpoint | Public | Schwab Token | Cron Secret |
| :--- | :---: | :---: | :---: |
| `GET /` | ✅ | — | — |
| `GET /dashboard` | ✅ (redirects to `/` if no tokens) | — | — |
| `GET /api/auth/login` | ✅ | — | — |
| `GET /api/auth/callback` | ✅ (implicit OAuth state validation) | — | — |
| `GET /api/scanner` | — | ✅ | — |
| `GET /api/positions` | — | ✅ | — |
| `GET /api/settings` | ✅ | — | — |
| `PATCH /api/settings` | ✅ | — | — |
| `GET /api/cron/snapshot-iv` | — | — | ✅ |

> **Note on `/api/settings`:** Marked "Public" because there is no user-level auth in v1.2. The deployment URL is unguessable in practice, and Schwab gates the meaningful actions (trading, positions). When multi-user becomes scope, this endpoint will need user-level auth.

### Row-Level Permissions
None. All four tables are singletons or globally-readable. No multi-tenant isolation required at v1.2.

---

## 7. Error Handling & Edge Cases

### Edge Case Matrix

| Screen | Action | Edge Case | Handling Strategy |
| :--- | :--- | :--- | :--- |
| Home | Page load | Tokens exist but refresh token expired | Show ReauthBanner with "Reconnect to Schwab" button. |
| Home | Login click | User denies authorization at Schwab | Callback receives `error=access_denied` → error page with retry link. |
| Home | Login click | Network failure during OAuth | Generic error page; user retries. |
| Dashboard | Initial load | No tokens in DB | Redirect to `/`. |
| Dashboard | Initial load | Refresh token expired | Show ReauthBanner inside dashboard; allow scanner to render with stale data if any. |
| Dashboard | Initial load | All symbols in CALIBRATING | Dashboard renders normally; CalibrationBanner explains. |
| Dashboard | Initial load | Neon DB unreachable | Error page with retry; do not attempt to load scanner. |
| Scanner cell | Display | IV history has < 20 days | `status: CALIBRATING`, `daysCalibrated: <n>`, `setup: null`. |
| Scanner cell | Display | Symbol has 0 IV history rows (newly added, cron hasn't run) | `status: NO_DATA`. |
| Scanner cell | Display | `atm_iv <= 0` rows present (after-hours bug) | Filtered out during IV Rank computation; calibration day count unaffected. |
| Scanner cell | Display | Strike grid lacks ~16Δ short | Builder selects nearest available; `setup` populated; condor may have wider/narrower wings; if either wing < $10 → `status: FAIL`, reason: "wing width below $10 minimum". |
| Scanner cell | Display | Strike grid lacks ~5Δ long | Builder snaps long to `short ± targetWidth`; ratio displayed honestly. |
| Scanner cell | Display | Computed credit ≤ 0 | `status: FAIL`, reason: "credit ≤ 0 — no premium available". |
| Scanner cell | Display | Credit < $150 (Foundation Patch) | `status: FAIL`, reason: "credit below $150 minimum on $10 wing". |
| Scanner cell | Display | IV Rank ≤ 25% | `status: FAIL`, reason: "IV Rank below 25% threshold". |
| Scanner cell | Display | Schwab returns invalid symbol | `status: INVALID_SYMBOL`, reason: "Invalid symbol or no options chain available". Settings row still saved. |
| Scanner cell | Display | Mark price is 0 or null on any leg | Display "—" for that leg's mark; credit displayed but flagged as "incomplete pricing". |
| Scanner cell | Edit symbol | New symbol invalid | Card transitions to INVALID_SYMBOL state; user can edit again. |
| Scanner cell | Edit symbol | New symbol duplicates an existing cell | Server Action rejects; toast: "Symbol already configured". |
| Scanner cell | Remove | Removing the last cell | Allowed; dashboard shows empty state + AddCellButton. |
| AddCellButton | Click | Already at 10 cells | Button disabled; tooltip: "Maximum 10 cells". |
| AddCellButton | Click | Settings table write fails | Optimistic UI rolls back; toast: "Failed to save settings". |
| Positions monitor | Display | Account hash not yet fetched | Skeleton/loading state. |
| Positions monitor | Display | Non-iron-condor positions exist | **OPEN QUESTION F8.1** — defer to v1.3. v1.2 either filters or displays generically. |
| Refresh button | Click | Already refreshing | Button disabled during in-flight request. |
| Refresh button | Click | Mid-refresh, refresh token expires | Returns 401 → ReauthBanner appears; refresh button re-enabled. |
| Cron job | Execution | Wrong `CRON_SECRET` | `401` returned; logged in Vercel function logs. |
| Cron job | Execution | Refresh token expired | Single symbol's snapshot fails → `failed` array includes it; cron exits 200 with partial success; logged for manual re-auth. |
| Cron job | Execution | Single symbol fetch fails | Logged in `failed` array; other symbols continue. |
| Cron job | Execution | Cron takes >60s | Vercel kills function; partial results captured in `failed`. Unlikely with 21 symbols and unthrottled GET. |
| OAuth callback | Receive code | `state` param mismatch | Reject with CSRF error page. |
| OAuth callback | Receive code | Code exchange fails (Schwab 401) | Redirect to `/` with error toast. |
| Network | Any API | Schwab API down | `502` to client; toast with "Schwab API unreachable, retry shortly". |

---

## 8. Build Order

Build order is split into already-completed phases (historical, for reference) and pending phases (next sessions).

### ✅ Phase 0 — Foundation (DONE, v1.0 Day 1)
- [S] Schwab Developer Portal app creation
- [S] Vercel + Neon + GitHub project setup
- [S] OAuth flow design

### ✅ Phase 1 — Project Scaffold (DONE, v1.1 Session 2)
- [M] Next.js 15 + TypeScript + Tailwind setup
- [S] Folder structure: `app/`, `lib/schwab/`, `lib/strategy/`, `components/`
- [S] Environment variables wired

### ✅ Phase 2 — Database Schema (DONE)
- [S] `tokens`, `accounts`, `iv_history` tables in Neon

### ✅ Phase 3 — OAuth Flow (DONE)
- [M] `/api/auth/login` + `/api/auth/callback`
- [M] Token store / refresh / retrieve logic in `lib/schwab/auth.ts`
- [S] Account hash discovery

### ✅ Phase 4 — Schwab API Service Layer (DONE)
- [M] `lib/schwab/client.ts` — base fetch wrapper
- [M] `lib/schwab/chains.ts` — option chain fetcher + delta finder + leg builder
- [S] `lib/schwab/quotes.ts` — underlying price quotes
- [S] `lib/schwab/accounts.ts` — positions fetcher

### ✅ Phase 5 — Strategy Engine (DONE)
- [M] `lib/strategy/iv-rank.ts`
- [M] `lib/strategy/condor-builder.ts` (with symmetric wing width logic)
- [S] `lib/strategy/filters.ts`

### ✅ Phase 6 — Scanner Dashboard (DONE)
- [L] Dark trading-terminal UI with IBM Plex Mono + Barlow Condensed
- [M] `ScannerCard` component
- [S] `CalibrationBanner` + `StatusBadge` + header

### ✅ Phase 7 — Daily IV Snapshot Cron (DONE)
- [S] `/api/cron/snapshot-iv` route
- [S] `vercel.json` cron schedule (4:15 PM ET weekdays)
- [S] `CRON_SECRET` protection

### 🔧 Phase 8 — Foundation Patch (NEXT SESSION)
*Goal: align scanner with Strategy v1.4 rules and start IV calibration for the other 18 instruments.*

| Item | Complexity | Blockers |
| :--- | :--- | :--- |
| Extend cron `PILLARS` array to 21 instruments | S | None |
| Deploy updated `condor-builder.ts` with symmetric wings (already written, not pushed) | S | None |
| Delete `app/api/debug/route.ts` | S | None |
| Add `minWingWidth = 10` constant + filter to condor builder | S | None |
| Add dollar-based credit floor ($150) to filter chain | S | Adds a new failure-reason string |
| Add `commissionRoundTrip` + `netCreditAfterCommission` to `CondorSetup` type | S | None |
| Add commission cost display + friction warning badge to `TradeSetupTable` | M | UI work |

**Phase 8 expected duration:** 1 session (2–3 hours). All items are S/M.

### 🔧 Phase 9 — v1.2 Configurable Cells (NEXT-NEXT SESSION)
*Goal: replace the hardcoded 3-pillar grid with a user-configurable cell list.*

| Item | Complexity | Blockers |
| :--- | :--- | :--- |
| Add `user_settings` table to Neon schema | S | None |
| Backfill default row on deploy | S | Idempotent insert |
| Add `lib/db/settings.ts` with `getUserSettings()` + `updateUserSettings()` | S | None |
| Add `/api/settings` GET + PATCH routes | S | Validation logic |
| Modify `/api/scanner` to accept `symbols` query param | S | Backward compat |
| Modify `Dashboard` Server Component to fetch settings before scanner | S | Sequential server fetches |
| Build `AddCellButton` component + max-10 enforcement | S | None |
| Build click-to-edit interaction on `ScannerCard` symbol header | M | useState locally; Server Action to persist |
| Implement remove affordance on cells | S | None |
| Update `ScannerGrid` layout to wrap at 4+ cells (no column compression) | S | Tailwind grid utilities |
| Wire Server Action `setTickers()` for all mutations | M | Need `revalidatePath` after each |
| Update cron `PILLARS` source to be union of defaults + `user_settings.tickers` | S | Cron picks up new tickers within 24h |
| Smoke test add → edit → remove flow end-to-end | M | Manual QA |

**Phase 9 expected duration:** 1 session (3–5 hours). Most items are S; a few M.

### Blocking Dependencies
- Phase 8 → Phase 9: Phase 9 needs Phase 8's `symbols` query param expansion on `/api/scanner` to drive cell-specific fetching. If Phase 8 and 9 are merged, the query param work moves to Phase 9.
- IV calibration clock: cells added via Phase 9 will display CALIBRATING until 20 days of cron snapshots accumulate. This is why Phase 8 (cron expansion) must come first — every day matters.

### Out-of-Phase Deferred Work
- All v1.3 items (BPR tracker, correlation block, position cap, roll alerts, positions monitor enhancements) — see PRD Section 10.
- v1.4 earnings sleeve — see PRD Section 10.
- v2.0 execution layer — see PRD Section 10.

---

## 9. Open Questions Inherited from PRD

These remain unresolved at tech spec time and should be addressed before or during Phase 9 implementation:

- **PRD 11.3** — On an invalid ticker submission, save the row anyway? Recommended: yes; treat the cell as INVALID_SYMBOL until the user edits to a valid ticker.
- **PRD F2.1** — All 21 cron symbols day-of-deploy vs gradual? Recommended: all 21 day-of-deploy.
- **PRD F7.1** — Friction warning at 8% of expected win, or alternative threshold? Recommended: 8% relative threshold.
- **PRD F8.1** — Non-iron-condor positions handling? Deferred to v1.3 — for v1.2, filter them out of the Positions Monitor and log to console for now.

---

## 10. Tech Spec Self-Review

Per the guide's Prompt 16 checklist:

| Check | Status |
| :--- | :--- |
| Anything in the PRD not accounted for in the spec? | ✅ All 12 features mapped to data models / endpoints / phases |
| Internal contradictions? | None identified |
| Build order dependencies clear? | ✅ Phase 8 → Phase 9 explicit |
| Tech stack choices conflict with feature requirements? | None |
| Sections too vague to act on? | Two open questions (F2.1 default behavior, F7.1 exact threshold value) — both have recommended resolutions inline |

---

**End of Tech Spec v1.2**
