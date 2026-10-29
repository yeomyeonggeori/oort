import { describe, expect, it } from "vitest";
import {
  AGENT_INITIATIVE_LABEL,
  AGENT_INITIATIVE_RATIONALE_LABEL,
  approvalHeadTitle,
  rationaleTag,
} from "./agentInitiative";
import { TEAM_AI_RATIONALE_LABEL } from "./teamAi";

describe("먼저 제안 꼬리표와 사유 이름표", () => {
  it("먼저 제안 카드만 제목 끝에 꼬리표가 붙고, 서버 제목은 그대로다", () => {
    const title = "승인 요청: 메시지 고정";
    expect(approvalHeadTitle({ title })).toBe(title);
    expect(approvalHeadTitle({ title, agentInitiated: true })).toBe(
      `${title} · ${AGENT_INITIATIVE_LABEL}`
    );
  });

  it("사유 이름표는 도우미 카드, 먼저 제안, 그 밖의 순서로 고른다", () => {
    const team = rationaleTag({
      proposedVia: { kind: "team_ai", requesterId: null, requesterName: null },
    });
    expect(team.label).toBe(TEAM_AI_RATIONALE_LABEL);
    expect(team.note).not.toBeNull();
    // 먼저 제안은 이름표만이다: 아래 줄을 더 세우지 않는다.
    expect(rationaleTag({ agentInitiated: true })).toEqual({
      label: AGENT_INITIATIVE_RATIONALE_LABEL,
      note: null,
    });
    // 둘 다 서면 도우미 쪽이 이긴다(먼저 제안은 호스티드 에이전트만 올린다).
    expect(
      rationaleTag({
        proposedVia: { kind: "team_ai", requesterId: null, requesterName: null },
        agentInitiated: true,
      }).label
    ).toBe(TEAM_AI_RATIONALE_LABEL);
    const plain = rationaleTag({});
    expect(plain.note).toBeNull();
    expect(plain.label).not.toBe(AGENT_INITIATIVE_RATIONALE_LABEL);
    expect(plain.label).not.toBe(TEAM_AI_RATIONALE_LABEL);
  });
});
