import type { AgentApprovalCard } from "./agentCardModel";
import { TEAM_AI_RATIONALE_LABEL, TEAM_AI_RATIONALE_NOTE } from "./teamAi";

// =============================================================================
// 「먼저 제안」 카드의 표시 (ADR-0186 증보 v5 U-c, #4705)
//
// 에이전트가 아무도 부르지 않았는데 소유자와의 1:1 대화에 올린 승인 카드다. 서버는 그 사실을
// 카드 props 최상위 `origin: "agent_initiated"` 로 싣는다. 제안자는 **카드 작성자**(에이전트
// 멤버)라서 메시지 줄이 이미 말한다 — 카드에 이름을 다시 쓰지 않는다. 서버가 정한 요약 문장도
// 말로 같은 사실을 전한다(`props.summary`).
//
// 표시는 **카드 머리 제목 끝의 짧은 꼬리표 하나**와 사유 줄의 이름표뿐이다(2026-10-29 범위 조정:
// 새 행·새 배지를 만들지 않는다. 승인 카드의 모양은 다음 묶음에서 새로 짠다).
//
// 닫힌 판정이다. `origin` 이 정확히 `agent_initiated` 일 때만 표시가 서고, 모르는 값(아직 없는
// 미래의 출처)은 표시 없이 카드가 지금까지 그대로 선다. 모르는 출처를 「먼저 제안」이라고 부르면
// 승인자가 틀린 사실로 판단한다(`teamAi.ts` 의 `parseTeamAiProposal` 과 같은 규율).
//
// 사유(`rationale`)는 **에이전트가 쓴 글**이다. 시킨 사람이 없어 그 글이 유일한 설득 수단이라
// 사칭 표면이 되므로, 사유 줄의 이름표가 그것을 말한다. 평문으로만 그린다(링크·멘션·서식 변환 금지).
// =============================================================================

/** 카드 props 최상위 `origin` 의 값. */
export const AGENT_INITIATED_ORIGIN = "agent_initiated";

/** 카드 머리 제목 끝에 붙는 꼬리표. */
export const AGENT_INITIATIVE_LABEL = "먼저 제안";

/**
 * 카드 머리에 그릴 제목. 먼저 제안 카드는 제목 끝에 「 · 먼저 제안」이 붙고, 그 밖의 카드는 서버가
 * 준 제목 그대로다. 웹과 폰이 같은 규칙을 두 벌로 갖지 않게 코어에 둔다.
 */
export function approvalHeadTitle(
  card: Pick<AgentApprovalCard, "title" | "agentInitiated">
): string {
  return card.agentInitiated === true
    ? `${card.title} · ${AGENT_INITIATIVE_LABEL}`
    : card.title;
}

/** 사유 줄의 이름표. 모델이 아니라 **에이전트**가 쓴 글이라는 것을 이름에서 말한다. */
export const AGENT_INITIATIVE_RATIONALE_LABEL = "에이전트가 쓴 글";

export interface RationaleTag {
  label: string;
  /** 사유 아래 한 줄. 없으면 그리지 않는다. */
  note: string | null;
}

/**
 * 사유 줄의 이름표를 한 곳에서 고른다. 웹과 폰이 같은 갈래를 두 벌로 갖지 않게 코어에 둔다.
 * 도우미(팀 AI) 카드가 먼저고, 그다음이 먼저 제안(이름표만, 아래 줄 없음), 둘 다 아니면 지금까지의
 * 「사유」다.
 */
export function rationaleTag(
  card: Pick<AgentApprovalCard, "proposedVia" | "agentInitiated">
): RationaleTag {
  if (card.proposedVia !== undefined) {
    return { label: TEAM_AI_RATIONALE_LABEL, note: TEAM_AI_RATIONALE_NOTE };
  }
  if (card.agentInitiated === true) {
    return { label: AGENT_INITIATIVE_RATIONALE_LABEL, note: null };
  }
  return { label: "사유", note: null };
}
