// ADR-0201 증보 v2 H8 (#3893): 키 저장 뒤 다음 단계 카드의 판정과 문구.
import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import {
  readTeamAiAliasStatus,
  readTeamAiNameStatus,
  TEAM_AI_NEXT_STEP_COPY,
  teamAiAliasNotices,
  teamAiCallableLine,
  teamAiNextStepView,
  teamAiSeedName,
  teamAiTryLabel,
} from "./teamAiNextStep";
import {
  readTeamAiSwitch,
  teamAiHelperName,
  teamAiSectionTitle,
  teamAiSwitchDescription,
} from "./teamAiSwitch";

const resolved = { linkPosition: 0, endpointLabel: "api.anthropic.com", linkResolved: true, modelId: null };

function view(over: Partial<Parameters<typeof teamAiNextStepView>[0]> = {}) {
  const bag = { team_ai_fast_path: false };
  return teamAiNextStepView({
    bag,
    state: readTeamAiSwitch(bag),
    support: undefined,
    keySaved: true,
    defaultAi: { teamAgent: resolved, summary: null },
    ...over,
  });
}

describe("teamAiNextStepView", () => {
  it("키가 있고 꺼져 있고 서버가 스위치를 알면 단계를 세운다", () => {
    expect(view()).toEqual({ kind: "steps", defaultReady: true, defaultStale: false });
  });

  it("숨는 경우: 가방 없음(구성원), 키 없음, 이미 켜짐, 기본 AI 표 못 읽음", () => {
    expect(view({ state: null }).kind).toBe("hidden");
    expect(view({ keySaved: false }).kind).toBe("hidden");
    const on = { team_ai_fast_path: true };
    expect(view({ bag: on, state: readTeamAiSwitch(on) }).kind).toBe("hidden");
    expect(view({ defaultAi: null }).kind).toBe("hidden");
  });

  it("옛 서버: 가방에 키가 없으면 물음이 ready 일 때만 선다", () => {
    const empty = {};
    const state = readTeamAiSwitch(empty);
    expect(view({ bag: empty, state, support: undefined }).kind).toBe("hidden");
    expect(view({ bag: empty, state, support: "absent" }).kind).toBe("hidden");
    expect(view({ bag: empty, state, support: "unknown" }).kind).toBe("hidden");
    expect(view({ bag: empty, state, support: "ready" }).kind).toBe("steps");
  });

  it("1단계: 줄이 없으면 할 일, 안 풀리면 다시 고르기", () => {
    expect(view({ defaultAi: { teamAgent: null, summary: null } })).toEqual({
      kind: "steps",
      defaultReady: false,
      defaultStale: false,
    });
    expect(
      view({ defaultAi: { teamAgent: { ...resolved, linkResolved: false }, summary: null } })
    ).toEqual({ kind: "steps", defaultReady: false, defaultStale: true });
  });
});

describe("별칭 상태와 채울 이름", () => {
  const helper = {
    id: "m-helper",
    kind: "agent",
    status: "active",
    handle: "oort-helper",
    displayName: "oort 도우미",
  } as RosterMember;

  it("S1 이전 서버(키 없음): 도우미 핸들을 채운다. 부르지 못하는 @oort 를 채우지 않는다", () => {
    expect(readTeamAiAliasStatus({ team_ai_fast_path: true })).toBeNull();
    expect(teamAiSeedName(null, helper)).toBe("oort-helper");
    expect(teamAiSeedName(null, undefined)).toBe("oort-helper");
  });

  it("oort 가 등록되면 @oort, 막혔으면 다음 ASCII 별칭, 한글만 남으면 핸들", () => {
    const all = readTeamAiAliasStatus({
      team_ai_alias_status: { claude: "taken", oort: "registered", 오르트: "registered", junk: "x" },
    });
    expect(all).toEqual([
      { alias: "oort", state: "registered" },
      { alias: "오르트", state: "registered" },
      { alias: "claude", state: "taken" },
    ]);
    expect(teamAiSeedName(all, helper)).toBe("oort");
    const oortTaken = readTeamAiAliasStatus({
      team_ai_alias_status: { oort: "taken", 오르트: "registered", claude: "registered" },
    });
    expect(teamAiSeedName(oortTaken, helper)).toBe("claude");
    const koreanOnly = readTeamAiAliasStatus({
      team_ai_alias_status: { oort: "taken", 오르트: "registered", claude: "taken" },
    });
    expect(teamAiSeedName(koreanOnly, helper)).toBe("oort-helper");
  });

  it("문장: 부르는 이름, 막힌 별칭은 누가 쓰는지, 이름 겹침 경고", () => {
    const status = readTeamAiAliasStatus({
      team_ai_alias_status: { oort: "display_name_match", 오르트: "registered", claude: "taken" },
    });
    expect(teamAiCallableLine(status)).toBe("부르는 이름: @oort · @오르트");
    expect(teamAiAliasNotices(status, (alias) => (alias === "claude" ? "김하늘" : null))).toEqual([
      "표시 이름이 「oort」인 멤버가 있어요. @oort는 oort 도우미를 불러요.",
      "@claude는 이미 김하늘이 쓰고 있어서 연결하지 않았어요.",
    ]);
    expect(teamAiAliasNotices(status, () => null)[1]).toBe(
      "@claude는 이미 다른 멤버가 쓰고 있어서 연결하지 않았어요."
    );
    expect(teamAiTryLabel("마케팅", "oort")).toBe("#마케팅에서 @oort 불러 보기");
    expect(teamAiTryLabel(null, "oort-helper")).toBe("채널에서 @oort-helper 불러 보기");
  });
});

describe("이름을 바꾸면 별칭이 따라간다 (#4966 결과를 보인다, #4945)", () => {
  it("기본 셋 뒤에 새 이름의 별칭이 더해져 읽힌다. @name 키는 별칭이 아니다", () => {
    const status = readTeamAiAliasStatus({
      team_ai_alias_status: {
        "@name": "not_derivable",
        비서봇: "registered",
        claude: "registered",
        oort: "registered",
        오르트: "registered",
      },
    });
    expect(status?.map((entry) => entry.alias)).toEqual(["oort", "오르트", "claude", "비서봇"]);
    expect(teamAiCallableLine(status)).toBe("부르는 이름: @oort · @오르트 · @claude · @비서봇");
    expect(readTeamAiNameStatus({ team_ai_alias_status: { "@name": "not_derivable" } })).toBe("not_derivable");
    expect(readTeamAiNameStatus({ team_ai_alias_status: { "@name": "reserved" } })).toBe("reserved");
    expect(readTeamAiNameStatus({ team_ai_alias_status: { "@name": "x", oort: "registered" } })).toBeNull();
    expect(readTeamAiNameStatus({})).toBeNull();
  });
});

describe("문구는 도우미의 표시 이름을 따라간다 (ADR-0201 증보 v3 B10-7, #4945)", () => {
  it("멤버가 있으면 그 이름, 없으면 기본 이름을 문구에 채우고 「oort 도우미」를 글자로 쓰지 않는다", () => {
    expect(teamAiHelperName({ displayName: " 비서봇 " })).toBe("비서봇");
    expect(teamAiHelperName(null)).toBe("oort 도우미");
    expect(teamAiHelperName({ displayName: "  " })).toBe("oort 도우미");
    const name = teamAiHelperName({ displayName: "비서봇" });
    const sentences = [
      TEAM_AI_NEXT_STEP_COPY.title(name),
      TEAM_AI_NEXT_STEP_COPY.lead(name),
      TEAM_AI_NEXT_STEP_COPY.step2Title(name),
      TEAM_AI_NEXT_STEP_COPY.step2Action(name),
      TEAM_AI_NEXT_STEP_COPY.enabled(name),
      teamAiSectionTitle(name),
      teamAiSwitchDescription(name),
      ...teamAiAliasNotices(
        readTeamAiAliasStatus({ team_ai_alias_status: { oort: "display_name_match" } }),
        () => null,
        name
      ),
    ];
    for (const sentence of sentences) {
      expect(sentence, sentence).toContain("비서봇");
      expect(sentence, sentence).not.toContain("oort 도우미");
    }
    expect(TEAM_AI_NEXT_STEP_COPY.enabled("비서봇")).toBe("비서봇을 켰어요.");
    expect(TEAM_AI_NEXT_STEP_COPY.enabled("Hermes")).toBe("Hermes를 켰어요.");
  });
});
