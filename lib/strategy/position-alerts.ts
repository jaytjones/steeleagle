/**
 * lib/strategy/position-alerts.ts
 *
 * Turns the monitor's display signals into actionable close/watch alerts (PRD v1.3 item 5).
 * Per the strategy (§5):
 *   - Profit take: close at 50% of credit received.
 *   - 21-DTE rule: close at ≤21 DTE without exception (gamma); 22–23 DTE is a "watch".
 *   - Stop-loss:   close/adjust at a multiple of credit (2× default, 1.5× Volatility pillar).
 *
 * P&L-based signals (profit, stop) only fire when openPnl is the reliable OPEN figure. If
 * the monitor is showing today-only P&L (openPnlReliable === false), they're skipped —
 * today's P&L can't be measured against the target/stop honestly. Time-based (DTE) alerts
 * fire regardless, since they don't depend on P&L.
 */
import type { ReconstructedPosition } from './reconstruct-positions';
import { pillarOf } from './position-limits';

export const DTE_CLOSE = 21;
export const DTE_WATCH = 23;
export const PROFIT_TARGET = 0.5; // 50% of credit
export const STOP_MULT_DEFAULT = 2; // 2× credit
export const STOP_MULT_VOL = 1.5; // 1.5× credit (Volatility pillar)

export type AlertLevel = 'NONE' | 'WATCH' | 'ACTION';
export type AlertTone = 'neutral' | 'positive' | 'negative';

export type PositionAlert = {
  level: AlertLevel;
  /** Most-urgent reason first. */
  reasons: string[];
  /** Coloring hint: positive = profit take, negative = loss/stop, neutral = time-only. */
  tone: AlertTone;
};

export function alertFor(p: ReconstructedPosition): PositionAlert {
  if (p.kind === 'OTHER') return { level: 'NONE', reasons: [], tone: 'neutral' };

  const reasons: string[] = [];
  let level: AlertLevel = 'NONE';
  let tone: AlertTone = 'neutral';

  // --- Time: 21-DTE rule ---
  if (p.dte !== null) {
    if (p.dte <= DTE_CLOSE) {
      reasons.push(`21-DTE rule — close now (${p.dte} DTE)`);
      level = 'ACTION';
    } else if (p.dte <= DTE_WATCH) {
      reasons.push(`Approaching 21-DTE (${p.dte} DTE)`);
      level = 'WATCH';
    }
  }

  // --- P&L: profit take / stop-loss (only when open P&L is trustworthy) ---
  if (p.openPnlReliable && p.credit !== null && p.credit > 0) {
    const stopMult = pillarOf(p.underlying) === 'VOLATILITY' ? STOP_MULT_VOL : STOP_MULT_DEFAULT;
    const lossMultiple = -p.openPnl / p.credit; // positive when losing

    if (lossMultiple >= stopMult) {
      reasons.unshift(`Stop-loss — down ${lossMultiple.toFixed(1)}× credit (≥${stopMult}×)`);
      level = 'ACTION';
      tone = 'negative';
    } else if (p.openPnl >= PROFIT_TARGET * p.credit) {
      reasons.push(`Profit target — ${Math.round((p.openPnl / p.credit) * 100)}% of credit`);
      level = 'ACTION';
      tone = 'positive';
    }
  }

  return { level, reasons, tone };
}

export type AlertSummary = { action: number; watch: number };

export function summarizeAlerts(positions: ReconstructedPosition[]): AlertSummary {
  let action = 0;
  let watch = 0;
  for (const p of positions) {
    const a = alertFor(p);
    if (a.level === 'ACTION') action++;
    else if (a.level === 'WATCH') watch++;
  }
  return { action, watch };
}
