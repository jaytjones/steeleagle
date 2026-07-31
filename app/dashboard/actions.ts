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

/**
 * Toggles the exit-sweep placement pause. When true, the post-close sweep
 * skips GTC placement (step c) ONLY — reconcile and 21-DTE alerts
 * always run, and standing GTCs at Schwab are untouched (they can
 * still fill while paused; reconcile journals those fills).
 *
 * Returns the updated settings so the Client Component can sync
 * without an extra round-trip (same contract as setTickers).
 */
export async function setPauseExitPlacement(
  paused: boolean,
): Promise<UserSettings> {
  const updated = await updateUserSettings({ pauseExitPlacement: paused })
  revalidatePath('/dashboard')
  return updated
}