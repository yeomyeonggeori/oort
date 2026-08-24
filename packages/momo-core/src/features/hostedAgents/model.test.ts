import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  boundedLabel,
  connectionFacts,
  hostedFailureMessage,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  isHostedOperatorDenied,
  isHostedTerminal,
  parseActivationIssuance,
  parseHostedConnection,
  parseHostedConnections,
  parsePairingIssuance,
  toHostedConnection,
  type HostedAgentConnection,
} from "./model";

// =============================================================================
// #1360 HAP-UX1 — wire 경계와 문구.
//
// RED PROOF 넷:
//
//   ① 목록/조회 파서를 통과한 줄에는 비밀값이 없다. `toHostedConnection` 의
//      필드별 재구성을 스프레드로 바꾸면 붉어진다.
//   ② 이 빌드가 모르는 scope 는 승인 요약에 들어가지 않는다. `isHostedScope`
//      필터를 지우면 붉어진다.
//   ③ 승인 응답은 방금 요청한 커넥션의 것이어야 하고, 자격증명 id 가 커넥션이
//      가리키는 것과 같아야 한다. 두 대조 중 하나를 지우면 붉어진다.
//   ④ 실패 문구는 서버 영어 문장을 절대 잇지 않는다. `statusAdvice` 대신 wire
//      message 를 쓰면 붉어진다.
// =============================================================================

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const CREDENTIAL = "00000000-0000-7000-8000-0000000000e1";
const CHANNEL = "00000000-0000-7000-8000-000000000201";

function wireConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function connection(
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("RED PROOF ① 파서를 통과한 줄은 비밀값을 실어 나르지 못한다", () => {
  it("서버가 약속을 어기고 비밀값을 실어도 화면 타입에 남지 않는다", () => {
    const row = toHostedConnection(
      wireConnection({
        pairingCredential: "momo_pair_v1.leaked",
        credential: "momo_agent_v1.leaked",
        detectedClientName: "<img onerror=alert(1)>",
      })
    );
    expect(row).not.toBeNull();
    expect(Object.keys(row as object).sort()).toEqual([
      "agentMemberId",
      "approvedChannelIds",
      "approvedScopes",
      "audience",
      "authMode",
      "createdAtMs",
      "id",
      "status",
      "updatedAtMs",
    ]);
  });

  it("도어벨 원문은 버리고 마스킹만 남긴다", () => {
    const leaked = "crsr_live_this_must_not_appear";
    const row = toHostedConnection(
      wireConnection({
        doorbellUrl: "https://hooks.example/a",
        doorbellSecretMasked: "••••abcd",
        doorbellSecret: leaked,
        doorbellLastFiredAtMs: 9,
        doorbellLastStatus: "ok_200",
      })
    );
    expect(row).not.toBeNull();
    expect(row?.doorbellUrl).toBe("https://hooks.example/a");
    expect(row?.doorbellSecretMasked).toBe("••••abcd");
    expect(row?.doorbellLastFiredAtMs).toBe(9);
    expect(row?.doorbellLastStatus).toBe("ok_200");
    expect(row as object).not.toHaveProperty("doorbellSecret");
    expect(JSON.stringify(row)).not.toContain(leaked);
  });

  it("필수 칸이 하나라도 없으면 반쯤 그린 줄 대신 아무것도 안 준다", () => {
    expect(toHostedConnection(wireConnection({ status: "wat" }))).toBeNull();
    expect(toHostedConnection(wireConnection({ approvedChannelIds: null }))).toBeNull();
    expect(toHostedConnection(wireConnection({ createdAtMs: "1700" }))).toBeNull();
    expect(toHostedConnection(null)).toBeNull();
  });

  it("목록은 최근에 만든 것이 위로 오고 읽을 수 없는 줄은 빠진다", () => {
    const rows = parseHostedConnections({
      connections: [
        wireConnection({ id: CONNECTION, createdAtMs: 1 }),
        wireConnection({ id: CREDENTIAL, createdAtMs: 2 }),
        { id: "broken" },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual([CREDENTIAL, CONNECTION]);
  });
});

describe("RED PROOF ② 모르는 권한은 승인 요약에 들어가지 않는다", () => {
  it("닫힌 집합 밖의 scope 는 버린다", () => {
    const row = toHostedConnection(
      wireConnection({
        approvedScopes: ["agent:port:connect", "admin:everything", "messages:read"],
      })
    );
    expect(row?.approvedScopes).toEqual(["agent:port:connect", "messages:read"]);
  });

  it("같은 scope 가 두 번 와도 한 번만 센다", () => {
    const row = toHostedConnection(
      wireConnection({ approvedScopes: ["messages:read", "messages:read"] })
    );
    expect(row?.approvedScopes).toEqual(["messages:read"]);
  });
});

describe("발급 응답", () => {
  it("pairing 값은 pairing_pending 상태의 응답에서만 받는다", () => {
    const issuance = parsePairingIssuance({
      connection: wireConnection(),
      pairingCredential: "momo_pair_v1.x",
      pairingExpiresAtMs: 1_700_000_900_000,
    });
    expect(issuance.pairingCredential).toBe("momo_pair_v1.x");
    expect(() =>
      parsePairingIssuance({
        connection: wireConnection({ status: "detected" }),
        pairingCredential: "momo_pair_v1.x",
        pairingExpiresAtMs: 1,
      })
    ).toThrow(WireShapeError);
  });

  it("재발급은 방금 그 커넥션의 응답이어야 한다", () => {
    expect(() =>
      parsePairingIssuance(
        {
          connection: wireConnection({ id: CREDENTIAL }),
          pairingCredential: "momo_pair_v1.x",
          pairingExpiresAtMs: 1,
        },
        { connectionId: CONNECTION }
      )
    ).toThrow(WireShapeError);
  });
});

describe("RED PROOF ③ 승인 응답의 두 대조", () => {
  const body = {
    connection: wireConnection({
      status: "detected",
      activeCredentialId: CREDENTIAL,
      approvedChannelIds: [CHANNEL],
      approvedScopes: ["agent:port:connect"],
    }),
    credentialId: CREDENTIAL,
    credential: "momo_agent_v1.secret",
    tokenType: "Bearer",
  };

  it("승인 뒤에도 상태는 detected 다 (증명이 아직 안 왔다)", () => {
    const issued = parseActivationIssuance(body, { connectionId: CONNECTION });
    expect(issued.connection.status).toBe("detected");
    expect(issued.credential).toBe("momo_agent_v1.secret");
  });

  it("다른 커넥션을 설명하는 응답은 저장하라고 내밀 값이 아니다", () => {
    expect(() =>
      parseActivationIssuance(body, { connectionId: CREDENTIAL })
    ).toThrow(WireShapeError);
  });

  it("커넥션이 가리키는 자격증명과 다른 id 는 거절한다", () => {
    expect(() =>
      parseActivationIssuance(
        { ...body, credentialId: AGENT },
        { connectionId: CONNECTION }
      )
    ).toThrow(WireShapeError);
  });

  it("서버가 곧바로 active 를 답하는 날에도 깨지지 않는다", () => {
    // 상태는 서버가 정한다. 이 파서가 막는 것은 상태가 아니라 **엉뚱한 커넥션**이다.
    const issued = parseActivationIssuance(
      {
        ...body,
        connection: wireConnection({
          status: "active",
          activeCredentialId: CREDENTIAL,
        }),
      },
      { connectionId: CONNECTION }
    );
    expect(issued.connection.status).toBe("active");
  });

  it("아직 다이얼인도 안 한 커넥션의 응답은 승인 완료로 읽지 않는다", () => {
    expect(() =>
      parseActivationIssuance(
        { ...body, connection: wireConnection({ activeCredentialId: CREDENTIAL }) },
        { connectionId: CONNECTION }
      )
    ).toThrow(WireShapeError);
  });

  it("단건 조회는 커넥션 하나만 읽고 cleanup manifest 는 보지 않는다", () => {
    const row = parseHostedConnection({
      connection: wireConnection({ status: "active" }),
      cleanupArtifacts: [{ id: "x" }],
    });
    expect(row.status).toBe("active");
  });
});

describe("상태 어휘", () => {
  it("detected 는 한 상태에 두 문장이다", () => {
    // 승인 전과 증명 대기는 같은 상태 이름 아래 서로 다른 자리다. 문장 하나를
    // 고집하면 둘 중 하나는 반드시 거짓말이 된다.
    const before = hostedStatusDetail(connection({ status: "detected" }));
    const after = hostedStatusDetail(
      connection({ status: "detected", activeCredentialId: CREDENTIAL })
    );
    expect(before).not.toBe(after);
    expect(before).toContain("아무 권한도 열리지 않았습니다");
    expect(after).toContain("첫 증명이 성공해야");
  });

  it("만료와 감지는 서로 다른 톤을 받는다", () => {
    expect(hostedStatusTone("expired")).toBe("danger");
    expect(hostedStatusTone("detected")).toBe("warn");
    expect(hostedStatusTone("active")).toBe("ok");
    expect(hostedStatusLabel("pairing_pending")).toBe("연결 대기");
  });

  it("해제 계열은 이 마법사의 것이 아니다", () => {
    expect(isHostedTerminal("cleanup_pending")).toBe(true);
    expect(isHostedTerminal("disconnected")).toBe(true);
    expect(isHostedTerminal("expired")).toBe(false);
  });
});

describe("감지 화면이 그리는 사실", () => {
  it("키 집합이 닫혀 있다", () => {
    // 이 목록이 열리면 "서버가 준 다른 필드도 한 줄 추가"가 자연스러워지고, 그
    // 습관이 provider 가 보낸 문자열을 화면에 올린다.
    const facts = connectionFacts(connection({ status: "detected" }), "김인턴");
    expect(facts.map((fact) => fact.key)).toEqual([
      "전용 에이전트",
      "연결 상태",
      "인증 방식",
      "허용 대상",
    ]);
  });

  it("모르는 인증 방식을 아는 척하지 않는다", () => {
    const facts = connectionFacts(connection({ authMode: "oauth" }), "김인턴");
    expect(facts[2]?.value).toBe("이 빌드가 모르는 방식");
  });
});

describe("이름 다듬기", () => {
  it("제어문자와 줄바꿈이 승인 요약을 미로로 만들지 못한다", () => {
    expect(boundedLabel("김인턴\n\t 봇")).toBe("김인턴 봇");
  });

  it("긴 이름은 잘리고 잘렸다는 표시가 남는다", () => {
    expect(boundedLabel("가".repeat(70))).toBe(`${"가".repeat(60)}…`);
  });

  it("짧은 이름은 그대로 둔다", () => {
    expect(boundedLabel("hermes")).toBe("hermes");
  });
});

describe("RED PROOF ④ 실패 문구", () => {
  it("서버가 보낸 영어 문장을 화면에 잇지 않는다", () => {
    const message = hostedFailureMessage(
      "confirm",
      new ApiError(400, "approved channels are not eligible")
    );
    expect(message).not.toContain("approved channels");
    expect(message).toContain("다시 고르세요");
  });

  it("같은 상태 코드도 동작에 따라 다음 행동이 다르다", () => {
    expect(hostedFailureMessage("create", new ApiError(409, "x"))).toContain(
      "다른 핸들"
    );
    expect(hostedFailureMessage("regenerate", new ApiError(409, "x"))).toContain(
      "이미 활성이거나"
    );
    expect(hostedFailureMessage("confirm", new ApiError(409, "x"))).toContain(
      "이미 승인됐거나"
    );
  });

  it("권한 부족은 누가 할 수 있는지 말한다", () => {
    expect(hostedFailureMessage("list", new ApiError(403, "x"))).toContain(
      "오너나 관리자"
    );
    expect(isHostedOperatorDenied(new ApiError(403, "x"))).toBe(true);
    expect(isHostedOperatorDenied(new ApiError(500, "x"))).toBe(false);
  });

  it("아무도 답하지 않은 것과 서버가 거절한 것은 다른 문장이다", () => {
    const network = hostedFailureMessage(
      "get",
      new NetworkError("timeout", 15_000)
    );
    expect(network).toContain("연결 상태를 불러오지 못했습니다.");
    expect(network).toContain("15초");
    expect(hostedFailureMessage("get", new WireShapeError())).toContain(
      "서버 응답을 확인하지 못했습니다"
    );
  });
});
