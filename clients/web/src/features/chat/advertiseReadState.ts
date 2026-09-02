import {
  updateReadState,
  type ReadState,
  type UpdateReadStateOptions,
} from "@momo/core/lib/api";

// =============================================================================
// Read-state advertisement helper (ADR-0178 D6 / #1934).
//
// Every product PUT /read-state goes through {@link advertiseReadState}. The
// HTTP function (`updateReadState`) does not choose intent.
//
// Classification of call sites:
//
// 1. ChatShell — first PUT after the open channel id changes (mount or
//    switch): reason `channel_open` → `read_intent: "explicit_open"`.
//    This is D4/D6 "명시 열람". The same tx clears a mark on the server.
//
// 2. ChatShell — later PUTs while that channel stays open (message arrival,
//    coalesced flush): reason `arrival_flush` → omit `read_intent`
//    (background). A mark must survive; this is the path that used to be
//    indistinguishable from (1) and would have silently erased it.
//
// 3. channelActions 「읽음 처리」 (sidebar row / header, BT-1): reason
//    `mark_read_menu` → `read_intent: "explicit_open"`. Explicit user
//    action, same discriminator as opening the channel.
//
// 4. useInbox `useMarkRead` (mention cursor advance): reason
//    `inbox_mention` → omit `read_intent`. The user marked one mention
//    read; that is not opening the channel. Safety default keeps a mark.
//
// 5. Message ⋯ 「여기부터 안 읽음」: reason `mark_unread` → omit
//    `read_intent` and send `mark_unread_before_seq`. explicit_open on this
//    request would delete the mark in the same transaction that set it.
//
// Never send `read_intent: "background"` as a string. Absence is the wire
// form. Default-on-the-server is background, which is the safety direction.
// =============================================================================

export type ReadAdvertisementReason =
  | "channel_open"
  | "arrival_flush"
  | "mark_read_menu"
  | "inbox_mention"
  | "mark_unread";

export function readIntentWire(
  reason: ReadAdvertisementReason
): UpdateReadStateOptions["readIntent"] {
  if (reason === "channel_open" || reason === "mark_read_menu") {
    return "explicit_open";
  }
  return undefined;
}

export function channelReadAdvertisementReason(
  previousChannelId: string | null,
  channelId: string
): Extract<ReadAdvertisementReason, "channel_open" | "arrival_flush"> {
  if (
    previousChannelId === null ||
    previousChannelId.toLowerCase() !== channelId.toLowerCase()
  ) {
    return "channel_open";
  }
  return "arrival_flush";
}

/** PUT 성공 뒤에만 광고된 채널 id 를 고정한다. 실패면 다음도 명시 열람. */
export function nextAdvertisedChannelId(
  previous: string | null,
  channelId: string,
  putSucceeded: boolean
): string | null {
  return putSucceeded ? channelId : previous;
}

export function advertiseReadState(
  workspaceId: string,
  channelId: string,
  lastReadSeq: number,
  reason: ReadAdvertisementReason,
  extra?: { markUnreadBeforeSeq?: number }
): Promise<ReadState> {
  return updateReadState(workspaceId, channelId, lastReadSeq, {
    readIntent: readIntentWire(reason),
    markUnreadBeforeSeq: extra?.markUnreadBeforeSeq,
  });
}
