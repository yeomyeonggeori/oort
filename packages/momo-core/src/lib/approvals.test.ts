import { describe, expect, it } from "vitest";
import { approvalsFromWire } from "./api";

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
