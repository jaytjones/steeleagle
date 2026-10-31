# SteelEagle — Product Requirements Document
**Version:** PRD v2.16 (covers everything shipped through v2.16)
**Status:** Consolidated refresh — from the deployed build, the code, and session summaries 17–28
**Last Updated:** October 31, 2026 (Session 28)
**Supersedes:** PRD v2.3 (July 28, 2026; amended through July 31)
**Companion Tech Spec:** `steeleagle-tech-spec-v2-16.md`

> **About this refresh.** PRD v2.3 last changed on July 31 (v2.5 + v2.6). Since then fourteen
> milestones shipped without a refresh: v2.6.1, v2.7/v2.7.1, v2.8, v2.9, v2.10, v2.11, v2.12,
> v2.13 (+ .1, .2), v2.14, Session 27's fixes, v2.15 and v2.16. The largest shift: **the journal
> now largely keeps itself.** The account's own order record is ledgered, proven complete every
> night, and used to journal entries, rolls and closes automatically — with every placement
> consequence held behind JJ's confirmation. Session summaries remain the decision log; this PRD
> is the current-state reference. Where this and the code disagree, the code wins.

---

## 1. Executive Summary
SteelEagle is a single-user iron condor **scanning, execution, risk-management, and journaling**
dashboard for one solo retail options trader (**JJ**) running the TOMIC framework. It is a closed
loop from candidate to closed trade, and since v2.11 it also audits itself against the account.

- **v1.0–v1.5.1** — scanner, strategy alignment, roll-aware journal, Schwab importer.
- **v2.0 / v2.1** — confirmation-gated order placement; panel editing + logged override.
- **v2.1.1** — earnings sleeve **removed**.
- **v2.2 / v2.2.1 / v2.3** — automated exit sweep (50% GTC), close hardening, Cancel GTC,
  `currentStructure`.
- **v2.3.1 / v2.3.2** — roll and entry forms hardened (blank is never $0.00).
- **v2.4** — index options (XSP trade-ready; SPX/NDX/RUT refuse orders by design).
- **v2.5** — override on **every** verdict. **v2.6** — IV Rank measurement corrected.
- **v2.6.1** — delta-staleness marker. **v2.7 / v2.7.1** — iron butterfly recognition + exits.
- **v2.8** — journal ⇄ account **reconciliation** (flags, never blocks).
- **v2.9** — **sweep run visibility**: every run persisted and shown on the dashboard.
- **v2.10** — expiration selection: 30–45 DTE, monthly preferred.
- **v2.11** — **fill ledger + position identity**: the account's order record, proven complete.
- **v2.12** — quantity-aware placement guard; scale-ins supported; sweep closes editable.
- **v2.13** — honest re-auth window; .1/.2 fix two defects that kept the identity from balancing.
- **v2.14 / v2.15 / v2.16** — **gated auto-journal** of closes, rolls and entries; roll-price
  editing; split-roll prefill. *(Session 27 in between: landing page per-request; BPR derived.)*

**The execution line is unchanged since v2.3.** SteelEagle places entry orders (on request) and
standing 50%-profit GTC exits (automatically). It does **not** place closing orders — JJ closes in
thinkorswim. What changed is the *journal*: it now records what happened in TOS without a click,
whenever the night's accounting proves the record complete.

---

## 2. Problem Statement
The TOMIC framework requires daily verification of IV Rank ≥ 25%, 30–45 DTE chains, ~16Δ/~5Δ
strikes, symmetric wings and a minimum credit across a 25-instrument universe, plus position
management (BPR, the 5-position cap, pillar concurrency, 21-DTE exits, 50% targets, rolls) and an
accurate trade record. Schwab exposes none of this analysis and groups nothing into spreads.

Success added three problems, in order:
1. **Hand-entering a 4-leg condor is error-prone** — v2.0.
2. **A profit target only pays if someone is watching** — v2.2's standing GTC.
3. **The journal drifts from the account, and drift is a live mis-pricing.** Most trading
   happens in TOS, outside the app. An unjournaled roll means the sweep prices the next GTC from
   the wrong credit and the wrong strikes — in August, GLD's exit was rejected by Schwab every
   night for eleven days on legs rolled away twice, and nobody saw it. v2.8–v2.16 address this:
   detect drift (reconciliation), deliver it (sweep visibility), prove completeness (the
   position identity), and close the gap (auto-journal).

---

## 3. Target Users

### Primary Persona — The Operator (JJ)
| Attribute | Detail |
| :--- | :--- |
| **Who** | Solo retail options trader; sole developer AND live trader of this system. US Central time. |
| **Primary goal** | Surface qualifying setups, place them without fat-finger risk, stay inside the risk envelope, keep an accurate record without transcription |
| **Biggest frustrations** | Schwab computes no IV Rank and groups no spreads; manual entry is error-prone; targets are missed while away; journaling TOS activity by hand lags and drifts |
| **Technical comfort** | High — TypeScript, Next.js, OAuth, Postgres, Vercel |

No secondary personas. Single-user, behind a session-cookie login.

---

## 4. Goals & Success Metrics

### Primary Goals
1. **Surface actionable setups consistently.**
2. **Keep the operator inside the risk envelope.**
3. **Execute without transcription error** — tickets rebuilt server-side from validated primitives.
4. **Never miss a mechanical exit** — the 50% target stands as a live GTC.
5. **Keep the journal true to the account** — detect drift, prove completeness, and journal what
   can be proven, automatically. *(new since v2.3)*
6. **Never let a check fail silently** — "cannot tell" is never rendered as "healthy". *(new)*

### Success Indicators (Qualitative)
- SteelEagle is the first step of the routine, not a verification step.
- The dashboard banner is trusted: red means something needs eyes, and it is not red otherwise.
- JJ does not check TOS to learn whether an exit filled, and rarely journals by hand.
- Unjournaled Activity is usually empty; when it is not, every card is real work.

---

## 5. Feature List

Legend: **[SHIPPED · vN]** live in production · **[REMOVED · vN]** deleted.

### Core Scanner
- **F1 — Schwab OAuth** [SHIPPED · v1.0, **re-auth window v2.13**, landing page S27]. Access
  token auto-refreshes. **The 7-day refresh window runs from the INTERACTIVE login and a refresh
  does not extend it** (v2.13 — before, every refresh slid the deadline forward, so the warning
  could never fire). The banner reads **ok / soon (≤ 48 h) / expired / unknown**, deadline in CT;
  "unknown" is never shown as fine. Schwab, not the stored deadline, decides whether a grant is
  live — the deadline warns, it does not gate. The landing page renders per request (Session 27:
  it had been prerendered, freezing the deadline at deploy time).
- **F2 — Daily IV History** [SHIPPED · v1.0, corrected v2.6]. 21:15 UTC weekdays. 25 instruments.
  Same measurement as the scanner by construction (ATM call, 28–52 DTE); refuses `atm_iv ≤ 0`.
- **F3 — IV Rank** [SHIPPED · v1.0]. ≥ 20 days or CALIBRATING. Basis-separated (v2.6).
- **F4 — Iron Condor Setup Builder** [SHIPPED · v1.0, **expiration selection v2.10**]. ~16Δ
  shorts, ~5Δ longs, symmetric wings. **Expiration: 30–45 DTE, monthly preferred** — a monthly
  wins anywhere in range; with none, closest to 37.5 DTE, ties break longer; outside 30–45 is
  excluded, never stretched. The IV measurement keeps its own unchanged rule (28–52, nearest) so
  IV Rank's basis did not move. Monthlies are `expirationType "S"`, not `"M"` (probe-pinned).
- **F5 — Strategy Filter Chain** · **F6 — Scanner UI** · **F7 — Setup Cards** · **F9 —
  Calibration Banner** · **F10 — 25-symbol coverage** · **F11 — Ticker Cells** (max 10) ·
  **F12 — Settings** (incl. `pause_exit_placement`). All [SHIPPED], unchanged.

### Strategy Alignment Layer (v1.3)
- **F13 — Position Reconstruction** · **F14 — BPR Utilization** · **F15 — Position Limits &
  Entry Gate** · **F17 — Liquidity Filter** — [SHIPPED · v1.3].
- **F16 — Position & Roll Alerts** [SHIPPED · v1.3, **delta-staleness v2.6.1**]. The roll badge is
  exception-only, so "healthy" and "no opinion" looked identical. Now `Δ STALE` (amber, in market
  hours = a fault) / `Δ —` (dim, after hours = expected), one predicate for row and banner.

### Tactical Earnings Sleeve
- **F18** — **[REMOVED · v2.1.1]**. Second cron slot freed and **held open**.

### Trade Journal & Importer
- **F19 — Trade Journal** [SHIPPED · v1.5, hardened v2.2.1–v2.3.2, **BPR derived S27**]. One
  trade per condor lifecycle; rolls mutate the trade. **BPR is derived, not typed**: wider wing ×
  100 × contracts − net credit, auto-filled (editable) on the New Trade form, stamped by Import;
  null — never a guess — when a leg is unpriced. Every write path refuses a blank price ($0.00 is
  legal, blank is not). *Session 28 backfilled 11 July trades whose BPR held a $0.00 placeholder.
  No gate reads `initial_bpr`; it is a journal record.*
- **F20 — Schwab Position Importer** [SHIPPED · v1.5.1]. Still the manual path for entries.
  Cannot see a same-strike scale-in (Schwab aggregates the position) — auto-entry can (F32).

### Execution
- **F21 — Confirmation-Gated Order Placement** [SHIPPED · v2.0]. Nothing auto-submits; the ticket
  is rebuilt server-side. **XSP is placeable** (v2.4); SPX/NDX/RUT refuse until each earns a
  fixture. The app never OPENS a butterfly.
- **F22 — Panel Leg Editing + Logged Override** [SHIPPED · v2.1, **all verdicts v2.5**]. Every
  verdict is overridable, FAIL included, with the violated rules and a typed reason stamped into
  the journal. CALIBRATING renders `IV RANK: UNKNOWN (n/20)`.

### Automated Exits
- **F23 — Auto-Exit Sweep** [SHIPPED · v2.2, **quantity-aware guard v2.12**]. Post-close cron:
  (a) journal filled GTCs, clear dead ones; (b) 21-DTE alerts; (c) place 50% GTCs at ≥ 24 DTE.
  **Pre-place guard (v2.12): place only when `held − covered ≥ contracts`** — the hazard is
  over-covering, and "any working close exists" was only ever a proxy for it. Every unknown
  degrades to the old blanket rule, which never over-covered. More closes than contracts held is
  its own critical flag. **The cron never cancels.**
- **F24 — Placement Pause** [SHIPPED · v2.2]. Suspends step (c) **only**. *(Session 28 fixed a
  defect: the paused branch had been skipping the auto-journal step too.)*
- **F25 — Close-Form Hardening** [SHIPPED · v2.2.1].
- **F26 — Closed-Trade Edit** [SHIPPED · v2.2.1, **sweep closes editable v2.12**]. Close legs on a
  closed trade: price, direction, time. A `schwab_fill` close is editable; editing demotes its
  `source` to `manual` and keeps the order id. Structure is immutable.
- **F27 — Cancel GTC** [SHIPPED · v2.3]. The app cancels; JJ closes in TOS; **Record Close**
  journals it — unless auto-journal already did (F32).
- **F28 — Current-Structure Reconstruction** [SHIPPED · v2.3, **butterflies v2.7/v2.7.1**]. The
  structural invariant is **`LP < SP <= SC < LC`** — the `<=` admits the iron butterfly's
  zero-width body; `SP > SC` is never valid. A butterfly is an `IRON_CONDOR`; butterflies arise
  from rolls only, and their 50% exits auto-place (Schwab records them identically to a condor).
  Same-expiration rolls place automatically; diagonals keep `MANUAL GTC`. The Monitor renders
  **one chip per journal trade** on a position, so two same-strike trades show two GTCs.

### Account Truth (v2.8 – v2.13)
- **F29 — Journal ⇄ Account Reconciliation** [SHIPPED · v2.8, multiset v2.12]. Every sweep
  compares open trades to the account: **DRIFT / PHANTOM** (critical) · **UNCOMPARABLE** ·
  **UNIMPORTED** · **MATCH**. Compares the union of all trades on a key as a multiset by putCall,
  so two same-strike trades reconcile. **A DRIFT FLAGS; it never blocks placement** (JJ,
  2026-08-04) — this is a heuristic in front of a mechanical chain that already works. "Did not
  run" is critical, never "nothing found".
- **F30 — Sweep Run Visibility** [SHIPPED · v2.9]. Every sweep run is persisted (`sweep_runs`) and
  rendered on the dashboard banner. Severity is **stamped at the producer**, never inferred from
  prose: `routine` is reserved for permanent, decided refusals (and the young GTC hold, F32);
  everything structural is `critical`, so the banner is not wallpaper. **Freshness** is derived
  from the clock — two missed weekday runs = stale — because a cron that stops firing produces no
  report at all. NOTES are a fourth channel: things the sweep did for JJ, shown on every night.
- **F31 — Fill Ledger & Position Identity** [SHIPPED · v2.11, fixed v2.13.1/.2]. Every fetched
  order is classified and ledgered (`schwab_fills`, keyed on order id). A nightly
  `position_snapshots` anchor proves `positions(T₀) + Σ order effects == positions(T₁)`: a
  **zero residual is a completeness proof** — every contract that moved is explained by an order.
  **Unjournaled Activity** shows recent fills the journal does not record (7 days), with a
  deep link that pre-fills the Roll/Close form with real execution prices. v2.13.1: money-market
  sweeps were wrongly refusing the identity (it is an option-leg identity on both sides). v2.13.2:
  **Schwab files a cancellation as an EXECUTION** — `executionType` is the only field that says so,
  and before the fix a cancelled GTC read as a filled close.

### Self-Keeping Journal (v2.14 – v2.16)
- **F32 — Gated Auto-Journal** [SHIPPED · closes v2.14, rolls v2.15, **entries v2.16**]. After
  every placement decision, the sweep journals what JJ did in TOS — **only on a night whose
  interval balances to a zero residual**, all or nothing. Three passes: **entries → rolls →
  closes**.
  - **Closes** (v2.14) — `closeReason: manual` (the app knows JJ closed it, not why).
  - **Rolls** (v2.15) — same-expiration, single-ticket, one-sided 2+2 or full 4+4; butterfly
    results allowed. Refuses: already journaled, ambiguous owner (same-strike pair), contract
    mismatch, standing GTC or prior hold, a second roll of a trade in one night, a roll out in
    time, an unpriced leg, closing legs the journal does not currently hold, a malformed result.
  - **Entries** (v2.16) — four-leg entries, BPR derived; deduped by **Schwab order id**, so a
    scale-in becomes its own trade; a same-strike trade with no order id refuses. Butterfly
    entries refuse.
  - **The GTC is HELD** after an automatic entry or roll until JJ clicks **Confirm & arm GTC** on
    the trade card (Monitor chip: `GTC HELD`). The hold is a `trades` column, set in the same
    transaction as the write; it can only withhold a placement, never cause one. Its flag is
    routine, then **critical after 3 unconfirmed runs**.
  - Every refusal stays an inbox card. A pass that throws is critical. Writes appear as NOTES.
- **F33 — Roll-Price Editing** [SHIPPED · v2.16]. Repair roll-leg **prices** on an open or closed
  trade (direction, strikes, times are structure). Refused while a GTC stands — cancel it first,
  the sweep re-places at the corrected price. Same provenance rule as F26.
- **F34 — Split-Roll Prefill** [SHIPPED · v2.16]. A roll done as two tickets (close one spread,
  open another) opens as **one** pre-filled Roll form for JJ to confirm. No automatic write.

### Naming contract (v2.3 — do not collapse)
| Control | Where | What it does |
| :--- | :--- | :--- |
| **Cancel GTC** | Positions Monitor | Cancels the standing exit **at Schwab** |
| **Record Close** | Journal card | **Journals** a close that already happened — sends nothing |
| **Confirm & arm GTC** | Journal card | Lifts the hold on an automatic entry/roll — sends nothing; the next sweep places |

---

## 6. User Flows

### Flow 1 — Login · Flow 4 — Ticker Cells
Unchanged.

### Flow 2 — Daily Routine
`/dashboard` → **sweep banner first** (red = needs eyes; NOTES list what was journaled for you;
stale = the cron did not fire) → scanner cells → Monitor (GTC chips, `GTC HELD`, `Δ STALE`).

### Flow 3 — Place a Trade
Unchanged (override available on every verdict).

### Flow 5 — Re-Authentication
Banner turns **soon** 48 h before the 7-day deadline (CT). Log in again any time before it.

### Flow 6 — The Exit Loop (unattended)
Sweep places a 50% GTC at ≥ 24 DTE → it fills → the next sweep journals the close. Do not
journal a sweep-placed fill by hand.

### Flow 7 — Trade in thinkorswim, let the journal follow
Enter, roll or close in TOS → that evening, on a balanced night, the sweep journals it and the
banner says so → **for an entry or roll, open the trade card, check the legs (edit roll prices if
needed), click Confirm & arm GTC** → the next sweep places the 50% exit. Anything the sweep could
not prove or refused appears in **Unjournaled Activity** → open the card's pre-filled form →
confirm.

### Flow 8 — Manage / Exit Manually
Cancel GTC (if one stands) → close in TOS → let the sweep journal it, or Record Close.

### Flow 9 — Repair
Closed trade: **Edit Close**. Any trade with roll legs: **Edit Roll Prices** (cancel a standing
GTC first). Entry legs are not editable.

---

## 7. Out of Scope (current)
1. **App-placed closing orders** — rejected in v2.3. The app cancels; JJ closes.
2. **Any cron-initiated cancellation.** 21-DTE is alert-only.
3. **Automated stop-losses.**
4. **Blocking placement on reconciliation** — rejected (JJ, 2026-08-04). Drift flags only.
5. **Automatic split-roll pairing** — deferred (JJ, 2026-10-31); prefill only.
6. **Auto-journaling rolls out in time, partial rolls, aggregated (multi-trade) rolls.**
7. **Editing entry legs, roll direction/strikes/times.**
8. **Diagonal / multi-expiration exits** — `MANUAL GTC`.
9. **Auto-exit on multi-root indices (SPX/NDX/RUT)** — the OCC root would be a guess.
10. **At-fill exit placement · intraday sweeps** (Hobby: one run/day; second slot held open).
11. Multi-user, native mobile, backtesting, tax reporting, external alerts.

---

## 8. Non-Functional Requirements
- **Performance:** dashboard ≤ 3 s cold; one post-close invocation covers the IV snapshot (25
  symbols) and the whole sweep. One wholesale orders fetch per run (order endpoints 10/min).
- **Platform:** desktop primary; stacked mobile layout.
- **Security:** tokens server-side; account hash only; session cookie (30 days) on every route but
  `/login` and `/api/cron/*` (`CRON_SECRET`, a Vercel Sensitive variable).
- **Isolation rules (do not loosen):** the ledger tables (`schwab_fills`, `position_snapshots`) and
  `sweep_runs` are write-only from the cron and read-only elsewhere; **nothing in the placement
  path reads them**. The only automatic input to placement from the journal side is the `trades`
  hold column, and it can only withhold.
- **Fail-safe directions:** settings-read failure → not paused; unknown held count → strict guard;
  unknown coverage ≠ zero coverage; "did not run" is critical.
- **Infrastructure:** Vercel Hobby, **1 of 2 cron slots used**. Neon Postgres. The cron is due
  21:15 UTC (4:15 PM CDT / **3:15 PM CST**); Vercel drift of ~12–57 min has been observed.
- **Regulatory:** single US user; informational, not financial advice.

---

## 9. Open Questions
- **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.
- **The self-resolving PHANTOM** (Session 25) — on a night the sweep itself journals a close,
  reconciliation (which ran earlier in the same sweep) flags that trade critical. Deliberately not
  fixed: both fixes cross an isolation boundary drawn on purpose.
- **Diagonal exits** — whether per-leg expirations ever earn a ticket shape and fixture.
- **v2.4 step 11** — the manual ladder on the first qualifying XSP setup (no longer
  calendar-blocked).

---

## 10. Future Scope
**Owed live verifications (nothing to build):** a non-trivial balanced night (one containing a
real fill, ideally a cancelled GTC) · the first production writes of auto-journal for closes,
rolls and entries (NOTE → `GTC HELD` → confirm → placement) · the first roll-price edit · the
`createTrade` duplicate-order guard · L3-in-app (Cancel GTC on a sweep-placed GTC) · L3 ladder.

**Unscheduled:** automatic split-roll pairing · at-fill exit placement · entry-leg editing ·
continuous fill sync · multi-user · backtest engine over stored IV history · native mobile.

---

**End of PRD v2.16**
