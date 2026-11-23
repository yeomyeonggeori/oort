import type { LocaleService } from "../../i18n/context";
import type { PlainMessageKey } from "../../i18n/keys";
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

/** 내가 반응한 사람들 가운데 있을 때의 첫 사람 이름. 「나(내 반응 취소)」 — 칩이 누르면 무엇을 하는지도 함께 말한다. */
export const REACTION_SELF_TOKEN_KEY = "timeline.reaction.selfToken" satisfies PlainMessageKey;

type Format = LocaleService["formatMessage"];

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

function joinNames(formatMessage: Format, shown: string[], extra: number): string {
  const [a = "", b = "", c = ""] = shown;
  if (extra > 0) {
    switch (shown.length) {
      case 0:
        return formatMessage("timeline.reaction.namesExtra0", { extra });
      case 1:
        return formatMessage("timeline.reaction.namesExtra1", { a, extra });
      case 2:
        return formatMessage("timeline.reaction.namesExtra2", { a, b, extra });
      default:
        return formatMessage("timeline.reaction.namesExtra3", { a, b, c, extra });
    }
  }
  switch (shown.length) {
    case 0:
      return "";
    case 1:
      return formatMessage("timeline.reaction.names1", { a });
    case 2:
      return formatMessage("timeline.reaction.names2", { a, b });
    default:
      return formatMessage("timeline.reaction.names3", { a, b, c });
  }
}

/**
 * One sentence naming who reacted. `myMemberId` is optional: a signed-out
 * viewer has no 「나」, and an id that is in the list but not theirs is named
 * through the directory like anyone else.
 */
export function formatReactionNames(
  formatMessage: Format,
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
  if (self) named.push(formatMessage(REACTION_SELF_TOKEN_KEY));
  named.push(...others);

  const extra = Math.max(0, named.length - NAMED_LIMIT) + unresolved;
  return joinNames(formatMessage, named.slice(0, NAMED_LIMIT), extra);
}

/**
 * Accessible name for a chip: count, the name sentence, and (when I have not
 * reacted) the add hint. The remove hint already sits on 「나」 when I have.
 */
export function reactionChipAccessibleName(
  formatMessage: Format,
  emoji: string,
  count: number,
  names: string,
  mine: boolean
): string {
  if (!names) {
    return mine
      ? formatMessage("timeline.reaction.chipMineNoNames", { emoji, count })
      : formatMessage("timeline.reaction.chipOtherNoNames", { emoji, count });
  }
  return mine
    ? formatMessage("timeline.reaction.chipMine", { emoji, count, names })
    : formatMessage("timeline.reaction.chipOther", { emoji, count, names });
}
