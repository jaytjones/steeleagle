# SteelEagle — Product Requirements Document
**Version:** PRD v2.3 (covers everything shipped through the v2.3 Cancel GTC milestone)
**Status:** Consolidated refresh — reverse-engineered from the deployed build + session summaries 11–16
**Last Updated:** July 28, 2026 (Session 16)
**Supersedes:** PRD v1.5.1 (June 15, 2026), which covered v1.0–v1.5.1
**Companion Tech Spec:** `steeleagle-tech-spec-v2-3.md`

> **About this refresh.** The v1.5.1 PRD fell six milestones behind: v2.0 (order placement),
> v2.1 (panel editing + logged override), **v2.1.1 (earnings sleeve REMOVED)**, v2.2 (auto-exit
> sweep), v2.2.1 (close hardening + closed-trade edit), and v2.3 (Cancel GTC) all shipped
> without a doc refresh. The single largest correction is v2.1.1: **F18, the Tactical Earnings
> Sleeve, no longer exists** — the prior PRD documents a product surface that has been deleted.
> The per-session **summary docs** remain the running decision log; this PRD is the
> current-state reference.

---

## 1. Executive Summary
SteelEagle is a single-user iron condor **scanning, execution, risk-management, and journaling**
dashboard for one solo retail options trader running the TOMIC framework. It began (v1.0/1.1) as
a read-only scanner and is now a closed loop from candidate to closed trade:

- **v1.2** — user-configurable ticker cells (up to 10).
- **v1.3** — strategy alignment: position reconstruction, BPR utilization, position caps, entry
  gating, 21-DTE / profit / stop / roll alerts.
- **v1.4** — Tactical Earnings Sleeve. **Removed in v2.1.1.**
- **v1.5 / v1.5.1** — roll-aware Trade Journal + Schwab position importer.
- **v2.0** — **order placement**: confirmation-gated 4-leg condor entry through the Schwab
  Orders API, with fills journaled from the real order record.
- **v2.1** — editable strikes in the review step + a high-friction **logged gate override**.
- **v2.1.1** — **earnings sleeve removed** (sleeve enum narrowed to `core`; the second cron slot
  freed and deliberately held open).
- **v2.2** — **automated exit sweep**: the 4:15 cron reconciles filled GTC exits, clears terminal
  orders, alerts at 21 DTE, and places 50%-profit GTC closes. Plus an operator pause toggle.
- **v2.2.1** — **close-form hardening** (the blank-price defect) + **closed-trade edit**.
- **v2.3** — **Cancel GTC** from the Monitor + `currentStructure(events)`, which lifts the
  rolled-trade placement exclusion. *(Deployed 2026-07-28.)*

**The execution line has moved.** SteelEagle now places entry orders and standing profit-target
exits. It does **not** place closing orders — a discretionary or mechanical exit is closed by the
operator in thinkorswim and journaled with **Record Close** (v2.3 §1.2).

---

## 2. Problem Statement
The TOMIC framework requires daily verification of many conditions — IV Rank ≥ 25%, 30–45 DTE
chains, ~16Δ / ~5Δ strikes, symmetric wings, minimum credit — across a **25-instrument** universe,
plus ongoing position management (BPR utilization, the 5-position cap, per-pillar concurrency,
21-DTE exits, 50%-profit targets, roll triggers) and an accurate trade record. Schwab exposes none
of this analysis natively and groups nothing into spreads — it returns flat option legs.

Two problems have been added by success. First, **hand-entering a 4-leg condor in thinkorswim is
itself error-prone**, which v2.0 addresses. Second, **a profit target only pays if someone is
watching** — a 50% target reached at 11:00 AM on a day the operator is busy is a target missed,
which v2.2's standing GTC addresses by placing the order in advance.

---

## 3. Target Users

### Primary Persona — The Operator
| Attribute | Detail |
| :--- | :--- |
| **Demographic** | Solo retail options trader, technically proficient; sole developer AND live trader of this system |
| **Primary goal** | Surface qualifying setups, place them without fat-finger risk, stay inside the risk envelope, and keep an accurate trade record |
| **Biggest frustrations** | Schwab computes no IV Rank, groups no spreads, tracks no BPR utilization or 21-DTE deadlines; manual 4-leg entry is error-prone; profit targets are missed while away from the screen |
| **Technical comfort** | High — TypeScript, Next.js, OAuth, Postgres, Vercel |
| **Mindset quote** | "My decision-making time should scale with my conviction about a trade, not with my willingness to click through option chains." |

### Secondary Personas
None. SteelEagle is explicitly single-user, now behind a session-cookie login (v2.0 auth layer).

---

## 4. Goals & Success Metrics

### Primary Goals
1. **Surface actionable setups consistently.**
2. **Keep the operator inside the risk envelope** — caps, BPR, and deadlines visible at a glance.
3. **Execute without transcription error** — the ticket is rebuilt server-side from validated
   primitives; a client-supplied ticket is never forwarded to Schwab.
4. **Never miss a mechanical exit** — the profit target stands as a live GTC whether or not
   anyone is watching.
5. **Maintain an accurate trade record**, including automatic journaling of exits that fill.

### Success Indicators (Qualitative)
- SteelEagle is the **first** step of the routine, not a verification step.
- Surfaced trades are accepted without cross-checking IV Rank/strikes elsewhere.
- FAIL / CALIBRATING / BLOCKED / roll / 21-DTE signals are trusted and acted on.
- The journal is the single source of truth for what's open and what each trade earned.
- **The operator does not check thinkorswim to find out whether an exit filled** — the sweep
  reports it.

### Open Quantitative Targets
Deferred until real usage produces a baseline. Revisit in a post-launch retrospective.

---

## 5. Feature List

Status legend: **[SHIPPED · vN]** — live in production. **[REMOVED · vN]** — deleted, documented
so the history reads correctly.

### Core Scanner (v1.0–v1.2) — unchanged unless noted
- **F1 — Schwab OAuth Authentication** [SHIPPED · v1.0]. One-time 3-legged OAuth; access token
  (30 min) auto-refreshed on 401; refresh token (7 day) drives a re-auth banner.
- **F2 — Daily IV History Collection** [SHIPPED · v1.0, **universe extended v2.4-Phase-0**].
  `/api/cron/snapshot-iv`, 4:15 PM ET weekdays. Now **25 instruments** — the original 21 ETFs
  plus **XSP, SPX, NDX, RUT**, added 2026-07-28 to start their calibration clock early. Skips
  writes when ATM IV is null. Does **not** backfill history for new symbols.
- **F3 — IV Rank Computation** [SHIPPED · v1.0]. ≥20 days required or "CALIBRATING — X days."
- **F4 — Iron Condor Setup Builder** [SHIPPED · v1.0]. ~16Δ shorts, ~5Δ longs, symmetric wings,
  30–45 DTE, minimum $10 wing.
- **F5 — Strategy Filter Chain** [SHIPPED · v1.0]. IV Rank > 25%, credit/wing ≥ 15%, credit ≥ $150
  on a $10 wing, credit > 0.
- **F6 — Scanner Dashboard UI** [SHIPPED · v1.0].
- **F7 — Trade Setup Cards** [SHIPPED · v1.0, extended v1.3 + v2.0]. Now also the launch point
  for order placement (F21).
- **F9 — Calibration Banner** [SHIPPED · v1.0]. Currently naming XSP/SPX/NDX/RUT.
- **F10 — Multi-Pillar Coverage** [SHIPPED · Foundation Patch, now 25 symbols].
- **F11 — Configurable Ticker Cells** [SHIPPED · v1.2]. Max 10.
- **F12 — Settings Persistence** [SHIPPED · v1.2, extended v2.2]. Singleton `user_settings`;
  now also carries `pause_exit_placement`.

### Strategy Alignment Layer (v1.3) — unchanged
- **F13 — Position Reconstruction** · **F14 — BPR Utilization Tracker** ·
  **F15 — Position Limits & Entry Gate** (5 concurrent; Equity block max 2; Volatility max 1;
  Currency max 1) · **F16 — Position & Roll Alerts** · **F17 — Liquidity Filter** (4-leg spread
  ≤ 25% of credit). All [SHIPPED · v1.3].

### Tactical Earnings Sleeve
- **F18 — Tactical Earnings Sleeve** — **[REMOVED · v2.1.1]**. The watchlist, Finnhub earnings
  calendar, expected-move builder, earnings gate, crisis protocol, `/api/earnings-scanner`,
  `earnings_calendar` table, the `snapshot-earnings` cron, and the earnings UI were **deleted**.
  Zero historical earnings rows existed, so the `trades.sleeve` enum was narrowed to `'core'`
  outright. Freeing the second Vercel cron slot was a deliberate outcome; **that slot is held
  open, not reused**. Finnhub is no longer a dependency.

### Trade Journal & Importer (v1.5 / v1.5.1)
- **F19 — Trade Journal** [SHIPPED · v1.5, hardened v2.2.1]. One logical trade = the full
  lifecycle; a roll mutates the trade rather than creating a row; net credit always derived.
- **F20 — Schwab Position Importer** [SHIPPED · v1.5.1]. Operator-confirmed one-time bootstrap.

### Execution (v2.0 / v2.1)

#### F21 — Confirmation-Gated Order Placement [SHIPPED · v2.0]
**User story:** As the operator, I want to place a scanned condor without re-typing four legs
into thinkorswim.
- `PlaceOrderPanel` on a PASS card: review → confirm → submit. **Nothing auto-submits.**
- The ticket is **rebuilt server-side** by `buildCondorOrder` from zod-validated primitives; a
  client-supplied ticket object is never forwarded. The builder throws on any structural
  violation (strike ordering, credit ≥ narrower wing) — Schwab does not catch these.
- Order status polling and cancel from the panel.
- **Fill → journal:** `recordFillAction` journals only a **fully FILLED** order, reading real
  per-leg fill prices from the order record. Partial fills are refused, never journaled.
- **Does NOT:** place multi-leg structures other than condors, or auto-submit anything.

#### F22 — Panel Leg Editing + Logged Gate Override [SHIPPED · v2.1]
**User story:** As the operator, I want to adjust a strike, and to be able to proceed past a
BLOCKED gate when I judge it right — with the reasoning on the record.
- Editable strikes in the review step with live revalidation; an edited leg **nulls its delta**
  metadata (a stale delta is worse than none).
- Override requires a typed reason (≥ 15 chars), keeps the violation visibly red through the
  whole flow, and **stamps the violated rules verbatim + the reason into the journal notes**.
  The journal record is the point: override outcomes must be reviewable later.
- **Does NOT:** allow overrides of TIGHT gates (already enabled), or edit expirations.

### Automated Exits (v2.2 / v2.2.1 / v2.3)

#### F23 — Auto-Exit Sweep [SHIPPED · v2.2]
**User story:** As the operator, I want my 50% profit target working as a live order, and I want
fills journaled without me.
Folded into the existing 4:15 PM ET cron — **no new cron slot**. Four duties, each try/catch
isolated:
- **(a) Reconcile** — a standing GTC exit reported FILLED is journaled as a `close`
  (`close_reason = 'profit_target'`) with real per-leg fill prices.
- **(a cont.) Clear** — an exit Schwab reports terminal (CANCELED/REJECTED/EXPIRED/REPLACED)
  releases the standing-exit record; the **next** sweep re-places.
- **(b) 21-DTE alert** — **alert-only**, including "cancel standing GTC [id]".
- **(c) Place** — for an eligible open trade with no standing exit and `dte ≥ 24`, place a
  **GTC NET_DEBIT buy-to-close at 50% of journaled net credit**, rounded **down** to a valid tick.
- **Refusal postures:** the sweep acts on fetched Schwab order state, never the bookkeeping
  column; a fetch gap flags rather than clears; a pre-place guard refuses when any working close
  already exists on the same underlying + expiration.
- **Does NOT:** cancel any order, place the 21-DTE close, or auto-stop-loss. **The cron never
  cancels.**

#### F24 — Placement Pause Toggle [SHIPPED · v2.2]
Operator switch (`user_settings.pause_exit_placement`) that suspends **step (c) only**.
Reconcile, clear, and alerts always run; standing GTCs are untouched. Withheld candidates are
reported with the target debit they would have used. Fail-safe: a settings-read failure means
**not paused** — a DB hiccup must never silently disarm exit placement.

#### F25 — Close-Form Hardening [SHIPPED · v2.2.1]
**User story:** As the operator, I want it to be impossible to file a close with prices I didn't
type.
A real corruption (SPY 8/14) filed three `$0.00` close events because the form coerced blank
fields via `Number('') === 0`. Four guards: blank travels as `null`, not `0`; the schema demands
exactly four legs each role once with every price explicit (**$0.00 is legal, blank is not**);
the four rows are fixed with no add/remove; the submit button is dead until the same schema the
server enforces accepts the draft. An expiry is journaled as four `$0.00` legs, with a one-click
fill.

#### F26 — Closed-Trade Edit [SHIPPED · v2.2.1]
**User story:** As the operator, I want to repair a mis-keyed close without writing SQL.
Editable: `close` events with `source='manual'` on a **closed** trade — price, credit/debit
direction, timing — plus trade-level close reason, closed-at, and notes. Never editable: entry
and roll legs (live-data provenance), anything `source='schwab_fill'`, and all structural fields.
Totals are **re-derived from the full event log**, never patched incrementally. One ineligible
leg rolls back the whole edit.

#### F27 — Cancel GTC [SHIPPED · v2.3]
**User story:** As the operator, when I'm closing a position myself, I want to kill the standing
GTC from the same screen — because a forgotten one can re-open a short condor.
- Two-step confirm beside the `GTC @ $X.XX` chip on the Positions Monitor.
- **The app cancels; it does not close.** The operator closes in thinkorswim, then uses
  **Record Close**. This was chosen over a sequenced cancel-then-close: the hazard is the
  dangling GTC, not the typing, and a sequenced action creates a window where the cancel succeeds,
  the close rejects, and the position sits unprotected.
- **The standing-exit record is cleared only on a status Schwab confirms is terminal.** A
  `PENDING_CANCEL` can still fill, so it does not clear; the sweep clears it once confirmed.
- **A FILLED exit is reported as a closed position, not a failed cancel** — with an explicit
  "do NOT close in thinkorswim" instruction, because closing again would open a new position.
- A partial fill refuses outright.

#### F28 — Current-Structure Reconstruction [SHIPPED · v2.3]
`currentStructure(events)` folds the event log into the four legs currently held, so **rolled
trades are no longer excluded from auto-placement**. Placement eligibility is now "can the
structure be reconstructed?", not "is it rolled?" — same-expiration rolls place automatically;
diagonals (a one-sided roll out in time) keep the `MANUAL GTC` chip. The planner gate and the
Monitor chip share one predicate so the chip cannot promise what the sweep won't do.

### Naming contract (v2.3 — do not collapse)
| Control | Where | What it does |
| :--- | :--- | :--- |
| **Cancel GTC** | Positions Monitor | Cancels the standing exit **at Schwab** |
| **Record Close** | Journal card | **Journals** a close that already happened — sends nothing |

---

## 6. User Flows

### Flow 1 — Login
`/login` (session cookie, 30-day TTL, middleware-enforced on every route but `/login` and
`/api/cron/*`) → `/dashboard`. Schwab OAuth is a separate, one-time authorization.

### Flow 2 — Daily Morning Scan (primary)
`/dashboard` → settings/scanner/positions/auth-status → cells show PASS / CALIBRATING / FAIL /
NO_DATA with the entry gate on PASS cards → operator reviews against the BPR chip and caps.

### Flow 3 — Place a Trade [v2.0/v2.1]
PASS card → **Place Order** → review (edit strikes/credit/quantity if needed; override a BLOCKED
gate with a typed reason) → confirm → Schwab order id returned → poll status → on FILL, journal
it from the real order record.

### Flow 4 — Configure Ticker Cells · Flow 5 — Re-Authentication
Unchanged from v1.5.1.

### Flow 6 — The Exit Loop (mostly unattended) [v2.2]
The 4:15 sweep places a 50% GTC once a trade is ≥ 24 DTE and eligible → the GTC stands at Schwab
→ if it fills, the next sweep journals the close automatically → the Monitor chip disappears.
**Standing instruction: when a GTC fills, do not journal by hand — let the sweep do it.**

### Flow 7 — Manage / Exit a Position Manually [v2.3]
Monitor flags 21-DTE / profit / stop / tested-short → **Cancel GTC** (if one stands) → close in
thinkorswim → **Record Close** in the journal. If the GTC turns out to have filled, the app says
so and the sweep journals it instead.

### Flow 8 — Journal a Trade · Flow 9 — Import Open Positions
Unchanged, except the Close form is now the hardened **Record Close** (F25) and closed trades
expose **Edit Close** (F26).

---

## 7. Out of Scope (current)
1. **App-placed closing orders.** Explicitly rejected in v2.3 §1.2 — the app cancels, the operator
   closes. Revisit only with a live fixture for the new order shape.
2. **Any cron-initiated cancellation.** The cron never cancels; 21-DTE is alert-only.
3. **Automated stop-losses.** Manual, per strategy.
4. **At-fill exit placement** (placing the GTC the moment an entry fills) — a fast-follow gated
   on the first real entry fill validating `recordFillAction`.
5. **Intraday sweeps.** Vercel Hobby allows one run/day per job; the second slot is held open.
6. **Diagonal / multi-expiration exits.** `currentStructure` refuses them; they stay manual.
7. **Roll-event editing.** Editing a `roll_close` on an open trade would desync a standing GTC.
8. **Continuous Schwab → journal sync**, native mobile, multi-user, backtesting, tax reporting,
   external alerts.

---

## 8. Non-Functional Requirements

### Performance
- Dashboard load ≤ 3 s cold. Scanner refresh ≤ 8 s for ≤ 10 cells. The 4:15 cron covers **25
  symbols** plus the exit sweep in one invocation.
- **Order endpoints are throttled 10/min/account.** The sweep makes **one wholesale
  working+recent orders fetch per run** and matches locally, rather than polling per trade.

### Platform
Desktop browser primary; the dashboard and monitor adapt to a stacked mobile layout. No offline mode.

### Data Privacy & Security
- Tokens server-side only; account **hash** persisted, never the raw number; no third-party
  analytics. Trade journal data (positions, fills, P&L) is stored in Neon.
- **App-level auth (v2.0):** signed session cookie, 30-day TTL, enforced by middleware on every
  route except `/login` and `/api/cron/*` (which authenticate via `CRON_SECRET`).
- `CRON_SECRET` is a Vercel **Sensitive** variable — unreadable after creation.

### External APIs
- **Schwab Trader API** — Market Data + Accounts/Trading. GET unthrottled; **order endpoints
  10/min/account**; IV=0 after hours; positions are flat legs without reliable strike/expiration
  fields (parse the OCC symbol). Index symbols require the `$` prefix on `/chains` and `/quotes`.
- **Finnhub — removed** with the earnings sleeve (v2.1.1).

### Infrastructure
Vercel Hobby, **1 of 2 cron slots used** (the free slot is deliberately held open). Neon Postgres
via `@vercel/postgres`; transactional journal writes through a pooled client.

### Regulatory
No PII beyond Schwab's account hash; informational only, not financial advice; single US user.

---

## 9. Open Questions
- **Sub-$1 4dp NET_DEBIT acceptance** — sub-$1 exit targets format to 4 decimal places; whether
  Schwab accepts that on penny-increment options is unverified until the first sub-$1 placement.
- ~~**Roll-form explicit prices**~~ — **CLOSED, shipped v2.3.1 (2026-07-30).** Blank now travels
  as `null` via `RollTradeDraft`; `RollTradeSchema` demands every price explicitly ($0.00 legal,
  blank not) and enforces the roll-leg invariant; `rollTradeAction` returns `ActionResult<T>`.
  **v2.3.2 (2026-07-31)** then closed the same defect class on the ENTRY form — the last of the
  three journal write paths, and the highest-stakes one, since a $0.00 entry leg propagates
  through `netCredit` into `profitTargetBuyback`, which is the price the sweep places the standing
  GTC at.
- **`atm_iv ≤ 0` — DOC-VS-CODE RESOLVED, and it is a CODE bug (open).** The v1.2 tech spec and
  v1.5.1 PRD both state the IV cron "skips writes when `atm_iv ≤ 0`" and that "the IV Rank query
  ignores rows with `atm_iv <= 0`". **Neither guard exists.** The cron skips only on `null`
  (`volatility ?? impliedVolatility ?? null`, so a Schwab-returned `0` passes straight through),
  and `calculateIVRank` selects every row in the 365-day window with no `> 0` filter. One zero row
  drags `low52w` to 0, which inflates every subsequent IV Rank — biasing toward false PASS — and
  counts toward the 20-day calibration minimum. See §9a below.
- **Operator override on ALL verdicts** — April's standing request: every FAIL/BLOCKED verdict
  keeps its reasons but becomes overridable, with overrides marked in the journal so outcomes are
  trackable. Unscheduled. Related display bug: a card can show "15.0%" while its FAIL reason says
  "14.9%" (display rounds, the filter compares exact). Sharpened 2026-07-30: the override must
  extend to diversification/position gates, BPR, and calibration; warnings stay fully visible.
  The calibration case still needs a design answer — overriding CALIBRATING means placing with no
  IV Rank data at all, so the review step should render "IV RANK: UNKNOWN (X days)" rather than
  nothing.
- **Diagonal exits** — whether per-leg expirations ever earn their own ticket shape and fixture.
- ~~**`user_settings` schema file**~~ — **CLOSED.** The table including `pause_exit_placement` is
  in `supabase-schema.sql` (lines 56–73) and matches `migrations/2026-07-28-pause-exit-placement.sql`.
  The Session 15–18 boards carried this as open after it had already been folded in. The filename
  remains historically misnamed (the DB is Neon); left as-is deliberately, since ~10 session
  summaries reference it by name as the decision log.

---

## 9a. Open Bug — IV Rank zero-row contamination

**Severity: high (biases trade selection toward false PASS).** **Status: reported, unfixed —
awaiting April's call, because the fix has operational consequences mid-calibration.**

- `app/api/cron/snapshot-iv/route.ts` writes a row whenever `atmIv !== null`. Nullish coalescing
  does not treat `0` as absent, so an after-hours `volatility: 0` from Schwab is persisted.
- `lib/strategy/iv-rank.ts` computes `low52w = Math.min(...ivValues)` over an unfiltered SELECT.
- Net effect with one contaminated row: `ivRank ≈ currentIv / high52w × 100`, systematically
  **overstated**, and `daysOfHistory` counts the bad rows toward `MIN_DAYS_REQUIRED = 20`.
- The v1.2 tech-spec risk table already identified this exact hazard ("Schwab returns IV=0 outside
  market hours, corrupting `iv_history`") and recorded both guards as the mitigation. The
  mitigation was documented but never implemented.

**Why it is not fixed in the same pass:** adding `WHERE atm_iv > 0` would drop contaminated rows
out of `daysOfHistory`, which can revert symbols to CALIBRATING — including the four index symbols
calibrating since 2026-07-28. That is an operator decision, not a silent code change.

**Diagnostic before deciding** (read-only):
`SELECT symbol, count(*) FILTER (WHERE atm_iv <= 0) AS bad, count(*) AS total FROM iv_history GROUP BY symbol ORDER BY bad DESC;`

---

## 10. Future Scope

### v2.4 — Index Options (steps 3–9 SHIPPED; step 11 calendar-blocked)
XSP/SPX/NDX/RUT as tradeable instruments: cash settlement, European exercise, 1256 tax treatment,
`$`-prefixed market-data symbols, per-root OCC handling. Phase 0 findings are pinned in
`steeleagle-v2-4-phase0-findings.md`; the build is specced in
`steeleagle-v2-4-index-options-spec-revB.md`.

- **Steps 3–6, 9 shipped** (`989dfc8`): `lib/strategy/instruments.ts` is the single source of
  truth; `parseOccSymbol` returns both `root` and resolved `underlying`.
- **Steps 7–8 shipped** (`e3df1ff`): the XSP place-and-cancel golden fixture is pinned (order
  1007409658003, 2026-07-30) and `orderFixturePinned` is flipped for XSP only. **XSP is
  trade-ready.** SPX/NDX/RUT still refuse order construction until each earns its own fixture —
  flipping that boolean is a live-money change.
- **Step 11** (manual ladder on the first qualifying XSP setup) is calendar-blocked: calibration
  completes ~Aug 24–25, then needs IVR > 25% + a liquidity PASS. Sanity-check the first PASS
  against TOS spreads before trusting it.
- Multi-root indices (SPX/NDX/RUT) refuse auto-exit **by design** — `trade_events` stores no
  symbol, so the OCC root would be a guess. XSP has a single root and is fully placeable.

### Unscheduled
Operator override on all verdicts · at-fill exit placement · roll-event editing · continuous fill
sync · multi-user · backtest engine over stored IV history · native mobile.

---

**End of PRD v2.3**
