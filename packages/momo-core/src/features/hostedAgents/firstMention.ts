import { uuidEq, type RosterMember } from "../../lib/api";
import { attachParticle } from "../../lib/koreanParticle";
import {
  GROK_HOSTED_AGENT_ID,
  hostedAgentSignature,
  matchHostedAgentMember,
} from "./detect";
import type { HostedAgentConnection } from "./model";
import { testMentionGate } from "./wizard";

// =============================================================================
// 호스티드 에이전트 초대 직후 첫 왕복 (T-6 / #1656, E6).
//
// 완료 판정은 하나다: 그 에이전트가 author 인 메시지가 채널에 나타난다.
// 그 메시지가 답변인지 실패 고지인지는 이 표면이 가르지 않는다. 벤치의
// ANSWERED/NOTICE 분기는 측정 쪽이고, 제품 표면은 "답이 왔는가"만 본다.
//
// 위저드 단계 기계(`./wizard`)와 감지 레지스트리(`./detect`)는 건드리지 않는다.
// 이 파일이 하는 일은 이미 활성인 연결 + 채널 메시지에서 네 상태를 도출하는
// 것뿐이다.
// =============================================================================

/**
 * 답을 기다리다가 오류로 넘어가는 상한.
 *
 * 벤치 `REPLY_TIMEOUT` 기본(300초)과 같다. **제품 게이트가 아니다.** 이 값이
 * 하는 일은 무음 실패를 막는 것뿐이다: 답이 안 오면 오류 상태가 실존해야
 * 한다(E6). 응답 시간 자체를 합격/불합격으로 쓰지 마라.
 */
export const FIRST_MENTION_WAIT_MS = 300_000;

/** 에이전트=1급 member 정체성. 이 문자열이 화면에서 빠지면 E6 불합격이다. */
export const FIRST_MENTION_AGENT_BADGE = "에이전트";

export type FirstMentionPhase = "hidden" | "empty" | "loading" | "error";

export type FirstMentionErrorKind =
  | "timeout"
  | "messages"
  | "connections"
  | null;

export type FirstMentionLoadStatus = "idle" | "loading" | "ready" | "error";

/** 왕복 판정이 메시지에서 읽는 칸. 전체 Message 를 끌어오지 않는다. */
export interface FirstMentionMessage {
  authorMemberId: string;
  createdAtMs: number;
  body?: string;
  state?: string;
  props?: Record<string, unknown>;
}

export interface FirstMentionTarget {
  connectionId: string;
  agentMemberId: string;
  displayName: string;
  handle: string;
}

export interface FirstMentionView {
  phase: FirstMentionPhase;
  complete: boolean;
  agent: FirstMentionTarget | null;
  headline: string;
  detail: string;
  actionLabel: string | null;
  errorKind: FirstMentionErrorKind;
  /** 모든 보이는 상태에서 같은 라벨. 테스트가 누락을 잡는다. */
  agentBadge: typeof FIRST_MENTION_AGENT_BADGE;
}

const HIDDEN: FirstMentionView = {
  phase: "hidden",
  complete: false,
  agent: null,
  headline: "",
  detail: "",
  actionLabel: null,
  errorKind: null,
  agentBadge: FIRST_MENTION_AGENT_BADGE,
};

function isUsableAgent(member: RosterMember): boolean {
  return (
    member.kind === "agent" &&
    member.status !== "deleted" &&
    member.status !== "suspended"
  );
}

function activeOnChannel(
  connection: HostedAgentConnection,
  channelId: string
): boolean {
  if (connection.status !== "active") return false;
  if (!testMentionGate(connection).allowed) return false;
  return connection.approvedChannelIds.some((id) => uuidEq(id, channelId));
}

function memberForConnection(
  members: readonly RosterMember[],
  agentMemberId: string
): RosterMember | null {
  return (
    members.find(
      (member) => isUsableAgent(member) && uuidEq(member.id, agentMemberId)
    ) ?? null
  );
}

function toTarget(
  connection: HostedAgentConnection,
  member: RosterMember
): FirstMentionTarget {
  return {
    connectionId: connection.id,
    agentMemberId: member.id,
    displayName: member.displayName,
    handle: member.handle,
  };
}

/**
 * 이 채널에서 첫 왕복을 재야 하는 호스티드 에이전트.
 *
 * 우선순위: 위저드가 넘긴 힌트 → 그록봇 시그니처 매칭 → 없음.
 * 힌트가 있으면 이름을 바꿔도 같은 연결을 따라간다. 힌트가 없으면
 * v1 시그니처(그록봇/`grokbot`)만 고른다. 일반 호스티드 연결의 테스트
 * 멘션 링크는 힌트를 싣는다.
 */
/**
 * 목록이 오기 전에 뱃지를 그리기 위한 힌트 미리보기.
 * 연결이 활성인지는 아직 모른다. 대상 확정은 `pickFirstMentionTarget`.
 */
export function previewHintedAgent(
  members: readonly RosterMember[],
  hintedAgentMemberId: string | null | undefined
): FirstMentionTarget | null {
  const hinted = hintedAgentMemberId?.trim() ?? "";
  if (hinted === "") return null;
  const member = memberForConnection(members, hinted);
  if (!member) return null;
  return {
    connectionId: "",
    agentMemberId: member.id,
    displayName: member.displayName,
    handle: member.handle,
  };
}

export function pickFirstMentionTarget(input: {
  channelId: string;
  members: readonly RosterMember[];
  connections: readonly HostedAgentConnection[];
  hintedAgentMemberId?: string | null;
}): FirstMentionTarget | null {
  const onChannel = input.connections.filter((row) =>
    activeOnChannel(row, input.channelId)
  );
  const hinted = input.hintedAgentMemberId?.trim() ?? "";
  if (hinted !== "") {
    const connection = onChannel.find((row) =>
      uuidEq(row.agentMemberId, hinted)
    );
    const member = connection
      ? memberForConnection(input.members, connection.agentMemberId)
      : null;
    if (connection && member) return toTarget(connection, member);
  }

  const grok = hostedAgentSignature(GROK_HOSTED_AGENT_ID);
  if (!grok) return null;
  const grokMember = matchHostedAgentMember(input.members, grok.identity);
  if (!grokMember) return null;
  const connection = onChannel.find((row) =>
    uuidEq(row.agentMemberId, grokMember.id)
  );
  return connection ? toTarget(connection, grokMember) : null;
}

function handleBoundaryAfter(body: string, end: number): boolean {
  if (end >= body.length) return true;
  return !/[A-Za-z0-9_-]/.test(body.charAt(end));
}

/** 낙관적 echo 처럼 mention_member_ids 가 아직 없는 본문용. */
export function bodyMentionsHandle(
  body: string | undefined,
  handle: string
): boolean {
  if (!body || handle.trim() === "") return false;
  const needle = `@${handle}`;
  const foldedBody = body.toLowerCase();
  const foldedNeedle = needle.toLowerCase();
  let from = 0;
  while (from < foldedBody.length) {
    const at = foldedBody.indexOf(foldedNeedle, from);
    if (at < 0) return false;
    const end = at + foldedNeedle.length;
    if (handleBoundaryAfter(foldedBody, end)) return true;
    from = at + 1;
  }
  return false;
}

function isDeleted(message: FirstMentionMessage): boolean {
  return message.state === "deleted";
}

function recordedMentionIds(message: FirstMentionMessage): string[] {
  const raw = message.props?.["mention_member_ids"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

export function messageMentionsAgent(
  message: FirstMentionMessage,
  agentMemberId: string,
  handle: string
): boolean {
  if (isDeleted(message)) return false;
  if (recordedMentionIds(message).some((id) => uuidEq(id, agentMemberId))) {
    return true;
  }
  return bodyMentionsHandle(message.body, handle);
}

export function isAgentReply(
  message: FirstMentionMessage,
  agentMemberId: string
): boolean {
  if (isDeleted(message)) return false;
  return uuidEq(message.authorMemberId, agentMemberId);
}

function selfMentionedAgent(
  message: FirstMentionMessage,
  selfMemberId: string,
  agentMemberId: string,
  handle: string
): boolean {
  if (!uuidEq(message.authorMemberId, selfMemberId)) return false;
  return messageMentionsAgent(message, agentMemberId, handle);
}

function copyFor(view: {
  phase: Exclude<FirstMentionPhase, "hidden">;
  agent: FirstMentionTarget;
  errorKind: FirstMentionErrorKind;
}): Pick<FirstMentionView, "headline" | "detail" | "actionLabel"> {
  const name = view.agent.displayName;
  const handle = view.agent.handle;
  if (view.phase === "empty") {
    return {
      headline: "첫 멘션을 보내보세요.",
      detail: `${attachParticle(`@${handle}`, "object")} 부르면 ${attachParticle(name, "subject")} 같은 채널에 답합니다.`,
      actionLabel: "첫 멘션 쓰기",
    };
  }
  if (view.phase === "loading") {
    return {
      headline: `${name}의 답을 기다리는 중입니다.`,
      detail: "에이전트가 같은 채널에 메시지를 쓰면 이 온보딩은 끝납니다.",
      actionLabel: null,
    };
  }
  if (view.errorKind === "timeout") {
    return {
      headline: `${name}의 답이 오지 않았습니다.`,
      detail: "다시 멘션해 보세요. 답이 없으면 이 온보딩은 끝나지 않습니다.",
      actionLabel: "다시 멘션하기",
    };
  }
  if (view.errorKind === "connections") {
    return {
      headline: "그록봇 연결 상태를 확인하지 못했습니다.",
      detail: "다시 시도하세요.",
      actionLabel: "다시 시도",
    };
  }
  return {
    headline: "채널 메시지를 확인하지 못했습니다.",
    detail: "연결을 확인하고 다시 시도하세요.",
    actionLabel: "다시 시도",
  };
}

function visible(
  agent: FirstMentionTarget,
  phase: Exclude<FirstMentionPhase, "hidden">,
  errorKind: FirstMentionErrorKind,
  complete = false
): FirstMentionView {
  return {
    phase,
    complete,
    agent,
    ...copyFor({ phase, agent, errorKind }),
    errorKind,
    agentBadge: FIRST_MENTION_AGENT_BADGE,
  };
}

/**
 * 네 상태 중 빈/로딩/오류를 도출한다. 오프라인은 호출부가 배너로 얹는다
 * (캐시된 내용은 계속 그린다).
 */
export function firstMentionView(input: {
  target: FirstMentionTarget | null;
  hintedAgentMemberId?: string | null;
  previewAgent?: FirstMentionTarget | null;
  connectionsStatus: FirstMentionLoadStatus;
  messagesStatus: FirstMentionLoadStatus;
  messages: readonly FirstMentionMessage[];
  selfMemberId: string;
  nowMs: number;
  waitMs?: number;
}): FirstMentionView {
  const waitMs = input.waitMs ?? FIRST_MENTION_WAIT_MS;
  const hinted = (input.hintedAgentMemberId ?? "").trim() !== "";

  if (input.target === null) {
    if (!hinted) return HIDDEN;
    const preview = input.previewAgent ?? null;
    if (input.connectionsStatus === "loading") {
      return {
        ...HIDDEN,
        phase: "loading",
        agent: preview,
        headline: "그록봇 연결 상태를 확인하는 중입니다.",
        detail: "",
        actionLabel: null,
      };
    }
    if (input.connectionsStatus === "error") {
      if (preview) return visible(preview, "error", "connections");
      return {
        ...HIDDEN,
        phase: "error",
        headline: "그록봇 연결 상태를 확인하지 못했습니다.",
        detail: "다시 시도하세요.",
        actionLabel: "다시 시도",
        errorKind: "connections",
      };
    }
    return HIDDEN;
  }

  const agent = input.target;
  const reply = input.messages.find((row) =>
    isAgentReply(row, agent.agentMemberId)
  );
  if (reply) {
    return {
      ...HIDDEN,
      complete: true,
      agent,
    };
  }

  if (input.messagesStatus === "error") {
    return visible(agent, "error", "messages");
  }
  if (input.messagesStatus === "loading" || input.messagesStatus === "idle") {
    return visible(agent, "loading", null);
  }

  const mention = input.messages
    .filter((row) =>
      selfMentionedAgent(
        row,
        input.selfMemberId,
        agent.agentMemberId,
        agent.handle
      )
    )
    .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];

  if (!mention) return visible(agent, "empty", null);

  if (input.nowMs - mention.createdAtMs >= waitMs) {
    return visible(agent, "error", "timeout");
  }
  return visible(agent, "loading", null);
}

/** 컴포저에 심을 첫 멘션 초안. 이미 글이 있으면 호출부가 덮지 않는다. */
export function firstMentionDraft(handle: string): string {
  return `@${handle} `;
}
