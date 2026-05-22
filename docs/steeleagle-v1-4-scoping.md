# SteelEagle — v1.4 Earnings Sleeve: Scoping Pass

**Date:** May 21, 2026
**Status:** Pre-build scoping. Not yet a committed spec — decisions in §7 should be settled first.
**Strategy basis:** `iron-condor-strategy-version-1_5.md` §8 (Tactical Earnings Plays).
**Companion:** picks up after `steeleagle-session-6-summary.md` (v1.3 complete).

---

## 1. Provider Decision

**Recommended: Finnhub** (free tier, earnings calendar, 60 calls/min, JSON, includes a before/after-market session field). It is the only free option carrying the session-timing field this strategy depends on. **FMP** is the paid upgrade (~$20/mo) if confirmed-date reliability proves insufficient. **Alpha Vantage** is excluded — its calendar is date-only (no bmo/amc), which breaks entry timing.

> The entire sleeve hinges on the **bmo/amc session field**. Verification step #1 before building: confirm Finnhub's earnings-calendar `hour` field populates (bmo / amc / dmh) for the Tier-1 names on the free tier.

---

## 2. What v1.4 Needs (distilled from Strategy §8)

1. A **tiered watchlist** — Tier 1 tradeable, Tier 2 sized-down (max 1 contract), Tier 3 blocked.
2. **Upcoming earnings date + session** (bmo/amc) per watchlist name, refreshed daily.
3. **Expected move** from the ATM straddle of the *post-earnings* expiration.
4. A **short-DTE condor builder** distinct from the core: nearest weekly **after** earnings (1–3 DTE), shorts at/just outside the expected move (or 1.25× EM), longs 2–3 strikes out, **$5 wings** ($10 for >$300 names), **25% profit target**, **no stop loss**.
5. **Entry-window logic**: enter the day before earnings in the last hour; AMC on day D → enter D's last hour; BMO on day D → enter D−1's last hour; earnings after Friday close → enter Friday afternoon.
6. **Integration caps** with the core: ≤10% of total BPR for earnings collectively, ≤2 concurrent earnings positions, ≤3% account equity per trade.
7. **Crisis protocol**: skip earnings entries the week the core takes a stop-loss event.
8. **Pre-entry checklist** (§8.4): total BPR ≤50%, earnings BPR ≤10%, ≤2 earnings open, name is Tier 1 / sized-down Tier 2, and the expected-move pricing implies an IV-overstatement opportunity.

---

## 3. Data Model

### New table — earnings calendar cache

A daily-refreshed cache so the dashboard reads fast and we don't hammer the provider. Append/upsert, like `iv_history`.

```sql
create table if not exists earnings_calendar (
  id            serial       primary key,
  symbol        text         not null,
  report_date   date         not null,
  session       text         not null default 'UNKNOWN', -- BMO | AMC | DMH | UNKNOWN
  eps_estimate  numeric(12,4),
  confirmed     boolean      not null default false,
  fetched_at    timestamptz  not null default now(),
  unique (symbol, report_date)
);

create index if not exists earnings_calendar_symbol_date_idx
  on earnings_calendar (symbol, report_date);
```

The scanner reads the **soonest future `report_date` per symbol**. Daily re-pull catches date drift / confirmation (§8.5 warns dates can move or be deferred).

### Watchlist — config-as-code (recommended) vs table

The PRD says "persistent table," but the 12 names + tiers are strategy-defined and rarely change. A constant mirrors the existing `position-limits.ts` pillar-map pattern and is simpler. **Recommend a constant for v1.4**, promote to a table only if UI editing is wanted later (open question §7).

### TypeScript types (domain — not all stored)

```typescript
type EarningsTier = 1 | 2 | 3;
type EarningsSession = 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN';

/** Mirrors the earnings_calendar row. */
type EarningsEvent = {
  symbol: string;
  reportDate: Date;
  session: EarningsSession;
  epsEstimate: number | null;
  confirmed: boolean;
  fetchedAt: Date;
};

type ExpectedMove = {
  symbol: string;
  expiration: Date;          // post-earnings expiration used
  underlyingPrice: number;
  straddlePrice: number;     // ATM call mid + ATM put mid
  expectedMoveAbs: number;   // ≈ straddlePrice
  expectedMovePct: number;   // expectedMoveAbs / underlyingPrice
};

/** Earnings condor — reuses CondorSetup geometry, different rules. */
type EarningsCondorSetup = {
  legs: CondorLeg[];         // same 4-leg shape
  credit: number;
  wingWidth: number;         // $5 standard ($10 for >$300 names) — NOT the core $10 floor
  bpr: number;
  expiration: Date;
  dte: number;               // 1–3
  expectedMove: ExpectedMove;
  shortMoveMultiple: number; // 1.0 (at EM) or 1.25 (safety margin)
  profitTargetPct: 25;       // not 50
  // no stopLoss field — gap risk preempts stops (§8.2)
};

type EarningsStatus =
  | 'NO_EARNINGS_SOON'   // next report outside the entry horizon
  | 'UPCOMING'           // within horizon, not yet entry window
  | 'ENTER_NOW'          // in the entry window, gate clear
  | 'BLOCKED'            // gate failed (BPR / concurrent / crisis)
  | 'TIER3_BLOCKED'      // never tradeable
  | 'NO_DATA';

type EarningsScannerCell = {
  symbol: string;
  tier: EarningsTier;
  nextEarnings: EarningsEvent | null;
  daysUntil: number | null;
  entryWindow: string;       // human label, e.g. "Enter Thu PM (AMC)"
  status: EarningsStatus;
  setup: EarningsCondorSetup | null;
  blockReasons: string[];    // tier3, earnings BPR cap, ≥2 open, crisis protocol
};
```

### Not stored
- **Earnings positions** — no new table. Earnings condors are placed manually in Schwab and read back via `/accounts/{hash}`; `reconstruct-positions.ts` already classifies them as `IRON_CONDOR`. We **identify** an open position as "earnings" by its underlying being a watchlist name (an individual stock, not an ETF pillar). Keeps the "no trade history stored" principle intact.

---

## 4. Module Breakdown

Pure strategy modules mirror the existing six (`lib/strategy/`, each with a companion `.test.ts`).

| Module | Purpose | Pure? |
| :--- | :--- | :--- |
| `lib/strategy/earnings-watchlist.ts` | symbol → tier map; `tierOf()`, `isTradeable()` (Tier 1/2), per-tier sizing (Tier 2 = max 1 contract / size down) | ✅ |
| `lib/strategy/expected-move.ts` | `computeExpectedMove(atmStraddle, underlyingPrice)` → abs + pct | ✅ |
| `lib/strategy/earnings-entry-window.ts` | `entryWindow(reportDate, session, now)` → ENTER_NOW / UPCOMING / PAST + human label; encodes the AMC/BMO/Fri-close timing rules | ✅ |
| `lib/strategy/earnings-condor.ts` | `buildEarningsCondor(chain, expectedMove, tier, opts)` — post-earnings weekly, shorts at/just-outside EM (or 1.25×), $5/$10 wings, longs 2–3 out, 25% target, **no stop, no $10 wing floor** | ✅ |
| `lib/strategy/earnings-gate.ts` | `computeEarningsGate(...)` — fuses tier check + earnings BPR sub-cap (≤10%) + concurrent-earnings cap (≤2) + per-trade equity cap (≤3%) + crisis-protocol into one verdict (analogous to `entry-gate.ts`) | ✅ |

Integration layer (not pure):

| File | Purpose | Status |
| :--- | :--- | :--- |
| `lib/earnings/finnhub.ts` | Provider client — `getEarningsCalendar(symbols, from, to)` → normalized `EarningsEvent[]` (maps Finnhub `hour` → `session`) | new |
| `lib/db/earnings.ts` | `getUpcomingEarnings()`, `upsertEarnings(events)` against `earnings_calendar` | new |
| `app/api/cron/snapshot-earnings/route.ts` | **2nd Vercel cron** (free tier allows 2; 1 used). Daily pull of the watchlist calendar → upsert cache. `CRON_SECRET` protected | new |
| `app/api/earnings-scanner/route.ts` | Builds `EarningsScannerCell[]`: read cache → for names in the entry horizon, fetch chain, compute EM, build condor, run gate | new |
| `components/earnings/EarningsCard.tsx` | One card per watchlist name with upcoming earnings; tier badge, countdown, entry window, EM, setup or block reasons | new |
| `components/earnings/EarningsSection.tsx` | Dashboard section/tab separate from the core scanner grid | new |

Reused: `reconstruct-positions.ts` (identify open earnings positions), `bpr.ts` (shared 50% cap + new ≤10% sub-cap), `lib/schwab/chains.ts` (ATM straddle for EM).

---

## 5. Integration With the Core

- **BPR is shared, with a sub-cap.** Earnings positions count toward the same 50%-of-equity total cap (`bpr.ts`), *and* carry their own ≤10% earnings sub-cap. Extend `bpr.ts` (or `earnings-gate.ts`) to compute earnings-only open BPR separately.
- **Concurrency is separate.** §8.4 says earnings trades don't compete for the core 5-position slots. So the core 5-cap (`position-limits.ts`) is untouched; earnings get their own ≤2 cap in `earnings-gate.ts`.
- **Position classification.** `reconstruct-positions.ts` already returns condors; partition open condors into core vs earnings by `isTradeable(underlying)` / watchlist membership. No schema change.

---

## 6. Build Order

| Phase | Work | Notes |
| :--- | :--- | :--- |
| **A — Data foundation** | `finnhub.ts` client, `earnings_calendar` table, `lib/db/earnings.ts`, `snapshot-earnings` cron | Deploy first so the cache starts filling immediately (no calibration window like IV, but dates need to be present) |
| **B — Pure modules** | `earnings-watchlist`, `expected-move`, `earnings-entry-window`, `earnings-condor`, `earnings-gate` (+ tests) | The testable core; mirrors the v1.3 module rhythm |
| **C — Scanner route** | `earnings-scanner` route wiring B + chains | EM from ATM straddle on post-earnings expiration |
| **D — UI** | `EarningsCard` + `EarningsSection` on the dashboard | Pull the real component patterns before editing (Session 6 lesson) |
| **E — Integration** | gate wired, BPR sub-cap, crisis-protocol (best-effort), position partition | |

---

## 7. Key Risks & Open Questions

1. **bmo/amc field (provider).** Confirm Finnhub's `hour` field populates for Tier-1 names on the free tier. If unreliable → FMP (paid). *This gates everything.*
2. **Crisis protocol can't be fully enforced without a trade journal.** "A core stop-loss event this week" requires knowing about *closed* losing trades — but no trade history is stored (positions are read live). v1.4 can only do **best-effort**: block earnings entries if any core position is *currently* at/over its stop (via `position-alerts.ts`). Full "happened this week" detection needs the trade journal (PRD §10 future scope). **Recommend:** best-effort auto-block + a manual "core stop this week?" acknowledge toggle on the earnings section.
3. **$5 wings collide with the core's $10 minimum.** The Foundation Patch added a hard ≥$10 wing filter to `condor-builder.ts`. The earnings sleeve uses $5 wings, so `earnings-condor.ts` must be a **separate builder** that does not inherit that floor (and a separate friction check — $5 wings fail the core's friction math, but earnings economics are different: 25% target, IV-crush, held 1 day). Do **not** route earnings through the core builder.
4. **Watchlist: constant vs table.** Recommend constant (config-as-code); promote to a table only if UI editing is wanted.
5. **Post-earnings weekly availability.** Confirm a 1–3 DTE weekly expiration exists and is liquid for each name after its report. Most Tier-1 mega-caps have weeklies; verify per name (esp. around holidays).
6. **Where the earnings UI lives.** Separate dashboard section/tab (recommended — different rules, different cadence) vs interleaved with the core scanner.
7. **Confirmed vs estimated dates.** Daily re-pull to catch drift; the entry-window module should treat an unconfirmed/just-moved date cautiously (abort logic from §8.5: if material news breaks before entry, skip).
8. **Sizing & contract count.** Tier 2 is "max 1 contract, size down 25–50%"; Tier 1 default. Encode in `earnings-watchlist.ts` so `earnings-condor.ts` and `earnings-gate.ts` both read one source.

---

## 8. Scope Note

This is a **complement, not a replacement** for the TOMIC core (§8 opening). Expected annual contribution is modest (~$100–250 on $30k per the doc) with real binary tail risk; 5–8% of simulated years go net-negative for the sleeve in isolation. Build it as a clearly-bounded overlay with hard caps, not a second primary engine.

---

**End of v1.4 Scoping Pass**
