import {
  idKey,
  memberFor,
  memberNameParts,
  type Directory,
} from "../workspace/directory";

// =============================================================================
// Reaction chip name folding (BF-A1 / #1884).
//
// The snapshot already carries who reacted (`ReactionMap` → member id arrays).
// `chipsFor` folds that list to a count for the glyph. This module folds the
// same list into one sentence for the chip tooltip / accessible name: who, in
// the order they arrived, with me first when I am in it.
//
// Unresolved ids (roster still loading, a member who has left) do not become a
// fake display name. Each one adds to 「외 N명」. The roster's two 김인턴 still
// go through `memberNameParts`, so the handle rides along when the name alone
// would collide.
// =============================================================================

/** How many people the sentence names before the rest become 「외 N명」. */
const NAMED_LIMIT = 3;

/** First-person token when the viewer is among the reactors. */
export const REACTION_SELF_LABEL = "나";

/**
 * Toggle direction when the viewer already reacted. Same words the chip used
 * to put in its accessible name; the tooltip parenthetical reuses them so hover
 * and the screen reader do not disagree about what a click will do.
 */
export const REACTION_REMOVE_HINT = "내 반응 취소";

/** Toggle direction when the viewer has not reacted. */
export const REACTION_ADD_HINT = "나도 반응하기";

function selfToken(): string {
  return `${REACTION_SELF_LABEL}(${REACTION_REMOVE_HINT})`;
}

function resolvedLabel(
  directory: Directory,
  memberId: string
): string | null {
  const member = memberFor(directory, memberId);
  if (!member || member.displayName.trim() === "") return null;
  const parts = memberNameParts(directory, memberId, "");
  if (parts.name.trim() === "") return null;
  return parts.handle ? `${parts.name} ${parts.handle}` : parts.name;
}

function joinNames(shown: string[], extra: number): string {
  if (shown.length === 0) return extra > 0 ? `외 ${extra}명` : "";
  const head = shown.join(", ");
  return extra > 0 ? `${head} 외 ${extra}명` : head;
}

/**
 * One sentence naming who reacted. `myMemberId` is optional: a signed-out
 * viewer has no 「나」, and an id that is in the list but not theirs is named
 * through the directory like anyone else.
 */
export function formatReactionNames(
  memberIds: readonly string[],
  directory: Directory,
  myMemberId?: string
): string {
  const mine = myMemberId ? idKey(myMemberId) : undefined;
  const seen = new Set<string>();
  const others: string[] = [];
  let self = false;
  let unresolved = 0;

  for (const raw of memberIds) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const id = idKey(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    if (mine !== undefined && id === mine) {
      self = true;
      continue;
    }
    const label = resolvedLabel(directory, id);
    if (label === null) unresolved += 1;
    else others.push(label);
  }

  const named: string[] = [];
  if (self) named.push(selfToken());
  named.push(...others);

  const extra = Math.max(0, named.length - NAMED_LIMIT) + unresolved;
  return joinNames(named.slice(0, NAMED_LIMIT), extra);
}

/**
 * Accessible name for a chip: count, the name sentence, and (when I have not
 * reacted) the add hint. The remove hint already sits on 「나」 when I have.
 */
export function reactionChipAccessibleName(
  emoji: string,
  count: number,
  names: string,
  mine: boolean
): string {
  const counted = `${emoji} 반응 ${count}개`;
  if (!names) {
    return mine
      ? `${counted}, ${REACTION_REMOVE_HINT}`
      : `${counted}, ${REACTION_ADD_HINT}`;
  }
  return mine
    ? `${counted}, ${names}`
    : `${counted}, ${names}, ${REACTION_ADD_HINT}`;
}
