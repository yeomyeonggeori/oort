// ADR-0201 증보 v4 P8·P15-A15 (#5375): 위임이 끝난 답의 화면 모델 — 칩·그림 자리·쓴 양 줄은 서버 소유 칸에서만 선다.
import { describe, expect, it } from "vitest";
import { TEAM_AI_DELEGATED_PROPS_KEY } from "./teamAiDelegation";
import {
  compactTokenText,
  TEAM_AI_DELEGATION_DEADLINE_MS,
  TEAM_AI_SPENT_LINE_SIZER,
  teamAiDelegationWait,
  teamAiDelegatedAnswerOf,
  teamAiSpentLineOf,
} from "./teamAiDelegationView";

const HERMES = "0195f0a8-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
const RUN = "0195F0A8-0000-7000-8000-000000000001";

function answer(delegated: unknown, extra: Record<string, unknown> = {}) {
  return {
    state: "sent" as const,
    props: { source: "team_ai", run_id: RUN, [TEAM_AI_DELEGATED_PROPS_KEY]: delegated, ...extra },
  };
}

describe("teamAiDelegatedAnswerOf", () => {
  it("그림을 맡긴 도우미 답: 칩 하나·run id(소문자)·그림 자리", () => {
    const view = teamAiDelegatedAnswerOf(answer([{ kind: "image", agent_member_id: HERMES }]), "agent");
    expect(view).toEqual({
      delegations: [{ kind: "image", agentMemberId: HERMES }],
      runId: RUN.toLowerCase(),
      picture: true,
    });
  });

  it("검색을 맡긴 답은 그림 자리를 잡지 않는다", () => {
    const view = teamAiDelegatedAnswerOf(answer([{ kind: "web_search", agent_member_id: HERMES }]), "agent");
    expect(view?.picture).toBe(false);
    expect(view?.delegations).toHaveLength(1);
  });

  it("서버 소유 칸이 없으면, 사람이 같은 키를 썼으면, 지워졌으면 아무것도 없다", () => {
    // 칸이 없는 도우미 답(운영 꺼짐·맡기지 않음·맡겼다 실패) — 새로 보이는 것이 없다.
    expect(teamAiDelegatedAnswerOf({ state: "sent", props: { source: "team_ai", run_id: RUN } }, "agent")).toBeNull();
    // 사람이 같은 키를 보낸 메시지(서버가 벗기지만 화면도 작성자 종류를 본다, #5577).
    const forged = answer([{ kind: "image", agent_member_id: HERMES }]);
    expect(teamAiDelegatedAnswerOf(forged, "human")).toBeNull();
    expect(teamAiDelegatedAnswerOf(forged, undefined)).toBeNull();
    expect(teamAiDelegatedAnswerOf({ ...forged, state: "deleted" }, "agent")).toBeNull();
  });

  it("run id가 없으면 칩은 서고 쓴 양을 읽을 곳은 없다", () => {
    const view = teamAiDelegatedAnswerOf(
      { state: "sent", props: { source: "team_ai", [TEAM_AI_DELEGATED_PROPS_KEY]: [{ kind: "image", agent_member_id: HERMES }] } },
      "agent"
    );
    expect(view?.runId).toBeNull();
    expect(view?.picture).toBe(true);
  });
});

describe("쓴 양 줄", () => {
  it("짧은 토큰 글자는 버림이고 언어와 상관없다", () => {
    expect(compactTokenText(0)).toBe("0");
    expect(compactTokenText(999)).toBe("999");
    expect(compactTokenText(1_000)).toBe("1k");
    expect(compactTokenText(12_345)).toBe("12.3k");
    expect(compactTokenText(12_399)).toBe("12.3k");
    expect(compactTokenText(999_999)).toBe("999.9k");
    expect(compactTokenText(1_250_000)).toBe("1.2M");
    expect(compactTokenText(-5)).toBe("0");
    expect(compactTokenText(Number.NaN)).toBe("0");
  });

  it("run의 spent 그대로: 도우미 행의 토큰 합·어림 표지·Hermes 횟수", () => {
    expect(
      teamAiSpentLineOf({ promptTokens: 9_000, completionTokens: 3_345, webSearches: 0, estimated: false, delegations: 1 })
    ).toEqual({ tokens: "12.3k", estimated: false, delegations: 1 });
    expect(
      teamAiSpentLineOf({ promptTokens: 400, completionTokens: 120, webSearches: 0, estimated: true, delegations: 0 })
    ).toEqual({ tokens: "520", estimated: true, delegations: 0 });
  });

  it("spent가 없으면 줄의 사실도 없다(숫자를 지어내지 않는다)", () => {
    expect(teamAiSpentLineOf(undefined)).toBeNull();
  });

  it("자리를 잡는 값은 가장 넓은 갈래다(어림 문구 + Hermes 조각)", () => {
    expect(TEAM_AI_SPENT_LINE_SIZER.estimated).toBe(true);
    expect(TEAM_AI_SPENT_LINE_SIZER.delegations).toBeGreaterThan(0);
    // 실제로 나올 수 있는 짧은 글자 중 가장 넓은 모양(소수 한 자리 + 단위)보다 짧지 않다.
    for (const count of [999_999, 99_999, 9_999_999]) {
      expect(TEAM_AI_SPENT_LINE_SIZER.tokens.length).toBeGreaterThanOrEqual(compactTokenText(count).length);
    }
  });
});

describe("teamAiDelegationWait (위임을 기다리는 동안의 진행 줄)", () => {
  const STAGE_AT = 1_000_000;
  const SPENT_ROW = { promptTokens: 1, completionTokens: 1, webSearches: 0, estimated: false, delegations: 0 };
  const run = (latestStage: string, spent: typeof SPENT_ROW | null = SPENT_ROW) => ({
    latestStage,
    lastEventAtMs: STAGE_AT,
    ...(spent === null ? {} : { spent }),
  });

  it("그림: stage 시각부터 120초 안이면 기다림(60초·100초), 넘으면 아니다(130초)", () => {
    const image = run("위임: 팀 Hermes · 그림");
    expect(teamAiDelegationWait(image, STAGE_AT + 60_000)).toEqual({
      kind: "image",
      untilMs: STAGE_AT + TEAM_AI_DELEGATION_DEADLINE_MS.image,
      minutes: 2,
    });
    expect(teamAiDelegationWait(image, STAGE_AT + 100_000)?.kind).toBe("image");
    expect(teamAiDelegationWait(image, STAGE_AT + 120_000)).toBeNull();
    expect(teamAiDelegationWait(image, STAGE_AT + 130_000)).toBeNull();
  });

  it("검색: 60초 마감, 1분", () => {
    const search = run("위임: 팀 Hermes · 검색");
    expect(teamAiDelegationWait(search, STAGE_AT + 50_000)).toMatchObject({ kind: "web_search", minutes: 1 });
    expect(teamAiDelegationWait(search, STAGE_AT + 70_000)).toBeNull();
  });

  it("받은 뒤·머리 낱말·다른 stage·도우미 작업 run이 아닌 run은 기다림이 아니다", () => {
    expect(teamAiDelegationWait(run("위임 결과 수신: 팀 Hermes"), STAGE_AT + 10_000)).toBeNull();
    expect(teamAiDelegationWait(run("위임 중"), STAGE_AT + 10_000)).toBeNull();
    expect(teamAiDelegationWait(run("조사 중 · 1／3 · 가격 비교"), STAGE_AT + 10_000)).toBeNull();
    // 바깥 에이전트가 스스로 쓴 같은 모양의 stage(작업 run이 아니라 spent가 없다).
    expect(teamAiDelegationWait(run("위임: 하위봇 · 그림", null), STAGE_AT + 10_000)).toBeNull();
  });
});
