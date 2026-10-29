import { attachParticle } from "../../lib/koreanParticle";
import type { AgentApprovalCard } from "./agentCardModel";
import { TEAM_AI_RATIONALE_LABEL, TEAM_AI_RATIONALE_NOTE } from "./teamAi";

// =============================================================================
// 「먼저 제안」 카드의 표시 (ADR-0186 증보 v5 U-c, #4705)
//
// 에이전트가 아무도 부르지 않았는데 소유자와의 1:1 대화에 올린 승인 카드다. 서버는 그 사실을
// 카드 props 최상위 `origin: "agent_initiated"` 로 싣는다(`workspace_action_request_props` 뒤에
// 더하는 키). 제안자는 **카드 작성자**(에이전트 멤버)이고 props 에 이름을 굽지 않는다: 이름은
// 바뀌면 낡는다(인플레이스 카드와 같은 이유). 그래서 이 모듈은 이름을 받아 문장을 지을 뿐
// 이름을 읽지 않는다.
//
// 닫힌 판정이다. `origin` 이 정확히 `agent_initiated` 일 때만 표시가 서고, 모르는 값(아직 없는
// 미래의 출처)은 표시 없이 카드가 지금까지 그대로 선다. 모르는 출처를 「먼저 제안」이라고 부르면
// 승인자가 틀린 사실로 판단한다(`teamAi.ts` 의 `parseTeamAiProposal` 과 같은 규율).
//
// 사유(`rationale`)는 **에이전트가 쓴 글**이다. 시킨 사람이 없어 그 글이 유일한 설득 수단이라
// 사칭 표면이 되므로, 카드는 그 글에 꼬리표를 달고 판단의 근거는 서버가 읽어 만든 행이라고
// 말한다. 평문으로만 그린다(링크·멘션·서식 변환 금지).
// =============================================================================

/** 카드 props 최상위 `origin` 의 값. */
export const AGENT_INITIATED_ORIGIN = "agent_initiated";

/** 카드 맨 위 사실 줄의 이름표. */
export const AGENT_INITIATIVE_LABEL = "먼저 제안";

/**
 * 「아무도 부르지 않았는데 ○○가 먼저 올렸어요.」 제안자는 카드 작성자의 이름이다. 이름을
 * 모르면(디렉터리에 없음) 「에이전트」로 말한다. 이름을 지어내지 않는다.
 */
export function agentInitiativeLine(agentName: string | null): string {
  const who =
    agentName === null || agentName.trim() === ""
      ? "에이전트가"
      : attachParticle(agentName, "subject");
  return `아무도 부르지 않았는데 ${who} 먼저 올렸어요.`;
}

/**
 * 결정 전에만 서는 한 줄: 아직 아무것도 바뀌지 않았고, 승인해야 실행된다. 결정이 난 카드에는
 * 서지 않는다(승인 뒤에 「아무것도 바뀌지 않았어요」는 거짓이다).
 */
export const AGENT_INITIATIVE_AUTHORITY =
  "승인하기 전에는 아무것도 바뀌지 않아요. 승인하면 승인한 사람의 권한으로 실행돼요.";

/** 사유 줄의 꼬리표. 모델이 아니라 **에이전트**가 쓴 글이라는 것을 이름에서 말한다. */
export const AGENT_INITIATIVE_RATIONALE_LABEL = "에이전트가 쓴 글";

/** 사유 아래 한 줄. 판단의 근거는 사유가 아니라 위의 행이다. */
export const AGENT_INITIATIVE_RATIONALE_NOTE =
  "실제로 바뀌는 내용은 위 칸을 보세요.";

export interface RationaleTag {
  label: string;
  /** 사유 아래 한 줄. 없으면 그리지 않는다. */
  note: string | null;
}

/**
 * 사유 줄의 이름표를 한 곳에서 고른다. 웹과 폰이 같은 갈래를 두 벌로 갖지 않게 코어에 둔다.
 * 도우미(팀 AI) 카드가 먼저고, 그다음이 먼저 제안, 둘 다 아니면 지금까지의 「사유」다.
 */
export function rationaleTag(
  card: Pick<AgentApprovalCard, "proposedVia" | "agentInitiated">
): RationaleTag {
  if (card.proposedVia !== undefined) {
    return { label: TEAM_AI_RATIONALE_LABEL, note: TEAM_AI_RATIONALE_NOTE };
  }
  if (card.agentInitiated === true) {
    return {
      label: AGENT_INITIATIVE_RATIONALE_LABEL,
      note: AGENT_INITIATIVE_RATIONALE_NOTE,
    };
  }
  return { label: "사유", note: null };
}
