'use client'

// ============================================================
// SteelEagle — /login
// The single door in front of everything (see middleware.ts).
// ============================================================

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = { error: null }

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState)

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <form
        action={formAction}
        className="w-full max-w-xs bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4"
      >
        <div>
          <div className="font-[family-name:var(--font-display)] tracking-widest uppercase text-slate-200 text-lg">
            SteelEagle
          </div>
          <div className="text-slate-600 text-xs font-mono mt-1">operator login</div>
        </div>

        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          placeholder="password"
          className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-800"
        />

        {state.error && (
          <div className="text-xs font-mono text-red-400">✗ {state.error}</div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded border border-sky-800 text-sky-400 hover:bg-sky-950/40 py-2 text-sm font-mono disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </main>
  )
}
