# Strategy + SteelEagle — Session 4 Summary

**Date:** May 17, 2026
**Status:** Phase 9 (v1.2 Configurable Cells) shipped to production. v1.3 ready to scope.

---

## What Was Accomplished This Session

A pure build session executing Phase 9 of the SteelEagle tech spec. All 13 items from the Phase 9 build order completed, deployed to https://steeleagle.vercel.app, and end-to-end smoke-tested in production. No strategy doc changes — `iron-condor-strategy-version-1_4.md` from Session 3 remained the operative spec throughout.

Beyond the planned Phase 9 work, the session surfaced and fixed three latent architectural issues that had been waiting to bite:

1. **`lib/supabase/` folder was a holdover from a pre-Neon design**, with all imports going through `@/lib/supabase/client` even though the project uses Vercel Postgres (Neon under the hood). Renamed to `lib/db/` with corresponding import path updates across five files.

2. **`Pillar` type was a literal union of three symbols** (`'SPY' | 'TLT' | 'GLD'`) but used throughout the codebase as a stand-in for arbitrary tickers. Widened to `string` to match runtime reality and accommodate user-configurable cells.

3. **Scanner returned malformed `ScannerResult` objects on error** — just `{symbol, error}` instead of fully-shaped objects. A latent crash waiting for the first invalid ticker; surfaced when the user added "DRT" and the entire dashboard tree unmounted on `r.ivRank.daysOfHistory` (undefined access). Fixed at the source by introducing a `makeErrorResult` helper that synthesizes placeholder values for all required fields.

---

## Phase 9 Build Order — Status

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | `user_settings` table in Neon | ✅ | Singleton pattern with `CHECK (id = 1)` |
| 2 | Backfill default row | ✅ | Idempotent insert; `getUserSettings()` also self-heals if missing |
| 3 | `lib/db/settings.ts` | ✅ | Format validation, dedupe, max-10 enforcement, empty-array allowed |
| 4 | `GET` / `PATCH` `/api/settings` | ✅ | Validation errors return 400; DB errors return 500 |
| 5 | `/api/scanner` accepts `symbols` param | ✅ | Falls back to `user_settings.tickers` when no query param |
| 6 | Dashboard fetches settings before scanner | ✅ | Kept as Client Component (it already was); three endpoints fetched in parallel via `Promise.all` |
| 7 | `AddCellButton` + max-10 enforcement | ✅ | Disabled state with "Max 10 cells" message |
| 8 | Click-to-edit on symbol header | ✅ | Enter commits, Escape cancels, duplicate detection with toast |
| 9 | Remove affordance on cells | ✅ | Hover-revealed × button top-right of each card |
| 10 | Grid wraps at 4+ cells | ✅ | Already free via `grid-cols-3` (fixed col count, no compression) |
| 11 | Server Action `setTickers()` wired | ✅ | Optimistic UI with rollback; powers add/edit/remove flows |
| 12 | Cron `PILLARS` source union | ✅ | Strategic 21-pillar defaults ∪ `user_settings.tickers`, deduped |
| 13 | End-to-end smoke test | ✅ | All flows verified post-deploy |

---

## Bugs & Issues Encountered

### TypeScript errors on `lib/db/settings.ts` (resolved in three iterations)

- **First error:** `Module not found: Can't resolve '@/lib/db/settings'`. The file had been buried in Step 1's instructions and was lost during the folder-rename detour. Created.
- **Second error:** `QueryResult<QueryResultRow>` not assignable to `UserSettingsRow[]`. The initial code assumed `sql` returned rows directly (like Neon's HTTP driver), but `@vercel/postgres` returns the pg-style `{rows, rowCount, fields}` wrapper. Switched to `result.rows` accessor.
- **Third error:** `string[]` not assignable to `Primitive`. `@vercel/postgres` tagged-template literals only accept scalar interpolations — arrays must go through `sql.query(text, [array])`. Switched the array-passing statements to positional parameters.

### DRT crash (resolved with two follow-up fixes)

- **First crash:** Adding "DRT" via the UI 500'd the entire dashboard. Schwab returns 400 for unknown symbols; the scanner caught it but pushed only `{symbol, error}`. The dashboard's calibration banner check (`visibleResults.every(r => r.ivRank.daysOfHistory < 20)`) then crashed on undefined access. Fixed by introducing `makeErrorResult()` in the scanner so every result conforms to the `ScannerResult` shape.
- **Second issue:** After the shape fix, the dashboard rendered cleanly but displayed Schwab's raw JSON error verbatim (`Schwab API error 400: {"errors":[...]}`). Added `translateScannerError()` to translate known error patterns into user-facing copy.

---

## Tech Debt Cleaned Up

### `lib/supabase/` → `lib/db/`

Folder renamed; five import paths updated across:
- `app/api/auth/callback/route.ts`
- `app/api/cron/snapshot-iv/route.ts`
- `lib/schwab/accounts.ts`
- `lib/schwab/auth.ts`
- `lib/strategy/iv-rank.ts`

Build clean post-rename.

### `Pillar` type widened to `string`

The cron route had `const PILLARS: Pillar[] = [21 symbols]` which would have failed strict type-check against the original `'SPY' | 'TLT' | 'GLD'` literal union — somehow passing in production. Widened to `string` to match the v1.2 universe of user-configurable tickers.

### Scanner error contract

All error paths in `/api/scanner` now return fully-shaped `ScannerResult` objects via the `makeErrorResult` helper. Eliminates a class of latent crashes downstream consumers had been silently dodging because SPY/TLT/GLD always returned valid chains. This is the second-time-something-went-wrong shape of issue — worth remembering when designing API contracts: if your types say a field is required, your code needs to deliver it on every code path, including failure paths.

### Graceful error messages

`translateScannerError()` converts raw error strings into user-facing copy before they reach the UI. Recognized patterns:

| Pattern | User-facing message |
|---|---|
| Schwab 400 | Symbol not recognized by Schwab — remove this cell or check spelling |
| Schwab 401 | Schwab session expired — reconnect to refresh data |
| Schwab 429 | Rate limited by Schwab — try again in a moment |
| Other Schwab errors | Schwab market data unavailable — try refreshing |
| Network failures | Network error — check your connection and try again |
| Unknown | Unable to load market data for this symbol |

Raw error detail is still logged to console for debugging.

---

## Files Created or Modified

### Created
- `lib/db/settings.ts` — user settings DB access layer
- `app/api/settings/route.ts` — `GET` and `PATCH` endpoints
- `app/dashboard/actions.ts` — `setTickers()` Server Action
- `components/scanner/AddCellButton.tsx` — `+` tile with max-10 enforcement
- `components/scanner/PendingCell.tsx` — new cell in edit mode

### Modified
- `types/index.ts` — widened `Pillar` to `string`
- `app/api/scanner/route.ts` — `symbols` query param, `makeErrorResult`, `translateScannerError`
- `app/api/cron/snapshot-iv/route.ts` — `PILLARS` = defaults ∪ `user_settings.tickers`
- `app/dashboard/page.tsx` — settings fetch, mutation handlers, grid-driven rendering, skeleton fallback
- `components/scanner/ScannerCard.tsx` — `SymbolHeader` click-to-edit, hover-revealed × remove

### Renamed
- `lib/supabase/` → `lib/db/` (folder) with import path updates in five files

### Database
- New table `user_settings` in Neon (singleton row, `id = 1`, `tickers TEXT[]`, `updated_at TIMESTAMPTZ`)

---

## State of the Deployed System

- **URL:** https://steeleagle.vercel.app
- **Default tickers:** SPY, TLT, GLD (per `user_settings` at session end)
- **IV calibration status:** Days collected per symbol varies — symbols added via the Phase 8 cron extension or via Phase 9 user_settings additions need 20+ trading days before usable IV Rank. Verify with:
  ```sql
  SELECT symbol, COUNT(*) AS snapshots, MAX(snapshot_date) AS latest
  FROM iv_history
  GROUP BY symbol
  ORDER BY symbol;
  ```
- **Cron:** Active, runs 4:15 PM ET weekdays
- **Schwab auth:** Active; refresh token expires every 7 days, user prompts for re-auth as needed
- **Known issues:** None blocking

---

## Decisions: Next Sessions

### v1.3 — Strategy v1.4 Alignment Layer (NEXT)

Per PRD Section 10, v1.3 delivers risk-management awareness the dashboard currently lacks:

- **BPR utilization tracker** — sum open BPR, surface as header chip; warn when adding a new trade would exceed the 50% cap
- **Per-pillar concurrent position constraints:**
  - Volatility pillar: max 1 open at a time
  - Currency pillar: max 1 open at a time
  - Equity block (SPY + QQQ + EFA + EEM combined): max 2 simultaneously
- **5-position concurrent cap enforcement** — block new entries when at cap; warning on scanner cards
- **Positions monitor enhancements** — P&L vs 50% profit target, days-to-21-DTE countdown, 21-DTE close alert
- **Roll alert** — when short delta on an open position is tested (drifts to ~30Δ), surface a roll recommendation for the untested side
- **Liquidity warning** — if bid/ask spread on the constructed condor exceeds 25% of credit, mark FAIL with reason "spread too wide"

These features require parsing live position data from Schwab's `/accounts/{hash}` into typed iron-condor objects, then threading that state through the scanner UI surfaces.

**Expected duration:** 2–3 sessions.

### v1.4 — Earnings Sleeve Scanner (LATER)

Section 8 of the strategy doc (Tactical Earnings Plays) is a distinct workstream:
- Tier 1/2/3 candidate watchlist (AAPL/MSFT/JPM/V/KO/PG/WMT/JNJ Tier 1, GOOGL/AMZN/AMD/CRM Tier 2)
- Earnings calendar integration (third-party API — Schwab doesn't expose this)
- Expected-move computation from at-the-money straddle price
- Short-DTE condor builder (1–3 DTE, 25% profit target, no stop loss)
- Earnings-specific BPR cap (≤10% total; ≤2 simultaneous earnings positions)
- Crisis protocol enforcement

**Expected duration:** 1–2 sessions; depends on earnings calendar API selection.

### Deferred to v2.0+

- Trade execution layer via Schwab Orders API
- Native mobile (iOS / Android)
- Multi-user support
- Backtest engine with historical IV data
- Trade journal

---

## Tech Stack (Unchanged from Session 3)

| Layer | Technology |
|---|---|
| Frontend + Backend | Next.js 16.2.6, TypeScript, Tailwind CSS, Turbopack |
| Database | Neon Postgres via `@vercel/postgres` |
| Hosting | Vercel (Hobby plan, auto-deploys on `git push`) |
| Auth | Schwab OAuth 2.0 (3-legged Authorization Code flow) |
| Cron | Vercel Cron (1 of 2 free jobs used) |
| Fonts | IBM Plex Mono + Barlow Condensed (Google Fonts) |
| Source control | GitHub (jaytjones/steeleagle, public repo) |

---

## Pickup Checklist for Next Session

```
Resuming SteelEagle build.

Last session: May 17, 2026 (Session 4 — Phase 9 / v1.2 Configurable Cells shipped)
Dashboard: https://steeleagle.vercel.app
Repo: github.com/jaytjones/steeleagle

Reference documents:
- iron-condor-strategy-version-1_4.md (strategy spec, unchanged from Session 3)
- steeleagle-prd-v1-2.md (product requirements; v1.3 scope in Section 10)
- steeleagle-tech-spec-v1-2.md (implementation details; Phase 9 build order COMPLETE)
- steeleagle-session-4-summary.md (this file)

Phase 9 / v1.2 status: COMPLETE — all 13 items shipped, smoke-tested in production.

Pre-work for v1.3:
1. Verify cron picked up any custom tickers added during Phase 9 testing:
     SELECT symbol, COUNT(*), MAX(snapshot_date) FROM iv_history GROUP BY symbol;
2. Review Schwab's /accounts/{hash} response shape — what position fields
   are exposed for open iron condors? (BPR per position, current P&L,
   open date, leg detail, etc.)
3. Confirm BPR is reported per-position by Schwab or whether we need to
   derive it from leg max-loss.

v1.3 implementation order (preliminary, refine in session):
1. Position data enrichment — parse /accounts/{hash} into typed iron-condor objects
2. BPR utilization tracker — header chip showing % of cap used
3. 5-position concurrent cap with pre-flight check on scanner cards
4. Per-pillar concurrent position constraints (Vol/Currency = 1, Equity block = 2)
5. Positions monitor enhancements (P&L vs 50%, 21-DTE countdown, alerts)
6. Roll alert when short delta is tested
7. Liquidity warning for tight-spread underlyings

Open questions to resolve early in v1.3:
- Q1: How are partial fills represented in Schwab's positions response?
- Q2: Does the 5-position cap include partially-closed positions still open at one leg?
- Q3: What threshold for "21-DTE close alert" — exactly 21, or 21–23 with grace?
```

---

**End of Session 4 Summary**
