// 「쓴 앱」 와이어 읽기 (#3946 서버 규칙과 같은 닫힌 규칙, #3950).
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { appsUsedFromWire, fetchAgentRunDetail } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const ONE = [{ pluginId: "google-calendar", tool: "list_events", calls: 3 }];

describe("appsUsedFromWire", () => {
  it("정상 보고는 그대로, 빈 값·없음은 null", () => {
    expect(appsUsedFromWire(ONE)).toEqual(ONE);
    // 공식 앱 id 는 점이 든다(`com.momo.plugins.github`) — 서버 `is_plugin_id` 와 같은 모양.
    const dotted = [{ pluginId: "com.momo.plugins.github", tool: "get_issue", calls: 1 }];
    expect(appsUsedFromWire(dotted)).toEqual(dotted);
    for (const empty of [undefined, null, [], "x", {}]) {
      expect(appsUsedFromWire(empty)).toBeNull();
    }
  });

  it("모양이 하나라도 어긋나면 보고 전체를 버린다", () => {
    const bad: unknown[] = [
      [{ ...ONE[0], body: "x" }],
      [{ pluginId: "Google Calendar", tool: "t", calls: 1 }],
      [{ pluginId: "ab", tool: "t", calls: 1 }],
      [{ pluginId: "gmail", tool: "a:b", calls: 1 }],
      [{ pluginId: "gmail", tool: "t", calls: 100001 }],
      [{ pluginId: "gmail", tool: "t", calls: "3" }],
      [ONE[0], ONE[0]],
      Array.from({ length: 17 }, (_, i) => ({ pluginId: "gmail", tool: `t${i}`, calls: 1 })),
      [1],
    ];
    for (const value of bad) expect(appsUsedFromWire(value)).toBeNull();
    // 16개는 허용
    expect(
      appsUsedFromWire(Array.from({ length: 16 }, (_, i) => ({ pluginId: "gmail", tool: `t${i}`, calls: 1 })))
    ).toHaveLength(16);
  });
});

describe("run 상세가 appsUsed 를 싣는다", () => {
  function host(): void {
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
  }
  const base = {
    id: "11111111-1111-7111-8111-111111111111",
    workspaceId: "22222222-2222-7222-8222-222222222222",
    agentMemberId: "33333333-3333-7333-8333-333333333333",
    channelId: "44444444-4444-7444-8444-444444444444",
    status: "succeeded",
    stepCount: 1,
    maxSteps: 4,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  const serve = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
    );

  it("최상위 appsUsed 가 정본, 없으면 output.appsUsed, 둘 다 없으면 키 자체가 없다", async () => {
    host();
    serve({ ...base, appsUsed: ONE });
    expect((await fetchAgentRunDetail(base.workspaceId, base.id)).appsUsed).toEqual(ONE);
    serve({ ...base, output: { appsUsed: ONE } });
    expect((await fetchAgentRunDetail(base.workspaceId, base.id)).appsUsed).toEqual(ONE);
    serve({ ...base, output: { body: "x" } });
    expect("appsUsed" in (await fetchAgentRunDetail(base.workspaceId, base.id))).toBe(false);
    // 변조된 값은 화면에 닿지 않는다.
    serve({ ...base, appsUsed: [{ ...ONE[0], token: "secret" }] });
    expect("appsUsed" in (await fetchAgentRunDetail(base.workspaceId, base.id))).toBe(false);
  });
});
