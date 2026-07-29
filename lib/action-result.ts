// ============================================================
// SteelEagle — server-action error contract
//
// Next.js REDACTS thrown server-action error messages in production
// builds (the client receives a digest only). Every operator-critical
// message — Schwab rejection reasons, "CHECK THINKORSWIM", journaling
// refusals — must therefore travel as a RETURN VALUE, which is never
// redacted, with the full error logged server-side for Vercel.
//
// Extracted from app/dashboard/order-actions.ts in v2.2.1 so the journal's
// Close/Edit refusals reach April intact instead of as a digest. Lives in
// lib/ (not a 'use server' file) because a 'use server' module may only
// export async functions — toResult is a plain helper.
// ============================================================

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Wrap an action body: catch everything, log server-side, return the message. */
export async function toResult<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    console.error(`[${label}] failed:`, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
