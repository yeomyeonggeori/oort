import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { ApiError, createAgentWorkRun } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  WORK_BRANCH_MAX_BYTES,
  WORK_BRIEF_MAX_BYTES,
  WORK_TITLE_MAX_BYTES,
  WorkRunDraftError,
  newWorkRunClientId,
  normalizeWorkRunInput,
  utf8ByteLength,
  workRunFailure,
  type WorkRunDraft,
  type WorkRunFailureReason,
} from "./workRunRequest";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const RUN_ID = "00000000-0000-7000-8000-0000000000b1";
const CLIENT_RUN = "11111111-1111-4111-8111-111111111111";

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
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

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const draft = (over: Partial<WorkRunDraft> = {}): WorkRunDraft => ({
  agentMemberId: AGENT,
  clientRunId: CLIENT_RUN,
  title: "  로그인 버그 고치기 ",
  brief: " 재현 순서는 이슈에 있어요. ",
  ...over,
});

function runBody(extra: Record<string, unknown> = {}) {
  return {
    id: RUN_ID.toUpperCase(),
    workspaceId: WS,
    agentMemberId: AGENT,
    channelId: CH,
    status: "queued",
    stepCount: 0,
    maxSteps: 20,
    depth: 0,
    input: { type: "work", title: "로그인 버그 고치기", brief: "재현 순서는 이슈에 있어요." },
    createdAtMs: 1,
    updatedAtMs: 1,
    ...extra,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizeWorkRunInput", () => {
  it("공백을 다듬고 빈 선택값은 싣지 않는다", () => {
    expect(normalizeWorkRunInput(draft({ repo: "   ", branch: "" }))).toEqual({
      type: "work",
      title: "로그인 버그 고치기",
      brief: "재현 순서는 이슈에 있어요.",
    });
    expect(
      normalizeWorkRunInput(draft({ repo: " https://github.com/a/b ", branch: " fix/x " }))
    ).toMatchObject({ repo: "https://github.com/a/b", branch: "fix/x" });
  });

  it("제목·설명이 비면 칸을 가리키는 오류를 낸다", () => {
    expect(() => normalizeWorkRunInput(draft({ title: "  " }))).toThrow(WorkRunDraftError);
    try {
      normalizeWorkRunInput(draft({ brief: "" }));
      throw new Error("unreachable");
    } catch (e) {
      expect((e as WorkRunDraftError).field).toBe("brief");
    }
  });

  it("한도는 글자 수가 아니라 UTF-8 바이트다 — 한글 67자는 제목 한도를 넘는다", () => {
    expect(utf8ByteLength("가")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(() => normalizeWorkRunInput(draft({ title: "가".repeat(66) }))).not.toThrow();
    expect(66 * 3).toBeLessThanOrEqual(WORK_TITLE_MAX_BYTES);
    expect(() => normalizeWorkRunInput(draft({ title: "가".repeat(67) }))).toThrow(WorkRunDraftError);
    expect(() => normalizeWorkRunInput(draft({ brief: "a".repeat(WORK_BRIEF_MAX_BYTES) }))).not.toThrow();
    expect(() => normalizeWorkRunInput(draft({ brief: "a".repeat(WORK_BRIEF_MAX_BYTES + 1) }))).toThrow(
      WorkRunDraftError
    );
    expect(() => normalizeWorkRunInput(draft({ branch: "b".repeat(WORK_BRANCH_MAX_BYTES + 1) }))).toThrow(
      WorkRunDraftError
    );
  });

  it("clientRunId는 UUID로 새로 만든다", () => {
    expect(newWorkRunClientId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newWorkRunClientId()).not.toBe(newWorkRunClientId());
  });
});

describe("createAgentWorkRun", () => {
  it("닫힌 본문을 agent-runs 경로로 POST한다(모르는 키 없음)", async () => {
    installHost();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(201, runBody()));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createAgentWorkRun(WS.toUpperCase(), CH.toUpperCase(), draft({ repo: "https://github.com/a/b" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://oort.test/v1/workspaces/${WS}/channels/${CH.toLowerCase()}/agent-runs`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      agentMemberId: AGENT,
      clientRunId: CLIENT_RUN,
      input: {
        type: "work",
        title: "로그인 버그 고치기",
        brief: "재현 순서는 이슈에 있어요.",
        repo: "https://github.com/a/b",
      },
    });
    expect(out.replayed).toBe(false);
    expect(out.run.id).toBe(RUN_ID);
    expect(out.run.status).toBe("queued");
  });

  it("재시도해도 같은 clientRunId·같은 본문이 나가고, 서버 200 재생은 한 건으로 읽힌다", async () => {
    installHost();
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      calls += 1;
      // 첫 응답은 유실(네트워크 끊김), 두 번째는 서버가 같은 run을 200으로 재생.
      if (calls === 1) throw new TypeError("Network request failed");
      return json(200, runBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    const mine = draft();
    await expect(createAgentWorkRun(WS, CH, mine)).rejects.toBeInstanceOf(NetworkError);
    const retried = await createAgentWorkRun(WS, CH, { ...mine });

    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1]!).clientRunId).toBe(CLIENT_RUN);
    expect(retried.replayed).toBe(true);
    expect(retried.run.id).toBe(RUN_ID);
  });

  it("공백만 다른 재시도도 서버 비교를 깨지 않도록 같은 본문이 된다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(201, runBody()));
    vi.stubGlobal("fetch", fetchMock);
    await createAgentWorkRun(WS, CH, draft());
    await createAgentWorkRun(WS, CH, draft({ title: "로그인 버그 고치기", brief: "재현 순서는 이슈에 있어요.", repo: " " }));
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body);
  });

  it("입력이 틀리면 서버를 부르지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createAgentWorkRun(WS, CH, draft({ title: "" }))).rejects.toBeInstanceOf(WorkRunDraftError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("응답은 느슨하게 읽는다 — 모르는 필드는 무시, 필수가 없으면 형태 오류", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(201, runBody({ somethingNew: { a: 1 }, output: null })))
    );
    const ok = await createAgentWorkRun(WS, CH, draft());
    expect(ok.run.id).toBe(RUN_ID);

    vi.stubGlobal("fetch", vi.fn(async () => json(201, { id: RUN_ID })));
    await expect(createAgentWorkRun(WS, CH, draft())).rejects.toBeInstanceOf(WireShapeError);
  });

  it("거절은 서버 코드를 담은 ApiError로 던진다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(409, { error: { code: "hosted_channel_not_approved", message: "this channel is not approved for the hosted agent" } })
      )
    );
    const err = await createAgentWorkRun(WS, CH, draft()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("hosted_channel_not_approved");
  });
});

describe("workRunFailure — 거절 사유 전수", () => {
  const api = (status: number, message: string, code?: string) => new ApiError(status, message, code);

  // 서버 `agent_runs.rs create`가 내는 모든 거절. 새 거절이 생기면 이 표에 줄을 더한다.
  const CASES: Array<[string, unknown, WorkRunFailureReason]> = [
    ["409 coded hosted_connection_not_active", api(409, "the hosted agent connection is not active", "hosted_connection_not_active"), "hosted_connection_not_active"],
    ["409 coded hosted_channel_not_approved", api(409, "this channel is not approved for the hosted agent", "hosted_channel_not_approved"), "hosted_channel_not_approved"],
    ["409 coded agent_paused", api(409, "agent is paused", "agent_paused"), "agent_paused"],
    ["409 coded claude_subscription_agent_paused", api(409, "Claude subscription agents are paused on this server", "claude_subscription_agent_paused"), "claude_subscription_agent_paused"],
    ["409 uncoded agent is paused", api(409, "agent is paused"), "agent_paused"],
    ["409 hosted delivery off", api(409, "hosted agent delivery is not enabled"), "hosted_delivery_off"],
    ["409 gateway off", api(409, "work runs require an enabled BYOA agent gateway"), "gateway_off"],
    ["409 subscription agents off", api(409, "subscription agents are disabled on this server"), "subscription_agents_off"],
    ["409 idempotency conflict", api(409, "client_run_id idempotency conflict"), "idempotency_conflict"],
    ["409 concurrent limit", api(409, "agent concurrent run limit reached"), "concurrent_limit"],
    ["409 unrecognised", api(409, "something reworded"), "unknown"],
    ["403 owner only", api(403, "this subscription agent takes requests from its owner only"), "owner_only"],
    ["403 guest", api(403, "guests cannot request work from a hosted agent"), "guest_not_allowed"],
    ["403 not a member", api(403, "not an active human channel member"), "not_a_member"],
    ["403 human required", api(403, "human member required"), "not_a_member"],
    ["404 agent", api(404, "active channel agent not found"), "agent_not_found"],
    ["400 validation", api(400, "title is required"), "invalid_input"],
    ["422 body shape", api(422, "Failed to deserialize"), "invalid_input"],
    ["401", api(401, "unauthorized"), "unauthorized"],
    ["429", api(429, "slow down"), "rate_limited"],
    ["500", api(500, "internal server error"), "server_error"],
    ["network", new NetworkError("unreachable", 15000), "network"],
    ["draft error", new WorkRunDraftError("title", "제목을 적어 주세요."), "invalid_input"],
    ["non-error", "boom", "unknown"],
  ];

  it.each(CASES)("%s", (_name, error, reason) => {
    expect(workRunFailure(error).reason).toBe(reason);
  });

  it("모든 문장은 해요체 한글이고 상태 코드·영문 원문·합쇼체를 싣지 않는다", () => {
    for (const [, error] of CASES) {
      const { sentence } = workRunFailure(error);
      expect(sentence).toMatch(/[가-힣]/);
      expect(sentence).not.toMatch(/\b(40\d|409|422|5\d\d|HTTP)\b/);
      expect(sentence.replace(/oort|Claude/g, "")).not.toMatch(/[A-Za-z]{3,}/);
      expect(sentence).not.toMatch(/(습니다|십시오|합니다)[.\s]*$/);
      expect(sentence).toMatch(/요[.]?$/);
    }
  });

  it("사유마다 문장이 다르다(409 닫힌 사유 4종은 서로 구분된다)", () => {
    const four = [
      "hosted_connection_not_active",
      "hosted_channel_not_approved",
      "agent_paused",
      "claude_subscription_agent_paused",
    ].map((code) => workRunFailure(api(409, "x", code)).sentence);
    expect(new Set(four).size).toBe(4);
  });

  it("다음 행동: 네트워크·5xx는 같은 id로 재시도, 연결·승인·소유자 문제는 다른 곳에서 해결", () => {
    expect(workRunFailure(new NetworkError("timeout", 15000)).next).toBe("retry_same");
    expect(workRunFailure(api(503, "x")).next).toBe("retry_same");
    expect(workRunFailure(api(409, "x", "hosted_connection_not_active")).next).toBe("fix_elsewhere");
    expect(workRunFailure(api(403, "guests cannot request work from a hosted agent")).next).toBe("fix_elsewhere");
    expect(workRunFailure(api(409, "client_run_id idempotency conflict")).next).toBe("new_request");
  });

  it("칸을 가리키는 입력 오류는 field를 싣는다", () => {
    expect(workRunFailure(new WorkRunDraftError("brief", "설명을 적어 주세요.")).field).toBe("brief");
  });
});
