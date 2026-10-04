import type { RosterMember } from "../../lib/api";
import type { MentionRoutingTarget } from "../routing/mentionTargets";
import {
  aiAgentLabels,
  classifyAiAgent,
  nonOwnerComposerNotice,
  pausedComposerNotice,
  type AiAgentClassification,
} from "./aiHubModel";

// =============================================================================
// 멘션 자동완성 보조 줄 · 작성 중 한 줄 (AIH-9, #3439, 플랜 §5).
//
// 문장은 전부 `aiHubModel` 이 만든다. 이 파일은 명부 행(RosterMember)을 `AiAgentFacts` 로
// 옮기고 어느 문장을 올릴지 고를 뿐이다. 두 가지를 일부러 하지 않는다.
//
//   · 호스티드 연결 목록(`invocationScope` 등 오늘 값)을 읽지 않는다. 자동완성은 명부만 안다.
//     서버가 brain 을 내려주지 않는 구서버의 에이전트는 `unknown` 이라 줄을 그리지 않는다
//     (플랜 §9: 모르는 것을 「팀 키 · 누구나」로 읽지 않는다).
//   · 보낸 뒤의 비소유자 안내를 만들지 않는다. 서버가 같은 자리(owner_only_gate)에서 타임라인에
//     「<소유자>의 개인 에이전트예요 …」 안내를 이미 남긴다(`subscription_notice_body`).
//     클라가 같은 사실을 한 번 더 그리면 보낸 사람이 두 줄을 본다. 문구 정렬은 서버 몫의 후속이다.
// =============================================================================

export function classifyRosterAgent(member: RosterMember, viewerHumanId: string | null | undefined): AiAgentClassification {
  return classifyAiAgent(
    {
      brain: member.brain,
      callableBy: member.callableBy,
      ownerDisplayName: member.owner?.displayName,
      hostOnline: typeof member.hostOnline === "boolean" ? member.hostOnline : null,
      brainUnavailableReason: member.brainUnavailableReason,
      ownerHumanId: member.ownerHumanId ?? member.owner?.id,
    },
    { humanId: viewerHumanId }
  );
}

export interface MentionAnnotation {
  /** 이름 아래 보조 줄(`쓰는 AI · 부를 수 있는 사람`). null 이면 줄을 그리지 않는다. */
  line: string | null;
  /** 오른쪽 칩. */
  badge: string | null;
  /** 보는 사람이 못 부른다: 자물쇠 + 흐리게. 선택은 막지 않는다. */
  locked: boolean;
}

/** 에이전트가 아니거나 모르면 null. 사람 후보에는 아무것도 붙이지 않는다. */
export function mentionAnnotation(member: RosterMember, viewerHumanId: string | null | undefined): MentionAnnotation | null {
  if (member.kind !== "agent") return null;
  const labels = aiAgentLabels(classifyRosterAgent(member, viewerHumanId));
  if (labels.mentionLine === null) return null;
  return { line: labels.mentionLine, badge: labels.mentionBadge, locked: labels.lockedForViewer };
}

/**
 * 글이 부르는 에이전트들 가운데 못 부르는 것(남의 구독·개인 키)과 쉬는 것(Claude 문의 중)을
 * 말하는 한 줄. 없으면 null. 여럿이면 처음 하나를 말하고 나머지 수를 덧붙인다.
 * 남의 구독이 쉬는 중이기도 하면 못 부른다는 말이 먼저다(더 근본적인 사실).
 */
export function composerAgentNotice(agents: readonly RosterMember[], viewerHumanId: string | null | undefined): string | null {
  const notices: string[] = [];
  for (const agent of agents) {
    if (agent.kind !== "agent") continue;
    const c = classifyRosterAgent(agent, viewerHumanId);
    const notice = nonOwnerComposerNotice(c, agent.displayName) ?? pausedComposerNotice(c, agent.displayName);
    if (notice !== null) notices.push(notice);
  }
  if (notices.length === 0) return null;
  if (notices.length === 1) return notices[0];
  return `${notices[0]} 외 ${notices.length - 1}명도 답하지 않아요.`;
}

/** 이 에이전트는 보는 사람이 불러도 답하지 않는다(못 부름 또는 Claude 문의 중). */
export function agentWillNotAnswer(agent: RosterMember, viewerHumanId: string | null | undefined): boolean {
  if (agent.kind !== "agent") return false;
  const c = classifyRosterAgent(agent, viewerHumanId);
  const name = agent.displayName;
  return (nonOwnerComposerNotice(c, name) ?? pausedComposerNotice(c, name)) !== null;
}

/**
 * 라우팅 줄이 센 대상: 부른 에이전트 가운데 **답할 에이전트만** 남긴다(#3444).
 * 답하지 않는 에이전트는 바로 아래 「답하지 않아요」 줄이 말하므로, 같은 에이전트가 두 줄에
 * 서로 다른 말(「이번 메시지에 적용돼요」 / 「답하지 않아요」)로 서 있으면 모순이다.
 * 하나만 남으면 `one`, 아무도 안 남으면 `none` 으로 접는다.
 */
export function answeringMentionTarget(
  target: MentionRoutingTarget,
  viewerHumanId: string | null | undefined
): MentionRoutingTarget {
  if (target.kind === "none") return target;
  const agents = target.kind === "one" ? [target.agent] : target.agents;
  const answering = agents.filter((agent) => !agentWillNotAnswer(agent, viewerHumanId));
  if (answering.length === agents.length) return target;
  if (answering.length === 0) return { kind: "none" };
  if (answering.length === 1) return { kind: "one", agent: answering[0] };
  return { kind: "many", agents: answering };
}
