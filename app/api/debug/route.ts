// ============================================================
// SteelEagle — Temporary Supabase Diagnostic (v2)
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

  // Test 1: Can Vercel reach the public internet at all?
  let publicFetchResult: string
  try {
    const res = await fetch('https://api.ipify.org?format=json')
    const data = await res.json()
    publicFetchResult = `ok — Vercel IP: ${data.ip}`
  } catch (err) {
    publicFetchResult = `failed — ${err instanceof Error ? err.message : String(err)}`
  }

  // Test 2: Can Vercel reach the Supabase project URL?
  let supabaseFetchResult: string
  let supabaseFetchStatus: number | null = null
  try {
    const testUrl = `${url}/rest/v1/`
    const res = await fetch(testUrl, {
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
      },
    })
    supabaseFetchStatus = res.status
    supabaseFetchResult = `ok — HTTP ${res.status}`
  } catch (err) {
    supabaseFetchResult = `failed — ${err instanceof Error ? err.message : String(err)}`
  }

  return NextResponse.json({
    url_preview: urlPreview,
    url_length: url?.length ?? 0,
    key_length: key?.length ?? 0,
    test_public_internet: publicFetchResult,
    test_supabase: supabaseFetchResult,
    test_supabase_status: supabaseFetchStatus,
  })
}
