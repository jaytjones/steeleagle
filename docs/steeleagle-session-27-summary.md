# SteelEagle — Session 27 Summary

**Date:** October 30, 2026
**Milestone:** **landing page un-frozen** · **BPR derived, not typed** · **v2.15 auto-journal ROLLS designed (not built)**
**Branch:** main
**Test baseline:** 878 → **885 passing** · `tsc --noEmit` silent · build clean · eslint clean on touched files
**Migrations:** none this session. v2.15 will need one (`trades.exit_hold_order_id`).

---

## The shape of this session

A short housekeeping session before the next build: JJ brought three small items.
Two turned out to be quick fixes; the third was a design question that needed her decisions,
got them, and became a spec.

1. "The landing screen still says the refresh token is good until Aug 25, but I've refreshed many times since."
2. "How can the nightly sweep log rolls automatically instead of me doing them by hand?"
3. "Manual entries ask for BPR, but it's just wing width × 100 − credit. Why isn't it calculated?"

---

## 1. The landing page was a static file

### Finding

The auth code was not the problem. v2.13's `storeTokens` has been correct since
`81313a4`: the OAuth callback passes `newAuthorization: true` and resets the deadline.
A read-only DB check (timestamps only, no token values) showed the deadline on file is
**Mon Nov 2, 4:02 PM CT**, which means JJ's last interactive login was around Mon Oct 26,
4:02 PM CT. Every re-login had been recorded.

`app/page.tsx` was **in the prerender manifest**, and the local `.next` build from Aug 20
had `valid until: Tue, Aug 25, 10:10 AM CT` written into `index.html`. Next 16 decides
static vs dynamic from request-time signals (`cookies()`, `headers()`, awaited
`searchParams`, `connection()`). **A Postgres read through `@vercel/postgres` is not one**,
so Vercel built `/` once per deploy and served the result forever.

Consequences:
- **The landing page could never show `soon` or `expired`.** It showed whatever state was
  true at deploy time. That is the v2.6.1 / v2.9 failure shape again: a warning that is
  structurally unable to fire.
- **The `?error=` banner never worked either.** In Next 16 `searchParams` is a Promise, so
  the old synchronous `searchParams.error` read was always `undefined`.

The dashboard was never affected. `ReauthBanner` gets its data from a client-side fetch
to a dynamic API route, so it was live and correct all along.

### Fix

`Home` now takes `searchParams: Promise<{ error?: string }>` and its first line is
`const { error } = await searchParams`. That one `await` makes the page render per
request *and* fixes the error banner. A comment marks the `await` as load-bearing.
Verified in a clean build: `/` is listed as `ƒ` (dynamic) and is gone from
`prerender-manifest.json`.

**General lesson, now in CLAUDE.md:** a page that must show live state needs a
request-time signal, not just I/O.

`/dashboard`, `/journal` and `/login` are still prerendered. That is correct: all three
are `'use client'` shells that fetch their data in the browser.

### Timing JJ needs (CT)

- The 48-hour warning starts **Sat Oct 31, ~4:02 PM CT**.
- Daylight saving ends **Sun Nov 1**, so the cron (21:15 UTC) is due at **3:15 PM CT**
  from Monday.
- Observed drift has ranged from 12 to 57 minutes, so **Monday's sweep could land after
  the 4:02 PM lapse**. Re-login over the weekend or Monday morning.

---

## 2. BPR is derived, not typed

### Finding

There was no reason behind it; it had just never been wired in. The formula already
existed in `recordFillAction` (`order-actions.ts`, the at-fill path):
`max(put wing, call wing) × 100 × contracts − net credit dollars`. The Monitor's
`reconstruct-positions` uses the same formula. Only the three hand paths asked JJ to type
it: the New Trade form, the Import review card, and the CONDOR_OPEN pre-fill (which
refuses).

Also found: **as far as a search can tell, `initialBpr` is stored but never read.** The
header's open-BPR chip comes from live positions (`lib/strategy/bpr.ts` via
`reconstruct-positions`), not the journal. The `types.ts` comment saying a 0
"under-counts capital in the position-limit and BPR gates" looks out of date. This came
from a grep, not a full trace, so it is noted but not acted on.

### Shipped

- **`entryBpr(legs, contracts)`** in `lib/journal/trade-math.ts` (pure, built on the
  existing `entryWingWidth` + `tally`). It returns **null, never a guess**, when any leg is
  missing or the contract count is not a positive integer. It also returns null when the
  result is ≤ 0, because a credit that meets or exceeds the wing is a typo, not a BPR.
  `enteredBpr` still refuses the blank. 7 tests, including JJ's worked example
  (10-wide, $2.35 → **765**), asymmetric wings, a butterfly body and contract scaling.
- **New Trade form:** the BPR field follows the legs as JJ types them. `bprOverride` is
  `null` while it is following the legs; typing switches to an override, and `↺ auto (n)`
  switches back. Clearing the field keeps it blank (an override of `""`) rather than
  silently refilling it. The derived value is built from the same `numOrNull` the draft
  uses, so a blank leg can never enter the arithmetic as zero.
- **Importer:** `groupIntoCondors` stamps the BPR from the marks, and
  `enrichWithOrderHistory` re-stamps it from the real fills. Both go through one
  `withDerivedBpr` helper, and the value stays 0 (the existing "not set" placeholder) when
  the legs don't price. `candidateEntryLegs` is exported so the card uses the same mapping.
  Pinned in `importer.test.ts`: marks → **402**, fills → **393**.
- **Import review card:** shows `auto · …` when the field equals the derived figure. When
  JJ has edited a price or the BPR itself, it offers `↺ auto (n)` instead, so a corrected
  fill price comes with a corrected BPR.
- `ImportCandidateReviewPanel` comment updated to match.

### A premise that no longer holds (noted, not acted on)

v2.11 §8.2 and the `auto-close.ts` header both say entries can never be journaled
hands-off because **`initialBpr` is not in the order payload**. It can now be derived
from the payload. `fillToPrefill` still returns null for `CONDOR_OPEN` and the inbox
still says "use Import". Changing that is a scope question for JJ, not a fix.

---

## 3. v2.15 — auto-journal ROLLS, designed

`docs/steeleagle-v2-15-auto-roll-spec.md`. Pre-code analysis written from the real code.

### Decisions JJ locked this session

1. **One-sided rolls are the norm.** On a four-leg position (condor or butterfly) JJ
   almost always rolls two legs, either the put spread or the call spread. The design is
   built around 2+2; a four-leg (8-event) roll is admitted only because the same invariants
   cover it at no cost.
2. **Same-expiration rolls only.** A roll that changes expiration stays an inbox card.
3. **The GTC is held after an auto-journaled roll until JJ confirms it with one click.**
   She may lift this later.

Carried forward unchanged: single tickets only (split rolls are not paired), the
zero-residual gate (all-or-nothing), `complexOrderStrategyType` is never read, and
`close-from-fill`'s `legRole` is never reused for rolls.

### Key findings in the spec

- **Most of the machinery already exists.** `classify-fill`'s `ROLL` shape already
  enforces `RollTradeSchema`'s invariant. `closeOwners` filters on closing legs, so it
  identifies a roll's trade unchanged. `fillToPrefill` already builds the roll rows.
- **The hold is a new column, `trades.exit_hold_order_id`**, written in the same
  transaction as the roll and read by the planner in step (c). It does not break the
  isolation rules: it is a `trades` column (the same kind as `exit_order_id`), the ledger
  tables stay out of the placement path, and it can only withhold a placement. Its flag
  is `routine`, with an optional escalation to critical after N unconfirmed runs.
- **Condition 9 cannot use `structureRefusal`.** That function refuses SPX/NDX/RUT on
  symbol grounds before looking at a single leg, so every index roll would refuse forever
  and look identical to "no rolls happened". The fix is to split `currentStructure` into
  symbol checks plus a structure-only fold, so there is still one `LP < SP <= SC < LC`
  predicate with two callers.
- **Rolls run before closes in step (d), and trades are re-read between the two.** If the
  order were reversed, a morning roll followed by an afternoon close of the new legs would
  leave the close as an inbox card permanently.
- **GLD-style scale-ins can never be auto-rolled.** Two same-strike trades rolled by one
  2-lot ticket refuse on both owner count and contract count, the same answer v2.14 gives
  for their close.
- **Three of the six historical single-ticket rolls are not pinned as fixtures:**
  `1007450735138`, `1007465290239`, `1007511371504`. They need dumping before the planner
  is written.
- **Proof plan:** a read-only replay over the 180-day ledger that must reproduce JJ's
  hand-journaled roll events exactly, then the first live write on the next one-sided
  roll she does on a BALANCED night.

### Open questions for JJ (spec §8)

1. **There is no roll-edit path.** v2.12 made closes editable; rolls are not. The
   recommendation is to ship with the hold as the safeguard and queue price-only roll
   editing.
2. Admit 4+4 single-ticket rolls? Recommended: yes.
3. Escalate the hold flag to critical after how many runs? Recommended: 3.
4. Confirm the app may write a butterfly result (SP == SC) from a roll. This is allowed
   by the v2.7 decisions, but it would be the first time the app writes one rather than
   recognising one JJ typed.

---

## 4. Decisions locked this session

| # | Decision | By |
|---|---|---|
| D1 | Auto-roll targets one-sided (2+2) rolls; 4+4 admitted only via the same invariants | JJ |
| D2 | Auto-roll is same-expiration only | JJ |
| D3 | An auto-journaled roll HOLDS the trade's GTC until a one-click confirm | JJ |
| D4 | BPR is pre-filled from the strategy formula and remains editable; null (blank) when it cannot be computed, never a fabricated figure | session (approved by JJ: "proceed with 1 and 3") |

---

## 5. Owed / queued

- **Re-login before Mon Nov 2, 4:02 PM CT.** Monday's sweep is due at 3:15 PM CT after
  the DST change, and drift could push it past the lapse.
- **Deploy check:** after this lands on Vercel, confirm the landing page shows Nov 2 (or a
  later date, after re-login) and not a stale one. Confirm `?error=auth_failed` renders
  the banner.
- **v2.15:** answer spec §8, pin the three missing roll fixtures, then follow the build
  pattern (pure modules → migration → cron → UI) per the spec.
- **Still owed from earlier sessions:** a non-trivial live BALANCED (an interval containing
  a real fill, ideally a cancelled GTC); the first production fire of v2.14's close write;
  v2.4 step 11 (manual XSP ladder; IV calibration should have completed long ago, so this
  is no longer calendar-blocked); L3-in-app; L3 ladder; the open self-resolving PHANTOM
  question from Session 25.
- **Possibly stale:** the `initialBpr` "feeds position-limit and BPR gates" comments in
  `types.ts`. Trace the consumers before deleting them.
- **Calendar gap:** the last session summary is dated Aug 20 and this one Oct 30. Nothing
  here audits what the sweep did in between. `sweep_runs` holds that history, and a look
  at it is worth doing before the v2.15 build.
