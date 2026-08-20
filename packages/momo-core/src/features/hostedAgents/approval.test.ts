import { describe, expect, it } from "vitest";
import type { HostedAgentConnection } from "./model";
import {
  approvableChannelIds,
  approvalConsequence,
  APPROVAL_SECURITY_NOTE,
  buildConfirmApproval,
  channelApprovalChoices,
  DEFAULT_HOSTED_SCOPES,
  HOSTED_SCOPE_CHOICES,
  isApprovableChannel,
  normalizeScopes,
  REQUIRED_HOSTED_SCOPE,
  scopeActionList,
  scopeGate,
  type ApprovalChannelInput,
} from "./approval";

// =============================================================================
// #1360 HAP-UX1 — 사람이 내리는 보안 결정.
//
// RED PROOF 넷:
//
//   ① 자격 없는 채널은 전송 본문에 실리지 않는다. `approvableChannelIds` 의
//      `isApprovableChannel` 필터를 지우면 붉어진다.
//   ② 자격 없는 채널이 목록에서 사라지지 않는다. `channelApprovalChoices` 가
//      걸러 내기 시작하면 붉어진다.
//   ③ 결과 문장이 닫히는 쪽을 말한다. 두 번째 문장을 지우면 붉어진다.
//   ④ 접속 권한은 꺼지지 않는다. `normalizeScopes` 의 필수 주입을 지우면 붉어진다.
// =============================================================================

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const ENGINE = "00000000-0000-7000-8000-000000000202";
const ARCHIVED = "00000000-0000-7000-8000-000000000203";
const DM = "00000000-0000-7000-8000-0000000002d1";

function channels(): ApprovalChannelInput[] {
  return [
    { id: GENERAL, label: "#general", kind: "public" },
    { id: ENGINE, label: "#엔진", kind: "private" },
    { id: ARCHIVED, label: "#지난-스프린트", kind: "public", archivedAtMs: 1 },
    { id: DM, label: "성재", kind: "dm" },
  ];
}

function connection(
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "detected",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("RED PROOF ② 자격 없는 줄은 사유와 함께 선다", () => {
  it("DM 과 보관 채널이 목록에서 사라지지 않는다", () => {
    const rows = channelApprovalChoices(channels());
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.id)).toEqual([GENERAL, ENGINE, ARCHIVED, DM]);
  });

  it("고를 수 없는 줄은 잠기고 그 자리에서 이유를 말한다", () => {
    const rows = channelApprovalChoices(channels());
    const dm = rows.find((row) => row.id === DM);
    const archived = rows.find((row) => row.id === ARCHIVED);
    expect(dm?.disabled).toBe(true);
    expect(dm?.detail).toContain("1:1 대화는 승인 대상이 아닙니다");
    expect(archived?.disabled).toBe(true);
    expect(archived?.detail).toContain("보관된 채널입니다");
  });

  it("고를 수 있는 줄도 무엇이 일어나는지 상시로 말한다", () => {
    const rows = channelApprovalChoices(channels());
    expect(rows[0]?.detail).toContain("공개 채널입니다");
    expect(rows[1]?.detail).toContain("비공개 채널입니다");
  });

  it("자격 판정은 서버의 valid_channels 와 같은 규칙이다", () => {
    expect(isApprovableChannel({ id: GENERAL, label: "x", kind: "public" })).toBe(true);
    expect(isApprovableChannel({ id: DM, label: "x", kind: "dm" })).toBe(false);
    expect(
      isApprovableChannel({ id: ARCHIVED, label: "x", kind: "public", archivedAtMs: 1 })
    ).toBe(false);
  });
});

describe("RED PROOF ① 고를 수 없는 것은 보내지 않는다", () => {
  it("DM 과 보관 채널을 골라도 본문에 실리지 않는다", () => {
    expect(approvableChannelIds(channels(), [GENERAL, DM, ARCHIVED])).toEqual([
      GENERAL,
    ]);
  });

  it("목록에 아예 없는 id 는 실리지 않는다", () => {
    expect(
      approvableChannelIds(channels(), ["00000000-0000-7000-8000-0000000009ff"])
    ).toEqual([]);
  });

  it("대소문자가 다른 같은 uuid 는 같은 채널이고 두 번 실리지 않는다", () => {
    expect(
      approvableChannelIds(channels(), [GENERAL.toUpperCase(), GENERAL])
    ).toEqual([GENERAL]);
  });

  it("전송 본문의 agentMemberId 는 커넥션이 들고 있는 값이다", () => {
    const body = buildConfirmApproval(
      connection(),
      channels(),
      [GENERAL, DM],
      ["messages:write", "admin:everything"]
    );
    expect(body).toEqual({
      agentMemberId: AGENT,
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [GENERAL],
      approvedScopes: ["agent:port:connect", "messages:write"],
      authMode: "static_bearer",
    });
  });
});

describe("RED PROOF ④ 접속 권한은 꺼지지 않는다", () => {
  it("고르지 않아도 들어간다", () => {
    expect(normalizeScopes(["messages:read"])).toEqual([
      REQUIRED_HOSTED_SCOPE,
      "messages:read",
    ]);
  });

  it("아무것도 안 골라도 접속 하나는 남는다", () => {
    expect(normalizeScopes([])).toEqual([REQUIRED_HOSTED_SCOPE]);
    expect(scopeGate(normalizeScopes([])).allowed).toBe(true);
  });

  it("이 빌드가 모르는 권한은 버린다", () => {
    expect(normalizeScopes(["admin:everything"])).toEqual([REQUIRED_HOSTED_SCOPE]);
  });

  it("목록 순서를 지키고 중복을 없앤다", () => {
    expect(
      normalizeScopes(["messages:write", "agent:inbox:read", "messages:write"])
    ).toEqual(["agent:port:connect", "agent:inbox:read", "messages:write"]);
  });

  it("접속 줄은 잠겨 있고 왜 잠겼는지 적혀 있다", () => {
    const connect = HOSTED_SCOPE_CHOICES[0];
    expect(connect?.id).toBe(REQUIRED_HOSTED_SCOPE);
    expect(connect?.required).toBe(true);
    expect(connect?.requiredReason).toContain("항상 포함됩니다");
  });

  it("기본값은 부르면 읽고 답하는 최소 조합이다", () => {
    // 작업 두 줄과 지난 대화 읽기는 끄고 시작한다. 최소 권한의 뜻은 기본값이
    // 필요를 따라가는 것이지 다 켜 두고 빼라고 시키는 것이 아니다.
    expect([...DEFAULT_HOSTED_SCOPES]).toEqual([
      "agent:port:connect",
      "agent:inbox:read",
      "messages:write",
    ]);
  });

  it("모든 권한 줄이 자기 결과 문장을 갖는다", () => {
    for (const choice of HOSTED_SCOPE_CHOICES) {
      expect(choice.detail.length).toBeGreaterThan(10);
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });
});

describe("RED PROOF ③ 결과 문장은 닫히는 쪽도 말한다", () => {
  it("무엇을 허락했는지와 무엇이 닫히는지를 한 문단에 적는다", () => {
    const sentence = approvalConsequence("김인턴", 3, [
      "agent:port:connect",
      "agent:inbox:read",
      "messages:write",
    ]);
    expect(sentence).toContain("김인턴은 3개 채널에서");
    expect(sentence).toContain("자기를 부른 메시지 읽기, 메시지 쓰기");
    expect(sentence).toContain("승인하지 않은 채널에서는");
  });

  it("조사를 이름에 맞춘다", () => {
    expect(approvalConsequence("hermes", 1, ["agent:port:connect", "messages:read"])).toContain(
      "hermes는 1개 채널에서"
    );
  });

  it("채널을 하나도 안 고른 것도 결과가 있는 선택이다", () => {
    const sentence = approvalConsequence("김인턴", 0, [
      "agent:port:connect",
      "messages:write",
    ]);
    expect(sentence).toContain("어떤 대화에도 닿지 못합니다");
  });

  it("접속만 고른 것도 결과가 있는 선택이다", () => {
    const sentence = approvalConsequence("김인턴", 2, ["agent:port:connect"]);
    expect(sentence).toContain("읽기도 쓰기도 하지 못합니다");
  });

  it("접속은 행동 목록에 들어가지 않는다", () => {
    // 접속은 다른 권한들이 서 있는 바닥이지 사람이 승인하는 행동이 아니다.
    expect(scopeActionList(["agent:port:connect"])).toEqual([]);
    expect(scopeActionList(["agent:port:connect", "agent:jobs:read"])).toEqual([
      "작업 가져가기",
    ]);
  });

  it("승인이 사람의 보안 결정이라는 사실을 감추지 않는다", () => {
    expect(APPROVAL_SECURITY_NOTE).toContain("사람만 내릴 수 있는 보안 결정");
    expect(APPROVAL_SECURITY_NOTE).toContain("감지됐다는 사실은 권한의 근거가 아니고");
  });
});
