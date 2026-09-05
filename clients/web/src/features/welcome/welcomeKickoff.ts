import { uuidEq } from "@momo/core/lib/api";

// =============================================================================
// Welcome kickoff model (UX-R2b / ADR-0181 D7).
//
// Mount gates, backstop clock, shown-marker, and copy live here so the stage
// component and the settings fields do not invent a second set of numbers.
// =============================================================================

/** 120s. Named *_MS house convention. Not a CSS duration. */
export const WELCOME_BACKSTOP_MS = 120_000;

export const WELCOME_SHOWN_STORAGE_PREFIX = "oort.welcomeKickoffShown.v1";

/** Server-seeded default public channel (ADR-0181 D3). */
export const WELCOME_DEFAULT_CHANNEL_NAME = "general";

export const WELCOME_STAGE_COPY = "팀이 준비하고 있어요";

export const WELCOME_BACKSTOP_COPY =
  "에이전트가 아직 준비 중이에요. 설정 › 에이전트에서 상태를 볼 수 있어요";

export const WELCOME_BACKSTOP_LINK_LABEL = "설정 › 에이전트";

/** Agent hub is the product surface that shows agent status. */
export const WELCOME_BACKSTOP_HREF = "/agents";

export const WELCOME_PROMPT_MAX_CHARS = 2000;

export const WELCOME_PROMPT_TOO_LONG =
  "웰컴 프롬프트는 2000자까지 쓸 수 있습니다.";

export const WELCOME_KICKOFF_ITEM_KEY = "welcome-kickoff";

export type WelcomeKickoffPhase = "hidden" | "stage" | "exiting" | "backstop";

export type WelcomeCloudKind = "comet" | "asteroid" | "star";

/** 4 line-art bodies. OortCloudMark kinds; mascot body untouched. */
export const WELCOME_KICKOFF_SHAPES: readonly WelcomeCloudKind[] = [
  "comet",
  "asteroid",
  "star",
  "comet",
];

export function welcomeShownKey(workspaceId: string, memberId: string): string {
  return `${WELCOME_SHOWN_STORAGE_PREFIX}:${workspaceId}:${memberId}`;
}

export function isDefaultWelcomeChannel(channel: {
  kind?: string;
  name?: string;
}): boolean {
  return (
    channel.kind === "public" && channel.name === WELCOME_DEFAULT_CHANNEL_NAME
  );
}

export type WelcomeMountReason =
  | "no-fresh-signup"
  | "wrong-workspace"
  | "wrong-member"
  | "not-default-channel"
  | "timeline-not-ready"
  | "has-agent-message"
  | "already-shown";

export type WelcomeMountDecision =
  | { show: true }
  | { show: false; reason: WelcomeMountReason };

export function decideWelcomeMount(input: {
  freshSignup: { workspaceId: string; memberId: string } | null;
  workspaceId: string;
  memberId: string;
  channelKind?: string;
  channelName?: string;
  timelineStatus: "loading" | "ready" | "error";
  hasAgentAuthoredMessage: boolean;
  shown: boolean;
}): WelcomeMountDecision {
  if (input.freshSignup === null) {
    return { show: false, reason: "no-fresh-signup" };
  }
  if (!uuidEq(input.freshSignup.workspaceId, input.workspaceId)) {
    return { show: false, reason: "wrong-workspace" };
  }
  if (!uuidEq(input.freshSignup.memberId, input.memberId)) {
    return { show: false, reason: "wrong-member" };
  }
  if (
    !isDefaultWelcomeChannel({
      kind: input.channelKind,
      name: input.channelName,
    })
  ) {
    return { show: false, reason: "not-default-channel" };
  }
  if (input.timelineStatus !== "ready") {
    return { show: false, reason: "timeline-not-ready" };
  }
  if (input.hasAgentAuthoredMessage) {
    return { show: false, reason: "has-agent-message" };
  }
  if (input.shown) {
    return { show: false, reason: "already-shown" };
  }
  return { show: true };
}

export function hasAgentAuthoredMessage(
  messages: readonly { authorMemberId: string }[],
  authorKind: (memberId: string) => string | undefined
): boolean {
  return messages.some((message) => authorKind(message.authorMemberId) === "agent");
}

/**
 * useTimeline keeps the previous channel's rows until its effect clears them.
 * Deciding on that render would lock `has-agent-message` for the wrong room.
 * Rows without `channelId` (tests that only pass author) are treated as matching.
 */
export function messagesBelongToChannel(
  messages: readonly { channelId?: string }[],
  channelId: string | null
): boolean {
  if (channelId === null) return true;
  return messages.every(
    (message) =>
      message.channelId === undefined || uuidEq(message.channelId, channelId)
  );
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readShownMarker(workspaceId: string, memberId: string): boolean {
  try {
    return localStore()?.getItem(welcomeShownKey(workspaceId, memberId)) === "1";
  } catch {
    return false;
  }
}

export function writeShownMarker(workspaceId: string, memberId: string): void {
  try {
    localStore()?.setItem(welcomeShownKey(workspaceId, memberId), "1");
  } catch {
    // Quota or a locked store: the server opener still lands once.
  }
}

export function welcomePromptTooLong(value: string): string | null {
  if (value.length <= WELCOME_PROMPT_MAX_CHARS) return null;
  return WELCOME_PROMPT_TOO_LONG;
}

export interface WelcomeKickoffItem {
  kind: "welcome-kickoff";
  key: typeof WELCOME_KICKOFF_ITEM_KEY;
}

export const WELCOME_KICKOFF_ITEM: WelcomeKickoffItem = {
  kind: "welcome-kickoff",
  key: WELCOME_KICKOFF_ITEM_KEY,
};
