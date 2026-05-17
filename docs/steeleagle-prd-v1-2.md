# SteelEagle — Product Requirements Document
**Version:** PRD v1.2 (covers SteelEagle v1.0/1.1 shipped, Foundation Patch, and v1.2 Configurable Cells)
**Status:** Reverse-engineered from deployed build + agreed next-session scope
**Last Updated:** May 16, 2026

---

## 1. Executive Summary
SteelEagle is a personal iron condor scanning dashboard that monitors a configurable list of liquid ETF underlyings for high-probability options trade setups using the TOMIC (The Option Method Insurance Company) framework. The current production version (v1.1) surfaces three pillars (SPY/TLT/GLD) with IV Rank, candidate condor structures, and pass/fail filtering against the strategy rules; the next two milestones extend coverage to five pillars across 21 instruments (Foundation Patch) and make the dashboard's ticker grid user-configurable (v1.2). Trades are executed manually outside the application based on dashboard recommendations.

---

## 2. Problem Statement
The TOMIC framework requires daily verification of multiple conditions — IV Rank ≥ 25%, current option chain at 30–45 DTE, strikes at ~16Δ and ~5Δ, symmetric wing widths, and minimum credit thresholds — across an expanding universe of underlyings (currently 3, growing to 21+). Performing this analysis manually in thinkorswim or Schwab's web interface is repetitive, slow, and error-prone, particularly because Schwab does not expose IV Rank natively and the trader must switch between symbols, expirations, and delta filters to construct each candidate condor.

---

## 3. Target Users

### Primary Persona — The Operator
| Attribute | Detail |
| :--- | :--- |
| **Demographic** | Solo retail options trader, technically proficient, Austin TX |
| **Primary goal** | Surface qualifying TOMIC iron condor setups each morning without manually clicking through option chains |
| **Biggest frustration today** | thinkorswim doesn't compute IV Rank natively; manual chain analysis across multiple underlyings takes 15–30 minutes daily and produces inconsistent results |
| **Technical comfort** | High — comfortable with TypeScript, Next.js, OAuth, Postgres, deploying to Vercel |
| **Mindset quote** | "My decision-making time should scale with my conviction about a trade, not with my willingness to click through option chains." |

### Secondary Personas
None for v1.2. SteelEagle is explicitly a single-user tool. Multi-user support is future scope (see Section 10).

---

## 4. Goals & Success Metrics

### Primary Goals
1. **Surface actionable trade setups consistently.** When market conditions warrant (IV Rank > 25% across at least one pillar), the dashboard produces clearly evaluated candidate condors that meet all strategy rules.
2. **Reduce decision time vs. manual analysis.** The morning review using SteelEagle should be measurably faster than the prior thinkorswim-based workflow.

### Success Indicators (Qualitative)
- The operator opens SteelEagle as the first step of the daily trading routine, not as a verification step after manual analysis.
- Candidate trades surfaced by SteelEagle are accepted at face value without needing to cross-check IV Rank or strike selection in another tool.
- When SteelEagle says "CALIBRATING" or "FAIL," the operator trusts the filter result and moves to the next pillar.

### Open Quantitative Targets
Specific thresholds (e.g., "≥N qualifying trades surfaced per week," "daily review time ≤X minutes," "user acts on ≥X% of surfaced setups") are intentionally deferred until 90 days of real usage produces a baseline. These should be revisited in a post-launch retrospective.

---

## 5. v1 Feature List

Features are marked with status:
- **[SHIPPED]** — In current production deployment (v1.0/1.1)
- **[FOUNDATION PATCH]** — In next session's scope (small backend/frontend changes)
- **[v1.2]** — Configurable cells milestone

### F1 — Schwab OAuth Authentication [SHIPPED]
**User story:** As the operator, I want to authenticate with my Schwab brokerage account once and have the dashboard maintain that connection automatically, so I don't have to manage tokens or re-authenticate during every session.

**Acceptance criteria:**
- Clicking "Login" redirects to Schwab's CAG (Client Authentication Gateway).
- After authorization, the callback exchanges the auth code for access + refresh tokens and stores them in the `tokens` table.
- Access tokens (30-min TTL) are auto-refreshed on every API call that returns 401.
- The hashed account number is fetched once via `/accounts/accountNumbers` and cached in the `accounts` table.
- A user-visible re-auth prompt appears when the refresh token (7-day TTL) expires.

**Edge cases handled:** Token race conditions during concurrent refresh attempts; OAuth state mismatch errors; user denying authorization at Schwab.

**Explicitly does NOT do:** Support multiple Schwab accounts per user; store tokens client-side.

### F2 — Daily IV History Collection [SHIPPED, EXTENDED IN FOUNDATION PATCH]
**User story:** As the operator, I want SteelEagle to build its own historical IV record so it can compute IV Rank, because Schwab's API does not expose historical IV directly.

**Acceptance criteria (current):**
- Vercel Cron triggers `/api/cron/snapshot-iv` at 4:15 PM ET on every market day.
- For each tracked symbol, the cron fetches the ATM IV from the option chain and writes one row to `iv_history` with `(symbol, date, atm_iv, underlying_price)`.
- The cron endpoint is protected by a `CRON_SECRET` bearer token.
- Currently tracks 3 symbols: SPY, TLT, GLD.

**Acceptance criteria (Foundation Patch additions):**
- The tracked symbol list expands to **21 instruments**: SPY, QQQ, IWM, DIA, EFA, EEM, TLT, IEF, HYG, LQD, GLD, SLV, USO, DBA, VXX, UVXY, SVXY, UUP, FXY, FXE, FXB.
- Each new symbol begins its 20+ day calibration window from first snapshot.

**Edge cases handled:** Market-closed days (Schwab returns 0 for IV after hours — skip writes if IV ≤ 0); partial chain fetch failures (log and continue with remaining symbols).

**Explicitly does NOT do:** Backfill historical IV for new symbols (calibration starts fresh per ticker); track intraday IV.

### F3 — IV Rank Computation [SHIPPED]
**User story:** As the operator, I want to see each instrument's current IV expressed as a percentile rank against its own recent history, so I can apply the > 25% TOMIC threshold filter.

**Acceptance criteria:**
- IV Rank is computed as `(current_IV − rolling_low) / (rolling_high − rolling_low) × 100`.
- Rolling window is "up to 365 days" — uses whatever history is available, capped at one year.
- A minimum of 20 days of history is required before an IV Rank value is exposed; below that threshold, the symbol shows "CALIBRATING — X days collected".
- IV Rank is displayed as an integer percentage on each pillar card.

**Edge cases handled:** Symbols with very little or constant IV (returns null, displays "NO DATA"); a single bad outlier snapshot from a corrupt API response (cleaned by ignoring IV ≤ 0).

**Explicitly does NOT do:** Use IV Percentile (a different metric); weight recent data more heavily than older data.

### F4 — Iron Condor Setup Builder [SHIPPED, REFINED IN FOUNDATION PATCH]
**User story:** As the operator, I want SteelEagle to construct a complete 4-leg iron condor for each qualifying pillar, with strikes selected to match the TOMIC framework, so I can place the trade in my broker without re-deriving the strikes.

**Acceptance criteria (current):**
- Short put and short call are placed at the nearest available ~16Δ strikes.
- Ideal long put and long call are independently identified at ~5Δ.
- The narrower of the two natural wing widths is selected as the symmetric wing width, and long strikes are snapped to `short ± targetWidth`.
- Selected expiration is 30–45 DTE (nearest qualifying weekly or monthly).
- Credit is computed as the sum of all four mid-price quotes (short minus long for each side).
- BPR / max loss is computed as `wingWidth - credit`.

**Acceptance criteria (Foundation Patch additions):**
- **Minimum wing width of $10 enforced.** If the natural symmetric wing comes in below $10, the builder rejects the setup and the pillar fails with reason "wing width below $10 minimum."
- Wing width selection respects strike grid availability — if the underlying only offers $5 strike increments, the nearest valid wing ≥ $10 is selected.

**Edge cases handled:** Strike grids that don't contain a clean 16Δ (selects nearest available); illiquid expirations (skip and try the next valid DTE in range); zero or negative computed credit (filters fail with "credit ≤ 0").

**Explicitly does NOT do:** Suggest asymmetric wings; construct calendars, diagonals, or other strategies; place orders.

### F5 — Strategy Filter Chain [SHIPPED, REFINED IN FOUNDATION PATCH]
**User story:** As the operator, I want SteelEagle to mechanically apply all TOMIC entry rules so a trade only shows "PASS" if it meets every condition, eliminating the need for me to double-check.

**Acceptance criteria (current):**
- IV Rank > 25%
- Credit / wing width ≥ 15%
- Computed credit > 0
- Status badge displays PASS / CALIBRATING / FAIL / NO DATA based on filter outcome and data availability.
- Failed filters display the specific failure reason on the trade card.

**Acceptance criteria (Foundation Patch additions):**
- **Dollar-based credit floor added:** credit ≥ $150 on a $10-wide condor (15% of $10 wing = $1.50 per share = $150 per contract). This becomes the binding constraint when the percentage filter would otherwise pass on a sub-economic credit.
- All filter outcomes display as discrete failure reasons (not aggregated).

**Edge cases handled:** Symbols below the 20-day calibration threshold (displays CALIBRATING, skips filter chain); symbols with no data at all (displays NO DATA).

**Explicitly does NOT do:** Apply 21-DTE exit logic (that's position management, not entry filtering); check earnings dates; check correlation with other open positions.

### F6 — Scanner Dashboard UI [SHIPPED]
**User story:** As the operator, I want a single dark-themed dashboard that shows the status of every pillar at a glance, so I can scan all underlyings in seconds.

**Acceptance criteria:**
- Dark trading-terminal aesthetic using IBM Plex Mono + Barlow Condensed fonts.
- Sticky header showing market open/closed status and a manual refresh button.
- 3-column responsive grid (current) of pillar cards.
- Each card shows symbol, current IV, IV Rank, status badge, 4-leg trade setup details, credit, wing width, credit/width ratio, BPR.

**Edge cases handled:** Empty data states; in-progress fetches; mid-stream UI rendering before scripts complete.

**Explicitly does NOT do:** Sort or rank pillars by IV Rank (presentation order is fixed); show historical IV charts; show greeks beyond delta.

### F7 — Trade Setup Cards [SHIPPED, EXTENDED IN FOUNDATION PATCH]
**User story:** As the operator, I want each candidate condor displayed with everything I need to enter it in my broker — strikes, deltas, action, credit, BPR — so I never have to re-derive the trade.

**Acceptance criteria (current):**
- 4-leg table displays LP (long put), SP (short put), SC (short call), LC (long call) with: strike, delta, mark price, action (buy/sell).
- Credit, wing width, credit/width ratio, and BPR/max loss summary line beneath the leg table.
- Filter failure reasons displayed in place of the trade setup when status ≠ PASS.

**Acceptance criteria (Foundation Patch additions):**
- **Commission cost ($5.20 round-trip per contract) displayed on the trade card** with a "Net credit after commission" line.
- A friction warning badge (amber) appears when commission cost exceeds 8% of expected 50%-profit win (i.e., commission > $0.08 × credit × 0.5).

**Edge cases handled:** Missing mark prices (display "—"); stale chain data (refresh button forces re-fetch).

**Explicitly does NOT do:** Calculate post-tax P&L; suggest position sizing; calculate breakeven points.

### F8 — Positions Monitor [SHIPPED — BASIC]
**User story:** As the operator, I want to see my currently open iron condor positions in SteelEagle, so I have a single source of truth for active trades.

**Acceptance criteria (current):**
- Displays an empty state when no open iron condor positions exist.
- Fetches positions from Schwab via `/accounts/{hash}` using the hashed account number.

**Edge cases handled:** Account hash not yet fetched (displays loading state); positions other than iron condors (filtered out or displayed in a secondary list — TBD per Open Questions).

**Explicitly does NOT do:** Calculate P&L vs. 50% profit target (see Future Scope); compute days-to-21-DTE alerts (see Future Scope); suggest roll adjustments.

### F9 — Calibration Banner [SHIPPED]
**User story:** As the operator, I want a clearly visible indication when SteelEagle's IV history is too short to produce reliable IV Rank values, so I know not to trust the filter results yet.

**Acceptance criteria:**
- A banner displays at the top of the dashboard when any tracked instrument has fewer than 20 days of IV history.
- Banner indicates the symbol(s) and days collected.
- Banner does not block the dashboard — pillars with sufficient history continue to display normally.

**Edge cases handled:** Mix of calibrated and calibrating symbols (banner shows only those still calibrating).

**Explicitly does NOT do:** Estimate IV Rank from partial history.

### F10 — Multi-Pillar Coverage [FOUNDATION PATCH]
**User story:** As the operator, I want SteelEagle to scan all 21 instruments across all 5 strategy pillars, so my diversification matches the strategy doc (v1.4) rather than the original Trinity (v1.0).

**Acceptance criteria:**
- All 21 instruments are pushed into the IV snapshot cron immediately (F2 extension).
- Until a corresponding UI surface exists, scanner output for the 18 new instruments is available via direct `/api/scanner?symbols=X,Y,Z` calls.
- Once v1.2 ships, all 21 instruments are available in the configurable cells UI.

**Edge cases handled:** Symbols with no Schwab options chain available (logged, skipped, surfaced as "NO DATA"); symbols with thin liquidity (no special handling at this layer — see Future Scope for liquidity warnings).

**Explicitly does NOT do:** Auto-rotate pillars on/off based on IV Rank; group cards by pillar (a future enhancement).

### F11 — Configurable Ticker Cells [v1.2]
**User story:** As the operator, I want to add, remove, and edit which tickers appear as cells on my dashboard, so I can focus on the pillars that matter today without scrolling through 21 cards.

**Acceptance criteria:**
- Default state on first load is 3 cells (SPY, TLT, GLD) — unchanged from v1.0/1.1.
- User can **add** new cells via a **`+` button placed after the last card** in the grid, up to a maximum of 10 cells. The `+` button is disabled (or hidden) when 10 cells are present.
- User can **delete/close** any cell via a close affordance on each card, including the defaults. **Deleted defaults persist permanently** — they do not auto-restore on re-login. The user re-adds them manually if desired.
- Each cell ticker is editable via **click-to-edit inline on the symbol header**. Clicking the symbol text transforms it into a text input; pressing Enter commits the change and re-runs the scanner for that cell; pressing Escape cancels.
- Invalid/unsupported tickers (no Schwab options chain available) display an error state isolated to that card with the message "Invalid symbol or no options chain available." The settings row is still saved so the operator can correct the ticker.
- **Grid layout wraps to a second row at 4+ cells.** Column count per row stays consistent with the 3-column grid; cells do not compress to smaller widths. With 10 cells, the layout is 3 + 3 + 3 + 1.

**Edge cases handled:** Adding a ticker not currently in the IV snapshot cron (the cron's symbol list is driven by the union of all defaults + `user_settings.tickers`, so newly-added symbols are picked up on the next cron run); concurrent edits from multiple browser tabs (last-write-wins on the singleton `user_settings` row).

**Explicitly does NOT do:** Allow more than 10 cells; support custom strategy variants per ticker (e.g., different DTE per cell); reorder cells (drag-and-drop is future scope).

### F12 — Settings Persistence [v1.2]
**User story:** As the operator, I want my ticker selections to persist across sessions and devices, so I don't have to reconfigure the dashboard every time I open it.

**Acceptance criteria:**
- A new `user_settings` table is added to Neon with at minimum: `tickers text[]`, `updated_at timestamptz`.
- The dashboard fetches settings on initial load and uses the `tickers` array to drive scanner calls.
- The scanner API accepts a `symbols` query param (replacing the hardcoded `PILLARS` array).
- Changes are persisted on every add/remove/edit interaction with optimistic UI.

**Edge cases handled:** Concurrent edits from multiple tabs (last-write-wins); settings table empty on first run (insert default row); migration from hardcoded PILLARS to settings-driven flow (one-time backfill on deploy).

**Explicitly does NOT do:** Multi-user settings keyed by user ID (singleton row pattern only); version history of settings changes; export/import settings.

---

## 6. User Flows

### Flow 1 — First-Time Login (one-time setup)
1. **Trigger:** Operator navigates to https://steeleagle.vercel.app.
2. **Screen:** Home page with "Login with Schwab" button.
3. **Action:** Operator clicks button → redirects to Schwab CAG.
4. **Action:** Operator authenticates with Schwab brokerage credentials.
5. **Action:** Schwab redirects back to `/api/auth/callback` with auth code.
6. **Backend:** Callback exchanges code for tokens, writes to `tokens`, fetches account hash, writes to `accounts`.
7. **Screen:** Redirect to `/dashboard`.
8. **Success state:** Dashboard renders with calibration banner (first-time users have 0 days of IV history).
9. **Failure states:** Operator denies authorization at Schwab → error page with retry link; auth code exchange fails → error page with retry; Neon write fails → error page with admin contact note.

### Flow 2 — Daily Morning Scan (primary use case)
1. **Trigger:** Operator opens SteelEagle (manual navigation, no scheduled prompt).
2. **Screen:** Dashboard loads with cached or freshly-fetched scanner data.
3. **Action:** Backend calls `/api/scanner` which iterates the configured ticker list, calls Schwab `/chains` for each, computes IV Rank, builds candidate condors, applies filters.
4. **Screen:** Each cell displays its result — PASS, CALIBRATING, FAIL, or NO DATA.
5. **Action:** Operator scans the cells. For any PASS, they review the 4-leg setup.
6. **Action:** Operator opens Schwab/TOS in a separate window and manually enters the trade.
7. **Success state:** Operator has placed (or chosen not to place) trades and closes SteelEagle.
8. **Failure states:** Refresh token expired (>7 days since last login) → re-auth prompt on dashboard load; Schwab API unreachable → error toast with retry option; all symbols in CALIBRATING state → dashboard still useful as a "data collection in progress" view.

### Flow 3 — Configure Ticker Cells [v1.2]
1. **Trigger:** Operator wants to add a new pillar to their dashboard view.
2. **Screen:** Dashboard with existing cells.
3. **Action:** Operator clicks the "+" control (TBD per Open Question 11.1).
4. **Screen:** New empty cell appears in edit mode.
5. **Action:** Operator types a ticker symbol (e.g., "QQQ") and confirms.
6. **Backend:** `PATCH /api/settings` writes the new ticker array.
7. **Backend:** Scanner fetches data for the new ticker.
8. **Screen:** New cell populates with PASS/CALIBRATING/FAIL/NO DATA.
9. **Success state:** New cell persists across page reloads and devices.
10. **Failure states:** Invalid ticker (no options chain available) → error state on the new cell only, settings still saved; over 10 cells attempted → control disabled with tooltip.

### Flow 4 — Re-Authentication After 7-Day Refresh Token Expiry
1. **Trigger:** Operator opens SteelEagle after >7 days of inactivity, or after token corruption.
2. **Backend:** First API call returns 401, refresh attempt also returns 401 (refresh token expired).
3. **Screen:** Dashboard displays a re-auth banner with "Reconnect to Schwab" button.
4. **Action:** Operator clicks button → same OAuth flow as Flow 1 (steps 3–7).
5. **Success state:** Tokens refreshed, dashboard reloads with fresh data.
6. **Failure states:** Operator unable to authenticate at Schwab → error page with support note.

### Flow 5 — Calibration Window for New Tickers (initial state on Foundation Patch deploy)
1. **Trigger:** Foundation Patch deploys; 18 new tickers added to IV snapshot cron.
2. **Day 0 → Day 19:** Each new ticker displays "CALIBRATING — X days collected" on its cell (if it has a cell) or via direct scanner API output.
3. **Day 20+:** IV Rank becomes available; cell transitions to PASS or FAIL based on filter chain.
4. **Day 365:** Full 52-week IV history available; IV Rank values reach their long-term accuracy.
5. **Success state:** All 21 instruments cleanly transition through calibration.
6. **Failure states:** A symbol fails IV snapshot for multiple consecutive days (cron logs error, calibration days do not increment, banner shows "STALLED" status).

---

## 7. Out of Scope (v1.2 and Earlier)

Explicitly NOT in scope for the documents below. These are deferred to Future Scope (Section 10) or permanent exclusions.

1. **Automated trade execution.** Trades are placed manually via Schwab/TOS. Deferred to v2.0.
2. **Native mobile applications.** Web-only via Next.js. Mobile responsive design is a stretch goal; native iOS/Android is v3.0.
3. **Multi-user support.** Single-user tool. Multi-user is future scope (no specific version planned).
4. **Earnings condor scanning.** Section 8 of the strategy doc is a separate workstream. Deferred to "Future Scope — Earnings Sleeve."
5. **Position adjustment recommendations.** Roll alerts, defensive adjustments, etc. are deferred to v1.3+.
6. **Backtest engine.** No historical simulation of strategy returns inside the app.
7. **Tax tracking or year-end P&L reporting.** Deferred indefinitely.
8. **External alerts.** No Slack, email, SMS, or push notifications. Dashboard is pull-only.
9. **Drag-and-drop cell reordering.** v1.2 supports add/remove/edit, not reorder.

---

## 8. Non-Functional Requirements

### Performance
- **Initial dashboard load:** ≤3 seconds from cold (excluding OAuth flow).
- **Scanner refresh:** ≤8 seconds for full scan across configured cells (typical: 3–5 cells, max: 10 cells).
- **Cron job duration:** ≤30 seconds for full 21-symbol IV snapshot (Vercel 60-second cron limit on free tier).

### Platform Targets
- **Desktop browser:** Primary target. Chromium-family, Safari, Firefox (modern versions).
- **Mobile responsive:** Stretch goal — dashboard should be usable on a phone but not optimized.
- **Offline:** No offline mode. Always-online tool.

### Data Privacy & Security
- **Tokens stored server-side only.** Never sent to the client.
- **Cron endpoint protected.** `CRON_SECRET` bearer token required.
- **Account hash, not raw account number.** Schwab requires the hashed value for trading endpoints.
- **No third-party analytics, advertising, or trackers.**

### Authentication
- **Schwab OAuth 2.0** (3-legged Authorization Code flow).
- **Access token TTL:** 30 minutes, auto-refreshed on 401.
- **Refresh token TTL:** 7 days, requires manual re-auth via Schwab CAG/LMS.
- **Token endpoint:** `https://api.schwabapi.com/v1/oauth/token`.

### Schwab API Rate Limits
- **Order endpoints:** 10 requests/min/account (per app configuration, well above realistic peak).
- **GET endpoints:** Unthrottled.
- **App approval:** Production environment, "Accounts and Trading Production" + "Market Data Production" subscriptions.

### Infrastructure Constraints
- **Vercel Cron:** 2 jobs free tier (currently using 1).
- **Neon Postgres:** Free tier (sufficient for current data volume).
- **Vercel hobby plan:** Function execution limits apply.

### Regulatory
- **No PII collected** beyond what Schwab returns from `/accounts/accountNumbers`.
- **No financial advice provided.** All output is informational; trade decisions are explicitly the operator's responsibility.
- **No GDPR/CCPA exposure** — single user, single jurisdiction (US).

---

## 9. Open Questions

### v1.2 Design (remaining to resolve before building)
- **11.3** — On an invalid ticker, should the `user_settings` row save the invalid symbol (allowing the user to fix the typo without re-entering)? Suggested: yes, save it; the error state on the card displays "Invalid symbol or no options chain available" until the user edits to a valid one.

### Foundation Patch (resolve during implementation)
- **F2.1** — Does the IV snapshot cron get all 21 symbols added on day-of-deploy, or roll them in gradually? Suggested: all 21 day-of-deploy; calibration runs in parallel.
- **F7.1** — Friction warning threshold: 8% of expected win, or expressed differently (e.g., "commission > $10 alert")? Suggested: 8% — keeps it relative as wing widths and credits scale.

### Positions Monitor (deferred to v1.3)
- **F8.1** — How are non-iron-condor positions handled? Filtered out, displayed as a secondary read-only list, or surfaced with a "not an iron condor" warning?

---

## 10. Future Scope (Beyond v1.2)

These represent the v1.4 strategy-aligned vision and are explicitly captured here to ensure they're not lost. They are NOT in scope for the current PRD but should inform tech spec decisions (data model design, API extensibility, etc.) where possible.

### v1.3 — Strategy v1.4 Alignment Layer
- **BPR utilization tracker.** Display current open BPR as a percentage of the 50% cap; warn when adding a new trade would exceed the cap.
- **Per-pillar concurrent position constraints.** Volatility and Currency pillars enforce max 1 open position at a time; Equity pillar treats SPY/QQQ/EFA/EEM as one block with max 2 simultaneously.
- **5-position concurrent cap enforcement.** Block new entries when at the cap; surface a warning on the scanner cards.
- **Positions monitor enhancements.** P&L vs. 50% profit target, days-to-21-DTE countdown, 21-DTE close alert.
- **Roll alert.** When the short delta on an open position is tested (drifts to ~30Δ), surface a roll recommendation for the untested side.
- **Liquidity warning for currency/volatility ETFs.** If bid/ask spread on the constructed condor exceeds 25% of credit, mark FAIL with reason "spread too wide."

### v1.4 — Earnings Sleeve Scanner (Section 8 of Strategy Doc)
- **Tier 1/2/3 candidate watchlist.** Persistent table with AAPL/MSFT/JPM/V/PG/KO/WMT/JNJ (Tier 1), GOOGL/AMZN/AMD/CRM (Tier 2). Tier 3 explicitly blocked.
- **Earnings calendar integration.** Fetch upcoming earnings dates from a third-party API (Schwab does not expose this — likely Finnhub or similar).
- **Expected-move computation.** Derive from at-the-money straddle price for the post-earnings expiration.
- **Short-DTE condor builder.** 1–3 DTE expirations, 25% profit target (not 50%), no stop loss.
- **Earnings-specific BPR cap.** ≤10% of total BPR for earnings trades; ≤2 simultaneous earnings positions.
- **Crisis protocol enforcement.** If TOMIC core experiences a stop-loss event in the same week, block earnings entries.

### v2.0 — Trade Execution
- Confirmation-driven order placement via Schwab Orders API.
- Order status tracking.
- One-tap trade entry from the dashboard card.

### v3.0 — Mobile Native
- iOS and Android native apps.
- Push notifications for fills, 21-DTE alerts, refresh token expiry.

### Future (Unscheduled)
- Multi-user support with auth (likely Clerk or Supabase Auth).
- Backtest engine with historical IV data.
- Strategy variant configuration per pillar (allow different DTE/delta targets per instrument).
- **Trade journal.** Per-trade notes, post-mortem capture, tagging by setup quality, and retrospective P&L review. Likely paired with the v2.0 execution layer so journal entries can be auto-populated from filled orders.

---

**End of PRD v1.2**
