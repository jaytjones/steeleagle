# CLAUDE.md — SteelEagle

Single-user iron condor trading dashboard (TOMIC strategy) for one operator: **JJ**.
JJ is the sole developer AND trades live money through this system. Mistakes here
can place, miss, or mangle real orders at Schwab. Act accordingly.

**Refer to the owner/operator/developer as JJ — never by any other name.** Older
documents in `docs/`, code comments, and migration notes still say "April"; that is
the same person under a superseded name. Read those as JJ, and do not reintroduce
the old name in anything new.

**JJ is in US Central time. State every wall-clock time in CT.** Market mechanics
that are genuinely Eastern (the 09:30–16:00 ET session, 1:00 PM ET early closes) stay
in ET because that is what the exchange runs on — but anything describing when *she*
should look at something, or when a job fires, is CT.

**Stack:** Next.js 16 (App Router) · TypeScript strict · Tailwind v4 · Neon Postgres
via `@vercel/postgres` · Vercel Hobby (2 cron slots, 1 used — the free slot is
deliberately held open) · Schwab Trader API (OAuth) · deployed at steeleagle.vercel.app

## Gates — run before ANY push, in this order

```bash
npx tsx --test "lib/**/*.test.ts"        # unit tests (currently 800 passing)
./node_modules/.bin/tsc --noEmit         # THE type gate — tsx transpiles WITHOUT type-checking
rm -rf .next && npm run build            # required especially after deleting routes
```

- `tsx --test` passing does NOT mean the types are clean. `tsc --noEmit` is the gate.
- `tsc --noEmit` is now expected to be COMPLETELY silent. The old pinned TS5097 noise in
  `roll-alert.test.ts` was a lone `.ts` import extension, not a convention — fixed in
  v2.6.1; every other lib test already imported extensionless. Any TS5097 now is real.
  A `.next/types/… 2.ts` conflict means Finder artifacts in the build dir: `rm -rf .next`.
- Use the repo-local toolchain (`./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`).
  Never `npx --yes`.
- After any batch file operation: `find app components lib -name "* 2.*"` — sweep for
  macOS Finder collision artifacts (one has already been committed once).

## The Schwab doctrine — never build from docs alone

Schwab's API documentation is unreliable. Every Schwab interaction path is built from
a **live fixture first**, code second:

- New order type → place-and-cancel a real order, dump it, pin the payload as a golden
  fixture, THEN write the builder against the fixture. See `lib/schwab/order-ticket.ts`
  and `lib/schwab/exit-ticket.ts` for the pattern.
- Known doc traps already caught this way: `duration: "GOOD_TILL_CANCEL"` not `"GTC"`;
  `volatility` is already a percentage; `fromEnteredTime` needs a 180-day lookback for
  standing GTCs; `settlementType` means AM/PM ("A"/"P"), NOT physical/cash; positions
  are flat legs with no reliable strike/expiration fields — parse the OCC symbol.
- Index symbols ($XSP etc.): `/chains` and `/quotes` accept ONLY the `$`-prefixed form.
  `iv_history` stores canonical $-free symbols; `$` exists only at the fetch boundary.

## Safety postures — preserve these, never "simplify" them away

- **Refuse, don't guess.** Ambiguous or partial data (partial fills, leg-count
  mismatches, missing order ids) → refuse the write, flag for the operator, leave state
  intact. Never fabricate prices. This posture exists on every Schwab-facing write path.
- `getWorkingAndRecentOrders` **throws** on failure rather than degrading to `[]` —
  an empty result would permit duplicate GTC placements. Do not soften this.
- The exit sweep acts on **fetched Schwab order state**, never on `trades.exit_order_id`
  alone (the column is bookkeeping, not truth). Never null the column on a fetch gap.
- The cron never cancels working orders. 21-DTE is alert-only. Stop-losses are manual.
- Fail-safe directions are deliberate: settings-read failure → NOT paused (a DB hiccup
  must never disarm exit placement); IV cron skips writes on null IV.
- Server actions **return `ActionResult<T>`, never throw** — Next.js redacts thrown
  server-action messages in production (digest only). Use the `toResult(label, fn)`
  wrapper with server-side `console.error` for Vercel log visibility.
- `@vercel/postgres` tagged templates take scalars only; arrays need
  `sql.query(text, [array])` positional form.

## Build pattern

1. Pure module in `lib/` with unit tests FIRST (no I/O — see `lib/strategy/*`,
   `lib/journal/trade-math.ts`, `planExitSweep`)
2. Wire to API route / server action (glue + per-item try/catch isolation only —
   decisions live in the pure module)
3. Wire to UI last
4. Migrations: dated file in `migrations/`, applied in Neon BEFORE code deploys when a
   SELECT gains a column, and folded into `supabase-schema.sql` in the same commit
   (filename is historical; the DB is Neon)

Fetch and read the actual current source files before writing code that references
repo types — guessing field names causes downstream type errors. When replacing a
file, edit the real current version; verify the diff is exactly the intended changes.

## Process rules

- **Verification-first:** findings and pre-code analysis before implementation. If open
  questions exist, resolve them before writing code.
- **Prior decisions are locked** unless JJ explicitly reopens them. Session summary
  docs in `docs/` are the decision log — check them before re-litigating anything.
  Current-state reference: `docs/steeleagle-prd-v2-3.md` + `steeleagle-tech-spec-v2-3.md`
  (refreshed Session 16). Summaries are evidence, not truth — two documented "facts"
  were wrong in Session 16. Where a doc and the code disagree, the code wins.
- IV Rank needs ~20 trading days of history with no backfill — new symbols go into the
  IV cron as early as possible, never at feature-build time.
- `CRON_SECRET` is a Vercel Sensitive variable and cannot be revealed after creation —
  if rotating, save the new value locally immediately.
- VS Code showing "cannot find module" after file replacement → Restart TS Server
  (confirmed recurring false positive; trust the tsc CLI gate).

## Current state (update as milestones ship)

- **Live: v2.3** (deployed 2026-07-28). The stack as it stands:
  - v2.2 auto-exit sweep in the post-close `snapshot-iv` cron: reconcile fills → clear
    terminal orders → 21-DTE alerts → place 50%-profit GTC closes · placement pause
    toggle (`user_settings.pause_exit_placement`; pauses step (c) ONLY).
  - v2.2.1 Close-form hardening + closed-trade edit + `deriveTotals(events)` —
    `docs/steeleagle-v2-2-1-close-hardening-decisions.md`.
  - v2.3 **Cancel GTC** + `currentStructure(events)` — `docs/steeleagle-v2-3-spec.md`.
    The app cancels the standing GTC; JJ closes in TOS; **Record Close** journals it.
    **No app-placed closing orders** (Option A explicitly rejected).
  - v2.4 **index options** (XSP/SPX/NDX/RUT) — `docs/steeleagle-v2-4-index-options-spec-revB.md`.
    Build order 3–6 + 9 done: `lib/strategy/instruments.ts` is the single source of truth
    (registry, `resolveUnderlying`, pillars, fees, `minWingWidth`, `apiSymbolFor`).
    `parseOccSymbol` returns `root` AND resolved `underlying` — that one change fixes
    grouping, the equity-block cap, the importer, and the sweep's pre-place guard.
    **Steps 7–10 are DONE.** Step 7 was completed 2026-07-30 (order `1007409658003`, an
    unfillable XSP condor placed and cancelled in TOS, read back and pinned; V7 answered —
    index option symbols are standard OCC, byte-identical in form to the ETF convention).
    `orderFixturePinned: true` for XSP shipped in `e3df1ff` with golden tests; SPX/NDX/RUT
    stay `false` and refuse for the separate multi-root reason. **Only step 11 remains** —
    the manual ladder on the first qualifying XSP setup, calendar-blocked to ~Aug 24–25.
  - v2.7 **iron butterfly recognition** — `docs/steeleagle-v2-7-iron-butterfly-spec.md`.
    The structural invariant is now **`LP < SP <= SC < LC`** (JJ, 2026-08-04): the
    `<=` admits the butterfly's zero-width body; **`SP > SC` is never valid** and stays
    refused at every site. A butterfly is an `IRON_CONDOR`, not a new `PositionKind` —
    the two shorts are told apart by putCall, never by strike. Butterflies arise from
    ROLLS only; the scanner cannot make one (16Δ shorts vs ~50Δ) and `PlaceOrderPanel`
    stays strict. **Recognition is free, placement is fixture-gated**: both ticket
    builders hardcode `complexOrderStrategyType: 'IRON_CONDOR'`.
    Also closed a live defect: `currentStructure` compared NO strikes, so any
    mis-ordered structure passed `isPriceableStructure` (green GTC chip, planner queued
    it) and then threw in the placement loop — `report.errors` every sweep run, forever,
    with no exit placed. The ordering check now lives in the ONE predicate.
  - v2.7.1 **butterfly exit gate discharged** (same day). Fixture pinned from a real
    place-and-cancel: **orderId 1007469542479** (SPY 2026-08-28 745/765/765/785) came
    back as `complexOrderStrategyType: "IRON_CONDOR"` — Schwab records a butterfly
    IDENTICALLY to a condor, same SC/LC/SP/LP leg order. Pinned as
    `SPY_BUTTERFLY_GOLDEN` in `exit-ticket.test.ts`. Butterflies are now priceable and
    the sweep auto-places their 50% GTC. **`buildCondorOrder` still REFUSES them** —
    that fixture is a CLOSE, the entry payload is unpinned, and the app must never OPEN
    a butterfly. `order-ticket.test.ts` pins the asymmetry; do not "fix" it by loosening.
  - `scripts/dump-order.ts` — read-only single-order dump by id. Use this over
    `dump-working-orders.ts` (window scan) whenever the order id is known.
  - v2.8 **journal ⇄ account reconciliation** — `lib/journal/reconcile.ts` (pure) +
    `scripts/reconcile-journal.ts`. The missing guard: a missed ENTRY is caught later by
    Import, a missed CLOSE by Record Close, but a missed **roll** had no fallback at all
    (`deduplicateCandidates` keys on underlying+expiration, so a same-expiration roll is
    filtered as `alreadyImported` and its changed strikes are never compared). Verdicts:
    DRIFT / PHANTOM (critical) · UNCOMPARABLE · UNIMPORTED · MATCH. Report-only, never
    repairs — the account is truth for STRUCTURE, but the journal is the only record of
    PRICES and INTENT, which is exactly what repairing a missed roll would need.
    `UNCOMPARABLE` exists so "cannot tell" is never rendered as "healthy".
    Run: `npx tsx --env-file=.env.local scripts/reconcile-journal.ts` (exit 1 = critical).
    **DECIDED 2026-08-04 (JJ): a DRIFT FLAGS, it does NOT block placement.** Blocking
    was rejected — this module is a heuristic in front of a mechanical chain that already
    works (pre-place guard, 24-DTE floor, refuse-don't-guess), and a false positive must
    never suppress a legitimate GTC. **Nothing in the cron may consult
    `report.reconciliation` when deciding what to place — keep it that way.**
  - v2.8 **wired into the cron** (2026-08-04). Isolated try/catch, its own
    `getAccountSnapshot()` call, and it can never abort a sweep. Criticals also push into
    `report.flagged` with a `RECONCILIATION` prefix. `reconciliation.ran: false` is NOT
    "nothing found" — a positions-fetch failure flags `RECONCILIATION DID NOT RUN`, since
    an absent warning identical to a clean bill is how the /quotes 404 hid (v2.6.1).
    `flagged.tradeId` widened to `string | null` (an UNIMPORTED finding has no trade).
  - v2.9 **sweep run visibility** (2026-08-07) — `lib/strategy/sweep-report.ts` (pure) +
    `sweep_runs` table + `GET /api/sweep-runs` + `components/SweepBanner.tsx`.
    The gap Aug 5–6 proved: the sweep detected a live mis-priced GTC on SPY 2026-09-11
    three runs running — reconciliation DRIFT, stale-journal placement, Schwab REJECTED,
    id correctly not stored — and **every detector fired into a log nobody read**, because
    `ExitSweepReport` was only the cron's HTTP response body. Detection was never the
    problem; delivery was. Now persisted and rendered on the dashboard.
    **Flag severity is stamped at the PRODUCER, never inferred from the reason prose.**
    `toFlag` carries `severity: 'critical' | 'routine'`. Routine = the two permanent
    symbol-level refusals ONLY (multi-root index, unpinned fixture), decided via the
    instrument registry — those recur every run by design and must not hold the banner
    red, or it becomes wallpaper and stops being read. Every STRUCTURAL refusal
    (diagonal, vacant leg, strikes not `LP < SP <= SC < LC`) stays **critical** — that is
    the v2.7 defect class. `severity` is required, not optional-with-default, so a new
    flag site cannot be added without the compiler asking which it is.
    `sweepFreshness()` derives "did the cron even fire?" from the clock, since a cron
    that stops firing produces NO report and silence is the one state a report-rendering
    banner cannot show. 2 missed weekday runs = stale (1 would false-alarm on the ~50 min
    of Vercel Hobby drift observed live: 21:17 UTC Aug 4, 22:05 UTC Aug 5 and 6).
    Weekend-aware, and needs no holiday calendar — the Vercel cron is weekday-based, not
    market-based, so a holiday cannot produce a false alarm.
    **`sweep_runs` is WRITE-ONLY from the cron and READ-ONLY everywhere else. Nothing in
    the placement path may read it** — reconciliation flags, it does not block, and a
    HISTORY of flags is weaker evidence than a live one.
  - v2.11 **snapshot-anchored fill ingestion** (2026-08-14) —
    `docs/steeleagle-v2-11-fill-ingestion-spec.md`, Session 23 summary. The account's own
    record is now ledgered and compared: `schwab_fills` (keyed on ORDER ID — positions are
    aggregated, orders are not) + `position_snapshots` anchoring JJ's accounting identity
    `positions(T₀) + Σ effects == positions(T₁)`. A zero residual is a COMPLETENESS PROOF,
    and the residual is exactly the class of events that produce no order at all
    (expirations, assignments). Proved live: the Aug 14 SPY 09-11 SPLIT roll — two VERTICAL
    tickets 4m28s apart that say nothing about being a roll — balances to EXACTLY ZERO.
    **Doctrine: `complexOrderStrategyType` is NEVER read** (rolls came back `CONDOR` ×5 and
    `CUSTOM` ×1, structurally identical); classify from `instruction` alone.
    **`close-from-fill`'s `legRole` must NOT be reused for rolls** — `short = startsWith('BUY')`
    is right for a pure close and WRONG for a roll, where `BUY_TO_OPEN` is a long.
    Unjournaled Activity is the delivery surface, bounded to `ACTIONABLE_WINDOW_DAYS = 7`
    (JJ) — a historical backfill is a DIFFERENT exercise from steady-state detection.
    Items deep-link to `/journal?fill=<orderId>` and pre-fill the Roll/Close form with real
    execution prices; a pre-fill **never fabricates a price** (empty string, never "0.00").
    Both tables are WRITE-ONLY from the cron and READ-ONLY elsewhere; **nothing in the
    placement path may read either.**
  - v2.12 **quantity-aware guard + multiset reconciliation** (2026-08-14) —
    `docs/steeleagle-v2-12-spec.md`. The FIRST change to alter placement behaviour.
    Guard: **place only when `held - covered >= contracts`** — the hazard is OVER-COVERING,
    and "any working close exists" was only ever a proxy for it. `held > covered` was the
    first formulation and is WRONG for a multi-lot trade (2 held, 1 covered, 2-lot → claims
    3 of 2). **Every unknown degrades to the pre-v2.12 blanket rule**, which never
    over-covered: `heldContracts` null, `contracts` absent, or `coveredContracts` null
    (unknown coverage must never read as ZERO coverage). `covered > held` is its own
    CRITICAL flag. Reconciliation compares the UNION of all trades on a key against the
    account as a multiset keyed on **`putCall`, never `role`** (an `OTHER` position carries
    generic LONG/SHORT and loses put-vs-call). **No partitioning** — splitting 8 legs into
    two condors is genuinely ambiguous and a wrong pairing would build a wrong close.
  - v2.12 **`schwab_fill` closes are EDITABLE** (JJ, 2026-08-14 — `dce1472`). Discharges
    v2.11 §8.1. The sweep has always written them and 16 exist live; they were unrepairable
    except by hand SQL. Editing DEMOTES `source` to `'manual'` and **KEEPS
    `schwab_order_id`** — the order id says which fill the leg came from, `source` says
    where the NUMBER came from. Event TYPE and STRUCTURE stay immutable.
- **Schwab AGGREGATES identical-strike positions** into one row at the summed quantity.
  Two 1-lot condors at the same strikes+expiration are indistinguishable from one 2-lot;
  only DIFFERING strikes produce 8 legs (→ `OTHER`). Confirmed live on GLD 2026-09-18,
  2026-08-04. Consequence: the app cannot journal two same-strike condors as separate
  trades cleanly — `underlying|expiration` is the key for the positions route's GTC chip
  AND the sweep's pre-place guard, so the second trade's exit must be placed by hand.
  - v2.10 **expiration selection** (2026-08-07) — `lib/strategy/expiration.ts` (pure).
    The scanner was proposing **28 DTE** (2026-09-04) because expiration choice lived in
    `chains.ts` as "nearest within 28–52". Now: condors are **30–45 DTE, monthly
    preferred**; the tiebreak with no monthly is closest to the **37.5 midpoint**, ties
    break LONGER (deterministic — an unstable tie would make the proposal wobble between
    refreshes). A **monthly wins anywhere in range** (JJ): a 31-DTE monthly beats a
    44-DTE weekly. Outside 30–45 is EXCLUDED, not down-ranked — refuse, don't stretch.
    **THE TRAP, and why this is two selections and not one:** `atmIv` is read off
    whichever expiration is chosen, so changing the pick changes the IV BASIS and
    `iv-basis.ts` mandates minting a new `IV_BASIS_CURRENT` — which would have reset all
    28 symbols from 5 days to 0 and pushed IV Rank from ~Aug 27 to ~Sep 10. It would also
    make the measurement WORSE: a monthly-preferred window samples a jumping tenor, and
    IV term structure turns that into noise in the 52-week range. So the IV rule is
    **extracted VERBATIM and unchanged** (`atm_28_52dte`, nearest within 28–52) and the
    condor rule is separate. 30–45 ⊂ 28–52, so both come from the SAME fetch — the
    request parameters did not change at all. **Never collapse them back into one; they
    agree only by coincidence of the window.** `orderIvCandidates` / `orderCondorCandidates`
    return ORDERED lists so the caller keeps v2.4's fall-through past expirations left
    empty by the index root filter.
    **`expirationType` for a monthly is `"S"` (standard), NOT `"M"`** — probe-pinned
    2026-08-07 across SPY/GLD/TLT/XSP/SPX. Guessing "M" from the docs yields a preference
    that silently never fires, indistinguishable from "no monthly available". Read it only
    through `isMonthlyExpirationType`.
    `ChainResult` no longer has top-level `expiration`/`dte`/`calls`/`puts` — it carries
    `ivExpiration`/`ivDte`/`atmIv` and a **nullable** `condor` block, so the compiler forces
    every call site to say which tenor it means. `buildCondor` takes `CondorChain`, never
    the whole result. **A null `condor` must NOT make `getOptionChain` return null** — the
    IV cron would skip the symbol and punch an unrecoverable hole in its 52-week range.
    Verified live 2026-08-07: SPY/GLD/TLT/XSP all → IV 09-04 (28 DTE), condor 09-18 (42).
- **800 tests · 1/2 cron slots · no pending migrations**
  (`2026-08-07-sweep-runs.sql` applied 2026-08-07; `2026-08-14-fill-ledger.sql` applied
  2026-08-14 — both verified against the live DB, write paths round-tripped.)
- **`jsonb` reorders keys on storage.** A stored `sweep_runs.report` compared to a fresh
  one by `JSON.stringify` is `false` with no data lost — compare structurally
  (`deepStrictEqual`). Confirmed live 2026-08-07. `placed[].price` does survive as the
  string `"2.40"`, not the number `2.4`.
- **The cron is `15 21 * * 1-5` = 21:15 UTC — 4:15 PM CT now, 3:15 PM CT in winter.**
  Vercel crons are UTC-only. Docs said "4:15 PM ET" for 19 sessions; the LABEL was wrong,
  not the time (4:15 was always Central). Corrected repo-wide 2026-07-31. The DST margin
  swing (75 min → 15 min in winter) was reviewed and **closed by JJ 2026-07-31: no
  change** — the only requirement is that the sweep runs after the close. Do not reopen.
  **21:15 is when it is DUE, not when it RUNS.** Vercel Hobby drift has stabilised at
  ~57 min: `sweep_runs` shows 2026-08-11, 08-12 and 08-13 all within 2 seconds of
  **22:12 UTC ≈ 5:12 PM CT** (earlier observations were ~50 min — 21:17 UTC Aug 4,
  22:05 Aug 5–6). Quote the DUE time when scheduling, the OBSERVED time when telling
  JJ when to look. `sweepFreshness`'s 2-missed-run tolerance exists for exactly this
  drift and is unaffected by it.
  - v2.6.1 **delta-staleness marker** — `docs/steeleagle-v2-6-1-delta-staleness-spec.md`.
    RollBadge is exception-only, so "healthy" and "no roll opinion at all" rendered
    identically; a dead `/quotes` path showed up as badges that quietly never appeared
    (exactly how the v2.4 duplicated-URL 404 hid). Now: `Δ STALE` (amber, in-hours =
    fault) / `Δ —` (dim, after-hours = expected), one predicate `deltaMarker()` shared
    by the row marker and the banner. The positions route's roll-annotation catch stamps
    `noDeltaVerdict()` so an exception can never leave a condor unannotated.
    `isRegularMarketHours()` has NO holiday calendar by design — a false alarm on a
    closed day beats a silent miss on an open one.
- **25-symbol IV universe** — XSP/SPX/NDX/RUT calibrating since 2026-07-28
  (complete ~Aug 24–25).
- **Verification owed:** L3-in-app (Cancel GTC from the Monitor on a real sweep-placed
  GTC) · L3 ladder (7/29 `cleared[]` → 7/30 re-place) · L4 (next GTC fill — hands off,
  let the sweep journal it).
- **v2.9 live-run verification DISCHARGED 2026-08-14** (Session 22). `sweep_runs` holds
  rows for Aug 11/12/13 with `severity`, `headline` and per-flag `severity` populated, and
  the Aug 11 run records a real placement (`placed: SPY @2.58`, order `1007557518040` —
  confirmed still WORKING at Schwab). It also captured the GLD rejection streak faithfully,
  two criticals a night. Detection AND delivery both proven on live data.
- **Queued:** **v2.11 step 8 — gated auto-write. DEFERRED by JJ 2026-08-14 until the
  sweep has run.** Its blocking decision (§8.1, uneditable auto-written closes) is
  DISCHARGED (`dce1472`); the remaining gate is purely observational — see the verification
  note below. · **v2.4 step 11** (manual XSP ladder — calendar-blocked to ~Aug 24–25 once
  IV calibration completes; NOT a build task) · Board #17 (expiration date on the Monitor).
  **v2.11 AND v2.12 are SHIPPED, and v2.4 step 7 was DONE 2026-07-30** — all three sat in
  this queue after the code landed, and JJ caught the last one. v2.3.1/v2.3.2 did the
  same for two sessions (`d088f53`, `8b9ab14`). Where a doc and the code disagree, the code
  wins; **check `git log -- <file>` before believing a queue entry.**
- **CLOSED 2026-08-07:** the SPY 2026-08-28 unjournaled roll (journaled — now MATCH) and
  the SPY 2026-09-11 unjournaled roll (journaled 2026-08-07 — now MATCH, credit $548).
  The second GLD 2026-09-18 condor is journaled as its own trade, so GLD now reports
  **UNCOMPARABLE ×2** exactly as Session 20 decision #6 predicted; drift detection on GLD
  is suspended until one leg of the pair closes, and **trade B's GTC must be placed by
  hand** (the pre-place guard sees trade A's standing 1007448830391 on the shared
  `underlying|expiration` key and flags instead of placing).
  **FIXED by v2.12 (`658a7c8`, `891a5fd`).** The guard is now quantity-aware — place only
  when `held - covered >= contracts` — so trade B's GTC places automatically, and
  reconciliation compares the UNION of the pair against the account instead of giving up.
  Live after the change: `match 4 · uncomparable 0`, where it had read `UNCOMPARABLE x2`
  every run for eleven days. Every unknown (positions unavailable, mixed leg sizes, unknown
  order coverage) still degrades to the old blanket rule, which never over-covered.
- **CLOSED 2026-08-14** (Session 22): the SPY 2026-09-11 split roll (two VERTICAL tickets
  4m28s apart — `1007598808689` + `1007598809002`), both GLD 2026-09-18 rolls
  (`1007511371504`, `1007598809028` — 2-lot tickets rolling the aggregated position), and the
  SPY 2026-08-28 close (`1007514529392`, the 745/765/765/785 butterfly, net debit $14.00,
  closed in TOS Aug 7 and unjournaled for a week). Reconciliation went **2 CRITICAL → 0**:
  `match 2 · drift 0 · phantom 0 · uncomparable 2 · unimported 0`.
  **The 11-day lesson:** GLD's exit GTC was REJECTED by Schwab EVERY NIGHT from Aug 3 to
  Aug 13 on strikes that had been rolled away twice. Every rejection was recorded in
  `sweep_runs` and surfaced nowhere else. An unjournaled roll is a live mis-pricing, and a
  GTC Schwab bounces on the same legs nightly is the strongest available signal of journal
  drift — v2.11's inbox must surface REJECTED PLACEMENTS, not only unjournaled fills.
- **The Schwab rejection is an EXTERNAL guard, and it only covers strike drift.** Session
  20 §4a said `PLACEMENT_MIN_DTE = 24` prevented the SPY 8/28 stale-journal close. It did
  not: order **1007468901538** was placed 2026-08-04 4:17 PM CT and Schwab REJECTED it
  ("may result in an oversold/overbought position"). Same on SPY 9/11 — **1007487397396**
  (Aug 5) and **1007505458280** (Aug 6), both rejected. What stops a stale-journal close
  is Schwab's own position validation, not our calendar and not a guard we wrote. It
  works because the legs are not held — so it does **NOT** cover CONTRACT drift (the GLD
  1-vs-2 case), where the order is valid at Schwab and will fill.
  **An unjournaled roll is a live mis-pricing, not a bookkeeping lag** — the app cannot
  detect one from the journal alone, because the journal is the only record of intent.
- Placement eligibility is `isPriceableStructure(events)`, NOT "is it rolled" (v2.3).
  Same-expiration rolls auto-place; diagonals keep the `MANUAL GTC` chip. The planner
  gate and the Monitor chip share that one predicate — keep it that way. v2.4 widened
  it to symbol-level refusals (multi-root index, unpinned order fixture) via
  `structureRefusal()`; `isPriceableStructure` is defined in terms of that, so it
  stays ONE predicate.
- **Index instruments cannot place orders until their fixture is pinned.** Both ticket
  builders throw on `orderFixturePinned: false`. Flipping that boolean in
  `lib/strategy/instruments.ts` is a live-money change — only after a real
  place-and-cancel payload has been dumped and pinned as a golden test.
- Multi-root indices (SPX/NDX/RUT) refuse auto-exit by design: `trade_events` stores no
  symbol, so the root would be a guess. XSP has a single root and is fully placeable.
  Decided 2026-07-29, superseding the rev-A `trade_events.occ_root` migration.
