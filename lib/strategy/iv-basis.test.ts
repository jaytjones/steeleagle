/**
 * v2.6 — IV measurement basis.
 *
 * The write-side guard the v1.2 tech-spec risk table recorded as the mitigation
 * for "Schwab returns IV=0 outside market hours, corrupting iv_history" and
 * which was never actually implemented. Thirty zero rows across
 * SPY/QQQ/IWM/SLV/DIA/GLD/AAPL/TLT got in through the gap.
 *
 * Run with:  npx tsx --test lib/strategy/iv-basis.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  IV_BASIS_CURRENT,
  IV_BASIS_LEGACY,
  isSnapshotWorthStoring,
} from './iv-basis'

describe('isSnapshotWorthStoring', () => {
  it('accepts a real positive IV', () => {
    assert.equal(isSnapshotWorthStoring(14.5), true)
    assert.equal(isSnapshotWorthStoring(0.01), true)
  })

  /**
   * THE bug. `volatility ?? impliedVolatility ?? null` does not treat a
   * Schwab-returned 0 as absent, so the old `atmIv === null` check let zeros
   * straight through to the INSERT.
   */
  it('REFUSES zero — the exact value that contaminated iv_history', () => {
    assert.equal(isSnapshotWorthStoring(0), false)
  })

  it('refuses negatives and non-finite values', () => {
    assert.equal(isSnapshotWorthStoring(-1), false)
    assert.equal(isSnapshotWorthStoring(NaN), false)
    assert.equal(isSnapshotWorthStoring(Infinity), false)
  })

  it('refuses absent values', () => {
    assert.equal(isSnapshotWorthStoring(null), false)
    assert.equal(isSnapshotWorthStoring(undefined), false)
  })

  it('narrows the type so a stored value is always a number', () => {
    const v: number | null = 12.3 as number | null
    if (isSnapshotWorthStoring(v)) {
      // Compiles only because the predicate narrows — the INSERT can never
      // receive null.
      assert.equal(v.toFixed(1), '12.3')
    } else {
      assert.fail('expected 12.3 to be storable')
    }
  })
})

describe('basis constants', () => {
  it('the two bases are distinct', () => {
    // If these ever collide, legacy near-expiry rows silently re-enter the IV
    // Rank window and the whole migration is undone.
    assert.notEqual(IV_BASIS_CURRENT, IV_BASIS_LEGACY)
  })

  /**
   * Pinned deliberately: these strings are persisted in every row and are the
   * migration's DEFAULT. Changing one without a data migration orphans history
   * — every symbol would silently revert to CALIBRATING.
   */
  it('the stored values are pinned to what the migration writes', () => {
    assert.equal(IV_BASIS_LEGACY, 'legacy_front_expiry')
    assert.equal(IV_BASIS_CURRENT, 'atm_28_52dte')
  })
})
