// ============================================================
// SteelEagle — Login Action
// ============================================================

'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  createSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '@/lib/auth/session'

export interface LoginState {
  error: string | null
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get('password')
  const expected = process.env.APP_PASSWORD
  const secret = process.env.AUTH_SECRET

  if (!expected || !secret) {
    // Fail closed and say why — a misconfigured deploy should be loud.
    return { error: 'Server misconfigured: APP_PASSWORD / AUTH_SECRET not set.' }
  }

  const ok =
    typeof password === 'string' &&
    password.length > 0 &&
    (await safeEqual(secret, password, expected))

  if (!ok) {
    // Flat delay on failure — enough to make online brute force
    // impractical for a single-operator app without a rate-limit store.
    await new Promise((r) => setTimeout(r, 1500))
    return { error: 'Wrong password.' }
  }

  const store = await cookies()
  store.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
  redirect('/dashboard')
}
