# SteelEagle v2.12 — quantity-aware pre-place guard + multiset reconciliation

**Status:** SPEC
**Date:** 2026-08-14 (Session 22 decision, built Session 23)
**Origin:** April, 2026-08-14 — *"I don't like the idea of refusing at entry — sometimes it's a
valid trade that should be placed with an acceptable setup."*

> **THIS IS THE FIRST v2.1x CHANGE THAT ALTERS PLACEMENT BEHAVIOUR.** Everything in v2.11 is
> report-only. The guard change *loosens* a safety check, so every rule below is stated with
> its fail-safe direction, and the degraded mode is exactly today's behaviour.

---

## 1. The two defects

Both come from the same root: `underlying|expiration` is used as if it identified a trade,
and it does not.

### Defect A — the guard blocks legitimate placement

`lib/strategy/exit-sweep.ts` refuses to place when **any** working close order exists on the
same `underlying|expiration`:

```ts
const conflict = orderStates.find(
  (o) => o.isClose && o.underlying === trade.symbol &&
         o.expiration === trade.currentExpiration && blocksPlacement(o),
)
```

With two GLD 2026-09-18 trades, trade A's standing GTC blocks trade B's forever. CLAUDE.md
records the consequence as a standing limitation: *"trade B's exit must be placed by hand."*

**But the hazard the guard exists to prevent is OVER-COVERING** — placing closes for more
contracts than are held. Blocking on mere existence is a proxy for that, and it is wrong
whenever more than one contract is held.

### Defect B — reconciliation gives up

`reconcileJournal` returns `UNCOMPARABLE` the moment two open trades share a key:

> *"the account groups their legs into one pile, so neither side can be attributed to a
> specific trade."*

True — but attribution is the wrong question. **The union is comparable even when the parts
are not.**

---

## 2. The guard rule

> **Place only when `held > covered`.**
>
> `held` — contracts the ACCOUNT holds on this `underlying|expiration`
> `covered` — contracts already claimed by working close orders on that key

| case | held | covered | outcome |
|---|---|---|---|
| single 1-lot, GTC standing | 1 | 1 | blocked (unchanged) |
| single 1-lot, no GTC | 1 | 0 | place (unchanged) |
| **GLD: 2 held, A's GTC standing** | **2** | **1** | **place B — the fix** |
| GLD: both GTCs standing | 2 | 2 | blocked |
| over-covered already | 1 | 2 | blocked **and flagged critical** |

`covered` counts `remainingQuantity ?? quantity` — the still-live portion of a working order.
A partially filled GTC covers only what has not yet filled.

### Fail-safe direction — the part that matters

`held` comes from the account, and the account can be unavailable. **When `held` cannot be
determined, fall back to today's blanket rule: any working close blocks.**

That means every failure mode — positions fetch failed, the key reconstructs as `OTHER`,
the position is absent — degrades to *exactly the behaviour shipped today*, which has never
over-covered. The loosening applies only where we have positive evidence of how much is held.

`held < covered` is not merely "blocked"; it is an anomaly (more closes standing than
contracts held) and earns a **critical** flag. Nothing else in the app would notice it.

### Deliberately NOT in scope: leg-set matching

Session 22 framed the rule as "working close orders **on matching legs**". Matching legs
would let two DIFFERENT-strike trades on one key each place their own GTC. It is omitted
because:

- it cannot be used where it would matter — different strikes on one key reconstruct as
  `OTHER`, so `held` is unknown and the guard falls back to strict anyway;
- `SweepOrderState` carries no leg strikes, so it is a change to the digest as well;
- quantity alone already fixes the case that exists (GLD), and errs conservative in every
  other: a stale GTC that covers nothing real inflates `covered`, which *under*-places.

Revisit when a different-strike collision actually occurs. It has not.

---

## 3. The multiset rule

For each `underlying|expiration` key with one or more open journal trades:

```
expected = ⋃ over trades of  (role, strike, expiration, signed qty × contracts)
actual   = account legs      (role, strike, expiration, signed qty)
```

Compare as multisets. `ReconstructedLeg` already carries a signed per-leg `quantity`, and it
carries it **even on an 8-leg `OTHER`** — so this needs no partitioning heuristic.

That matters: splitting 8 legs into two condors is genuinely ambiguous (330L/350S + 365L/385S
versus 330L/385S + 365L/350S), and a wrong pairing would build a wrong close. Multiset
comparison **sidesteps the question instead of guessing at it.**

### Verdicts

| result | verdict | severity |
|---|---|---|
| multisets equal, one trade on the key | `MATCH` | ok |
| multisets equal, N > 1 trades on the key | `MATCH` (noted as aggregate) | ok |
| multisets differ | `DRIFT` | critical |
| a trade's structure cannot be derived | `UNCOMPARABLE` | warning |
| no position at all for the key | `PHANTOM` | critical / warning if expired |

`UNCOMPARABLE` survives — it is still the honest answer when `currentStructure` refuses. What
disappears is `UNCOMPARABLE` *caused only by two trades sharing a key*, which is the GLD case.

An aggregate `MATCH` says: the account holds exactly what the journal claims, in total. It
does **not** claim to know which contract belongs to which trade — that is unknowable for
fungible identical-strike contracts, and the guard makes it unnecessary.

---

## 4. What does NOT change

- **No refusal at entry.** April's rejection stands; a second trade on an occupied key is a
  legitimate trade and must never be blocked (Session 22 D4).
- **No merging of same-key trades.** Two trades stay two trades, each with its own credit,
  its own 50% target, and its own GTC (Session 22 D5).
- **`currentStructure` is untouched.** It is the one predicate gating live-money placement and
  nothing here modifies it.
- **Reconciliation still FLAGS, never BLOCKS** (April, 2026-08-04). The multiset change makes
  the flag more accurate; it does not give it veto power.
- **The 24-DTE floor, the pause toggle, refuse-don't-guess** — all unchanged.

---

## 5. Build order

1. `positionsToHeldContracts` — pure, account legs → `Map<key, contracts>`, `null` where not
   derivable. Tests first.
2. `SweepOrderState.coveredContracts` + `SweepTradeInput.heldContracts` — digest and adapter.
3. The guard, in `planExitSweep`. Tests must cover the over-cover case explicitly and the
   `held === null` fallback.
4. Multiset comparison in `reconcile.ts`, widening `ReconcilePosition` to per-leg quantity.
5. Cron wiring: positions are already fetched twice (reconciliation, ingestion). The planner
   needs them too — see §6.
6. Live verification against the account before any deploy that could place.

---

## 6. Open question for April

**The positions fetch now feeds a PLACEMENT decision, not just a report.**

Today the cron fetches positions twice, each inside its own try/catch, and a failure degrades
only an observation. The guard needs the same data, and a failure there changes what gets
placed — to the strict fallback, which is safe, but it means a Schwab hiccup silently reverts
GLD to hand-placement.

Two options, and the difference is only visible when the fetch fails:

- **(a) Third isolated fetch.** Maximum isolation, one more API call per run. A failure
  degrades the guard to strict and flags it.
- **(b) One hoisted fetch shared by all three.** Fewer calls, but a single failure now takes
  out reconciliation, ingestion and the guard together.

**Recommendation: (a).** It matches the existing pattern, and coupling three independent
safety observations to one fetch is exactly what §2's fail-safe reasoning argues against.
Proceeding on (a) unless April says otherwise.
