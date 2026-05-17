// ============================================================
// SteelEagle — Dashboard Server Actions
// Used by the Dashboard UI to mutate user settings.
// ============================================================

'use server'

import { revalidatePath } from 'next/cache'
import { updateUserSettings, type UserSettings } from '@/lib/db/settings'

/**
 * Replaces the dashboard's full ticker list.
 *
 * The UI computes the new array client-side (splice / filter / concat)
 * and submits the whole thing. We don't expose granular add/remove
 * endpoints — full-replacement keeps the contract simple and matches
 * the PATCH endpoint's shape.
 *
 * Throws on validation errors; the caller should catch and surface a
 * toast. Returns the updated settings so the Client Component can
 * sync its local state without an extra round-trip.
 */
export async function setTickers(tickers: string[]): Promise<UserSettings> {
  const updated = await updateUserSettings({ tickers })
  revalidatePath('/dashboard')
  return updated
}