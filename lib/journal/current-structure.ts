// ============================================================
// SteelEagle — v2.3 current-structure reconstruction (pure — no I/O)
//
// Folds a trade's event log into the four legs it currently holds. This
// is what lifts the v2.2 rolled-trade placement exclusion (spec §4.1a
// finding 1): before this, the sweep could only price trades whose entry
// `open` events were still the live structure, so any rolled trade was
// skipped and flagged MANUAL GTC.
//
// The fold rule: for each leg role, the MOST RECENT roll_open wins;
// absent any, the entry `open` stands. `roll_close` is not merely the
// cost side — it marks the role vacant, so a leg closed and never
// replaced is caught rather than silently reported at its pre-roll strike.
//
// Rolls are applied in BATCHES keyed by occurredAt, closes before opens
// within a batch. A roll is atomic — RollTradeSchema stamps one
// occurredAt across every leg it touches, so the insertion order of
// roll_close vs roll_open inside one roll is arbitrary and must not
// change the result.
//
// Refusal posture identical to exitInputFromOpenEvents: any ambiguity
// throws. This output prices a live-money order — a guessed leg is worse
// than a MANUAL GTC chip.
// ============================================================

import {
  hasAmbiguousRoot,
  isOrderFixturePinned,
  preferredRootFor,
  unpinnedFixtureMessage,
} from '@/lib/strategy/instruments'
import { LEGS, type Leg, type TradeEvent } from './types'

/**
 * The four legs a trade currently holds.
 *
 * Structurally identical to `CondorExitInput` in lib/schwab/exit-ticket.ts,
 * so it feeds buildCondorExitTicket directly. Kept as its own type rather
 * than imported: the event log is a journal concern, and the journal must
 * not depend on the Schwab layer.
 */
export interface CondorStructure {
  symbol: string
  /**
   * v2.4 — the OCC root the exit legs must be built under. Equals `symbol` for
   * every ETF and for XSP; diverges only for multi-root indices, which this
   * function refuses outright (see below), so in practice this is always the
   * instrument's single unambiguous root.
   */
  root: string
  expiration: string // YYYY-MM-DD
  longPut: { strike: number }
  shortPut: { strike: number }
  shortCall: { strike: number }
  longCall: { strike: number }
}

/** The event fields the fold needs — nothing about money. */
export type StructureEvent = Pick<
  TradeEvent,
  'eventType' | 'leg' | 'strike' | 'expiration' | 'occurredAt' | 'createdAt'
>

interface LegState {
  strike: number
  expiration: string
}

/** Chronological, with insertion order as the tiebreak. Sorted defensively —
 *  callers usually pass DB order, but this must not depend on that. */
function chronological(events: StructureEvent[]): StructureEvent[] {
  return [...events].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt),
  )
}

/**
 * The trade's current four legs, or a thrown refusal.
 *
 * @param symbol  underlying, from the trade row (the event log doesn't carry it)
 * @param events  the trade's FULL event log
 */
export function currentStructure(symbol: string, events: StructureEvent[]): CondorStructure {
  // ---- v2.4 symbol-level refusals, before any leg work ----
  // Both are the same posture as every refusal below: this output prices a
  // live-money order, so anything we cannot PROVE gets a MANUAL GTC chip.
  //
  // (1) Ambiguous OCC root. `trade_events` records strikes and expirations,
  // never symbols, so for an underlying with two roots (SPX/SPXW) there is no
  // evidence of which one the position was opened under. Building from
  // `preferredRoot` would be a guess, and a close order on the wrong root does
  // not close the position — it opens a new one. This supersedes v2.4 spec
  // §8.3's proposed `trade_events` root column: the manual journal path has no
  // OCC symbol to populate such a column from, so the column would re-derive
  // the same guess with a schema change on top. XSP — the only index tradeable
  // at this account size — has a single root and passes cleanly.
  if (hasAmbiguousRoot(symbol)) {
    throw new Error(
      `currentStructure(${symbol}): ${symbol} trades under multiple OCC roots ` +
        `and the event log does not record which one this position holds — ` +
        `refusing to guess a close symbol (place this GTC manually)`,
    )
  }

  // (2) No pinned order fixture. The Schwab doctrine: never build an order
  // payload for an instrument whose real recorded shape we have not seen.
  if (!isOrderFixturePinned(symbol)) {
    throw new Error(`currentStructure(${symbol}): ${unpinnedFixtureMessage(symbol)}`)
  }

  // ---- Base: the entry legs ----
  const opens = events.filter((e) => e.eventType === 'open')
  if (opens.length !== 4) {
    throw new Error(
      `currentStructure(${symbol}): expected exactly 4 open events, got ${opens.length} — refusing to build`,
    )
  }
  const state = new Map<Leg, LegState | null>()
  for (const o of opens) {
    if (state.has(o.leg)) {
      throw new Error(
        `currentStructure(${symbol}): duplicate ${o.leg} open event — refusing to build`,
      )
    }
    state.set(o.leg, { strike: o.strike, expiration: o.expiration })
  }
  if (state.size !== 4) {
    throw new Error(
      `currentStructure(${symbol}): open events must cover each leg exactly once, got [${opens
        .map((o) => o.leg)
        .join(', ')}]`,
    )
  }

  // ---- Fold the rolls, one atomic batch at a time ----
  const rolls = chronological(
    events.filter((e) => e.eventType === 'roll_close' || e.eventType === 'roll_open'),
  )

  let i = 0
  while (i < rolls.length) {
    const at = rolls[i].occurredAt
    const batch: StructureEvent[] = []
    while (i < rolls.length && rolls[i].occurredAt === at) batch.push(rolls[i++])

    // Closes first: within one roll the two sides are simultaneous, so
    // ordering by createdAt would make the result depend on the order the
    // operator happened to add the rows.
    for (const e of batch) {
      if (e.eventType !== 'roll_close') continue
      if (state.get(e.leg) == null) {
        throw new Error(
          `currentStructure(${symbol}): ${e.leg} rolled closed at ${at} but it is already ` +
            `closed — the event log is inconsistent, refusing to build`,
        )
      }
      state.set(e.leg, null)
    }
    for (const e of batch) {
      if (e.eventType !== 'roll_open') continue
      state.set(e.leg, { strike: e.strike, expiration: e.expiration })
    }
  }

  // ---- Every role must still be live ----
  const vacant = LEGS.filter((l) => state.get(l) == null)
  if (vacant.length > 0) {
    throw new Error(
      `currentStructure(${symbol}): [${vacant.join(', ')}] closed by a roll and never ` +
        `reopened — this is no longer a four-leg condor, refusing to build`,
    )
  }

  // ---- Single expiration (v2.3 spec §5.1, default: refuse) ----
  // A one-sided roll out in time leaves the legs spanning two expirations —
  // a diagonal, which the ticket's single `expiration` and
  // complexOrderStrategyType 'IRON_CONDOR' cannot express. Those trades keep
  // the MANUAL GTC chip until per-leg expirations earn their own fixture.
  const expirations = new Set(LEGS.map((l) => state.get(l)!.expiration))
  if (expirations.size !== 1) {
    throw new Error(
      `currentStructure(${symbol}): legs span multiple expirations ` +
        `[${[...expirations].sort().join(', ')}] — a diagonal cannot be priced as an ` +
        `iron condor, refusing to build (place this GTC manually)`,
    )
  }

  // ---- Strike ordering (Session 20) ----
  //
  // This check did not exist here before, and its absence was a live divergence
  // between the two things v2.3 promised could never disagree. `currentStructure`
  // compared no strikes, so ANY mis-ordered structure passed `isPriceableStructure`
  // — the Monitor rendered a green GTC-target chip and the planner queued the
  // trade — and then `buildCondorExitTicket` threw inside the placement loop. The
  // trade landed in `report.errors` on every single sweep run, forever, while the
  // UI claimed it was covered. Refusing HERE routes it to `toFlag` with this
  // message verbatim, which is the designed fail-safe: MANUAL GTC, not a
  // recurring error and a lie on screen.
  //
  // The iron butterfly gets its own message because it is not a malformed trade —
  // it is a legitimate structure the ORDER PATH cannot yet express. Recognition
  // (Monitor, importer, BPR, slot cap) accepts it; only ticket-building refuses,
  // and only until a place-and-cancel fixture pins what Schwab actually records
  // for one. Same posture, same reason, as the unpinned index instruments above.
  const lp = state.get('long_put')!.strike
  const sp = state.get('short_put')!.strike
  const sc = state.get('short_call')!.strike
  const lc = state.get('long_call')!.strike

  if (sp === sc) {
    throw new Error(
      `currentStructure(${symbol}): the short strikes are both ${sp} — this is an iron ` +
        `BUTTERFLY, and no place-and-cancel fixture has pinned what Schwab records for ` +
        `one (the ticket builders hardcode complexOrderStrategyType "IRON_CONDOR", ` +
        `pinned from real condor closes). Refusing to guess an order payload ` +
        `(place this GTC manually).`,
    )
  }
  if (!(lp < sp && sp < sc && sc < lc)) {
    throw new Error(
      `currentStructure(${symbol}): strikes ${lp} / ${sp} / ${sc} / ${lc} are not ordered ` +
        `LP < SP < SC < LC — refusing to build (place this GTC manually)`,
    )
  }

  return {
    symbol,
    root: preferredRootFor(symbol),
    expiration: [...expirations][0],
    longPut: { strike: lp },
    shortPut: { strike: sp },
    shortCall: { strike: sc },
    longCall: { strike: lc },
  }
}

/**
 * Non-throwing probe: WHY can't the sweep price this trade? null = it can.
 *
 * v2.4: the refusal set grew from "the event log is ambiguous" to include
 * symbol-level refusals (multi-root index, unpinned order fixture), and those
 * read nothing like "diagonal". Returning the actual message means the sweep's
 * flag and the Monitor's chip tooltip tell April the real reason instead of a
 * generic one that would be wrong for an index trade.
 */
export function structureRefusal(symbol: string, events: StructureEvent[]): string | null {
  try {
    currentStructure(symbol, events)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Non-throwing probe: is this trade priceable by the sweep?
 *
 * The planner needs a yes/no without a try/catch, and the Monitor needs the
 * same answer to decide GTC-target chip vs MANUAL GTC. Replaces
 * `hasRollEvents` as the placement gate (v2.3 spec §2b). ONE predicate — the
 * planner gate and the Monitor chip must never be able to disagree.
 */
export function isPriceableStructure(symbol: string, events: StructureEvent[]): boolean {
  return structureRefusal(symbol, events) === null
}
