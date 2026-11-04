import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalPageFromWire,
  approvalsFromWire,
  fetchApprovalPage,
  fetchApprovals,
} from "./api";
import { installCoreHost, resetCoreHost } from "../runtime/host";

// =============================================================================
// 승인 프로젝션의 와이어 형상 (goal M-AP1 2R).
//
// 이 디코더가 지키는 것은 두 가지이고, 둘 다 "화면이 거짓말하지 않는다"의 아래층이다:
//
//   1. **두 표기를 다 읽는다.** 정본 스펙(`docs/api/openapi.yaml`
//      ApprovalProjection)은 snake_case, 이식된 Rust 서버
//      (`bins/momo-server/src/dto.rs:2213` ApprovalDto)는 camelCase다. 한쪽만
//      읽으면 다른 쪽 서버에서 모든 행이 버려지고, 오류 하나 없이 빈 목록이 된다.
//      빈 승인 목록은 사람 자리에서 「결정할 것이 없다」로 읽힌다.
//   2. **payload에서 툴 이름만 꺼낸다.** 이 서버의 action_type은 언제나
//      `tool_call`이므로, 무엇을 허가하는지는 payload에만 있다. 인자는 꺼내지
//      않는다 — 세션 id·경로·프롬프트는 인박스 행이 할 말이 아니다.
// =============================================================================

const CAMEL = {
  id: "019F8338-025E-7873-93A3-C1FBA9149185",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  runId: "019F8338-0211-7A11-850C-D4E6229DDCA7",
  channelId: "00000000-0000-7000-8000-000000000201",
  requestedBy: "00000000-0000-7000-8000-000000000103",
  actionType: "tool_call",
  payload: {
    run_id: "019F8338-0211-7A11-850C-D4E6229DDCA7",
    action_type: "tool_call",
    tool_call: {
      call_id: "call-1",
      name: "work.session.end",
      arguments: '{"session_id":"SESSION-APP"}',
      arguments_json: { session_id: "SESSION-APP" },
    },
    approval_reason: "irreversible tool",
    resume_model: "gpt-5.6",
  },
  status: "pending",
  expiresAtMs: 1_700_000_600_000,
  createdAtMs: 1_699_999_000_000,
};

const SNAKE = {
  id: CAMEL.id,
  workspace_id: CAMEL.workspaceId,
  run_id: CAMEL.runId,
  channel_id: CAMEL.channelId,
  requested_by: CAMEL.requestedBy,
  action_type: CAMEL.actionType,
  payload: CAMEL.payload,
  status: CAMEL.status,
  expires_at_ms: CAMEL.expiresAtMs,
  created_at_ms: CAMEL.createdAtMs,
};

describe("approval projection decoding", () => {
  it("reads the Rust server's camelCase page", () => {
    const [approval] = approvalsFromWire({ approvals: [CAMEL] });
    expect(approval.workspaceId).toBe(CAMEL.workspaceId);
    expect(approval.runId).toBe(CAMEL.runId);
    expect(approval.channelId).toBe(CAMEL.channelId);
    expect(approval.requestedBy).toBe(CAMEL.requestedBy);
    expect(approval.actionType).toBe("tool_call");
    expect(approval.expiresAtMs).toBe(CAMEL.expiresAtMs);
  });

  it("reads the canonical spec's snake_case page to exactly the same row", () => {
    expect(approvalsFromWire({ approvals: [SNAKE] })).toEqual(
      approvalsFromWire({ approvals: [CAMEL] })
    );
  });

  it("lifts the tool NAME out of payload, and nothing else", () => {
    const [approval] = approvalsFromWire({ approvals: [CAMEL] });
    expect(approval.toolName).toBe("work.session.end");
    // 인자는 행에 실리지 않는다.
    expect(JSON.stringify(approval)).not.toContain("SESSION-APP");
  });

  it("leaves the tool name absent rather than inventing one", () => {
    const [noTool] = approvalsFromWire({
      approvals: [{ ...CAMEL, payload: { run_id: CAMEL.runId } }],
    });
    expect(noTool.toolName).toBeUndefined();
    const [blank] = approvalsFromWire({
      approvals: [{ ...CAMEL, payload: { tool_call: { name: "   " } } }],
    });
    expect(blank.toolName).toBeUndefined();
  });

  it("keeps an absent reversibility flag ABSENT", () => {
    // 판정은 model.ts가 fail-closed로 한다. 디코더가 여기서 기본값을 채워 넣으면
    // "서버가 무엇을 말했는가"와 "우리가 어떻게 읽기로 했는가"가 한 값에 섞인다.
    const [approval] = approvalsFromWire({ approvals: [CAMEL] });
    expect(approval.isReversible).toBeUndefined();
    expect(
      approvalsFromWire({ approvals: [{ ...CAMEL, isReversible: false }] })[0]
        .isReversible
    ).toBe(false);
    expect(
      approvalsFromWire({ approvals: [{ ...SNAKE, is_reversible: true }] })[0]
        .isReversible
    ).toBe(true);
  });

  it("drops a row that is missing a required field in BOTH spellings", () => {
    const { requestedBy: _dropped, ...missing } = CAMEL;
    expect(approvalsFromWire({ approvals: [missing] })).toEqual([]);
    // 나머지 행은 살아남는다.
    expect(approvalsFromWire({ approvals: [missing, CAMEL] })).toHaveLength(1);
  });

  it("answers an unusable page with an empty list, never a throw", () => {
    expect(approvalsFromWire({ approvals: null })).toEqual([]);
    expect(approvalsFromWire({})).toEqual([]);
  });
});

describe("워크스페이스 행동 승인의 행동 id (#3729)", () => {
  const ACTION = {
    ...CAMEL,
    actionType: "workspace_action",
    payload: {
      action: { id: "channel.create", args: { name: "계획" }, rationale: null },
      proposed_by: CAMEL.requestedBy,
      resume_model: null,
    },
  };

  it("payload.action.id 한 조각만 꺼낸다 (args 는 인박스 행이 할 말이 아니다)", () => {
    const [approval] = approvalsFromWire({ approvals: [ACTION] });
    expect(approval.workspaceActionId).toBe("channel.create");
    expect(JSON.stringify(approval)).not.toContain("계획");
  });

  it("도구 호출 승인에는 칸 자체가 없다", () => {
    const [approval] = approvalsFromWire({ approvals: [CAMEL] });
    expect(approval.workspaceActionId).toBeUndefined();
  });
});


// #4763(승인 목록 읽기 확장): 모든 상태·결정 자리·결과 한 문장·쪽매김. 키는 두 표기를 다 읽고,
// 새 칸이 없는 옛 서버 응답은 지금처럼 읽는다.
describe("승인 목록의 새 칸 (ADR-0186 v6 R-f, #4763)", () => {
  const SERVER = {
    ...CAMEL,
    status: "approved",
    decidedBy: "00000000-0000-7000-8000-000000000101",
    decidedAtMs: 1_700_000_100_000,
    decisionMode: "inline",
    isDirect: false,
    rootId: "019F8338-0211-7A11-850C-D4E6229DDC01",
    result: { line: "  승인됐어요  " },
  };

  it("결정 자리·DM 여부·스레드·만든 시각·결과 문장을 있는 그대로 읽는다", () => {
    const [approval] = approvalsFromWire({ approvals: [SERVER] });
    expect(approval).toMatchObject({
      decisionMode: "inline",
      isDirect: false,
      rootId: SERVER.rootId,
      createdAtMs: CAMEL.createdAtMs,
      resultLine: "승인됐어요",
    });
  });

  it("snake_case(정본 스펙) 표기도 같은 행으로 읽는다", () => {
    const snake = {
      ...SNAKE,
      status: "approved",
      decision_mode: "open",
      is_direct: true,
      root_id: SERVER.rootId,
      result: { line: "도구 실행을 마쳤어요" },
    };
    expect(approvalsFromWire({ approvals: [snake] })[0]).toMatchObject({
      decisionMode: "open",
      isDirect: true,
      rootId: SERVER.rootId,
      resultLine: "도구 실행을 마쳤어요",
    });
  });

  it("옛 서버 응답(새 칸 없음)은 칸이 없는 그대로다: decisionMode의 없음은 inline이 아니다", () => {
    const [approval] = approvalsFromWire({ approvals: [CAMEL] });
    for (const key of ["decisionMode", "isDirect", "rootId", "resultLine"]) {
      expect(key in approval, key).toBe(false);
    }
    expect(approval.status).toBe("pending");
  });

  it("모르는 decisionMode는 open이고, 빈 result.line은 문장이 아니다", () => {
    const [odd] = approvalsFromWire({
      approvals: [{ ...SERVER, decisionMode: "sheet", result: { line: "   " } }],
    });
    expect(odd.decisionMode).toBe("open");
    expect("resultLine" in odd).toBe(false);
  });

  it("다섯 상태를 모두 읽는다", () => {
    const statuses = ["pending", "approved", "rejected", "expired", "cancelled"];
    const rows = approvalsFromWire({
      approvals: statuses.map((status, index) => ({ ...SERVER, id: `row-${index}`, status })),
    });
    expect(rows.map((row) => row.status)).toEqual(statuses);
  });

  it("쪽 응답은 nextCursor를 고치지 않고 싣고, 없거나 빈 값이면 다음 쪽이 없다", () => {
    expect(approvalPageFromWire({ approvals: [SERVER], nextCursor: "Ab_9-x==" }).nextCursor).toBe("Ab_9-x==");
    for (const page of [{ approvals: [] }, { approvals: [], nextCursor: "" }, { approvals: [], nextCursor: 7 }]) {
      expect("nextCursor" in approvalPageFromWire(page), JSON.stringify(page)).toBe(false);
    }
    expect(approvalPageFromWire({ approvals: [SERVER] }).approvals).toHaveLength(1);
    expect(approvalPageFromWire(null)).toEqual({ approvals: [] });
  });
});

describe("승인 목록 읽기: scope·cursor (#4763)", () => {
  beforeEach(() => {
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session: {
        getAccessToken: () => "t",
        getRefreshToken: () => null,
        getPersistedSession: () => null,
        applyLogin: () => {},
        applyRotation: () => {},
        markAuthExpired: () => {},
        clearSession: () => {},
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const urlOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => String(fetchMock.mock.calls[call]?.[0]);
  const row = (id: string) => ({ ...CAMEL, id, status: "approved" });

  it("옛 호출은 URL이 그대로다: status가 첫 쿼리이고 scope·cursor는 붙지 않는다", async () => {
    const fetchMock = vi.fn(async () => json({ approvals: [CAMEL] }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchApprovals("ws", "pending", 50);
    expect(urlOf(fetchMock)).toBe("https://oort.test/v1/workspaces/ws/approvals?status=pending&limit=50");
    expect(rows).toHaveLength(1);
  });

  it("scope는 줄 때만 붙는다(기본 team은 서버 몫)", async () => {
    const fetchMock = vi.fn(async () => json({ approvals: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchApprovalPage("ws", { status: "all", scope: "mine", limit: 20 });
    expect(urlOf(fetchMock)).toBe("https://oort.test/v1/workspaces/ws/approvals?status=all&limit=20&scope=mine");
    await fetchApprovals("ws", "pending", 50, { scope: "team" });
    expect(urlOf(fetchMock, 1)).toContain("&scope=team");
  });

  it("nextCursor를 이어 받는다: 다음 읽기는 그 값을 인코딩만 해서 cursor로 보낸다", async () => {
    const OPAQUE = "2026-11-01T09:00:00.123456+00:00|id=Ab/9+x==";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ approvals: [row("a1"), row("a2")], nextCursor: OPAQUE }))
      .mockResolvedValueOnce(json({ approvals: [row("a3")] }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchApprovalPage("ws", { status: "approved", limit: 2 });
    expect(first.approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(first.nextCursor).toBe(OPAQUE);
    expect(urlOf(fetchMock)).not.toContain("cursor");
    const second = await fetchApprovalPage("ws", { status: "approved", limit: 2, cursor: first.nextCursor });
    expect(urlOf(fetchMock, 1)).toContain(`&cursor=${encodeURIComponent(OPAQUE)}`);
    expect(second.approvals.map((a) => a.id)).toEqual(["a3"]);
    // 마지막 쪽에는 다음 쪽이 없다.
    expect("nextCursor" in second).toBe(false);
  });

  it("fetchApprovals는 행 목록을 돌려주고 cursor 옵션을 그대로 넘긴다", async () => {
    const fetchMock = vi.fn(async () => json({ approvals: [row("b1")], nextCursor: "next" }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchApprovals("ws", "rejected", 10, { cursor: "prev" });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["b1"]);
    expect(urlOf(fetchMock)).toBe("https://oort.test/v1/workspaces/ws/approvals?status=rejected&limit=10&cursor=prev");
  });
});
