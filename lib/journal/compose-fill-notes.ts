// ============================================================
// SteelEagle — v2.1 fill-notes composition (pure)
//
// One place that owns the journal `notes` string written by
// recordFillAction. Two shapes:
//
//   no override → the standard v2.0 auto-journal note
//   override    → "OVERRIDE — rules bypassed: <violations>. Reason: <reason>. | <base>"
//
// The override stamp is the entire point of the logged-override
// feature (Session 11 decision: the journal record IS the product;
// six months of override outcomes is the only evidence that should
// ever change the rules). So this module:
//
//   - joins the entry-gate violations verbatim,
//   - never lets an empty violations array produce a blank stamp,
//   - truncates defensively to the NewTradeSchema notes cap (2000)
//     so a legitimate fill can NEVER be rejected by the journal
//     write after the money is already committed.
// ============================================================

/** Base note for every v2.0-path auto-journaled fill. */
export const V2_FILL_NOTE =
  'v2.0 placement — journaled automatically from the confirmed fill.'

/** Mirrors NewTradeSchema's `notes: z.string().trim().max(2000)`. */
export const NOTES_MAX = 2000

export interface OverrideMeta {
  /** Operator-typed justification (panel enforces ≥ 15 chars). */
  reason: string
  /** Entry-gate reasons, verbatim from `entryGate.reasons`. */
  violations: string[]
}

/**
 * Compose the journal notes for an auto-journaled fill.
 * Always returns a string of length ≤ NOTES_MAX.
 */
export function composeFillNotes(override?: OverrideMeta | null): string {
  if (!override) return V2_FILL_NOTE

  const violations =
    override.violations.length > 0
      ? override.violations.map((v) => v.trim()).filter(Boolean).join('; ')
      : ''
  const violationText = violations || 'Entry gate BLOCKED'

  const composed = `OVERRIDE — rules bypassed: ${violationText}. Reason: ${override.reason.trim()}. | ${V2_FILL_NOTE}`

  if (composed.length <= NOTES_MAX) return composed
  return composed.slice(0, NOTES_MAX - 1) + '…'
}
