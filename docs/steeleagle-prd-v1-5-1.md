# SteelEagle — Product Requirements Document
**Version:** PRD v1.5.1 (covers everything shipped through the Schwab Position Importer)
**Status:** Consolidated refresh — reverse-engineered from the deployed build + session summaries 2–10
**Last Updated:** June 15, 2026
**Supersedes:** PRD v1.2 (May 16, 2026), which covered only v1.0–v1.2
**Companion Tech Spec:** `steeleagle-tech-spec-v1-5-1.md`

> **About this refresh.** The prior PRD/Tech Spec were v1.2 snapshots and fell four milestones behind the build (v1.3 strategy alignment, v1.4 earnings sleeve, v1.5 trade journal, v1.5.1 importer all shipped without a doc refresh). This document consolidates the current state. The per-session **summary docs** (`steeleagle-session-N-summary.md`) remain the running decision/learning log — this PRD is the current-state reference, not a replacement for that history.

---

## 1. Executive Summary
SteelEagle is a single-user iron condor **scanning, risk-management, and journaling** dashboard for a solo retail options trader running the TOMIC framework. It began (v1.0/1.1) as a read-only scanner that surfaces high-probability condor setups across liquid ETFs with IV Rank, candidate structures, and pass/fail filtering — the data Schwab doesn't expose natively. It has since grown into a full pre-trade and post-trade workbench:

- **v1.2** — user-configurable ticker cells (up to 10).
- **v1.3** — a **Strategy v1.4 alignment layer**: live position reconstruction, BPR utilization tracking, the 5-position + per-pillar caps, entry gating, and 21-DTE / profit-target / stop-loss / roll alerts on open positions.
- **v1.4** — a **Tactical Earnings Sleeve**: a tiered watchlist, Finnhub earnings calendar, expected-move-based short-DTE condor builder, and multi-cap gating with crisis protocol.
- **v1.5** — a roll-aware **Trade Journal** (manual entry; the full iron-condor lifecycle as one logical trade with an append-only event log).
- **v1.5.1** — a **Schwab Position Importer** that bootstraps the journal from open positions + filled-order history under operator confirmation.

Trade **execution** remains manual in Schwab/thinkorswim; SteelEagle is decision-support and record-keeping, not an order router (execution is the v2.0 line).

---

## 2. Problem Statement
The TOMIC framework requires daily verification of many conditions — IV Rank ≥ 25%, 30–45 DTE chains, ~16Δ / ~5Δ strikes, symmetric wings, minimum credit — across an expanding universe (3 → 21 instruments), plus ongoing **position management** (BPR utilization, the 5-position cap, per-pillar concurrency, 21-DTE exits, 50%-profit targets, roll triggers) and a separate **earnings sleeve** with its own rules. Schwab exposes none of this analysis natively and groups nothing into spreads — it returns flat option legs. Doing all of it by hand across thinkorswim/Schwab is slow, repetitive, and error-prone. SteelEagle mechanizes the entry analysis, the risk/position math, the earnings workflow, and the trade record so the operator's time scales with conviction, not clicks.

---

## 3. Target Users

### Primary Persona — The Operator
| Attribute | Detail |
| :--- | :--- |
| **Demographic** | Solo retail options trader, technically proficient |
| **Primary goal** | Surface qualifying TOMIC setups, stay inside the risk envelope, and keep an accurate trade record — without manual chain analysis or spreadsheet bookkeeping |
| **Biggest frustrations** | Schwab doesn't compute IV Rank, doesn't group spreads, doesn't track BPR utilization or 21-DTE deadlines; manual analysis + journaling is slow and inconsistent |
| **Technical comfort** | High — TypeScript, Next.js, OAuth, Postgres, Vercel |
| **Mindset quote** | "My decision-making time should scale with my conviction about a trade, not with my willingness to click through option chains." |

### Secondary Personas
None. SteelEagle is explicitly single-user. Multi-user support is future scope (§10).

---

## 4. Goals & Success Metrics

### Primary Goals
1. **Surface actionable setups consistently** — when conditions warrant, produce clearly-evaluated candidate condors that meet every strategy rule, for both the core and earnings sleeves.
2. **Keep the operator inside the risk envelope** — make BPR utilization, the 5-position / per-pillar caps, and 21-DTE / profit / stop / roll deadlines visible at a glance so no rule is silently violated.
3. **Maintain an accurate trade record** — capture the full lifecycle (entry → rolls → exit) of each condor with derived credit accounting, manually or imported from Schwab.
4. **Reduce decision + bookkeeping time vs. manual analysis.**

### Success Indicators (Qualitative)
- The operator opens SteelEagle as the **first** step of the routine, not a verification step.
- Surfaced trades are accepted at face value without cross-checking IV Rank/strikes elsewhere.
- The operator trusts FAIL / CALIBRATING / BLOCKED / roll / 21-DTE signals and acts on them.
- The journal is the single source of truth for what's open and what each trade earned.

### Open Quantitative Targets
Specific thresholds (qualifying trades/week, review time, action rate) remain deferred until real usage produces a baseline. Revisit in a post-launch retrospective.

---

## 5. Feature List

Status legend:
- **[SHIPPED]** — live in production. Milestone in brackets: `[SHIPPED · v1.3]` etc.
- **[PLANNED]** — see Future Scope (§10).

### Core Scanner (v1.0–v1.2)

#### F1 — Schwab OAuth Authentication [SHIPPED · v1.0]
One-time 3-legged OAuth; access token (30 min) auto-refreshed on 401; refresh token (7 day) drives a re-auth banner; hashed account number cached. Does **not** support multiple Schwab accounts or client-side tokens.

#### F2 — Daily IV History Collection [SHIPPED · v1.0, extended Foundation Patch]
Vercel Cron (`/api/cron/snapshot-iv`, 4:15 PM ET weekdays) writes one ATM-IV row per tracked symbol to `iv_history`. Skips writes when `atm_iv ≤ 0` (after-hours). Tracks the **21-instrument** universe (SPY, QQQ, IWM, DIA, EFA, EEM, TLT, IEF, HYG, LQD, GLD, SLV, USO, DBA, VXX, UVXY, SVXY, UUP, FXY, FXE, FXB). Does **not** backfill history for new symbols.

#### F3 — IV Rank Computation [SHIPPED · v1.0]
`(current_IV − rolling_low) / (rolling_high − rolling_low) × 100` over up to 365 days; ≥20 days required or the cell shows "CALIBRATING — X days." Does **not** use IV Percentile or recency-weighting.

#### F4 — Iron Condor Setup Builder [SHIPPED · v1.0, refined Foundation Patch + v1.3]
Short legs at ~16Δ, longs at ~5Δ, symmetric wings, 30–45 DTE, mid-price credit, BPR = wingWidth − credit. **Minimum $10 wing** enforced; respects strike-grid availability. (v1.3 adds the liquidity filter — F17.) Does **not** suggest asymmetric wings, calendars/diagonals, or place orders.

#### F5 — Strategy Filter Chain [SHIPPED · v1.0, refined Foundation Patch]
IV Rank > 25%, credit/wing ≥ 15%, **credit ≥ $150 on a $10 wing**, credit > 0. Discrete failure reasons per card. Does **not** apply 21-DTE exit logic (that's position management — F16).

#### F6 — Scanner Dashboard UI [SHIPPED · v1.0]
Dark trading-terminal aesthetic (IBM Plex Mono + Barlow Condensed), sticky header with market status + refresh, responsive cell grid.

#### F7 — Trade Setup Cards [SHIPPED · v1.0, extended Foundation Patch + v1.3]
4-leg table (LP/SP/SC/LC: strike, delta, mark, action), credit / wing / ratio / BPR, **commission ($5.20 round-trip) + net-credit-after-commission**, amber friction badge when commission > 8% of the expected 50% win. v1.3 overlays the **entry-gate** strip (F15). Does **not** compute post-tax P&L or breakevens.

#### F8 — Positions Monitor [SHIPPED · v1.0 basic, fully built v1.3]
See F13–F16 — superseded by the v1.3 reconstruction + alerts layer.

#### F9 — Calibration Banner [SHIPPED · v1.0]
Top-of-dashboard banner naming symbols with < 20 days of IV history; non-blocking.

#### F10 — Multi-Pillar Coverage [SHIPPED · Foundation Patch]
All 21 instruments in the IV cron; reachable via `/api/scanner?symbols=…` and the configurable cells.

#### F11 — Configurable Ticker Cells [SHIPPED · v1.2]
Add/remove/edit cells inline (default SPY/TLT/GLD, max 10). Deleted defaults persist. Invalid tickers show an isolated error but still save. Does **not** support reorder or per-ticker strategy variants.

#### F12 — Settings Persistence [SHIPPED · v1.2]
Singleton `user_settings` row (`tickers[]`); scanner accepts a `symbols` param; optimistic UI on every mutation. Does **not** key settings by user (singleton only).

### Strategy v1.4 Alignment Layer (v1.3)

#### F13 — Position Reconstruction [SHIPPED · v1.3]
**User story:** As the operator, I want SteelEagle to turn Schwab's flat option legs back into the spreads I actually hold, so the monitor shows real positions, not a leg soup.
- Parses each leg's 21-char OCC symbol; groups by underlying + expiration; classifies into **IRON_CONDOR** (clean 4-leg), **VERTICAL_SPREAD** (one wing), or **OTHER** (equities/cash/unrecognized, with a diagnostic note).
- Derives BPR the strategy way (`wingWidth − credit`), not Schwab's per-leg maintenance requirement.
- **Does NOT:** auto-split two stacked condors on the same underlying+expiration (rare; surfaced as OTHER).

#### F14 — BPR Utilization Tracker [SHIPPED · v1.3]
**User story:** As the operator, I want to see how much of my buying-power budget is committed before I add a trade.
- Header chip: open BPR as a % of the **50%-of-equity cap**, with a dollar ratio, slot count (`N/5`), and an 80% warning tick. Status OK / WARNING (≥80%) / OVER.
- Per-card pre-flight: adding this candidate → FITS / TIGHT (≥90%) / EXCEEDS.
- Cap denominator = `currentBalances.liquidationValue` from the account snapshot.

#### F15 — Position Limits & Entry Gate [SHIPPED · v1.3]
**User story:** As the operator, I want PASS cards to tell me when I actually *can't* (or shouldn't) add the trade.
- **Global cap:** max 5 concurrent positions (condors + verticals).
- **Per-pillar caps:** Equity block {SPY, QQQ, IWM, DIA, EFA, EEM} max 2; Volatility max 1; Currency max 1; Fixed-income/Commodity no per-pillar cap.
- **Entry gate** fuses position limits + BPR pre-flight into one verdict (OK / TIGHT / BLOCKED) shown on PASS cards with reasons.

#### F16 — Position & Roll Alerts [SHIPPED · v1.3]
**User story:** As the operator, I want the monitor to tell me which open trades need action today.
- Per-position badges: **CLOSE** at ≤ 21 DTE (WATCH at 22–23), **PROFIT** at ≥ 50% of credit, **STOP** at ≤ −2× credit (−1.5× for Volatility). Profit/stop self-suppress when only today's P&L is available (unreliable).
- **Roll alert:** fetches live short-leg deltas via `/quotes`; when one short drifts to |Δ| ≥ 0.30, recommends rolling the untested side toward 30Δ (WATCH at 0.27–0.30; REVIEW when both shorts tested; suppressed after-hours).
- Banner roll-up: "N need action · M to watch · X, Y to roll."

#### F17 — Liquidity Filter [SHIPPED · v1.3]
**User story:** As the operator, I don't want setups whose bid/ask spread eats the credit.
- Fails a setup when total 4-leg spread > **25% of credit**, with reason "spread too wide — X% of credit (max 25%)." Applied to all setups (matters most on thin currency/volatility ETFs).

### Tactical Earnings Sleeve (v1.4)

#### F18 — Tactical Earnings Sleeve [SHIPPED · v1.4]
**User story:** As the operator, I want a separate, rule-isolated workflow for short-DTE post-earnings condors on a vetted watchlist.
- **Watchlist (config-as-code, 12 tradeable):** Tier 1 (AAPL, MSFT, JPM, V, KO, PG, WMT, JNJ — default size); Tier 2 (GOOGL, AMZN, AMD, CRM — sized down 50%, max 1 contract); Tier 3 (TSLA, NVDA, NFLX, META, SNAP, PLTR — **blocked**, never tradeable).
- **Earnings calendar:** per-symbol Finnhub fetch, cached daily (`/api/cron/snapshot-earnings`, 12:00 UTC weekdays, 90-day forward window) into `earnings_calendar` with session (BMO/AMC/DMH/UNKNOWN).
- **Expected move:** ATM straddle (call mid + put mid) of the post-earnings weekly.
- **Earnings condor builder (separate rules, NOT core):** post-earnings weekly 1–7 DTE, shorts at **1.25× expected move**, **$5 wings** (≤ $300 underlying) / **$10** (> $300), **25% profit target**, **no stop loss**.
- **Entry window:** the last trading hour (15:00–16:00 ET) on the day before the report, ET-aware for BMO/AMC/DMH. (Holidays not yet modeled — flagged for manual review.)
- **Multi-cap gate:** tier check + crisis flag + **≤ 2 concurrent earnings** + **3% per-trade** + **10% earnings BPR sub-cap** + the shared **50% total** cap.
- **Crisis protocol:** if the core sleeve took a stop-loss in the last 7 days (exact query against the journal), block earnings entries; a manual crisis toggle is also available.
- **UI:** a separate collapsible "Tactical Earnings" section on the dashboard (cards per name; crisis toggle).
- **Does NOT:** place earnings trades, manage exits, or model market holidays.

### Trade Journal & Importer (v1.5 / v1.5.1)

#### F19 — Trade Journal [SHIPPED · v1.5]
**User story:** As the operator, I want one record per condor that follows it from entry through rolls to exit, with the credit math always correct.
- **One logical trade = the full lifecycle.** A roll is a *mutation* of the trade (updates running totals + current expiration), not a new row. Leg-level detail is an append-only event log (`open` / `close` / `roll_close` / `roll_open`).
- **Net credit is derived** (`total_credit_collected − total_debit_paid`), never stored — stays correct across any number of rolls.
- Standalone `/journal` page: list + open/closed filter, manual 4-leg entry with live net-credit preview, per-trade card with credit accounting, **wing width**, entry legs, roll/close activity timeline, and inline Roll / Close forms.
- Two sleeves (`core` / `earnings`). Server-side zod validation; per-share leg prices → server-derived dollar amounts (client never supplies totals).
- **Does NOT (v1.5):** auto-populate from fills, reconstruct the current post-roll structure as a single 4-leg view (shows entry legs + timeline), or auto-close on profit/DTE.

#### F20 — Schwab Position Importer [SHIPPED · v1.5.1]
**User story:** As the operator, I want to bootstrap the journal from the condors I already hold, instead of re-typing each 4-leg structure.
- Fetches open positions + 90 days of filled orders; groups legs into candidate condors; **matches** each to its originating filled order to recover real per-leg fill prices, open date, and order id (degrades to position-average "marks only" when no match).
- Inline review panel on `/journal`: editable prices, open date, and **BPR** per candidate; matched/marks-only badges; read-only "already in journal" and "incomplete position" sections; per-candidate skip.
- **Operator-confirmed** — nothing imports without review. Confirmed candidates are written via the existing `createTrade` path (matched → `source = 'schwab_fill'` + order id; marks-only → `manual`).
- **Does NOT:** import without confirmation, import partial (< 4-leg) positions, sync continuously (one-time bootstrap), or import non-condors / the earnings sleeve.

---

## 6. User Flows

### Flow 1 — First-Time Login
Home → "Login with Schwab" → Schwab CAG → `/api/auth/callback` exchanges code, writes `tokens`, caches account hash → `/dashboard` (calibration banner on day 0). Failure: denied auth / code exchange / DB write → error page with retry.

### Flow 2 — Daily Morning Scan (primary)
Open `/dashboard` → server fetches settings, scanner, positions, auth status → each cell shows PASS / CALIBRATING / FAIL / NO_DATA, PASS cards overlaid with the entry gate → operator reviews PASS setups against the BPR chip + caps → places qualifying trades manually in Schwab/TOS. The **Positions Monitor** flags 21-DTE / profit / stop / roll actions; the **Earnings** section shows upcoming earnings candidates.

### Flow 3 — Configure Ticker Cells [v1.2]
Add/edit/remove a cell → `PATCH /api/settings` (or the `setTickers` server action) → scanner re-runs for that cell → persists across reloads. Invalid ticker → isolated card error, still saved.

### Flow 4 — Re-Authentication (7-day expiry)
First API call 401 → refresh also 401 → ReauthBanner ("Reconnect to Schwab") → OAuth flow → tokens refreshed.

### Flow 5 — Manage an Open Position [v1.3]
Monitor shows a position at ≤ 21 DTE / 50% profit / tested short → operator acts in Schwab, then records the **Roll** or **Close** in the journal (Flow 7).

### Flow 6 — Earnings Entry [v1.4]
Earnings section shows a Tier 1/2 name inside its entry window with a built post-earnings condor + expected move + gate verdict → operator places it manually in the last hour before the report (if the gate and crisis protocol allow).

### Flow 7 — Journal a Trade [v1.5]
`/journal` → "+ New Trade" → enter symbol/sleeve/expiration/contracts/BPR + 4 legs (per-share prices) → live net-credit preview → save (one `trades` row + four `open` events). Later: inline **Roll** (append roll_close/roll_open, patch totals + current expiration) or **Close** (append close legs, set close_reason/closed_at).

### Flow 8 — Import Open Positions [v1.5.1]
`/journal` → "↓ Import from Schwab" → review candidate condors (edit prices/date/BPR, skip any) → confirm → each writes via `createTrade` → list refreshes with a "N imported (M failed)" result.

---

## 7. Out of Scope (current)
Deferred to Future Scope (§10) or permanent exclusions:
1. **Automated trade execution / order routing.** Manual in Schwab/TOS. (v2.0)
2. **Continuous Schwab → journal sync.** The v1.5.1 importer is a one-time bootstrap; ongoing fill ingestion is v2.0.
3. **Automated exits** (50%-profit / 21-DTE auto-close writing journal events). Schema supports it; not built.
4. **Current-structure (post-roll) reconstruction** in the journal card — shows entry legs + activity timeline.
5. **Native mobile apps.** Responsive web only. (v3.0)
6. **Multi-user support.** Single-user.
7. **Backtest engine; tax/year-end reporting; external alerts (Slack/email/SMS/push); drag-and-drop cell reorder.**
8. **Market-holiday calendar** for the earnings entry window (weekends only today).

---

## 8. Non-Functional Requirements

### Performance
- Initial dashboard load ≤ 3 s cold (excl. OAuth). Scanner refresh ≤ 8 s for ≤ 10 cells. IV cron ≤ 30 s for 21 symbols. The importer makes exactly **1** `/orders` call per session (well inside the 10/min limit).

### Platform
- Desktop browser primary (Chromium/Safari/Firefox). Mobile responsive is a stretch (the dashboard + monitor already adapt to a stacked layout). No offline mode.

### Data Privacy & Security
- Tokens server-side only; cron protected by `CRON_SECRET`; account **hash** (not raw number) persisted; no third-party analytics. **Trade journal data (positions, fills, P&L) is stored in Neon** — this is the one place SteelEagle persists trading activity (it did not in v1.2).

### Authentication
- Schwab OAuth 2.0 (3-legged). Access token 30 min (auto-refresh on 401); refresh token 7 days (manual re-auth). Token endpoint `https://api.schwabapi.com/v1/oauth/token`.

### External APIs
- **Schwab Trader API** (Market Data + Accounts/Trading), OAuth Bearer. GET unthrottled; **order endpoints 10/min/account** (used read-only by the importer). Returns IV=0 after hours.
- **Finnhub** (`/calendar/earnings`), free tier, API key in env — earnings calendar source.

### Infrastructure
- Vercel Hobby + **2 Cron jobs** (snapshot-iv, snapshot-earnings) — at the free-tier limit. Neon Postgres free tier (`@vercel/postgres` / `POSTGRES_URL`). Journal writes use a pooled `db.connect()` client for transactions.

### Regulatory
- No PII beyond Schwab's account hash; no financial advice (informational only); no GDPR/CCPA exposure (single user, US).

---

## 9. Open Questions
- **Journal current-structure view** — should the trade card collapse rolls into the current effective 4 legs, or keep the entry-legs + activity-timeline presentation? (Tracked since v1.5; display-only.)
- **Earnings holiday calendar** — model US market holidays in the entry window, or keep the manual-review caveat?
- **Automated exits** — when (if) to build the 50%-profit / 21-DTE auto-close cron that writes journal `close` events.
- **`user_settings` schema** — the table is live in Neon but not in the committed `supabase-schema.sql`; fold it into the canonical schema file (see Tech Spec §2).

---

## 10. Future Scope (beyond v1.5.1)

### v2.0 — Trade Execution & Continuous Sync
- Confirmation-driven order placement via the Schwab Orders API; order-status tracking; one-tap entry from a scanner/earnings card.
- **Continuous Schwab-fill sync** into the journal (`source = 'schwab_fill'`) — the natural successor to the v1.5.1 one-time importer.
- Automated exit cron (50%-profit / 21-DTE) writing journal `close` events.

### v3.0 — Mobile Native
- iOS/Android apps; push notifications for fills, 21-DTE, refresh-token expiry.

### Future (Unscheduled)
- Multi-user support with auth; backtest engine over stored IV history; per-pillar strategy-variant config; scanner → journal entry-form pre-population; earnings liquidity filter + holiday calendar; journal current-structure reconstruction.

---

**End of PRD v1.5.1**
