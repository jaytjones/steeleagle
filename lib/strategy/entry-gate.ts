/**
 * lib/strategy/entry-gate.ts
 *
 * Combines the two independent entry constraints into one verdict for a scanner card:
 *   - position limits (global 5-cap + per-pillar / equity block)  → position-limits.ts
 *   - BPR capacity (50%-of-equity cap pre-flight)                 → bpr.ts
 *
 * A setup that passes the strategy filters is still un-enterable if either gate blocks.
 * Pure + deterministic; the dashboard calls this per visible card and passes the result
 * down to <ScannerCard entryGate={...} />.
 */

import type { ReconstructedPosition } from './reconstruct-positions';
import { checkPositionLimits } from './position-limits';
import { preflightAddTrade, type BprUtilization } from './bpr';

export type EntryGateStatus = 'OK' | 'TIGHT' | 'BLOCKED';

export type EntryGate = {
  status: EntryGateStatus;
  /** Block/caution reasons (empty when OK). */
  reasons: string[];
};

export function computeEntryGate(args: {
  positions: ReconstructedPosition[];
  bprUtil: BprUtilization | null;
  symbol: string;
  /** Whether the candidate condor passes the strategy filters (PASS card). */
  passesFilter: boolean;
  /** Prospective max-loss BPR in PER-CONTRACT DOLLARS (e.g. 820). */
  prospectiveBprDollars: number;
}): EntryGate {
  const { positions, bprUtil, symbol, passesFilter, prospectiveBprDollars } = args;

  // Only a setup you'd actually take has an entry gate; FAIL/CALIBRATING is moot.
  if (!passesFilter) return { status: 'OK', reasons: [] };

  const reasons: string[] = [];
  let status: EntryGateStatus = 'OK';

  // Position-count / per-pillar limits (items 3 & 4).
  const limit = checkPositionLimits(positions, symbol);
  if (!limit.allowed) {
    status = 'BLOCKED';
    reasons.push(...limit.reasons);
  }

  // BPR capacity pre-flight (item 2 follow-on).
  if (bprUtil) {
    const pre = preflightAddTrade(bprUtil, prospectiveBprDollars);
    if (pre.status === 'EXCEEDS') {
      status = 'BLOCKED';
      reasons.push('Entering would exceed the 50% BPR cap');
    } else if (pre.status === 'TIGHT' && status !== 'BLOCKED') {
      status = 'TIGHT';
      reasons.push(`Would use ${Math.round(pre.projectedPctOfCap)}% of the BPR cap`);
    }
  }

  return { status, reasons };
}
