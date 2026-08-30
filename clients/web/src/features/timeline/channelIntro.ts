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
// message lands below it without a remount. This file holds the copy and the
// show/hide rules. The React node lives next door.
//
// empty vs history: actions and "첫…" copy are the empty surface. A channel
// that already has messages only states facts the client has (name, topic, that
// this row is the start of history).
// =============================================================================

export const CHANNEL_INTRO_ITEM_KEY = "channel-intro";

/** Non-empty channel intro: the start of history, not an invitation to write. */
export const CHANNEL_INTRO_STARTED = "이 채널의 시작입니다.";

/** Non-empty DM intro: the start of this pair's history. */
export const DM_INTRO_STARTED = "이 대화의 시작입니다.";

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
  /** True when the title names an agent. Matches header/sidebar `--agent`. */
  isAgent: boolean;
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

function untitledChannelName(name: string): string {
  return name.trim() === "" ? "이름 없는 채널" : name.trim();
}

export function buildChannelIntro(input: {
  kind: Channel["kind"] | undefined;
  /** Header label: channel name, or DM `displayName` plus `@handle` when needed. */
  name: string;
  topic?: string;
  peer: Pick<RosterMember, "displayName" | "kind"> | null;
  canAddMember: boolean;
  /** Message count is 0. Actions and "첫…" copy only then. */
  empty: boolean;
}): ChannelIntroView {
  const copy = emptyChannelCopy(input.kind, input.peer);
  const write: ChannelIntroActionView = {
    kind: "write",
    label: EMPTY_WRITE_ACTION_LABEL,
  };
  if (copy.surface === "dm") {
    const named = input.name.trim();
    const title =
      named !== ""
        ? named
        : input.peer?.displayName?.trim() || "다이렉트 메시지";
    const body = input.empty
      ? `${copy.headline}\n\n${copy.detail}`
      : `${DM_INTRO_STARTED}\n\n${copy.detail}`;
    return {
      surface: "dm",
      icon: "dm",
      title,
      body,
      isAgent: input.peer?.kind === "agent",
      actions: input.empty ? [write] : [],
    };
  }
  const topic = normalizeChannelTopic(input.topic ?? "");
  const title = untitledChannelName(input.name);
  const actions: ChannelIntroActionView[] = [];
  if (input.empty) {
    actions.push(write);
    if (input.canAddMember) {
      actions.push({
        kind: "add-member",
        label: EMPTY_ADD_MEMBER_ACTION_LABEL,
      });
    }
  }
  return {
    surface: "channel",
    icon: input.kind === "private" ? "lock" : "hash",
    title,
    body: topic === ""
      ? input.empty
        ? copy.detail
        : CHANNEL_INTRO_STARTED
      : topic,
    isAgent: false,
    actions,
  };
}
