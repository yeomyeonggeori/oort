// =============================================================================
// Copy-action labels shared by web and phone (UX-D3 / #1755).
//
// The words live here for the same reason `QUOTE_ACTION_LABEL` and
// `pinActionLabel` do: a label written twice is a label that drifts. The
// phone sheet already said 「메시지 복사하기」; the web menu had said
// 「메시지 복사」. Verb phrases, matching the six siblings in the menu
// (답글 달기 · 인용해서 답하기 · 고정하기 · 고치기 · 지우기).
// =============================================================================

/** Idle label: put the message body on the clipboard. */
export const COPY_MESSAGE_ACTION_LABEL = "메시지 복사하기";

/** Receipt after the body landed on the clipboard. */
export const COPY_MESSAGE_DONE_LABEL = "메시지 복사됨";

/** Idle label: put a paste-anywhere link on the clipboard. */
export const COPY_LINK_ACTION_LABEL = "링크 복사하기";

/** Receipt after the link landed on the clipboard. */
export const COPY_LINK_DONE_LABEL = "링크 복사됨";

export function copyMessageActionLabel(copied: boolean): string {
  return copied ? COPY_MESSAGE_DONE_LABEL : COPY_MESSAGE_ACTION_LABEL;
}

export function copyLinkActionLabel(copied: boolean): string {
  return copied ? COPY_LINK_DONE_LABEL : COPY_LINK_ACTION_LABEL;
}
