# Strategy + SteelEagle — Session 5 Summary

**Date:** May 20, 2026
**Status:** v1.3 (Strategy v1.4 Alignment Layer) items 1–5 and 7 built, tested, and wired. Item 6 (roll alert) is the only remaining v1.3 feature — deferred to next session.

---

## What Was Accomplished This Session

Built the bulk of **v1.3 — the Strategy v1.4 Alignment Layer**: the risk-management awareness the dashboard previously lacked. Six new pure, unit-tested strategy modules were added under `lib/strategy/`, totalling **66 passing tests**, and wired into the scanner and a rebuilt positions monitor.

The work followed the v1.3 implementation order from the Session 4 pickup checklist. Items 1–5 are built and wired; item 7 (liquidity filter) is built and its two-line builder edit delivered; item 6 (roll alert) is scoped but not started — it's the one feature that adds a new Schwab call to the positions path, so it was held for a deliberate start.

No strategy-doc changes — `iron-condor-strategy-version-1_4.md` remained the operative spec throughout.

---

## Pre-Work Resolved

Before building, the Schwab `/accounts/{hash}` response shape was reviewed and the Session 4 open questions closed:

- **Schwab returns flat option legs, not grouped condors.** A single open condor appears as four separate `OPTION` position entries. Reconstruction must group legs by `(underlying, expiration)` and classify the structure. The OCC symbol (21-char) encodes underlying / expiration / put-call / strike, which is enough to reconstruct.
- **No per-condor BPR field.** Schwab reports a per-leg `maintenanceRequirement`, but it's unreliable for spreads. BPR is derived the strategy-consistent way instead: `wingWidth − credit` (max loss), keeping it dimensionally identical to the scanner's entry BPR.
- **Q1 (partial fills):** a single remaining wing → classified as a **Vertical Spread**, separate from condors.
- **Q2 (does a partial occupy a 5-cap slot?):** **yes** — a vertical still carries risk and holds a slot; its BPR is fractional (the remaining wing's own max loss).
- **Q3 (21-DTE alert threshold):** **WARNING at 22–23 DTE, ALERT at ≤21 DTE** (alert wins at exactly 21, matching "close at 21 without exception").
- **SQL note:** the Session 4 pickup query used `MAX(snapshot_date)`, but the `iv_history` schema column is `date` — reconcile before running the calibration check.

---

## v1.3 Build Status

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Position reconstruction (flat legs → typed condors/verticals/others) | ✅ Built + wired | `reconstruct-positions.ts` |
| 2 | BPR utilization tracker (header chip, 50%-cap pre-flight) | ✅ Built + wired | `bpr.ts`, `BprChip.tsx`; chip live in header |
| 3 | 5-position concurrent cap | ✅ Built + wired | `position-limits.ts` |
| 4 | Per-pillar constraints (equity block 2, Vol/Currency 1) | ✅ Built + wired | `position-limits.ts` |
| — | Entry gate (limits + BPR pre-flight) on scanner cards | ✅ Built + wired | `entry-gate.ts`; strip on PASS cards |
| 5 | Positions monitor alerts (21-DTE, profit target, stop-loss) | ✅ Built + wired | `position-alerts.ts`; banner + per-row badges |
| 7 | Liquidity filter (bid/ask spread > 25% of credit → FAIL) | ✅ Built; builder edit delivered | `liquidity.ts` |
| 6 | Roll alert when a short strike's delta is tested (~30Δ) | ⏸ Deferred | Needs live-delta chain re-fetch — next session |

---

## New Strategy Modules

All pure and deterministic; each has a companion `.test.ts`.

| Module | Purpose | Tests |
|---|---|---|
| `lib/strategy/reconstruct-positions.ts` | OCC parsing; group flat Schwab legs → Iron Condors / Vertical Spreads / Others; derive max-loss BPR + open P&L; `summarizeOpenRisk()` | 12 |
| `lib/strategy/bpr.ts` | `computeBprUtilization()` (open BPR vs 50%-of-equity cap); `preflightAddTrade()` | 9 |
| `lib/strategy/position-limits.ts` | symbol→pillar map; `checkPositionLimits()` — global 5-cap, equity block (max 2), Vol/Currency (max 1) | 17 |
| `lib/strategy/entry-gate.ts` | `computeEntryGate()` — fuses position limits + BPR pre-flight into one per-card verdict | 7 |
| `lib/strategy/position-alerts.ts` | `alertFor()` / `summarizeAlerts()` — 21-DTE rule, 50% profit target, stop-loss (2× / 1.5× Vol) | 14 |
| `lib/strategy/liquidity.ts` | `checkLiquidity()` — 4-leg bid/ask spread vs 25% of credit | 7 |

**Total: 66 tests** (`npm test` runs all via `tsx --test "lib/**/*.test.ts"`).

---

## Key Decisions Made

- **Three position buckets, no fourth.** Irregular option groups (3-leg fragments, naked legs, unparseable OCC) land in `OTHER` with a diagnostic `note` rather than a dedicated bucket.
- **2+ condors on the same underlying AND expiration → `OTHER`** (flagged limitation; rare on a 5-position account; auto-splitting nested condors is ambiguous and was not attempted).
- **Equity block = all six Equities-pillar names** (SPY, QQQ, IWM, DIA, EFA, EEM), max 2 simultaneous. IWM and DIA explicitly count toward the block.
- **BPR cap denominator = `liquidationValue`** (account net liq) × 50%.
- **Stop-loss folded into item 5** (beyond the strict PRD profit/DTE list) — same machinery, and the strategy weights it heavily.
- **Liquidity filter applied universally** (not just Currency/Volatility) — liquid names pass trivially; protects any thin ticker added via configurable cells. Gating to thin pillars remains a one-line option via `pillarOf`.
- **Open-P&L reliability guard:** profit/stop alerts and the monitor's target framing self-suppress when only today's P&L is available (`openPnlReliable === false`).

---

## Bugs & Issues Encountered

- **`SchwabPosition` name collision** in `lib/schwab/accounts.ts` — the new `getAccountSnapshot()` imported a strategy type with the same name as a local declaration. Resolved by aliasing the import (`SchwabPosition as ReconInputPosition`). Cleaner long-term fix: hoist one canonical raw-Schwab-position type into `@/types`.
- **Response-shape change broke `PositionsMonitor` at runtime.** Changing `/api/positions` from `OpenPosition[]` to `{ positions: ReconstructedPosition[], balances }` left the old monitor reading fields that no longer existed → undefined access → error boundary ("This page couldn't load"). Same class as the Session 4 DRT crash. Fixed by rewriting the monitor against the new shape. **Lesson reinforced:** when an API response shape changes, every consumer must change in lockstep; a passing build doesn't catch it because fetched JSON is type-*asserted*, not validated.
- **`tsx --test` does not full type-check.** Two TypeScript narrowing errors in `position-alerts.ts` (redundant always-true guards) passed all tests but would have failed the Vercel build. **`tsc --noEmit` / the build is the real type gate** — worth running locally before pushing.
- **Downloads-folder false alarm (114 errors).** A component opened from `~/Downloads` reported a flood of errors — all downstream of the `@/` alias and React types being absent outside the project. Vanished once the file was in the repo. (Same root pattern as a misplaced file: not a code problem.)
- **webhint `no-inline-styles` hint** on `BprChip`'s computed fill-bar width — a severity-4 hint from a browser-devtools extension (not `tsc`/ESLint), on a line correctly using inline style for a runtime-computed value. Ignored.

---

## Files Created / Modified

### Created — strategy modules + tests
- `lib/strategy/reconstruct-positions.ts` (+ `.test.ts`)
- `lib/strategy/bpr.ts` (+ `.test.ts`)
- `lib/strategy/position-limits.ts` (+ `.test.ts`)
- `lib/strategy/entry-gate.ts` (+ `.test.ts`)
- `lib/strategy/position-alerts.ts` (+ `.test.ts`)
- `lib/strategy/liquidity.ts` (+ `.test.ts`)

### Created — components
- `components/scanner/BprChip.tsx` — header BPR chip (slate palette, `var(--font-display)`)

### Modified
- `lib/schwab/accounts.ts` — added `getAccountSnapshot()` (raw positions + balances)
- `app/api/positions/route.ts` — returns `{ positions: ReconstructedPosition[], balances }` via reconstruction
- `app/dashboard/page.tsx` — positions typed `ReconstructedPosition[]`; added `balances` state; `<BprChip>` in header; `computeEntryGate()` per card
- `components/scanner/ScannerCard.tsx` — `entryGate?` prop + "capped / tight" strip on PASS setups
- `components/positions/PositionsMonitor.tsx` — full rewrite: three buckets, DTE banding, P&L-vs-target, `loading` prop, alert banner + per-row CLOSE/PROFIT/WATCH badges
- `lib/strategy/condor-builder.ts` — liquidity filter (2 edits: import + filter block) **[verify applied/deployed]**
- `package.json` — `test` script (`tsx --test "lib/**/*.test.ts"`) + `tsx` devDependency

---

## Data-Verification Items (confirm against a live account)

These are runtime behaviors that depend on the real Schwab payload — none are code bugs, and each announces itself:

1. **`currentBalances.liquidationValue` populates under `fields: 'positions'`.** If it returns empty, the BPR chip reads `OVER` with a `$X / $0` readout → widen the `fields` param.
2. **`longOpenProfitLoss` / `shortOpenProfitLoss` present per leg.** If absent, `openPnl` falls back to `currentDayProfitLoss` and `openPnlReliable` flips false → monitor shows "(today)" and suppresses target/stop alerts.
3. **`condor.bpr` unit** — treated as per-share (×100 → per-contract dollars for the cap math), matching the builder's `totalCredit * 100` idiom. Mis-unit fails loud (every PASS card would read "exceeds cap").
4. **`averagePrice` sign for short legs** — abs() is applied defensively, so credit comes out right either way; confirm the magnitude is the premium.

---

## State of the Deployed System

- **URL:** https://steeleagle.vercel.app
- **Repo:** github.com/jaytjones/steeleagle
- **Items 1–2:** confirmed working in production — page loads, BPR chip live in the header, positions monitor rendering the reconstructed shape.
- **Items 3–5:** wiring delivered and applied during the session (entry-gate strip on cards, alert banner + badges in the monitor).
- **Item 7:** module complete + tested; the two `condor-builder.ts` edits were delivered at session close — **confirm they're applied and the build is green at next session start.**
- **Tests:** 66 passing via `npm test`.
- **Cron / Schwab auth:** unchanged from Session 4 (cron 4:15 PM ET weekdays; 7-day refresh-token re-auth).

---

## Decisions: Next Session

### v1.3 Item 6 — Roll Alert (NEXT, and the last v1.3 feature)

When an open position's short strike is tested (delta drifts to ~30Δ), surface a roll recommendation for the **untested** side (per Strategy §5: roll the untested side closer to collect more premium and extend the break-even on the tested side).

**Why it was held:** delta is **not** in the `/accounts/{hash}` positions payload. Item 6 is the first feature that needs a **live option-chain re-fetch** — pull current deltas for the open short strikes and compare against the ~30Δ trigger. Reconstruction already carries `occSymbol` on every leg specifically to key this re-fetch.

**Scoping questions to resolve early:**
- Trigger threshold — exactly 30Δ, or a band (e.g. 28–32Δ)?
- One chain fetch per open underlying/expiration, or batch via `/quotes` on the specific short OCC symbols? (`/quotes` on the exact symbols is lighter than a full `/chains` pull.)
- Where the roll suggestion surfaces — a new row action in the monitor, or a dedicated alert.
- Does it respect the same `openPnlReliable`-style guarding when quotes are stale/after-hours?

**Expected duration:** 1 session.

### After v1.3

Per PRD Section 10: v1.4 earnings sleeve scanner, then v2.0 execution layer. Both unchanged from prior planning.

---

## Pickup Checklist for Next Session

```
Resuming SteelEagle build.

Last session: May 20, 2026 (Session 5 — v1.3 items 1–5 and 7 built + wired; 66 tests)
Dashboard: https://steeleagle.vercel.app
Repo: github.com/jaytjones/steeleagle

Reference documents:
- iron-condor-strategy-version-1_4.md (strategy spec, unchanged)
- steeleagle-prd-v1-2.md (product requirements; v1.3 scope in Section 10)
- steeleagle-tech-spec-v1-2.md (implementation details)
- steeleagle-session-5-summary.md (this file)

v1.3 status: items 1–5 + 7 done. Item 6 (roll alert) is the only remaining feature.

First, confirm clean state:
1. Verify item 7's condor-builder.ts edits are applied and the Vercel build is green.
2. Run `npm test` — expect 66 passing.
3. `tsc --noEmit` locally before any push (npm test does NOT type-check).

Then build v1.3 Item 6 — Roll Alert:
1. Decide trigger: ~30Δ exact vs band (28–32Δ).
2. Add a live-delta source for open short strikes — likely `/quotes` on the exact
   short-leg OCC symbols (lighter than a full `/chains` pull). Legs already carry
   `occSymbol` from reconstruct-positions.
3. New pure module `lib/strategy/roll-alert.ts` (+ tests): given a position's short
   deltas, decide if/which side to roll and the suggested target.
4. Surface in PositionsMonitor (new action badge: ROLL) and/or the alert banner.
5. Guard against stale/after-hours quotes (no delta → no roll alert).

Open questions to resolve early in Item 6:
- Q1: Trigger threshold — exact 30Δ or a band?
- Q2: Re-fetch per underlying/expiration, or batch /quotes on short OCC symbols?
- Q3: How to present the roll — monitor row action vs dedicated alert?
- Q4: Does the live-delta fetch add latency to the positions load that needs a
      loading state, or fetch it lazily/separately?

Data-verification items still open (see Session 5 summary):
- liquidationValue under fields=positions; longOpenProfitLoss/shortOpenProfitLoss
  presence; condor.bpr unit; averagePrice sign on shorts.
```

---

**End of Session 5 Summary**
