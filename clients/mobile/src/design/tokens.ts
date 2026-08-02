// =============================================================================
// The v0 shell's visual constants.
//
// These are not a new palette. They are the values `ConnectScreen` already shipped
// with in goal RN-C2, lifted out of that one file so the four screens this batch
// adds cannot each invent a slightly different grey. Nothing here is a guess about
// what the product should look like — that conversation belongs with 성재 and the
// design-taste skills, neither of which has an RN dialect yet.
//
// Two values below are NOT taste, they are constraints, and they are the reason
// this file exists rather than a handful of inline hex strings:
//
//   TOUCH_TARGET   44. The iOS HIG minimum, and the number every row, tab and
//                  button in this batch is measured against. A 32px row looks
//                  right in a screenshot and is missed by a thumb.
//   SAFE_GUTTER    the horizontal padding every screen shares, so that nothing
//                  in this app can produce a horizontal scroll — a list whose
//                  rows are 16px inset on one side and 24px on the other is how
//                  that starts.
// =============================================================================

/** iOS HIG minimum tappable edge, in points. Not negotiable per-screen. */
export const TOUCH_TARGET = 44;

/** Shared horizontal inset. One number, so no two surfaces disagree. */
export const SAFE_GUTTER = 16;

export const color = {
  /** App background. */
  bg: '#0f1115',
  /** Raised surface: cards, rows, the tab bar. */
  surface: '#171a20',
  /** A pressed surface, one step up rather than a new hue. */
  surfacePressed: '#1e222a',
  /** Hairlines and field borders. */
  border: '#2a2f38',
  /** Primary body text. */
  text: '#f2f3f5',
  /** Secondary text: labels, timestamps, the second line of a row. */
  textMuted: '#9aa0a8',
  /** Third-rank text: hints under a settled state. */
  textFaint: '#6b7280',
  /** The one accent. Selection, links, the primary button. */
  accent: '#3b6fd4',
  accentPressed: '#325ab3',
  accentText: '#6fa8dc',
  /** Agent identity. Agents are members, and the product names them apart. */
  agent: '#b58bd6',
  /** Something needs a person: unread counts, pending approvals. */
  warn: '#d9a441',
  /** A refusal or a failure. Never used for "not provided yet". */
  danger: '#e0777d',
  dangerSurface: '#2a1c1f',
  dangerBorder: '#5a2f35',
  /** A settled success. */
  ok: '#93d3a8',
  okSurface: '#16241c',
  okBorder: '#2c4a38',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  pill: 999,
} as const;

/**
 * Type scale. Body is 16 because that is the size iOS stops zooming text fields
 * at, and a login form that zooms on focus is the first thing a person meets.
 */
export const font = {
  title: 26,
  heading: 18,
  body: 16,
  label: 13,
  meta: 12,
} as const;
