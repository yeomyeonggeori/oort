import { describe, expect, it } from "vitest";
import {
  AGENT_INITIATIVE_RATIONALE_LABEL,
  agentInitiativeLine,
  rationaleTag,
} from "./agentInitiative";
import { TEAM_AI_RATIONALE_LABEL } from "./teamAi";

describe("먼저 제안 줄과 사유 꼬리표", () => {
  it("제안자 이름에 주격 조사를 받침에 맞게 붙이고, 이름을 모르면 이름을 짓지 않는다", () => {
    expect(agentInitiativeLine("김인턴")).toContain("김인턴이");
    expect(agentInitiativeLine("planner")).toContain("planner가");
    for (const unknown of [null, "", "   "]) {
      const line = agentInitiativeLine(unknown);
      expect(line).toContain("에이전트가");
      expect(line).not.toContain("null");
    }
  });

  it("사유 이름표는 도우미 카드, 먼저 제안, 그 밖의 순서로 고른다", () => {
    const team = rationaleTag({
      proposedVia: { kind: "team_ai", requesterId: null, requesterName: null },
    });
    expect(team.label).toBe(TEAM_AI_RATIONALE_LABEL);
    expect(team.note).not.toBeNull();
    const initiated = rationaleTag({ agentInitiated: true });
    expect(initiated.label).toBe(AGENT_INITIATIVE_RATIONALE_LABEL);
    expect(initiated.note).not.toBeNull();
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
