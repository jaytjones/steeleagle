# Strategy + SteelEagle — Session 8 Summary

**Date:** June 6, 2026
**Status:** Built the **v1.4 Tactical Earnings Sleeve end-to-end** (scoping Phases A–E) plus the **OAuth stale-hash hardening** deferred from Session 7. Everything is code-complete and gated — **143 tests passing**, `tsc --noEmit` clean. Two of three go-live steps are done (Finnhub key set; `earnings_calendar` created in Neon). v1.4 is the first net-new feature since v1.3.

---

## What Was Accomplished This Session

### 1. v1.4 Tactical Earnings Sleeve — full build
A short-DTE iron-condor sleeve that sells inflated pre-earnings IV and harvests the post-announcement IV crush. Kept deliberately separate from the TOMIC core (different rules, different cadence). Built in this order (see decision below on sequencing):

- **Phase B — five pure strategy modules (+ tests)** under `lib/strategy/`:
  - `earnings-watchlist.ts` — config-as-code tier map (T1×8 / T2×4 / T3×6), `tierOf` / `isTradeable` / `sizeFactorOf` / `maxContractsFor` / `tradeableSymbols`.
  - `expected-move.ts` — EM from the ATM straddle (`computeExpectedMove`, `shortStrikeDistance`).
  - `earnings-entry-window.ts` — ET-aware AMC/BMO/DMH/Friday timing rules (`entryWindow`), `Intl`-based, no tz dependency.
  - `earnings-condor.ts` — separate builder ($5/$10 wings, shorts at 1.25× EM, 25% target, no stop / no $10 floor) + `selectPostEarningsExpiration` sanity-check.
  - `earnings-gate.ts` — fuses tier + crisis + ≤2 concurrent + 3% per-trade + 10% earnings sub-cap + shared 50% cap into one verdict.
- **Phase A — data foundation:**
  - `lib/earnings/finnhub.ts` — provider client; pure `mapSession`/`normalizeFinnhubRow` (tested), per-symbol `getEarningsCalendar`.
  - `earnings_calendar` table (added to `supabase-schema.sql`), `lib/db/earnings.ts` (`upsertEarnings`, `getUpcomingEarnings`).
  - `app/api/cron/snapshot-earnings/route.ts` — 2nd Vercel cron; `vercel.json` updated.
- **Phase C — scanner route:** `app/api/earnings-scanner/route.ts` composing cache → entry window → (within horizon) chain → EM → expiration pick → condor → gate; `lib/schwab/earnings-chain.ts` (near-dated chain + ATM straddle); `lib/earnings/scanner-types.ts` (shared `EarningsScannerCell`).
- **Phase D — UI:** `components/earnings/EarningsCard.tsx` + `EarningsSection.tsx` (separate collapsible section), wired into `app/dashboard/page.tsx`.
- **Phase E — integration:** `detectCoreStop` crisis auto-detect fused with the manual toggle; UI surfaces auto-detection distinctly from the manual switch.

### 2. OAuth stale-hash hardening (Session-7 outage root cause)
- `refreshAccountHash()` in `lib/schwab/accounts.ts` — single source of truth for re-pulling + persisting the hashed account number.
- **Self-healing retry** in `getAccountSnapshot`: on the stale-hash signature (Schwab `200 + empty body`), re-pull the hash once and retry before surfacing the failure.
- **Callback de-silenced** (`app/api/auth/callback/route.ts`): a hash-refresh failure now logs loudly and proceeds (token exchange succeeded; self-heal recovers on first read) instead of silently keeping a stale hash while reporting success.

---

## Key Decisions Made

- **Provider = Finnhub** (free tier). The `hour`/session field populating for upcoming rows was the gating validation — confirmed against a live MSFT sample (`hour:"amc"`, future date, null actuals).
- **Build sequencing: pure modules before data foundation**, deviating from the scoping doc's Phase-A-first. Rationale: no IV-style calibration window means the cache only needs to exist before the scanner route (later); the pure modules are testable now with no creds and match the v1.3 rhythm.
- **Imports:** relative between earnings modules; `@/types` only for shared `OptionContract`/`CondorLeg`. (Verified `tsx --test` resolves `@/` for type-only imports — they erase at runtime — but tested modules still use relative imports for runtime siblings.)
- **Watchlist sizing:** `maxContractsFor` = 1 below $50k equity, 2 above (§8.2); Tier-2 `sizeFactor` = 0.5 (conservative end of "size down 25–50%"), advisory until the account can hold >1 contract.
- **Expected move = the ATM straddle** (the doc's definition), not the 0.85× refinement; safety margin comes from 1.25× short placement instead.
- **Entry window:** AMC → report day; BMO/DMH/UNKNOWN → prior trading day (UNKNOWN/DMH treated as the cautious BMO worst case). Friday-close and weekend-quirk dates roll back to Friday. **Holidays NOT modelled** (weekends only) — flagged as a route-level manual-review case.
- **Earnings condor is a SEPARATE builder** — does not inherit the core's $10 wing floor, 16Δ shorts, 50% target, stop loss, friction check, or credit/width floor. Returns `null` only on structural failure. No post-earnings weekly within 1–7 DTE surfaces as a `BLOCKED` card (the sanity-check April asked for).
- **Gate caps:** earnings ≤2 concurrent (separate from the core 5-slot cap), 3% per-trade, 10% earnings sub-cap, shared 50% total via the existing `preflightAddTrade`. Note: at realistic sizing the ≤2 cap binds well before the 10% sub-cap (2×~$400 ≪ $3000 at $30k); the sub-cap test uses a contrived single $2800 position to exercise the math.
- **Crisis = best-effort:** `crisisActive = manualToggle || detectCoreStop(positions)`. `detectCoreStop` = any open **core** (non-watchlist) spread currently at/over its stop, keyed off `alertFor(p).tone === 'negative'` (reuses `position-alerts.ts`' stop math). Full "core stop happened *this week*" detection needs a trade journal — not available (no trade history stored).
- **`earnings_calendar`:** uuid pk to match `iv_history` (scoping doc sketched `serial`); `confirmed = (epsActual != null)`; reads use `to_char(report_date,'YYYY-MM-DD')` to dodge the `date`→JS-`Date` timezone foot-gun; symbol-array filter via `sql.query(text, [arr])` positional `= ANY($2)`.
- **UI:** separate collapsible section (default open) with a header summary + crisis toggle; the toggle reflects *manual* intent while an `auto: core stop` pill + banner show auto-enforcement when a core stop is detected (you can't un-detect a real stop with the switch). Cards are read-only (watchlist is fixed config).
- **OAuth hardening:** stale-hash detection is a narrow match on `/empty response body/i` so a 401/403 does NOT trigger a hash-refresh loop; coupled to `client.ts::schwabFetch`'s wording (commented).

---

## Key Learnings & Principles (new this session)

- **`tsx --test` resolves the `@/` alias for type-only imports** (they erase at runtime), but it transpiles **without full type-checking** — a closure-mutated `status` passed `tsx --test` yet failed `tsc --noEmit` as a no-overlap comparison. Fix: derive status from boolean flags at the end. `tsc --noEmit` remains the real gate.
- **Use the repo-LOCAL toolchain (`./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`), not `npx --yes`.** `npx --yes` fetches the *latest* tool, which drifts from the lockfile-pinned version in both directions and produces misleading pass/fail (this caused a phantom editor-only TS error and a misread eslint result this session).
- **`react-hooks/set-state-in-effect` (eslint-plugin-react-hooks 7.1.1, pinned)** flags the codebase's entire data-fetch-in-effect idiom — including the pre-existing `fetchData` effect. It is **not deploy-blocking**: Next 16's `next build` doesn't run ESLint as a gate (the live app already ships with the violation). `tsc` + tests are the deploy-relevant gates. Optional fix: downgrade the rule to `warn` in `eslint.config.mjs` if `npm run lint` green is wanted.
- **Editor a11y squiggles (Edge Tools / axe) flag dynamic `aria-expanded={bool}` as invalid** — false positive; React serializes booleans to `"true"`/`"false"` in the DOM. Not part of the lint/build pipeline.
- **Schwab returns `200 + empty body` for a stale/mismatched account hash** (the S7 trap) — now self-healed in `getAccountSnapshot`.
- **`gen_random_uuid()` needs no extension on Neon** (built into Postgres 13+); proven by the existing `iv_history` table.
- **An inline `unique(a,b)` auto-creates a btree index**, so a separate plain `create index` on the same columns is redundant (unlike `iv_history`, whose explicit index is `desc` — a different ordering). `earnings_calendar_symbol_date` duplicates the unique index and can be dropped.

---

## Files Created / Modified

### Created
- `lib/strategy/earnings-watchlist.ts` (+ `.test.ts`)
- `lib/strategy/expected-move.ts` (+ `.test.ts`)
- `lib/strategy/earnings-entry-window.ts` (+ `.test.ts`)
- `lib/strategy/earnings-condor.ts` (+ `.test.ts`)
- `lib/strategy/earnings-gate.ts` (+ `.test.ts`)
- `lib/earnings/finnhub.ts` (+ `.test.ts`)  ← **new folder `lib/earnings/`**
- `lib/earnings/scanner-types.ts`
- `lib/db/earnings.ts`
- `lib/schwab/earnings-chain.ts`
- `app/api/cron/snapshot-earnings/route.ts`  ← **new folder**
- `app/api/earnings-scanner/route.ts`  ← **new folder**
- `components/earnings/EarningsCard.tsx`  ← **new folder `components/earnings/`**
- `components/earnings/EarningsSection.tsx`

### Modified
- `supabase-schema.sql` — added `earnings_calendar`.
- `vercel.json` — added the 2nd cron (`/api/cron/snapshot-earnings`, `0 12 * * 1-5`).
- `app/dashboard/page.tsx` — earnings section + crisis (`crisisManual` / `crisisInfo`) wiring; independent earnings fetch.
- `lib/schwab/accounts.ts` — `refreshAccountHash()` + self-heal retry in `getAccountSnapshot`.
- `app/api/auth/callback/route.ts` — de-silenced hash write (calls `refreshAccountHash`, logs failures; dropped the inline `sql`/`ACCOUNTS_URL`).

---

## Verification

- **`npm test`** (`tsx --test "lib/**/*.test.ts"`): **143 passing** (79 baseline + 64 new: watchlist/EM/entry-window 34, condor/gate 21, finnhub 5, detectCoreStop 4).
- **`tsc --noEmit`** (repo-local, non-test): **clean** (`./node_modules/.bin/tsc --noEmit 2>&1 | grep -v '\.test\.ts'`).
- **ESLint:** new files clean; `app/dashboard/page.tsx` shows the known `react-hooks/set-state-in-effect` on both fetch effects (pre-existing idiom; non-blocking — see learnings).
- **NOT run:** `next build` (no Schwab/Neon env locally). `tsc` + tests are the gate, not a full prod build.
- **Live, by April:** `FINNHUB_API_KEY` set; `earnings_calendar` created in Neon (`\d` output verified correct).

---

## Go-Live Status / Remaining

- **DONE:** Finnhub key set; `earnings_calendar` table created in Neon.
- **To populate now:** hit `/api/cron/snapshot-earnings` with the `CRON_SECRET` bearer, or wait for the next weekday 12:00-UTC cron run. Cells go live once the cache has dates.
- **Optional cleanup:** `drop index if exists earnings_calendar_symbol_date;` (redundant with the unique index).
- **Optional:** downgrade `react-hooks/set-state-in-effect` to `warn` in `eslint.config.mjs` for a green `npm run lint`.
- **Optional:** fix the stale "Run this in: Supabase Dashboard" header comment in `supabase-schema.sql` (it's Neon now).

---

## On the Horizon / Follow-ups

- **Trade journal** — the natural next unlock. It would let crisis enforcement detect a core stop that *already closed this week* (full §8.4, beyond the current best-effort open-stop proxy) and enable per-trade post-mortem / P&L review. (PRD §10 future scope.)
- **Earnings liquidity filter** — the earnings condor deliberately does NOT route through the core's `liquidity.ts`; per-name post-earnings weeklies can be thin (scoping §7.5). A spread-vs-credit check for the earnings builder is a reasonable add.
- **Holiday calendar** in `earnings-entry-window.ts` — currently weekends only; a report the day after a market holiday could name a closed prior day as the entry day. Route-level manual review for now.
- **Backlog (unchanged, PRD §10):** trade placement (~one session: order builder + POST route + confirm modal), custom domain (~15–20 min Vercel config), Beacon design-system adoption decision, security hardening (per-user sessions / Vercel password protection), mobile PWA.
- **Status note:** the 21-instrument IV cron and the roll alert (older horizon items) are already shipped in the repo — likely done, not pending.

---

## Pickup Checklist for Next Session

```
Resuming SteelEagle build.

Last session: June 6, 2026 (Session 8 — built v1.4 Tactical Earnings Sleeve
end-to-end + OAuth stale-hash hardening). v1.4 is code-complete and gated;
Finnhub key + earnings_calendar table are live. Core (v1.3) unchanged.

Dashboard: https://steeleagle.vercel.app
Repo: github.com/jaytjones/steeleagle (public)

Reference documents:
- iron-condor-strategy-version-1_5.md  (operative strategy; §8 = earnings sleeve)
- steeleagle-prd-v1-2.md
- steeleagle-tech-spec-v1-2.md
- steeleagle-v1-4-scoping.md             (earnings sleeve scoping — now BUILT, A–E)
- steeleagle-session-7-summary.md        (v1.3 hardening / UX)
- steeleagle-session-8-summary.md        (this file — v1.4 build)

Confirm clean state (use the REPO-LOCAL toolchain, not npx --yes):
1. npm test  -> expect 143 passing.
2. ./node_modules/.bin/tsc --noEmit 2>&1 | grep -v '\.test\.ts'  -> expect no output.
   (npm test does NOT type-check; tsx --test transpiles without full type-checking.)

Go-live finish (if not already populated):
- POST/GET /api/cron/snapshot-earnings with Authorization: Bearer $CRON_SECRET
  to fill earnings_calendar now, or wait for the weekday 12:00-UTC cron.
- Optional: drop redundant index earnings_calendar_symbol_date.

Candidate next milestones:
- Trade journal (unlocks full crisis enforcement + post-mortem/P&L review).
- Earnings liquidity filter (spread vs credit on the post-earnings weekly).
- Or pull from the PRD §10 backlog (trade placement, custom domain, etc.).
```

---

**End of Session 8 Summary**
