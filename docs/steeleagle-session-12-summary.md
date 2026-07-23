# SteelEagle — Session 12 Summary

**Date:** July 22, 2026
**Milestone:** v2.1 Panel Leg Editing + Logged Gate Override — SHIPPED, live-verified in prod
**Branch:** main (no feature branches; git is the rollback)

---

## What Was Accomplished

### 0. v2.0 checklist closed out (pre-session state)
Items 1–4 of the Session 11 checklist were completed before this session: auth commit live and verified, v2.0 commit live, Neon password rotated, Layer 3 passed (unfillable order → WORKING → cancel → confirmed in TOS). **Layer 4 was deliberately skipped** (April's call, risk-assessed): L3 already validated the capital-risk half (place/working/cancel); what L4 uniquely tests is `recordFillAction`'s fill parsing, whose failure modes are all recoverable (hard-refusal by design; importer/manual fallbacks; no fabricated data can reach the journal). **Consequence: the first real production fill IS Layer 4** — verify that journal entry against the TOS fill confirmation (per-leg prices, net credit, BPR, order id) before trusting the auto-journal path. Spec §8 #5 (4-leg fill semantics) stays open until then.

### 1. v2.1 Feature A — Editable strikes in the review step
`PlaceOrderPanel` review state: all four strikes are editable inputs, initialized from the scan.
- Client revalidation mirrors the builder's guardrails: LP < SP < SC < LC; credit < **narrower** wing. Invalid → red border + submit disabled, with explicit error lines.
- Live recompute of $credit / $BPR. **BPR display uses the WIDER wing** (max loss) — matches `recordFillAction`'s `initialBpr` (`Math.max` of the two wings). When edits make wings asymmetric, the summary line shows `wings XP/YC`.
- Edited legs: amber "custom" marker + a Δ-abandoned warning; **edited legs null their delta** in everything sent to the server (both `placeCondorOrderAction` and `recordFillAction` deltas) — a stale delta is worse than no delta.
- No chain pre-validation (spec §5 #1 resolved to the default): a non-existent strike is rejected by Schwab at submit time — **confirmed live**: synchronous 400, `"Could not resolve instrument [asset type: OPTION, symbol: …]"`, surfaced legibly in the panel error state, nothing journaled.
- `Back`/`Done`/`Dismiss` now fully reset panel state (strikes, price, qty, override) — no stale custom strike can linger into a later open of the same card.

### 2. v2.1 Feature B — Logged gate override (BLOCKED only)
- Idle + BLOCKED: disabled "Entry blocked" button gains a red "Override gate…" secondary action → new `override` phase: violations listed verbatim, reason textarea (≥ **15** chars trimmed — spec §5 #3 confirmed; max 500), Proceed disabled until valid.
- Proceed → review wrapped in a persistent red banner (violations verbatim + reason on record); red strip persists through working/journaling/journaled states.
- Server contract: `PlaceCondorSchema` and `recordFillAction` gain optional `override { reason, violations[] }`, **zod-validated server-side** (`OverrideSchema`) — a hand-crafted client call cannot stamp a 3-char reason.
- Journal stamp via new pure module `lib/journal/compose-fill-notes.ts` (+5 tests): `OVERRIDE — rules bypassed: <violations; joined>. Reason: <reason>. | <v2.0 base note>`. Empty-violations fallback (`Entry gate BLOCKED`) so the zod `min(1)` can never reject a live fill; **defensive truncation to the 2000-char notes cap** so a legitimate fill can never be rejected on notes length after the money is committed.
- TradeCard shows notes only — no OVERRIDE badge (spec §5 #2 resolved to the default).
- Builder + golden tests: **untouched**, per spec hard rule.

### 3. NEW FINDING + FIX — Next.js production error redaction (discovered in manual test 6)
The off-grid-strike test produced the generic *"An error occurred in the Server Components render… message is omitted in production builds"* — the first server-action throw prod had ever seen (L3's happy path throws nothing; L4 was skipped). **Next.js redacts thrown server-action error messages in production (digest only).** Every message in `order-actions.ts` was operator-critical and being destroyed — including **"Cancel failed — CHECK THINKORSWIM"** and the `recordFillAction` refusal reasons.

**Fix (latent v2.0 defect, repo-wide principle now):**
- All four order actions return `ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }` via a single `toResult(label, fn)` wrapper — internal logic character-for-character unchanged; only the boundary changed from throw to return. `console.error` server-side preserves full stacks in Vercel logs.
- **Rule: no exported server action may throw** when its message is operator-facing. Documented in the file header.
- Panel unwraps `.ok` at all four call sites; try/catch retained only for transport-level failures. Re-ran test 6 post-fix: real Schwab 400 text now surfaces.

### 4. Fixed in passing
- **Duplicate-journal-write hazard:** the v2.0 journaling effect depended on `[phase, condor]` — a scanner refresh changing `condor` identity mid-journaling could re-fire `recordFillAction`. Deps narrowed to `[phase]` (eslint-disable is load-bearing; documented inline). Effect now fires exactly once per fill.
- Canceled-state copy: "did not fill (canceled/**rejected**/expired)" — REJECTED routes through `TERMINAL_UNFILLED` and was mislabeled.

## Verification
- `npx tsx --test "lib/**/*.test.ts"` → **207 passing** (202 baseline + 5 compose-fill-notes).
- `tsc --noEmit` clean · ESLint clean · `npm run build` clean (April, local).
- Manual tests 1–7 (spec §4 + extensions) **all passed live in prod**: ordering violation blocks submit; credit ≥ narrow wing blocks; custom marker + live recompute; Back resets; override reason gating + persistent banner; off-grid strike → legible Schwab 400, nothing journaled; override end-to-end on unfillable order → cancel → no journal write.
- **Not yet observed live:** a real fill through the v2.0/v2.1 path (auto-journal + §8 #5), and a real overridden fill's notes stamp. Both verify organically on first occurrence.

## Key Decisions
- **L4 bypassed with the first real fill designated as its validation** (rationale in §0).
- Spec §5 open questions resolved, all to defaults: no chain pre-validation; notes-only (no TradeCard badge); 15-char minimum.
- **Server actions return results, never throw** — new repo-wide error contract, same tier of learning as the stale-hash empty-body signature.
- Noted, not actioned: Schwab error strings include the account hash in the URL path (hash not raw number, app behind auth — acceptable; scrub point would be `schwabFetch` error formatting if ever wanted).

## Files
**New:** `lib/journal/compose-fill-notes.ts`, `lib/journal/compose-fill-notes.test.ts`
**Modified:** `app/dashboard/order-actions.ts` (override meta + ActionResult contract), `components/scanner/PlaceOrderPanel.tsx` (editable strikes, override flow, ActionResult unwrapping, reset semantics)
**Untouched by design:** `lib/schwab/order-ticket.ts` + golden tests

## Open Items Board (post-v2.1)
1. **§8 #5 / de-facto L4:** first real fill → verify auto-journal against TOS before trusting the path. First overridden fill → verify the notes stamp.
2. **Auto-exit cron** (50%-profit / 21-DTE auto-close): now unblocked by the execution layer, still blocked by the **Vercel Hobby cron slot** (2/2 used by IV + earnings snapshots). Needs consolidation of an existing job or a paid plan.
3. **Tech Spec materially stale** (v1.5.1 doc; v2.0 execution layer, auth layer, and v2.1 all undocumented). PRD §10 also needs the v2.0/v2.1 status flip.
4. Rate-limit doc reconciliation (internal 10/min vs public up-to-120/min) — unresolved, low priority.
5. `user_settings` still not in the committed schema file.

**Final state:** 207 tests passing · tsc/ESLint/build clean · v2.1 live-verified in prod.
