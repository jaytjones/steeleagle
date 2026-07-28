// ============================================================
// SteelEagle — v2.4 Phase 0: index symbol probe (V1–V5, V8)
//
// Purpose (v2.4 spec §3): pin Schwab's ACTUAL symbol conventions
// for index options (XSP, SPX, NDX, RUT) before any app code is
// written. Never build from docs — the GOOD_TILL_CANCEL lesson.
//
//   V1: /chains symbol format ($SPX vs SPX vs $SPX.X)
//   V2: does one chain carry BOTH roots (SPX + SPXW)? how exposed?
//   V3: delta / mark / IV population vs ETF chains (after-hours
//       IV=0 behavior is ALSO an answer — note run time)
//   V4: /quotes on an index OPTION symbol (roll-alert path)
//   V5: /quotes underlying INDEX symbol (iv_history row)
//   V8: /expirationchain behavior for indices
//
// V6/V7 (positions payload, order payload) wait for the v2.4
// build's place-and-cancel fixture — NOT this script.
//
// Usage (locally, where .env.local has POSTGRES_URL etc.):
//   npx tsx --env-file=.env.local scripts/probe-index-symbols.ts
//
// READ-ONLY: market-data GETs only. No trader endpoints, no
// writes, no account identifiers in any response body — output
// is safe to paste in full.
// ============================================================

import { marketGet } from '../lib/schwab/client'

// --------------------------------------------------------
// Candidate formats per index. Errors are data: a 400 on a
// variant pins that the format is wrong, which is the point.
// --------------------------------------------------------
const INDICES = [
  { canonical: 'XSP', variants: ['$XSP', 'XSP', '$XSP.X'] },
  { canonical: 'SPX', variants: ['$SPX', 'SPX', '$SPX.X'] },
  { canonical: 'NDX', variants: ['$NDX', 'NDX', '$NDX.X'] },
  { canonical: 'RUT', variants: ['$RUT', 'RUT', '$RUT.X'] },
]

// ETF control: known-good shape to diff index results against (V3).
const CONTROL_SYMBOL = 'SPY'

const isRecord = (o: unknown): o is Record<string, unknown> =>
  typeof o === 'object' && o !== null

const hr = (label: string) => console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`)

// Same 28–52 DTE window the app's chain fetch uses.
const MS_PER_DAY = 24 * 60 * 60 * 1000
const fmt = (d: Date) => d.toISOString().slice(0, 10)
const today = new Date()
const fromDate = fmt(new Date(today.getTime() + 28 * MS_PER_DAY))
const toDate = fmt(new Date(today.getTime() + 52 * MS_PER_DAY))

// Fields we care about on a contract, if present. Everything else
// is noise for V1–V3; the raw sample at the end of each chain
// section preserves one full contract verbatim in case a field
// matters that this list doesn't anticipate.
const CONTRACT_FIELDS = [
  'symbol', 'description', 'exchangeName', 'settlementType',
  'expirationType', 'delta', 'mark', 'bid', 'ask', 'volatility',
  'multiplier', 'deliverableNote',
] as const

interface ChainProbeResult {
  variant: string
  ok: boolean
  optionSymbols: string[] // OCC-style symbols harvested for the V4 quote probe
}

// --------------------------------------------------------
// V1 / V2 / V3 — chains per variant
// --------------------------------------------------------
async function probeChain(variant: string): Promise<ChainProbeResult> {
  console.log(`\n--- /chains symbol="${variant}" ---`)
  try {
    const chain = await marketGet<Record<string, unknown>>('/chains', {
      symbol: variant,
      contractType: 'ALL',
      strikeCount: '4', // tiny — shape probe, not a data pull
      includeUnderlyingQuote: 'true',
      optionType: 'S',
      fromDate,
      toDate,
    })

    console.log(`status: ${chain.status}`)
    console.log(`echoed symbol: ${chain.symbol}`)
    console.log(`underlyingPrice: ${chain.underlyingPrice}`)
    const underlying = chain.underlying
    if (isRecord(underlying)) {
      console.log(
        `underlying quote block: symbol=${underlying.symbol} mark=${underlying.mark} last=${underlying.last}`,
      )
    } else {
      console.log(`underlying quote block: ${underlying === undefined ? 'ABSENT' : JSON.stringify(underlying)}`)
    }

    const optionSymbols: string[] = []

    for (const mapKey of ['callExpDateMap', 'putExpDateMap'] as const) {
      const expMap = chain[mapKey]
      if (!isRecord(expMap)) {
        console.log(`${mapKey}: ABSENT or empty`)
        continue
      }
      const expKeys = Object.keys(expMap)
      console.log(`${mapKey}: ${expKeys.length} expirations: ${expKeys.join(' | ')}`)

      // Harvest every contract; report distinct roots (V2) and a
      // field sample from the first contract per expiration (V3).
      const roots = new Set<string>()
      let printedSample = false
      let rawSample: Record<string, unknown> | null = null

      for (const expKey of expKeys) {
        const strikes = expMap[expKey]
        if (!isRecord(strikes)) continue
        for (const contracts of Object.values(strikes)) {
          if (!Array.isArray(contracts)) continue
          for (const c of contracts) {
            if (!isRecord(c)) continue
            const occ = typeof c.symbol === 'string' ? c.symbol : ''
            if (occ) {
              // OCC root = leading chars before the padded date block.
              roots.add(occ.slice(0, 6).trim())
              if (optionSymbols.length < 4) optionSymbols.push(occ)
            }
            if (!printedSample) {
              const sample: Record<string, unknown> = {}
              for (const f of CONTRACT_FIELDS) if (f in c) sample[f] = c[f]
              console.log(`  first-contract fields (${expKey}):`)
              console.log(`  ${JSON.stringify(sample)}`)
              printedSample = true
              rawSample = c
            }
          }
        }
      }
      console.log(`  DISTINCT ROOTS in ${mapKey}: [${[...roots].join(', ')}]`)
      if (rawSample) {
        console.log(`  RAW first contract (verbatim, ${mapKey}):`)
        console.log(`  ${JSON.stringify(rawSample)}`)
      }
    }

    return { variant, ok: true, optionSymbols }
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    return { variant, ok: false, optionSymbols: [] }
  }
}

// --------------------------------------------------------
// V5 — underlying index quote per variant
// --------------------------------------------------------
async function probeUnderlyingQuote(variant: string): Promise<void> {
  console.log(`\n--- /quotes symbols="${variant}" ---`)
  try {
    const data = await marketGet<Record<string, unknown>>('/quotes', {
      symbols: variant,
      fields: 'quote',
    })
    const keys = Object.keys(data)
    console.log(`response keys: [${keys.join(', ')}]`)
    for (const k of keys) {
      const entry = data[k]
      if (!isRecord(entry)) continue
      console.log(`  assetMainType=${entry.assetMainType}`)
      const quote = entry.quote
      if (isRecord(quote)) {
        console.log(
          `  quote: lastPrice=${quote.lastPrice} mark=${quote.mark} bid=${quote.bidPrice} ask=${quote.askPrice} closePrice=${quote.closePrice}`,
        )
      } else {
        console.log(`  quote block ABSENT`)
      }
    }
    if (keys.length === 0) console.log('  EMPTY response (no match, no error)')
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --------------------------------------------------------
// V4 — option quote via OCC symbols harvested from the chain
// (the roll-alert path: getOptionDeltas uses /quotes this way)
// --------------------------------------------------------
async function probeOptionQuote(canonical: string, occSymbols: string[]): Promise<void> {
  if (occSymbols.length === 0) {
    console.log(`\n--- /quotes option probe for ${canonical}: SKIPPED (no chain symbols harvested) ---`)
    return
  }
  const batch = occSymbols.slice(0, 2)
  console.log(`\n--- /quotes option symbols for ${canonical}: ${JSON.stringify(batch)} ---`)
  try {
    const data = await marketGet<Record<string, unknown>>('/quotes', {
      symbols: batch.join(','),
      fields: 'quote',
    })
    const keys = Object.keys(data)
    console.log(`response keys: [${keys.join(', ')}]`)
    for (const k of keys) {
      const entry = data[k]
      if (!isRecord(entry)) continue
      const quote = entry.quote
      if (isRecord(quote)) {
        console.log(
          `  ${k}: delta=${quote.delta} mark=${quote.mark} bid=${quote.bidPrice} ask=${quote.askPrice} volatility=${quote.volatility}`,
        )
      } else {
        console.log(`  ${k}: quote block ABSENT — entry keys: [${Object.keys(entry).join(', ')}]`)
      }
    }
    if (keys.length === 0) console.log('  EMPTY response — symbol format not accepted by /quotes')
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --------------------------------------------------------
// V8 — /expirationchain per variant
// --------------------------------------------------------
async function probeExpirationChain(variant: string): Promise<void> {
  console.log(`\n--- /expirationchain symbol="${variant}" ---`)
  try {
    const data = await marketGet<Record<string, unknown>>('/expirationchain', {
      symbol: variant,
    })
    const list = data.expirationList
    if (!Array.isArray(list)) {
      console.log(`expirationList ABSENT — raw keys: [${Object.keys(data).join(', ')}]`)
      return
    }
    console.log(`expirationList: ${list.length} entries. First 5 verbatim:`)
    for (const e of list.slice(0, 5)) console.log(`  ${JSON.stringify(e)}`)
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --------------------------------------------------------
// Main
// --------------------------------------------------------
async function main() {
  console.log(`SteelEagle v2.4 Phase 0 probe — run at ${new Date().toISOString()}`)
  console.log(
    `NOTE run time above: after-hours IV=0 / delta-null behavior is itself a V3 finding.`,
  )
  console.log(`Chain window: ${fromDate} → ${toDate} (app's 28–52 DTE)`)

  // Control first: known-good ETF shape to diff against.
  hr(`CONTROL — ${CONTROL_SYMBOL} (ETF baseline for V3 comparison)`)
  const control = await probeChain(CONTROL_SYMBOL)
  await probeOptionQuote(CONTROL_SYMBOL, control.optionSymbols)

  for (const idx of INDICES) {
    hr(`${idx.canonical} — V1/V2/V3 chains`)
    const results: ChainProbeResult[] = []
    for (const v of idx.variants) results.push(await probeChain(v))

    hr(`${idx.canonical} — V5 underlying quote`)
    for (const v of idx.variants) await probeUnderlyingQuote(v)

    hr(`${idx.canonical} — V4 option quote (roll-alert path)`)
    // Use symbols from the first variant whose chain succeeded.
    const winner = results.find((r) => r.ok && r.optionSymbols.length > 0)
    await probeOptionQuote(idx.canonical, winner?.optionSymbols ?? [])

    hr(`${idx.canonical} — V8 expirationchain`)
    for (const v of idx.variants) await probeExpirationChain(v)
  }

  hr('DONE — paste EVERYTHING above back into the session')
}

main().catch((err) => {
  console.error('Probe failed hard:', err)
  process.exit(1)
})
