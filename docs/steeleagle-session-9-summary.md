# Strategy + SteelEagle — Session 9 Summary

**Date:** June 14, 2026
**Status:** Built the **v1.5 Trade Journal end-to-end** (full vertical slice: schema → DB → API → UI) per the Session 8 Addendum §A2 roll-aware design, and **rewired crisis auto-detect off the journal** (exact closed-trade query, replacing the best-effort open-stop proxy). Code-complete and gated — **149 tests passing** (11 new), `tsc --noEmit` clean on all journal files. Migration SQL run in Neon by April, no issues. The journal is **fully manual** (v1.5 manual-entry phase); automated population is deferred to later milestones.

---

## What Was Accomplished This Session

### 1. v1.5 Trade Journal — full build
A roll-aware journal where **one logical trade = the full iron-condor lifecycle** (entry → rolls → exit), with an append-only leg-level event log. Implements the Addendum §A2 core principle: *a roll is a mutation of an existing position, not a new trade.*

- **Schema (Addendum §A2 verbatim)** — appended to `supabase-schema.sql`:
  - `trades` — one row per logical condor; running credit/debit totals; `initial_expiration` vs. `current_expiration`; `close_reason` enum; status open/closed.
  - `trade_events` — append-only leg log (`open` / `close` / `roll_close` / `roll_open`); includes `source` + `schwab_order_id` **forward-compat columns** for v2.0 fills (no migration needed later).
  - Net credit is **derived, never stored** (`total_credit_collected − total_debit_paid`).
- **Domain + validation** — `lib/journal/types.ts` (read models + zod write-schemas: `NewTradeSchema`, `RollTradeSchema`, `CloseTradeSchema`).
- **Money math (+ tests)** — `lib/journal/trade-math.ts`: `legAmount`, `tally`, `netCredit`, `profitTargetBuyback`, `isAtProfitTarget`, `realizedPnl`. 11 unit tests in `trade-math.test.ts`, including the roll-correctness case.
- **DB layer** — `lib/db/journal.ts`: transactional `createTrade` / `rollTrade` / `closeTrade` (trade + legs never desync), `listTrades` / `getTrade`, and `hadRecentCoreStop(days)` — the exact crisis query.
- **API + actions** — `app/api/journal/route.ts` (GET, with `?status=` filter) and `app/journal/actions.ts` (zod-validated `createTradeAction` / `rollTradeAction` / `closeTradeAction`, returning the refreshed list).
- **UI** — standalone `/journal` page:
  - `app/journal/page.tsx` — list + open/closed filter tabs + new-trade toggle.
  - `components/journal/NewTradeForm.tsx` — manual 4-leg entry with live net-credit preview.
  - `components/journal/TradeCard.tsx` — credit accounting, entry legs, roll/close **Activity** timeline, `N× ROLLED` badge, inline **Roll** and **Close** forms.
  - `components/journal/LegRowsEditor.tsx` — dynamic leg-row editor shared by roll/close.
  - `components/journal/fields.tsx` — dark-theme form primitives.

### 2. Crisis auto-detect rewired onto the journal (full §8.4)
- `app/api/earnings-scanner/route.ts` — `autoCoreStop` now comes from `hadRecentCoreStop(7)` (a **core** `close_reason = 'stop_loss'` within 7 days) instead of `detectCoreStop(positions)`. This is the exact "core stop happened *this week*" signal the open-stop proxy could only approximate. Wrapped in try/catch → falls back to `false` so a journal hiccup can't suppress the whole earnings scan.
- `detectCoreStop` in `lib/strategy/earnings-gate.ts` marked **`@deprecated`** (retained for reference/tests).

### 3. Dashboard discoverability
- `app/dashboard/page.tsx` — added a **📓 Journal** link in the top bar (and the `next/link` import).

---

## Key Decisions Made

- **Scope = full vertical slice** (schema → UI) in one pass, not a foundation-first slice. The whole manual journal is usable today.
- **Standalone entry form, no scanner pre-population.** The Addendum sketched pre-filling the entry form from the scanner card; we deliberately kept the form standalone for v1.5 (operator types symbol/strikes/deltas/prices). No changes to `ScannerCard` / `EarningsCard`. Pre-population is a clean later add.
- **Crisis: REPLACE, not OR.** Chose to swap the proxy entirely for the journal query rather than fuse them. Consequence: until a real `stop_loss` close is logged, `autoCoreStop` stays `false` (the **manual toggle still works** in the interim). An OR-with-proxy transition is a one-line change if the gap matters before trades accumulate.
- **Transactions via `db.connect()`** — create/roll/close wrap their multi-statement writes in `BEGIN`/`COMMIT` on the WebSocket-pooled client. The HTTP `sql` template can't do transactions; this is the first transactional code path in the repo (see learnings).
- **Trade-level totals derived server-side from the legs** — the client submits per-share leg prices + credit/debit direction; the DB layer computes `amount = price × 100 × contracts` and the running totals. A client-supplied amount/total is never trusted.
- **Fully manual intake.** No order/fill ingestion. Every event is hardcoded `source = 'manual'`, `schwab_order_id = null`. Auto-population is a future milestone, not v1.5.
- **Card shows entry legs + activity timeline**, not a reconstructed "current structure." Intentional v1.5 cut — tracked as a follow-up (below).
- **zod for validation** (already a dep) at the action boundary; flattened ZodError → single human-readable message.

---

## Key Learnings & Principles (new this session)

- **`@vercel/postgres` is Neon-native** — it's built on `@neondatabase/serverless`; Vercel Postgres *is* Neon. No driver change needed for Neon. (The Supabase env vars `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` and the `supabase-schema.sql` filename are stale leftovers from a prior Supabase→Neon migration; the live Postgres connection is `POSTGRES_URL` via the Vercel/Neon integration.)
- **Transactions need `db.connect()`, not the `sql` template.** The exported `sql` (HTTP one-shot) can't hold a multi-statement session; `db.connect()` returns a WebSocket-pooled `VercelPoolClient` that supports `BEGIN`/`COMMIT`/`ROLLBACK`. Works on Neon. This is the only path in the repo that does so.
- **node-postgres returns `numeric`/`timestamptz` as strings.** All numeric columns are explicitly `Number(...)`-coerced and timestamps `toIso(...)`-normalized in the row→model mappers (same `to_char(... ,'YYYY-MM-DD')` date trick the earnings module uses to dodge the `date`→JS-`Date` tz foot-gun).
- **A function taking `unknown` is assignable to a prop expecting a concrete type** (param contravariance) — so the server actions typed `(raw: unknown)` pass cleanly into the form props expecting `(input: NewTradeInput) => …`.
- **`tsx` is not a declared dependency.** `npm test` (`tsx --test …`) fails with "command not found" in a clean env; `npx tsx --test "lib/**/*.test.ts"` runs green. Worth adding `tsx` to devDependencies (or keep using `npx tsx`). Consistent with S8's "tsx --test transpiles without full type-checking; `tsc` is the real gate."
- **`react-hooks/set-state-in-effect`** fires on the new `/journal` data-fetch effect exactly as it does on the pre-existing dashboard effects — same non-blocking idiom (see S8 learnings). Matched convention rather than diverging.

---

## Files Created / Modified

### Created
- `lib/journal/types.ts`  ← **new folder `lib/journal/`**
- `lib/journal/trade-math.ts` (+ `.test.ts`)
- `lib/db/journal.ts`
- `app/api/journal/route.ts`  ← **new folder**
- `app/journal/page.tsx` + `app/journal/actions.ts`  ← **new folder**
- `components/journal/NewTradeForm.tsx`  ← **new folder `components/journal/`**
- `components/journal/TradeCard.tsx`
- `components/journal/LegRowsEditor.tsx`
- `components/journal/fields.tsx`

### Modified
- `supabase-schema.sql` — added `trades` + `trade_events` (run in Neon, no issues).
- `app/api/earnings-scanner/route.ts` — `autoCoreStop` now from `hadRecentCoreStop(7)`; dropped the `detectCoreStop` import.
- `lib/strategy/earnings-gate.ts` — `detectCoreStop` marked `@deprecated`.
- `app/dashboard/page.tsx` — 📓 Journal nav link + `next/link` import.

---

## Verification

- **Tests** (`npx tsx --test "lib/**/*.test.ts"`): **149 passing** (138 baseline + 11 new in `trade-math.test.ts`). `npm test` needs `tsx` on PATH — use `npx tsx` (not a declared dep).
- **`tsc --noEmit`:** clean on every journal/earnings/dashboard file. The only errors are **pre-existing & unrelated**: stale `.next/types/*  2.ts` duplicate generated files (the " 2" Finder/sync dupes) and `lib/strategy/roll-alert.test.ts` `allowImportingTsExtensions`.
- **ESLint:** journal `lib`/`components` clean; `app/journal/page.tsx` shows the known non-blocking `react-hooks/set-state-in-effect` (matches the dashboard idiom).
- **Migration:** `trades` + `trade_events` SQL pasted and run in the **Neon** SQL Editor by April — no issues.
- **NOT run:** `next build` (no Schwab/Neon env locally); the transaction path was **not** smoke-tested against the live DB (offered, declined for now).

---

## Go-Live Status / Remaining

- **DONE:** `trades` + `trade_events` created in Neon. `/journal` loads (empty until first entry); `+ New Trade` writes the first rows.
- **Worth doing:** **smoke-test the transaction path** once against Neon (create → roll → close, confirm totals reconcile, delete the test row) — it's the only code path the app hasn't exercised before.
- **Optional cleanup (carried from S8, still open):**
  - Rename `supabase-schema.sql` → `schema.sql` and fix the "Supabase Dashboard" header comment (it's Neon).
  - Drop redundant index `earnings_calendar_symbol_date`.
  - Downgrade `react-hooks/set-state-in-effect` to `warn` for a green `npm run lint`.
  - Add `tsx` to devDependencies so `npm test` runs without `npx`.

---

## On the Horizon / Follow-ups

- **Journal "current structure" reconstruction (TRACKED, new this session).** The data model is fully roll-aware, but the card *display* shows original entry legs + a roll/close activity timeline — it does **not** yet collapse rolls into the current effective 4 legs (latest `roll_open` per leg, falling back to entry). All the data is in `trade_events`; this is a display-only follow-up. **April asked to track this for the future.**
- **Automated exit cron** (Addendum §A3 milestone #2) — close at 50%-profit / 21-DTE without manual intervention; writes `close` events + sets `close_reason`/`closed_at`. The schema already supports this with no migration.
- **Trade placement / v2.0** (Addendum §A3 milestone #3) — one-tap entry from the scanner card; Schwab fills auto-populate the journal as `source = 'schwab_fill'`. A read-only **Schwab-fill importer** (fetch recent option fills → match to open trades → suggest entries to confirm) was floated as a stepping stone.
- **Scanner→journal pre-population** — pre-fill `NewTradeForm` from a `ScannerCard` / `EarningsCard` (the Addendum's original entry-form sketch; deferred from this session's standalone-form decision).
- **Earnings liquidity filter** — spread-vs-credit check on the post-earnings weekly (scoping §7.5; small, do alongside).
- **Holiday calendar** in `earnings-entry-window.ts` — weekends only today.
- **Backlog (PRD §10):** custom domain, security hardening (per-user sessions), mobile PWA.

---

## Pickup Checklist for Next Session

```
Resuming SteelEagle build.

Last session: June 14, 2026 (Session 9 — built v1.5 Trade Journal end-to-end
+ rewired crisis auto-detect onto the journal). Journal is code-complete,
gated, and live in Neon (trades + trade_events created). FULLY MANUAL intake.
Core (v1.3) + earnings sleeve (v1.4) unchanged.

Dashboard: https://steeleagle.vercel.app   (/journal is the new page)
Repo: github.com/jaytjones/steeleagle (public)

Reference documents:
- iron-condor-strategy-version-1_5.md   (operative strategy)
- steeleagle-prd-v1-2.md / steeleagle-tech-spec-v1-2.md
- steeleagle-session-8-summary.md        (v1.4 earnings sleeve)
- steeleagle-session-8-addendum.md       (trade-journal design §A2 — now BUILT)
- steeleagle-session-9-summary.md        (this file — v1.5 journal)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"  -> expect 149 passing.
   (npm test needs tsx on PATH; it's not a declared dep — use npx tsx.)
2. ./node_modules/.bin/tsc --noEmit 2>&1 | grep -v '\.test\.ts' | grep -v '\.next'
   -> expect no journal/app errors (ignore stale ".next/* 2.ts" dupes).

First thing to do:
- Smoke-test the transaction path against Neon: create -> roll -> close one
  trade via /journal, confirm net-credit/totals reconcile, then delete it.
  (db.connect()/BEGIN-COMMIT is the only transactional path in the repo.)

Candidate next milestones:
- Journal current-structure reconstruction (TRACKED display follow-up).
- Automated exit cron (50%-profit / 21-DTE auto-close -> writes close events).
- Trade placement v2.0 (one-tap entry; Schwab fills auto-populate as
  source='schwab_fill') or a read-only Schwab-fill importer as a stepping stone.
- Scanner->journal entry-form pre-population.
```

---

**End of Session 9 Summary**
