# Strategy + SteelEagle — Session 6 Summary

**Date:** May 21, 2026
**Status:** v1.3 (Strategy v1.4 Alignment Layer) **COMPLETE.** Item 6 (roll alert) built, tested, and fully wired — strategy module → `/api/positions` annotation → `PositionsMonitor` badges + banner. Build green. v1.3 is shipped.

---

## What Was Accomplished This Session

Built and wired **v1.3 Item 6 — the Roll Alert**, the last remaining v1.3 feature. A new pure strategy module (`lib/strategy/roll-alert.ts`, **13 passing tests**) decides, given a position's live short deltas, whether and which side to roll. It's wired into the positions route via a batched `/quotes` delta fetch and a small field-name adapter, and surfaced in the monitor as per-row badges plus a banner roll-up. Test total moves **66 → 79**.

With Item 6 fully wired — module, route annotation, and `PositionsMonitor` surface — **v1.3 is complete.** Roll verdicts compute server-side on every open condor and render as per-row `ROLL` / `REVIEW` / `ROLL?` badges plus a banner roll-up; after-hours (null deltas) they self-suppress.

---

## Open Questions Resolved (Item 6 scoping)

- **Q1 — Trigger threshold:** two-band, mirroring the existing 21-DTE WARN/ALERT pattern. `WATCH` when a short's |Δ| is in **[0.27, 0.30)**; `ROLL` at **|Δ| ≥ 0.30**. The roll *target* for the untested side is **~0.30Δ** (per Strategy §5's "16Δ → 30Δ" example). A hard threshold for the trigger, not a band.
- **Q2 — Data source:** batched **`/quotes` on the exact short-leg OCC symbols** (lighter than a `/chains` pull). One batched call covers every open short across all positions.
- **Q3 — Surface:** per-row badge in `PositionsMonitor` + fold into the existing alert banner — consistent with item 5's CLOSE/PROFIT/WATCH machinery.
- **Q4 — Latency:** fold the delta fetch into `/api/positions`, covered by the monitor's existing `loading` prop. Isolated in an inner `try/catch` so a `/quotes` hiccup degrades to "no badge this load" instead of 500-ing the whole monitor.

---

## v1.3 Final Build Status

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Position reconstruction (flat legs → typed condors/verticals/others) | ✅ Built + wired | `reconstruct-positions.ts` |
| 2 | BPR utilization tracker (header chip, 50%-cap pre-flight) | ✅ Built + wired | `bpr.ts`, `BprChip.tsx` |
| 3 | 5-position concurrent cap | ✅ Built + wired | `position-limits.ts` |
| 4 | Per-pillar constraints (equity block 2, Vol/Currency 1) | ✅ Built + wired | `position-limits.ts` |
| 5 | Positions monitor alerts (21-DTE, profit target, stop-loss) | ✅ Built + wired | `position-alerts.ts` |
| 7 | Liquidity filter (spread > 25% of credit → FAIL) | ✅ Built + wired | `liquidity.ts` |
| **6** | **Roll alert (short tested ~30Δ → roll untested side)** | **✅ Built + wired** | `roll-alert.ts`, route annotation, `PositionsMonitor` badges + banner |

---

## New Strategy Module

| Module | Purpose | Tests |
|---|---|---|
| `lib/strategy/roll-alert.ts` | `computeRollAlert(position, shortDeltas)` — given live short deltas, decide ROLL / WATCH / BOTH_TESTED / NO_DELTA / NONE and which side to roll; `summarizeRollAlerts()` (banner), `rollBadge()` (label helper) | 13 |

**Total: 79 tests** (`npm test` → `tsx --test "lib/**/*.test.ts"`).

---

## Key Decisions Made

- **Pure module takes already-fetched deltas, doesn't fetch.** Keeps it deterministic and testable in isolation, like the other six. The `/quotes` call lives in `lib/schwab/quotes.ts` and is invoked by the route.
- **Structural input + route-side adapter.** `roll-alert.ts` accepts a `RollInputPosition` (`symbol`, `type`, `legs[{action,type,occSymbol}]`) rather than importing `ReconstructedPosition`. The route maps the real reconstructed fields to it (`underlying→symbol`, `kind→type`, `quantity<0→SELL`, `putCall→type`). This decouples the module from repo types (its tests don't depend on them) and **avoids a circular import** — `reconstruct-positions.ts` imports `RollVerdict` (type-only) from `roll-alert.ts`, and `roll-alert.ts` imports nothing back.
- **`BOTH_TESTED` → no clean roll.** When both shorts breach the trigger, rolling the "untested" side is undefined; surface a `REVIEW` badge for manual handling rather than guess.
- **Self-suppression on bad data.** Missing/zero/NaN deltas (after-hours; Schwab returns 0 greeks off-hours, same class as the IV=0 bug) → `NO_DELTA` → no badge. Same philosophy as `openPnlReliable`.
- **Annotation isolated from core data path.** The delta-fetch + verdict loop in `/api/positions` is in its own inner `try/catch`; reconstruction failure still 500s (core data genuinely missing), but a roll-annotation failure just logs and returns positions without badges.
- **Badge labels disambiguated from the DTE alerts.** The monitor's `RollBadge` reads `verdict.status` directly (not `rollBadge()`) so the approaching state renders as a muted **`ROLL?`** pill rather than a second **`WATCH`** that would collide with the item-5 DTE-watch pill in the same cell. Escalation: `ROLL` amber (adjustment), `REVIEW` red (both tested → folds into banner "needs action"), `ROLL?` muted slate (approaching, row-only — not counted in the banner, to keep the summary line clean).

---

## Bugs & Issues Encountered

- **Route field-name mismatch (the main one).** First-pass wiring assumed `position.type`, `leg.action`, `position.symbol`. The real reconstructed types use **`kind`**, **signed `quantity`** (negative = short), **`underlying`**, and **`putCall`** — there is no `action` or `type` on these objects. Surfaced as a cluster of TS2339/TS2345 errors in `route.ts`. Fixed by pulling the actual `reconstruct-positions.ts` from the repo and writing a `toRollInput` adapter against the real fields. **Lesson reinforced (cf. Session 5's response-shape lesson): read the actual type definitions before writing against repo types — do not guess field names.** (Applied this round for `PositionsMonitor.tsx` too — pulled the file before editing.)
- **`rollVerdict` field placement.** The `rollVerdict?: RollVerdict` member was initially pasted *outside* the `ReconstructedPosition` type body, so TS parsed it as a value expression ("Cannot find name 'rollVerdict'" / "Expression expected" / "RollVerdict used as a value"). Moved inside the type braces; committed version is correct. (A leftover `// inside ReconstructedPosition:` instruction comment can be deleted.)
- **Devtools noise, triaged and ignored** (neither from `tsc`/ESLint, neither blocks the build):
  - `BprChip.tsx` `no-inline-styles` — webhint sev-4 on the computed fill-bar width. Same hint already ignored in Session 5.
  - `ScannerCard.tsx` `axe/forms` "Form elements must have labels" — Edge Tools a11y hint on the v1.2 click-to-edit symbol input. Optional real fix: add `aria-label="Edit ticker symbol"` to that input.

---

## Files Created / Modified

### Created
- `lib/strategy/roll-alert.ts` (+ `roll-alert.test.ts`, 13 tests)

### Modified
- `lib/strategy/reconstruct-positions.ts` — added `import type { RollVerdict }` + optional `rollVerdict?: RollVerdict` field on `ReconstructedPosition` (additive; no consumer breaks)
- `lib/schwab/quotes.ts` — added `getOptionDeltas(occSymbols)`: batched `/quotes` delta fetch (via `marketGet`), returns `Map<occSymbol, number|null>`; zeroes/missing → null
- `app/api/positions/route.ts` — `toRollInput` adapter + roll annotation loop (one batched `getOptionDeltas` call; per-condor `computeRollAlert`), isolated in an inner `try/catch`
- `components/positions/PositionsMonitor.tsx` — `RollBadge` per-row pill (ROLL amber / REVIEW red / ROLL? muted; tooltip = `verdict.note`), reading `verdict.status` directly to avoid the DTE-WATCH label collision; `AlertBanner` extended with a `… to roll` clause (BOTH_TESTED folds into "needs action")

---

## Data-Verification Items (confirm against a live account)

**New (Item 6):**
1. `/quotes` returns `delta` under the `quote` object for option symbols, **populated intraday**. If greeks live elsewhere or need a different `fields` value, adjust the extraction in `getOptionDeltas`.
2. `/quotes` accepts the exact **21-char `occSymbol`** format `reconstruct-positions.ts` emits. If Schwab wants different spacing/format on quotes, add a formatter before the call.
3. End-to-end: a real open condor with a short drifting toward 30Δ should produce a `ROLL` verdict and badge. Until a live position exercises it, the feature is logic-correct but unproven against the live payload.

**Carried over from Session 5:**
- `liquidationValue` populates under `fields: 'positions'`.
- `longOpenProfitLoss` / `shortOpenProfitLoss` present per leg.
- `condor.bpr` unit (per-share ×100 → per-contract dollars).
- `averagePrice` sign on short legs (abs() applied defensively).

---

## State of the Deployed System

- **URL:** https://steeleagle.vercel.app
- **Repo:** github.com/jaytjones/steeleagle (public)
- **roll-alert.ts:** built, 13 tests, committed.
- **route.ts:** roll annotation wired; build green.
- **Monitor surface:** `RollBadge` + banner wired; **build green, confirmed.**
- **Tests:** 79 passing via `npm test` (the UI surface is untested by design — testing lives on the pure strategy modules).
- **Cron / Schwab auth:** unchanged (cron 4:15 PM ET weekdays; 7-day refresh-token re-auth).

**v1.3 is feature-complete and deployed.** Remaining confidence gap is purely the live-payload verification above (needs a real open position, ideally one near 30Δ).

---

## Document Note

The operative strategy spec is now **`iron-condor-strategy-version-1_5.md`** (Session 5 and earlier referenced v1.4). v1.5 adds two sections with **no changes to Sections 1–8**:
- **§8 Tactical Earnings Plays** — a full spec for the v1.4 milestone (watchlist tiers, IV-crush mechanics, BPR caps, crisis protocol). This is the doc to build v1.4 against.
- **§9 Scaling Addendum (exploratory)** — model-derived higher-delta / wider-wing analysis at a ~$30k bankroll. Informational; does not change the operative $10k rules.

---

## Decisions: Next Session

### v1.4 Earnings Sleeve (Strategy §8)
Bigger than a single feature; the **earnings-calendar provider is the first decision** (everything downstream depends on it).
- New watchlist table (Tier 1: AAPL/MSFT/JPM/V/KO/PG/WMT/JNJ; Tier 2 sized-down: GOOGL/AMZN/AMD/CRM; Tier 3 blocked).
- Third-party earnings-calendar API (Schwab doesn't expose earnings dates — doc suggests Finnhub or similar).
- Expected-move computation from the ATM straddle for the post-earnings expiration.
- Short-DTE condor builder: 1–3 DTE, shorts at/just outside the expected move (or 1.25× EM), **25% profit target** (not 50%), **no stop loss**, $5 wings ($10 for >$300 names).
- Integration constraints with the core: ≤10% of total BPR for earnings, ≤2 concurrent earnings positions, ≤3% account equity per trade; **crisis protocol** (skip earnings entries the week of a core stop-loss event).
- Pre-entry verification checklist (5 conditions, §8.4).

This is a sizeable milestone (new external dependency + a parallel scanner with different rules). Worth its own scoping pass before building.

---

## Pickup Checklist for Next Session

```
Resuming SteelEagle build.

Last session: May 21, 2026 (Session 6 — v1.3 COMPLETE: Item 6 roll alert built,
wired through /api/positions, and surfaced in PositionsMonitor; 79 tests; build green).

Dashboard: https://steeleagle.vercel.app
Repo: github.com/jaytjones/steeleagle (public)

Reference documents:
- iron-condor-strategy-version-1_5.md  (operative strategy spec; §8 = v1.4 earnings sleeve)
- steeleagle-prd-v1-2.md               (product requirements)
- steeleagle-tech-spec-v1-2.md         (implementation details)
- steeleagle-session-6-summary.md      (this file)

First, confirm clean state:
1. npm test → expect 79 passing.
2. tsc --noEmit locally before any push (npm test does NOT type-check).

v1.3 is done. Remaining is live-payload verification only (need a real account / position):
- /quotes returns `delta` under `quote` for option symbols, intraday.
- /quotes accepts the 21-char occSymbol format reconstruct-positions emits.
- A short near ~30Δ actually fires a ROLL verdict + badge end-to-end.
- Carried from Session 5: liquidationValue under fields=positions;
  longOpenProfitLoss/shortOpenProfitLoss presence; condor.bpr unit; averagePrice sign.

Then begin v1.4 — Earnings Sleeve (Strategy §8). Scope it before building:
- DECIDE FIRST: earnings-calendar provider (Finnhub or similar). Everything depends on it.
- Watchlist table (Tier 1/2 tradable, Tier 3 blocked).
- Expected-move from ATM straddle; short-DTE condor builder (1–3 DTE, 25% target, no stop).
- Integration caps: ≤10% BPR, ≤2 concurrent, ≤3% equity/trade, crisis-protocol block.
- Pre-entry verification checklist (§8.4).
```

---

**End of Session 6 Summary**
