// =============================================================================
// A syntactic @mention token, shared by send-time routing and message markdown.
//
// The composer inserts roster handles, but completed text still needs one
// grammar at every consumer. Keeping that grammar here prevents the send path
// from calling `@hermes` while the timeline leaves the same bytes unstyled (or
// the reverse). Directory membership is deliberately absent: this module says
// only what a token looks like. Each consumer decides whether that handle names
// somebody it is allowed to act on or render as a mention.
// =============================================================================

const HANDLE_AT_START = /^[A-Za-z0-9_.-]+/;

export interface MentionToken {
  /** Case-folded identity used for directory matching. */
  handle: string;
  /** The author's exact bytes, including `@`. */
  raw: string;
  /** First source index after this token. */
  end: number;
}

/**
 * The mention beginning at `at`, or null when `@` is ordinary text.
 *
 * A token opens only at the start of the text or after whitespace, matching the
 * composer and keeping `person@example.com` out. There is no trailing-boundary
 * requirement: Korean particles attach directly (`@hermes에게`), and the first
 * non-handle character belongs to the surrounding sentence.
 */
export function mentionTokenAt(source: string, at: number): MentionToken | null {
  if (source[at] !== "@") return null;
  if (at > 0 && !/\s/u.test(source[at - 1])) return null;
  const match = HANDLE_AT_START.exec(source.slice(at + 1));
  if (match === null) return null;
  const raw = `@${match[0]}`;
  return {
    handle: match[0].toLowerCase(),
    raw,
    end: at + raw.length,
  };
}
