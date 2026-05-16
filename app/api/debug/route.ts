// ============================================================
// SteelEagle — Temporary Supabase Diagnostic
// GET /api/debug
// DELETE THIS FILE once Supabase connection is confirmed working
// ============================================================

import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  const urlPreview = url
    ? `${url.substring(0, 15)}...${url.substring(url.length - 12)}`
    : null

  const keyPreview = key
    ? `${key.substring(0, 10)}...${key.substring(key.length - 6)}`
    : null

  // Attempt a raw fetch directly to Supabase REST API
  let fetchResult: string
  let fetchStatus: number | null = null

  try {
    const testUrl = `${url}/rest/v1/tokens?select=id&limit=1`
    const response = await fetch(testUrl, {
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
      },
    })
    fetchStatus = response.status
    fetchResult = response.ok ? 'success' : `HTTP ${response.status}`
  } catch (err) {
    fetchResult = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({
    url_present: !!url,
    url_length: url?.length ?? 0,
    url_preview: urlPreview,
    key_present: !!key,
    key_length: key?.length ?? 0,
    key_preview: keyPreview,
    fetch_status: fetchStatus,
    fetch_result: fetchResult,
  })
}
