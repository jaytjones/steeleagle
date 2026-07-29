// ============================================================
// SteelEagle — User Settings API
// GET   /api/settings  — fetch the current ticker list
// PATCH /api/settings  — replace the ticker list
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getUserSettings, updateUserSettings } from '@/lib/db/settings'

export async function GET() {
  try {
    const settings = await getUserSettings()
    return NextResponse.json(settings)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/settings error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (
    !body ||
    typeof body !== 'object' ||
    (!('tickers' in body) && !('pauseExitPlacement' in body))
  ) {
    return NextResponse.json(
      { error: 'Request body must include "tickers" and/or "pauseExitPlacement"' },
      { status: 400 },
    )
  }

  const raw = body as { tickers?: unknown; pauseExitPlacement?: unknown }

  let tickers: string[] | undefined
  if ('tickers' in raw) {
    if (
      !Array.isArray(raw.tickers) ||
      raw.tickers.some((t) => typeof t !== 'string')
    ) {
      return NextResponse.json(
        { error: '"tickers" must be an array of strings' },
        { status: 400 },
      )
    }
    tickers = raw.tickers as string[]
  }

  let pauseExitPlacement: boolean | undefined
  if ('pauseExitPlacement' in raw) {
    if (typeof raw.pauseExitPlacement !== 'boolean') {
      return NextResponse.json(
        { error: '"pauseExitPlacement" must be a boolean' },
        { status: 400 },
      )
    }
    pauseExitPlacement = raw.pauseExitPlacement
  }

  try {
    const settings = await updateUserSettings({ tickers, pauseExitPlacement })
    return NextResponse.json(settings)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Validation errors from normalizeTickers — surface as 400 to the caller
    const isValidation =
      message.startsWith('Invalid ticker') ||
      message.startsWith('At least one ticker') ||
      message.startsWith('Maximum')
    return NextResponse.json(
      { error: message },
      { status: isValidation ? 400 : 500 },
    )
  }
}