# SteelEagle — v2.4 Index Options Spec (DRAFT, rev A)

**Date:** July 24, 2026 (Session 15)
**Status:** DRAFT rev A — April's §12 decisions folded in (2026-07-24). Remains DRAFT until the §2 verification findings are pinned. Findings → FINAL per the v2.2 pattern.
**Supersedes:** `steeleagle-v2-3-index-options-spec-DRAFT.md` in full (renumbered to v2.4).
**Baseline:** v2.2 live in prod · 214 tests · 1/2 cron slots · exit sweep verified (L1/steady-state) · L3/L4 pending

---

## 0. Sequencing (decided)

- **v2.3 = Monitor close flow + `currentStructure(events)`** (as originally scoped in the v2.2 spec). Immediate operational value; proceeds first.
- **v2.4 = this milestone** (index options, full pipeline).
- **Pull-forward exception (Phase 0, runs NOW — before v2.3):** the §2 probe run + adding the four index symbols to the IV cron. Rationale: IV Rank needs ~20 trading days of history and no backfill exists. Starting the clock immediately means XSP finishes calibrating at roughly the same time v2.3 finishes building — so "trade XSP as soon as it calibrates + qualifies" (April, §12.4) incurs no post-v2.4 wait. Phase 0 is small (probe script + a constant-list change to the cron universe) and touches nothing v2.3 touches.

## 0a. Decisions on record (April, 2026-07-24)
1. **Sequencing:** index milestone is v2.4; Monitor close flow keeps v2.3. Phase 0 pull-forward as above.
2. **Same-index conflict rule: WARN, not block.** (§6.2)
3. **Settings input: reject `$`-prefixed symbols with a message** (no silent normalization). (§5.6)
4. **XSP is intended for live trading as soon as it calibrates and a setup qualifies** — the v2.4 build must end trade-ready (fixtures + full ladder), not infrastructure-only.

---

## 1. Scope

Add index options (**XSP, SPX, NDX, RUT**) to the full pipeline: IV history → scanner → entry gate → order placement → positions monitor → exit sweep → journal/importer. XSP is expected to be the only instrument that clears the BPR gate at the current account size; SPX/NDX/RUT are future-proofing and will surface in the scanner but BLOCK naturally on BPR pre-flight — no special-casing needed.

### Non-goals
- No changes to the 5-pillar framework itself (indices join the existing equity block).
- No earnings-sleeve support for indices (indices don't report earnings; N/A by construction).
- No 1256 tax accounting in the journal (doc-level note only; see §9).
- No VIX options (options on futures, different animal entirely).

---

## 2. Instrument Reality Check (strategy math first)

Approximate levels as of drafting — verify current at build time:

| Instrument | ~Level | Strike inc. | Proportional wing | Est. BPR/contract | Viable @ $10k? | Notes |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| **XSP** | ~690 | $1 | $10 (identical to SPY) | ~$800 | **Yes** | 1/10 SPX. Cash-settled, European, 1256. Wider spreads than SPY — liquidity filter will gate. |
| **SPX** | ~6,900 | $5 | $50–$100 | $4k–$9k | No (single position ≈ entire BPR cap) | Deepest index chain in existence. Becomes viable ~$80k–$200k account. |
| **RUT** | ~2,200 | $5 | $20–$30 | $1.5k–$2.5k | Marginal | Viable around $30k–$50k under the 5%-of-capital BPR rule. |
| **NDX** | ~25,000 | $25 | $150–$250 | $12k+ | No | Furthest out. QQQ remains the Nasdaq vehicle for the foreseeable future. |

**Why bother at all (the strategy case):**
1. **Section 1256 tax treatment** — 60% long-term / 40% short-term on broad-based index options vs. 100% short-term on ETF options. At the 22% planning bracket, blended 1256 rate ≈ ~16.5% vs. 22% — a ~5.5-point after-tax edge on every dollar of profit, for free. This materially improves the Section 7 friction math in the strategy doc.
2. **European exercise** — no early assignment risk on short legs, ever. Removes the (currently unmodeled) dividend-date assignment risk on SPY/QQQ/DIA short calls.
3. **Cash settlement** — no pin risk, no share delivery. (Mostly moot given the 21-DTE exit — positions are never held to settlement — but eliminates a failure mode if an exit is ever missed.)

**Fees (estimates — verify against Schwab's fee schedule and a real fill):** exchanges pass through proprietary index fees on top of Schwab's $0.65/contract: SPX ~$0.55–0.70, NDX ~$0.55, RUT ~$0.40–0.50, XSP ~$0.10–0.20 per contract. This breaks the hardcoded $5.20 round-trip constant (§8).

---

## 3. Verification Phase (Phase 0, runs NOW — never build from docs)

The GOOD_TILL_CANCEL lesson applies with force here: index symbol conventions are exactly the kind of thing Schwab records differently than documented. A probe script (pattern: `scripts/dump-working-orders.ts`) answers:

| # | Question | Endpoint | Why it matters |
| :--- | :--- | :--- | :--- |
| V1 | Chains symbol format: `$SPX` vs `SPX` vs `$SPX.X`? Same for XSP/NDX/RUT. | `/chains` | Scanner adapter boundary + IV cron. |
| V2 | Do chains for `$SPX` return **both** SPX (AM) and SPXW (PM) roots? How is the root exposed per contract? | `/chains` | Root selection policy (§5). |
| V3 | Do delta / mark / IV fields populate identically to ETF chains? After-hours IV=0 behavior same? | `/chains` | IV cron + condor builder reuse. |
| V4 | Quotes symbol format for an index **option** (roll-alert path): does the OCC-style symbol with root `SPXW` work in `/quotes`? | `/quotes` | F16 roll alerts. |
| V5 | Underlying **index** quote symbol (for `underlying_price` in `iv_history`)? | `/quotes` | IV cron row completeness. |
| V6 | How does a held index option appear in the positions payload — instrument `symbol`, `assetType`, `underlyingSymbol`? | `/accounts/{hash}` | Reconstruction + importer + exit-sweep guard. Can't fully verify until a real position exists — XSP ladder covers it (§12). |
| V7 | Order payload symbol format for placement — root-padded OCC (`SPXW  260918P06500000`)? `assetType`? | `/orders` | Golden fixture (§7). Answered by place-and-cancel, v2.0 pattern. |
| V8 | `/expirationchain` behavior for indices. | `/expirationchain` | Only if the builder uses it for index paths. |

**Phase 0 deliverables:** (a) probe script April runs locally; raw JSON pasted back; V1–V5, V8 pinned into this spec; (b) **IV cron universe gains XSP, SPX, NDX, RUT in the same session** (using the verified V1/V5 symbols) — calibration clock starts; the calibration banner handles the messaging. V6/V7 wait for the v2.4 build proper.

---

## 4. Instrument Metadata Module (new, pure)

`lib/strategy/instruments.ts` — single source of truth, config-as-code (pattern: `earnings-watchlist.ts`):

```typescript
interface InstrumentMeta {
  symbol: string;            // canonical internal symbol: 'SPX', 'XSP', ... ($-free)
  apiSymbol: string;         // market-data symbol, e.g. '$SPX' (verified V1/V5)
  kind: 'etf' | 'index';
  occRoots: string[];        // ALL roots that map back to this underlying, e.g. ['SPX','SPXW']
  preferredRoot: string;     // root the builder/ticket uses for new orders (PM-settled)
  pillar: Pillar;            // indices → equity block
  sameIndexAs?: string[];    // ['SPY'] for XSP/SPX; ['QQQ'] for NDX; ['IWM'] for RUT (§6)
  strikeIncrement: number;
  standardWingWidth: number; // 10 for XSP; 50 for SPX; 25 for RUT; 200 for NDX (tune at build)
  perContractFee: number;    // Schwab $0.65 + index proprietary fee (§8)
  settlement: 'physical' | 'cash';
}
```

**Canonicalization rule:** the app stores and displays `$`-free symbols everywhere (`iv_history`, `trades`, settings, UI). The `$`/root translation happens only at the Schwab adapter boundary. Existing ETF rows are untouched (their apiSymbol == symbol).

---

## 5. Root ↔ Underlying Mapping (the load-bearing change)

Today `parseOccSymbol`'s root **is** the underlying. Index roots break this: `SPXW → SPX`, `NDXP → NDX`, `RUTW → RUT`. Every consumer of the parsed underlying must resolve through the metadata:

| Consumer | Failure mode if unmapped |
| :--- | :--- |
| `reconstruct-positions` grouping | SPXW legs group under "SPXW"; SPX AM legs under "SPX" — one condor split into two OTHER piles. |
| `position-limits` / entry gate | SPXW position not counted in the equity block → cap silently bypassed. |
| Importer (`groupIntoCondors`, dedupe) | Same split; dedupe vs. journal trades (stored as `SPX`) never matches → duplicate import candidates. |
| **v2.2 exit-sweep pre-place guard** | Guard keys on underlying+expiration. A working SPXW close would not match a journal trade stored as `SPX` → guard blind spot → **duplicate GTC placement**. Highest-severity consumer. |
| Roll-alert quote batching | Wrong symbols requested; alerts self-suppress (NO_DELTA) — degrades, doesn't corrupt. |

Implementation: `resolveUnderlying(occRoot): string` in the metadata module; unit tests pin every root in the table plus passthrough for unknown roots (an unmapped root resolves to itself — ETF behavior unchanged, and a future new index root degrades to the current behavior rather than crashing).

**Root selection policy for new orders:** prefer the PM-settled root (`preferredRoot`). Settlement style is operationally irrelevant under the 21-DTE exit (never held to settlement), so this is a symbol-plumbing choice, not a risk choice — but PM roots (SPXW/NDXP/RUTW) have the denser weekly expiration grid the 30–45 DTE window wants. If V2 shows a target expiration exists only under the AM root, accept it; the exit path must handle either (it will, via `occRoots`).

---

## 6. Scanner Path Changes

1. **IV cron:** four new symbols → 25-instrument universe. **Ships in Phase 0** (§3), not with the main build.
2. **Chains adapter:** symbol translation at the boundary (V1); root filtering per §5 policy (V2).
3. **Condor builder:** `wingWidth` parameter sourced from `standardWingWidth` instead of the $10 constant; strike-stepping respects `strikeIncrement`. The 16Δ/5Δ/30–45 DTE logic is unchanged.
4. **Filter chain generalization:** the absolute "credit ≥ $150" floor is a $10-wing constant. Generalize to the ratio the strategy doc already states: **credit ≥ 15% of wing width** (=$150 on $10, =$750 on $50, etc.). The credit/width ≥ 15% filter already exists — the absolute floor becomes derived, not separate. One test pins each width tier.
5. **Liquidity filter:** unchanged — and doing real work. XSP spreads may fail the 25%-of-credit rule regularly; that is the filter operating as designed, not a bug.
6. **Settings validation (decided §0a.3):** `$`-prefixed input is **rejected with a message** ("use SPX, not $SPX — the $ is added internally"), consistent with the existing isolated-error-but-still-save cell behavior for the other cells. The four canonical index symbols become valid tickers.

---

## 7. Entry Gate: Equity Block Expansion + Same-Index WARN (decided)

1. **Equity block** grows: {SPY, QQQ, IWM, DIA, EFA, EEM, **XSP, SPX, NDX, RUT**} — max 2 concurrent, unchanged, still a hard cap.
2. **Same-index conflict rule (decided §0a.2 — WARN, not block):** when an open position exists on a `sameIndexAs` sibling (SPY↔XSP↔SPX, QQQ↔NDX, IWM↔RUT), the entry gate verdict stays OK/TIGHT but carries a warning reason: `"same-index overlap: SPY position open — zero diversification"`. Surfaced in the gate strip like existing reasons; never blocks. Strategy doc §3 gains a one-line note at next revision.

---

## 8. Execution Path

1. **Golden fixture (April, manual):** place a deliberately **unfillable** XSP iron condor entry (NET_CREDIT well above market) in TOS → dump via the working-orders script → pin the recorded shape (root symbol format, `assetType`, `complexOrderStrategyType`) → **cancel**. Same for an unfillable NET_DEBIT close if the shape differs. Zero fill risk, answers V7. This is the v2.0/v2.2 fixture discipline applied a third time.
2. **`buildOccSymbol`:** currently pads the underlying as the root. Must accept an explicit root (from `preferredRoot` / the originating leg's parsed root for exits). Entry-side golden tests for ETFs stay untouched (v2.2 rule); index fixtures are **new** tests alongside.
3. **Order ticket / exit ticket:** both builders take the root through the metadata; exit legs derive the root from the entry `open` events' stored symbols (exact by construction — same posture as v2.2 leg derivation). Requires `trade_events` to preserve the full OCC symbol or at least the root — **verify what `insertEvent` stores today; if only leg/strike/expiration, add a `root` (or full symbol) column in this milestone's migration.** Flagged as the one probable schema change.
4. **Exit sweep:** guard comparison switches from raw parsed root to `resolveUnderlying(root)` on both sides (fetched orders AND journal trades). Pure-planner tests gain SPXW/SPX cross-match cases.
5. **`recordFillAction` / close-from-fill:** refusal semantics unchanged; symbol parsing flows through the same mapping.

## 9. Fees & Commission

`commissionRoundTrip` ($5.20 hardcoded) becomes per-instrument: `8 × perContractFee(symbol)` per 1-lot round trip. ETFs keep $0.65 → $5.20, byte-identical output. Index estimates from §2 seed the metadata; **corrected against the first real index fill's confirmed fees** (open item, same class as the sub-$1 4dp question). The friction badge (>8% of expected win) needs no change — it consumes the computed value.

## 10. Tax Note (doc-only)

1256 instruments get 60/40 treatment and mark-to-market at year-end. No journal schema change in v2.4; the instrument metadata (`kind: 'index'`) makes any future year-end report trivially able to segregate. Strategy doc §7's "assume 22% short-term" note should gain a sentence when next revised.

## 11. Hazards on Record

1. **Root blind spot in the pre-place guard** (§5) — the one place an unmapped root causes real money movement (duplicate GTC). Mitigation: guard resolves through the mapping on both sides; planner tests pin the cross-root match; unknown roots fail toward FLAG, never toward place.
2. **Event-log root loss** (§8.3) — if `trade_events` doesn't retain the root, exits on index trades can't rebuild the correct symbol. Resolve in verification; migrate if needed.
3. **Fee estimates wrong** — cosmetic until an index trade is contemplated near the friction threshold; corrected at first real fill.
4. **XSP liquidity** — expect frequent liquidity-filter FAILs. Not a defect. Given §0a.4 (April intends to trade XSP live), the first few qualifying windows should be sanity-checked against TOS's displayed spreads before trusting a PASS.
5. **Calibration gap** — mitigated by Phase 0; residual risk only if Phase 0 slips past the v2.3 build start.
6. **v2.3 interaction** — v2.3's `currentStructure(events)` and Monitor close flow will merge first. §8.3's possible `trade_events` root column should be designed so `currentStructure` consumes it too (rolled index trades in some future need the root exactly the same way). Coordinate the two migrations if both touch `trade_events`.

## 12. Build Order

**Phase 0 (NOW, pre-v2.3):**
1. Probe script + verification run (April, manual) → pin V1–V5, V8 findings into this spec.
2. IV cron universe + verified apiSymbols for XSP/SPX/NDX/RUT — deploy; confirm first snapshot rows land (and `atm_iv ≤ 0` skip behaves) on the next weekday run.

**v2.4 build (post-v2.3):**
3. `lib/strategy/instruments.ts` + tests (pure, no credentials) — metadata, `resolveUnderlying`, fee table.
4. Root mapping threaded through `reconstruct-positions`, `position-limits`, importer, roll-alert symbol batching + tests.
5. Scanner: chains adapter, builder parameterization, filter generalization, settings `$`-rejection + tests.
6. Entry gate: equity-block expansion + same-index WARN + tests.
7. XSP golden fixture: place-and-cancel unfillable entry (+ close if shape differs) (April, manual) → pin V6/V7.
8. Ticket builders: explicit-root `buildOccSymbol` path, index fixtures; `trade_events` root column migration if needed (coordinated with v2.3 per §11.6).
9. Exit sweep: `resolveUnderlying` on the guard + planner cross-root tests.
10. Gates: `tsc --noEmit` clean, ESLint clean, full test suite, `next build`.
11. Manual ladder (first qualifying XSP setup): scan → gate → place (L2) → cancel/re-place (L3) → GTC fill reconcile (L4). Can double as the still-pending v2.2 L4 if the XSP GTC fills first.

## 13. Open Questions

All four §12 questions from rev-DRAFT are **resolved** (§0a). Remaining opens are verification-gated only: V1–V8 findings, the `trade_events` root question (§8.3), and the fee-table correction at first real index fill.

**End of v2.4 Index Options spec (DRAFT rev A)**
