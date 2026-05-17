# Strategy + SteelEagle — Session 3 Summary

**Date:** May 16, 2026
**Status:** Strategy doc finalized at v1.4 · PRD v1.2 and Tech Spec v1.2 produced · Ready for SteelEagle Phase 8 build

---

## What Was Accomplished This Session

A unified working session covering both the trading strategy and the SteelEagle scanning dashboard:

1. **Strategy document evolved through four versions** (1.0 → 1.4), expanding from a 3-pillar Trinity Portfolio to a 5-pillar framework with a complementary tactical earnings sleeve.
2. **Five Monte Carlo simulations** validated parameter choices and surfaced the central economic problem (commission friction) along with its remedy ($10 wings).
3. **SteelEagle gap analysis** identified that the current production build (v1.0/1.1) is several strategy-doc versions behind the spec.
4. **Two new docs reverse-engineered** from the existing SteelEagle build plus the agreed next-session scope: a PRD and a Tech Spec, both following the `jaytjones/app-building-tools` guides.

---

## Strategy Document Evolution (v1.0 → v1.4)

### v1.0 → v1.1: Trinity → Four Pillars
**What changed:** Expanded from 3 pillars (SPY/TLT/GLD) to 4 pillars by adding **Volatility** (VXX, UVXY, SVXY). Added 3–4 instrument alternates within each existing pillar: Equity (QQQ, IWM, DIA), Fixed Income (IEF, HYG, LQD), Commodities (SLV, USO, DBA). Renamed "Trinity Portfolio" to "Four Pillars" and introduced the substitute / supplement distinction for alternates.

**Why:** Diversification across more instruments per pillar gives flexibility when one underlying's IV Rank is below the 25% threshold. Volatility added as a structurally-different fourth pillar with its own risk profile (tighter stops, position-count-based sizing). Added correlation warning for SPY+QQQ (~0.95 correlated — running both is not real diversification).

### v1.1 → v1.2: Five Pillars + Foreign Equities
**What changed:** Added **Currency** as a 5th pillar (UUP, FXY, FXE, FXB). Added EFA and EEM as alternates to the Equity pillar. Expanded the equity correlation warning to cover SPY+QQQ+EFA+EEM as a single "equity-class exposure" block.

**Why:** Currencies are the most genuinely uncorrelated asset class — driven by *relative* central bank policy (Fed vs ECB vs BOJ), structurally independent from equity/bond/commodity risk drivers. FXY in particular is a true safe-haven that often rallies during equity crashes (yen carry trade unwinds). EFA/EEM add some currency exposure and geographic diversification without leaving the equity sleeve entirely.

### v1.2 → v1.3: Commission Friction Defense
**What changed:** Standardized on **$10-wide wings** (previously $5). BPR per trade moved to ~$1,000 (from $500–$1,000 range). Set explicit **5-position concurrent cap**. Removed dollar-based BPR caps on Volatility and Currency pillars; replaced with **position count rules** (max 1 open per pillar at a time). Added new **Section 7: Commission Cost Awareness** with explicit friction math.

**Why:** This is the most consequential version change. Simulation analysis revealed that at $5 wings with $0.65/contract commissions on Schwab/TOS, the strategy is **slightly negative-EV** — commissions consume more than 100% of the per-trade edge over a year. $10 wings dilute friction from 11.5% of each win to 5.8%, restoring positive EV. Everything else in v1.3 cascades from this single insight.

### v1.3 → v1.4: Tactical Earnings Plays
**What changed:** Added **Section 8 — Tactical Earnings Plays** as a complementary sleeve to the TOMIC core. Includes mechanics for short-duration (1–3 DTE) iron condors that exploit IV crush around earnings announcements, a 12-name candidate watchlist organized into 3 tiers, integration rules with the TOMIC core (10% BPR allocation ceiling, max 2 concurrent earnings positions, crisis protocol), and earnings-specific risk notes covering binary event dominance.

**Why:** Earnings condors capture a structurally different volatility phenomenon (acute IV crush) from the monthly TOMIC trades (theta + IV mean reversion). They use different underlyings, different time horizons, and different mechanics. Modest contribution (~$100–250 net annually) but uncorrelated to the core, making them a valid portfolio diversifier.

---

## Key Simulation Findings

### 1. $5 Wings Are Economically Broken at Schwab Commissions
Commissions of $0.65/contract × 8 legs = **$5.20 round-trip per iron condor**. At $5-wide wings producing ~$90 credit, the 50% profit target is +$45 per win — meaning $5.20 friction is **11.5% of each win**. Across the year:

- Per-trade gross EV: +$4.73
- Per-trade commission: -$5.20
- **Net EV per trade: -$0.47**

At 44 trades/year, the strategy goes slightly negative ($9,980–$9,960 median year-end). This was the single most important finding of the session.

### 2. $10 Wings Restore the Edge
Same commission ($5.20), but $10 wings produce ~$180 credit and a $90 win at 50% target. Friction drops to **5.8% of each win**. Net EV per trade goes positive (~$4.25 at 1 trade/week on $10k). Median year-end on $10k account: ~$10,200 (~2% annual return after friction). Modest but real.

### 3. Compounding Doesn't Activate in Year 1
The v1.3 compound scaling rule sets BPR to 5% of current capital with a $1,000 floor. On a $10k account with ~2% annual return, year-end capital sits around $10,200 — well below the $20k threshold where 5%-of-capital exceeds the $1,000 floor. **Compounding effects appear only in years 2+ or at higher starting capital**.

### 4. $30k Account Conservative Mode: Bigger Dollars, Smaller %
At $30k with 5% BPR ($1,500/trade, $15 wings, max 10 positions):
- 2 trades/week: median annual net ~$560 (**1.87%** return after friction)
- 3 trades/week: ~$925 net (3.08% return)

Absolute dollars roughly double the $10k account but **percentage returns drop** because position sizing becomes more conservative as a fraction of capital. The benefit at $30k is **friction efficiency** — commissions drop from 23–33% of gross profits ($10k) to 13–18% ($30k).

### 5. Aggressive Mode (10% BPR) Roughly Triples Returns
At $30k with 10% BPR ($3,000/trade, $30 wings, max 5 positions):
- 2 trades/week: median annual net ~$1,400 (**4.6%** return)
- Single-trade dollar risk doubles ($1,080 max loss vs $540)
- Position diversity drops from 10 to 5 concurrent
- Distribution widens substantially — left tail (10th percentile) gets meaningfully worse

Trade-off: ~3× returns for ~2× per-trade dollar volatility.

### 6. Earnings Sleeve Adds Modest, Uncorrelated Income
Tier 1 candidates only (AAPL, MSFT, JPM, V, KO, PG, WMT, JNJ). Parameters:
- 77% win rate at 25% profit target
- 10% binary max-loss rate (gap moves blow through wings)
- $400 BPR per trade, 12 trades/year (3 per cycle × 4 cycles)
- **Annual net contribution: ~$100–250 on $30k**

About **5–8% of simulated years see 2+ max-loss events**, producing net-negative outcomes for the sleeve in isolation. Combined with TOMIC core, overall account stays positive in those years. Real but small contribution; explicitly *not* a primary return engine.

---

## SteelEagle Coverage Gap Analysis

SteelEagle (deployed at https://steeleagle.vercel.app) was built against Strategy v1.0. The strategy doc has since evolved 4 versions ahead of the implementation:

| Strategy v1.4 Component | SteelEagle Status | Priority |
|---|---|---|
| Five Pillars × 21 instruments (currently 3) | ❌ 3 of 21 | Critical |
| 16Δ shorts / 5Δ longs / symmetric wings | ✅ Built | — |
| IV Rank > 25% filter | ✅ Built | — |
| 30–45 DTE selection | ✅ Built | — |
| **$10-wide wing minimum (v1.3)** | ❌ Not enforced | High |
| **Dollar credit floor ($150 min, v1.3)** | ⚠️ Has % only | High |
| Commission cost surfaced on trade card | ❌ Missing | Medium |
| Correlation block (SPY+QQQ+EFA+EEM = 1 slot) | ❌ Missing | Medium |
| 5-position concurrent cap | ❌ Missing | Medium |
| BPR utilization tracker | ❌ Missing | Medium |
| Vol/Currency "max 1 open" enforcement | ❌ Missing | Medium |
| Positions monitor with DTE / 21-DTE alert / P&L | ⚠️ Empty state | High |
| Roll alert when short delta tested | ❌ Missing | Medium |
| Earnings sleeve scanner (Section 8) | ❌ Missing | Low |

**Critical insight: IV calibration has a real-world clock.** Each new instrument needs **20+ trading days** of cron snapshots before its IV Rank is usable. This clock can't be parallelized away. Adding the 18 new instruments to the snapshot cron immediately is the highest-leverage smallest action.

---

## Decisions: Next Two Sessions

### Phase 8 — Foundation Patch (NEXT SESSION)
**Goal:** Align scanner with Strategy v1.4 rules and start IV calibration for the other 18 instruments.

- Extend cron `PILLARS` array to 21 instruments (immediate IV history collection start)
- Deploy updated `condor-builder.ts` with symmetric wings (written, not yet pushed)
- Delete diagnostic `app/api/debug/route.ts`
- Add `minWingWidth = 10` constant + filter to condor builder
- Add dollar-based credit floor ($150) to filter chain
- Add `commissionRoundTrip` + `netCreditAfterCommission` to `CondorSetup` type
- Add commission cost display + friction warning badge to `TradeSetupTable`

**Expected duration:** 1 session, 2–3 hours.

### Phase 9 — v1.2 Configurable Cells (NEXT-NEXT SESSION)
**Goal:** Replace the hardcoded 3-pillar grid with a user-configurable cell list.

- Add `user_settings` table to Neon schema
- `GET` + `PATCH` `/api/settings` routes
- Modify `/api/scanner` to accept `symbols` query param
- Build `AddCellButton` (+ button after last card, max 10 cells)
- Implement click-to-edit inline on symbol header
- Add close affordance on cells (deleted defaults persist permanently)
- Grid layout wraps to second row at 4+ cells (no column compression)
- Wire Server Action `setTickers()` for all mutations

**Expected duration:** 1 session, 3–5 hours.

### Deferred to v1.3+ (Future Scope)
- BPR utilization tracker and correlation block enforcement
- 5-position concurrent cap with pre-flight check
- Positions monitor enhancements (DTE countdown, P&L vs 50% target, 21-DTE alert)
- Roll alert when short delta is tested
- Liquidity warnings for currency/volatility ETFs
- Earnings sleeve scanner (Section 8) — separate workstream, distinct UI
- Trade execution layer (v2.0)
- Native mobile (v3.0)
- Multi-user support (unscheduled)

---

## Files Produced This Session

1. **`iron-condor-strategy-version-1_4.md`** — Complete strategy specification covering 5 pillars, 21 instruments, commission-friction rules, position count constraints, and the Section 8 Tactical Earnings Plays sleeve.

2. **`steeleagle-prd-v1-2.md`** — Reverse-engineered Product Requirements Document covering current production build (v1.0/1.1) + Foundation Patch + v1.2 Configurable Cells. Captures the v1.4-aligned vision in Section 10 as Future Scope.

3. **`steeleagle-tech-spec-v1-2.md`** — Companion Technical Specification covering tech stack, data models (with TypeScript types and PostgreSQL schema), routes, state management strategy, API contracts, edge case matrix, and build order with complexity estimates.

---

## Tech Stack (Unchanged from Session 2)

| Layer | Technology |
|---|---|
| Frontend + Backend | Next.js 15, TypeScript, Tailwind CSS |
| Database | Neon Postgres (via Vercel integration) |
| Hosting | Vercel (auto-deploys on `git push`) |
| Auth | Schwab OAuth 2.0 (3-legged Authorization Code flow) |
| Cron | Vercel Cron (2 jobs free tier) |
| Fonts | IBM Plex Mono + Barlow Condensed (Google Fonts) |
| Source control | GitHub (private repo) |

---

## Pickup Checklist

```
Resuming SteelEagle build.

Last session: May 16, 2026 (Session 3 — Strategy alignment + PRD/TS produced)
Dashboard: https://steeleagle.vercel.app
Repo: github.com/YOUR_USERNAME/steeleagle

Reference documents:
- iron-condor-strategy-version-1_4.md (the spec)
- steeleagle-prd-v1-2.md (product requirements)
- steeleagle-tech-spec-v1-2.md (implementation details)

Immediate work — Phase 8 Foundation Patch:
1. Extend IV snapshot cron PILLARS array to all 21 instruments
2. Push condor-builder.ts (symmetric wing width fix — written, not deployed)
3. Add minWingWidth=10 constant + filter
4. Add $150 dollar-based credit floor
5. Add commissionRoundTrip to CondorSetup type
6. Add commission cost display + friction warning to TradeSetupTable
7. Delete app/api/debug/route.ts

IV Rank status: 0/20 days collected (calibration clock starts on first Phase 8 deploy)
First cron snapshot of new instruments: First market day after Phase 8 deploy

Open questions to resolve during Phase 8:
- F2.1: All 21 cron symbols day-of-deploy? (Recommended: yes)
- F7.1: Friction warning threshold = 8% of expected win? (Recommended: yes)
```

---

**End of Session 3 Summary**
