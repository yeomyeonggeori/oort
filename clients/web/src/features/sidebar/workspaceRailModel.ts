// =============================================================================
// 워크스페이스 레일 타일의 표시 규칙 (검수 피드백 #4a-1).
//
// The rail draws the WORKSPACE, not the person. The bug this repairs was a
// prop the shell wired to `selfName` (the signed-in member's display name), so
// the current-workspace tile showed the reader's own initial. The fix reads
// the real name from the workspace the session is bound to (GET
// /v1/workspaces/{ws}, already fetched by 설정 > 워크스페이스), and this module
// is the pure half of that: given the workspace name query, decide the single
// glyph and the accessible name of the tile.
//
// It is a separate module for the same reason `openChannel` is: the decision is
// a data-in / string-out function this bundle can unit test without a DOM, and
// keeping it here means the "never draw a person in the workspace tile" rule is
// a checked-in test rather than a habit. The name is never a parameter here —
// the only inputs are the workspace query and the workspace id — so the old
// regression cannot be re-expressed through this function.
// =============================================================================

/** The one-letter fallback when neither the name nor the id yields a glyph. */
const FALLBACK_INITIAL = "W";

/**
 * The slice of the workspace-name query the rail actually reads. Deliberately
 * NOT a bare `string`: a bare string is exactly what let a person's name be
 * passed in, so the tile is fed the query result and its loading/error facts
 * instead.
 */
export interface WorkspaceNameState {
  /** The resolved workspace name, or undefined until it arrives. */
  name?: string;
  /** The name is still being fetched (first load, no cached answer). */
  isPending: boolean;
  /** The fetch failed; render an honest id-derived fallback, never a person. */
  isError: boolean;
}

export interface WorkspaceRailTile {
  /**
   * The single glyph in the tile, or null while the name is still loading. Null
   * is the point: a letter drawn before the name resolves would be guessed from
   * whatever string was nearest, which is the mistake that started as a
   * person's initial. No name yet means no letter, not a stand-in letter.
   */
  initial: string | null;
  /** Accessible name and tooltip for the tile. Always workspace-scoped. */
  label: string;
  /** The name is still resolving: the tile shows a placeholder, aria-busy. */
  loading: boolean;
}

/** First non-empty grapheme of a human string, upper-cased when Latin. */
function firstGlyph(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const [first] = Array.from(trimmed);
  return first ?? null;
}

/**
 * Decide the current-workspace tile from the name query and the id the session
 * is bound to.
 *
 *   - resolved to a name  -> that name's first glyph, name as the label
 *   - still loading       -> no glyph (placeholder), a workspace-scoped label
 *   - resolved empty/error-> the id's first glyph, a generic workspace label
 *
 * The error/empty fallback is derived from the workspace id, never from any
 * person: an id-derived letter is honest about being a stand-in, where a name
 * borrowed from the member row reads as a real (and wrong) workspace name.
 */
export function workspaceRailTile(
  query: WorkspaceNameState,
  workspaceId: string
): WorkspaceRailTile {
  const nameGlyph = query.name ? firstGlyph(query.name) : null;
  if (nameGlyph !== null && query.name) {
    return { initial: nameGlyph, label: query.name.trim(), loading: false };
  }
  if (query.isPending) {
    return { initial: null, label: "워크스페이스 불러오는 중", loading: true };
  }
  const idGlyph = firstGlyph(workspaceId);
  return {
    initial: (idGlyph ?? FALLBACK_INITIAL).toUpperCase(),
    label: "워크스페이스",
    loading: false,
  };
}
