import { describe, expect, it } from "vitest";
import type { AgentProfile, AgentRunSummary, RosterMember } from "@momo/core/lib/api";
import type { AgentWorkingSignal } from "@/features/agents/agentWorkingSignal";
import {
  agentMembers,
  canInvalidateMemory,
  effectiveEffortLabel,
  effectiveModelLabel,
  lifecycleLabel,
  memoryKindLabel,
  mergeRunPages,
  signalsForAgent,
} from "@momo/core/features/agents/hubModel";

function member(
  id: string,
  kind: RosterMember["kind"],
  displayName: string
): RosterMember {
  return {
    id,
    workspaceId: "WS",
    kind,
    status: "active",
    displayName,
    handle: displayName,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function signal(overrides: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: "AGENT",
    channelId: "CHANNEL",
    state: "working",
    source: "run",
    headlines: [],
    lastActivityAtMs: 1_000,
    ...overrides,
  };
}

function run(id: string): AgentRunSummary {
  return {
    id,
    channelId: "CHANNEL",
    status: "succeeded",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentMemberId: "AGENT",
    workspaceId: "WS",
    instructions: "",
    enabledTools: [],
    triggers: { mention: true },
    paused: false,
    version: 1,
    updatedBy: "ME",
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("프로필 카드", () => {
  it("모델은 프로필 선택 > 에이전트 기본 > 없음 순으로 읽고, 상속을 상속이라 말한다", () => {
    const agent = { ...member("A", "agent", "김인턴"), agentModel: "hermes-agent" };
    expect(effectiveModelLabel(profile({ modelPref: "gpt-5.6" }), agent)).toBe(
      "gpt-5.6"
    );
    expect(effectiveModelLabel(profile(), agent)).toBe("hermes-agent (에이전트 기본)");
    expect(effectiveModelLabel(null, member("A", "agent", "김인턴"))).toBe(
      "지정된 모델 없음"
    );
  });

  it("추론 강도의 빈칸은 '고르지 않음'과 '축이 없음'을 구분한다", () => {
    expect(effectiveEffortLabel(profile({ effortPref: "high" }), true)).toBe("high");
    expect(effectiveEffortLabel(profile(), true)).toBe("모델 기본값");
    expect(effectiveEffortLabel(profile(), false)).toBe(
      "이 서버에는 추론 강도 축이 없음"
    );
  });

  it("상태는 멤버십 정지가 먼저이고, 못 읽은 것을 활성이라 하지 않는다", () => {
    const active = member("A", "agent", "김인턴");
    const suspended: RosterMember = { ...active, status: "suspended" };
    expect(lifecycleLabel(suspended, profile({ paused: true }), false, false)).toBe(
      "사용 중지"
    );
    expect(lifecycleLabel(active, null, true, false)).toBe("상태 확인 중");
    expect(lifecycleLabel(active, null, false, true)).toBe("상태 확인 실패");
    expect(lifecycleLabel(active, profile({ paused: true }), false, false)).toBe(
      "일시정지"
    );
    expect(lifecycleLabel(active, profile(), false, false)).toBe("활성");
  });
});

describe("agent hub model", () => {
  it("keeps only agents and sorts the stable roster projection", () => {
    expect(
      agentMembers([
        member("H", "human", "사람"),
        member("B", "agent", "Zulu"),
        member("A", "agent", "Alpha"),
      ]).map((item) => item.id)
    ).toEqual(["A", "B"]);
  });

  it("matches UUIDs without case and removes stale current-work claims", () => {
    const signals = new Map([
      ["a", signal({ memberId: "agent", state: "awaiting_approval" })],
      ["b", signal({ memberId: "AGENT", channelId: "B", lastActivityAtMs: 0 })],
      ["c", signal({ memberId: "OTHER" })],
    ]);
    expect(signalsForAgent(signals, "AgEnT", 91_001)).toEqual([]);
    expect(signalsForAgent(signals, "agent", 2_000)).toHaveLength(2);
  });

  it("deduplicates cursor pages by lower-cased run id without reordering", () => {
    expect(
      mergeRunPages([
        { runs: [run("RUN-B"), run("RUN-A")] },
        { runs: [run("run-a"), run("RUN-0")] },
      ]).map((item) => item.id)
    ).toEqual(["run-b", "run-a", "run-0"]);
  });

  it("allows invalidation only for workspace managers or the creator", () => {
    expect(canInvalidateMemory("admin", "ME", undefined)).toBe(true);
    expect(canInvalidateMemory("member", "ME", "me")).toBe(true);
    expect(canInvalidateMemory("member", "ME", "OTHER")).toBe(false);
    expect(memoryKindLabel("preference")).toBe("선호");
    expect(memoryKindLabel("fact")).toBe("사실");
    expect(memoryKindLabel("project_note")).toBe("project_note");
  });
});
