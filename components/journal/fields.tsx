'use client'

// ============================================================
// SteelEagle — Trade Journal form primitives
// Small dark-theme inputs shared by the new-trade / roll / close forms.
// ============================================================

import type { ReactNode } from 'react'

const baseInput =
  'w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-emerald-700 disabled:opacity-50'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-slate-500 text-xs font-[family-name:var(--font-display)] tracking-wider uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${baseInput} ${props.className ?? ''}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${baseInput} ${props.className ?? ''}`} />
}
