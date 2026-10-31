# SteelEagle v2.16 — roll editing · auto-journal entries · split-roll pairing (pre-code analysis)

**Status:** SHIPPED 2026-10-31 (Session 28). §4 answered by JJ the same day (all four
recommendations); §5 is the as-built record. **No migration** — reuses v2.15's
`exit_hold_order_id` / `exit_hold_at`. Written from the real code and a read-only pass over
the live ledger (141 fills) and journal (23 trades).

---

## 0. Evidence that shaped this

| Fact (live, 2026-10-31) | Consequence |
|---|---|
| 27 filled `CONDOR_OPEN`, 10 `ROLL`, 22 `CONDOR_CLOSE`, **1** split roll (2 halves) in 180 days | Split rolls are rare: ~1 in 11 rolls. Their cost/benefit is the weakest of the three (§3). |
| 22 of 23 trades' entry events are `schwab_fill` with an order id; 1 is `manual` | Entries already come from Import (or `recordFillAction`), journaled 0–161 h after the fill. Auto-entry saves that click and closes the lag. |
| **0** trades carry the `v2.0 placement` note or `OVERRIDE` | `recordFillAction` (app placement) has never been used in production. It still must not be able to duplicate an auto-entry (§2.4). |
| **0 of 23** trades carry entry deltas | An auto-entry's null deltas lose nothing that is recorded today. |
| Both GLD 2026-09-18 entries are `manual` (hand-typed, 69 h and 161 h late) | Key-site (b): Import cannot see a scale-in. A STRUCTURAL dedup has the same blindness; an ORDER-ID dedup does not (§2.2). |
| SPY 2026-09-30 entry `1007686506025` (Aug 24) is `UNJOURNALED_OPEN` | One live trade ran start to finish unjournaled — no GTC, no 21-DTE alert. Exactly the gap auto-entry closes. (Expired; history now.) |

---

## 1. Roll editing — prices only (v2.15 §8.1 option (b))

### 1.1 What exists

`lib/journal/edit-close.ts` → `planCloseEdit` (pure) → `editClosedTrade` (DB, closed trades
only). Editable: `close` events — price, credit/debit, occurredAt. Totals RE-DERIVED from
the full log, never patched. A `schwab_fill` edit demotes `source` to `manual` and keeps
`schwab_order_id` (v2.12). Rolls were excluded on purpose: *"Editing a roll_close on an open
trade would also desync the standing GTC's 50% target."*

### 1.2 Proposed

- **Editable: `roll_close` / `roll_open` PRICE only.** Decided by JJ's 8.1 answer ("prices
  only — structure stays immutable"). Not editable, and why:
  - *credit/debit* — on a roll it is fixed by the instruction (BUY pays, SELL collects, the
    F3 table). A wrong direction means a wrong ROLE, which is structure.
  - *occurredAt* — the fold batches a roll by `occurredAt`; editing one leg's time splits
    the batch and changes what `currentStructure` reconstructs. (A whole-batch time edit is
    possible but is not "prices only" — out of scope.)
- **Open AND closed trades** (rolls exist on both). New pure `planRollEdit` beside
  `planCloseEdit`, new DB `editRollPrices`, both re-derive totals exactly as the close edit.
- **Provenance:** same v2.12 rule — `schwab_fill` → `manual`, order id kept.
- **Held trades (v2.15):** editing is the designed repair BEFORE confirming. The hold stays;
  JJ edits, then confirms. The AUTO tag keys on `schwab_order_id`, which is kept, so it
  still marks the legs.
- **Standing GTC — OPEN QUESTION Q1.** On an open trade with `exit_order_id` set, a price
  edit changes the net credit the live GTC was priced from. The cron never cancels or
  re-prices a working order, so the GTC would stay wrong until it fills or JJ cancels it.

### 1.3 UI

`TradeCard`: an **Edit roll prices** action listing every roll leg (both kinds) with a price
field, live totals preview via the shared planner (as `EditCloseForm`), the hardened
blank-is-not-zero wire shape (`price: number | null`).

---

## 2. Auto-journal ENTRIES (v2.11 §8.2)

### 2.1 Shape

Third pass in step (d): **entries → rolls → closes**, trades re-read between. Entries
first, because a same-interval entry-then-roll needs the entry to exist for the roll to find
its owner (same argument as rolls-before-closes, v2.15 §6). Same shared gate
(`auto-journal-gate.ts`, zero residual, interval-bounded).

Mapper `entryInputFromFill(fill)` → `NewTradeInput`: legs from the classifier (F3 roles;
entry direction SELL = credit), `contracts` from the fill, `openedAt` = fill time,
`initialBpr = entryBpr(legs, contracts)` (Session 27; **null refuses** — never the
`recordFillAction` 0.01 floor), `source: 'schwab_fill'` + order id (same as Import),
`delta: null` (orders carry no greeks; 0/23 trades record one), `sleeve: 'core'`, notes
`Journaled automatically from Schwab order <id>.`

### 2.2 Dedup — by ORDER ID, not structure

`matchFill` dedups structurally, so a second same-strike entry (the GLD scale-in) reads
`ALREADY_JOURNALED` and is skipped — Import's blindness, reproduced. Instead:

| Journal state | Verdict |
|---|---|
| a trade's `open` events carry THIS order id | skip — already journaled (Import / earlier run) |
| no trade holds these legs | **write** — a new entry |
| trades hold these legs, and EVERY one's `open` events carry a DIFFERENT order id | **write** — a second order is a second entry: the scale-in (proposed — Q3) |
| a trade holds these legs with NO order id (hand-typed) | **refuse** — cannot tell a hand-typed copy of this entry from a scale-in |

The zero residual proves the order moved the position, and one order is one entry, so the
third row is provable, not guessed. It would discharge key-site (b) for future scale-ins.

### 2.3 Refusals (recorded, inbox card stays)

Not FILLED / partial / any leg unpriced · not a well-formed four-leg structure
(`isCondorShape` already gates `CONDOR_OPEN`) · `entryBpr` null · row 4 above.
**Butterfly ENTRY: refuse** — the app must never open one and Schwab's entry payload for one
is unpinned (v2.7.1); a butterfly entered in TOS stays a hand journal entry.

### 2.4 `recordFillAction` must not duplicate

It calls `createTrade` with no dedup. Add: refuse when any trade's `open` events already
carry this order id ("already journaled — check the Journal"). Needed whether or not
auto-entry ships, since Import can race it today. (Also noted, low severity: its price
average does not skip cancellation records (`movedNothing`) and counts a missing execution
quantity as 1 where every other reader counts 0 — the v2.13.2 class. Align it in the same
change.)

### 2.5 GTC on an auto-journaled entry — OPEN QUESTION Q2

An open trade with no `exit_order_id` gets a 50% GTC on the next sweep. An auto-entry would
therefore be the first time the app places a live order on a trade no human journaled. The
hold mechanism from v2.15 can be reused unchanged (`exit_hold_order_id` = the entry order).

---

## 3. Split-roll pairing (v2.11 §8.3)

### 3.1 What it would take

Pair one `PARTIAL_CLOSE` with one `PARTIAL_OPEN`: same underlying, same expiration, same
contracts, both legs of each ticket one `putCall`, closed roles == opened roles, unique
owner, both inside the interval, gap ≤ a window. Refuse on any second candidate on the same
key in the window (no guessing). Output = one roll batch → the v2.15 path (same conditions
H/R/6/9a/9b, same hold).

**One `occurredAt` per roll** (the fold batches on it): propose the LATER ticket's time —
when the roll was complete. Between the two tickets the position is genuinely 3-legged; the
journal does not model that and does not need to.

### 3.2 The honest cost/benefit

One occurrence in 180 days. The pairing heuristic (window, order, uniqueness) is the
least-proven logic of the three, and its only live fixture is that one pair. The cheaper
alternative is **prefill-only**: the inbox pairs the two halves into ONE Roll form (today
each half opens its own form with a "add the partner's legs" note) — no automatic write.
**OPEN QUESTION Q4.**

---

## 4. Open questions for JJ

1. **Roll edit with a standing GTC.** (a) Refuse until the GTC is cancelled (Cancel GTC on
   the Monitor; the sweep re-places at the corrected price) — *recommended*; (b) allow and
   warn "cancel and let it re-place".
2. **Hold the first GTC on an auto-journaled entry?** (a) Yes, reuse the v2.15 hold —
   *recommended*: one click per entry, and it keeps the rule that an automatic write reaches
   placement only by withholding; (b) no — entry interpretation is unambiguous and fill
   prices are Schwab's.
3. **Auto-journal scale-ins** (row 3 of §2.2)? (a) Yes — *recommended*; (b) no, refuse any
   structural match.
4. **Split-roll scope.** (a) Prefill-only now, auto-pairing deferred — *recommended*;
   (b) full auto-pairing; (c) defer both. If (b): the max gap between tickets (live: 4 min
   28 s; proposed 30 min) and whether OPEN-then-CLOSE ordering is admitted.

Defaults taken unless JJ says otherwise: roll edits on open and closed trades, both
`manual` and `schwab_fill` legs, v2.12 demotion; auto-entry deltas null; butterfly entries
refused; `recordFillAction` dedup + execution-scope alignment ships regardless; build order
roll editing → entries → split rolls.

---

## 5. As built (2026-10-31)

### 5.1 JJ's answers to §4

1. **Refuse** a roll-price edit while a GTC is standing — cancel it from the Monitor first.
2. **Hold** the first GTC on an auto-journaled entry (the v2.15 mechanism, unchanged).
3. **Journal scale-ins** as their own trade (§2.2 row 3).
4. **Prefill-only** split-roll pairing; automatic pairing deferred.

### 5.2 What shipped

- **Roll editing** — `lib/journal/edit-roll.ts` (`planRollEdit`, `previewRollEditTotals`),
  `editRollPrices` (DB; open or closed trade; guarded per-row on id + trade + roll type;
  totals re-derived), `editRollPricesAction`, **Edit Roll Prices** on the TradeCard. Only
  CHANGED legs are submitted, so an untouched `schwab_fill` leg keeps its provenance.
- **Auto-entry** — `lib/journal/entry-from-fill.ts` (mapper + `entryDisagreement`),
  `lib/journal/auto-entry.ts` (planner, order-id dedup). Pass (d0) in `runAutoJournal`,
  before rolls and closes. `createTrade(input, { holdExitPlacement })` sets the hold in the
  same INSERT.
- **`createTrade` refuses a duplicate entry order id** — inside the transaction, so Import,
  `recordFillAction` and auto-entry are all covered. (`recordFillAction` had no dedup.)
- **`recordFillAction`** now skips cancellation records (`movedNothing`) and counts a
  missing execution quantity as 0.
- **Split-roll prefill** — `lib/journal/split-roll.ts` (`pairSplitRoll`,
  `splitRollToPrefill`, 30-minute window, exactly-one-candidate rule). The inbox route pairs
  halves into ONE Roll form; the OPEN half — which closes nothing and so had no trade to
  open a form on — now takes the CLOSE half's trade.
- **Hold wording generalized** (planner flag, roll-pass H refusal, Monitor chip, TradeCard
  banner) — a hold can now come from an entry or a roll.
- **Report** — `autoJournal.entries` (same shape as `rolls`), NOTE line, its own
  `AUTO-JOURNAL (ENTRIES) DID NOT RUN` backstop, headline count.
- Stale "an entry needs a BPR the order does not carry" copy corrected (inbox card, journal
  page notice, two code comments).

### 5.3 Known limits, stated so nobody waits for them

- **Entry then ROLL on the same day:** the roll pass refuses on H while the entry's hold is
  pending. The roll stays an inbox card.
- **Entry legs are not editable.** A wrong auto-entry stays held and is fixed by hand.
- **The inbox still dedups entries structurally** (`matchFill`), so a scale-in the sweep
  could NOT journal (gate closed) is hidden from the inbox as ALREADY_JOURNALED — as before.

### 5.4 Proof

- 999 tests. Live anchors: `GLD_ENTRY` (the scale-in), the Aug 14 split pair, and trade
  `7dc07054`'s real hand-entry error for roll editing.
- **Entry replay** (`scripts/dry-run-auto-entry.ts`, read-only; journal-as-of by
  `createdAt`): 27 filled entries → **27 would write, 12 EXACT, 0 leg mismatches, 0
  refused.** Includes the GLD scale-in `1007457102802`, written as its own trade and
  matching JJ's hand-typed trade `9b3f575a` exactly, BPR included.
  **11 older trades carried `initial_bpr = $0.00`** (July Imports, before 0 was refused) —
  legs exact, BPR the placeholder. **Backfilled 2026-10-31 (JJ approved)** with
  `scripts/backfill-entry-bpr.ts`: `entryBpr` from each trade's own journaled entry legs,
  one transaction, every UPDATE guarded on `initial_bpr = 0`; all 11 were closed; re-run
  finds 0. Low risk because no gate reads `initial_bpr` (verified — the `types.ts` comments
  saying it fed the position-limit gates were stale and are corrected). 4 entries never journaled (3 in May; SPY 2026-09-30,
  Aug 24).
- **Owed live:** the `createTrade` duplicate guard has no unit coverage (DB-only) and is
  first exercised in production; first auto-entry on a BALANCED night (NOTE, `GTC HELD`,
  confirm card reading "Entered"); first roll-price edit.
