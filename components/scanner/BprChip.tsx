/**
 * components/scanner/BprChip.tsx  (or components/header/)
 *
 * Header chip: open BPR as a % of the 50%-of-equity cap (Strategy v1.4 §4 / PRD v1.3).
 * Pure presentation — feed it the object from computeBprUtilization().
 *
 * Palette matches the dashboard (slate); display font via var(--font-display).
 */
'use client';

import type { BprUtilization } from '@/lib/strategy/bpr';

const STATUS_STYLES = {
  OK: { text: 'text-emerald-400', fill: 'bg-emerald-400', ring: 'border-emerald-400/30' },
  WARNING: { text: 'text-amber-400', fill: 'bg-amber-400', ring: 'border-amber-400/40' },
  OVER: { text: 'text-red-400', fill: 'bg-red-500', ring: 'border-red-500/50' },
} as const;

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function BprChip({ utilization }: { utilization: BprUtilization }) {
  const { openBpr, cap, pctOfCap, status, slotsUsed } = utilization;
  const s = STATUS_STYLES[status];

  const finite = Number.isFinite(pctOfCap);
  const fillWidth = Math.min(100, Math.max(0, finite ? pctOfCap : 100));
  const pctLabel = finite ? `${Math.round(pctOfCap)}%` : 'OVER';

  return (
    <div
      className={`inline-flex items-center gap-3 rounded-md border ${s.ring} bg-slate-900/80 px-3 py-1.5`}
      title={`Open BPR ${usd(openBpr)} of ${usd(cap)} cap (50% of equity) · ${slotsUsed}/5 slots`}
    >
      <span className="font-[family-name:var(--font-display)] text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        BPR
      </span>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-sm font-semibold leading-none ${s.text}`}>
            {pctLabel}
          </span>
          <span className="font-mono text-[11px] leading-none text-slate-500">
            {usd(openBpr)} <span className="text-slate-600">/</span> {usd(cap)}
          </span>
        </div>

        {/* Fill bar vs cap, with a tick at the 80% warn line. */}
        <div className="relative h-1 w-20 overflow-hidden rounded-full bg-slate-700/60 sm:w-28">
          <div
            className={`h-full ${s.fill} transition-[width] duration-300`}
            style={{ width: `${fillWidth}%` }}
          />
          <div className="absolute inset-y-0 left-[80%] w-px bg-slate-500/70" aria-hidden />
        </div>
      </div>
    </div>
  );
}

export default BprChip;
