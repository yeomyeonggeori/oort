import { describe, expect, it } from "vitest";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit";
import {
  AGENT_INITIATIVE_RATIONALE_LABEL_KEY,
  approvalHeadTitle,
  rationaleTag,
} from "./agentInitiative";
import { TEAM_AI_RATIONALE_LABEL_KEY } from "./teamAi";

// 문장은 사전(`timeline.json`)에 있다(#6044). 시험은 제품과 같은 한국어 생성물로 키를 풀어 한국어 그대로 단정한다.
const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });

describe("먼저 제안 꼬리표와 사유 이름표", () => {
  it("먼저 제안 카드만 제목 끝에 꼬리표가 붙고, 서버 제목은 그대로다", () => {
    const title = "승인 요청: 메시지 고정";
    expect(approvalHeadTitle(ko, { title })).toBe(title);
    expect(approvalHeadTitle(ko, { title, agentInitiated: true })).toBe(
      `${title} · 먼저 제안`
    );
  });

  it("사유 이름표는 도우미 카드, 먼저 제안, 그 밖의 순서로 고른다", () => {
    const team = rationaleTag({
      proposedVia: { kind: "team_ai", requesterId: null, requesterName: null },
    });
    expect(team.labelKey).toBe(TEAM_AI_RATIONALE_LABEL_KEY);
    expect(ko(team.labelKey)).toBe("도우미가 쓴 사유");
    expect(team.noteKey).not.toBeNull();
    // 먼저 제안은 이름표만이다: 아래 줄을 더 세우지 않는다.
    expect(rationaleTag({ agentInitiated: true })).toEqual({
      labelKey: AGENT_INITIATIVE_RATIONALE_LABEL_KEY,
      noteKey: null,
    });
    expect(ko(AGENT_INITIATIVE_RATIONALE_LABEL_KEY)).toBe("에이전트가 쓴 글");
    // 둘 다 서면 도우미 쪽이 이긴다(먼저 제안은 호스티드 에이전트만 올린다).
    expect(
      rationaleTag({
        proposedVia: { kind: "team_ai", requesterId: null, requesterName: null },
        agentInitiated: true,
      }).labelKey
    ).toBe(TEAM_AI_RATIONALE_LABEL_KEY);
    const plain = rationaleTag({});
    expect(plain.noteKey).toBeNull();
    expect(ko(plain.labelKey)).toBe("사유");
    expect(plain.labelKey).not.toBe(AGENT_INITIATIVE_RATIONALE_LABEL_KEY);
    expect(plain.labelKey).not.toBe(TEAM_AI_RATIONALE_LABEL_KEY);
  });
});
