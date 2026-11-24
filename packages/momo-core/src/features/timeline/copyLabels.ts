// =============================================================================
// Copy-action labels shared by web and phone (UX-D3 / #1755).
//
// The words live here for the same reason `QUOTE_ACTION_LABEL` and
// `pinActionLabel` do: a label written twice is a label that drifts. The
// phone sheet already said 「메시지 복사하기」; the web menu had said
// 「메시지 복사」. Verb phrases, matching the six siblings in the menu
// (답글 달기 · 인용해서 답하기 · 고정하기 · 고치기 · 지우기).
// =============================================================================

import type { PlainMessageKey } from "../../i18n/keys";

/** Idle label: put the message body on the clipboard. */
export const COPY_MESSAGE_ACTION_KEY = "timeline.copy.messageAction" satisfies PlainMessageKey;

/** Receipt after the body landed on the clipboard. */
export const COPY_MESSAGE_DONE_KEY = "timeline.copy.messageDone" satisfies PlainMessageKey;

/** Idle label: put a paste-anywhere link on the clipboard. */
export const COPY_LINK_ACTION_KEY = "timeline.copy.linkAction" satisfies PlainMessageKey;

/**
 * Receipt after the link landed on the clipboard. The same words (「링크 복사됨」 / "Link copied") already
 * live in the phone link card's key, so this reads it instead of adding a second copy.
 */
export const COPY_LINK_DONE_KEY = "mobile.linkCard.copied" satisfies PlainMessageKey;

export function copyMessageActionKey(copied: boolean): PlainMessageKey {
  return copied ? COPY_MESSAGE_DONE_KEY : COPY_MESSAGE_ACTION_KEY;
}

export function copyLinkActionKey(copied: boolean): PlainMessageKey {
  return copied ? COPY_LINK_DONE_KEY : COPY_LINK_ACTION_KEY;
}
