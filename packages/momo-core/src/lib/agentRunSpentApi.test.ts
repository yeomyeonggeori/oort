// run이 쓴 양(`spent`) 와이어 읽기 — ADR-0201 증보 v3 B12(#4968) + 증보 v4 P7 `delegations`(#5370), 코어 #5374.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { agentRunProgressFromWire, agentRunSpentFromWire, fetchAgentRunDetail } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

/** 서버 `AgentRunSpentDto`가 내는 모양 그대로(openapi `AgentRunSpent`, `delegations` 필수). */
const SPENT = { promptTokens: 12000, completionTokens: 300, webSearches: 0, estimated: false, delegations: 1 };

describe("agentRunSpentFromWire", () => {
  it("서버 모양을 그대로 읽는다: 도우미 자신의 토큰·검색 + Hermes에 맡긴 횟수", () => {
    expect(agentRunSpentFromWire(SPENT)).toEqual(SPENT);
    expect(agentRunSpentFromWire({ ...SPENT, delegations: 0, estimated: true })).toEqual({
      ...SPENT,
      delegations: 0,
      estimated: true,
    });
  });

  it("delegations를 모르는 옛 서버(#5370 전)는 맡긴 적이 없으니 0이다", () => {
    const { delegations: _omitted, ...old } = SPENT;
    expect(agentRunSpentFromWire(old)).toEqual({ ...old, delegations: 0 });
  });

  it("칸이 모자라거나 모양이 다르면 쓴 양을 말하지 않는다(던지지 않는다)", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "spent",
      [],
      { ...SPENT, promptTokens: undefined },
      { ...SPENT, completionTokens: -1 },
      { ...SPENT, webSearches: 1.5 },
      { ...SPENT, estimated: "no" },
      { ...SPENT, delegations: -1 },
      { ...SPENT, delegations: "1" },
      { ...SPENT, delegations: null },
    ];
    for (const value of bad) expect(agentRunSpentFromWire(value), JSON.stringify(value)).toBeUndefined();
  });
});

describe("run 진행과 상세가 spent를 싣는다", () => {
  const progress = {
    id: "11111111-1111-7111-8111-111111111111",
    channelId: "44444444-4444-7444-8444-444444444444",
    agentMemberId: "33333333-3333-7333-8333-333333333333",
    triggerMessageId: "55555555-5555-7555-8555-555555555555",
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  it("진행: 팀 AI 작업 run이면 spent가 있고, 없거나 모양이 다르면 키가 없으며 진행 자체는 그대로다", () => {
    expect(agentRunProgressFromWire({ ...progress, spent: SPENT }).spent).toEqual(SPENT);
    const without = agentRunProgressFromWire(progress);
    expect("spent" in without).toBe(false);
    const broken = agentRunProgressFromWire({ ...progress, spent: { ...SPENT, delegations: -1 } });
    expect("spent" in broken).toBe(false);
    expect(broken.id).toBe(progress.id);
  });

  it("상세: 최상위 spent를 읽는다", async () => {
    const session: SessionPort = {
      getAccessToken: () => "t",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    };
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session,
    });
    const detail = {
      id: progress.id,
      workspaceId: "22222222-2222-7222-8222-222222222222",
      agentMemberId: progress.agentMemberId,
      channelId: progress.channelId,
      status: "succeeded",
      stepCount: 1,
      maxSteps: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    const serve = (body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
        )
      );
    serve({ ...detail, spent: SPENT });
    expect((await fetchAgentRunDetail(detail.workspaceId, detail.id)).spent).toEqual(SPENT);
    serve(detail);
    expect("spent" in (await fetchAgentRunDetail(detail.workspaceId, detail.id))).toBe(false);
  });
});
