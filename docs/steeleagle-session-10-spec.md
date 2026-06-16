# SteelEagle — Session 10 Spec
## Feature: Schwab Position Importer → Trade Journal

**Version:** Session 10 Spec v1.0
**Date:** June 15, 2026
**Preceded by:** Session 9 (v1.5 Trade Journal — manual entry, full vertical slice)
**Milestone label:** v1.5.1 — Schwab Import

---

## 1. Goal

Provide a one-time bootstrapping flow that pulls currently open iron condor positions from the Schwab API, enriches them with historical order fill data where available, and pre-populates the trade journal via the existing `createTradeAction` path. After this session, the operator can import all open positions into the journal in a single confirmation step rather than manually re-entering each 4-leg structure.

This is the **stepping stone** between the fully manual v1.5 journal and the v2.0 Schwab-fill auto-importer described in the Session 9 horizon notes. It shares auth, schema, and DB layer with both ends — no migrations, no new dependencies.

---

## 2. Scope

### In scope
- Fetch open option positions from `/trader/v1/accounts/{hash}/positions` (already called by `/api/positions`)
- Fetch recent order history from `/trader/v1/accounts/{hash}/orders` (new Schwab endpoint, same auth)
- Group raw position legs into candidate iron condors
- Match each candidate condor to its originating filled order where possible
- Render a confirmation UI on `/journal` where the operator reviews candidates, corrects prices if needed, and confirms imports
- Call `createTradeAction` for each confirmed import — identical to the manual form path, no new DB writes

### Out of scope
- Automatically importing without confirmation (operator always reviews before committing)
- Importing partial positions (fewer than 4 legs remaining after partial closes) — surface as warnings, not imports
- Ongoing / scheduled sync (this is a one-time bootstrap tool; continuous sync is v2.0)
- Importing non-iron-condor positions (covered calls, naked puts, stock) — filter out silently
- Earnings sleeve positions — the earnings journal is future scope; these are excluded from this importer

---

## 3. Schwab API Surface

### 3.1 Positions endpoint (already used)

```
GET /trader/v1/accounts/{hash}?fields=positions
```

Already called by `lib/schwab/accounts.ts`. The response includes an array of position objects. Each option position contains:

```jsonc
{
  "instrument": {
    "assetType": "OPTION",
    "symbol": "SPY  250117C00580000",   // OCC symbol
    "putCall": "CALL",
    "underlyingSymbol": "SPY",
    "strikePrice": 580.0,
    "expirationDate": "2025-01-17"
  },
  "longQuantity": 0,
  "shortQuantity": 1,
  "averagePrice": 1.85,                  // average fill price per share
  "marketValue": -185.0,
  "currentDayProfitLoss": 12.0
}
```

Key fields for the importer: `instrument.putCall`, `instrument.underlyingSymbol`, `instrument.strikePrice`, `instrument.expirationDate`, `longQuantity`, `shortQuantity`, `averagePrice`.

Note: `averagePrice` is the average fill price across all fills for this position — this is the value to use as the leg price when order-history matching fails (Mode A fallback).

### 3.2 Orders endpoint (new)

```
GET /trader/v1/accounts/{hash}/orders
  ?fromEnteredTime=YYYY-MM-DDT00:00:00.000Z
  &toEnteredTime=YYYY-MM-DDT23:59:59.999Z
  &status=FILLED
```

Returns filled orders within a date range. The importer will use a 90-day lookback window (covers all realistic open TOMIC positions given the 30–45 DTE entry + 21 DTE exit discipline). Each filled order contains:

```jsonc
{
  "orderId": 123456789,
  "enteredTime": "2025-01-03T10:31:00+00:00",
  "orderLegCollection": [
    {
      "instrument": {
        "assetType": "OPTION",
        "symbol": "SPY  250117C00580000",
        "putCall": "CALL",
        "underlyingSymbol": "SPY",
        "strikePrice": 580.0,
        "expirationDate": "2025-01-17"
      },
      "instruction": "SELL_TO_OPEN",   // BUY_TO_OPEN / SELL_TO_OPEN
      "quantity": 1
    }
    // ... 3 more legs for an iron condor order
  ],
  "orderActivityCollection": [
    {
      "executionLegs": [
        {
          "legId": 1,
          "price": 1.85,               // actual fill price per share for this leg
          "time": "2025-01-03T10:31:04+00:00"
        }
        // ... one executionLeg per orderLeg
      ]
    }
  ]
}
```

Key fields: `orderId`, `enteredTime`, `orderLegCollection[].instrument.symbol` (for matching to positions), `orderLegCollection[].instruction` (to derive long/short), `orderActivityCollection[0].executionLegs[].price` (actual fill prices).

**Rate limit note:** The `/orders` endpoint is throttled at 10 requests/min/account (per Tech Spec v1.2 §1). The importer makes exactly 1 call to this endpoint per import session — well within limits.

---

## 4. New Types

Add to `lib/journal/types.ts`:

```typescript
/** Fidelity of price data available for an import candidate. */
type ImportConfidence = 'matched' | 'marks_only';

/**
 * A single option leg as parsed from the Schwab positions response.
 * Intermediate type used only inside the importer pipeline.
 */
type RawPositionLeg = {
  occSymbol: string;           // e.g. "SPY  250117C00580000"
  underlying: string;          // e.g. "SPY"
  putCall: 'PUT' | 'CALL';
  strike: number;
  expiration: string;          // "YYYY-MM-DD"
  longQty: number;
  shortQty: number;
  averagePrice: number;        // per-share fill average from Schwab position
};

/**
 * A 4-leg iron condor candidate assembled from position legs,
 * optionally enriched with order-history fill data.
 */
type ImportCandidate = {
  /** Unique key for React rendering and confirmation tracking. */
  candidateId: string;          // e.g. "SPY-2025-01-17"
  underlying: string;
  expiration: string;           // "YYYY-MM-DD"
  contracts: number;            // quantity (all legs assumed equal)

  longPut:   ImportLeg;
  shortPut:  ImportLeg;
  shortCall: ImportLeg;
  longCall:  ImportLeg;

  /**
   * 'matched'    — prices from order history; openDate from order enteredTime.
   * 'marks_only' — prices from averagePrice on position; openDate is null.
   */
  confidence: ImportConfidence;
  openDate: string | null;      // ISO date string; null when confidence = 'marks_only'
  schwabOrderId: number | null; // populated when confidence = 'matched'
};

type ImportLeg = {
  action: 'BUY' | 'SELL';
  putCall: 'PUT' | 'CALL';
  strike: number;
  /** Per-share price. From order history fill if matched; averagePrice fallback. */
  price: number;
};

/**
 * The full response shape of GET /api/journal/import-candidates.
 */
type ImportCandidatesResponse = {
  candidates: ImportCandidate[];
  /** Positions that had option legs but didn't form a clean 4-leg condor. */
  incomplete: IncompletePosition[];
  /** Candidates already present in the journal (matched by underlying + expiration). */
  alreadyImported: ImportCandidate[];
};

type IncompletePosition = {
  underlying: string;
  expiration: string;
  legsFound: number;   // 1, 2, or 3
  reason: string;      // human-readable explanation
};
```

---

## 5. New Files

### 5.1 `lib/schwab/orders.ts` — Schwab orders fetcher

Single exported function. Wraps the `/orders` endpoint with the same `getValidAccessToken()` + fetch pattern as `lib/schwab/accounts.ts`.

```typescript
/**
 * Fetch filled orders from Schwab for the past `lookbackDays` calendar days.
 * Returns the raw Schwab order array — parsing is done in the importer.
 */
export async function getFilledOrders(
  accountHash: string,
  lookbackDays: number = 90
): Promise<SchwabOrder[]>
```

Internal type `SchwabOrder` mirrors the Schwab JSON shape described in §3.2. Only the fields used by the importer need to be typed — `orderId`, `enteredTime`, `orderLegCollection`, `orderActivityCollection`.

Error handling: if the orders endpoint returns a non-200 (e.g., the account has no order history, or a permission scope issue), log and return `[]` — the importer degrades to marks-only mode rather than failing the whole import.

### 5.2 `lib/journal/importer.ts` — grouping and matching logic

Pure functions, no I/O. Testable in isolation.

```typescript
/**
 * Parse Schwab position data into flat RawPositionLeg objects.
 * Filters out non-option positions and positions with 0 net quantity.
 */
export function parsePositionLegs(schwabPositions: unknown[]): RawPositionLeg[]

/**
 * Group RawPositionLegs into ImportCandidates.
 *
 * Grouping key: underlying + expiration.
 * A valid condor group has exactly 4 legs: 1 LP, 1 SP, 1 SC, 1 LC.
 * Identification rules:
 *   - Short put  = PUT  with shortQty > 0, lower strike
 *   - Long put   = PUT  with longQty  > 0, lower strike (below short put)
 *   - Short call = CALL with shortQty > 0, lower strike
 *   - Long call  = CALL with longQty  > 0, higher strike (above short call)
 * Groups with != 4 legs go into IncompletePosition[].
 * All legs in a group must have equal qty — mismatched qty → IncompletePosition.
 */
export function groupIntoCondors(
  legs: RawPositionLeg[]
): { candidates: ImportCandidate[]; incomplete: IncompletePosition[] }

/**
 * Enrich candidates with order-history fill data where a match is found.
 *
 * Matching strategy:
 *   For each candidate, search filledOrders for a FILLED order whose
 *   orderLegCollection contains all 4 OCC symbols present in the candidate legs.
 *   If found: set confidence = 'matched', populate openDate from enteredTime,
 *   schwabOrderId from orderId, and override each leg's price from the
 *   corresponding executionLeg fill price.
 *   If not found: leave confidence = 'marks_only', openDate = null,
 *   schwabOrderId = null, prices from averagePrice (already set by grouper).
 *
 * Note: a candidate may have been entered as multiple separate 2-leg orders
 * (a common workflow — enter the put spread, then the call spread). In this
 * case the matcher finds 2 orders; it uses the earlier enteredTime as openDate
 * and sums prices from both orders' executionLegs. This is noted in the
 * candidate's confidence as 'matched' but a boolean `splitOrder: true` flag
 * is added to signal the UI to show a "(2 orders)" annotation.
 */
export function enrichWithOrderHistory(
  candidates: ImportCandidate[],
  filledOrders: SchwabOrder[]
): ImportCandidate[]

/**
 * Filter out candidates already in the journal.
 * Match on underlying + expiration against open trades in the DB.
 */
export function deduplicateCandidates(
  candidates: ImportCandidate[],
  openJournalTrades: { underlying: string; currentExpiration: string }[]
): { fresh: ImportCandidate[]; alreadyImported: ImportCandidate[] }
```

**Why pure functions:** The matching and grouping logic has real edge-case complexity (split orders, partial closes, mismatched quantities). Pure functions mean it can all be unit-tested without mocking Schwab or the DB. Follow the `trade-math.ts` pattern.

### 5.3 `app/api/journal/import-candidates/route.ts` — new API route

```
GET /api/journal/import-candidates
```

Orchestrates the pipeline:

1. `getValidAccessToken()` → bail with 401 if expired
2. `getAccountHash()` from DB
3. Fetch positions via existing `lib/schwab/accounts.ts` call
4. `parsePositionLegs()` → filter to options only
5. `groupIntoCondors()` → candidates + incomplete
6. `getFilledOrders(hash, 90)` → raw order array
7. `enrichWithOrderHistory(candidates, orders)`
8. `listTrades({ status: 'open' })` → existing journal trades
9. `deduplicateCandidates(enriched, openTrades)` → fresh + alreadyImported
10. Return `ImportCandidatesResponse`

Response shape: `ImportCandidatesResponse` (§4).

Error handling: each step is wrapped independently. Orders fetch failure → degrade to marks-only (step 7 returns `[]`). If positions fetch fails entirely → 502 with descriptive message.

### 5.4 `app/journal/actions.ts` — extend with `importTradesAction`

Add alongside the existing `createTradeAction` / `rollTradeAction` / `closeTradeAction`:

```typescript
/**
 * Bulk-import confirmed candidates into the journal.
 * Each candidate maps to exactly one createTrade() DB call.
 * Candidates are imported sequentially (not parallel) to avoid
 * transaction contention on the Neon WebSocket pool.
 * Returns the refreshed trade list on success.
 */
export async function importTradesAction(
  candidates: ImportCandidate[]
): Promise<Trade[]>
```

Internally, for each candidate, this constructs a `NewTradeInput` and calls the existing `createTrade()` DB function. The mapping:

| `ImportCandidate` field | → `NewTradeInput` field |
| :--- | :--- |
| `underlying` | `symbol` |
| `openDate ?? today's date` | `openDate` |
| `expiration` | `expiration` |
| `contracts` | `contracts` |
| `confidence === 'matched' ? 'schwab_import' : 'manual'` | `source` on each `trade_event` |
| `schwabOrderId` | `schwabOrderId` on each `trade_event` |
| legs → `NewTradeInput.legs[]` | one leg per `ImportLeg` |

Note: `'schwab_import'` is a new valid value for the `source` column. Since `source` is a `text` column (not a Postgres enum — confirmed in Session 9 notes where it's described as a free-text field with `'manual'` hardcoded), **no migration is required.** Just use the string `'schwab_import'` in the insert.

---

## 6. UI: Import Flow on `/journal`

### 6.1 Entry point

Add an **"↓ Import from Schwab"** button to the `/journal` page header, placed to the right of the existing `+ New Trade` toggle. The button is always visible (not gated on whether open positions exist — the operator may not know without checking).

### 6.2 Import flow states

The import UI lives inline on the `/journal` page as a collapsible panel (same pattern as the `+ New Trade` toggle). It does not navigate away or open a modal.

```
[Idle]
  ↓ user clicks "↓ Import from Schwab"

[Loading]
  "Fetching open positions from Schwab..."
  Spinner. Button disabled.

[Review]
  Panel expands showing:
  - ImportCandidateReviewPanel (see §6.3)

[Confirming]
  "Importing N trades..."
  Spinner. Confirm button disabled.

[Done]
  Panel closes. Trade list refreshes.
  Toast: "N trade(s) imported successfully."
  If any failed: "N imported, M failed — see console."

[Error]
  Inline error message with retry button.
  "Could not fetch positions from Schwab. Check your connection and try again."
```

### 6.3 `ImportCandidateReviewPanel` component

Located at `components/journal/ImportCandidateReviewPanel.tsx`.

**Structure:**

```
┌─────────────────────────────────────────────────────────┐
│  IMPORT FROM SCHWAB                              [✕ Cancel] │
├─────────────────────────────────────────────────────────┤
│  Found 3 open condors. Review prices and confirm.        │
│                                                          │
│  ┌─── ImportCandidateCard ──────────────────────────┐   │
│  │  SPY  ·  Exp 2025-01-17  ·  1 contract           │   │
│  │  ✓ MATCHED  (order #123456789 · Jan 3, 2025)     │   │
│  │                                                   │   │
│  │  Leg        Strike   Action   Price               │   │
│  │  Long Put   560      BUY      $0.42  [__________] │   │
│  │  Short Put  565      SELL     $0.88  [__________] │   │
│  │  Short Call 580      SELL     $0.97  [__________] │   │
│  │  Long Call  585      BUY      $0.45  [__________] │   │
│  │                                                   │   │
│  │  Net credit: $0.98 · $98 per contract             │   │
│  │  Open date: 2025-01-03  [__________]              │   │
│  │                              [✕ Skip this trade]  │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─── ImportCandidateCard ──────────────────────────┐   │
│  │  TLT  ·  Exp 2025-02-21  ·  1 contract           │   │
│  │  ⚠ MARKS ONLY  (no order history match)          │   │
│  │  Prices shown are position averages — verify.     │   │
│  │  ...                                              │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  Already in journal (1):                                 │
│  GLD  Exp 2025-01-31 — skipped (already imported)       │
│                                                          │
│  Incomplete positions (1):                               │
│  QQQ  Exp 2025-01-17 — 2 of 4 legs found (partial close) │
│                                                          │
│                         [Import 2 trades →]              │
└─────────────────────────────────────────────────────────┘
```

**Key UI behaviors:**

- Each `ImportCandidateCard` has editable price fields (pre-filled from the candidate data). Prices are per-share, matching the manual `NewTradeForm` convention. The live net-credit preview updates as prices are edited — reuse the same `netCredit()` calculation from `trade-math.ts`.
- The open date field is editable. For `marks_only` candidates it defaults to today and is amber-highlighted with a tooltip: "No order history match — enter the actual trade date."
- "Skip this trade" removes the candidate from the confirmation set. It does not persist anything — just removes it from the local review list.
- The "Import N trades →" button at the bottom is disabled if zero candidates remain (all skipped). The count reflects the current non-skipped set.
- Already-imported and incomplete positions are shown as read-only informational sections below the importable candidates — they require no interaction.

### 6.4 Component list

| Component | File | Local State | Notes |
| :--- | :--- | :--- | :--- |
| `ImportButton` | `components/journal/ImportButton.tsx` | `status: 'idle' \| 'loading' \| 'review' \| 'confirming' \| 'done' \| 'error'`, `candidates: ImportCandidatesResponse \| null` | Owns the full import flow state machine |
| `ImportCandidateReviewPanel` | `components/journal/ImportCandidateReviewPanel.tsx` | `skipped: Set<string>` (by candidateId) | Receives candidates; calls `importTradesAction` on confirm |
| `ImportCandidateCard` | `components/journal/ImportCandidateCard.tsx` | `prices: Record<legKey, string>`, `openDate: string` | Editable prices + date; emits updated candidate on change |

`ImportButton` is the single stateful component. `ImportCandidateReviewPanel` and `ImportCandidateCard` receive props and emit updates upward — same unidirectional pattern as the existing journal components.

---

## 7. Edge Cases

| Scenario | Handling |
| :--- | :--- |
| No open option positions | Review panel shows "No open condors found." No candidates, no import button. |
| All candidates already in journal | Review panel shows only the "Already in journal" section. Import button disabled with message "All open positions are already in the journal." |
| Orders endpoint returns 403 / scope error | Log error, degrade all candidates to `marks_only`. Surface a yellow banner in the review panel: "Order history unavailable — prices shown are position averages." |
| Orders endpoint returns 401 (token expired mid-flow) | Propagate as a top-level error → trigger ReauthBanner, same as any other Schwab 401. |
| Position has mismatched leg quantities (e.g., 2 short / 1 long after partial close) | Grouper flags as `IncompletePosition` with reason "Mismatched quantities — possible partial close." Not imported. |
| Position has 5+ legs on same underlying + expiration (stacked condors) | Grouper attempts to find the first valid 4-leg condor subset; remaining legs flagged as a second `IncompletePosition`. In practice this should not occur with the TOMIC 1-position-per-pillar rule. |
| Split-order entry (call spread + put spread entered as 2 separate 2-leg orders) | `enrichWithOrderHistory` detects this and sets `splitOrder: true`. Card shows "(entered as 2 orders)" annotation. Prices and open date from the earlier of the two orders. |
| All 4 legs matched to an order but fill prices in `executionLegs` are 0 | Fall back to `averagePrice` from the position for affected legs. Surface as `marks_only` confidence. |
| Candidate's `openDate` is null (marks_only) and operator doesn't fill it in | Client-side validation on the `ImportCandidateCard` before confirm: open date is required. Show inline error on the card. |
| Import action fails partway through (e.g., DB error on 3rd of 5 imports) | `importTradesAction` returns a partial-success result indicating which candidates imported and which failed. Toast: "2 of 5 imported — 3 failed. Check /journal for details." Already-written trades are not rolled back (each `createTrade` is its own transaction). |
| Operator clicks import twice (double-submit) | `ImportButton` sets `status = 'confirming'` before calling the action. Confirm button is disabled while confirming. |

---

## 8. Tests

Follow the `trade-math.test.ts` pattern — pure unit tests in `lib/journal/importer.test.ts`. No Schwab mocks needed since all tested functions are pure.

Minimum test cases:

**`parsePositionLegs`**
- Filters out non-OPTION asset types
- Filters out zero-quantity positions
- Correctly maps longQty / shortQty to `RawPositionLeg`

**`groupIntoCondors`**
- Happy path: 4 legs → single `ImportCandidate` with correct LP/SP/SC/LC assignment
- Returns `IncompletePosition` when group has 3 legs
- Returns `IncompletePosition` when group has mismatched quantities
- Returns `IncompletePosition` when group has 2 puts and 0 calls
- Multiple underlying/expiration groups → multiple candidates

**`enrichWithOrderHistory`**
- Matched order: confidence becomes `'matched'`, prices come from executionLegs, orderId populated
- Unmatched order: confidence stays `'marks_only'`, prices unchanged
- Split-order case: `splitOrder: true`, openDate from earlier order
- ExecutionLeg price = 0: falls back to averagePrice, confidence = `'marks_only'`

**`deduplicateCandidates`**
- Candidate matching an open journal trade → moves to `alreadyImported`
- Candidate not in journal → stays in `fresh`
- Empty journal trades → all candidates are `fresh`

Target: ~20 new tests. Running count: 149 + 20 = ~169 passing after this session.

---

## 9. Files Created / Modified

### Created
- `lib/schwab/orders.ts` — Schwab orders fetcher
- `lib/journal/importer.ts` (+ `importer.test.ts`) — grouping, matching, dedup logic
- `app/api/journal/import-candidates/route.ts` — orchestration endpoint
- `components/journal/ImportButton.tsx` — stateful import flow owner
- `components/journal/ImportCandidateReviewPanel.tsx` — confirmation panel
- `components/journal/ImportCandidateCard.tsx` — per-candidate editable card

### Modified
- `lib/journal/types.ts` — add `ImportCandidate`, `ImportLeg`, `ImportConfidence`, `ImportCandidatesResponse`, `IncompletePosition`, `RawPositionLeg`
- `app/journal/actions.ts` — add `importTradesAction`
- `app/journal/page.tsx` — add `<ImportButton />` to page header

### Not modified
- `lib/db/journal.ts` — `createTrade()` already handles `source` and `schwabOrderId` as optional fields; no changes needed
- `supabase-schema.sql` — no migration required (`source` is a text column, not an enum)
- All scanner, earnings, and strategy files — untouched

---

## 10. Build Order (Phase 10)

All items sequenced to enable early end-to-end testing of the pipeline before the UI is complete.

| Step | Item | Complexity | Blocker |
| :---: | :--- | :---: | :--- |
| 1 | Add new types to `lib/journal/types.ts` | S | None |
| 2 | Write `lib/schwab/orders.ts` + manual smoke-test against Neon (curl the endpoint) | M | Step 1 |
| 3 | Write `lib/journal/importer.ts` pure functions | M | Step 1 |
| 4 | Write `lib/journal/importer.test.ts` (~20 tests) | M | Step 3 |
| 5 | Write `app/api/journal/import-candidates/route.ts` | M | Steps 2, 3 |
| 6 | Add `importTradesAction` to `app/journal/actions.ts` | S | Step 1 |
| 7 | Build `ImportCandidateCard` (editable legs + live net-credit) | M | Step 1 |
| 8 | Build `ImportCandidateReviewPanel` (skip logic, already-imported section, incomplete section, confirm button) | M | Steps 5, 6, 7 |
| 9 | Build `ImportButton` (state machine wrapper, fetch, error states) | M | Step 8 |
| 10 | Wire `<ImportButton />` into `app/journal/page.tsx` | S | Step 9 |
| 11 | End-to-end smoke test: import → confirm → verify journal entries in Neon | M | Step 10 |

**Expected session duration:** 3–5 hours. Steps 1–6 are pure logic and can be completed without running the app. Steps 7–10 are UI and require the dev server.

**Blocking dependency on prior sessions:** None. The journal `createTrade` DB path and the Schwab auth layer are fully operational. This session adds a new read path (orders) and a new write trigger (bulk import action) but does not modify any existing write paths.

---

## 11. Decisions Deferred to Implementation

- **`ImportButton` placement:** Header of the journal list section, right-aligned alongside `+ New Trade`. Exact spacing follows existing dark-theme header conventions — match the `+ New Trade` button style with a secondary/outline variant to visually subordinate it.
- **Marks-only open-date default:** Default to `today` in the date field with amber highlight. An empty field blocks confirm (enforced client-side on the card). Do not default to the expiration date or any other inference — the operator should set this explicitly.
- **Split-order annotation:** Display as a subtle badge or parenthetical below the confidence badge, e.g., `✓ MATCHED (2 orders · Jan 3, 2025)`. Does not affect import behavior.
- **Max candidates per import:** No hard cap. In practice the TOMIC framework supports at most 5 concurrent positions; the UI should handle up to 10 gracefully (matching the 10-cell scanner limit). No pagination needed.

---

## 12. Pickup Checklist for Session 10

```
Resuming SteelEagle build.

Last session: June 14, 2026 (Session 9 — v1.5 Trade Journal, manual entry).
This session: Phase 10 — Schwab Position Importer.
Spec: steeleagle-session-10-spec.md

Confirm clean state before starting:
1. npx tsx --test "lib/**/*.test.ts"  → expect 149 passing
2. ./node_modules/.bin/tsc --noEmit 2>&1 | grep -v '\.test\.ts' | grep -v '\.next'
   → expect no journal/app errors

Build order (follow §10 in spec sequentially):
Step 1  → lib/journal/types.ts          (new types — no logic, no tests)
Step 2  → lib/schwab/orders.ts          (Schwab orders fetcher)
Step 3  → lib/journal/importer.ts       (pure grouping/matching/dedup functions)
Step 4  → lib/journal/importer.test.ts  (~20 tests; run green before proceeding)
Step 5  → app/api/journal/import-candidates/route.ts
Step 6  → app/journal/actions.ts        (add importTradesAction)
Step 7  → components/journal/ImportCandidateCard.tsx
Step 8  → components/journal/ImportCandidateReviewPanel.tsx
Step 9  → components/journal/ImportButton.tsx
Step 10 → app/journal/page.tsx          (wire <ImportButton />)
Step 11 → end-to-end smoke test in browser + verify Neon rows

Key constraints:
- importTradesAction calls createTrade() sequentially (not parallel) to
  avoid transaction contention on the Neon WebSocket pool.
- 'schwab_import' is a text value for the source column — no migration needed.
- Orders endpoint is throttled at 10 req/min — the importer makes exactly 1
  call per import session; no rate-limit concern.
- enrichWithOrderHistory degrades gracefully: if orders endpoint fails or
  returns [], all candidates become 'marks_only'. Never throw from this path.
- openDate is required before confirm (client-side validation on
  ImportCandidateCard). marks_only candidates default to today with amber
  highlight; operator must verify.

Target test count after session: ~169 passing (149 + ~20 new).
```

---

**End of Session 10 Spec v1.0**
