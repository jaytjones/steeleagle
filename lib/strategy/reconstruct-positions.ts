/**
 * lib/strategy/reconstruct-positions.ts
 *
 * Reconstructs Schwab `/accounts/{hash}` positions into typed, grouped strategy
 * positions. Schwab returns a FLAT array of individual option legs, never grouped
 * spreads, so this module:
 *
 *   1. Parses each OPTION leg's 21-char OCC symbol -> { underlying, expiration, putCall, strike }
 *   2. Groups option legs by (underlying, expiration)
 *   3. Classifies each group into one of three buckets:
 *        - IRON_CONDOR     : clean 4-leg (long put < short put < short call < long call)
 *        - VERTICAL_SPREAD : clean 2-leg, one wing of a condor (put or call credit spread)
 *        - OTHER           : equities, money-market / cash-equivalent funds, and any
 *                            option group that does not match a known structure
 *   4. Derives BPR (max loss) the strategy-consistent way: `wingWidth - credit`,
 *      NOT from Schwab's per-leg `maintenanceRequirement` (unreliable for spreads).
 *
 * Dollar convention matches CondorSetup in types/index.ts:
 *   - wingWidth: strikeWidth * 100   (e.g. $10 wide -> 1000)
 *   - credit:    netCredit  * 100    (e.g. $1.80/sh -> 180)
 *   - bpr:       wingWidth - credit  (max loss), all scaled by contract quantity
 *
 * FIELDS TO VERIFY AGAINST A LIVE SCHWAB POSITION (community-documented shapes used here):
 *   - `averagePrice` is treated as a positive per-share premium for both long and short
 *     legs (we abs() it). If Schwab signs short premium negative, the abs() keeps credit
 *     correct; confirm once against a real open short.
 *   - Open P&L is summed from `longOpenProfitLoss` + `shortOpenProfitLoss` per leg. If
 *     those are absent on your account, `openPnl` falls back to summed `currentDayProfitLoss`
 *     and `openPnlReliable` is set false so the UI can flag it.
 */

// ---------------------------------------------------------------------------
// Input types — subset of Schwab securitiesAccount.positions[]
// ---------------------------------------------------------------------------

export type SchwabInstrument = {
  /** OCC symbol for options (e.g. "SPY   260619P00480000"); plain ticker otherwise. */
  symbol: string;
  description?: string;
  /** 'OPTION' | 'EQUITY' | 'COLLECTIVE_INVESTMENT' | 'CASH_EQUIVALENT' | 'MUTUAL_FUND' | ... */
  assetType: string;
  putCall?: 'PUT' | 'CALL';
  underlyingSymbol?: string;
};

export type SchwabPosition = {
  instrument: SchwabInstrument;
  longQuantity: number;
  shortQuantity: number;
  marketValue?: number;
  /** Per-share cost basis / premium. Magnitude is what matters here. */
  averagePrice?: number;
  currentDayProfitLoss?: number;
  longOpenProfitLoss?: number;
  shortOpenProfitLoss?: number;
  maintenanceRequirement?: number;
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ParsedOption = {
  underlying: string;
  /** ISO date 'YYYY-MM-DD'. */
  expiration: string;
  putCall: 'PUT' | 'CALL';
  /** Strike in dollars per share, e.g. 480. */
  strike: number;
};

export type LegRole =
  | 'LONG_PUT'
  | 'SHORT_PUT'
  | 'SHORT_CALL'
  | 'LONG_CALL'
  | 'LONG'   // generic long leg (vertical / unrecognized)
  | 'SHORT'; // generic short leg

export type ReconstructedLeg = ParsedOption & {
  role: LegRole;
  /** Signed contract count: positive = long, negative = short. */
  quantity: number;
  /** Per-share premium (magnitude). */
  averagePrice: number;
  marketValue: number;
  openPnl: number;
  /** Raw Schwab symbol, for re-fetching live deltas (roll alerts, v1.3 item 6). */
  occSymbol: string;
};

export type PositionKind = 'IRON_CONDOR' | 'VERTICAL_SPREAD' | 'OTHER';

export type ReconstructedPosition = {
  kind: PositionKind;
  underlying: string;
  /** ISO date; null for non-option OTHER rows. */
  expiration: string | null;
  legs: ReconstructedLeg[];
  /** Contracts for spreads; shares/units for OTHER. */
  quantity: number;
  /** strikeWidth * 100 * qty (dollars). null when not derivable. */
  wingWidth: number | null;
  /** Net credit in dollars (positive = credit received). null when not derivable. */
  credit: number | null;
  /** Max loss in dollars = wingWidth - credit. null when not derivable. */
  bpr: number | null;
  /** Current open P&L in dollars. */
  openPnl: number;
  /** False when openPnl was derived from a weaker fallback field. */
  openPnlReliable: boolean;
  /** Calendar days to expiration; null for OTHER. */
  dte: number | null;
  /** For VERTICAL_SPREAD: which wing. */
  side?: 'PUT' | 'CALL';
  /** Diagnostic for OTHER rows that are actually unrecognized option groups. */
  note?: string;
};

// ---------------------------------------------------------------------------
// OCC symbol parsing
// ---------------------------------------------------------------------------

/**
 * Parses a standard OCC option symbol. The strict format is a 6-char underlying
 * (right-padded with spaces) + YYMMDD + C/P + 8-digit strike (x1000). We parse
 * from the right so we tolerate Schwab's variable left padding ("SPY   2606...",
 * "SPY 2606...", or "SPY2606...").
 *
 * Assumption: underlying does not end in a digit (true for all 21 strategy ETFs).
 */
export function parseOccSymbol(symbol: string): ParsedOption | null {
  const m = /^(.+?)\s*(\d{6})([CP])(\d{8})$/.exec(symbol);
  if (!m) return null;
  const [, rawUnderlying, date, cp, strikeRaw] = m;
  const underlying = rawUnderlying.trim();
  if (!underlying) return null;
  const expiration = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
  const putCall: 'PUT' | 'CALL' = cp === 'P' ? 'PUT' : 'CALL';
  const strike = parseInt(strikeRaw, 10) / 1000;
  return { underlying, expiration, putCall, strike };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Calendar days to expiration (date-only, UTC), to avoid timezone drift. */
export function daysToExpiration(expiration: string, now: Date = new Date()): number {
  const exp = Date.parse(`${expiration}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((exp - today) / MS_PER_DAY);
}

function signedQty(p: SchwabPosition): number {
  return (p.longQuantity || 0) - (p.shortQuantity || 0);
}

function legOpenPnl(p: SchwabPosition): { value: number; reliable: boolean } {
  const lp = p.longOpenProfitLoss;
  const sp = p.shortOpenProfitLoss;
  if (lp !== undefined || sp !== undefined) {
    return { value: (lp ?? 0) + (sp ?? 0), reliable: true };
  }
  return { value: p.currentDayProfitLoss ?? 0, reliable: false };
}

function toLeg(p: SchwabPosition, parsed: ParsedOption, role: LegRole): ReconstructedLeg {
  return {
    ...parsed,
    role,
    quantity: signedQty(p),
    averagePrice: Math.abs(p.averagePrice ?? 0),
    marketValue: p.marketValue ?? 0,
    openPnl: legOpenPnl(p).value,
    occSymbol: p.instrument.symbol,
  };
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

type OptionLeg = { pos: SchwabPosition; parsed: ParsedOption };

export function reconstructPositions(
  positions: SchwabPosition[],
  now: Date = new Date(),
): ReconstructedPosition[] {
  const out: ReconstructedPosition[] = [];
  const optionLegs: OptionLeg[] = [];

  // 1. Split options from everything else.
  for (const pos of positions) {
    if (pos.instrument.assetType === 'OPTION') {
      const parsed = parseOccSymbol(pos.instrument.symbol);
      if (parsed) {
        optionLegs.push({ pos, parsed });
      } else {
        out.push(makeOther(pos, now, 'Option leg with unparseable OCC symbol'));
      }
    } else {
      out.push(makeOther(pos, now));
    }
  }

  // 2. Group option legs by (underlying, expiration).
  const groups = new Map<string, OptionLeg[]>();
  for (const leg of optionLegs) {
    const key = `${leg.parsed.underlying}|${leg.parsed.expiration}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(leg);
  }

  // 3. Classify each group.
  for (const group of groups.values()) {
    out.push(classifyGroup(group, now));
  }

  return out;
}

function classifyGroup(group: OptionLeg[], now: Date): ReconstructedPosition {
  const underlying = group[0].parsed.underlying;
  const expiration = group[0].parsed.expiration;
  const dte = daysToExpiration(expiration, now);

  const puts = group
    .filter((l) => l.parsed.putCall === 'PUT')
    .sort((a, b) => a.parsed.strike - b.parsed.strike);
  const calls = group
    .filter((l) => l.parsed.putCall === 'CALL')
    .sort((a, b) => a.parsed.strike - b.parsed.strike);

  const qtyOf = (l: OptionLeg) => signedQty(l.pos);
  const sameMagnitude = group.every(
    (l) => Math.abs(qtyOf(l)) === Math.abs(qtyOf(group[0])),
  );
  const qty = Math.abs(qtyOf(group[0]));

  // --- IRON CONDOR: exactly 4 legs, 2 puts + 2 calls, clean structure ---
  if (group.length === 4 && puts.length === 2 && calls.length === 2 && sameMagnitude) {
    const [lowerPut, higherPut] = puts;
    const [lowerCall, higherCall] = calls;
    const isPutSpread = qtyOf(lowerPut) > 0 && qtyOf(higherPut) < 0; // long lower, short higher
    const isCallSpread = qtyOf(lowerCall) < 0 && qtyOf(higherCall) > 0; // short lower, long higher
    const noOverlap = higherPut.parsed.strike < lowerCall.parsed.strike; // shorts don't cross

    if (isPutSpread && isCallSpread && noOverlap) {
      const legs = [
        toLeg(lowerPut.pos, lowerPut.parsed, 'LONG_PUT'),
        toLeg(higherPut.pos, higherPut.parsed, 'SHORT_PUT'),
        toLeg(lowerCall.pos, lowerCall.parsed, 'SHORT_CALL'),
        toLeg(higherCall.pos, higherCall.parsed, 'LONG_CALL'),
      ];
      const putWidth = higherPut.parsed.strike - lowerPut.parsed.strike;
      const callWidth = higherCall.parsed.strike - lowerCall.parsed.strike;
      const strikeWidth = Math.max(putWidth, callWidth); // conservative if rolled asymmetric
      const creditPerShare = netCreditPerShare(legs);
      const { value: openPnl, reliable } = aggregateOpenPnl(group);
      return {
        kind: 'IRON_CONDOR',
        underlying,
        expiration,
        legs,
        quantity: qty,
        wingWidth: strikeWidth * 100 * qty,
        credit: creditPerShare * 100 * qty,
        bpr: (strikeWidth - creditPerShare) * 100 * qty,
        openPnl,
        openPnlReliable: reliable,
        dte,
      };
    }
  }

  // --- VERTICAL SPREAD: exactly 2 legs, same type, one long + one short ---
  if (group.length === 2 && sameMagnitude && (puts.length === 2 || calls.length === 2)) {
    const sorted = group.slice().sort((a, b) => a.parsed.strike - b.parsed.strike);
    const longLeg = sorted.find((l) => qtyOf(l) > 0);
    const shortLeg = sorted.find((l) => qtyOf(l) < 0);
    if (longLeg && shortLeg) {
      const side: 'PUT' | 'CALL' = puts.length === 2 ? 'PUT' : 'CALL';
      const legs = [
        toLeg(longLeg.pos, longLeg.parsed, 'LONG'),
        toLeg(shortLeg.pos, shortLeg.parsed, 'SHORT'),
      ];
      const strikeWidth = Math.abs(longLeg.parsed.strike - shortLeg.parsed.strike);
      const creditPerShare = netCreditPerShare(legs);
      const { value: openPnl, reliable } = aggregateOpenPnl(group);
      return {
        kind: 'VERTICAL_SPREAD',
        underlying,
        expiration,
        legs,
        quantity: qty,
        wingWidth: strikeWidth * 100 * qty,
        credit: creditPerShare * 100 * qty,
        bpr: (strikeWidth - creditPerShare) * 100 * qty,
        openPnl,
        openPnlReliable: reliable,
        dte,
        side,
      };
    }
  }

  // --- Anything else: unrecognized option structure -> OTHER w/ note ---
  const legs = group.map((l) =>
    toLeg(l.pos, l.parsed, qtyOf(l) > 0 ? 'LONG' : 'SHORT'),
  );
  const { value: openPnl, reliable } = aggregateOpenPnl(group);
  return {
    kind: 'OTHER',
    underlying,
    expiration,
    legs,
    quantity: qty || group.length,
    wingWidth: null,
    credit: null,
    bpr: null,
    openPnl,
    openPnlReliable: reliable,
    dte,
    note: `Unrecognized option group (${group.length} legs) — review manually`,
  };
}

/** credit/share = sum(|short premium|) - sum(|long premium|). */
function netCreditPerShare(legs: ReconstructedLeg[]): number {
  let credit = 0;
  for (const l of legs) {
    if (l.quantity < 0) credit += l.averagePrice;
    else credit -= l.averagePrice;
  }
  return credit;
}

function aggregateOpenPnl(group: OptionLeg[]): { value: number; reliable: boolean } {
  let value = 0;
  let reliable = true;
  for (const l of group) {
    const r = legOpenPnl(l.pos);
    value += r.value;
    if (!r.reliable) reliable = false;
  }
  return { value, reliable };
}

function makeOther(pos: SchwabPosition, now: Date, note?: string): ReconstructedPosition {
  const parsed = parseOccSymbol(pos.instrument.symbol);
  const { value: openPnl, reliable } = legOpenPnl(pos);
  return {
    kind: 'OTHER',
    underlying: parsed?.underlying ?? pos.instrument.underlyingSymbol ?? pos.instrument.symbol,
    expiration: parsed?.expiration ?? null,
    legs: parsed ? [toLeg(pos, parsed, signedQty(pos) > 0 ? 'LONG' : 'SHORT')] : [],
    quantity: signedQty(pos),
    wingWidth: null,
    credit: null,
    bpr: null,
    openPnl,
    openPnlReliable: reliable,
    dte: parsed ? daysToExpiration(parsed.expiration, now) : null,
    note,
  };
}

// ---------------------------------------------------------------------------
// Convenience summary — seam for v1.3 items 2-4 (BPR tracker, 5-cap, per-pillar)
// ---------------------------------------------------------------------------

export type OpenRiskSummary = {
  /** Total max-loss BPR across condors + verticals (dollars). */
  openBpr: number;
  /** Slots consumed against the 5-position cap (Q2: a vertical occupies a slot). */
  slotsUsed: number;
  condorCount: number;
  verticalCount: number;
  otherCount: number;
};

export function summarizeOpenRisk(reconstructed: ReconstructedPosition[]): OpenRiskSummary {
  let openBpr = 0;
  let condorCount = 0;
  let verticalCount = 0;
  let otherCount = 0;
  for (const p of reconstructed) {
    if (p.kind === 'IRON_CONDOR') {
      condorCount++;
      openBpr += p.bpr ?? 0;
    } else if (p.kind === 'VERTICAL_SPREAD') {
      verticalCount++;
      openBpr += p.bpr ?? 0; // Q2: fractional BPR falls out of the wing's own max loss
    } else {
      otherCount++;
    }
  }
  return {
    openBpr,
    slotsUsed: condorCount + verticalCount,
    condorCount,
    verticalCount,
    otherCount,
  };
}
