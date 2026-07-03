# SteelEagle — v2.0 Order Placement: Spec & Cold-Pickup Notes

**Version:** Spec draft v0.1 (planning artifact, not yet a session milestone)
**Date:** July 2, 2026
**Status:** Not started. This is a scoping + continuity doc so the work can be picked up cold.
**Companion docs:** `steeleagle-prd-v1-5-1.md` (§10 v2.0), `steeleagle-tech-spec-v1-5-1.md`, `steeleagle-session-10-summary.md`

> **What this is.** A pickup artifact for the first slice of the v2.0 execution line: confirmation-driven placement of a single iron condor via the Schwab Orders API. It captures the scope, the reuse inventory, the Schwab order-API specifics verified on July 2, the testing strategy (the important part — Schwab has no paper-trading API), a phased build order, and the open questions to resolve at pickup. It deliberately does **not** write any code.

---

## 1. Context & Scope

### Where this sits
This is the keystone of PRD §10 v2.0 ("Trade Execution & Continuous Sync"). It is the **first write path to Schwab** in the whole project — everything through v1.5.1 is read-only (the importer only *reads* positions + filled orders).

### Decision carried in from the July 2 planning session
The **automated exit cron** (50%-profit / 21-DTE auto-close) should **not** be built before this. Reasoning, recorded so it isn't re-litigated:

1. **It's a subset of v2.0, out of order.** The cron's whole value is placing a *closing order*. Without execution it can only write a `close` event to the journal for a position that is still open at Schwab — which **desyncs the journal from reality**, and the journal is explicitly the source of truth for what's open.
2. **It burns the last cron slot for nothing.** Vercel Hobby is at **2/2 crons** (IV + earnings). A third needs consolidation or a paid plan. Spending that slot on a cron that can't actually close anything yet is wasteful.
3. **After execution exists, it becomes trivial and sync-safe** — the cron places the closing order *and* writes the matching `close` event in one path. Cost of the cron barely changes by waiting; its value and safety change completely.

So: build order placement first. Auto-exit and continuous sync fall out of it cheaply afterward.

### Scope of THIS slice
- Confirmation-driven placement of **one iron condor** (the 4-leg core structure) as a single net-credit limit order.
- Order status readback + cancel.
- On confirmed fill, write the trade to the journal via the existing `createTrade` path.

### Does NOT (this slice)
- No auto-exit cron, no continuous/scheduled sync (both are later v2.0).
- No rolls or closes via API (phase 2 candidate — see §6).
- No market orders (limit only, consistent with the strategy's limit-order rule).
- No multi-account, no earnings-sleeve placement (core condor only to start).
- No removal of the manual workflow — this is additive; manual entry in TOS stays valid.

---

## 2. What already exists to build on (reuse inventory)

The point of this list: the *plumbing* is largely done — this slice is mostly a new order-ticket builder + a POST path wrapped around known infrastructure.

| Existing piece | Location | Reuse |
| :--- | :--- | :--- |
| OAuth + token refresh (401 → refresh, single `getAccessToken()` path) | `lib/schwab/auth.ts` / `client.ts` | Auth for the POST — unchanged. |
| Account hash (`refreshAccountHash`, `getAccountHash`) | `lib/schwab/accounts.ts` | Hash for `/accounts/{hash}/orders`. Self-healing empty-body retry already handled. |
| OCC symbol parsing (`parseOccSymbol`) | `reconstruct-positions.ts` | Reverse it to *build* the 21-char OCC leg symbols for the order. |
| Condor structure (`CondorSetup`: 4 legs, strikes, deltas, credit, wing) | `lib/strategy/condor-builder.ts` | Source of truth for what to place — feeds the ticket builder. |
| Read-side orders fetch (`getFilledOrders`, `traderGet` pattern) | `lib/schwab/orders.ts` | Same file + auth pattern; add place/cancel/status alongside. |
| Journal write (`createTrade`, `source='schwab_fill'`, `schwab_order_id`) | `lib/db/journal.ts`, `app/journal/actions.ts` | On fill, write the trade — `schwab_fill` + order id path already exists from v1.5.1. |

---

## 3. What's new (the actual build)

1. **Order-ticket builder (pure function).** `CondorSetup` → Schwab order JSON. Highest-risk, most-testable piece — a malformed 4-leg payload is the #1 failure mode. Build it as a pure function and pin with golden fixtures, exactly like `importer.ts` / `trade-math.ts`.
2. **Place / cancel / status client methods** in `lib/schwab/orders.ts` — `POST` to place, `GET /orders/{id}` for status, `DELETE /orders/{id}` to cancel. Same `traderGet`-style auth wrapper.
3. **Confirmation UI + server action.** A review-then-confirm gate (same operator-confirmed philosophy as the importer). **Critical:** Schwab performs **no server-side review** — a valid order submits and can execute immediately. Client-side confirmation is the *only* guardrail before submission.
4. **Fill → journal write.** On confirmed fill, map the order to `NewTradeInput` and call `createTrade` (`source='schwab_fill'`, real fill prices + order id).

---

## 4. Schwab Orders API reference (verified July 2, 2026)

> ⚠️ **Verify before trusting the JSON shape.** Per the canonical field-name-mismatch lesson (guessing `type`/`symbol` vs. actual `kind`/`underlying`/`putCall`), do **not** hand-write the condor order payload from memory or from this doc. The reliable path: place the exact condor once in the thinkorswim/Schwab UI, then use a codegen tool (e.g. schwab-py's `schwab-order-codegen.py`, which emits the JSON for your most recently placed order) to get the *canonical* payload, and mirror that. Treat the skeleton below as orientation only.

### Endpoints (base: `https://api.schwabapi.com/trader/v1`)
| Verb | Path | Purpose |
| :--- | :--- | :--- |
| POST | `/accounts/{hash}/orders` | Place order (201; order id in `Location` header). |
| GET | `/accounts/{hash}/orders/{orderId}` | Order status / detail. |
| DELETE | `/accounts/{hash}/orders/{orderId}` | Cancel a working order. |
| PUT | `/accounts/{hash}/orders/{orderId}` | Replace (cancel+re-place). |
| POST | `/accounts/{hash}/previewOrder` | **Unverified** — see gotcha below. |

### Representative condor payload (orientation only — verify via codegen)
A condor goes as **one** order, not four. Rough shape:
- `orderStrategyType: "SINGLE"`
- `complexOrderStrategyType: "IRON_CONDOR"`  ← verify exact accepted value
- `orderType: "NET_CREDIT"` with a `price` (the target credit)  ← verify
- `duration: "DAY"`, `session: "NORMAL"`
- `orderLegCollection`: 4 legs, each `{ instruction, quantity, instrument: { assetType: "OPTION", symbol: <OCC 21-char> } }`
  - Long put: `BUY_TO_OPEN` · Short put: `SELL_TO_OPEN` · Short call: `SELL_TO_OPEN` · Long call: `BUY_TO_OPEN`

### Gotchas
- **No review step.** A successfully-formed order is submitted immediately; there is no built-in dry-run/confirm on Schwab's side. This is why the testing layers in §5 matter and why client confirmation is mandatory.
- **Price is a string under the hood** with truncation quirks (values < 1 truncate to 4 dp, others to 2 dp). Consider passing price as an explicit pre-formatted string to avoid surprise rounding on the credit.
- **`previewOrder` may not exist / work for this app.** Community wrappers describe placeOrder as having no review process. Do **not** assume a working preview/dry-run endpoint — confirm against the current Schwab order docs at pickup; if absent, §5 Layer 3 (unfillable limit + cancel) is the substitute.
- **Rate-limit discrepancy to resolve.** Tech spec v1.5.1 notes orders throttled **10/min/account**; public sources cite up to **120/min** for PUT/POST/DELETE (GET unthrottled, adjustable 0–120 at app config). Not load-bearing for single manual placements, but reconcile the doc before any batch/auto-close work.

---

## 5. Testing strategy — the core of this doc

**Schwab has no paper-trading API.** There is a *sandbox*, but it is synthetic-data-only for validating auth, token refresh, and request/response shapes — **it is not a paper trading account and does not simulate fills.** Schwab support has confirmed the API is live-trading only. So the safe path is layered: cheapest/safest first, real money only at the very end and only trivially.

**Layer 1 — Unit-test the ticket builder (zero risk; most of the safety).**
Pure `CondorSetup → order JSON` function pinned with golden fixtures. Catches the malformed-payload failure class entirely offline. This is where the bulk of defect-catching lives, and it costs nothing. Prioritize it.

**Layer 2 — Sandbox app + preview (shape validation, no fills).**
A **separate** sandbox app (distinct credentials; only the base URL changes) to confirm auth/token plumbing and that the payload is accepted against synthetic accounts. Use `previewOrder` here *if* it turns out to be live. Neither validates real fill behavior.

**Layer 3 — Unfillable limit order on the live account + cancel (full write path, ~zero fill risk).**
The workhorse for a live-only API. Place a **real** order priced so it can never fill — since the condor is sold for a net *credit*, ask for an absurdly high credit no counterparty will take. Then exercise the whole loop: POST → GET status (expect WORKING/QUEUED) → DELETE. Do it **after hours** for extra margin and confirm the cancel lands. (This is independently the method the schwabr community recommends for the same reason.)

**Layer 4 — Exactly one tiny real fill, once (a few dollars).**
The one thing Layers 1–3 can't exercise is `fill → position → journal-sync`. Close it with a single genuinely-fillable but trivial order (one deep-OTM cheap contract, or 1 share of a low-priced ETF): let it fill, confirm it surfaces in `/positions` and reconstructs correctly, then close it. Budget a few dollars of commission/slippage as the cost of validating the real end-to-end path. Do this **once**, deliberately — not as routine testing.

> **Key insight:** Layer 1 is most of the safety and it's free. Because Schwab does no server-side review, client confirmation + these layers are the *entire* guardrail. If the ticket builder is a well-tested pure function, Layers 3–4 are just confirming plumbing around a payload you already trust — keeping real-money exposure to a single-digit-dollar, one-time check rather than an open-ended "test in prod" phase like the importer had.

---

## 6. Suggested build order (phased)

- **Phase A — Ticket builder + tests (no creds).** Pure `buildCondorOrder(setup)` + golden-fixture tests. First step, immediately verifiable, de-risks everything after. (Mirrors the "pure modules first" build order.)
- **Phase B — Client methods + Layer 3 validation.** `placeOrder` / `getOrder` / `cancelOrder` in `lib/schwab/orders.ts`; validate with the unfillable-limit + cancel loop after hours.
- **Phase C — Confirmation UI + server action.** Review-then-confirm gate; `placeOrderAction` (zod-validated), operator-confirmed. No auto-submit.
- **Phase D — Fill → journal + Layer 4 validation.** On confirmed fill, `createTrade` (`schwab_fill` + order id). Validate once with a tiny real fill.
- **Later (not this slice):** roll/close via API → then the **auto-exit cron** becomes a trivial, sync-safe add (place close order + write `close` event together). Continuous fill sync is the successor to the v1.5.1 importer.

---

## 7. Effort estimate

**1–2 sessions for a trustworthy first slice.** The prior happy-path estimate (~4–5h) holds for the read-plumbing-reuse reasons above, but this is the first write path and **can't be live-fire tested in prod the way the importer was** (a bad order places real money). The delta over happy-path is: golden-fixture ticket tests, order-status polling, rejection/partial-fill handling, and the confirmation UI. That pushes a *reliable* first slice toward the upper end. Phase A alone is a short, satisfying, zero-risk first sitting if you want a small entry point.

---

## 8. Open questions / verify at pickup

1. **Canonical condor order JSON** — exact `complexOrderStrategyType` value, `NET_CREDIT` vs. limit handling, per-leg instructions. Resolve via UI-place + codegen, not memory.
2. **`previewOrder`** — does it exist and work for this app? If yes, it simplifies Layer 2/3.
3. **Real order rate limit** — reconcile 10/min (own doc) vs. up-to-120/min (public).
4. **Write scope confirmed in practice** — April confirms the OAuth scope has trading write; confirm end-to-end in Layer 3 (first real POST).
5. **Partial-fill semantics for a 4-leg order** — does the condor fill atomically or can legs fill independently? Confirm before trusting the fill→journal mapping.
6. **Fill readback strategy** — poll `GET /orders/{id}` after placement vs. lean on the next positions import. Poll is cleaner for immediate journal write.
7. **Cron-slot constraint for the eventual auto-exit** — Vercel Hobby is 2/2 crons; the auto-exit cron needs consolidation or a plan bump when its turn comes.

---

## Pickup Checklist for Next Session

```
Starting SteelEagle v2.0 — Order Placement (first Schwab write path).

Read first:
- steeleagle-v2-order-placement-spec.md   (this doc)
- steeleagle-session-10-summary.md         (importer; read-side orders + createTrade path)
- steeleagle-tech-spec-v1-5-1.md §5, §7    (positions/orders routes, importer edge cases)

Decision on record: build order placement BEFORE the auto-exit cron. The cron is a
v2.0 subset that desyncs the journal if built without execution, and would burn the
last Vercel cron slot (2/2 used). It becomes trivial + sync-safe AFTER execution.

Reuse: OAuth/token, account hash, parseOccSymbol (reverse to build leg symbols),
CondorSetup, lib/schwab/orders.ts (add place/cancel/status next to getFilledOrders),
createTrade(source='schwab_fill', schwab_order_id).

Schwab: live-trading only (NO paper API). Sandbox = synthetic data / shape validation,
not fills. NO server-side order review — a valid order submits immediately.

Testing ladder:
  L1 pure ticket-builder golden tests (zero risk — do most of the work here)
  L2 sandbox app + previewOrder (if it exists) — shape only
  L3 unfillable limit (absurd credit) on live acct + cancel, after hours — full write path
  L4 one tiny real fill, once — fill -> positions -> journal sync

Build order: A ticket builder+tests -> B client methods+L3 -> C confirm UI+action -> D fill->journal+L4.

Before writing the payload: place the condor once in TOS and codegen the exact JSON
(schwab-py schwab-order-codegen.py). Do NOT hand-write it from memory (field-name-mismatch lesson).

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"        -> expect 172 passing (baseline).
2. ./node_modules/.bin/tsc --noEmit          -> no app errors.
3. npm run build                             -> clean compile.
```

---

**Sources consulted (July 2, 2026) — verify against current Schwab docs before building:**
- Schwab Developer Portal — sandbox is synthetic-data testing, not paper trading (developer.schwab.com/user-guides).
- Schwab API is live-trading only, no paper trading (Schwab support, per community reports).
- Order endpoint paths, cancel via DELETE, order JSON skeleton (`orderStrategyType`/`orderLegCollection`), price-as-string truncation, "no review process" warning (schwab-py + schwabr wrapper docs; archived Schwab order samples).
- Order rate limits (up to 120/min PUT/POST/DELETE, GET unthrottled) — reconcile with own tech spec's 10/min note.

**End of v2.0 Order Placement spec draft**
