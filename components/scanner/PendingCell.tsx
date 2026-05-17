'use client'

import { useState, useEffect, useRef } from 'react'

interface PendingCellProps {
  onCommit: (symbol: string) => void
  onCancel: () => void
}

export default function PendingCell({ onCommit, onCancel }: PendingCellProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const ticker = value.trim().toUpperCase()
      if (!ticker) {
        setError('Enter a ticker symbol')
        return
      }
      if (!/^[A-Z]+$/.test(ticker) || ticker.length > 5) {
        setError('Invalid ticker — alphabetic, max 5 chars')
        return
      }
      onCommit(ticker)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="bg-slate-900 border border-dashed border-emerald-900/60 rounded-xl p-5 flex flex-col gap-3 min-h-[400px]">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase())
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          placeholder="TICKER"
          maxLength={5}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-2xl font-bold tracking-tight font-[family-name:var(--font-display)] w-32 uppercase text-white placeholder:text-slate-600 outline-none focus:border-emerald-700"
        />
        <button
          onClick={onCancel}
          className="text-slate-500 hover:text-slate-300 text-2xl px-2 leading-none"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center text-center px-4 space-y-3">
        {error ? (
          <p className="text-red-400 text-sm font-mono">{error}</p>
        ) : (
          <>
            <p className="text-slate-500 text-sm font-mono">New cell</p>
            <p className="text-slate-600 text-xs font-mono">
              <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 text-[10px]">
                Enter
              </kbd>{' '}
              to add
              <span className="mx-1.5">·</span>
              <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 text-[10px]">
                Esc
              </kbd>{' '}
              to cancel
            </p>
          </>
        )}
      </div>
    </div>
  )
}