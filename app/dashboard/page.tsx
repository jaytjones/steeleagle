'use client'

// ============================================================
// SteelEagle — Dashboard
// Fetches settings, scanner, and positions; orchestrates the
// add / edit / remove flows that mutate user_settings.tickers.
// ============================================================

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import ScannerCard from '@/components/scanner/ScannerCard'
import AddCellButton from '@/components/scanner/AddCellButton'
import PendingCell from '@/components/scanner/PendingCell'
import PositionsMonitor from '@/components/positions/PositionsMonitor'
import ReauthBanner from '@/components/ReauthBanner'
import { setTickers } from './actions'
import type { ScannerResult } from '@/types'
import { BprChip } from '@/components/scanner/BprChip'
import { computeBprUtilization, type SchwabBalances } from '@/lib/strategy/bpr'
import type { ReconstructedPosition } from '@/lib/strategy/reconstruct-positions'
import type { UserSettings } from '@/lib/db/settings'
import { computeEntryGate } from '@/lib/strategy/entry-gate'
import EarningsSection from '@/components/earnings/EarningsSection'
import type {
  EarningsScannerCell,
  CrisisState,
  EarningsScanResponse,
} from '@/lib/earnings/scanner-types'

interface ScannerResponse {
  results: ScannerResult[]
  timestamp: string
}

interface AuthStatus {
  isAuthenticated: boolean
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  needsReauth: boolean
}

const MAX_CELLS = 10
const SKELETON_FALLBACK_COUNT = 3

export default function Dashboard() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [scanner, setScanner] = useState<ScannerResponse | null>(null)
  const [positions, setPositions] = useState<ReconstructedPosition[]>([])
  const [balances, setBalances] = useState<SchwabBalances | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [pendingAdd, setPendingAdd] = useState(false)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [positionsError, setPositionsError] = useState<string | null>(null)
  const [earnings, setEarnings] = useState<EarningsScannerCell[] | null>(null)
  const [earningsError, setEarningsError] = useState<string | null>(null)
  const [crisisManual, setCrisisManual] = useState(false)
  const [crisisInfo, setCrisisInfo] = useState<CrisisState | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    setPositionsError(null)
    try {
      const [setRes, scanRes, posRes, authRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/scanner'),
        fetch('/api/positions'),
        fetch('/api/auth/status'),
      ])
      // Capture auth status first — it drives the ReauthBanner and must be set
      // even if the scanner/settings calls below throw (an expired refresh token
      // makes those fail, which is exactly when we most need the banner).
      if (authRes.ok) {
        try {
          setAuthStatus((await authRes.json()) as AuthStatus)
        } catch {
          /* ignore malformed status payload */
        }
      }
      if (!setRes.ok) throw new Error(`Settings API returned ${setRes.status}`)
      if (!scanRes.ok) throw new Error(`Scanner API returned ${scanRes.status}`)
      const setData: UserSettings = await setRes.json()
      const scanData: ScannerResponse = await scanRes.json()
      // Positions failing is non-fatal to the rest of the dashboard, but it must
      // NOT masquerade as an empty account — surface the route's error message.
      let posData: { positions?: ReconstructedPosition[]; balances?: SchwabBalances | null } = {
        positions: [],
        balances: null,
      }
      if (posRes.ok) {
        posData = await posRes.json()
      } else {
        try {
          const errJson = await posRes.json()
          setPositionsError(errJson?.error ? String(errJson.error) : `Positions API returned ${posRes.status}`)
        } catch {
          setPositionsError(`Positions API returned ${posRes.status}`)
        }
      }
      setSettings(setData)
      setScanner(scanData)
      setPositions(posData.positions ?? [])
      setBalances(posData.balances ?? null)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Earnings scanner is fetched independently of the core dashboard data so the
  // crisis toggle can re-run just this section without re-scanning everything.
  const fetchEarnings = useCallback(async (crisis: boolean) => {
    try {
      const res = await fetch(`/api/earnings-scanner?crisis=${crisis}`)
      if (!res.ok) throw new Error(`Earnings API returned ${res.status}`)
      const data = (await res.json()) as EarningsScanResponse
      setEarnings(data.cells)
      setCrisisInfo(data.crisis ?? null)
      setEarningsError(data.accountError ?? null)
    } catch (err) {
      setEarningsError(err instanceof Error ? err.message : 'Failed to load earnings')
    }
  }, [])

  useEffect(() => {
    fetchEarnings(crisisManual)
  }, [fetchEarnings, crisisManual])

  const toggleCrisis = () => setCrisisManual((v) => !v)

  // --------------------------------------------------------
  // Mutation helpers — all go through `persistSettings`, which
  // does optimistic UI then re-runs the scanner against the
  // freshly-persisted ticker list.
  // --------------------------------------------------------

  const flashError = (msg: string) => {
    setError(msg)
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000)
  }

  const persistSettings = async (newTickers: string[]) => {
    if (!settings) return
    const previous = settings
    setSettings({ ...settings, tickers: newTickers }) // optimistic
    try {
      const updated = await setTickers(newTickers)
      setSettings(updated)
      // Refresh scanner with the new symbol set
      const scanRes = await fetch('/api/scanner')
      if (scanRes.ok) {
        const scanData: ScannerResponse = await scanRes.json()
        setScanner(scanData)
      }
    } catch (err) {
      setSettings(previous) // rollback
      flashError(err instanceof Error ? err.message : 'Failed to update settings')
    }
  }

  const handleAddCell = () => {
    if (settings && settings.tickers.length >= MAX_CELLS) return
    setPendingAdd(true)
  }

  const handleCommitNewCell = async (symbol: string) => {
    if (!settings) return
    if (settings.tickers.includes(symbol)) {
      flashError(`${symbol} is already in your list`)
      setPendingAdd(false)
      return
    }
    setPendingAdd(false)
    await persistSettings([...settings.tickers, symbol])
  }

  const handleCancelAdd = () => {
    setPendingAdd(false)
  }

  const handleEditCell = async (oldSymbol: string, newSymbol: string) => {
    if (!settings) return
    if (newSymbol === oldSymbol) return
    if (settings.tickers.includes(newSymbol)) {
      flashError(`${newSymbol} is already in your list`)
      return
    }
    const newTickers = settings.tickers.map((s) => (s === oldSymbol ? newSymbol : s))
    await persistSettings(newTickers)
  }

  const handleRemoveCell = async (symbol: string) => {
    if (!settings) return
    const newTickers = settings.tickers.filter((s) => s !== symbol)
    await persistSettings(newTickers)
  }

  // --------------------------------------------------------
  // Market status
  // --------------------------------------------------------

  const marketStatus = (() => {
    const now = new Date()
    const day = now.getUTCDay()
    const hour = now.getUTCHours()
    const minute = now.getUTCMinutes()
    const totalMins = hour * 60 + minute
    const isWeekday = day >= 1 && day <= 5
    const isMarketHours = totalMins >= 870 && totalMins < 1200
    if (!isWeekday) return { label: 'Weekend', color: 'text-slate-600' }
    if (isMarketHours) return { label: 'Market Open', color: 'text-emerald-500' }
    return { label: 'Market Closed', color: 'text-slate-500' }
  })()

  const visibleResults =
    scanner && settings
      ? scanner.results.filter((r) => settings.tickers.includes(r.symbol))
      : []
  const allCalibrating =
    visibleResults.length > 0 &&
    visibleResults.every((r) => r.ivRank.daysOfHistory < 20)
  const bprUtil = balances ? computeBprUtilization(positions, balances) : null
  const showAddButton =
    !!settings && !pendingAdd && settings.tickers.length < MAX_CELLS
  const addDisabled = !!settings && settings.tickers.length >= MAX_CELLS

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ── Top Bar ── */}
      <div className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 sm:gap-4">
            <span className="text-lg font-bold font-[family-name:var(--font-display)] tracking-wider">
              🦅 STEELEAGLE
            </span>
            <span className="text-slate-700 text-xs hidden sm:block">|</span>
            <span className="text-slate-500 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase hidden sm:block">
              Iron Condor Scanner
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
            {bprUtil && <BprChip utilization={bprUtil} />}
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${marketStatus.color.replace('text-', 'bg-')} inline-block`} />
              <span className={`${marketStatus.color} font-mono`}>{marketStatus.label}</span>
            </div>
            {lastRefresh && (
              <span className="text-slate-600 text-xs font-mono hidden sm:block">
                {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Link
              href="/journal"
              title="Trade journal"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors font-mono border bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-400"
            >
              📓 Journal
            </Link>
            <a
              href="/api/auth/login"
              title="Re-authenticate with Schwab (refresh token lasts 7 days)"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors font-mono border ${
                authStatus?.needsReauth
                  ? 'bg-amber-600/20 hover:bg-amber-600/30 border-amber-700/70 text-amber-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-400'
              }`}
            >
              ⮌ Reconnect
            </a>
            <button
              onClick={() => {
                fetchData()
                fetchEarnings(crisisManual)
              }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-md transition-colors font-mono border border-slate-700"
            >
              <span className={loading ? 'animate-spin inline-block' : ''}>↻</span>
              {loading ? 'Scanning...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {/* ── Reauth Banner ── */}
        {authStatus?.needsReauth && (
          <ReauthBanner refreshTokenExpiresAt={authStatus.refreshTokenExpiresAt} />
        )}

        {/* ── Error Banner ── */}
        {error && (
          <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-3 text-red-400 text-sm font-mono">
            {error}
          </div>
        )}

        {/* ── Calibration Banner ── */}
        {!loading && allCalibrating && (
          <div className="bg-amber-950/30 border border-amber-900/50 rounded-lg px-4 py-3 flex items-start gap-3">
            <span className="text-amber-500 text-sm mt-px shrink-0">⚡</span>
            <div>
              <p className="text-amber-400 text-sm font-semibold">IV Rank Calibrating</p>
              <p className="text-amber-700 text-xs font-mono mt-0.5">
                The daily cron job runs at 4:15 PM ET on market days. IV Rank will be available after 20 snapshots ({visibleResults[0]?.ivRank.daysOfHistory ?? 0} collected so far). Pass/fail status will reflect only non-IV filters until then.
              </p>
            </div>
          </div>
        )}

        {/* ── Scanner Grid ── */}
        {!scanner || !settings ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array(settings?.tickers.length ?? SKELETON_FALLBACK_COUNT)
              .fill(0)
              .map((_, i) => (
                <SkeletonCard key={i} />
              ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {settings.tickers.map((symbol) => {
              const result = scanner.results.find((r) => r.symbol === symbol)
              return result ? (
               <ScannerCard
                  key={symbol}
                  result={result}
                  onEdit={(newSymbol) => handleEditCell(symbol, newSymbol)}
                  onRemove={() => handleRemoveCell(symbol)}
                  entryGate={computeEntryGate({
                    positions,
                    bprUtil,
                    symbol,
                    passesFilter: !!result.condor?.passesFilter,
                    // condor.bpr is per-share; ×100 → per-contract dollars
                    prospectiveBprDollars: (result.condor?.bpr ?? 0) * 100,
                  })}
                />
              ) : (
                <SkeletonCard key={symbol} />
              )
            })}
            {pendingAdd && (
              <PendingCell
                onCommit={handleCommitNewCell}
                onCancel={handleCancelAdd}
              />
            )}
            {showAddButton && (
              <AddCellButton disabled={addDisabled} onClick={handleAddCell} />
            )}
          </div>
        )}

        {/* ── Positions ── */}
        {positionsError && (
          <div className="bg-red-950/40 border border-red-900/70 rounded-lg px-4 py-3 text-red-300 text-sm font-mono">
            Positions failed to load: {positionsError}
          </div>
        )}
        <PositionsMonitor positions={positions} loading={loading && !scanner} />

        {/* ── Tactical Earnings Sleeve ── */}
        <EarningsSection
          cells={earnings}
          loading={loading && !earnings}
          error={earningsError}
          crisisManual={crisisManual}
          crisisInfo={crisisInfo}
          onToggleCrisis={toggleCrisis}
        />
      </div>
    </main>
  )
}

// --------------------------------------------------------
// Skeleton card — used while scanner data is loading
// --------------------------------------------------------
function SkeletonCard() {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4 animate-pulse min-h-[400px]">
      <div className="h-8 w-20 bg-slate-800 rounded" />
      <div className="h-4 w-16 bg-slate-800 rounded" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-16 bg-slate-800 rounded-lg" />
        <div className="h-16 bg-slate-800 rounded-lg" />
      </div>
      <div className="space-y-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 bg-slate-800 rounded" />
        ))}
      </div>
    </div>
  )
}