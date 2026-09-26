import { uuidEq, type RosterMember } from "@momo/core/lib/api";
import { rosterPaused } from "@momo/core/features/agents/agentOps";
import type { KomettoExpression } from "@momo/core/features/onboarding/guide";
import { attachParticle } from "@momo/core/lib/koreanParticle";
import { AGENTS_NAV } from "@/features/sidebar/workspaceNav";

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

/** 120s 백스톱 띠의 첫 문장(굵게). 실패 문구가 아니다(ADR-0181 D7). */
export const WELCOME_BACKSTOP_TITLE = "아직 준비하고 있어요.";

/** 백스톱 둘째 문장. 에이전트 허브 링크를 감싼다. */
export const WELCOME_BACKSTOP_BEFORE = "진행 상황은 ";
export const WELCOME_BACKSTOP_AFTER = "에서 볼 수 있어요.";

export const WELCOME_BACKSTOP_COPY = `${WELCOME_BACKSTOP_TITLE} ${WELCOME_BACKSTOP_BEFORE}${AGENTS_NAV.label}${WELCOME_BACKSTOP_AFTER}`;

export const WELCOME_BACKSTOP_LINK_LABEL = AGENTS_NAV.label;

export const WELCOME_BACKSTOP_HREF = AGENTS_NAV.to;

export const WELCOME_PROMPT_MAX_CHARS = 2000;

export const WELCOME_PROMPT_LIMIT_SENTENCE = `${WELCOME_PROMPT_MAX_CHARS}자까지 쓸 수 있습니다.`;

export type WelcomeKickoffPhase = "hidden" | "stage" | "exiting" | "backstop";

// -----------------------------------------------------------------------------
// 첫 대화 코메토 띠 (#2817, ADR-0193 D5·D11). 킥오프 스테이지가 타임라인 머리
// 행에서 컴포저 바로 위 띠로 내려왔다. 자리는 「폰에서도」 카드(#2818)와 같고,
// 둘은 `phase`로 갈린다: 띠는 stage·backstop·exiting, 카드는 hidden + 정착 뒤.
// -----------------------------------------------------------------------------

/**
 * 오프너가 도착한 뒤 기쁨 표정이 머무는 시간. 그 뒤 띠가 접힌다(모션) 또는
 * 사라진다(reduced-motion: 표정 교체만, 모션 없음). 기쁨 흔들기(360ms) 뒤에
 * 문장 한 줄을 읽을 틈이다.
 */
export const WELCOME_BAND_JOY_HOLD_MS = 1_200;

/** 구독 에이전트의 CLI 세션을 기다릴 때(#2814 착수 전 확인 결과). */
export const WELCOME_BAND_SLEEPY_COPY = "터미널에서 Claude Code를 열어 두면 인사해요.";

/** 오프너가 도착한 순간(시안 D5 `.kband`의 굵은 문장). */
export const WELCOME_BAND_JOY_COPY = "첫 대화가 시작됐어요.";

/** 이름을 하나로 정할 수 없을 때의 화자. */
export const WELCOME_BAND_FALLBACK_SPEAKER = "에이전트";

/** 「{에이전트}가 인사하러 오고 있어요.」 조사는 이름의 받침이 정한다. */
export function welcomeBandWorkingCopy(speaker: string | null): string {
  return `${attachParticle(speaker ?? WELCOME_BAND_FALLBACK_SPEAKER, "subject")} 인사하러 오고 있어요.`;
}

export type WelcomeBandState = "working" | "sleepy" | "backstop" | "joy";

/** 띠 상태 → 코메토 표정. ADR-0193 D11 표(상태와 표정 1:1)의 행을 그대로 쓴다. */
export const WELCOME_BAND_EXPRESSION: Readonly<Record<WelcomeBandState, KomettoExpression>> = {
  // preparing: 에이전트 준비 중
  working: "working",
  // skipped: 지금은 사람이 할 일이 남아 기다림(대기이지 오류가 아니다)
  sleepy: "sleepy",
  // preparing: 백스톱도 「아직 준비하고 있어요」다
  backstop: "working",
  // success: 첫 말 도착
  joy: "happy",
};

export interface WelcomeBandSpeaker {
  /** 띠 문장에 넣을 이름. 하나로 정할 수 없으면 null(「에이전트」). */
  name: string | null;
  /**
   * 말할 수 있는 에이전트가 없고, 이 사람이 방금 붙인 에이전트가 CLI 세션을
   * 기다리는 중인가.
   *
   * 서버 사실(track/engine `hosted_agent_connections.rs`·`hosted_connection.rs`):
   * 호스티드(구독 포함) 에이전트는 `member.status='active'`, `paused=true`로
   * 만들어지고, 소유자 맥의 CLI가 자격을 처음 증명하는 트랜잭션에서
   * `paused=false`가 되며 그때 오너 킥오프가 들어간다. 그래서 「활성 에이전트가
   * 모두 잠들어 있고 그중 하나가 내 것」이면 오프너는 CLI가 열려야 온다.
   * 팀의 잠든 에이전트(내 것이 아님)만 있으면 이 문장을 쓰지 않는다.
   */
  sleepy: boolean;
}

export function welcomeBandSpeaker(
  members: readonly RosterMember[],
  memberId: string
): WelcomeBandSpeaker {
  const active = members.filter(
    (member) => member.kind === "agent" && member.status === "active"
  );
  // 「잠듦을 모름」(구 서버, `rosterPaused` null)은 깨어 있는 쪽으로 읽는다:
  // 그때는 지금까지의 문장(인사하러 오고 있어요)이 맞다.
  const awake = active.filter((member) => rosterPaused(member) !== true);
  if (awake.length > 0) {
    return { name: awake.length === 1 ? awake[0].displayName : null, sleepy: false };
  }
  const mine = active.filter(
    (member) => member.ownerHumanId !== undefined && uuidEq(member.ownerHumanId, memberId)
  );
  return {
    name: mine.length === 1 ? mine[0].displayName : null,
    sleepy: mine.length > 0,
  };
}

/** 킥오프 phase와 화자 사실 → 띠 상태. `hidden`이면 띠가 없다. */
export function decideWelcomeBand(input: {
  phase: WelcomeKickoffPhase;
  sleepy: boolean;
}): WelcomeBandState | null {
  switch (input.phase) {
    case "hidden":
      return null;
    case "exiting":
      return "joy";
    case "stage":
      return input.sleepy ? "sleepy" : "working";
    case "backstop":
      // 120s 뒤에도 CLI 세션을 기다리는 중이면 그 문장이 이미 「어디서 하면
      // 되는지」를 말한다(ADR-0181 D7 백스톱의 뜻). 문장을 바꾸지 않는다.
      return input.sleepy ? "sleepy" : "backstop";
  }
}

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
  | "directory-not-ready"
  | "no-active-agent"
  | "unresolved-author"
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
  directoryStatus: "pending" | "success" | "error";
  activeAgentCount: number;
  hasUnresolvedAuthor: boolean;
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
  if (input.directoryStatus !== "success") {
    return { show: false, reason: "directory-not-ready" };
  }
  if (input.activeAgentCount === 0) {
    return { show: false, reason: "no-active-agent" };
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
  if (input.hasUnresolvedAuthor) {
    return { show: false, reason: "unresolved-author" };
  }
  if (input.hasAgentAuthoredMessage) {
    return { show: false, reason: "has-agent-message" };
  }
  if (input.shown) {
    return { show: false, reason: "already-shown" };
  }
  return { show: true };
}

/** Directory members the kickoff already has. Invited/suspended do not count. */
export function countActiveAgents(
  members: readonly { kind: string; status: string }[]
): number {
  return members.filter(
    (member) => member.kind === "agent" && member.status === "active"
  ).length;
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
  return WELCOME_PROMPT_LIMIT_SENTENCE;
}

/** Fresh marker is present and roster/backlog have not settled — hold the write CTA. */
export function isWelcomeDecisionPending(input: {
  freshSignup: { workspaceId: string; memberId: string } | null;
  workspaceId: string;
  memberId: string;
  channelKind?: string;
  channelName?: string;
  timelineStatus: "loading" | "ready" | "error";
  directoryStatus: "pending" | "success" | "error";
  channelId: string | null;
  messages: readonly { channelId?: string }[];
}): boolean {
  if (input.freshSignup === null) return false;
  if (!uuidEq(input.freshSignup.workspaceId, input.workspaceId)) return false;
  if (!uuidEq(input.freshSignup.memberId, input.memberId)) return false;
  if (
    !isDefaultWelcomeChannel({
      kind: input.channelKind,
      name: input.channelName,
    })
  ) {
    return false;
  }
  if (readShownMarker(input.workspaceId, input.memberId)) return false;
  if (input.timelineStatus === "loading") return true;
  if (input.directoryStatus === "pending") return true;
  if (!messagesBelongToChannel(input.messages, input.channelId)) return true;
  return false;
}
