// ============================================================
// SteelEagle — Session Auth (pre-v2.0 security layer)
//
// Single-operator password auth. A signed, HttpOnly session cookie
// gates every page, API route, and server action via middleware.ts.
//
// Why app-level instead of Vercel Deployment Protection: on the Hobby
// plan, Standard Protection leaves the PRODUCTION domain public —
// which is exactly the URL that matters. This layer protects prod
// regardless of Vercel plan, and covers server actions too.
//
// Edge-safe by design: middleware runs on the Edge runtime, where
// node:crypto is unavailable — all HMAC work uses Web Crypto
// (crypto.subtle), which exists in both Edge and Node runtimes.
//
// Env vars required (add to Vercel + .env.local):
//   APP_PASSWORD  — the login password (long & random; a passphrase)
//   AUTH_SECRET   — ≥32 random bytes hex (e.g. `openssl rand -hex 32`);
//                   signs the session cookie. Rotating it logs out
//                   all sessions.
// ============================================================

export const SESSION_COOKIE = 'se_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// --------------------------------------------------------
// Web Crypto HMAC helpers
// --------------------------------------------------------
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Constant-time-ish string comparison without node's timingSafeEqual
 * (unavailable on Edge). Both inputs are first HMAC'd with the auth
 * secret, so lengths are always equal and the XOR walk is over
 * fixed-length digests — the comparison leaks nothing about either
 * original value.
 */
export async function safeEqual(secret: string, a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmacHex(secret, a), hmacHex(secret, b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  return diff === 0
}

// --------------------------------------------------------
// Session token: "<expiresAtMs>.<hmac(expiresAtMs)>"
// --------------------------------------------------------
function authSecret(): string {
  const s = process.env.AUTH_SECRET
  if (!s || s.length < 32) {
    // Fail CLOSED: with no/weak secret, no session can verify.
    throw new Error('AUTH_SECRET missing or too short (need ≥32 chars) — sessions disabled')
  }
  return s
}

export async function createSessionToken(now: number = Date.now()): Promise<string> {
  const expiresAt = String(now + SESSION_TTL_MS)
  const sig = await hmacHex(authSecret(), expiresAt)
  return `${expiresAt}.${sig}`
}

export async function verifySessionToken(
  token: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expiresAt = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!/^\d{10,16}$/.test(expiresAt)) return false
  if (Number(expiresAt) < now) return false
  let expected: string
  try {
    expected = await hmacHex(authSecret(), expiresAt)
  } catch {
    return false // no AUTH_SECRET → fail closed
  }
  return safeEqual(authSecret(), sig, expected)
}
