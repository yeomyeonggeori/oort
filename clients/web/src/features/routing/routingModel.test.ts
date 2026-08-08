import { describe, expect, it } from "vitest";
import fixtures from "./routingFixtures.json";
import {
  INHERIT_DRAFT,
  agentEffortInheritLabel,
  agentModelInheritLabel,
  appliedModelLabel,
  applyModelChange,
  clearUnsupportedEffort,
  clearedEffortNotice,
  draftEquals,
  draftFromProfile,
  effectiveModel,
  effortLabel,
  effortsForModel,
  hasUnattestedModels,
  ignoredEffortNotice,
  ignoredModelNotice,
  inheritedEffortLabel,
  inheritedModelLabel,
  isOverride,
  knownAgentModels,
  modelOptions,
  parseEffortTable,
  resolveInheritance,
  routingPayload,
  routingRejectionField,
  sharedClearedEffortNotice,
  sharedEfforts,
  sharedModelOptions,
  supportsEffort,
  type CalledAgentRouting,
  type EffortTable,
  type RoutingDraft,
  type RoutingProfile,
} from "@momo/core/features/routing/routingModel";
import {
  mentionRoutingTarget,
  mentionRoutingTargetKey,
  mentionedHandles,
} from "@momo/core/features/routing/mentionTargets";
import type { RosterMember } from "@momo/core/lib/api";

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

  // 서버가 재는 자는 `MessageRoutes.resolveProfileModel`이고 그 허용집합은
  // `{agent.model} ∪ workspace.settings.allowed_agent_models`다. 뒤쪽 절반을 주는
  // REST가 없으므로 교집합은 계산할 수 없고, 대신 **근거 순서**를 지킨다: 증명된
  // 값(에이전트 자신의 모델)이 맨 앞, 허용목록이 아닌 effort 표가 맨 뒤
  // (2026-07-26 머지 리뷰 F1).
  it("피커 목록은 근거가 강한 순서로 온다", () => {
    expect(
      modelOptions(table, "claude-opus-5", ["hermes-fast", "claude-opus-5"])
    ).toEqual([
      // 1층: 이 에이전트의 모델. 서버가 반드시 받는 유일한 값이다.
      "claude-opus-5",
      // 2층: 이 워크스페이스가 실제로 돌리는 모델.
      "hermes-fast",
      // 3층: effort 표에만 있는 이름들. 표는 강도 능력표이지 허용목록이 아니다.
      "hermes-agent",
      "hermes-default",
      "hermes-lite",
    ]);
  });

  it("받은 agent별 허용집합과만 교집합을 만든다", () => {
    expect(
      modelOptions(
        table,
        "hermes-agent",
        ["hermes-fast", "external-premium"],
        ["hermes-agent", "hermes-fast", "workspace-only"]
      )
    ).toEqual(["hermes-agent", "hermes-fast", "workspace-only"]);
  });

  it("증명된 값이 하나뿐인지 아닌지를 화면에 알려준다", () => {
    // 목록이 에이전트 자신의 모델뿐이면 할 말은 "목록을 주는 경로가 없다"이고,
    // 그 밖의 이름이 하나라도 섞이면 "허용 여부를 모른다"로 바뀐다.
    expect(hasUnattestedModels(["hermes-agent"], "hermes-agent")).toBe(false);
    expect(hasUnattestedModels([], "hermes-agent")).toBe(false);
    expect(
      hasUnattestedModels(["hermes-agent", "hermes-fast"], "hermes-agent")
    ).toBe(true);
  });

  it("표가 없어도 모델 축은 고를 수 있다", () => {
    // 모델은 ADR-0131 D2라 모든 세대의 서버가 가지고 있고, 표는 ADR-0134 D2라
    // 아직 없는 서버가 있다. 표를 목록의 유일한 출처로 두면 표가 없는 서버에서
    // MOMO-537(에이전트 기본 모델 편집)이 통째로 사라진다(R1 B2).
    expect(
      modelOptions(null, "hermes-agent", ["hermes-fast", "hermes-agent"])
    ).toEqual(["hermes-agent", "hermes-fast"]);
    expect(modelOptions(null, "")).toEqual([]);
  });

  it("허용집합을 못 받으면 목록을 지어내지 않고 기존 완화 동작을 유지한다", () => {
    expect(
      modelOptions(null, "hermes-agent", ["hermes-fast", "hermes-agent"], null)
    ).toEqual(["hermes-agent", "hermes-fast"]);
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

  it("받은 허용집합 밖의 저장된 모델은 base model로 상속되지만 숨기지 않는다", () => {
    const inheritance = resolveInheritance(table, "hermes-agent", {
      modelPref: "external-premium",
      effortPref: "max",
    }, ["hermes-agent", "hermes-fast"]);
    expect(inheritance.model).toEqual({ value: "hermes-agent", source: "agent" });
    expect(inheritance.ignoredModelPref).toBe("external-premium");
    expect(ignoredModelNotice("external-premium", "hermes-agent")).toBe(
      "프로필에 저장된 모델 external-premium은 현재 워크스페이스에서 허용되지 않아 hermes-agent 모델로 적용됩니다."
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

  it("에이전트가 둘이면 요청도 둘이고, 부른 순서대로 목록이 된다", () => {
    const target = mentionRoutingTarget("@hermes @kim-intern 같이 봐줘", members);
    expect(target.kind).toBe("many");
    expect(target.kind === "many" && target.agents.map((a) => a.handle)).toEqual([
      "hermes",
      "kim-intern",
    ]);
  });
});

// =============================================================================
// 오버라이드가 붙어 있는 상대의 정체 (#1113).
//
// 초안을 비우는 기준이 "한 명일 때의 그 한 명"이면, 여럿을 부른 글에서는 이름을
// 갈아 끼워도 초안이 그대로 남는다. 그것은 사람이 고른 적 없는 상대에게 값을
// 보내는 일이고, 단일 타깃에서 이 화면이 이미 막아 둔 사고다.
// =============================================================================

describe("mentionRoutingTargetKey", () => {
  const members = [
    agent("hermes", "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90"),
    agent("kim-intern", "019f9a01-0000-7000-8000-000000000404"),
    agent("atlas", "019f9a01-0000-7000-8000-000000000405"),
  ];
  const keyOf = (text: string) =>
    mentionRoutingTargetKey(mentionRoutingTarget(text, members));

  it("부를 사람이 없으면 붙어 있을 자리도 없다", () => {
    expect(keyOf("그냥 메모")).toBeNull();
  });

  it("부른 집합이 바뀌면 정체가 바뀐다", () => {
    // 이 줄이 빨개지는 회귀: 정체를 한 명일 때의 id 하나로 되돌리면 두 값이
    // 같아지고, 김인턴에게 고른 강도가 아틀라스에게 그대로 따라간다.
    expect(keyOf("@hermes @kim-intern 봐줘")).not.toBe(
      keyOf("@hermes @atlas 봐줘")
    );
    expect(keyOf("@hermes 봐줘")).not.toBe(keyOf("@hermes @atlas 봐줘"));
  });

  it("같은 사람들을 다른 순서로 불렀으면 같은 정체다", () => {
    // 서버가 만드는 run이 같으므로, 문장 안에서 이름을 옮겼다는 이유로 고른 값이
    // 사라지면 그것은 사람이 한 적 없는 취소다.
    expect(keyOf("@hermes @atlas 봐줘")).toBe(keyOf("@atlas @hermes 봐줘"));
  });
});

// =============================================================================
// 여럿을 부른 글의 공통 어휘 (#1113).
//
// 전송 표면이 받는 `routing`은 메시지 한 건당 블록 하나이고, 서버는 그 하나를
// per-agent 루프 안에서 각 에이전트에게 다시 푼다. 그러므로 여럿에게 걸 수 있는
// 값은 부른 모두가 받아 주는 것들뿐이다: 한 명에게만 유효한 값을 실으면 서버는 그
// 한 명에서 400을 답하고, 그 400이 전송 트랜잭션 전체를 되돌린다.
// =============================================================================

function called(
  handle: string,
  agentModel: string,
  allowedModels: string[] | null,
  profile: RoutingProfile | null = null
): CalledAgentRouting {
  return {
    id: handle,
    handle,
    displayName: handle,
    inheritance: resolveInheritance(table, agentModel, profile, allowedModels),
    allowedModels,
  };
}

describe("sharedModelOptions", () => {
  it("고를 수 있는 모델은 받은 allow-list들의 교집합이다", () => {
    const result = sharedModelOptions(
      [
        called("hermes", "hermes-agent", ["hermes-agent", "hermes-fast"]),
        called("kim-intern", "hermes-fast", ["hermes-fast", "hermes-lite"]),
      ],
      table
    );
    // 합집합이면 hermes-agent가 남고, 그것을 고른 전송은 김인턴에서 400을 받아
    // **메시지 전체**가 되돌아온다. 이 단정이 그 회귀를 빨갛게 만든다.
    expect(result.models).toEqual(["hermes-fast"]);
    expect(result.allowedReceived).toBe(true);
  });

  it("공통이 하나도 없으면 빈 목록이다. 없는 선택지를 그리지 않는다", () => {
    const result = sharedModelOptions(
      [
        called("hermes", "hermes-agent", ["hermes-agent"]),
        called("kim-intern", "hermes-fast", ["hermes-fast"]),
      ],
      table
    );
    expect(result.models).toEqual([]);
    expect(result.allowedReceived).toBe(true);
  });

  it("allow-list를 못 받은 에이전트는 목록을 좁히지 않는다", () => {
    // 모른다는 것은 비었다는 것과 다르다. 못 받은 쪽을 빈 집합으로 셈하면 실제로
    // 허용된 모델이 피커에서 영영 사라진다(단일 경로 modelOptions와 같은 규칙).
    const result = sharedModelOptions(
      [
        called("hermes", "hermes-agent", null),
        called("kim-intern", "hermes-fast", ["hermes-fast", "hermes-lite"]),
      ],
      table
    );
    expect(result.models).toEqual(["hermes-fast", "hermes-lite"]);
    expect(result.allowedReceived).toBe(false);
  });
});

describe("sharedEfforts", () => {
  const pair = [
    called("hermes", "hermes-agent", null),
    called("kim-intern", "hermes-fast", null),
  ];

  it("부른 모두의 모델이 받아 주는 값만 남는다", () => {
    // hermes-agent는 max까지 받고 hermes-fast는 medium까지다. 합집합을 올려 두면
    // max를 고른 전송이 400으로 되돌아오고, 두 명을 부른 메시지가 통째로 안 나간다.
    expect(sharedEfforts(table, pair, null)).toEqual(["low", "medium"]);
  });

  it("모델 오버라이드가 걸리면 기준은 그 모델 하나다", () => {
    // 모두가 그 모델로 돌기 때문이다. 상속 모델을 계속 세면 고를 수 있었던 값이
    // 이유 없이 사라진다.
    expect(sharedEfforts(table, pair, "hermes-agent")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("상속값을 모르는 에이전트가 하나라도 있으면 아무 값도 주장하지 않는다", () => {
    const unknown: CalledAgentRouting[] = [
      pair[0],
      { ...pair[1], inheritance: null },
    ];
    expect(sharedEfforts(table, unknown, null)).toEqual([]);
    expect(sharedEfforts(null, pair, null)).toEqual([]);
  });
});

describe("clearUnsupportedEffort", () => {
  it("목록에서 벗어난 강도는 비우고 무엇을 비웠는지 돌려준다", () => {
    const draft: RoutingDraft = { model: null, effort: "max" };
    const result = clearUnsupportedEffort(draft, null, ["low", "medium"]);
    expect(result.draft).toEqual({ model: null, effort: null });
    expect(result.clearedEffort).toBe("max");
    expect(sharedClearedEffortNotice("max")).toBe(
      "추론 강도 최대를 부른 모두가 쓸 수 있는 것은 아니라 상속으로 되돌렸습니다."
    );
  });

  it("받아 주는 강도는 그대로 둔다", () => {
    const draft: RoutingDraft = { model: null, effort: "low" };
    expect(clearUnsupportedEffort(draft, "hermes-fast", ["low", "medium"])).toEqual({
      draft: { model: "hermes-fast", effort: "low" },
      clearedEffort: null,
    });
  });

  it("단일 타깃의 자동 클리어도 같은 규칙 하나를 쓴다", () => {
    // applyModelChange는 이 함수에 "그 모델의 표 행"을 넘기는 얇은 층이다. 규칙이
    // 두 벌이 되면 한쪽만 고쳐지는 순간이 오고, 그때 화면은 서버가 400으로 거절할
    // 조합을 사람에게 남겨 둔다.
    const draft: RoutingDraft = { model: "hermes-agent", effort: "max" };
    expect(applyModelChange(table, draft, "hermes-fast", "hermes-agent")).toEqual(
      clearUnsupportedEffort(
        draft,
        "hermes-fast",
        effortsForModel(table, "hermes-fast").efforts
      )
    );
  });
});

// =============================================================================
// 서버 거절의 배달 주소 (2026-07-26 머지 리뷰 F1).
//
// 허용목록 밖 모델에 대한 400은 "모델을 바꿔라"는 요청이므로 폼 맨 아래가 아니라
// 모델 상자 옆에 서야 한다. 엔진 절반이 프로필 PUT을 200 무음 폐기에서 400으로
// 바꾸는 중이고 그 **문구는 아직 확정되지 않았으므로**, 여기서는 리터럴을 맞히지
// 않고 축 이름이 문장에 등장하는지만 본다. 못 알아보면 null이고, 그때는 지금까지와
// 똑같이 폼 전체에 붙는다.
// =============================================================================

describe("routingRejectionField", () => {
  const both: RoutingDraft = { model: "hermes-fast", effort: "max" };
  const modelOnly: RoutingDraft = { model: "hermes-fast", effort: null };

  it("허용목록 거절은 모델 상자로 간다", () => {
    // 컴포저 전송 표면의 실제 문구(capability.ts가 인용하는 그것).
    expect(
      routingRejectionField(
        400,
        "routing.model is not in workspace.settings.allowed_agent_models",
        both
      )
    ).toBe("model");
    // 프로필 PUT의 기존 길이 검사도 같은 상자에 대한 답이다.
    expect(
      routingRejectionField(400, "modelPref must contain 1...200 characters", both)
    ).toBe("model");
  });

  it("강도 거절은 강도 상자로 가고, 두 축을 모두 부르는 문장도 그렇다", () => {
    expect(
      routingRejectionField(400, "effortPref is not valid for model hermes-fast", both)
    ).toBe("effort");
  });

  it("보내지 않은 축으로는 배달하지 않는다", () => {
    // 강도를 싣지 않았는데 온 400은 강도에 대한 답일 수 없다.
    expect(
      routingRejectionField(400, "effortPref is not a known field", modelOnly)
    ).toBe("model");
    expect(
      routingRejectionField(400, "modelPref rejected", INHERIT_DRAFT)
    ).toBeNull();
  });

  it("이 폼이 새로 보내는 값이 모델뿐이면 알아보지 못한 400도 모델의 답이다", () => {
    // 나머지 키는 읽은 그대로 되돌려 보내는 값이라 방금 전까지 서버가 받아 주던
    // 것들이다.
    expect(routingRejectionField(400, "bad request", modelOnly)).toBe("model");
  });

  it("알아보지 못하면 폼 전체에 붙인다. 승급이지 대체가 아니다", () => {
    expect(routingRejectionField(400, "bad request", both)).toBeNull();
    expect(routingRejectionField(500, "modelPref rejected", both)).toBeNull();
    expect(routingRejectionField(403, "modelPref rejected", both)).toBeNull();
  });
});
