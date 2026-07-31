# SteelEagle — v2.4 Index Options Spec (rev B)

**Date:** July 29, 2026 (Session 17)
**Status:** rev B — Phase 0 findings folded in; build order steps 3–6 and 9 IMPLEMENTED and gated.
Remains open only on the fixture-gated items (steps 7, 8, 11).
**Supersedes:** `steeleagle-v2-4-index-options-spec-DRAFT-revA.md`. Rev A's §0a decisions
stand unchanged; §4, §5, §6, §8 are amended below where the code disproved the draft.
**Phase 0 source:** `steeleagle-v2-4-phase0-findings.md` (V1–V5, V8 pinned).

---

## 0. What changed from rev A

Rev A was written before the probe and before anyone read the shipped builder. Three of its
claims did not survive contact with the code. Per CLAUDE.md, **where a doc and the code
disagree, the code wins** — each correction is recorded here rather than silently applied.

| Rev A said | Reality | Resolution |
| :--- | :--- | :--- |
| §6.3 "builder's `wingWidth` sourced from `standardWingWidth` instead of the $10 constant" | The builder has no $10 wing constant. It derives each wing naturally from the 5Δ strike and takes the narrower side. The only $10 is `MIN_WING_WIDTH`, a **filter floor**. | `standardWingWidth` → **`minWingWidth`**, a per-instrument floor. No target width exists to parameterize. |
| §6.3 "strike-stepping respects `strikeIncrement`" | There is no strike-stepping. Long strikes snap to strikes that **actually exist in the fetched chain** (`findNearestStrike`) — strictly better than stepping by an assumed increment. | **`strikeIncrement` dropped from `InstrumentMeta`.** A field nothing consumes rots. |
| §6.4 "generalize the credit ≥ $150 floor to credit ≥ 15% of wing width" | The 15% ratio filter *already existed*. On a $10 wing, $150 **is** 15% — the absolute floor was a duplicate that silently under-gated wide wings. | The separate absolute-credit filter is **deleted**. The ratio filter now reports the derived dollar floor in its message, so nothing is lost from the operator's view. |

## 0a. Decisions on record

Rev A §0a items 1–4 (sequencing, WARN-not-block, reject `$`-prefixed input, XSP intended for
live trading) are unchanged. Two new decisions, both taken 2026-07-29:

**5. `trade_events` root retention — NO MIGRATION. Refuse multi-root instead.**
Supersedes rev A §8.3. The condition §8.3 set was met (`trade_events` stores
`leg/strike/expiration`, never a symbol), but the proposed column does not solve the problem
it was aimed at: the **manual journal path has no OCC symbol to populate it from**, so for a
hand-entered trade the column would store `preferredRoot` — re-deriving the same guess, with
a schema change on top. Instead, `currentStructure()` **refuses outright** for any underlying
with more than one OCC root. Consequences:
- **XSP has a single root (Phase 0 V2) and is fully placeable** — it is the only index tradeable
  at this account size, so the milestone still ends trade-ready per §0a.4.
- SPX/NDX/RUT get the `MANUAL GTC` chip and a sweep flag naming the real reason.
- **0 pending migrations.** Reopen when an SPX-size account makes those instruments live;
  at that point the root should come from a real fill, not a column default.

**6. Index order placement is gated behind a pinned fixture.**
`InstrumentMeta.orderFixturePinned` is `false` for all four indices. While false, **both**
ticket builders throw and `currentStructure()` refuses. This is the Schwab doctrine made
mechanical: Schwab performs no server-side review, so a symbol format guessed from
documentation submits and can execute. Flipping one boolean per instrument is the entire
cost of lifting it — after step 7.

---

## 1–3. Scope, instrument reality check, verification phase

Unchanged from rev A, with the §2 level corrections from the Phase 0 findings table applied
(XSP 741, SPX 7,413, NDX 28,039, RUT 2,948). V1–V5 and V8 are **pinned**; V6 and V7 remain
open and are answered by step 7.

## 4. Instrument metadata module — AS BUILT

`lib/strategy/instruments.ts` (pure, 35 unit tests). Registry of 25 instruments: the 21-ETF
five-pillar universe plus XSP/SPX/NDX/RUT.

```typescript
interface InstrumentMeta {
  symbol: string              // canonical, $-free — what the DB and UI store
  apiSymbol: string           // '$SPX' for indices (V1)
  kind: 'etf' | 'index'
  occRoots: string[]          // ALL roots mapping to this underlying
  preferredRoot: string       // PM-settled where a choice exists
  pillar: Pillar              // indices → EQUITY
  minWingWidth: number        // was the $10 constant (§0 correction)
  perContractFee: number      // $0.65 + index proprietary fee — ESTIMATE for indices
  settlement: 'physical' | 'cash'   // from config, NEVER Schwab's settlementType (V3 trap)
  orderFixturePinned: boolean       // §0a.6 doctrine gate
}
```

Dropped vs rev A: `strikeIncrement` (§0), `sameIndexAs` — the sibling relation is declared as
**groups** (`['SPY','XSP','SPX']`, `['QQQ','NDX']`, `['IWM','RUT']`) so it cannot be recorded
asymmetrically, and `sameIndexSiblings()` derives from them.

`Pillar` and `pillarOf` moved here from `position-limits.ts` (re-exported there for
compatibility) — instrument identity is one concern, and it removes an import cycle.

**Canonicalization rule (unchanged):** `$`-free everywhere; the `$` exists only at
`apiSymbolFor()`, called at exactly two fetch sites (the IV cron and `getOptionChain`).

## 5. Root ↔ underlying mapping — AS BUILT

`parseOccSymbol` now returns **both** `root` (raw, e.g. `SPXW`) and `underlying`
(`resolveUnderlying(root)`, e.g. `SPX`). That single change resolves every consumer in the
rev A table at once, because all of them already read `.underlying`:

| Consumer | Status |
| :--- | :--- |
| `reconstruct-positions` grouping | ✅ mixed-root SPX condor assembles as ONE position (test pinned) |
| `position-limits` / entry gate | ✅ SPXW counts against the equity block; both sides resolved |
| Importer (`groupIntoCondors`, dedupe) | ✅ one candidate, and dedupe matches a journal `SPX` row |
| **Exit-sweep pre-place guard** | ✅ working SPXW close blocks placement for a trade stored as `SPX` |
| Roll-alert quote batching | ✅ needs no root work (OCC option symbols take no `$`) — **but see §12** |

Unknown roots **pass through to themselves**. ETF behaviour is byte-identical, and a future
index root Schwab introduces degrades to today's behaviour rather than crashing.

**Root selection for new orders:** `preferredRoot` (PM-settled). Because §0a.5 refuses
multi-root instruments outright, in practice the root a builder receives is always the
instrument's one unambiguous root — never a guess.

## 6. Scanner path — AS BUILT

1. **IV cron:** shipped in Phase 0; this build **absorbed the `INDEX_API_SYMBOLS` shim** into
   the registry and derived `DEFAULT_CRON_SYMBOLS` from `INSTRUMENTS`, so a symbol added to
   the registry starts its calibration clock immediately.
2. **Chains adapter:** `apiSymbolFor()` at the request; **root filtering for index chains**.
   Phase 0 V2 showed one `$SPX` response mixes SPXW and SPX and that at a monthly expiration
   both land under the **same** `callExpDateMap` key — unfiltered, `findByDelta` would build a
   "condor" out of two different instruments. Filtering is applied to **indices only**; ETF
   chains pass through untouched. The expiration walk is now nearest-first *with fallthrough*,
   so an index expiration that exists only under the AM root yields the next tradeable one
   instead of an empty chain.
3. **Builder:** `minWingWidthFor(symbol)`, `commissionRoundTrip(symbol)`, credit floor derived
   from the wing. ETFs compute 8 × $0.65 = $5.20 and a $10 floor — byte-identical (regression
   tests pinned). One credit-tier test per width: $10/$10/$25/$50/$200 → $150/$150/$375/$750/$3,000.
4. **Liquidity filter:** unchanged. Expect XSP FAILs; that is the filter working (§11.4).
5. **Settings validation:** `$`-prefixed input **rejected with a message** per §0a.3 —
   *"use SPX, not $SPX — the $ is added internally for index market data"*. Silent stripping
   was rejected because `iv_history` keys on the canonical form, so a `$SPX` cell would
   calibrate a second, permanently-empty history.

## 7. Entry gate — AS BUILT

1. **Equity block** now {SPY, QQQ, IWM, DIA, EFA, EEM, XSP, SPX, NDX, RUT}, max 2. The cap is
   unchanged; only membership grew, and it grew via the registry rather than a second list.
2. **Same-index WARN** (§0a.2): `EntryGate` gains a **`warnings: string[]`** field, deliberately
   separate from `reasons`. Warnings never touch `status` — keeping them in a different array
   means no future warning can flip a verdict by being pushed onto the wrong list. The scanner
   card's gate strip now renders on a non-OK verdict **or** on an OK verdict carrying a warning
   (gating on status alone would have hidden it, since an overlap never blocks).

## 8. Execution path — XSP COMPLETE · SPX/NDX/RUT still fixture-gated

1. **Golden fixture (step 7, April, manual): ✅ DONE 2026-07-30 for XSP.**
   An unfillable XSP condor (LP 700 / SP 710 / SC 770 / LC 780, exp 2026-08-27, NET_CREDIT
   $9.00, DAY, qty 1) was placed in TOS after hours, read back via
   `scripts/dump-working-orders.ts` as **order 1007409658003**, and cancelled. `buildOccSymbol`
   reproduced every live leg symbol with zero changes. No NET_DEBIT repeat was needed — see the
   composition note in §12. **SPX/NDX/RUT remain unpinned**: each needs its own
   place-and-cancel before `orderFixturePinned` may be flipped.

   *Readback quirks pinned in the fixture so nobody "fixes" them later:* leg order differed from
   the SPY fixture (a TOS emission artifact — the golden test asserts the leg **set** plus exact
   symbols, not order); `price` echoes as a NUMBER in the GET readback while the POST sends a
   formatted string; `enteredTime` uses `+0000` offset format.
2. **`buildOccSymbol`:** first argument is now the **OCC root**, not the underlying. ETF golden
   fixtures untouched (root === symbol). Index cases added as new tests alongside.
3. **Ticket builders:** both take the root; `CondorExitInput.root` is optional and falls back to
   `preferredRoot`. `CondorStructure` supplies it. **No `trade_events` migration** (§0a.5).
4. **Exit sweep:** guard resolves through the mapping on both sides — pinned by a planner test
   where a working **SPXW** close blocks placement for a journal trade stored as **SPX**. That is
   rev A §11.1, the one hazard that moves real money, closed.
5. **`recordFillAction`:** flows through the same parser, so an SPXW fill journals as `SPX`.

**Also built:** `structureRefusal(symbol, events)` returns the *actual* refusal message, so the
sweep's flag reads "XSP has no pinned order fixture…" rather than a generic "diagonal" that
would be wrong for an index trade. `isPriceableStructure` is now defined in terms of it —
still exactly ONE predicate behind the planner gate and the Monitor chip.

## 9. Fees — AS BUILT

`commissionRoundTrip(symbol)` = 8 × `perContractFee(symbol)`. ETFs → $5.20, unchanged.
Index values remain **estimates** (XSP $0.80, RUT $1.10, NDX $1.20, SPX $1.30 per contract)
and are **corrected against the first real index fill** — open item, unchanged.

## 10. Tax note

Unchanged (doc-only). `kind: 'index'` now exists in the metadata, so a future 1256 year-end
report can segregate trivially.

## 11. Hazards — status

| # | Hazard | Status |
| :--- | :--- | :--- |
| 1 | Root blind spot in the pre-place guard | **CLOSED** — both sides resolved, planner test pinned |
| 2 | Event-log root loss | **CLOSED by refusal**, not by migration (§0a.5) |
| 3 | Fee estimates wrong | Open — corrected at first real index fill |
| 4 | XSP liquidity FAILs | Open by design — sanity-check the first PASS against TOS spreads |
| 5 | Calibration gap | Mitigated — clock started 2026-07-28, completes ~Aug 24–25 |
| 6 | v2.3 interaction | **No conflict** — no migration, and `currentStructure` absorbed the root work |
| 7 | **NEW — unpinned index order payload** | **LIFTED for XSP** 2026-07-30 (fixture pinned); still **GATED** for SPX/NDX/RUT — builders refuse until each earns its own place-and-cancel |

## 12. Build order — status

| # | Step | Status |
| :--- | :--- | :--- |
| 1–2 | Phase 0 probe + IV cron universe | ✅ shipped 2026-07-27/28 |
| 3 | `instruments.ts` + tests | ✅ |
| 4 | Root mapping through reconstruct / limits / importer / roll-alert | ✅ |
| 5 | Scanner: chains adapter, builder, filters, settings | ✅ |
| 6 | Entry gate: equity block + same-index WARN | ✅ |
| 7 | **XSP golden fixture (April, manual)** | ✅ **DONE 2026-07-30** — order 1007409658003 placed-and-cancelled in TOS, read back via `scripts/dump-working-orders.ts`. V7 answered: XSP option symbols are standard OCC, byte-identical in form to the ETF convention (`XSP   260827P00700000`), single root. V6 remains technically unpinned until a real XSP fill (positions parse via OCC symbol, format now live-confirmed). |
| 8 | Ticket builders + explicit root | ✅ `e3df1ff` — XSP `orderFixturePinned: true` + golden tests; SPX/NDX/RUT stay `false` |
| 9 | Exit sweep cross-root guard + planner tests | ✅ |
| 10 | Gates | ✅ 437 tests · `tsc` clean · `next build` clean |
| 11 | Manual ladder on the first qualifying XSP setup | ⏳ calendar-blocked — calibration completes ~Aug 24–25, then needs IVR > 25% + liquidity PASS (sanity-check the first PASS against TOS spreads, hazard #4) |

**No second XSP place-and-cancel for the close shape.** The NET_DEBIT/GTC envelope is pinned by
the ETF close fixture (2026-07-24) and proven live by the TLT GTC fill; the index-specific
unknown — symbol format — is pinned by the step 7 entry fixture. The two compose. The doctrine
gates on *unknowns*, not on ceremony.

**Unrelated bug found and fixed during step 4:** `getOptionDeltas` built its URL as
`/marketdata/v1/quotes?…` while `marketGet` already prepends `…/marketdata/v1` — the path
segment was duplicated and every call 404'd. The positions route wraps roll-alert annotation
in its own try/catch, so this surfaced only as a log line and silently-absent roll badges.
**Roll alerts have been non-functional since the batching path was added.** `getQuotes` in the
same file always used the correct form. Worth a targeted check on the next market-hours load:
open a condor page and confirm a delta-derived badge or a `NONE`/`WATCH` verdict appears
rather than `NO_DELTA`.

## 13. Open items

1. ~~**V7** — order payload symbol format.~~ **Answered by the step 7 fixture, 2026-07-30.**
   **V6** — index *positions*-endpoint payload shape — technically unpinned until a real XSP
   fill exists; practical risk near zero (positions parse via the OCC symbol, whose format is
   now live-confirmed).
2. **Fee table** — corrected at first real index fill.
3. **Sub-$1 4dp NET_DEBIT acceptance** — pre-existing (v2.2 §6b), unchanged.
4. **`minWingWidth` for indices** — seeded proportionally from §2; tune against the first real
   full-chain look at XSP once it calibrates.

**End of v2.4 Index Options spec (rev B)**
