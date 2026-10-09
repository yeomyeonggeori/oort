import type { RosterMember } from "@momo/core/lib/api";
import type { HostedAgentConnection } from "@momo/core/features/hostedAgents/model";
import { agentMembers } from "@momo/core/features/agents/hubModel";
import {
  AI_AGENTS_PANE_COPY as COPY,
  AI_HUB_COPY,
  aiAgentLabels,
  classifyAiAgent,
  type AiAgentClassification,
  type AiAgentFacts,
  type AiAgentLabels,
} from "@momo/core/features/ai/aiHubModel";

// =============================================================================
// 「에이전트」 구획의 표와 만들기 3종 (AIH-7, #3428). React 없음.
//
// 표의 문장은 전부 core `aiAgentLabels` 가 만든다. 이 파일은 (1) 서버 명부 행과 호스티드 연결
// 목록을 core 입력(AiAgentFacts)으로 옮기고, (2) core 가 말하지 않는 「상태」 칸의 한 단어를
// 고르고(사용 중지 > 문의 중 > 일시정지 > 맥 켜짐/꺼짐 > 활성), (3) 만들기 종류별 사용 가능
// 여부를 정한다. 새 문장을 만들지 않는다.
// =============================================================================

export type AgentStatusTone = "ok" | "warn" | "mute";

export interface AgentStatusView {
  label: string;
  tone: AgentStatusTone;
  /** 칩 아래 보조 줄(문의 중 사유, 맥 꺼짐 설명). */
  detail: string | null;
}

export interface AgentTableRow {
  id: string;
  name: string;
  handle: string;
  /** 로고 칸 한 글자: 하니스(C/X) 또는 이름 첫 글자. */
  mark: string;
  classification: AiAgentClassification;
  labels: AiAgentLabels;
  /** 모르면 null: 칸에 「상태를 볼 수 없어요」. */
  status: AgentStatusView | null;
}

export function agentStatus(agent: RosterMember, labels: AiAgentLabels, c: AiAgentClassification): AgentStatusView | null {
  if (agent.status !== "active") return { label: COPY.inactive, tone: "mute", detail: null };
  // core 의 서버 사유 상태는 회색(muted) 한 가지 톤이다.
  if (labels.status) return { label: labels.status.label, tone: "mute", detail: labels.status.detail };
  if (agent.paused === true) return { label: COPY.paused, tone: "mute", detail: null };
  if (labels.host) {
    return { label: labels.host.label, tone: c.hostOnline === true ? "ok" : "warn", detail: labels.host.detail };
  }
  if (agent.paused === false) return { label: COPY.active, tone: "ok", detail: null };
  return null;
}

function factsFor(agent: RosterMember, conn: HostedAgentConnection | undefined, connectionsKnown: boolean): AiAgentFacts {
  return {
    brain: agent.brain,
    callableBy: agent.callableBy,
    ownerDisplayName: agent.owner?.displayName,
    hostOnline: typeof agent.hostOnline === "boolean" ? agent.hostOnline : null,
    brainUnavailableReason: agent.brainUnavailableReason,
    ownerHumanId: agent.ownerHumanId ?? agent.owner?.id,
    invocationScope: conn?.invocationScope,
    subscriptionHarness: conn?.subscriptionHarness,
    // 목록을 읽었고 연결이 없으면 팀 키, 목록을 못 읽었으면 모른다.
    hostedConnection: connectionsKnown ? conn !== undefined : undefined,
  };
}

/**
 * 명부와 호스티드 연결 목록 → 표 행. `connections` 가 null 이면 목록을 못 읽은 것이다(권한 없음 포함):
 * 서버가 brain 을 직접 내려준 행은 그대로 읽고, 아닌 행은 「쓰는 AI를 아직 몰라요」가 된다.
 */
export function agentTableRows(
  members: readonly RosterMember[],
  connections: readonly HostedAgentConnection[] | null,
  viewerHumanId: string
): AgentTableRow[] {
  const byAgent = new Map<string, HostedAgentConnection>();
  for (const conn of connections ?? []) byAgent.set(conn.agentMemberId.toLowerCase(), conn);
  return agentMembers(members).map((agent) => {
    const classification = classifyAiAgent(
      factsFor(agent, byAgent.get(agent.id.toLowerCase()), connections !== null),
      { humanId: viewerHumanId }
    );
    const labels = aiAgentLabels(classification);
    const mark = classification.harness
      ? classification.harness === "codex"
        ? "X"
        : "C"
      : ([...agent.displayName.trim()][0] ?? "?").toUpperCase();
    return {
      id: agent.id,
      name: agent.displayName,
      handle: agent.handle,
      mark,
      classification,
      labels,
      status: agentStatus(agent, labels, classification),
    };
  });
}

// ---- 만들기 2종 (구독 에이전트 만들기는 ADR-0198로 걷었다. 구독은 「내 도구」) ----

export type CreateKindId = "team" | "external";

export interface CreateKindInput {
  /** 소유자·관리자인가 (`canCreateAgentNow`: 서버 `routes::agents::create` 의 관문). */
  mayCreate: boolean;
  /** 외부 에이전트 초대(`hostedAgentPairing`)가 이 빌드·서버에 있는가. */
  externalProvided: boolean;
}

export interface CreateKindOption {
  id: CreateKindId;
  title: string;
  description: string;
  /** 누가 하나: 소유자·관리자. */
  audience: string;
  /** `available` 만 누를 수 있다. 나머지는 사유를 들고 잠긴다. */
  state: "available" | "locked";
  /** 잠긴 사유. `desktopHint` 는 웹에서 「데스크탑에서 해요」를 칩으로 보이기 위한 것. */
  reason: string | null;
  desktopHint: boolean;
}

export function createKindOptions(input: CreateKindInput): CreateKindOption[] {
  const kinds = AI_HUB_COPY.createKinds;
  const deniedReason = input.mayCreate ? null : COPY.create.denied;

  const external: Pick<CreateKindOption, "state" | "reason" | "desktopHint"> =
    deniedReason !== null
      ? { state: "locked", reason: deniedReason, desktopHint: false }
      : !input.externalProvided
        ? { state: "locked", reason: COPY.create.externalOff, desktopHint: false }
        : { state: "available", reason: null, desktopHint: false };

  return [
    {
      id: "team",
      ...kinds.team,
      state: deniedReason === null ? "available" : "locked",
      reason: deniedReason,
      desktopHint: false,
    },
    { id: "external", ...kinds.external, ...external },
  ];
}

/**
 * 명부 행 하나의 상태 한 단어(연결 목록 없이, 서버 명부 필드만으로). `/agents` 목록 칩이 표와 같은
 * 우선순위를 쓰게 하려는 것이다. 서버가 상태 필드를 안 주는 구서버는 null 이 아니라 「활성」/null 이 나오고,
 * 호출부는 「활성」이면 자기 프로필 기반 판정으로 돌아간다.
 */
export function rosterStatusView(agent: RosterMember, viewerHumanId: string): AgentStatusView | null {
  const classification = classifyAiAgent(factsFor(agent, undefined, false), { humanId: viewerHumanId });
  return agentStatus(agent, aiAgentLabels(classification), classification);
}
