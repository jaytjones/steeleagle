# SteelEagle — Day 1 Results

**Date:** May 15, 2026
**Status:** App deployed — blocked on Vercel environment variables

---

## Project Overview

**SteelEagle** is a personal iron condor scanning dashboard that monitors SPY, TLT, and GLD for high-probability options trade setups using the TOMIC (The Option Method Insurance Company) framework. Version 1.0 is a read-only scanner — trades are executed manually based on the dashboard's recommendations. Future versions will support automated execution with user permission.

---

## ✅ Completed in Day 1

### Strategy Foundation
- Reviewed **Iron Condor Strategy v1.0** (TOMIC framework)
- Confirmed core rules: ~16Δ shorts, ~5Δ longs, 30–45 DTE entry, 50% profit target, 21 DTE mechanical exit, IV Rank > 25% filter
- Trinity Portfolio confirmed: SPY (equities) / TLT (fixed income) / GLD (commodities)

### API Documentation Review
- Reviewed Schwab Trader API documentation (Accounts/Trading + Market Data)
- Confirmed required endpoints are available:
  - `/chains` — option chain with delta, IV, bid/ask per strike
  - `/expirationchain` — DTE filtering
  - `/quotes` — current underlying price
  - `/accounts/accountNumbers` — account hash discovery
  - `/accounts/{hash}` — positions and P&L
  - `/pricehistory` — for future use (not IV history)

### Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **MVP scope** | Read-only scanner/dashboard | Manual execution; auto-trade in future version |
| **Frontend framework** | React via Next.js + TypeScript + Tailwind | Single repo for frontend + backend |
| **Hosting** | Vercel (free tier) | Purpose-built for Next.js, free, HTTPS callback included |
| **Database** | Supabase Postgres (free tier) | Great for time-series IV data, no CC required |
| **Cron jobs** | Vercel Cron | Free, native to Next.js project |
| **Auth for services** | "Sign in with Google" on both Vercel + Supabase | Single identity, no new passwords |
| **IV Rank strategy** | Bootstrap rolling window via daily snapshots | API has no historical IV; we build our own |
| **Account number handling** | Auto-discover hashed value via API | User never pastes account number |
| **Order throttle limit** | 10 requests/min | 5× headroom over realistic peak (~2/min) |

### IV Rank Approach (Important Context)
The Schwab `/pricehistory` endpoint returns OHLC **price** data, not IV history. The `/chains` endpoint exposes *current* IV per option, but no rolling window. Our approach:

1. On every daily cron run, snapshot the ATM IV for SPY, TLT, and GLD into Supabase (`iv_history` table)
2. Display a "Calibrating — X days collected" indicator until ~20–30 days of history exists
3. Once sufficient history exists, compute IV Rank as: `(current_IV − 52w_low) / (52w_high − 52w_low) × 100`

---

## ✅ Completed in Session 2

### Built and Deployed
- Next.js 15 project scaffolded with TypeScript + Tailwind
- All folder structure and core files created:
  - `lib/supabase/client.ts` — Supabase server client
  - `lib/schwab/auth.ts` — token store/retrieve/refresh logic
  - `lib/schwab/client.ts` — Schwab API base fetch wrapper
  - `app/api/auth/login/route.ts` — OAuth Step 1
  - `app/api/auth/callback/route.ts` — OAuth Step 2 + account hash discovery
  - `app/api/cron/snapshot-iv/route.ts` — daily IV snapshot job
  - `app/page.tsx` — home/login page
  - `app/dashboard/page.tsx` — dashboard placeholder
  - `types/index.ts` — shared TypeScript types
  - `vercel.json` — cron schedule (4:15 PM ET weekdays)
- Supabase schema deployed (3 tables: `tokens`, `accounts`, `iv_history`)
- App live at `https://steeleagle.vercel.app`
- Schwab OAuth login flow tested — Schwab login succeeds ✅
- Supabase token write fails ❌ — blocked on env vars not saving in Vercel

### 🔴 First Thing Next Session
Vercel environment variables were not saving correctly through the UI.
Delete all existing variables and re-add them fresh one by one:

| Variable | Source |
|---|---|
| `SCHWAB_CLIENT_ID` | Schwab Dev Portal → SteelEagle app → "App Key" |
| `SCHWAB_CLIENT_SECRET` | Schwab Dev Portal → SteelEagle app → "Secret" |
| `SCHWAB_REDIRECT_URI` | `https://steeleagle.vercel.app/api/auth/callback` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |
| `CRON_SECRET` | Run `openssl rand -base64 32` in terminal |

After saving all six → Redeploy → test OAuth at `https://steeleagle.vercel.app/api/auth/login`

Success = green "Connected to Schwab" on home page + redirect to `/dashboard`

---

## 📋 Original Pre-Build Homework (All Complete)

### 1. Schwab Developer Portal — Create App
- [ ] Create a Schwab Developer Portal account at https://developer.schwab.com (separate from brokerage login)
- [ ] Submit the **Create App** form with these exact values:

| Field | Value |
|---|---|
| **Environment** | Production |
| **API Product** | Select **both**: "Accounts and Trading Production" **and** "Market Data Production" |
| **App Name** | `SteelEagle` |
| **App Description** | `Personal iron condor scanning dashboard` (optional) |
| **Callback URL** | `https://127.0.0.1` (we'll add the Vercel production URL later) |
| **Order Limit** | `10` |

> ⚠️ **Approval takes 2–3 business days.** Status will go from "Approved — Pending" → "Ready for Use." Submit this **first** so it processes while we build.

- [ ] Once approved, capture and securely save:
  - `client_id` (called "App Key" in the portal)
  - `client_secret` (called "Secret" in the portal)

### 2. Vercel Account Setup
- [ ] Sign up at https://vercel.com using "Continue with Google"
- [ ] (No project creation needed yet — we'll do that during the build)

### 3. Supabase Account Setup
- [ ] Sign up at https://supabase.com using "Continue with Google"
- [ ] Create a new project:
  - Name: `steeleagle`
  - Region: closest to Austin, TX (likely `us-east-1` or `us-west-1`)
  - Strong database password (save in password manager)
- [ ] Capture and save from Settings → API:
  - Project URL
  - `anon` public key
  - `service_role` secret key

### 4. GitHub Repo (Optional Prep)
- [ ] Create a private GitHub repo named `steeleagle` (we'll initialize it together, but having the repo ready saves a step)

---

## 🏗️ Next Session — Build Plan

When the user returns with Schwab approval + the four credentials (client_id, client_secret, Supabase URL, Supabase service_role key), the build sequence is:

### Phase 1: Foundation (Project Scaffold)
- [ ] Initialize Next.js 14+ project with TypeScript, Tailwind, ESLint, App Router
- [ ] Install dependencies: `@supabase/supabase-js`, `axios`, `zod`, `date-fns`
- [ ] Set up environment variables (`.env.local`)
- [ ] Configure folder structure: `app/`, `lib/schwab/`, `lib/supabase/`, `lib/strategy/`, `components/`

### Phase 2: Database Schema
- [ ] Create Supabase tables:
  - `tokens` — Schwab access/refresh tokens with expiration
  - `iv_history` — daily IV snapshots (symbol, date, atm_iv, underlying_price)
  - `accounts` — cached account hash from Schwab
- [ ] Enable Row Level Security (RLS) where appropriate
- [ ] Generate TypeScript types from schema

### Phase 3: OAuth Flow
- [ ] Build `/api/auth/login` route → redirects to Schwab CAG
- [ ] Build `/api/auth/callback` route → exchanges code for tokens, stores in Supabase
- [ ] Build `/api/auth/refresh` utility → auto-refreshes on 401 or before 30-min expiry
- [ ] Build token getter that handles refresh transparently
- [ ] Add 7-day refresh token re-auth UI prompt

### Phase 4: Schwab API Service Layer
- [ ] `schwab/quotes.ts` — get underlying price
- [ ] `schwab/chains.ts` — get option chain, filter by delta and DTE
- [ ] `schwab/accounts.ts` — discover hashed account number, fetch positions
- [ ] All wrapped with auto-refresh on 401

### Phase 5: Strategy Engine
- [ ] `strategy/iv-rank.ts` — compute IV Rank from `iv_history` table
- [ ] `strategy/condor-builder.ts` — given a symbol + expiration, find ~16Δ shorts and ~5Δ longs, compute credit and BPR
- [ ] `strategy/filters.ts` — apply IV Rank > 25%, credit ≥ 15% of wing width, etc.

### Phase 6: Scanner Dashboard UI
- [ ] Top-level scanner showing SPY / TLT / GLD with IV Rank, pass/fail badges
- [ ] Trade Setup Cards for each passing pillar (strikes, credit, wing width, breakeven)
- [ ] Positions Monitor (DTE, P&L vs 50% target, 21-DTE alert)
- [ ] Calibration banner if `iv_history` < 30 days

### Phase 7: Daily IV Snapshot Cron
- [ ] `/api/cron/snapshot-iv` route — pulls ATM IV for SPY/TLT/GLD, writes to `iv_history`
- [ ] Configure `vercel.json` cron schedule for 4:15 PM ET daily (post-market close)
- [ ] Add Vercel Cron secret for endpoint protection

### Phase 8: Deploy
- [ ] Push to GitHub
- [ ] Connect repo to Vercel
- [ ] Configure environment variables in Vercel dashboard
- [ ] Add production callback URL to Schwab App: `https://steeleagle.vercel.app/api/auth/callback`
- [ ] Test end-to-end OAuth flow in production
- [ ] Verify cron job runs

---

## 🔑 Reference: Key Technical Details

### Schwab OAuth Specifics
- **Token endpoint:** `https://api.schwabapi.com/v1/oauth/token`
- **Access token TTL:** 30 minutes
- **Refresh token TTL:** 7 days (requires full re-auth via CAG/LMS after expiry)
- **Authorization header format:** `Authorization: Bearer {access_token}`
- **Refresh request:** `grant_type=refresh_token`, Basic auth with `base64(client_id:client_secret)`

### Account Number Quirk
Schwab requires the **hashed** account number (not the raw number) for trading endpoints. Fetched via `GET /accounts/accountNumbers` after OAuth — store in `accounts` table.

### Base URLs
- Production: `https://api.schwabapi.com/trader/v1` (Accounts/Trading)
- Production: `https://api.schwabapi.com/marketdata/v1` (Market Data)

### Rate Limits
- Order requests (POST/PUT/DELETE): 10/min/account (our setting)
- Get requests: Unthrottled

---

## 📁 Project Knowledge Files
For continuity in future sessions, these files are in the project knowledge:
- `iron-condor-strategy-version-1.0.md` — Strategy spec
- `Trader_API_-_Individual___Products__Documentation.html` — Streaming/Market Data docs
- `Trader_API_-_Individual___Products___AcctsTradingProdDocumentation.html` — OAuth flow, order samples
- `Trader_API_-_Individual___Products___AcctsTradingProdSpecifications.html` — Accounts/Trading OpenAPI spec
- `Trader_API_-_Individual___Products___Charles_Schwab_Developer_Portal.html` — Market Data OpenAPI spec

---

## 🚦 Pick-Up Checklist for Next Session

When returning, paste the following to resume quickly:

```
Resuming SteelEagle build.

Schwab app status: [Approved / Still Pending]
Vercel signup: [Done / Not done]
Supabase project created: [Done / Not done]
GitHub repo created: [Done / Not done]

Credentials I have ready (do not paste them here):
- Schwab client_id: [yes/no]
- Schwab client_secret: [yes/no]
- Supabase project URL: [yes/no]
- Supabase service_role key: [yes/no]

Ready to start Phase 1 (project scaffold).
```

---

**End of Day 1 Results**
