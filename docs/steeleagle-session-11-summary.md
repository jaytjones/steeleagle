# SteelEagle — Session 11 Summary

**Date:** July 12, 2026
**Milestone:** v2.0 Order Placement (first Schwab write path) — code-complete, pending local build + Layer 3/4 live validation
**Branch:** main (feature-branch approach explicitly dropped this session; rollback via git)

---

## What Was Accomplished

### 0. Canonical order JSON recovered from a live Schwab record (spec §8 #1 — RESOLVED)
An unfillable SPY condor (SC 850 / LC 860 / SP 650 / LP 640, NET_CREDIT $8.00, DAY, PENDING_ACTIVATION) was placed in thinkorswim and read back verbatim via `scripts/dump-working-orders.ts` (new; reuses `traderGet` + cached hash, fetches 2 days of orders with **no** status filter). Confirmed:
- `orderStrategyType: "SINGLE"`, `complexOrderStrategyType: "IRON_CONDOR"`, `orderType: "NET_CREDIT"` + top-level `price`, `duration: "DAY"`, `session: "NORMAL"`.
- Minimal leg shape: `{ instruction, quantity, instrument: { assetType: "OPTION", symbol: <OCC 21-char> } }`. Everything else in the readback is echo, never POSTed.
- TOS leg order: SC, LC, SP, LP — mirrored in the builder.

### 1. Phase A — `lib/schwab/order-ticket.ts` (+ 22 tests)
Pure builder: `buildCondorOrder(input, { quantity, price }) → CondorOrderTicket`. Golden fixture **deep-equals + JSON.stringify-equals** the stripped live record. Also `buildOccSymbol` (exact inverse of `parseOccSymbol`, round-trip tested incl. fractional strikes like UVXY 22.5) and `formatOrderPrice` (Schwab truncation rules: <$1 → 4dp, ≥$1 → 2dp, truncate-not-round, float-artifact safe). Guardrails throw on: strike-order violations, credit ≥ narrower wing, bad quantity/price/expiration. Input is a structural `CondorOrderInput` — `CondorSetup` satisfies it (compile-time-proven), and the server action reconstructs it from validated primitives.

### 2. Phase B — write client + order methods
- `lib/schwab/client.ts`: replaced the **unused** `traderPost` (it routed through `schwabFetch`, whose empty-body guard would have **thrown on a successful 201**, and it couldn't expose the Location header) with `traderWrite(method, path, body?) → { status, location, body }`. The empty-body guard remains untouched for reads — it exists for the stale-hash signature; writes legitimately return empty bodies.
- `lib/schwab/orders.ts`: `placeOrder` (order id parsed from the Location header; a 2xx with an unparseable id throws a "CHECK THINKORSWIM — order may be working" error), `getOrder`, `cancelOrder`. Unlike `getFilledOrders`, these do NOT degrade gracefully — write failures surface loudly. `SchwabExecutionLeg` gained optional `quantity` for fill weighting.

### 3. Phases C+D — `app/dashboard/order-actions.ts` + `components/scanner/PlaceOrderPanel.tsx`
- `placeCondorOrderAction`: zod (`PlaceCondorSchema`) → rebuild ticket server-side → `placeOrder`. Client-supplied ticket objects are never forwarded.
- `getOrderStatusAction` / `cancelCondorOrderAction` (cancel reads back the terminal state; a fill that lands before the cancel routes to journaling).
- `recordFillAction` (Phase D): requires `status === FILLED` **and** full quantity; extracts per-leg fills as quantity-weighted averages by `legId`; maps legs via `parseOccSymbol` + instruction; computes `initialBpr = wingWidth×100×contracts − net credit $`; writes via existing `createTrade` (`source='schwab_fill'`, order id, `sleeve='core'`). **Refuses to journal** on partial fills (→ resolve at Schwab) or missing execution detail (→ use the importer's marks-only path) — never fabricates prices into the journal.
- `PlaceOrderPanel`: ImportButton-style state machine (`idle → review → placing → working → journaling → journaled | canceled | error`). Review step shows all 4 legs, editable credit/qty, live $credit/$BPR, and the "submits immediately — no Schwab review" warning; red explicit **Submit to Schwab** button. Working state polls every 3s (cap ~2 min) with Cancel. Wired into `ScannerCard` on PASS cards only; disabled when the entry gate is BLOCKED.

---

## Key Decisions
- **Feature branch dropped** — everything lands on main (April's call; git is the rollback). Consequence: **Phase C/D must not be pushed until Vercel Deployment Protection is enabled** — the app has no auth, and post-push the public URL exposes a live order-placement path, not just read-only data.
- **Golden fixture is a live record, not docs.** If the fixture tests ever "need fixing," re-derive from a fresh TOS order via the dump script — never edit the fixture from memory.
- **Partial fills and missing execution detail are hard refusals** in `recordFillAction` (spec §8 #5 stays open until observed live; the importer is the designed fallback).
- **`traderPost` replaced, not extended** — it was dead code with semantics that break on successful order writes.

## Verification
- `npx tsx --test "lib/**/*.test.ts"` → **194 passing** (172 baseline + 22 order-ticket).
- `tsc --noEmit` → clean (only the pre-existing `roll-alert.test.ts` noise).
- ESLint → clean on all 7 touched files.
- `next build` → **NOT run to completion** (sandbox couldn't reach Google Fonts). **April: run `npm run build` locally before pushing.**

## Remaining — April's checklist (in order)
1. **Auth layer first, as its own commit** (see §4 below): generate secrets (`openssl rand -hex 32` for `AUTH_SECRET`; a long passphrase for `APP_PASSWORD`), add both to Vercel env (Production) **and** `.env.local`, drop in the 5 auth files, run the gates, push. Verify: login works, dashboard/journal load, `/api/scanner` 401s in an incognito tab, and — next weekday — both crons still wrote rows (`/api/cron/*` is exempt from the middleware because Vercel's invocations carry `CRON_SECRET`, not a cookie).
2. Then commit the v2.0 files; run the three local gates (tests / tsc / build — build couldn't run in the sandbox, fonts unreachable).
3. **Rotate the Neon `neondb_owner` password** (pasted in-chat this session) and update `.env.local`; verify prod still loads.
4. **Layer 3:** after hours, use the panel on a PASS card with an absurd credit (e.g. 9.90 on $10 wings) → confirm WORKING → Cancel → confirm canceled in TOS.
5. **Layer 4, once:** one genuinely fillable trivial order → confirm fill → auto-journal → verify on /journal and in `/api/positions`.
6. Open items: spec §8 #3 (rate-limit doc reconciliation), #5 (observe 4-leg fill semantics during L4), eventual auto-exit cron (unblocked once this ships; still needs a cron slot).

## Next Milestone (decided end of session): v2.1 — Panel Leg Editing + Logged Gate Override
See `steeleagle-v2-1-panel-editing-override-spec.md`. Two additions to `PlaceOrderPanel`, shipped together: (1) editable strikes in the review step (client revalidation mirrors the builder; edited legs null their delta metadata; strike-grid existence is left to Schwab submit-time rejection); (2) a high-friction override for BLOCKED gates — typed reason (≥15 chars), persistent red banner, violations + reason stamped into the trade's journal notes. Decision on record: the override must exist (TOS already is one) but never be frictionless, and every use must be self-documenting in the journal. Server contract: optional `override { reason, violations[] }` on `PlaceCondorSchema` / `recordFillAction`; the ticket builder and its golden tests are unchanged. Prereq: v2.0 L3 passed.

### 4. Session Auth Layer (pre-v2.0 security — built this session)
Decision reversal with cause: Vercel's free Standard Protection on Hobby **does not protect the production domain** — steeleagle.vercel.app would stay public (Pro/Enterprise required; Password Protection is a paid add-on). So protection is app-level instead:
- `lib/auth/session.ts` (+ 8 tests) — signed session tokens (`<expiresMs>.<hmac>`), **Web Crypto HMAC** (edge-safe; middleware has no node:crypto), 30-day TTL, fail-closed on missing/short `AUTH_SECRET`, digest-based constant-time compare.
- `middleware.ts` — gates every page, API route, and server action (actions are POSTs to page routes, so the v2.0 order actions are covered). Exemptions: `/login` and `/api/cron/*` (cron invocations carry `CRON_SECRET`, not a cookie — gating them would silently kill both snapshot jobs). The Schwab OAuth callback is deliberately NOT exempt: Schwab redirects the operator's own cookie-carrying browser there.
- `app/login/{page,actions}.tsx/ts` — single password field (terminal aesthetic), constant-time check vs `APP_PASSWORD`, 1.5s flat delay on failure, HttpOnly/secure/lax cookie.
- Consequence: `/api/journal` and `/api/settings` are no longer "public-but-unguessable" — the Tech Spec §6 caveat is retired.
- New env vars: `APP_PASSWORD`, `AUTH_SECRET` (rotating `AUTH_SECRET` logs out all sessions).

## Files
**New (v2.0):** `lib/schwab/order-ticket.ts`, `lib/schwab/order-ticket.test.ts`, `app/dashboard/order-actions.ts`, `components/scanner/PlaceOrderPanel.tsx`, `scripts/dump-working-orders.ts`
**New (auth):** `middleware.ts`, `lib/auth/session.ts`, `lib/auth/session.test.ts`, `app/login/page.tsx`, `app/login/actions.ts`
**Modified:** `lib/schwab/client.ts` (traderPost → traderWrite), `lib/schwab/orders.ts` (place/get/cancel + execution-leg quantity), `components/scanner/ScannerCard.tsx` (panel wiring)

**Final verification (both layers):** 202 tests passing (172 baseline + 22 order-ticket + 8 auth) · `tsc --noEmit` clean · ESLint clean on all touched files · `next build` pending locally.
