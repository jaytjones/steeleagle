# SteelEagle — Session 17 Summary

**Date:** July 29, 2026
**Milestone:** **v2.4 index options — build order steps 3–6 + 9 BUILT and COMMITTED** (`989dfc8`, 29 files, +2,261/−150) · spec rev B written · one silent live bug found and fixed
**Branch:** main — **committed, deploy status unconfirmed**
**Test baseline:** 278 → **410 passing** (+132, no migrations)

---

## What Was Accomplished

### 1. Verification-first pass — three rev-A spec claims disproved by the code

Per the repo's own rule (*where a doc and the code disagree, the code wins*), the v2.4 rev-A
spec was checked against the shipped source before any code was written. Three claims did not
survive:

- **§6.3 "builder's `wingWidth` sourced from `standardWingWidth` instead of the $10 constant."**
  There is no $10 wing constant. `buildCondor` derives each wing naturally from the 5Δ strike and
  takes the narrower side. The only $10 is `MIN_WING_WIDTH`, a **filter floor**. → became
  per-instrument `minWingWidth`; there is no target width to parameterize.
- **§6.3 "strike-stepping respects `strikeIncrement`."** There is no strike-stepping. Long strikes
  snap to strikes that *actually exist in the fetched chain* (`findNearestStrike`) — strictly
  better than stepping by an assumed increment. → **`strikeIncrement` dropped from the metadata
  interface entirely.** A field nothing consumes rots.
- **§6.4 "generalize the credit ≥ $150 floor to credit ≥ 15% of wing width."** The 15% ratio
  filter *already existed*. On a $10 wing, $150 **is** 15% — the absolute floor was a duplicate
  that silently under-gated wide wings. → the separate filter is **deleted**; the ratio filter now
  reports the derived dollar floor in its message.

### 2. `lib/strategy/instruments.ts` — the single source of truth (build order 3)

25 instruments (21 ETFs + XSP/SPX/NDX/RUT), pure, 35 unit tests. Carries `apiSymbol`,
`occRoots`, `preferredRoot`, `pillar`, `minWingWidth`, `perContractFee`, `settlement`, and
`orderFixturePinned`. `Pillar` and `pillarOf` **moved here** from `position-limits.ts`
(re-exported there for compatibility) — instrument identity is one concern, and the move removed
an import cycle.

Two rev-A shapes changed: `strikeIncrement` dropped (§1 above), and `sameIndexAs` replaced by
declared **groups** (`['SPY','XSP','SPX']`, `['QQQ','NDX']`, `['IWM','RUT']`) so the sibling
relation cannot be recorded asymmetrically.

`settlement` is sourced from config, never from Schwab's `settlementType` — Phase 0 V3 pinned
that the field means AM/PM and reads `"P"` for cash-settled SPXW and physical SPY alike.

### 3. The load-bearing change: one edit, five consumers (build order 4)

`parseOccSymbol` now returns **both** `root` (raw `SPXW`) and `underlying`
(`resolveUnderlying(root)` → `SPX`). Every consumer in spec §5 already read `.underlying`, so
that single change fixed all of them at once — each pinned by a test, not assumed:

| Consumer | Failure it closes |
| :--- | :--- |
| `reconstruct-positions` grouping | one SPX condor split into an "SPXW" pile and an "SPX" pile |
| `position-limits` / entry gate | an SPXW position had pillar UNKNOWN → **equity cap silently bypassed** |
| Importer | same split, plus dedupe never matching a journal `SPX` row → duplicate import |
| **Exit-sweep pre-place guard** | a working SPXW close didn't match a trade stored as `SPX` → **duplicate GTC, real money** |
| `recordFillAction` | an SPXW fill journaled under the wrong symbol |

Unknown roots **pass through to themselves**: ETF behaviour is byte-identical, and a future index
root Schwab introduces degrades to today's behaviour rather than crashing.

### 4. Scanner, entry gate, exit sweep (build order 5, 6, 9)

- **Chains:** `apiSymbolFor()` at the request boundary; **root filtering for index chains only**.
  Phase 0 V2 showed one `$SPX` response mixes SPXW and SPX and that at a monthly expiration both
  land under the **same** `callExpDateMap` key — unfiltered, `findByDelta` would have built a
  "condor" out of two different instruments. The expiration walk is now nearest-first *with
  fallthrough*, so an index expiration existing only under the AM root yields the next tradeable
  one instead of an empty chain. ETF chains pass through untouched.
- **Builder:** per-instrument wing floor, per-instrument commission, derived credit floor. ETFs
  still compute 8 × $0.65 = $5.20 and a $10 floor, pinned by regression tests. One credit test per
  width tier: $10/$10/$25/$50/$200 → $150/$150/$375/$750/$3,000.
- **Settings:** `$`-prefixed input **rejected with a message** per §0a.3. Silent stripping was
  rejected because `iv_history` keys on the canonical form — a `$SPX` cell would calibrate a
  second, permanently-empty history.
- **Entry gate:** `EntryGate` gains **`warnings: string[]`**, deliberately separate from `reasons`
  so no future warning can flip a verdict by landing in the wrong array. The card's gate strip now
  renders on an OK verdict too — gating on status alone would have hidden the same-index warning,
  which by decision never blocks.
- **Cron:** the Phase 0 `INDEX_API_SYMBOLS` shim is **absorbed** into the registry, and
  `DEFAULT_CRON_SYMBOLS` now derives from `INSTRUMENTS` — a symbol added to the registry starts
  its calibration clock immediately, which matters because IV Rank has no backfill.

### 5. Two safety decisions (April, this session)

**A. `trade_events` root retention — NO MIGRATION; refuse multi-root instead.**
Supersedes rev A §8.3. The condition §8.3 set *was* met, but the proposed column doesn't solve
the problem: the **manual journal path has no OCC symbol to populate it from**, so a hand-entered
trade's column would store `preferredRoot` — the same guess, with a schema change on top.
`currentStructure()` now refuses outright for any underlying with >1 OCC root. XSP has a single
root (V2) and is fully placeable, so the milestone still ends trade-ready. **0 pending
migrations.**

**B. Index order placement is gated behind a pinned fixture.** `orderFixturePinned: false` on all
four indices makes both ticket builders throw *and* `currentStructure()` refuse. The Schwab
doctrine made mechanical: Schwab performs no server-side review, so a symbol format guessed from
documentation submits and can execute. Lifting it costs one boolean per instrument — after the
place-and-cancel.

Both refusals fold into the **existing** placement predicate rather than adding a second gate:
`structureRefusal()` returns the real message, and `isPriceableStructure` is defined in terms of
it. The planner gate and the Monitor chip still share exactly one predicate.

### 6. Live bug found and fixed — roll alerts have been dead

`getOptionDeltas` built its URL as `/marketdata/v1/quotes?…` while `marketGet` already prepends
`…/marketdata/v1` — the path segment was duplicated and **every call 404'd**. The positions route
wraps roll-alert annotation in its own try/catch, so this surfaced only as a log line and
silently-absent roll badges. `getQuotes` in the same file always used the correct form. Found
while auditing the module as a §5 consumer; unrelated to indices, on the same code path.

**Not yet confirmed fixed against live data** — needs one market-hours check (see open items).

---

## Key Learnings (repo-wide)

- **A spec written before anyone read the target module is a hypothesis.** Three of rev A's build
  instructions described a builder that doesn't exist. The verification-first rule caught all
  three *before* code was written — which is the entire point of it, and the second session
  running where it paid.
- **Prefer refusing over migrating when the new column can't carry new truth.** The
  `trade_events.occ_root` column would have stored a derived guess for every manually-journaled
  trade. A schema change that adds no information is worse than a refusal, because it *looks*
  like it added information.
- **The doctrine needs a mechanism, not just a habit.** "Never build from docs alone" survived
  four milestones as discipline. `orderFixturePinned` makes it a thrown error — the one place a
  future session could quietly regress it is now a boolean with a test asserting it's `false`.
- **Fix the operator message when you widen a refusal set.** v2.4 added symbol-level refusals to a
  predicate whose flag said *"diagonal, or a leg rolled closed"*. An XSP trade flagged as a
  diagonal would have sent April looking at the wrong thing at 4:15 PM. `structureRefusal` exists
  for that reason alone.
- **A `try/catch` that logs and continues will hide a dead feature indefinitely.** The roll-alert
  404 was invisible because the isolation wrapper did its job perfectly. Isolation should degrade
  the *feature*, not the *signal* — worth a look at whether these swallowed failures deserve a
  surface.
- **`*/` inside a block comment closes it.** A doc-comment glob (`lib/**/*.test.ts`) broke the
  esbuild transform of a new test file. Existing test files write the path without the glob;
  that's why.

---

## Open Items Board (post-Session 17)

1. **v2.4 steps 3–6 + 9 COMMITTED** as `989dfc8`. Gates were green at commit time: 410 tests ·
   `tsc` clean · `next build` clean · collision sweep clean. **Deploy not confirmed** — verify the
   Vercel build went green, then watch the first 4:15 PM CT sweep after it. Two behaviour changes
   land with no further prompt: (a) the equity block now counts index positions, so an equity
   candidate can BLOCK where it previously passed; (b) an open index trade in the journal, if one
   existed, would now be flagged MANUAL GTC rather than placed.
2. **v2.4 step 7 — XSP place-and-cancel golden fixture (April, manual). BLOCKING steps 8 and 11.**
   Place a deliberately unfillable XSP condor (NET_CREDIT well above market) in TOS → dump via
   `scripts/dump-working-orders.ts` → cancel. Answers V6 + V7. Until then no index order can be
   built at all, by design.
3. **Roll-alert fix needs live confirmation** — one market-hours load of a page with an open
   condor: expect a real verdict (`NONE`/`WATCH`/`ROLL`) rather than `NO_DELTA`.
4. **Carried from Session 16, status unknown — not revisited this session:**
   L3 ladder (7/29 `cleared[]` → 7/30 re-place) · L3-in-app (Cancel GTC *from the Monitor*) ·
   L4 (next GTC fill — hands off, let the sweep journal it) · first real ENTRY fill.
5. **v2.3.1** — roll-form explicit prices (`RollTradeSchema` still coerces `Number('') → 0`).
   Now queued *after* v2.4 step 7.
6. **Fee table** — index `perContractFee` values are estimates; corrected at the first real index
   fill.
7. **`minWingWidth` for indices** — seeded proportionally from spec §2; tune against a real
   full-chain look at XSP once it calibrates.
8. **Calibration completes ~Aug 24–25** for XSP/SPX/NDX/RUT (started 7/28, no backfill).
9. **Pre-existing ESLint errors** (4, all in files untouched this session): `app/journal/page.tsx`
   and `app/dashboard/page.tsx` `set-state-in-effect`, `PlaceOrderPanel.tsx` unescaped entities.
10. **Doc-refresh queue:** `user_settings` + `pause_exit_placement` still absent from the committed
    schema file · the `atm_iv ≤ 0` doc-vs-code note · strategy doc §3 same-index line + §7 1256
    sentence.
11. **Operator override on ALL verdicts** (April, 7/27) — unscheduled. Plus the display bug it
    surfaced: a card shows "15.0%" while its FAIL reason says "14.9%".
12. **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.

---

## Pickup checklist

```
SteelEagle post-Session 17. State: v2.4 steps 3-6 + 9 COMMITTED (989dfc8);
deploy unconfirmed · 410 tests · 1/2 cron slots · no pending migrations ·
25-symbol IV universe calibrating since 7/28 (completes ~Aug 24-25).

FIRST, ask April:
- Did 989dfc8 deploy green, and did the first sweep after it look normal?
  (watch for: equity candidates newly BLOCKED now that indices count toward
   the block; any index trade flagged MANUAL GTC)
- Has the XSP place-and-cancel been run? (step 7 -- blocks steps 8 and 11)
- Carried from S16, never revisited: did the 7/29 sweep report cleared[]?
  did 7/30 re-place? has Cancel GTC been run from the MONITOR (not TOS)?
  any GTC FILL since (L4)?
- Roll badges: on a market-hours load, do open condors show a real verdict now
  rather than NO_DELTA?  (confirms the getOptionDeltas 404 fix)

Read first:
- steeleagle-v2-4-index-options-spec-revB.md   (S0 = the 3 rev-A corrections;
                                                S0a.5/.6 = the two new decisions;
                                                S12 = build-order status table)
- steeleagle-v2-4-phase0-findings.md           (V1-V5, V8 pinned; V6/V7 open)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 410 passing
2. ./node_modules/.bin/tsc --noEmit    -> clean (roll-alert TS5097 noise ok;
                                          rm -rf .next FIRST or .next/types
                                          collision artifacts add false errors)
3. rm -rf .next && npm run build       -> clean
4. find app components lib -name "* 2.*"  -> empty

Decisions locked this session (do NOT re-litigate):
- NO trade_events root column. Multi-root indices (SPX/NDX/RUT) REFUSE auto-exit;
  XSP is single-root and fully placeable.  (supersedes rev A S8.3)
- Index order placement gated by orderFixturePinned; flipping it is a live-money
  change, only after a real place-and-cancel payload is pinned as a golden test
- strikeIncrement is NOT modelled (the builder snaps to real chain strikes)
- minWingWidth replaces standardWingWidth (a floor, not a target)
- the absolute $150 credit floor is DELETED; the 15% ratio filter is the rule
- chains root-filtering applies to INDICES ONLY; ETF chains pass through untouched
- EntryGate.warnings is separate from .reasons and never affects status
- isPriceableStructure stays ONE predicate (now defined via structureRefusal)

Next work, in order: confirm deploy -> XSP fixture (April) -> steps 8/11
(pin V6/V7, flip XSP's orderFixturePinned, run the manual ladder) -> v2.3.1.
```

**Final state:** v2.4 steps 3–6 + 9 committed and gate-clean (`989dfc8`), deploy unconfirmed ·
step 7 (XSP fixture) is the sole blocker on a trade-ready index milestone · roll alerts un-broken
after an unknown period dead · 410 tests · 1/2 cron slots · no pending migrations.
