import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel } from "./agentCardModel";
import {
  canDelegate,
  delegateButtonLabel,
  delegateMessageBody,
  parseTeamAiDelegate,
  parseTeamAiProposal,
  teamAiProposalLine,
} from "./teamAi";

const REQUESTER = "11111111-1111-4111-8111-111111111111";
const TEAM_AI = "22222222-2222-4222-8222-222222222222";
const GROK = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";

// 서버 `fallback_props` (PR #3837 team_ai.rs) 가 쓰는 모양 그대로.
function delegateProps(overrides: Record<string, unknown> = {}) {
  return {
    source: "team_ai_fallback",
    kind: "team_ai.delegate.v1",
    reason: "out_of_scope",
    agent_member_id: TEAM_AI,
    notice_for_member_id: REQUESTER,
    run_id: "55555555-5555-4555-8555-555555555555",
    delegate: {
      source_message_id: SOURCE,
      candidates: [
        {
          member_id: GROK,
          handle: "grokbot",
          display_name: "그록봇",
          client_msg_id: "66666666-6666-5666-8666-666666666666",
        },
      ],
    },
    ...overrides,
  };
}

function approvalMessage(props: Record<string, unknown>): Message {
  return {
    id: "m1",
    workspaceId: "w",
    channelId: "c",
    authorMemberId: TEAM_AI,
    type: "approval_request",
    body: "승인 요청",
    props,
    state: "sent",
    seq: 1,
    hlcTs: 0,
    hlcCount: 0,
    createdAtMs: 0,
  } as unknown as Message;
}

describe("도우미 제안 표기 (ADR-0201 D6-3)", () => {
  it("team_ai 출처만 읽는다", () => {
    expect(
      parseTeamAiProposal({
        kind: "team_ai",
        requester_id: REQUESTER,
        requester_name: "김하늘",
      })
    ).toEqual({ kind: "team_ai", requesterId: REQUESTER, requesterName: "김하늘" });
  });

  it("모르는 kind 는 표기가 없다 (닫힌 세계)", () => {
    expect(parseTeamAiProposal({ kind: "someone_else", requester_name: "x" })).toBeNull();
    expect(parseTeamAiProposal(null)).toBeNull();
    expect(parseTeamAiProposal("team_ai")).toBeNull();
  });

  it("승인 카드 모델이 proposed_via 를 싣고, 없으면 싣지 않는다", () => {
    const withVia = agentCardModel(
      approvalMessage({
        approval_id: "a1",
        proposed_via: { kind: "team_ai", requester_id: REQUESTER, requester_name: "김하늘" },
      })
    );
    expect(withVia?.kind).toBe("approval");
    if (withVia?.kind !== "approval") throw new Error("not approval");
    expect(withVia.proposedVia?.requesterName).toBe("김하늘");
    // 그린 키는 「숨김」으로 세지 않는다.
    expect(withVia.detail.withheld).toBe(0);

    const plain = agentCardModel(approvalMessage({ approval_id: "a1" }));
    if (plain?.kind !== "approval") throw new Error("not approval");
    expect(plain.proposedVia).toBeUndefined();
  });

  it("이름을 모르면 지어내지 않는다", () => {
    expect(teamAiProposalLine("김하늘")).toBe("도우미 제안 · 요청: 김하늘");
    expect(teamAiProposalLine(null)).not.toContain("요청: ");
  });
});

describe("넘기는 줄과 맡기기 버튼 (ADR-0201 D5)", () => {
  it("서버 모양을 읽는다", () => {
    const parsed = parseTeamAiDelegate(delegateProps());
    expect(parsed).not.toBeNull();
    expect(parsed?.reason).toBe("out_of_scope");
    expect(parsed?.reasonLine).toBe("넘긴 이유: 도우미가 바로 하기엔 큰 일");
    expect(parsed?.sourceMessageId).toBe(SOURCE);
    expect(parsed?.candidates).toHaveLength(1);
    expect(delegateButtonLabel(parsed!.candidates[0]!)).toBe("그록봇에게 맡기기");
  });

  it("kind 가 다르면 아무 것도 아니다 (구서버·다른 줄)", () => {
    expect(parseTeamAiDelegate({ ...delegateProps(), kind: "team_ai.delegate.v2" })).toBeNull();
    expect(parseTeamAiDelegate({ reason: "slow" })).toBeNull();
    expect(parseTeamAiDelegate(undefined)).toBeNull();
  });

  it("모르는 이유는 이유 줄을 세우지 않는다", () => {
    expect(parseTeamAiDelegate(delegateProps({ reason: "mystery" }))?.reasonLine).toBeNull();
  });

  // 한도에 닿은 줄(#4944): 이유 코드는 `over_budget` 그대로이고 `props.limit = {source, window}` 만 더해진다.
  // 「오늘」이라고만 하면 월 한도와 운영자 끔에는 틀린 말이다.
  describe("한도에 닿은 줄은 props.limit 로 이유를 고른다", () => {
    const reasonLine = (limit: unknown) =>
      parseTeamAiDelegate(
        delegateProps({ reason: "over_budget", ...(limit === undefined ? {} : { limit }) })
      )?.reasonLine;

    it("limit 가 없는 줄(옛 서버)은 옛 줄 그대로 「오늘」이다", () => {
      expect(reasonLine(undefined)).toBe("넘긴 이유: 오늘 도우미 사용량을 다 씀");
      expect(reasonLine(null)).toBe("넘긴 이유: 오늘 도우미 사용량을 다 씀");
    });

    it("서버가 내는 네 짝이 각자 자기 말을 한다", () => {
      expect(reasonLine({ source: "team", window: "day" })).toBe("넘긴 이유: 오늘 도우미 사용량을 다 씀");
      expect(reasonLine({ source: "team", window: "month" })).toBe(
        "넘긴 이유: 이번 달 도우미 사용량을 다 씀"
      );
      expect(reasonLine({ source: "operator", window: "day" })).toBe(
        "넘긴 이유: 서버 운영자가 정한 오늘 사용량을 다 씀"
      );
      expect(reasonLine({ source: "operator", window: "off" })).toBe(
        "넘긴 이유: 서버 운영자가 도우미를 멈춰 둠"
      );
    });

    it("모르는 짝이나 깨진 모양은 창을 지어내지 않고 어느 창에도 맞는 말만 한다", () => {
      const neutral = "넘긴 이유: 도우미 사용량 한도에 닿음";
      expect(reasonLine({ source: "team", window: "week" })).toBe(neutral);
      expect(reasonLine({ source: "partner", window: "day" })).toBe(neutral);
      expect(reasonLine({ source: "team" })).toBe(neutral);
      expect(reasonLine("month")).toBe(neutral);
      expect(reasonLine([])).toBe(neutral);
    });

    it("다른 이유의 줄은 limit 를 읽지 않는다", () => {
      expect(
        parseTeamAiDelegate(delegateProps({ reason: "slow", limit: { source: "operator", window: "off" } }))
          ?.reasonLine
      ).toBe("넘긴 이유: 도우미가 제때 답하지 못함");
    });

    it("이유 코드는 limit 가 있어도 over_budget 이다", () => {
      expect(
        parseTeamAiDelegate(delegateProps({ reason: "over_budget", limit: { source: "team", window: "month" } }))
          ?.reason
      ).toBe("over_budget");
    });
  });

  it("멱등 키가 없는 후보는 버튼이 아니다", () => {
    const parsed = parseTeamAiDelegate(
      delegateProps({
        delegate: {
          source_message_id: SOURCE,
          candidates: [{ member_id: GROK, handle: "grokbot", display_name: "그록봇" }],
        },
      })
    );
    expect(parsed?.candidates).toEqual([]);
  });

  it("버튼은 요청자 본인에게만 선다", () => {
    const parsed = parseTeamAiDelegate(delegateProps())!;
    expect(canDelegate(parsed, REQUESTER)).toBe(true);
    expect(canDelegate(parsed, REQUESTER.toUpperCase())).toBe(true);
    expect(canDelegate(parsed, GROK)).toBe(false);
    expect(canDelegate(parsed, undefined)).toBe(false);
    const noRequester = parseTeamAiDelegate(delegateProps({ notice_for_member_id: null }))!;
    expect(canDelegate(noRequester, REQUESTER)).toBe(false);
  });

  it("맡기는 본문은 도우미 멘션을 지우고 대상을 부른다", () => {
    expect(
      delegateMessageBody({
        targetHandle: "grokbot",
        sourceBody: "@oort-helper 이 레포 테스트 고쳐 줘",
        teamAiHandles: ["oort-helper"],
      })
    ).toBe("@grokbot 이 레포 테스트 고쳐 줘");
    // 문장 끝 마침표·디렉터리 handle·대문자도 지운다. 비슷한 다른 handle 은 남긴다.
    expect(
      delegateMessageBody({
        targetHandle: "grokbot",
        sourceBody: "채널 만들어 줘 @Team-Helper. @oort-helper2 도 봐",
        teamAiHandles: ["team-helper"],
      })
    ).toBe("@grokbot 채널 만들어 줘 . @oort-helper2 도 봐");
    expect(
      delegateMessageBody({ targetHandle: "grokbot", sourceBody: "@oort-helper", teamAiHandles: [] })
    ).toBe("@grokbot 인용한 요청을 맡아 주세요.");
    expect(
      delegateMessageBody({ targetHandle: "grokbot", sourceBody: null, teamAiHandles: [] })
    ).toBe("@grokbot 인용한 요청을 맡아 주세요.");
  });
});

describe("맡기는 메시지와 별칭 (ADR-0201 v2 H2, #3893)", () => {
  it("@oort·@오르트 로 부른 요청을 맡기면 도우미 이름을 모두 지운다", () => {
    expect(
      delegateMessageBody({
        targetHandle: "grokbot",
        sourceBody: "@oort @오르트 PR 리뷰해 줘",
        teamAiHandles: ["oort-helper", "oort", "오르트", "claude"],
      })
    ).toBe("@grokbot PR 리뷰해 줘");
  });

  it("「@오르트에게」는 서버 경계 규칙상 부른 것이 아니라서 남긴다", () => {
    expect(
      delegateMessageBody({
        targetHandle: "grokbot",
        sourceBody: "@오르트에게 물어봤는데",
        teamAiHandles: ["오르트"],
      })
    ).toBe("@grokbot @오르트에게 물어봤는데");
  });

  it("별칭을 넘기지 않으면(옛 서버) @oort 는 남는다 — 다른 멤버일 수 있다", () => {
    expect(
      delegateMessageBody({ targetHandle: "grokbot", sourceBody: "@oort 해 줘", teamAiHandles: [] })
    ).toBe("@grokbot @oort 해 줘");
  });
});
