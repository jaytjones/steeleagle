'use client'

// ============================================================
// SteelEagle — Dashboard
// Fetches settings, scanner, and positions; renders the full UI.
//
// settings.tickers is the source of truth for which cells exist.
// scanner.results provides the data per cell, looked up by symbol.
// In normal operation the two are always in sync (the scanner reads
// settings on the backend), but treating settings as canonical
// prepares for Step 5's optimistic mutation flows.
// ============================================================

import { useEffect, useState, useCallback } from 'react'
import ScannerCard from '@/components/scanner/ScannerCard'
import PositionsMonitor from '@/components/positions/PositionsMonitor'
import type { ScannerResult, OpenPosition } from '@/types'
import type { UserSettings } from '@/lib/db/settings'

interface ScannerResponse {
  results: ScannerResult[]
  timestamp: string
}

// Used before settings arrives on first load — matches the default
// SPY/TLT/GLD seed so the initial skeleton count is right out of the box.
const SKELETON_FALLBACK_COUNT = 3

export default function Dashboard() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [scanner, setScanner] = useState<ScannerResponse | null>(null)
  const [positions, setPositions] = useState<OpenPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [setRes, scanRes, posRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/scanner'),
        fetch('/api/positions'),
      ])

      if (!setRes.ok) throw new Error(`Settings API returned ${setRes.status}`)
      if (!scanRes.ok) throw new Error(`Scanner API returned ${scanRes.status}`)

      const setData: UserSettings = await setRes.json()
      const scanData: ScannerResponse = await scanRes.json()
      const posData = posRes.ok ? await posRes.json() : { positions: [] }

      setSettings(setData)
      setScanner(scanData)
      setPositions(posData.positions ?? [])
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

  const marketStatus = (() => {
    const now = new Date()
    const day = now.getUTCDay()
    const hour = now.getUTCHours()
    const minute = now.getUTCMinutes()
    const totalMins = hour * 60 + minute
    const isWeekday = day >= 1 && day <= 5
    const isMarketHours = totalMins >= 870 && totalMins < 1200 // 14:30–20:00 UTC = 9:30–16:00 ET
    if (!isWeekday) return { label: 'Weekend', color: 'text-slate-600' }
    if (isMarketHours) return { label: 'Market Open', color: 'text-emerald-500' }
    return { label: 'Market Closed', color: 'text-slate-500' }
  })()

  // Pre-compute calibration banner content from scanner.results.
  // Restrict to results whose symbols are actually in settings so
  // stale scanner data (e.g., a just-removed cell) doesn't skew it.
  const visibleResults =
    scanner && settings
      ? scanner.results.filter((r) => settings.tickers.includes(r.symbol))
      : []
  const allCalibrating =
    visibleResults.length > 0 &&
    visibleResults.every((r) => r.ivRank.daysOfHistory < 20)

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ── Top Bar ── */}
      <div className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold font-[family-name:var(--font-display)] tracking-wider">
              🦅 STEELEAGLE
            </span>
            <span className="text-slate-700 text-xs hidden sm:block">|</span>
            <span className="text-slate-500 text-xs font-[family-name:var(--font-display)] tracking-widest uppercase hidden sm:block">
              Iron Condor Scanner
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full ${marketStatus.color.replace(
                  'text-',
                  'bg-',
                )} inline-block`}
              />
              <span className={`${marketStatus.color} font-mono`}>
                {marketStatus.label}
              </span>
            </div>
            {lastRefresh && (
              <span className="text-slate-600 text-xs font-mono hidden sm:block">
                {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchData}
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
              <p className="text-amber-400 text-sm font-semibold">
                IV Rank Calibrating
              </p>
              <p className="text-amber-700 text-xs font-mono mt-0.5">
                The daily cron job runs at 4:15 PM ET on market days. IV Rank
                will be available after 20 snapshots (
                {visibleResults[0]?.ivRank.daysOfHistory ?? 0} collected so
                far). Pass/fail status will reflect only non-IV filters until
                then.
              </p>
            </div>
          </div>
        )}

        {/* ── Scanner Cards ── */}
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
                <ScannerCard key={symbol} result={result} />
              ) : (
                // Settings has a ticker the scanner didn't return for.
                // Rare: implies a mid-flight state between mutations.
                <SkeletonCard key={symbol} />
              )
            })}
          </div>
        )}

        {/* ── Positions ── */}
        <PositionsMonitor positions={positions} loading={loading && !scanner} />
      </div>
    </main>
  )
}

// --------------------------------------------------------
// Skeleton card — used while scanner data is loading
// --------------------------------------------------------

function SkeletonCard() {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4 animate-pulse">
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