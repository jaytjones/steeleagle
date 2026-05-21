/**
 * components/positions/PositionsMonitor.tsx
 *
 * Renders open positions grouped into the three buckets from reconstruct-positions:
 *   - Iron Condors
 *   - Vertical Spreads (one remaining wing, e.g. after a partial close)
 *   - Others (equities, money-market funds, unrecognized option groups)
 *
 * Consumes ReconstructedPosition[] from GET /api/positions (v1.3 shape).
 * Palette matches the dashboard (slate); display font via var(--font-display).
 *
 * Includes the locked 21-DTE banding (display only): WARNING at 22–23 DTE,
 * ALERT at ≤21 DTE, plus a P&L-vs-50%-of-credit readout. Roll/close *alerting*
 * logic is item 5; this is just the surface.
 */
import type { ReconstructedPosition } from '@/lib/strategy/reconstruct-positions';

function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

type DteStatus = 'OK' | 'WARNING' | 'ALERT';
function dteStatus(dte: number | null): DteStatus {
  if (dte === null) return 'OK';
  if (dte <= 21) return 'ALERT'; // strategy: close at 21 without exception
  if (dte <= 23) return 'WARNING';
  return 'OK';
}
const DTE_STYLES: Record<DteStatus, string> = {
  OK: 'text-slate-400',
  WARNING: 'text-amber-400',
  ALERT: 'text-red-400 font-semibold',
};

const HEAD = 'font-[family-name:var(--font-display)] uppercase tracking-wider text-slate-500';
const SECTION_HEAD =
  'font-[family-name:var(--font-display)] mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500';

function legStrike(p: ReconstructedPosition, role: string): number | undefined {
  return p.legs.find((l) => l.role === role)?.strike;
}

function structureLabel(p: ReconstructedPosition): string {
  if (p.kind === 'IRON_CONDOR') {
    return `${legStrike(p, 'LONG_PUT')}/${legStrike(p, 'SHORT_PUT')} · ${legStrike(p, 'SHORT_CALL')}/${legStrike(p, 'LONG_CALL')}`;
  }
  if (p.kind === 'VERTICAL_SPREAD') {
    const strikes = p.legs.map((l) => l.strike).sort((a, b) => a - b);
    return `${p.side} ${strikes[0]}/${strikes[1]}`;
  }
  return p.legs.map((l) => l.occSymbol).join(', ');
}

function PnlCell({ p }: { p: ReconstructedPosition }) {
  const credit = p.credit ?? 0;
  const target = credit * 0.5;
  const hit = credit > 0 && p.openPnl >= target;
  const pctOfCredit = credit > 0 ? (p.openPnl / credit) * 100 : null;
  const tone = p.openPnl > 0 ? 'text-emerald-400' : p.openPnl < 0 ? 'text-red-400' : 'text-slate-400';
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={`font-mono text-sm ${tone}`}>
        {usd(p.openPnl)}
        {!p.openPnlReliable && <span className="ml-1 text-[10px] text-slate-600">(today)</span>}
      </span>
      {p.openPnlReliable && pctOfCredit !== null && (
        <span className="font-mono text-[10px] text-slate-500">
          {Math.round(pctOfCredit)}% of credit
          {hit && <span className="ml-1 text-emerald-400">· TARGET</span>}
        </span>
      )}
    </div>
  );
}

function SpreadTable({ title, positions }: { title: string; positions: ReconstructedPosition[] }) {
  if (positions.length === 0) return null;
  return (
    <section className="mb-6">
      <h3 className={SECTION_HEAD}>
        {title} <span className="text-slate-600">({positions.length})</span>
      </h3>
      <div className="overflow-hidden rounded-md border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b border-slate-800 bg-slate-900/60 text-left text-[10px] ${HEAD}`}>
              <th className="px-3 py-2">Underlying</th>
              <th className="px-3 py-2">Structure</th>
              <th className="px-3 py-2 text-right">DTE</th>
              <th className="px-3 py-2 text-right">Credit</th>
              <th className="px-3 py-2 text-right">BPR</th>
              <th className="px-3 py-2 text-right">{'Open P&L'}</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const ds = dteStatus(p.dte);
              return (
                <tr key={`${p.underlying}-${p.expiration}-${i}`} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-[family-name:var(--font-display)] text-base font-semibold text-slate-100">
                      {p.underlying}
                    </span>
                    {p.quantity > 1 && <span className="ml-1 font-mono text-[10px] text-slate-500">×{p.quantity}</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{structureLabel(p)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${DTE_STYLES[ds]}`}>
                    {p.dte ?? '—'}
                    {ds === 'ALERT' && <span className="ml-1 text-[10px]">CLOSE</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{usd(p.credit)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{usd(p.bpr)}</td>
                  <td className="px-3 py-2 text-right">
                    <PnlCell p={p} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OthersTable({ positions }: { positions: ReconstructedPosition[] }) {
  if (positions.length === 0) return null;
  return (
    <section className="mb-6">
      <h3 className={SECTION_HEAD}>
        Others <span className="text-slate-600">({positions.length})</span>
      </h3>
      <div className="overflow-hidden rounded-md border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b border-slate-800 bg-slate-900/60 text-left text-[10px] ${HEAD}`}>
              <th className="px-3 py-2">Position</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Mkt Value</th>
              <th className="px-3 py-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const mv = p.legs.length ? p.legs.reduce((s, l) => s + l.marketValue, 0) : null;
              const label = p.legs[0]?.occSymbol ?? p.underlying;
              return (
                <tr key={`${label}-${i}`} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">{label}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{p.quantity}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{usd(mv)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.note ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EmptyPositionsState() {
  return (
    <div className="rounded-md border border-dashed border-slate-800 px-4 py-10 text-center">
      <p className="font-[family-name:var(--font-display)] text-sm uppercase tracking-wider text-slate-500">
        No open positions
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Open condors are entered manually in Schwab/TOS and will appear here once filled.
      </p>
    </div>
  );
}

function PositionsLoading() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md border border-slate-800 bg-slate-900/60" />
      ))}
    </div>
  );
}

export function PositionsMonitor({
  positions,
  loading = false,
}: {
  positions: ReconstructedPosition[];
  loading?: boolean;
}) {
  const condors = positions.filter((p) => p.kind === 'IRON_CONDOR');
  const verticals = positions.filter((p) => p.kind === 'VERTICAL_SPREAD');
  const others = positions.filter((p) => p.kind === 'OTHER');

  return (
    <div>
      <h2 className="font-[family-name:var(--font-display)] mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
        Open Positions
      </h2>
      {loading && positions.length === 0 ? (
        <PositionsLoading />
      ) : positions.length === 0 ? (
        <EmptyPositionsState />
      ) : (
        <>
          <SpreadTable title="Iron Condors" positions={condors} />
          <SpreadTable title="Vertical Spreads" positions={verticals} />
          <OthersTable positions={others} />
        </>
      )}
    </div>
  );
}

export default PositionsMonitor;
