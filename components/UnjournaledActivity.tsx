// ============================================================
// SteelEagle — Unjournaled Activity (v2.11)
//
// The delivery half of the fill ledger. Detection was never the problem —
// GLD's exit GTC was REJECTED by Schwab every night from Aug 3 to Aug 13 2026
// on strikes rolled away twice, and every rejection was recorded and seen by
// nobody. This is the surface that ends that.
//
// THREE STATES, NEVER COLLAPSED (the v2.6.1 rule, as SweepBanner applies it):
//
//   items      amber   recent fills that need journaling or review
//   clean      dim     ran, found nothing, and SAYS SO
//   error      red     the check could not run — NOT an empty inbox
//
// The dim "clean" line carries as much weight as the amber one. A panel that
// renders nothing when healthy is indistinguishable from a panel that is
// broken, and that specific confusion is what v2.9 and this both exist to end.
//
// The list is bounded to ACTIONABLE_WINDOW_DAYS of activity. Older fills stay
// in the ledger as forensics but are never shown as work — an inbox listing
// resolved history is wallpaper, and it buries whatever is current.
// ============================================================

export interface UnjournaledLeg {
  action: 'open' | 'close'
  role: string
  strike: number
  price: number | null
}

export interface UnjournaledItem {
  orderId: string
  verdict: string
  detail: string
  tradeId: string | null
  underlying: string | null
  expiration: string | null
  occurredAt: string | null
  status: string
  contracts: number
  netPrice: number | null
  orderType: string | null
  legs: UnjournaledLeg[]
}

export interface UnjournaledActivityProps {
  items: UnjournaledItem[] | null
  /** Set when the check itself failed. Rendered red — never as an empty inbox. */
  error?: string | null
  windowDays: number
  ledgerSize?: number
}

/** April is in US Central. Every wall-clock time in this app is CT. */
function formatCt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const VERDICT_LABEL: Record<string, string> = {
  UNJOURNALED_ROLL: 'ROLL',
  UNJOURNALED_CLOSE: 'CLOSE',
  UNJOURNALED_OPEN: 'ENTRY',
  REJECTED_PLACEMENT: 'REJECTED',
  NEEDS_REVIEW: 'REVIEW',
}

const ROLE_LABEL: Record<string, string> = {
  long_put: 'LP',
  short_put: 'SP',
  short_call: 'SC',
  long_call: 'LC',
}

function LegLine({ legs }: { legs: UnjournaledLeg[] }) {
  if (legs.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400">
      {legs.map((l, i) => (
        <span key={i}>
          <span className={l.action === 'close' ? 'text-rose-400' : 'text-emerald-400'}>
            {l.action === 'close' ? 'BTC/STC' : 'STO/BTO'}
          </span>{' '}
          {ROLE_LABEL[l.role] ?? l.role} {l.strike}
          {l.price !== null && <span className="text-slate-500"> @{l.price.toFixed(2)}</span>}
        </span>
      ))}
    </div>
  )
}

export default function UnjournaledActivity({
  items,
  error,
  windowDays,
  ledgerSize,
}: UnjournaledActivityProps) {
  // ---- Error: explicitly red. An inbox that could not be built is NOT empty. ----
  if (error) {
    return (
      <section className="rounded-lg border border-rose-800 bg-rose-950/40 p-4">
        <h2 className="text-sm font-semibold text-rose-300">Unjournaled Activity — CHECK FAILED</h2>
        <p className="mt-1 text-xs text-rose-200/90">
          {error} — this is NOT an empty inbox. Recent fills were not compared against the journal
          this load.
        </p>
      </section>
    )
  }

  // ---- Clean: says so, out loud. ----
  if (items !== null && items.length === 0) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-semibold text-slate-400">Unjournaled Activity</h2>
        <p className="mt-1 text-xs text-slate-500">
          Clean — every fill in the last {windowDays} days is already in the journal
          {typeof ledgerSize === 'number' && ` (${ledgerSize} orders ledgered)`}.
        </p>
      </section>
    )
  }

  if (items === null) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-semibold text-slate-400">Unjournaled Activity</h2>
        <p className="mt-1 text-xs text-slate-500">Loading…</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-amber-300">
          Unjournaled Activity — {items.length} need{items.length === 1 ? 's' : ''} attention
        </h2>
        <span className="text-[11px] text-amber-200/60">last {windowDays} days</span>
      </div>

      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li
            key={item.orderId}
            className="rounded border border-amber-900/60 bg-slate-950/40 p-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="rounded bg-amber-900/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200">
                {VERDICT_LABEL[item.verdict] ?? item.verdict}
              </span>
              <span className="text-sm font-medium text-slate-200">
                {item.underlying ?? '—'} {item.expiration ?? ''}
              </span>
              {item.contracts > 0 && (
                <span className="text-xs text-slate-400">×{item.contracts}</span>
              )}
              {item.netPrice !== null && (
                <span className="font-mono text-xs text-slate-400">
                  {item.orderType === 'NET_DEBIT' ? '−' : '+'}
                  {item.netPrice.toFixed(2)}
                </span>
              )}
              <span className="ml-auto text-[11px] text-slate-500">
                {item.occurredAt ? formatCt(item.occurredAt) : '—'}
              </span>
            </div>

            <LegLine legs={item.legs} />

            <p className="mt-2 text-xs leading-relaxed text-slate-400">{item.detail}</p>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
              <a
                href="/journal"
                className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500 hover:text-slate-100"
              >
                Open journal
              </a>
              <span className="font-mono text-slate-600">order {item.orderId}</span>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] leading-relaxed text-amber-200/50">
        Read-only. Nothing here changes what the sweep places — reconciliation flags, it does not
        block. Journal these in the app; the next cron run will re-check.
      </p>
    </section>
  )
}
