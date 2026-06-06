/**
 * lib/strategy/earnings-watchlist.ts
 *
 * Tactical Earnings sleeve watchlist (Strategy v1.5 §8.3) as config-as-code,
 * mirroring the SYMBOL_PILLAR pattern in position-limits.ts. The 12 tradeable
 * names + their tiers are strategy-defined and rarely change, so a constant is
 * the single source of truth; promote to a DB table only if UI editing is ever
 * wanted (v1.4 scoping §7.4).
 *
 *   Tier 1 — behaved mega-caps, default sizing.
 *   Tier 2 — active but manageable, max 1 contract, sized down vs Tier 1.
 *   Tier 3 — explicitly BLOCKED (10–25%+ overnight moves blow through the wings;
 *            the high IV is fairly priced, so there is no overstatement edge).
 *
 * Pure and deterministic. `earnings-condor.ts` and `earnings-gate.ts` both read
 * tier + sizing from here so the two never disagree.
 */

export type EarningsTier = 1 | 2 | 3;

/** Earnings-session timing from the provider's `hour` field (Finnhub bmo/amc/dmh). */
export type EarningsSession = 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN';

/** Symbol → tier for the §8.3 watchlist. Anything absent is OFF-watchlist. */
export const EARNINGS_WATCHLIST: Record<string, EarningsTier> = {
  // Tier 1 — preferred candidates (default sizing)
  AAPL: 1, MSFT: 1, JPM: 1, V: 1, KO: 1, PG: 1, WMT: 1, JNJ: 1,
  // Tier 2 — size down, max 1 contract
  GOOGL: 2, AMZN: 2, AMD: 2, CRM: 2,
  // Tier 3 — never tradeable (listed so the scanner can show TIER3_BLOCKED explicitly)
  TSLA: 3, NVDA: 3, NFLX: 3, META: 3, SNAP: 3, PLTR: 3,
};

/**
 * Max contracts per name. §8.2: "Maximum 1 contract per name unless account
 * exceeds $50k." At the current $10k–$30k scale that is 1 for every tier; the
 * cap is encoded as a function of equity so the rule lives in one place.
 */
export const MAX_CONTRACTS_DEFAULT = 1;
const LARGE_ACCOUNT_THRESHOLD = 50_000;

/**
 * Tier-2 sizing factor vs Tier 1. §8.2/§8.3 say "size down 25–50%"; we take the
 * conservative end (size down 50% → keep 50%). Advisory at current scale because
 * `maxContracts` already pins everyone at 1 contract; it scales the *target BPR*
 * the gate sizes against once the account is large enough to hold >1 contract.
 */
const TIER_SIZE_FACTOR: Record<EarningsTier, number> = { 1: 1.0, 2: 0.5, 3: 0 };

export function tierOf(symbol: string): EarningsTier | null {
  return EARNINGS_WATCHLIST[symbol.toUpperCase()] ?? null;
}

/** On the watchlist at all (any tier, including the blocked Tier 3)? */
export function isWatchlisted(symbol: string): boolean {
  return tierOf(symbol) !== null;
}

/** Tradeable = Tier 1 or Tier 2. Tier 3 and off-watchlist names are not. */
export function isTradeable(symbol: string): boolean {
  const tier = tierOf(symbol);
  return tier === 1 || tier === 2;
}

/** Sizing factor vs a Tier-1 baseline (1.0). Off-watchlist → 0. */
export function sizeFactorOf(symbol: string): number {
  const tier = tierOf(symbol);
  return tier === null ? 0 : TIER_SIZE_FACTOR[tier];
}

/** Contracts allowed for this name at the given account equity. */
export function maxContractsFor(symbol: string, accountEquity: number): number {
  if (!isTradeable(symbol)) return 0;
  return accountEquity > LARGE_ACCOUNT_THRESHOLD ? 2 : MAX_CONTRACTS_DEFAULT;
}

/** All tradeable (Tier 1 + 2) symbols — the universe the earnings cron pulls. */
export function tradeableSymbols(): string[] {
  return Object.keys(EARNINGS_WATCHLIST).filter(isTradeable);
}

/** Every watchlisted symbol including Tier 3 (so the UI can render blocked cards). */
export function allWatchlistSymbols(): string[] {
  return Object.keys(EARNINGS_WATCHLIST);
}
