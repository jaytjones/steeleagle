// ============================================================
// composeFillNotes — unit tests (v2.1)
// Run via: npx tsx --test "lib/**/*.test.ts"
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeFillNotes, NOTES_MAX, V2_FILL_NOTE } from './compose-fill-notes'

describe('composeFillNotes', () => {
  it('returns the plain v2.0 note when there is no override', () => {
    assert.equal(composeFillNotes(), V2_FILL_NOTE)
    assert.equal(composeFillNotes(null), V2_FILL_NOTE)
    assert.equal(composeFillNotes(undefined), V2_FILL_NOTE)
  })

  it('stamps the override with violations verbatim and the reason, then the base note', () => {
    const notes = composeFillNotes({
      reason: 'IWM position closing at open tomorrow; slot frees before this fill matters',
      violations: ['Max 5 concurrent positions reached'],
    })
    assert.equal(
      notes,
      'OVERRIDE — rules bypassed: Max 5 concurrent positions reached. ' +
        'Reason: IWM position closing at open tomorrow; slot frees before this fill matters. ' +
        '| ' +
        V2_FILL_NOTE,
    )
  })

  it('joins multiple violations with "; " in order', () => {
    const notes = composeFillNotes({
      reason: 'Deliberate concentration into vol spike, accepted risk',
      violations: [
        'Equity block already at max 2 positions',
        'Entering would exceed the 50% BPR cap',
      ],
    })
    assert.ok(
      notes.startsWith(
        'OVERRIDE — rules bypassed: Equity block already at max 2 positions; ' +
          'Entering would exceed the 50% BPR cap. Reason:',
      ),
    )
    assert.ok(notes.endsWith(V2_FILL_NOTE))
  })

  it('never produces a blank stamp from an empty or whitespace violations array', () => {
    for (const violations of [[], ['  ', '']]) {
      const notes = composeFillNotes({
        reason: 'A reason that is long enough to pass',
        violations,
      })
      assert.ok(notes.includes('rules bypassed: Entry gate BLOCKED.'))
    }
  })

  it('always returns ≤ NOTES_MAX characters (a fill must never be rejected on notes length)', () => {
    const notes = composeFillNotes({
      reason: 'x'.repeat(3000),
      violations: ['y'.repeat(500), 'z'.repeat(500)],
    })
    assert.ok(notes.length <= NOTES_MAX)
    assert.ok(notes.endsWith('…'))
    // The stamp prefix must survive truncation — that's the auditable part.
    assert.ok(notes.startsWith('OVERRIDE — rules bypassed:'))
  })
})
