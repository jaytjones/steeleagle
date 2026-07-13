# SteelEagle — v2.1 Panel Leg Editing + Logged Gate Override: Spec & Pickup Notes

**Version:** Spec draft v0.1 (planning artifact)
**Date:** July 12, 2026 (end of Session 11)
**Status:** Not started. Next milestone after the v2.0 order-placement + auth commits land and pass L3/L4.
**Companion docs:** `steeleagle-session-11-summary.md`, `steeleagle-v2-order-placement-spec.md`

> **What this is.** Two additions to the v2.0 `PlaceOrderPanel`, decided at the end of Session 11: (1) editable strikes in the review step, and (2) a high-friction, self-documenting override for BLOCKED entry gates. Both touch the same component and ship together.

---

## 1. Decisions already made (Session 11 — don't re-litigate)

- **The override must exist but must never be frictionless.** TOS is already an unrestricted bypass; the in-app gate's value is that the convenient path enforces the rules. The override therefore: requires a typed reason, stamps that reason + the violated rule(s) into the journal, and keeps the violation visibly red through the whole flow. The journal record is the point — six months of override outcomes is the only evidence that should ever change the rules themselves.
- **Edited strikes may not exist on the strike grid.** The scanner's strikes come from the live chain; hand-edited ones might not (e.g., GLD's coarser grid). Accepted failure mode for v2.1: **Schwab rejects at submit time** — safe, surfaced in the panel's error state. Pre-validating against the chain is an open question (§5), not a requirement.
- **Editing a strike abandons the 16Δ/5Δ targeting.** The UI must say so (edited legs show a "custom" marker), and the scan-time delta metadata for an edited leg is **nulled** in the journal write (a stale delta is worse than no delta).

## 2. Scope

### 2a. Leg editing (review step)
- The four strikes become editable inputs in `PlaceOrderPanel`'s review state (same pattern as the credit/qty inputs).
- Live client-side revalidation mirroring the builder: LP < SP < SC < LC, credit < narrower wing. Invalid → red border + submit disabled.
- Live recompute of displayed $credit / $BPR when strikes change (wing width changes).
- Edited legs: delta → `null` in `deltas` meta; a small "custom strike" marker next to the edited leg.
- Server side needs **no changes**: `PlaceCondorSchema` already accepts arbitrary positive strikes and `buildCondorOrder` already enforces structure. (This was deliberate v2.0 design slack.)

### 2b. Logged gate override
- BLOCKED state: the disabled "Entry blocked" button gains an "Override gate…" secondary action.
- Override flow: reason textarea (require ≥ 15 chars — a word isn't a reason) → proceeds to the normal review step wrapped in a persistent red banner listing the violated rule(s) verbatim from `entryGate.reasons`.
- On placement: `placeCondorOrderAction` and `recordFillAction` gain an optional `override` meta: `{ reason: string, violations: string[] }` (zod-validated, max lengths).
- `recordFillAction` prepends to the trade `notes`:
  `OVERRIDE — rules bypassed: <violations, joined>. Reason: <reason>. | v2.0 placement — journaled automatically from the confirmed fill.`
- TIGHT gates need no override (button already enabled); override applies to BLOCKED only.

### Does NOT (v2.1)
- No expiration editing (strikes only — changing expiration invalidates the whole scan; rescan instead).
- No asymmetric-wing or non-condor structures.
- No chain-existence pre-validation (open question).
- No override analytics view (the journal notes are queryable; a report is future scope).

## 3. Files
- `components/scanner/PlaceOrderPanel.tsx` — both features (state additions: `strikes` editable state, `override` sub-state before review).
- `app/dashboard/order-actions.ts` — `PlaceCondorSchema` + `recordFillAction` gain optional `override` meta; notes composition.
- `lib/schwab/order-ticket.ts` / tests — **no changes expected** (structure validation already there). If any change is needed, add golden tests, don't relax existing ones.

## 4. Testing
- Pure: none new required in the builder (already covers structural rejection). Add unit tests only if notes-composition is extracted into a pure helper (recommended: `composeFillNotes(override?) → string` in a pure module, 3–4 tests).
- Manual: (a) edit a strike to violate ordering → submit disabled with red border; (b) edit to a non-existent strike → Schwab rejection surfaces in the error state, nothing journaled; (c) override a BLOCKED card end-to-end on an unfillable-credit order (L3-style) → cancel → confirm no journal write; (d) full override + tiny fill only if a Layer-4-style validation is wanted (optional — the notes path can be verified with (c) + a manual `recordFillAction` fixture test instead).

## 5. Open questions (resolve at pickup)
1. Pre-validate edited strikes against the chain? The scanner result doesn't carry the full chain today; would need a chain fetch in the panel or a new field on `ScannerResult`. Default: skip, accept submit-time rejection.
2. Should override reasons also be surfaced on the TradeCard (a red "OVERRIDE" badge parsed from notes), or is the notes text enough for v2.1? Default: notes only.
3. Minimum reason length — 15 chars proposed; confirm.

## Pickup Checklist

```
Starting SteelEagle v2.1 — panel leg editing + logged gate override.

Read first:
- steeleagle-v2-1-panel-editing-override-spec.md  (this doc)
- steeleagle-session-11-summary.md                 (v2.0 placement + auth layer)

Prereqs that must already be true:
- Auth commit live (login works, incognito /api/scanner -> 401, crons still writing).
- v2.0 commit live; Layer 3 (unfillable + cancel) passed. Layer 4 ideally done.

Decisions on record: override = typed reason (>=15 chars) + red banner + violations
stamped into journal notes; edited strikes null their delta metadata and rely on
Schwab submit-time rejection for grid existence (no chain pre-validation).

Server contract: PlaceCondorSchema/recordFillAction gain optional
override { reason, violations[] }. Builder unchanged — do NOT relax golden tests.

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 202 passing.
2. ./node_modules/.bin/tsc --noEmit     -> no app errors (roll-alert.test.ts noise ok).
3. npm run build                        -> clean compile.
```

**End of v2.1 spec draft**
