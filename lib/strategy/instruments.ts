/**
 * lib/strategy/instruments.ts
 *
 * v2.4 — single source of truth for per-instrument metadata (spec §4).
 * Config-as-code, pure, no I/O. Every value here is either probe-verified
 * (Phase 0, `docs/steeleagle-v2-4-phase0-findings.md`) or explicitly marked
 * as an estimate awaiting a live fill.
 *
 * WHY THIS MODULE EXISTS — the load-bearing problem (spec §5):
 * before v2.4 an OCC symbol's ROOT *was* the underlying. That holds for every
 * ETF but breaks on indices: `SPXW` and `SPX` are two roots for ONE underlying.
 * Unmapped, a single SPX condor splits into two piles in `reconstructPositions`
 * and the importer, bypasses the equity-block cap in `position-limits`, and —
 * the highest-severity consumer — makes the exit sweep's pre-place guard blind,
 * which is how a duplicate GTC gets placed with real money. `resolveUnderlying`
 * is the one mapping every consumer resolves through.
 *
 * CANONICALIZATION RULE (spec §4): the app stores and displays `$`-free symbols
 * everywhere (`iv_history`, `trades`, settings, UI). The `$` prefix and the OCC
 * root translation exist ONLY at the Schwab adapter boundary. Existing ETF rows
 * are untouched — for an ETF, apiSymbol === symbol === preferredRoot.
 *
 * DELIBERATE OMISSION — `strikeIncrement`: spec §4 listed it and §6.3 called for
 * the builder to step strikes by it. The shipped builder does no strike-stepping
 * — it snaps to strikes that actually exist in the fetched chain
 * (`findNearestStrike`), which is strictly better than stepping by an assumed
 * increment. A field nothing consumes rots, so it is not modelled here.
 * Recorded as a rev-B correction to the spec.
 */

// ---------------------------------------------------------------------------
// Pillar — the strategy's five-pillar diversification model.
// Lives here (not in position-limits) because instrument identity is one
// concern: position-limits re-exports it so existing imports keep working.
// NOTE: distinct from `Pillar` in types/index.ts, which is an alias for
// `string` ("any tradable symbol") and is a different concept entirely.
// ---------------------------------------------------------------------------

export type Pillar = 'EQUITY' | 'FIXED_INCOME' | 'COMMODITY' | 'VOLATILITY' | 'CURRENCY';

export type InstrumentKind = 'etf' | 'index';

export interface InstrumentMeta {
  /** Canonical internal symbol — `$`-free. What the DB and UI store. */
  symbol: string;
  /** Market-data symbol for /chains and /quotes. `$`-prefixed for indices (V1). */
  apiSymbol: string;
  kind: InstrumentKind;
  /**
   * EVERY OCC root that maps back to this underlying. More than one entry
   * means a parsed root is not enough to rebuild an order symbol — see
   * `hasAmbiguousRoot`.
   */
  occRoots: string[];
  /** Root used when BUILDING a new order symbol. PM-settled where a choice exists. */
  preferredRoot: string;
  pillar: Pillar;
  /**
   * Minimum acceptable wing width in dollars/share — the generalized form of
   * the builder's old $10 constant. Scales with the instrument's price level
   * so a $10 wing on a 7,400-point index isn't treated as tradeable.
   */
  minWingWidth: number;
  /**
   * Schwab's $0.65 + any exchange proprietary index fee, per contract.
   * ETFs are exact. Index values are ESTIMATES from spec §2 and are corrected
   * against the first real index fill's confirmed fees (spec §9, open item).
   */
  perContractFee: number;
  /**
   * Physical delivery vs cash settlement. Sourced from config, NEVER from
   * Schwab's `settlementType` field — that means AM/PM ("A"/"P"), not
   * physical/cash, and reads "P" for cash-settled SPXW and physical SPY alike
   * (Phase 0 V3 trap).
   */
  settlement: 'physical' | 'cash';
  /**
   * THE SCHWAB DOCTRINE GATE. False until a real order for this instrument has
   * been placed-and-cancelled and its payload pinned as a golden fixture.
   * While false, no order ticket may be built for this symbol — the app
   * refuses rather than guessing a symbol format Schwab's docs get wrong.
   *
   * ETFs: true, pinned 2026-07-12 (entry) / 2026-07-24 (GTC close).
   * XSP: true, pinned 2026-07-30 (live place-and-cancel, order 1007409658003 —
   * answered V7: standard OCC symbol form, envelope identical to the ETF entry
   * fixture). SPX/NDX/RUT: false until each gets its own place-and-cancel.
   */
  orderFixturePinned: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ETF_FEE = 0.65; // Schwab's per-contract options commission.

function etf(symbol: string, pillar: Pillar): InstrumentMeta {
  return {
    symbol,
    apiSymbol: symbol,
    kind: 'etf',
    occRoots: [symbol],
    preferredRoot: symbol,
    pillar,
    minWingWidth: 10, // the shipped v1.x constant — $10 ≈ 5.8% friction
    perContractFee: ETF_FEE,
    settlement: 'physical',
    orderFixturePinned: true,
  };
}

/**
 * Index metadata. Every field below is probe-verified except `perContractFee`
 * and `minWingWidth`:
 *  - apiSymbol   V1: /chains and /quotes accept ONLY the `$` form; bare and
 *                `.X` forms both 400.
 *  - occRoots    V2: one chain response carries BOTH roots (SPX + SPXW). XSP is
 *                the exception — a SINGLE root, which is why XSP alone is
 *                unambiguous enough to auto-place an exit against.
 *  - settlement  V3: from `deliverableNote` ("100 $XSP(Cash)"), not
 *                `settlementType`.
 *  - minWingWidth  proportional to the level (spec §2), tuned at first scan.
 *  - perContractFee  ESTIMATE (spec §2/§9) — correct at first real fill.
 */
const INDEX_INSTRUMENTS: InstrumentMeta[] = [
  {
    symbol: 'XSP',
    apiSymbol: '$XSP',
    kind: 'index',
    occRoots: ['XSP'], // V2: no XSPW exists — the one unambiguous index
    preferredRoot: 'XSP',
    pillar: 'EQUITY',
    minWingWidth: 10, // 1/10 SPX — same scale as SPY, same floor
    perContractFee: ETF_FEE + 0.15,
    settlement: 'cash',
    // PINNED 2026-07-30: live XSP condor (order 1007409658003, 700/710P +
    // 770/780C @ 8/27, NET_CREDIT $9, unfillable) placed in TOS, read back via
    // dump-working-orders, cancelled. Answers V7: symbols are standard OCC
    // ("XSP   260827P00700000" — root padded to 6, identical to the ETF form);
    // envelope identical to the SPY entry fixture. Golden test:
    // order-ticket.test.ts "XSP golden fixture".
    orderFixturePinned: true,
  },
  {
    symbol: 'SPX',
    apiSymbol: '$SPX',
    kind: 'index',
    occRoots: ['SPX', 'SPXW'],
    preferredRoot: 'SPXW', // PM-settled, denser weekly grid in the 30–45 DTE band
    pillar: 'EQUITY',
    minWingWidth: 50,
    perContractFee: ETF_FEE + 0.65,
    settlement: 'cash',
    orderFixturePinned: false,
  },
  {
    symbol: 'NDX',
    apiSymbol: '$NDX',
    kind: 'index',
    occRoots: ['NDX', 'NDXP'],
    preferredRoot: 'NDXP',
    pillar: 'EQUITY',
    minWingWidth: 200,
    perContractFee: ETF_FEE + 0.55,
    settlement: 'cash',
    orderFixturePinned: false,
  },
  {
    symbol: 'RUT',
    apiSymbol: '$RUT',
    kind: 'index',
    occRoots: ['RUT', 'RUTW'],
    preferredRoot: 'RUTW',
    pillar: 'EQUITY',
    minWingWidth: 25,
    perContractFee: ETF_FEE + 0.45,
    settlement: 'cash',
    orderFixturePinned: false,
  },
];

/** The 21-instrument five-pillar ETF universe, unchanged from v1.4. */
const ETF_INSTRUMENTS: InstrumentMeta[] = [
  etf('SPY', 'EQUITY'), etf('QQQ', 'EQUITY'), etf('IWM', 'EQUITY'),
  etf('DIA', 'EQUITY'), etf('EFA', 'EQUITY'), etf('EEM', 'EQUITY'),
  etf('TLT', 'FIXED_INCOME'), etf('IEF', 'FIXED_INCOME'),
  etf('HYG', 'FIXED_INCOME'), etf('LQD', 'FIXED_INCOME'),
  etf('GLD', 'COMMODITY'), etf('SLV', 'COMMODITY'),
  etf('USO', 'COMMODITY'), etf('DBA', 'COMMODITY'),
  etf('VXX', 'VOLATILITY'), etf('UVXY', 'VOLATILITY'), etf('SVXY', 'VOLATILITY'),
  etf('UUP', 'CURRENCY'), etf('FXY', 'CURRENCY'),
  etf('FXE', 'CURRENCY'), etf('FXB', 'CURRENCY'),
];

export const INSTRUMENTS: readonly InstrumentMeta[] = [
  ...ETF_INSTRUMENTS,
  ...INDEX_INSTRUMENTS,
];

/** Canonical symbols of the four index instruments, in spec order. */
export const INDEX_SYMBOLS: readonly string[] = INDEX_INSTRUMENTS.map((i) => i.symbol);

const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

/** OCC root → canonical underlying. Built from occRoots so it cannot drift. */
const UNDERLYING_BY_ROOT = new Map<string, string>(
  INSTRUMENTS.flatMap((i) => i.occRoots.map((r) => [r, i.symbol] as const)),
);

/**
 * Same-index sibling groups (spec §7.2). Symbols within a group track the SAME
 * underlying index, so holding two of them is zero diversification even though
 * each is a distinct ticker. Declared as groups rather than per-instrument
 * `sameIndexAs` arrays so the relation cannot be recorded asymmetrically.
 */
const SAME_INDEX_GROUPS: readonly (readonly string[])[] = [
  ['SPY', 'XSP', 'SPX'], // S&P 500
  ['QQQ', 'NDX'], // Nasdaq-100
  ['IWM', 'RUT'], // Russell 2000
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function norm(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Metadata for a canonical symbol, or null when it isn't in the universe. */
export function getInstrument(symbol: string): InstrumentMeta | null {
  return BY_SYMBOL.get(norm(symbol)) ?? null;
}

export function isKnownInstrument(symbol: string): boolean {
  return BY_SYMBOL.has(norm(symbol));
}

/**
 * OCC root → the underlying it belongs to. `SPXW` → `SPX`, `NDXP` → `NDX`.
 *
 * PASSTHROUGH IS DELIBERATE: an unmapped root resolves to itself. That keeps
 * ETF behaviour byte-identical (root === underlying), and means a future index
 * root Schwab introduces degrades to today's behaviour rather than crashing —
 * it groups under its own name, which is visible and wrong-but-safe, instead of
 * silently merging into another underlying.
 */
export function resolveUnderlying(occRoot: string): string {
  const root = norm(occRoot);
  return UNDERLYING_BY_ROOT.get(root) ?? root;
}

/** Market-data symbol for /chains and /quotes — `$`-prefixed for indices. */
export function apiSymbolFor(symbol: string): string {
  return getInstrument(symbol)?.apiSymbol ?? norm(symbol);
}

/** Root to use when BUILDING an order symbol. Unknown symbols map to themselves. */
export function preferredRootFor(symbol: string): string {
  return getInstrument(symbol)?.preferredRoot ?? norm(symbol);
}

/** Every OCC root that maps back to this underlying. */
export function occRootsFor(symbol: string): string[] {
  return getInstrument(symbol)?.occRoots ?? [norm(symbol)];
}

/**
 * True when this underlying trades under MORE THAN ONE OCC root, so a parsed
 * position/event log cannot prove which root a given leg was opened under.
 *
 * The exit path refuses to auto-place for these (v2.4 decision, superseding
 * spec §8.3's `trade_events` root column): the journal records strikes and
 * expirations, never symbols, so building a close from `preferredRoot` would
 * be a guess — and a close order on the wrong root does not close the position.
 * XSP, the one index April can actually trade at this account size, has a
 * single root and is therefore fully placeable.
 */
export function hasAmbiguousRoot(symbol: string): boolean {
  return occRootsFor(symbol).length > 1;
}

/** Pillar for the 5-pillar caps. Indices join the EQUITY block (spec §7.1). */
export function pillarOf(symbol: string): Pillar | 'UNKNOWN' {
  return getInstrument(symbol)?.pillar ?? 'UNKNOWN';
}

/**
 * Other symbols tracking the SAME underlying index (never includes `symbol`).
 * Empty for instruments with no sibling (DIA, TLT, …).
 */
export function sameIndexSiblings(symbol: string): string[] {
  const s = norm(symbol);
  const group = SAME_INDEX_GROUPS.find((g) => g.includes(s));
  return group ? group.filter((m) => m !== s) : [];
}

/** Per-contract commission + exchange fee. Unknown symbols assume the ETF rate. */
export function perContractFee(symbol: string): number {
  return getInstrument(symbol)?.perContractFee ?? ETF_FEE;
}

/** 4 opens + 4 closes = 8 contract fills, per 1-lot round trip (spec §9). */
export const ROUND_TRIP_FILLS = 8;

/**
 * Round-trip commission in real dollars per contract.
 * ETFs: 8 × $0.65 = $5.20 — byte-identical to the constant it replaces.
 */
export function commissionRoundTrip(symbol: string): number {
  return ROUND_TRIP_FILLS * perContractFee(symbol);
}

/** Minimum acceptable wing width, dollars/share. Unknown symbols keep the $10 floor. */
export function minWingWidthFor(symbol: string): number {
  return getInstrument(symbol)?.minWingWidth ?? 10;
}

/**
 * Has a real Schwab order payload been recorded and pinned for this symbol?
 * Unknown symbols return TRUE: an operator-added ETF ticker uses the same
 * already-pinned equity-option payload shape, and gating those would break the
 * shipped v2.0 placement path for no safety gain. Only instruments explicitly
 * in the registry can be marked unpinned.
 */
export function isOrderFixturePinned(symbol: string): boolean {
  return getInstrument(symbol)?.orderFixturePinned ?? true;
}

/**
 * Refusal message for an unpinned instrument — one wording, used by every
 * write path so the operator sees the same instruction wherever it surfaces.
 */
export function unpinnedFixtureMessage(symbol: string): string {
  const s = norm(symbol);
  return (
    `${s} has no pinned order fixture — SteelEagle refuses to build a ${s} order ticket ` +
    `from documentation alone. Place and cancel an unfillable ${s} condor in TOS, dump it ` +
    `with scripts/dump-working-orders.ts, pin the payload as a golden fixture, then set ` +
    `orderFixturePinned: true for ${s} in lib/strategy/instruments.ts (v2.4 spec §8.1 / V7).`
  );
}
