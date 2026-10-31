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
npx tsx --test "lib/**/*.test.ts"        # unit tests (currently 999 passing)
./node_modules/.bin/tsc --noEmit         # THE type gate — tsx transpiles WITHOUT type-checking
rm -rf .next && npm run build            # required especially after deleting routes
```

- `tsx --test` passing does NOT mean the types are clean. `tsc --noEmit` is the gate, and it
  is expected to be COMPLETELY silent — any TS5097 is real. A `.next/types/… 2.ts`
  conflict means Finder artifacts in the build dir: `rm -rf .next`.
- Use the repo-local toolchain (`./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`).
  Never `npx --yes`. Known pre-existing lint: `set-state-in-effect` in `app/journal/page.tsx`.
- After any batch file operation: `find app components lib -name "* 2.*"` — sweep for
  macOS Finder collision artifacts (one has already been committed once).

## The Schwab doctrine — never build from docs alone

Schwab's API documentation is unreliable. Every Schwab interaction path is built from
a **live fixture first**, code second:

- New order type → place-and-cancel a real order, dump it, pin the payload as a golden
  fixture, THEN write the builder against the fixture (`lib/schwab/order-ticket.ts`,
  `lib/schwab/exit-ticket.ts`). Use `scripts/dump-order.ts <id>` (read-only) whenever the
  order id is known; `dump-working-orders.ts` only to scan a window.
- Known traps already caught this way:
  - `duration: "GOOD_TILL_CANCEL"` not `"GTC"` · `volatility` is already a percentage ·
    `fromEnteredTime` needs a 180-day lookback for standing GTCs · `settlementType` means
    AM/PM ("A"/"P"), NOT physical/cash.
  - Positions are flat legs with no reliable strike/expiration — parse the OCC symbol.
    **Identical-strike positions are AGGREGATED** into one row at the summed quantity: two
    1-lot condors at the same strikes are indistinguishable from one 2-lot.
  - Index symbols: `/chains` and `/quotes` accept ONLY the `$` form. `iv_history` stores
    canonical `$`-free symbols; `$` exists only at the fetch boundary (`apiSymbolFor`).
    `lib/strategy/instruments.ts` is the single source of truth for instruments;
    `parseOccSymbol` returns both `root` and the resolved `underlying` — group by underlying.
  - A monthly is `expirationType "S"`, NOT `"M"` — read only via `isMonthlyExpirationType`.
  - **`complexOrderStrategyType` is NEVER read** (rolls came back `CONDOR` and `CUSTOM`,
    structurally identical). Classify from `instruction` alone.
  - **A cancellation is filed as an EXECUTION** (`executionType: "CANCELED"`, full legs at
    price 0, non-zero quantity). `executionType` is the only discriminator, and
    `executionScope()` / `movedNothing()` in `lib/schwab/executions.ts` are the ONE place
    that reads it. Quantity and price are not discriminators.
  - Money-market sweeps (SWVXX: `MUTUAL_FUND`, bare `BUY`, fractional quantity) are always
    in the order window.
  - A butterfly CLOSE is recorded identically to a condor (`IRON_CONDOR`, same leg order).
  - The 7-day re-auth window runs from the INTERACTIVE login; a refresh does NOT extend it.

## Safety postures — preserve these, never "simplify" them away

- **Refuse, don't guess.** Ambiguous or partial data (partial fills, leg-count
  mismatches, missing order ids, two candidate owners) → refuse the write, flag for the
  operator, leave state intact. **Never fabricate prices** — a pre-fill leaves an unknown
  price blank (never "0.00"); a write refuses it.
- `getWorkingAndRecentOrders` **throws** on failure rather than degrading to `[]` —
  an empty result would permit duplicate GTC placements. Do not soften this.
- The exit sweep acts on **fetched Schwab order state**, never on `trades.exit_order_id`
  alone (the column is bookkeeping, not truth). Never null the column on a fetch gap.
- The cron never cancels working orders. 21-DTE is alert-only. Stop-losses are manual.
  **No app-placed closing orders** — the app cancels a GTC; JJ closes in TOS.
- Fail-safe directions are deliberate: settings-read failure → NOT paused; IV cron skips
  writes on null or ≤ 0 IV; unknown held count / coverage / size → the strict guard;
  **unknown coverage never reads as zero coverage**.
- **"Cannot tell" is never rendered as "healthy".** Every isolated check that fails
  reports `ran: false` as CRITICAL — never as "nothing found".
- Server actions **return `ActionResult<T>`, never throw** — Next.js redacts thrown
  server-action messages in production. Use `toResult(label, fn)`.
- `@vercel/postgres` tagged templates take scalars only; arrays need
  `sql.query(text, [array])`. **`jsonb` reorders keys** — compare stored reports
  structurally (`deepStrictEqual`), never by `JSON.stringify`.

## Build pattern

1. Pure module in `lib/` with unit tests FIRST (no I/O — decisions live here)
2. Wire to API route / server action (glue + per-item try/catch isolation only)
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
- **Prior decisions are locked** unless JJ explicitly reopens them. Session summary docs
  in `docs/` are the decision log — check them before re-litigating anything.
  Current-state reference: `docs/steeleagle-prd-v2-16.md` + `steeleagle-tech-spec-v2-16.md`
  (Session 28). Per-milestone specs (`docs/steeleagle-v2-*-spec.md`) hold each feature's
  decisions and as-built record. Summaries are evidence, not truth: where a doc and the
  code disagree, the code wins — and **check `git log -- <file>` before believing a queue
  entry** (shipped work has sat in the queue for sessions more than once).
- Refresh the PRD + tech spec every ~5 sessions or when a milestone changes behaviour,
  and fold new invariants into the list below rather than appending session narrative.
- IV Rank needs ~20 trading days of history with no backfill — new symbols go into the
  IV cron as early as possible, never at feature-build time.
- `CRON_SECRET` is a Vercel Sensitive variable and cannot be revealed after creation —
  if rotating, save the new value locally immediately.
- VS Code showing "cannot find module" after file replacement → Restart TS Server
  (confirmed recurring false positive; trust the tsc CLI gate).

## Current state

- **Live: v2.16** (2026-10-31). Latest summary: `docs/steeleagle-session-28-summary.md`.
  **999 tests · 1/2 cron slots · no pending migrations.**
- **Owed live verifications** (nothing to build): first production writes of the
  auto-journal for entries, rolls and closes (NOTE → `GTC HELD` → confirm → placement) ·
  first roll-price edit · the `createTrade` duplicate guard · a NON-trivial BALANCED night
  (an interval containing a real fill, ideally a cancelled GTC) · v2.4 step 11 (manual
  XSP ladder) · L3-in-app (Cancel GTC on a sweep-placed GTC) · L3 ladder.
- **Open question — the self-resolving PHANTOM.** Reconciliation reads `openTrades` once,
  before the sweep journals a close in the same run, so a night where everything worked can
  flag that trade critical. **Deliberately NOT fixed**: both fixes cross an isolation
  boundary drawn on purpose.
- **Queued (unscheduled):** automatic split-roll pairing · at-fill exit placement ·
  entry-leg editing · diagonal exits · a `sweep_runs` audit for Aug 20 – Oct 30.

## Invariants — do not loosen

### Placement (the sweep's step (c))
- Eligibility is `isPriceableStructure(events)` — ONE predicate shared by the planner and
  the Monitor chip. It includes the symbol-level refusals (`structureRefusal`).
  `structureOnlyRefusal` / `foldStructure` exist for JOURNAL writes only — **never use them
  for placement.**
- Structure invariant **`LP < SP <= SC < LC`**. The `<=` admits the iron butterfly;
  **`SP > SC` is never valid** anywhere. A butterfly is an `IRON_CONDOR`; the shorts are told
  apart by putCall, never by strike. Butterflies arise from rolls only; their exits
  auto-place. **`buildCondorOrder` still refuses butterflies** — the app must never OPEN
  one; `order-ticket.test.ts` pins the asymmetry, do not "fix" it.
- **Pre-place guard: place only when `held − covered ≥ contracts`.** Every unknown degrades
  to the pre-v2.12 blanket rule (any working close blocks). `covered > held` is critical.
- `PLACEMENT_MIN_DTE = 24`. Terminal order → clear; re-place on the NEXT run.
- **`orderFixturePinned` is a live-money switch** — flip it only after a real
  place-and-cancel payload is pinned. XSP is pinned; SPX/NDX/RUT also refuse auto-exit by
  design (`trade_events` stores no symbol, so the OCC root would be a guess).
- **The GTC hold** (`trades.exit_hold_order_id` + `exit_hold_at`): set in the SAME
  transaction as an automatic entry/roll write; the planner places nothing while it is set;
  it can only WITHHOLD. Flag routine, **critical after 3 unconfirmed runs** counted from the
  clock (`expectedRunsBetween`), critical if its age is unreadable. Cleared only by JJ's
  confirm (guarded on the order id shown) or by a close. A manual roll does not clear it.
- **Pause stops step (c) ONLY.** Reconcile, clear, alerts and the auto-journal always run.
- **Reconciliation FLAGS, it never blocks** (JJ, 2026-08-04). Nothing in the cron may
  consult `report.reconciliation` when deciding what to place.
- **`sweep_runs`, `schwab_fills` and `position_snapshots` are write-only from the cron and
  read-only elsewhere. Nothing in the placement path may read them.**
- Schwab's own order validation is an EXTERNAL guard that only covers STRIKE drift (legs
  not held → rejected). It does not cover CONTRACT drift. An unjournaled roll is a live
  mis-pricing, not a bookkeeping lag.

### Sweep reporting
- **Flag severity is stamped at the PRODUCER, never inferred from prose**, and is a
  required field. `routine` = the permanent symbol-level refusals (multi-root index,
  unpinned fixture) and a young GTC hold. Every STRUCTURAL refusal stays `critical`.
- Each isolated pass (reconciliation, ingestion, each auto-journal pass) reports `ran:false`
  as critical with its own prefix; `summarizeSweepRun` backstops each.
- Freshness comes from the clock (`sweepFreshness`): 2 missed weekday runs = stale.
- The Monitor renders ONE GTC chip per journal trade on a position (`exit-links.ts`, a
  LIST per key); an unpriceable link renders id-only, never dropped; a multi-trade row shows
  `NO GTC` rather than nothing. A held trade shows `GTC HELD`.
- NOTES are a fourth channel — what the sweep did for JJ — shown on every banner state.

### Fill ledger and the position identity
- `positions(T₀) + Σ effects == positions(T₁)`. **A zero residual proves COMPLETENESS, not
  correctness.** No anchor = UNANCHORED, never an empty-vs-empty balance.
- The identity is an OPTION-leg identity on both sides: a non-option leg is a KNOWN ZERO;
  a cancellation is a KNOWN ZERO. **A refusal means "in scope but unknown" — never "out of
  scope".** Over-refusing disarms the proof.
- The cron's `NOT_OPTION` filter guards the INBOX only; `sumEffects` reads the unfiltered
  orders by design. Scope is checked BEFORE the window (a fund settles days late).
  Intervals and windows are bound by FILL time, never by when a GTC died.
- `close-from-fill`'s `legRole` (`short = BUY`) must NEVER be reused for rolls — on a roll
  `BUY_TO_OPEN` is a long. Use the F3 table (`fillLegRole`).
- Unjournaled Activity is bounded to `ACTIONABLE_WINDOW_DAYS = 7` (JJ), and surfaces
  REJECTED placements as well as unjournaled fills — a GTC Schwab bounces nightly on the
  same legs is the strongest journal-drift signal (GLD, Aug 3–13).
- Ad-hoc check: `npx tsx --env-file=.env.local scripts/reconcile-journal.ts` (exit 1 =
  critical). Replays: `scripts/dry-run-auto-roll.ts`, `scripts/dry-run-auto-entry.ts`.

### Auto-journal (`runAutoJournal`, step (d))
- **Gate: the interval `(anchor, now]` balances to zero — `BALANCED` whitelist, all or
  nothing** (`auto-journal-gate.ts`, shared). Eligibility is the INTERVAL, not the inbox's
  7 days. Only `disposition = 'pending'` is eligible.
- Passes run **entries → rolls → closes**, trades re-read between, AFTER every placement
  decision. Refusals are recorded, not flagged (each stays an inbox card); writes are NOTES;
  a write that throws is critical. The route re-derives each write from the LIVE order and
  refuses unless it matches the plan.
- Never guess an owner: `closeOwners` returns a list; more than one → refuse (two
  same-strike trades). Contract mismatch → refuse. Auto-closes record `closeReason: manual`.
- Rolls: same-expiration, single-ticket only, closing legs must equal the CURRENT fold,
  already-journaled skipped via `matchFill`. The provenance note goes on each EVENT —
  `rollTrade`'s trade-level `notes` would overwrite JJ's own.
- Entries: deduped by **Schwab order id** (a scale-in becomes its own trade); a same-strike
  trade with no order id refuses. **`createTrade` refuses an entry order id already
  journaled**, for every caller.

### Journal
- Blank is never $0.00: every form carries `null` for blank (`*Draft` types — never widen a
  Draft to its Input). $0.00 is legal; blank is not.
- BPR is derived (`entryBpr`) and null — never guessed — when underivable. **No gate reads
  `initial_bpr`**; it is a journal record.
- Editing a `schwab_fill` leg demotes `source` to `manual` and KEEPS `schwab_order_id`.
  Event type and structure are immutable. Roll edits are PRICES ONLY and refuse while a GTC
  stands. Entry legs are not editable.
- **Two same-strike condors are a deliberate, supported workflow** (JJ, 2026-08-14) — they
  stay TWO trades with their own credits and 50% targets. Import cannot see the second
  (Schwab aggregates); auto-entry can. `matchFill` attribution between identical trades
  takes `[0]` and is not meaningful.
- Format YYYY-MM-DD dates from the STRING, never via `new Date(...)` — UTC midnight renders
  a day early in Central.

### Auth
- The stored re-auth deadline WARNS; Schwab decides whether a grant is live.
  `storeTokens(…, newAuthorization)` — callback `true`, refresh `false` (refresh keeps the
  deadline via `COALESCE`). A token-endpoint 4xx records the lapse (`LEAST`); a 5xx does not.
- A page that must show live state needs a request-time signal (`await searchParams`) —
  DB I/O alone does not stop Next from prerendering it.

### Scanner and IV
- **Two expiration selections, never collapse them:** condors use 30–45 DTE, monthly
  preferred; the IV measurement keeps `atm_28_52dte` (nearest within 28–52). They agree only
  by coincidence of the window. A null `condor` block must NOT make `getOptionChain` return
  null — the IV cron would punch a hole in the 52-week range. `orderIvCandidates` /
  `orderCondorCandidates` return ORDERED lists so callers fall through past expirations the
  index root filter leaves empty.
- The IV cron calls the same `getOptionChain` as the scanner; `iv_history.iv_basis` keeps
  measurement eras apart. Changing the IV pick means minting a new basis.
- Delta marker: `Δ STALE` in market hours is a fault, `Δ —` after hours is expected — one
  predicate (`deltaMarker`) for row and banner; the positions route's catch stamps
  `noDeltaVerdict()` so no condor is left unannotated. `isRegularMarketHours()` has no
  holiday calendar by design (a false alarm on a closed day beats a silent miss).

### The cron schedule
- `15 21 * * 1-5` = 21:15 UTC = **4:15 PM CDT / 3:15 PM CST**. Vercel crons are UTC-only.
  The DST margin was reviewed and **closed by JJ 2026-07-31 — do not reopen.**
- 21:15 is when it is DUE, not when it RUNS: Vercel Hobby drift has run in stretches of
  ~57, ~19 and ~12 minutes. Quote the DUE time when scheduling; when telling JJ when to
  look, quote the most recent OBSERVED run from `sweep_runs`.
