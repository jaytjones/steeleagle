# SteelEagle — Session 24 Summary

**Date:** August 18, 2026
**Milestones:** **v2.13 auth window** — SHIPPED · **Board #17** — SHIPPED · **`trades` key
site (a)** — FIXED
**Branch:** main — `8555950` · `b7c86b7` · `81313a4` · `631cb5c` — **all pushed**
**Test baseline:** 800 → **821 passing** · `tsc --noEmit` silent · build clean
**Migrations:** none. Nothing in this session changed a table.

---

## The shape of this session

The session opened on target 1 — *observe the first live cron run of v2.11 + v2.12* — and
that target is the one thing it could not deliver, because **the run never happened.**

`sweep_runs`, read newest-last:

| run (CT) | what happened |
|---|---|
| Thu Aug 13, 5:12 PM | 3 critical — the GLD rejection streak, pre-v2.11 code |
| Fri Aug 14, 9:36 PM | **manual** mid-session run on **pre-v2.11 code** (`report.ingestion` absent); placed 3 GTCs incl. both GLD |
| Sat–Sun Aug 15–16 | no run — the cron is `15 21 * * 1-5` |
| **Mon Aug 17, 4:16 PM** | **`sweep aborted before planning`** — `Token refresh failed: 400 … "Refresh token is invalid, expired or revoked"` |

So the honest statement is the same one Session 23 wrote, one week later: **nothing from v2.11
or v2.12 has yet run inside a real cron.** `position_snapshots` still holds exactly one row —
the seeded anchor from Aug 14, 10:22 PM CT — and `schwab_fills` still ends at Aug 14.

Two details are worth keeping. The Aug 17 run landed at **4:16 PM CT**, not the observed ~5:12
drift, because an abort is fast — the timestamp itself was evidence of a run that did no work.
And the Aug 14 9:36 PM row is **not** a cron run at all: it predates `519f0f5` by 47 minutes,
which is why it carries no `ingestion` block. A row in `sweep_runs` is not proof that the cron
fired; check what the report contains before reading it as one.

### What the failure did verify

The v2.11 backstops were exercised — in failure, which is the harder direction:

```
errors:         ["sweep aborted before planning: Token refresh failed: 400 …"]
reconciliation: ran=false
ingestion:      ran=false  reason="ingestion did not execute"  balance=UNANCHORED
severity:       critical (3)   headline: "3 CRITICAL — needs your eyes"
```

`ran: false` with a reason, not an empty happy report. That distinction is the whole of v2.8's
`RECONCILIATION DID NOT RUN` rule and v2.11's did-not-run backstop, and both held.

---

## 1. v2.13 — the re-login warning could never fire

JJ re-authorized at **10:10 AM CT on Aug 18**, which fixed the immediate outage and exposed the
real defect.

`storeTokens` stamped `refresh_token_expires_at = now + 7 days` on **every** call — the OAuth
callback and every refresh alike. Schwab's 7 days run from the **interactive login**, and a
refresh does not extend them. So the stored deadline slid forward for as long as the cron kept
running:

| | |
|---|---|
| last refresh before the failure | Fri Aug 14, 9:36 PM CT |
| deadline the DB therefore claimed | Fri Aug 21 |
| what Schwab did on Mon Aug 17 | revoked the grant |

**The warning that reads that column was written by the very thing it was meant to warn
about.** `getAuthStatus().needsReauth` could not go true early, `ReauthBanner` could only ever
appear after a dead sweep, and `getAccessToken`'s "refresh token expired" throw — the one
guard that looked like it covered this — has never once fired in the life of the app.

This is the same failure shape as the v2.6.1 roll badge that quietly never appeared and the
v2.9 flags that fired into a log nobody read: **detection that is structurally incapable of
firing.** The third instance, and the first where the detector was disarmed by its own writer.

### The fix

- **`lib/schwab/auth-window.ts`** (pure, 8 tests) — `reauthWindow()` → `ok` / `soon` (≤48h) /
  `expired` / `unknown`, with the deadline formatted in **CT**, because this is a statement
  about when *JJ* must act. `unknown` is a state of its own: a missing or malformed deadline
  must never render as healthy (the `UNCOMPARABLE` posture).
- **`storeTokens` takes a REQUIRED `{ newAuthorization }` flag.** Callback `true`, refresh
  `false`. Required, not optional-with-default, for the same reason `SweepFlag.severity` is:
  a new call site cannot inherit the wrong answer silently. The refresh path writes
  `COALESCE(tokens.refresh_token_expires_at, EXCLUDED…)` — the recorded deadline wins, and the
  fresh 7 days apply only if there is somehow none on record.
- **`getAccessToken` no longer consults our own deadline before calling Schwab.** It never
  fired when it was wrong, and *corrected* it could fire the other way and refuse a grant
  Schwab would still have honoured. Schwab is the authority on whether a grant is live; the
  stored deadline exists to WARN, not to gate. Same posture as Session 20 §4a's correction —
  what stops a stale close is Schwab's own validation, not our calendar.
- **A 4xx from the token endpoint records the lapse** (`LEAST`, so it can only move the
  deadline earlier) so the dashboard turns red on Schwab's verdict rather than on a date we
  guessed. **A 5xx does not** — that is an outage, and burning the window on one would invent
  a re-login JJ does not owe.
- **`ReauthBanner` renders three states**: amber at ≤48h with the CT deadline, red once
  lapsed, amber on `unknown` — and the dashboard renders it for **every** non-ok state, where
  it previously rendered only on `needsReauth`.

Live through the new code immediately after: `state: ok`, deadline **Tue, Aug 25, 10:10 AM
CT**. That value was written by the morning's interactive login, so **no data repair was
needed** — the column was already correct, it just had nothing stopping it from sliding again.

---

## 2. Board #17 — the expiration date on the Monitor

DTE answers *how long*; the date answers *which cycle*, and the cycle is what JJ matches
against the journal, the chain and the standing GTC. Rendered dim, one line under the DTE
number in both the mobile card and the desktop table, so the 21-DTE colour still carries the
row.

`formatExpirationLabel` formats from the **YYYY-MM-DD string and never through a `Date`**.
Session 23's defect #1 was exactly this — an expiration hydrated as a JS `Date` rendered a day
early, because `new Date('2026-09-18')` is UTC midnight and JJ is Central. A date-only value
has no timezone and must not acquire one. The year appears only when it is not the current
one; a malformed or absent date returns null and renders nothing rather than a guess.

---

## 3. `trades` key site (a) — the Monitor's GTC chip no longer last-wins

`/api/positions` keyed its open trades into a plain `Map` on `symbol|currentExpiration`.
With two trades on one key the second silently overwrote the first, so **one live standing GTC
rendered nowhere**: GLD 2026-09-18 stood at Schwab with BOTH `1007605997326` @6.82 and
`1007605997334` @5.11, and the Monitor showed one.

`lib/strategy/exit-links.ts` (pure, 10 tests) groups every open trade by
`symbol|currentExpiration` into a **LIST**, and `ReconstructedPosition.journalExit` became
`journalExits: JournalExitLink[]` — which made the compiler ask both consumers instead of
letting one keep reading a single trade.

The rules, each with its reason:

| rule | why |
|---|---|
| each link priced from **its own** credit | merging blends two real entries into one fictional average (JJ, 2026-08-14) |
| order is `openedAt`, then `id` | deterministic — chips that reorder between refreshes read as a change |
| a refusal never DROPS a link | an unpriceable target renders id-only; hiding it is how a live order goes unseen |
| a multi-trade row renders a dim `NO GTC` chip | with two trades, an absent chip is exactly the ambiguity this fixes |
| the 21-DTE alert names **every** standing GTC | one cancel instruction per live order, not just the first |

Verified against the live journal: `GLD|2026-09-18 → 2 chips (6.82, 5.11)`, matching both
working orders at Schwab exactly.

Sites (b) and (c) remain open **by decision, not omission** — (b) Import cannot help with a
scale-in because Schwab returns the aggregate; (c) `match-fill` attribution between genuinely
interchangeable trades is arbitrary and harmless.

---

## 4. Corrections to the record

**C1 — "the first live cron run" had not happened, and a `sweep_runs` row nearly said it had.**
The Aug 14 9:36 PM CT row looks like a run of the shipped stack (it placed three GTCs,
including both GLD trades) but predates the v2.11 cron wiring by 47 minutes. The tell is
`report.ingestion` being absent, not the timestamp. **Read the report's contents, not its
existence.**

**C2 — the pre-v2.12 blanket guard did place both GLD GTCs on Aug 14.** Not because it was
quantity-aware — it was not — but because both were planned against one working-order snapshot
taken before either was placed. That is the latent over-cover the v2.12 rule now states
properly; it happened to land correctly here.

**C3 — `getAccessToken`'s "Refresh token expired — OAuth re-login required" throw was dead
code for the life of the app.** It reads a column its own refresh path rewrites. Anything that
looked like coverage from it was never coverage.

---

## 5. Decisions locked this session

| # | Decision |
|---|---|
| D1 | **The refresh window belongs to the interactive login.** A refresh keeps the recorded deadline; only a login may set one. `newAuthorization` is required at the call site. |
| D2 | **The stored deadline WARNS, it does not GATE.** `getAccessToken` always asks Schwab; our clock is a heuristic in front of an authority that answers definitively. |
| D3 | **A 4xx burns the window, a 5xx does not.** Schwab saying "this grant is gone" is evidence; Schwab being down is not. |
| D4 | **`unknown` is a rendered state.** No deadline on record is amber, never silence. |
| D5 | **`journalExits` is a LIST at every call site**, and the type change was the point — a single-object field is how one of two live GTCs went unseen. |
| D6 | **Two same-strike condors keep separate targets on the Monitor** — a re-confirmation of the 2026-08-14 decision, now enforced in the rendering path. |

---

## 6. Owed / queued

- **STILL OWED — observe the first live cron run of v2.11 + v2.12.** Unchanged from Session 23
  §7; the expectations there stand and should not be re-derived. The guard's new path still
  needs one GTC to clear and re-place while another stands, so it may remain unexercised after
  one clean run — say so rather than calling it verified.
- **v2.11 step 8 — gated auto-write. STILL BLOCKED on the above.** Bounded by a ZERO RESIDUAL
  for the interval, never by classifier confidence.
- **v2.4 step 11** — manual XSP ladder, calendar-blocked to ~Aug 24–25.
- L3-in-app (Cancel GTC) · L3 ladder · L4 (next GTC fill, hands off).
- `trades` key sites (b) and (c) — open by decision.

### What to expect at the next sweep (~5:12 PM CT, Tuesday 2026-08-18)

| | |
|---|---|
| auth | the run should reach Schwab at all — the first thing to confirm |
| balance | `BALANCED`, empty residual — nothing traded since Aug 14 |
| ingestion flags | none, if balanced. **Silence is correct**: a zero residual is a proof, not an absence of complaints |
| inbox | the Aug 14 activity until it ages past 7 days (~Aug 21) |
| guard | not exercised unless a GTC clears |
| reconciliation | `match 4`, no `UNCOMPARABLE` |

**And v2.13's own proof:** after tonight's refresh the deadline must STILL read
**Tue, Aug 25, 10:10 AM CT**. If it has moved to the evening of Aug 25, the refresh path is
still extending the window and the fix is wrong.
