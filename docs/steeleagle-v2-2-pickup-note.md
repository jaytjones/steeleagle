# SteelEagle — v2.2 Auto-Exit: Pickup Note (pre-spec)

**Date:** July 22, 2026 (end of Session 12)
**Status:** Design shape agreed + fully de-risked. Spec NOT yet written — drafting the spec is the FIRST artifact of the next session.
**Companion docs:** `steeleagle-session-12-summary.md`, `steeleagle-v2-1-panel-editing-override-spec.md`

---

## The design shape (agreed Session 12 — don't re-derive)

The milestone is NOT "a cron that closes trades." It is:

**1. GTC-at-fill (the core build).** The 50%-profit exit price is definitionally half the collected credit — fixed at entry, no market data needed. So: extend the v2.0 fill flow — fill confirms → auto-journal (exists) → place a standing **GTC NET_DEBIT buy-to-close at 50% of the actual fill credit**. Schwab works it continuously; the exit fires intraday the moment the market touches it. The market does the timing. A 4:15-only cron design was rejected because it can never fill same-day and would exit profitable trades into next morning's open (worst spread window).

**2. Two thin folded cron legs (bookkeeping only, ZERO new slots):**
- **12:00 UTC (pre-market), folded into snapshot-earnings:** reconcile GTC fills → journal `close` events (`close_reason='profit_target'`); flag today's 21-DTE exits before the open.
- **4:15 PM ET (post-close), folded into snapshot-iv:** 21-DTE sweep — cancel that position's standing GTC, place (or alert for) the forced close (`close_reason='21_dte'`); reconcile anything that filled today.

**3. Stop-losses stay manual** — per strategy; nothing here promises auto-stops.

## Verified facts (Session 12 — all three pre-verification items GREEN)
1. **Schwab accepts GTC on complex/multi-leg orders** — confirmed live by April.
2. **A NET_DEBIT placed after hours (~4:20 PM) queues cleanly** for the next session — confirmed live by April.
3. **Duration budget is a non-issue:** Vercel Hobby with Fluid compute (default for new projects; SteelEagle deployed post-cutoff — verify the Fluid toggle in dashboard Settings → Functions) = **300s default AND max** per invocation, cron limits identical to function limits. The stale 10s/60s figures apply only to pre-April-2025 non-Fluid projects. Sources: vercel.com/docs/functions/limitations, vercel.com/docs/cron-jobs/manage-cron-jobs.

## Platform constraints on record
- **Hobby cron timing is only guaranteed within the scheduled hour.** Both folded jobs tolerate this (post-close job is fine anywhere after 4:00 PM ET; 12:00 UTC slipping an hour = 9:00 AM ET, still pre-open). Timing-precise crons (e.g. "close at 3:55 before the bell") are OFF THE TABLE on Hobby.
- **Hobby crons are strictly once-per-day** — no intraday sweep possible regardless of slots. This is why GTC-at-fill carries the intraday exit load.

## Design principles that carry over (non-negotiable)
- **Cron-placed orders journal ONLY on confirmed fill**, reconciled at the next run. The cron never assumes an exit happened. Same refusal semantics as `recordFillAction`.
- **Exit logic must be try/catch-isolated per item** inside the host crons — an exit-sweep failure must NEVER drop IV rows or earnings rows.
- **Server actions / routes return results, never throw operator-facing messages** (Session 12 ActionResult contract).
- **Golden fixture before builder code:** place ONE real GTC NET_DEBIT condor close in TOS, dump it with `scripts/dump-working-orders.ts`, pin the exact shape (`duration: "GTC"`, `orderType: "NET_DEBIT"`, whatever `complexOrderStrategyType` Schwab records for the close, leg instructions BUY_TO_CLOSE/SELL_TO_CLOSE). Never build from docs. This is a BUILD-phase task, first step of implementation.

## Open questions for the spec (resolve while drafting)
1. **Where does the GTC order id live?** The journal needs to associate the standing exit order with its trade (for reconciliation + 21-DTE cancel). Candidates: new column on `trades` (e.g. `exit_order_id`), vs. a convention in notes, vs. querying Schwab working orders by symbol+expiration at reconcile time. A column is probably right; check migration cost.
2. **50% of what, exactly?** Actual net fill credit (from the journal) vs. displayed order credit. Should be the journaled net credit per share; confirm rounding vs. `formatOrderPrice` truncation rules.
3. **Rolls:** a roll changes total credit collected — does the standing GTC get canceled/replaced on roll? (Rolls are manual today; probably: panel/journal roll flow flags the stale GTC for manual adjustment in v2.2, auto-replace is future scope.)
4. **21-DTE forced close: auto-place or alert-only?** Placing a market-hours-queued NET_DEBIT at a computed price from a cron is a bigger autonomy step than a GTC at a definitionally-known price. Decide the v2.2 line. (Lean: alert-first, auto-place as explicit follow-up — mirrors the v1.x→v2.0 progression.)
5. **Partial fill of the closing order** — same refusal-to-journal posture as entry fills; confirm the reconcile path degrades to a flag, not a guess.
6. Does the 4:15 job need Schwab auth headroom? (Crons are middleware-exempt via CRON_SECRET but still need a valid Schwab refresh token — a token expired >7 days kills the exit sweep silently. Decide how the cron surfaces auth failure: results row? alert flag in response?)

## Prereqs before v2.2 code ships
- v2.1 is live and wrapped (done, Session 12).
- **§8 #5 / de-facto Layer 4 still open:** the first real production fill validates `recordFillAction` end-to-end. GTC-at-fill EXTENDS that exact flow — strongly prefer observing one real fill before shipping v2.2's placement step, since it chains off the same confirmed-fill event.

## Pickup checklist

```
Starting SteelEagle v2.2 — auto-exit (GTC-at-fill + folded cron bookkeeping).
FIRST ARTIFACT: the v2.2 spec, drafted from this note.

Read first:
- steeleagle-v2-2-pickup-note.md            (this doc)
- steeleagle-session-12-summary.md           (v2.1 ship + ActionResult contract)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 207 passing.
2. ./node_modules/.bin/tsc --noEmit     -> clean (roll-alert.test.ts noise ok).
3. npm run build                        -> clean.

Ask April at pickup:
- Has a real fill happened yet? (closes §8 #5; gates the placement half of v2.2)
- Fluid compute confirmed ON in the Vercel dashboard?
- Answers/leanings on open questions 1–6 above.
```

**End of v2.2 pickup note**
