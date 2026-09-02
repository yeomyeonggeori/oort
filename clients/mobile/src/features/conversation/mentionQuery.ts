import type {RosterMember} from '@momo/core/lib/api';

// =============================================================================
// The @mention token under the caret, and the members that match it.
//
// ## Why this is not imported from the core
//
// It is not there. `@momo/core/features/routing/mentionTargets` holds the
// SEND-time half of mentions — `mentionedHandles`, `mentionedAgents`,
// `mentionRoutingTarget` — which answers "who does this finished text call?".
// The COMPOSE-time half, "what is the person typing right now", lives in the
// web client, and a client may not import another client
// (`__tests__/projectShape.test.ts` enforces it).
//
// These rules started as a character-for-character port of that web code: a
// mid-word `@` is not a mention (`a@b` is an email, not a call), a space closes
// the token, and matching is over handle AND display name while the ACCEPTED
// value is always the handle.
//
// ## The two have SINCE DIVERGED — this file is no longer a copy (#1930 M-4)
//
// The web half moved out of `Composer.tsx` into one parser for three triggers
// (`clients/web/src/features/chat/composerAutocomplete.ts`,
// `composerTriggerQueryAt`), and that move changed behaviour this file does not
// have. Measured by design-review #1930:
//
//   · **After a failed anchor** the web parser keeps scanning backwards (an `@`
//     that is not at a word start is ordinary body text, so `@hermes:` keeps
//     the open mention query). This file stops at `lastIndexOf('@')` and
//     returns null.
//   · **Inside code formatting** (`` `…` `` and ``` fences) the web parser opens
//     nothing. This file has no such suppression — the phone has no format tray
//     (#1902) yet, so it never had the question.
//   · `MENTION_LIMIT` below is the web's old name. The web constant is now
//     `COMPOSER_CANDIDATE_LIMIT` and it is shared by `@`, `#` and `:`; the
//     phone has neither `#` nor `:`.
//
// Nothing here is a bug on this surface, and #1930 deliberately did NOT touch
// the phone. What the comment must not do is keep claiming the two are the same
// file: the next person reading "ported, character for character" would fix one
// side and believe both moved.
//
// **This is a core gap and it is reported as one in the PR.** Both halves of
// mention handling are pure string work over `RosterMember`, neither knows what
// a DOM or a TextInput is, and the second half being in a client is the reason
// it had to be copied to reach a third one. `momo-core` is frozen for this
// batch, so extracting it is a follow-up rather than a drive-by — and that
// extraction is now the only thing that can make the two agree again.
// =============================================================================

/** How many candidates the list offers. The web `COMPOSER_CANDIDATE_LIMIT`. */
const MENTION_LIMIT = 6;

export interface MentionQuery {
  /** Index of the '@' that opened the query. */
  start: number;
  text: string;
}

/** The active @mention token at the caret, or null when there is none. */
export function mentionQueryAt(
  value: string,
  caret: number,
): MentionQuery | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  // A mid-word `@` is not a mention: only the start of the text or whitespace
  // may precede it.
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const text = upto.slice(at + 1);
  if (/\s/.test(text)) return null;
  return {start: at, text};
}

/**
 * Active members whose handle or display name contains the query.
 *
 * Display name is matched but never inserted: the handle is what the server
 * routes on (`mentionedHandles` splits on `/(^|\s)@([A-Za-z0-9_.-]+)/g`), so
 * inserting a display name with a space in it would produce a mention that
 * looks right and calls nobody.
 */
export function matchMembers(
  members: RosterMember[],
  query: string,
  limit = MENTION_LIMIT,
): RosterMember[] {
  const needle = query.trim().toLowerCase();
  const active = members.filter(m => m.status === 'active');
  const matched = needle
    ? active.filter(
        m =>
          m.handle.toLowerCase().includes(needle) ||
          m.displayName.toLowerCase().includes(needle),
      )
    : active;
  return matched.slice(0, limit);
}

/**
 * Where the caret lands after an edit turned `prev` into `next`.
 *
 * Derived from the two strings rather than read from `onSelectionChange`,
 * because that event arrives on its own schedule: React Native delivers it
 * after the text change, and during Korean composition it can describe the
 * position from BEFORE the syllable folded. A mention list computed from that
 * stale caret offers candidates for a token the person already finished.
 *
 * The rule is "the caret sits at the end of what changed": everything the two
 * strings share as a SUFFIX is untouched tail, so the caret is at
 * `next.length - sharedSuffix`. That is exact for an insertion, for a deletion,
 * and for an IME replacing the composing tail (`안녕하` → `안녕핫` shares no
 * suffix, so the caret is at the end — which is where it is).
 *
 * The suffix scan stops at the common PREFIX boundary so that a repeated
 * character cannot be counted as both prefix and suffix (`aa` → `aaa`).
 */
export function caretAfterChange(prev: string, next: string): number {
  let prefix = 0;
  const max = Math.min(prev.length, next.length);
  while (prefix < max && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  return next.length - suffix;
}

/**
 * The text and caret position after accepting `handle` for `query`.
 *
 * Pure, and separated from the component for one reason: the composer's value
 * must be set SYNCHRONOUSLY (spike #837 gate 1 — one deferred tick severs the
 * iOS IME's composition and Korean jamo stop combining entirely). Keeping the
 * string arithmetic out here means the component's accept handler is a single
 * synchronous `setText(...)` with nothing between the keystroke and the value,
 * and the arithmetic itself is unit-tested instead of eyeballed.
 */
export function applyMention(
  value: string,
  query: MentionQuery,
  caret: number,
  handle: string,
): {text: string; caret: number} {
  const text = `${value.slice(0, query.start)}@${handle} ${value.slice(caret)}`;
  // `@` + handle + the trailing space.
  return {text, caret: query.start + handle.length + 2};
}
