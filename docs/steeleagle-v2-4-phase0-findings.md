# SteelEagle — v2.4 Phase 0 Verification Findings

**Date:** July 27, 2026 (probe run 2026-07-28T03:50Z ≈ 11:50 PM ET Monday — after hours)
**Status:** V1–V5, V8 PINNED from live probe output (`scripts/probe-index-symbols.ts`, market-data GETs only, SPY as ETF control). V6/V7 remain open — answered by the v2.4 build's place-and-cancel fixture, per spec §3.
**Folds into:** `steeleagle-v2-4-index-options-spec-DRAFT-revA.md` → rev B / FINAL.

---

## Pinned findings

### V1 — Chains symbol format: `$`-prefixed ONLY
`/chains` accepts `$XSP`, `$SPX`, `$NDX`, `$RUT` (status SUCCESS, symbol echoed with `$`). Bare (`SPX`) and suffixed (`$SPX.X`) both **400 "Check Param Values"** — for all four indices. `apiSymbol = '$' + canonical` across the board; no per-index exceptions.

### V2 — Roots: one chain response carries BOTH roots; XSP has only one
- **SPX chains return SPXW + SPX**, NDX returns **NDXP + NDX**, RUT returns **RUTW + RUT** — mixed in a single response across the 28–52 DTE window (PM-root weeklies/dailies dominate; the AM monthly root appears at the 9/18 expiration).
- **XSP has a SINGLE root: `XSP`.** No XSPW exists. `occRoots: ['XSP']`, `preferredRoot: 'XSP'` — the one instrument April will actually trade at this account size needs no root disambiguation at all.
- Per-contract discriminator: the **`optionRoot` field** (e.g. `"SPXW"`), redundantly available as the OCC symbol's leading 6-char block. Use `optionRoot` — it's explicit.
- Expiration density in the window: SPX 10, NDX 9, XSP 7, RUT 4 expirations. The §5 preferredRoot-PM policy is confirmed viable — target expirations exist under PM roots throughout the 30–45 DTE band.

### V3 — Field parity: CONFIRMED, with two discriminator bonuses and one trap
- `delta`, `mark`, `bid`, `ask`, `volatility`, `multiplier` (100) populate identically to the SPY control. Chain and quote shapes are structurally interchangeable with ETFs.
- **After-hours note:** at 11:50 PM ET, IV was *populated* for control SPY AND all indices (no IV=0 observed for anything tonight). The cron's existing null-skip guard stands as adequate; behavior parity means indices introduce no new after-hours failure mode. *(Observed while here: the deployed cron skips on `atmIv === null` only — the "skip when ≤ 0" in the docs is aspirational vs. the code. Pre-existing, not a Phase 0 change; noted for the doc-refresh queue.)*
- **Bonus discriminators:** `exerciseType: "E"` (European) on all index contracts vs `"A"` on SPY; `deliverableNote: "100 $XSP(Cash)"` marks cash settlement vs `"100 SPY"`.
- ⚠️ **TRAP — Schwab's `settlementType` field means AM/PM, NOT physical/cash.** SPXW/NDXP/RUTW/XSP all show `settlementType: "P"` — same value as physically-settled SPY — because it means *PM-settled*. The spec's `InstrumentMeta.settlement: 'physical' | 'cash'` must be sourced from config (or `deliverableNote`), never from this field. This is exactly the docs-assumption class of bug the probe exists to catch.

### V4 — Option quotes via root-based OCC symbols: WORKS
`/quotes` accepts `SPXW  260825C07400000`-style symbols (root padded to 6 chars) and returns `delta`, `mark`, `volatility` — even after hours tonight. The roll-alert path (`getOptionDeltas`) needs **no format change**; it just needs the correct root in the symbols it builds, which is the §5 mapping work as already scoped.

### V5 — Underlying index quote: `$`-form only, and quote block is PARTIAL
- Only `$XSP`/`$SPX`/`$NDX`/`$RUT` resolve; bare and `.X` forms return an `errors` key, not a quote.
- `assetMainType: "INDEX"`; quote block carries **`lastPrice` + `closePrice` but NO `mark`/`bid`/`ask`** — indices are computed values, not traded instruments.
- **Cron impact: NONE.** The IV cron reads `chain.underlyingPrice` (populated: XSP 741.32, SPX 7413.18, NDX 28039.21, RUT 2948.03) and never touches `/quotes` for the underlying. Pin for future consumers (v2.4 scanner card display, etc.): read `lastPrice`, never `mark`, for index underlyings.

### V8 — `/expirationchain`: loose input, root-per-expiration output
- Accepts **all three** symbol formats identically (the one endpoint that doesn't validate) — do not use its tolerance to infer anything about the strict endpoints.
- Returns `optionRoots` per expiration entry (`"XSP"`, `"SPXW"`, `"NDXP"`, `"RUTW"`) — a clean root-availability source if the builder ever wants root-by-expiration without a full chain pull. `settlementType: "P"` here carries the same AM/PM meaning as V3's trap.

---

## Reality-check table corrections (spec §2)

Levels moved materially since drafting — RUT especially:

| Instrument | Spec §2 said | Probe actual | Near-ATM strike inc. observed* |
| :--- | ---: | ---: | ---: |
| XSP | ~690 | **741.32** | $5 (spec said $1) |
| SPX | ~6,900 | **7,413.18** | $10 (spec said $5) |
| NDX | ~25,000 | **28,039.21** | $50 (spec said $25) |
| RUT | ~2,200 | **2,948.03** | $5 (spec said $5) |

*Thin sample (strikeCount=4, near-ATM only); increments typically tighten/widen across the strike ladder. Treat as provisional; `strikeIncrement` and `standardWingWidth` tune at build per spec, from a full-chain look. The RUT level correction also moves its §2 BPR estimate up (~$2k–$3.5k at proportional wings) — still "marginal at $30k+," conclusion unchanged.

## Cron nearest-expiration semantics (accepted)

The IV cron fetches `strikeCount: 1` with no date window → ATM IV comes from the **nearest** expiration, which for SPX/NDX/XSP is a 0–1 DTE daily. This matches existing ETF behavior (SPY also carries dailies) and IV Rank is self-relative per symbol, so consistency — not tenor — is what matters. No change; pinned as accepted.

## Phase 0 deliverable (b): cron universe change

`app/api/cron/snapshot-iv/route.ts` (full-file replacement, built from live main, diff-verified two edits only):
1. `DEFAULT_CRON_SYMBOLS` gains `'XSP', 'SPX', 'NDX', 'RUT'` → 25-instrument universe.
2. `INDEX_API_SYMBOLS` shim: canonical → `$`-form translation at the `marketGet` boundary only; `iv_history` stores canonical `$`-free symbols per the spec §4 canonicalization rule. Comment marks it for absorption into `lib/strategy/instruments.ts` at v2.4 build.

IV loop otherwise byte-identical; exit sweep untouched.

**Deploy tonight → tomorrow's 4:15 PM CT run is calibration day 1.** Verify on the 7/28 run: four new rows in `iv_history` with symbols `XSP`/`SPX`/`NDX`/`RUT` (no `$`), plausible `atm_iv`, and `underlying_price` ≈ the levels above. Dashboard calibration banner should name the four as CALIBRATING. Expected calibration completion: ~20 trading days ≈ **Aug 24–25, 2026**.

## Still open (v2.4 build proper)
- **V6** — index option shape in the positions payload (needs a real position; XSP ladder covers it).
- **V7** — order payload symbol format (place-and-cancel unfillable fixture, spec §8.1).
- `trade_events` root retention question (spec §8.3) — unchanged.
- Fee table correction at first real index fill — unchanged.

**End of Phase 0 findings**
