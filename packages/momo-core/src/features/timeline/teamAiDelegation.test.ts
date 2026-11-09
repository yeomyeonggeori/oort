// ADR-0201 증보 v4 P8·P15-A15 (#5374): 도우미 답의 「Hermes 도움」 칩은 서버 소유 키 `team_ai_delegated`에서만 읽는다.
import { describe, expect, it } from "vitest";
import {
  MAX_TEAM_AI_DELEGATIONS,
  TEAM_AI_DELEGATED_PROPS_KEY,
  TEAM_AI_DELEGATION_KINDS,
  teamAiDelegationsFor,
  teamAiDelegationsOf,
} from "./teamAiDelegation";
import { parseTeamAiReplyMeta } from "./teamAiReply";
import {
  TEAM_AI_DELEGATION_CHIP_COPY,
  TEAM_AI_DELEGATION_REASON_COPY,
} from "../settings/teamAiCopyKeys";
import { TEAM_AI_DELEGATION_CLOSED_WORDS } from "../settings/teamAiLimits";
import { argumentSpecs, messageKeys } from "../../i18n/generated/messages";

const HERMES = "0195f0a8-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
const OTHER = "0195f0a8-1c2d-7e3f-8a4b-5c6d7e8f9a0c";
const RUN = "0195f0a8-0000-7000-8000-000000000001";

/** 서버 `team_ai_finish`가 위임이 끝난 답에 쓰는 모양 그대로(`source`·`run_id`·`team_ai_model` + 칩 칸). */
function answer(delegated: unknown): Record<string, unknown> {
  return {
    source: "team_ai",
    run_id: RUN,
    team_ai_model: { model: "claude-x", wire: "messages" },
    [TEAM_AI_DELEGATED_PROPS_KEY]: delegated,
  };
}

describe("team_ai_delegated 읽기", () => {
  it("서버가 쓴 한 칸을 읽는다: 종류와 Hermes 멤버 id(소문자)", () => {
    expect(TEAM_AI_DELEGATED_PROPS_KEY).toBe("team_ai_delegated");
    expect(teamAiDelegationsOf(answer([{ kind: "web_search", agent_member_id: HERMES }]))).toEqual([
      { kind: "web_search", agentMemberId: HERMES },
    ]);
    expect(
      teamAiDelegationsOf(answer([{ kind: "image", agent_member_id: HERMES.toUpperCase() }]))
    ).toEqual([{ kind: "image", agentMemberId: HERMES }]);
    expect(TEAM_AI_DELEGATION_KINDS).toEqual(["image", "web_search"]);
  });

  it("칩이 없는 답은 빈 배열이다: 옛 서버, 맡기지 않은 답, 키가 배열이 아님", () => {
    expect(teamAiDelegationsOf(undefined)).toEqual([]);
    expect(teamAiDelegationsOf({ source: "team_ai", run_id: RUN })).toEqual([]);
    for (const shape of [null, "image", { kind: "image", agent_member_id: HERMES }, 1]) {
      expect(teamAiDelegationsOf(answer(shape)), JSON.stringify(shape)).toEqual([]);
    }
  });

  it("도우미 답(`source: team_ai`)이 아니면 같은 키가 있어도 칩이 아니다 — 사람·웹훅·다른 에이전트의 글", () => {
    const forged = { [TEAM_AI_DELEGATED_PROPS_KEY]: [{ kind: "image", agent_member_id: HERMES }] };
    expect(teamAiDelegationsOf(forged)).toEqual([]);
    expect(teamAiDelegationsOf({ ...forged, source: "hermes_gateway" })).toEqual([]);
    expect(teamAiDelegationsOf({ ...forged, source: "TEAM_AI" })).toEqual([]);
  });

  it("모르는 종류·id가 아닌 값·모양이 다른 항목은 버리고 나머지를 읽는다", () => {
    expect(
      teamAiDelegationsOf(
        answer([
          { kind: "video", agent_member_id: HERMES },
          { kind: "image", agent_member_id: "hermes" },
          { kind: "image", agent_member_id: `${HERMES} ` },
          { kind: "image" },
          { agent_member_id: HERMES },
          "image",
          null,
          { kind: "web_search", agent_member_id: OTHER },
        ])
      )
    ).toEqual([{ kind: "web_search", agentMemberId: OTHER }]);
  });

  it("같은 종류·같은 Hermes는 한 번만, 서버 순서대로, 많아야 상한까지", () => {
    expect(
      teamAiDelegationsOf(
        answer([
          { kind: "image", agent_member_id: HERMES },
          { kind: "image", agent_member_id: HERMES.toUpperCase() },
          { kind: "web_search", agent_member_id: HERMES },
        ])
      )
    ).toEqual([
      { kind: "image", agentMemberId: HERMES },
      { kind: "web_search", agentMemberId: HERMES },
    ]);
    const many = Array.from({ length: 10 }, (_, i) => ({
      kind: i % 2 === 0 ? "image" : "web_search",
      agent_member_id: `0195f0a8-1c2d-7e3f-8a4b-5c6d7e8f9a${String(i).padStart(2, "0")}`,
    }));
    expect(teamAiDelegationsOf(answer(many))).toHaveLength(MAX_TEAM_AI_DELEGATIONS);
  });

  it("지워진 답에는 칩이 없다", () => {
    const props = answer([{ kind: "image", agent_member_id: HERMES }]);
    expect(teamAiDelegationsFor({ props, state: "sent" })).toHaveLength(1);
    expect(teamAiDelegationsFor({ props, state: "deleted" })).toEqual([]);
  });

  it("칩 칸만 있는 답은 기존 꼬리(찾아본 것·출처·모델 칩)를 새로 세우지 않는다 — 화면의 꼬리는 그대로다", () => {
    expect(
      parseTeamAiReplyMeta({
        source: "team_ai",
        run_id: RUN,
        [TEAM_AI_DELEGATED_PROPS_KEY]: [{ kind: "image", agent_member_id: HERMES }],
      })
    ).toBeNull();
  });
});

describe("칩·까닭의 사전 키", () => {
  const keys = new Set<string>(messageKeys);

  it("칩은 종류마다 이름 하나({name})를 받는 키다 — 이름은 그 Hermes의 지금 표시 이름", () => {
    for (const kind of TEAM_AI_DELEGATION_KINDS) {
      const key = TEAM_AI_DELEGATION_CHIP_COPY[kind];
      expect(keys.has(key), key).toBe(true);
      expect(Object.keys(argumentSpecs[key] ?? {}), key).toEqual(["name"]);
    }
  });

  it("문이 닫힌 낱말마다(그리고 unknown까지) 사전 문장이 있다", () => {
    for (const word of [...TEAM_AI_DELEGATION_CLOSED_WORDS, "unknown"] as const) {
      const key = TEAM_AI_DELEGATION_REASON_COPY[word];
      expect(keys.has(key), word).toBe(true);
      expect(Object.keys(argumentSpecs[key] ?? {}), word).toEqual([]);
    }
    expect(keys.has("teamAi.delegation.unavailable")).toBe(true);
  });
});
