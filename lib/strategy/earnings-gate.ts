/**
 * lib/strategy/earnings-gate.ts
 *
 * The earnings-sleeve analogue of entry-gate.ts. Fuses the §8.4 integration caps
 * into one verdict for an earnings card:
 *
 *   - Tier:        Tier 3 (and off-watchlist) are never tradeable.
 *   - Crisis:      skip earnings the week the core takes a stop-loss event
 *                  (best-effort: caller passes `crisisActive`, fused from a live
 *                  "any core position at/over stop" probe + a manual toggle).
 *   - Concurrency: ≤ 2 open earnings positions (SEPARATE from the core 5-cap —
 *                  §8.4 says earnings don't compete for core slots).
 *   - Per-trade:   ≤ 3% of account equity per earnings trade.
 *   - Earnings BPR sub-cap: open earnings BPR ≤ 10% of equity.
 *   - Shared total: still counts toward the core 50%-of-equity cap (via bpr.ts).
 *
 * "Open earnings position" = a reconstructed condor/vertical whose underlying is a
 * tradeable watchlist name (an individual stock, not an ETF pillar). No new table —
 * classification falls out of reconstruct-positions.ts + the watchlist constant.
 *
 * Pure + deterministic. Precedence mirrors entry-gate: BLOCKED > TIGHT > OK, reasons accumulate.
 */

import type { ReconstructedPosition } from './reconstruct-positions';
import { preflightAddTrade, type BprUtilization } from './bpr';
import { isTradeable, isWatchlisted, tierOf, type EarningsTier } from './earnings-watchlist';
import { alertFor } from './position-alerts';

export const MAX_CONCURRENT_EARNINGS = 2;
export const EARNINGS_BPR_CAP_FRACTION = 0.10; // ≤10% of equity, earnings collectively
export const PER_TRADE_EQUITY_CAP_FRACTION = 0.03; // ≤3% of equity per trade

export type EarningsGateStatus = 'OK' | 'TIGHT' | 'BLOCKED';

export type EarningsGate = {
  status: EarningsGateStatus;
  reasons: string[];
  tier: EarningsTier | null;
  /** Open earnings positions currently held (watchlist underlyings). */
  openEarningsCount: number;
  /** Summed BPR of those open earnings positions, real dollars. */
  earningsOpenBpr: number;
  /** 10% sub-cap ceiling in dollars (0 when equity unknown). */
  earningsCapDollars: number;
  /** 3% per-trade ceiling in dollars (0 when equity unknown). */
  perTradeCapDollars: number;
};

/** Count + summed BPR of currently-open earnings positions (watchlist underlyings). */
export function summarizeOpenEarnings(
  positions: ReconstructedPosition[],
): { count: number; openBpr: number } {
  const open = positions.filter(
    (p) =>
      (p.kind === 'IRON_CONDOR' || p.kind === 'VERTICAL_SPREAD') &&
      isTradeable(p.underlying),
  );
  const openBpr = open.reduce((sum, p) => sum + (p.bpr ?? 0), 0);
  return { count: open.length, openBpr };
}

/**
 * Best-effort crisis auto-detect (§8.4 crisis protocol). True when any OPEN CORE
 * position is currently at/over its stop. "Core" = a spread on a non-watchlist
 * (ETF pillar) underlying; an at/over-stop position is one whose live alert tone
 * is 'negative' (the stop-loss branch of alertFor).
 *
 * This is a conservative proxy: without a trade journal we can only see positions
 * that are still open and currently red, not core losers already closed this week
 * (v1.4 scoping §7.2). The route fuses this with a manual toggle:
 *   crisisActive = manualToggle || detectCoreStop(positions)
 */
export function detectCoreStop(positions: ReconstructedPosition[]): boolean {
  return positions.some(
    (p) =>
      (p.kind === 'IRON_CONDOR' || p.kind === 'VERTICAL_SPREAD') &&
      !isWatchlisted(p.underlying) &&
      alertFor(p).tone === 'negative',
  );
}

export function computeEarningsGate(args: {
  positions: ReconstructedPosition[];
  bprUtil: BprUtilization | null;
  symbol: string;
  /** Account net liq for the 3% / 10% caps. Pass 0 if balances aren't loaded. */
  equity: number;
  /** Earnings condor max-loss BPR in real dollars. */
  prospectiveBprDollars: number;
  /** Best-effort crisis flag: core stop-loss this week (auto probe OR manual toggle). */
  crisisActive: boolean;
}): EarningsGate {
  const { positions, bprUtil, symbol, equity, prospectiveBprDollars, crisisActive } = args;

  const tier = tierOf(symbol);
  const { count: openEarningsCount, openBpr: earningsOpenBpr } = summarizeOpenEarnings(positions);
  const haveEquity = Number.isFinite(equity) && equity > 0;
  const earningsCapDollars = haveEquity ? EARNINGS_BPR_CAP_FRACTION * equity : 0;
  const perTradeCapDollars = haveEquity ? PER_TRADE_EQUITY_CAP_FRACTION * equity : 0;

  const reasons: string[] = [];
  // Track blocking/caution as flags and derive `status` once at the end — this
  // avoids a closure mutating `status` (which defeats TS control-flow narrowing
  // and trips tsc --noEmit even though tsx --test transpiles it fine).
  let blocked = false;
  let tight = false;
  const block = (reason: string) => {
    blocked = true;
    reasons.push(reason);
  };

  // Tier gate.
  if (tier === 3) {
    block('Tier 3 — never tradeable (blocked)');
  } else if (tier === null) {
    block('Not on the earnings watchlist');
  }

  // Crisis protocol (best-effort).
  if (crisisActive) {
    block('Crisis protocol: core stop-loss this week — skip earnings entries');
  }

  // Concurrency (earnings-only ≤2).
  if (openEarningsCount >= MAX_CONCURRENT_EARNINGS) {
    block(`${MAX_CONCURRENT_EARNINGS} earnings positions already open`);
  }

  // Per-trade equity cap (≤3%).
  if (haveEquity && prospectiveBprDollars > perTradeCapDollars) {
    block(
      `Trade BPR $${Math.round(prospectiveBprDollars)} exceeds the 3% per-trade cap ` +
        `($${Math.round(perTradeCapDollars)})`,
    );
  }

  // Earnings BPR sub-cap (≤10% collectively).
  if (haveEquity && earningsOpenBpr + Math.max(0, prospectiveBprDollars) > earningsCapDollars) {
    block(
      `Earnings BPR would reach $${Math.round(earningsOpenBpr + prospectiveBprDollars)}, ` +
        `over the 10% sub-cap ($${Math.round(earningsCapDollars)})`,
    );
  }

  // Shared 50%-of-equity total cap (reuses the core pre-flight).
  if (bprUtil) {
    const pre = preflightAddTrade(bprUtil, prospectiveBprDollars);
    if (pre.status === 'EXCEEDS') {
      block('Entering would exceed the 50% total BPR cap');
    } else if (pre.status === 'TIGHT' && !blocked) {
      tight = true;
      reasons.push(`Would use ${Math.round(pre.projectedPctOfCap)}% of the total BPR cap`);
    }
  }

  const status: EarningsGateStatus = blocked ? 'BLOCKED' : tight ? 'TIGHT' : 'OK';

  return {
    status,
    reasons,
    tier,
    openEarningsCount,
    earningsOpenBpr: Math.round(earningsOpenBpr * 100) / 100,
    earningsCapDollars: Math.round(earningsCapDollars * 100) / 100,
    perTradeCapDollars: Math.round(perTradeCapDollars * 100) / 100,
  };
}
