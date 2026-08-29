import type { Channel, RosterMember } from "@momo/core/lib/api";
import { normalizeChannelTopic } from "@momo/core/features/channels/model";
import {
  emptyChannelCopy,
  EMPTY_ADD_MEMBER_ACTION_LABEL,
  EMPTY_WRITE_ACTION_LABEL,
} from "@momo/core/features/timeline/model";

// =============================================================================
// Channel intro as a virtualized leading row (#1904 / BF-A8).
//
// Buzz desktop ChannelIntroBlock (Apache-2.0) is the grammar: the same block is
// the empty-channel surface AND the first row of the message list, so the first
// message lands below it without a remount or a height change. This file holds
// the copy and the show/hide rules. The React node lives next door.
// =============================================================================

export const CHANNEL_INTRO_ITEM_KEY = "channel-intro";

export type ChannelIntroIcon = "hash" | "lock" | "dm";

export interface ChannelIntroActionView {
  kind: "write" | "add-member";
  label: string;
}

export interface ChannelIntroView {
  surface: "channel" | "dm";
  icon: ChannelIntroIcon;
  title: string;
  body: string;
  meta: string | null;
  actions: ChannelIntroActionView[];
}

export interface ChannelIntroItem {
  kind: "intro";
  key: typeof CHANNEL_INTRO_ITEM_KEY;
}

export const CHANNEL_INTRO_ITEM: ChannelIntroItem = {
  kind: "intro",
  key: CHANNEL_INTRO_ITEM_KEY,
};

/**
 * Ready channels show the intro at the start of loaded history.
 *
 * An empty channel is the start by definition. A channel with messages waits
 * until older pages are exhausted (`reachedStart`), matching buzz: the block
 * must not flash in the middle of a still-paginating window.
 */
export function shouldShowChannelIntro(input: {
  status: "loading" | "ready" | "error";
  reachedStart: boolean;
  messageCount: number;
}): boolean {
  if (input.status !== "ready") return false;
  return input.reachedStart || input.messageCount === 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Created-at / creator line. Omits itself when the client has neither fact. */
export function channelIntroMeta(
  createdAtMs: number | undefined,
  creatorName: string | undefined
): string | null {
  const name = creatorName?.trim() ?? "";
  const hasDate = createdAtMs !== undefined;
  const hasName = name !== "";
  if (!hasDate && !hasName) return null;
  if (hasDate) {
    const d = new Date(createdAtMs);
    const stamp = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
    return hasName
      ? `${name}님이 ${stamp}에 만들었습니다.`
      : `${stamp}에 만들어졌습니다.`;
  }
  return `${name}님이 만들었습니다.`;
}

export function buildChannelIntro(input: {
  kind: Channel["kind"] | undefined;
  name: string;
  topic?: string;
  peer: Pick<RosterMember, "displayName" | "kind"> | null;
  canAddMember: boolean;
  createdAtMs?: number;
  creatorName?: string;
}): ChannelIntroView {
  const copy = emptyChannelCopy(input.kind, input.peer);
  const write: ChannelIntroActionView = {
    kind: "write",
    label: EMPTY_WRITE_ACTION_LABEL,
  };
  if (copy.surface === "dm") {
    return {
      surface: "dm",
      icon: "dm",
      title: input.peer?.displayName ?? "다이렉트 메시지",
      body: copy.headline,
      meta: null,
      actions: [write],
    };
  }
  const topic = normalizeChannelTopic(input.topic ?? "");
  const rawName = input.name.trim() === "" ? "이 채널" : input.name.trim();
  const title = rawName.startsWith("#") ? rawName : `#${rawName}`;
  const actions: ChannelIntroActionView[] = [write];
  if (input.canAddMember) {
    actions.push({
      kind: "add-member",
      label: EMPTY_ADD_MEMBER_ACTION_LABEL,
    });
  }
  return {
    surface: "channel",
    icon: input.kind === "private" ? "lock" : "hash",
    title,
    body: topic === "" ? copy.detail : topic,
    meta: channelIntroMeta(input.createdAtMs, input.creatorName),
    actions,
  };
}
