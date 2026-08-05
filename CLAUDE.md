# CLAUDE.md — SteelEagle

Single-user iron condor trading dashboard (TOMIC strategy) for one operator: April.
She is the sole developer AND trades live money through this system. Mistakes here
can place, miss, or mangle real orders at Schwab. Act accordingly.

**April is in US Central time. State every wall-clock time in CT.** Market mechanics
that are genuinely Eastern (the 09:30–16:00 ET session, 1:00 PM ET early closes) stay
in ET because that is what the exchange runs on — but anything describing when *she*
should look at something, or when a job fires, is CT.

**Stack:** Next.js 16 (App Router) · TypeScript strict · Tailwind v4 · Neon Postgres
via `@vercel/postgres` · Vercel Hobby (2 cron slots, 1 used — the free slot is
deliberately held open) · Schwab Trader API (OAuth) · deployed at steeleagle.vercel.app

## Gates — run before ANY push, in this order

```bash
npx tsx --test "lib/**/*.test.ts"        # unit tests (currently 489 passing)
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
- **Prior decisions are locked** unless April explicitly reopens them. Session summary
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
    The app cancels the standing GTC; April closes in TOS; **Record Close** journals it.
    **No app-placed closing orders** (Option A explicitly rejected).
  - v2.4 **index options** (XSP/SPX/NDX/RUT) — `docs/steeleagle-v2-4-index-options-spec-revB.md`.
    Build order 3–6 + 9 done: `lib/strategy/instruments.ts` is the single source of truth
    (registry, `resolveUnderlying`, pillars, fees, `minWingWidth`, `apiSymbolFor`).
    `parseOccSymbol` returns `root` AND resolved `underlying` — that one change fixes
    grouping, the equity-block cap, the importer, and the sweep's pre-place guard.
    **Steps 7/8/11 blocked on the XSP place-and-cancel golden fixture (V6/V7).**
  - v2.7 **iron butterfly recognition** — `docs/steeleagle-v2-7-iron-butterfly-spec.md`.
    The structural invariant is now **`LP < SP <= SC < LC`** (April, 2026-08-04): the
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
    **Not yet wired into the cron** — deliberate; watch it run clean first.
- **Schwab AGGREGATES identical-strike positions** into one row at the summed quantity.
  Two 1-lot condors at the same strikes+expiration are indistinguishable from one 2-lot;
  only DIFFERING strikes produce 8 legs (→ `OTHER`). Confirmed live on GLD 2026-09-18,
  2026-08-04. Consequence: the app cannot journal two same-strike condors as separate
  trades cleanly — `underlying|expiration` is the key for the positions route's GTC chip
  AND the sweep's pre-place guard, so the second trade's exit must be placed by hand.
- **500 tests · 1/2 cron slots · no pending migrations.**
- **The cron is `15 21 * * 1-5` = 21:15 UTC — 4:15 PM CT now, 3:15 PM CT in winter.**
  Vercel crons are UTC-only. Docs said "4:15 PM ET" for 19 sessions; the LABEL was wrong,
  not the time (4:15 was always Central). Corrected repo-wide 2026-07-31. The DST margin
  swing (75 min → 15 min in winter) was reviewed and **closed by April 2026-07-31: no
  change** — the only requirement is that the sweep runs after the close. Do not reopen.
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
- **Queued:** v2.4 step 7 (XSP place-and-cancel fixture — April, manual) → v2.3.1
  (roll-form explicit prices — `RollTradeSchema` still coerces `Number('') → 0`).
- **OPEN — April action:** the SPY 2026-08-28 trade's **second roll (720/740 → 745/765)
  was never journaled**. The account holds the butterfly; the journal still reads
  720/740/765/785. Found 2026-08-04 while pinning the butterfly fixture. No bad order
  was placed (verified: `exitOrderId=null`, nothing standing on those legs) — what
  prevented it was `PLACEMENT_MIN_DTE = 24` with the trade at exactly 24 DTE, i.e. the
  calendar, not a guard. Until the roll is journaled, `netCredit` and every number
  derived from it (50% target, P&L, Record Close) are wrong for that trade.
  **An unjournaled roll is a live mis-pricing, not a bookkeeping lag** — the app cannot
  detect one, because the journal is the only record of intent.
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
