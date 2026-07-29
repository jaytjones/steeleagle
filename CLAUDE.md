# CLAUDE.md — SteelEagle

Single-user iron condor trading dashboard (TOMIC strategy) for one operator: April.
She is the sole developer AND trades live money through this system. Mistakes here
can place, miss, or mangle real orders at Schwab. Act accordingly.

**Stack:** Next.js 16 (App Router) · TypeScript strict · Tailwind v4 · Neon Postgres
via `@vercel/postgres` · Vercel Hobby (2 cron slots, 1 used — the free slot is
deliberately held open) · Schwab Trader API (OAuth) · deployed at steeleagle.vercel.app

## Gates — run before ANY push, in this order

```bash
npx tsx --test "lib/**/*.test.ts"        # unit tests (currently 214 passing)
./node_modules/.bin/tsc --noEmit         # THE type gate — tsx transpiles WITHOUT type-checking
rm -rf .next && npm run build            # required especially after deleting routes
```

- `tsx --test` passing does NOT mean the types are clean. `tsc --noEmit` is the gate.
- Known-good noise: `roll-alert.test.ts` emits one TS5097 error. Pinned; not a failure.
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
- IV Rank needs ~20 trading days of history with no backfill — new symbols go into the
  IV cron as early as possible, never at feature-build time.
- `CRON_SECRET` is a Vercel Sensitive variable and cannot be revealed after creation —
  if rotating, save the new value locally immediately.
- VS Code showing "cannot find module" after file replacement → Restart TS Server
  (confirmed recurring false positive; trust the tsc CLI gate).

## Current state (update as milestones ship)

- **Live:** v2.2 (auto-exit sweep folded into the 4:15 PM ET `snapshot-iv` cron:
  reconcile fills → clear terminal orders → 21-DTE alerts → place 50%-profit GTC
  closes) + placement pause toggle (`user_settings.pause_exit_placement`; pauses
  step (c) ONLY — reconcile and alerts always run).
- **25-symbol IV universe** — XSP/SPX/NDX/RUT calibrating since 2026-07-28
  (complete ~Aug 24–25).
- **v2.2.1 live** (Close-form hardening + closed-trade edit + `deriveTotals(events)`).
  Decisions + residual gaps: `docs/steeleagle-v2-2-1-close-hardening-decisions.md`.
- **v2.3 BUILT, not deployed** (**Cancel GTC** + `currentStructure(events)`; no
  migration; 278 tests) — `docs/steeleagle-v2-3-spec.md`. The app cancels the standing
  GTC; April closes in TOS; **Record Close** journals it. No app-placed closing orders.
  L3-in-app verification owed.
- **Queued:** v2.3.1 (roll-form explicit prices — `RollTradeSchema` still coerces
  `Number('') → 0`) → v2.4 (index options; spec rev B pending fold-in of
  `docs/steeleagle-v2-4-phase0-findings.md`).
- Placement eligibility is `isPriceableStructure(events)`, NOT "is it rolled" (v2.3).
  Same-expiration rolls auto-place; diagonals keep the `MANUAL GTC` chip. The planner
  gate and the Monitor chip share that one predicate — keep it that way.
