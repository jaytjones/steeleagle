/**
 * components/positions/PositionsMonitor.tsx
 *
 * Renders open positions grouped into three buckets (Iron Condors / Vertical Spreads /
 * Others) from reconstruct-positions, with the v1.3 item-5 alert layer:
 *   - top-of-monitor summary banner (N need action · M to watch)
 *   - per-row action badge: CLOSE (21-DTE / stop-loss) · PROFIT (target hit) · WATCH (22–23 DTE)
 *
 * Alerts come from position-alerts.ts; P&L-based signals self-suppress when openPnl is
 * today-only. Palette matches the dashboard (slate); display font via var(--font-display).
 */
import type { ReconstructedPosition } from '@/lib/strategy/reconstruct-positions';
import { alertFor, summarizeAlerts, type PositionAlert } from '@/lib/strategy/position-alerts';
import { summarizeRollAlerts, type RollVerdict } from '@/lib/strategy/roll-alert';

function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

type DteStatus = 'OK' | 'WARNING' | 'ALERT';
function dteStatus(dte: number | null): DteStatus {
  if (dte === null) return 'OK';
  if (dte <= 21) return 'ALERT';
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

/** CLOSE / PROFIT / WATCH pill from an alert, or null when no action. */
function ActionBadge({ alert }: { alert: PositionAlert }) {
  if (alert.level === 'NONE') return null;
  const { label, cls } =
    alert.level === 'WATCH'
      ? { label: 'WATCH', cls: 'bg-amber-950/40 text-amber-400 border-amber-900/50' }
      : alert.tone === 'positive'
        ? { label: 'PROFIT', cls: 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50' }
        : { label: 'CLOSE', cls: 'bg-red-950/40 text-red-400 border-red-900/50' };
  return (
    <span
      title={alert.reasons.join(' · ')}
      className={`ml-2 inline-block rounded border px-1.5 py-0.5 align-middle text-[9px] font-semibold tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}
/** ROLL / REVIEW / ROLL? pill from a position's roll verdict, or null when no signal.
 *  Reads verdict.status directly so the approaching state shows as "ROLL?" instead of a
 *  second "WATCH" that would collide with the DTE-watch pill in the same cell. */
function RollBadge({ verdict }: { verdict?: RollVerdict }) {
  if (!verdict) return null;
  const styles: Partial<Record<RollVerdict['status'], { label: string; cls: string }>> = {
    ROLL: { label: 'ROLL', cls: 'bg-amber-950/40 text-amber-400 border-amber-900/50' },
    BOTH_TESTED: { label: 'REVIEW', cls: 'bg-red-950/40 text-red-400 border-red-900/50' },
    WATCH: { label: 'ROLL?', cls: 'bg-slate-800/60 text-slate-400 border-slate-700/50' },
  };
  const s = styles[verdict.status];
  if (!s) return null; // NONE / NO_DATA → no badge (after-hours degrades to here)
  return (
    <span
      title={verdict.note}
      className={`ml-2 inline-block rounded border px-1.5 py-0.5 align-middle text-[9px] font-semibold tracking-wider ${s.cls}`}
    >
      {s.label}
    </span>
  );
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
              const alert = alertFor(p);
              return (
                <tr key={`${p.underlying}-${p.expiration}-${i}`} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="font-[family-name:var(--font-display)] text-base font-semibold text-slate-100">
                      {p.underlying}
                    </span>
                    {p.quantity > 1 && <span className="ml-1 font-mono text-[10px] text-slate-500">×{p.quantity}</span>}
                    <ActionBadge alert={alert} />
                    <RollBadge verdict={p.rollVerdict} />
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

function AlertBanner({ positions }: { positions: ReconstructedPosition[] }) {
  const { action, watch } = summarizeAlerts(positions);

  const verdicts = positions
    .map((p) => p.rollVerdict)
    .filter((v): v is RollVerdict => Boolean(v));
  const rollCount = summarizeRollAlerts(verdicts).length;
  const reviewCount = verdicts.filter((v) => v.status === 'BOTH_TESTED').length;

  // Both-tested needs manual intervention → counts toward "needs action" (red).
  const actionTotal = action + reviewCount;

  if (actionTotal === 0 && rollCount === 0 && watch === 0) return null;

  const parts: string[] = [];
  if (actionTotal > 0) parts.push(`${actionTotal} need${actionTotal === 1 ? 's' : ''} action`);
  if (rollCount > 0) parts.push(`${rollCount} to roll`);
  if (watch > 0) parts.push(`${watch} to watch`);

  const urgent = actionTotal > 0;
  const cls = urgent
    ? 'border-red-900/50 bg-red-950/30 text-red-400'
    : 'border-amber-900/50 bg-amber-950/30 text-amber-400';

  return (
    <div className={`mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-mono ${cls}`}>
      <span className="shrink-0">{urgent ? '⛔' : '⚠'}</span>
      <span>{parts.join(' · ')} — see the badges below.</span>
    </div>
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
          <AlertBanner positions={positions} />
          <SpreadTable title="Iron Condors" positions={condors} />
          <SpreadTable title="Vertical Spreads" positions={verticals} />
          <OthersTable positions={others} />
        </>
      )}
    </div>
  );
}

export default PositionsMonitor;
