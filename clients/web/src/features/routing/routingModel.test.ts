import { describe, expect, it } from "vitest";
import fixtures from "./routingFixtures.json";
import {
  INHERIT_DRAFT,
  agentEffortInheritLabel,
  agentModelInheritLabel,
  appliedModelLabel,
  applyModelChange,
  clearedEffortNotice,
  draftEquals,
  draftFromProfile,
  effectiveModel,
  effortLabel,
  effortsForModel,
  ignoredEffortNotice,
  inheritedEffortLabel,
  inheritedModelLabel,
  isOverride,
  knownAgentModels,
  modelOptions,
  parseEffortTable,
  resolveInheritance,
  routingPayload,
  supportsEffort,
  type EffortTable,
  type RoutingDraft,
  type RoutingProfile,
} from "./routingModel";
import { mentionRoutingTarget, mentionedHandles } from "./mentionTargets";
import type { RosterMember } from "@/lib/api";

// =============================================================================
// ADR-0134 계약 픽스처로 고정하는 세 경로: 상속 / 오버라이드 / 무효 클리어.
//
// 픽스처는 track/engine의 ProviderEffortTableRoutes.swift를 그대로 옮긴 것이고,
// 검증 기준도 서버의 RunRoutingResolution과 같은 판정이다. 엔진층이 아직 붙지
// 않은 서버 앞에서 이 UI가 무엇을 약속해도 되는지가 여기서 결정된다.
// =============================================================================

const table = parseEffortTable(fixtures.effortTable) as EffortTable;

describe("parseEffortTable", () => {
  it("서버 표를 provider x model 행으로 편다", () => {
    expect(table).not.toBeNull();
    expect(table.schema).toBe("momo.provider.effort_table.v0");
    expect(table.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(table.entries).toHaveLength(4);
    expect(table.entries[0]).toEqual({
      provider: "hermes",
      model: "hermes-agent",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    });
  });

  it("모르는 모양은 부분적으로 채우지 않고 null이다", () => {
    expect(parseEffortTable(null)).toBeNull();
    expect(parseEffortTable({ schema: "x" })).toBeNull();
    expect(
      parseEffortTable({ ...fixtures.effortTable, providers: [{ provider: "hermes" }] })
    ).toBeNull();
    // efforts 안에 문자열이 아닌 값이 하나라도 있으면 표 전체를 버린다.
    expect(
      parseEffortTable({
        ...fixtures.effortTable,
        providers: [{ provider: "hermes", models: [{ model: "m", efforts: [1], defaultEffort: "low" }] }],
      })
    ).toBeNull();
  });
});

describe("유효값은 모델마다 다르다 (D2)", () => {
  it("모델별 집합을 그대로 쓴다", () => {
    expect(effortsForModel(table, "hermes-agent").efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortsForModel(table, "hermes-fast").efforts).toEqual(["low", "medium"]);
    expect(effortsForModel(table, "hermes-fast").defaultEffort).toBe("low");
  });

  it("표에 없는 모델은 보수적인 fallback 집합을 받는다", () => {
    const unknown = effortsForModel(table, "gpt-5.6-sol");
    expect(unknown.listed).toBe(false);
    expect(unknown.efforts).toEqual(["low", "medium", "high"]);
    expect(supportsEffort(table, "gpt-5.6-sol", "max")).toBe(false);
  });

  it("서버 게이트와 같은 판정을 낸다", () => {
    expect(supportsEffort(table, "hermes-agent", "max")).toBe(true);
    expect(supportsEffort(table, "hermes-fast", "max")).toBe(false);
  });

  it("피커 목록은 표 + 이 에이전트가 실제로 쓰는 모델이다", () => {
    expect(modelOptions(table, "hermes-agent")).toEqual([
      "hermes-agent",
      "hermes-default",
      "hermes-fast",
      "hermes-lite",
    ]);
    expect(modelOptions(table, "claude-opus-5")).toContain("claude-opus-5");
  });

  it("표가 없어도 모델 축은 고를 수 있다", () => {
    // 모델은 ADR-0131 D2라 모든 세대의 서버가 가지고 있고, 표는 ADR-0134 D2라
    // 아직 없는 서버가 있다. 표를 목록의 유일한 출처로 두면 표가 없는 서버에서
    // MOMO-537(에이전트 기본 모델 편집)이 통째로 사라진다(R1 B2).
    expect(
      modelOptions(null, "hermes-agent", ["hermes-fast", "hermes-agent"])
    ).toEqual(["hermes-fast", "hermes-agent"]);
    expect(modelOptions(null, "")).toEqual([]);
  });

  it("로스터의 에이전트 모델은 중복 없이 등장 순서대로 모은다", () => {
    expect(
      knownAgentModels([
        { kind: "agent", agentModel: "hermes-fast" },
        { kind: "human", agentModel: null },
        { kind: "agent", agentModel: "hermes-fast" },
        { kind: "agent", agentModel: " hermes-agent " },
        { kind: "agent", agentModel: "" },
        { kind: "agent" },
      ])
    ).toEqual(["hermes-fast", "hermes-agent"]);
  });

  it("모델이 비어 있으면 적용 줄도 '지정 없음'이라고 말한다", () => {
    // 빈 문자열을 그대로 문장에 끼우면 "모델 , 추론 강도 …"가 된다(R1 M4).
    expect(appliedModelLabel("")).toBe("지정 없음");
    expect(appliedModelLabel("   ")).toBe("지정 없음");
    expect(appliedModelLabel("hermes-fast")).toBe("hermes-fast");
  });

  it("모르는 토큰은 서버가 준 그대로 보여준다", () => {
    expect(effortLabel("xhigh")).toBe("매우 높음");
    expect(effortLabel("ultra")).toBe("ultra");
  });
});

describe("픽스처 1: 상속", () => {
  // 픽스처는 REST 응답 그대로라 라우팅 밖 필드까지 들고 있다. 이 모델이 보는
  // 부분만 좁혀서 넘긴다.
  const scenario = fixtures.inherit;
  const profile = scenario.profile as RoutingProfile;

  it("프로필이 비어 있으면 모델은 에이전트 기본, 강도는 지정 없음", () => {
    const inheritance = resolveInheritance(table, scenario.agentModel, profile);
    expect(inheritance.model).toEqual({ value: "hermes-agent", source: "agent" });
    expect(inheritance.effort).toEqual({ value: null, source: "none" });
    expect(inheritance.ignoredEffortPref).toBeNull();
  });

  it("표의 기본값을 적용값으로 승격하지 않는다", () => {
    const inheritance = resolveInheritance(table, scenario.agentModel, profile);
    // 서버는 이 경우 effort를 아예 보내지 않는다(RunRoutingResolution).
    expect(inheritance.effort.value).toBeNull();
    expect(inheritance.modelDefaultEffort).toBe("medium");
  });

  it("상속 라벨에 실제값이 함께 적힌다 (D3)", () => {
    const inheritance = resolveInheritance(table, scenario.agentModel, profile);
    expect(inheritedModelLabel(inheritance)).toBe("상속 (에이전트 기본: hermes-agent)");
    expect(inheritedEffortLabel(inheritance)).toBe("상속 (지정 없음, 모델 기본 보통)");
  });

  it("상속만 있는 초안은 요청에 아무 키도 싣지 않는다", () => {
    const draft = draftFromProfile(profile);
    expect(draft).toEqual(INHERIT_DRAFT);
    expect(isOverride(draft)).toBe(false);
    expect(routingPayload(draft)).toBeUndefined();
  });
});

describe("픽스처 2: 오버라이드", () => {
  const scenario = fixtures.override;
  const profile = scenario.profile as RoutingProfile;

  it("프로필 층이 상속의 상대가 된다", () => {
    const inheritance = resolveInheritance(table, scenario.agentModel, profile);
    expect(inheritance.model).toEqual({ value: "hermes-fast", source: "profile" });
    expect(inheritance.effort).toEqual({ value: "low", source: "profile" });
    expect(inheritedModelLabel(inheritance)).toBe("상속 (프로필: hermes-fast)");
    expect(inheritedEffortLabel(inheritance)).toBe("상속 (프로필: 낮음)");
  });

  it("이번 요청만 올린 값이 그대로 routing 블록이 된다", () => {
    const draft = scenario.draft as RoutingDraft;
    expect(isOverride(draft)).toBe(true);
    expect(routingPayload(draft)).toEqual(scenario.expectedRouting);
  });

  it("오버라이드가 프로필 저장값과 다르다는 것을 구분한다", () => {
    const saved = draftFromProfile(profile);
    expect(draftEquals(saved, scenario.draft as RoutingDraft)).toBe(false);
    expect(effectiveModel(scenario.draft as RoutingDraft, "hermes-fast")).toBe(
      "hermes-agent"
    );
  });

  it("한쪽만 오버라이드하면 그 키만 실린다", () => {
    expect(routingPayload({ model: null, effort: "high" })).toEqual({ effort: "high" });
    expect(routingPayload({ model: "hermes-lite", effort: null })).toEqual({
      model: "hermes-lite",
    });
  });
});

describe("픽스처 3: 무효 클리어", () => {
  const scenario = fixtures.invalidClear;
  const profile = scenario.profile as RoutingProfile;

  it("모델을 바꾸면 못 받는 강도를 비우고 무엇을 비웠는지 말한다 (D3)", () => {
    const draft = draftFromProfile(profile);
    expect(draft).toEqual({ model: "hermes-agent", effort: "max" });

    const result = applyModelChange(table, draft, scenario.nextModel, scenario.agentModel);
    expect(result.draft).toEqual({ model: "hermes-fast", effort: null });
    expect(result.clearedEffort).toBe("max");
    expect(routingPayload(result.draft)).toEqual(scenario.expectedRouting);
  });

  it("안내 문구는 무엇이 왜 비워졌는지 적고 조사를 계산한다", () => {
    expect(clearedEffortNotice("hermes-fast", "max")).toBe(
      "hermes-fast는 추론 강도 최대를 지원하지 않아 상속으로 되돌렸습니다."
    );
    // 한글로 끝나는 모델 핸들도 같은 규칙으로 붙는다.
    expect(clearedEffortNotice("빠른모델", "high")).toContain("빠른모델은");
  });

  it("받을 수 있는 모델로 바꾸면 강도는 그대로 남는다", () => {
    const draft: RoutingDraft = { model: "hermes-agent", effort: "max" };
    const result = applyModelChange(table, draft, "hermes-default", "hermes-agent");
    expect(result.draft).toEqual({ model: "hermes-default", effort: "max" });
    expect(result.clearedEffort).toBeNull();
  });

  it("모델을 상속으로 되돌릴 때도 같은 검사를 받는다", () => {
    // 상속 모델이 hermes-fast인 에이전트에서 오버라이드만 걷으면 max가 남는다.
    const draft: RoutingDraft = { model: "hermes-agent", effort: "max" };
    const result = applyModelChange(table, draft, null, "hermes-fast");
    expect(result.draft).toEqual({ model: null, effort: null });
    expect(result.clearedEffort).toBe("max");
  });

  it("프로필이 저장한 강도가 지금 모델에서 죽어 있으면 그 사실을 노출한다", () => {
    // 프로필이 hermes-fast + max를 들고 있으면 서버는 max를 조용히 버린다.
    const inheritance = resolveInheritance(table, "hermes-agent", {
      modelPref: "hermes-fast",
      effortPref: "max",
    });
    expect(inheritance.effort).toEqual({ value: null, source: "none" });
    expect(inheritance.ignoredEffortPref).toBe("max");
    expect(ignoredEffortNotice("hermes-fast", "max")).toBe(
      "프로필에 저장된 추론 강도 최대는 hermes-fast에서 쓸 수 없어 적용되지 않습니다."
    );
  });
});

describe("표를 못 받은 서버 (엔진층 미반영)", () => {
  it("모델 층은 그대로 계산된다", () => {
    const inheritance = resolveInheritance(null, "hermes-agent", {
      modelPref: "hermes-fast",
    });
    expect(inheritance.model).toEqual({ value: "hermes-fast", source: "profile" });
    expect(inheritedModelLabel(inheritance)).toBe("상속 (프로필: hermes-fast)");
  });

  it("유효값을 잴 자가 없으므로 버려질 것이라고 주장하지 않는다", () => {
    const inheritance = resolveInheritance(null, "hermes-agent", {
      modelPref: "hermes-fast",
      effortPref: "max",
    });
    // 표가 있었다면 max는 hermes-fast에서 무효라 ignored가 됐겠지만, 여기서는
    // 판정 근거가 없다. 모르는 것을 아는 척하지 않는다.
    expect(inheritance.effort).toEqual({ value: "max", source: "profile" });
    expect(inheritance.ignoredEffortPref).toBeNull();
  });

  it("모델 기본값을 지어내지 않는다", () => {
    const inheritance = resolveInheritance(null, "hermes-agent", null);
    expect(inheritance.modelDefaultEffort).toBeNull();
    expect(inheritedEffortLabel(inheritance)).toBe("상속 (지정 없음)");
    expect(agentEffortInheritLabel(null)).toBe("상속 (지정 없음)");
  });
});

describe("프로필 편집 화면의 상속 라벨", () => {
  it("상대는 에이전트 자신의 모델 하나다", () => {
    expect(agentModelInheritLabel("hermes-agent")).toBe(
      "상속 (에이전트 기본: hermes-agent)"
    );
    expect(agentEffortInheritLabel("low")).toBe("상속 (지정 없음, 모델 기본 낮음)");
  });

  it("공백만 있는 선호는 지정이 아니다", () => {
    expect(draftFromProfile({ modelPref: "   ", effortPref: "" })).toEqual(INHERIT_DRAFT);
  });
});

// ---- 1회 오버라이드를 붙일 대상이 있는가 -------------------------------------

function agent(handle: string, id: string): RosterMember {
  return {
    id,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "agent",
    status: "active",
    displayName: handle,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function human(handle: string, id: string): RosterMember {
  return { ...agent(handle, id), kind: "human", agentModel: undefined };
}

describe("mentionRoutingTarget", () => {
  const members = [
    agent("hermes", "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90"),
    agent("kim-intern", "019f9a01-0000-7000-8000-000000000404"),
    human("seongjae", "019f94e3-7a10-79cd-9dee-208f47edd9a8"),
  ];

  it("텍스트에 남아 있는 핸들만 읽는다", () => {
    expect(mentionedHandles("@hermes 확인 부탁합니다")).toEqual(["hermes"]);
    expect(mentionedHandles("메일 주소 a@b.com 은 멘션이 아니다")).toEqual([]);
    expect(mentionedHandles("@hermes @hermes 두 번")).toEqual(["hermes"]);
  });

  it("에이전트 하나면 그 에이전트에 붙는다", () => {
    const target = mentionRoutingTarget("@hermes 빌드 로그 봐줘", members);
    expect(target.kind).toBe("one");
    expect(target.kind === "one" && target.agent.handle).toBe("hermes");
  });

  it("사람 멘션과 없는 핸들은 대상이 아니다", () => {
    expect(mentionRoutingTarget("@seongjae 확인 부탁", members).kind).toBe("none");
    expect(mentionRoutingTarget("@hermez 오타", members).kind).toBe("none");
  });

  it("에이전트가 둘이면 요청이 둘이라 하나의 오버라이드를 붙일 수 없다", () => {
    const target = mentionRoutingTarget("@hermes @kim-intern 같이 봐줘", members);
    expect(target.kind).toBe("many");
    expect(target.kind === "many" && target.agents).toHaveLength(2);
  });
});
