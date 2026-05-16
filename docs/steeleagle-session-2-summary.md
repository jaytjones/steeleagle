# SteelEagle — Session 2 Summary

**Date:** May 16, 2026
**Status:** Dashboard live at https://steeleagle.vercel.app — IV Rank calibrating

---

## What Was Built This Session

### Infrastructure
- Next.js 15 project scaffolded, deployed to Vercel via GitHub
- Neon Postgres database (3 tables: `tokens`, `accounts`, `iv_history`)
- Schwab OAuth 3-legged flow — fully working end-to-end
- Account hash auto-discovered and cached after first login
- Daily IV snapshot cron configured (4:15 PM ET, weekdays)

### API Service Layer (`lib/schwab/`)
- `auth.ts` — token store, retrieve, auto-refresh (30-min access / 7-day refresh)
- `client.ts` — base fetch wrapper for Market Data and Trader APIs
- `chains.ts` — option chain fetcher, delta finder, leg builder (strikeCount: 200)
- `quotes.ts` — underlying price quotes
- `accounts.ts` — positions fetcher using hashed account number

### Strategy Engine (`lib/strategy/`)
- `iv-rank.ts` — rolling IV Rank from Neon history (min 20 days, up to 365)
- `condor-builder.ts` — builds symmetric iron condor with wing width logic (see below)
- `filters.ts` — IV Rank > 25%, credit/width ≥ 15%, credit > 0

### API Routes
- `GET /api/scanner` — full scan for SPY, TLT, GLD
- `GET /api/positions` — open option positions from Schwab account
- `GET /api/auth/login` — initiates Schwab OAuth
- `GET /api/auth/callback` — exchanges code for tokens, caches account hash
- `GET /api/cron/snapshot-iv` — daily IV snapshot (protected by CRON_SECRET)

### Dashboard UI
- Dark trading terminal aesthetic (IBM Plex Mono + Barlow Condensed)
- Sticky header with market open/closed indicator and refresh button
- 3-column scanner cards (SPY / TLT / GLD) with:
  - Current IV and IV Rank (or calibrating state)
  - PASS / CALIBRATING / FAIL / NO DATA status badge
  - 4-leg trade setup (LP / SP / SC / LC with strike, delta, mark, action)
  - Credit, wing width, credit/width ratio, BPR/max loss
  - Filter failure reasons
- Positions monitor with empty state
- Calibration banner when IV history < 20 days

---

## Wing Width Logic (Updated End of Session)

**File:** `lib/strategy/condor-builder.ts`

**Rules:**
1. Short put and short call are always placed at the nearest ~16Δ strike — these never move
2. Ideal long put and long call are independently found at ~5Δ
3. Natural put wing width = short put strike − ideal long put strike
4. Natural call wing width = ideal long call strike − short call strike
5. **The narrower wing is the limiting factor** → `targetWidth = min(putWidth, callWidth)`
6. Long strikes are snapped to the nearest available strike at `short ± targetWidth`
7. Result: symmetric wings with short legs preserved at 16Δ

**Example (SPY tonight):**
- Short put $695 (-16Δ), ideal long put $645 (-5Δ) → put wing = $50
- Short call $769 (+16Δ), ideal long call $787 (+5Δ) → call wing = $18
- Call wing is limiting → **target width = $18**
- Final: Long put snaps to $677 (higher than 5Δ, acceptable), Long call stays $787
- Result: symmetric $18 wings on both sides ✓

---

## Known Issues / Next Session

### 🔴 Must Fix
- Deploy updated `condor-builder.ts` with symmetric wing width logic (written, not yet pushed)
- Delete `app/api/debug/route.ts` (diagnostic file, no longer needed)

### 🟡 To Verify Monday (Market Hours)
- `currentIv` populates correctly (Schwab returns 0 after hours)
- SPY condor long put reaches true 5Δ strike with strikeCount: 200
- Wing symmetry displays correctly in dashboard

### 🟢 Calibration Timeline
- Cron runs at 4:15 PM ET every market day
- IV Rank available after 20 snapshots (~4 weeks from first deploy)
- Full 52-week accuracy after ~252 trading days

---

## Environment Variables

| Variable | Source |
|---|---|
| `SCHWAB_CLIENT_ID` | Schwab Dev Portal → SteelEagle → App Key |
| `SCHWAB_CLIENT_SECRET` | Schwab Dev Portal → SteelEagle → Secret |
| `SCHWAB_REDIRECT_URI` | `https://steeleagle.vercel.app/api/auth/callback` |
| `NEXT_PUBLIC_SUPABASE_URL` | *(unused — migrated to Neon)* |
| `SUPABASE_SERVICE_ROLE_KEY` | *(unused — migrated to Neon)* |
| `CRON_SECRET` | Generated via `openssl rand -base64 32` |
| `POSTGRES_URL` | Auto-injected by Vercel Neon integration |

> Note: `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` can be removed from Vercel env vars — they are no longer used after the Neon migration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend + Backend | Next.js 15, TypeScript, Tailwind CSS |
| Database | Neon Postgres (via Vercel integration) |
| Hosting | Vercel (auto-deploys on `git push`) |
| Auth | Schwab OAuth 2.0 (3-legged Authorization Code flow) |
| Cron | Vercel Cron (2 jobs free tier) |
| Fonts | IBM Plex Mono + Barlow Condensed (Google Fonts) |
| Source control | GitHub (private repo) |

---

## Future Versions

### v1.1 (Near Term)
- Positions monitor with DTE countdown, P&L vs 50% target, 21-DTE alert
- Roll alert when short delta is tested
- Manual re-auth prompt when refresh token expires (7-day cycle)

### v2.0 (Execution)
- Display full condor order, user confirms, app places the trade via Schwab Orders API
- Order status tracking

### v3.0 (Mobile)
- Native iOS/Android app

---

## Pick-Up Checklist

```
Resuming SteelEagle.

Last session: May 16, 2026
Dashboard: https://steeleagle.vercel.app
Repo: github.com/YOUR_USERNAME/steeleagle

Immediate tasks:
1. Push condor-builder.ts (symmetric wing width fix — written, not deployed)
2. Delete app/api/debug/route.ts
3. Verify scanner on Monday during market hours

IV Rank status: 0/20 days collected
First cron snapshot: Monday May 18, 4:15 PM ET
```
