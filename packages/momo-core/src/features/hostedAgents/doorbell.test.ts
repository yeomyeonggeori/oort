import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  applyDoorbellRegistration,
  doorbellFailureMessage,
  doorbellLastStatusLabel,
  doorbellLastStatusTone,
  doorbellProjection,
  doorbellSecretIssue,
  doorbellUrlIssue,
  isDoorbellGateClosed,
  parseHostedDoorbellResponse,
  type HostedDoorbellRegistration,
} from "./doorbell";
import type { HostedAgentConnection } from "./model";

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const SECRET = "crsr_live_this_must_not_appear";

function connection(
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "active",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: ["agent:port:connect"],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("투영", () => {
  it("URL 과 마스킹이 둘 다 있어야 등록된 것이다", () => {
    expect(doorbellProjection(connection())).toBeNull();
    expect(
      doorbellProjection(connection({ doorbellUrl: "https://hooks.example/a" }))
    ).toBeNull();
    expect(
      doorbellProjection(connection({ doorbellSecretMasked: "••••abcd" }))
    ).toBeNull();
    expect(
      doorbellProjection(
        connection({
          doorbellUrl: "https://hooks.example/a",
          doorbellSecretMasked: "••••abcd",
          doorbellLastFiredAtMs: 9,
          doorbellLastStatus: "ok_200",
        })
      )
    ).toEqual({
      url: "https://hooks.example/a",
      secretMasked: "••••abcd",
      lastFiredAtMs: 9,
      lastStatus: "ok_200",
    });
  });
});

describe("RED PROOF 응답 파서는 시크릿 원문을 싣지 못한다", () => {
  it("서버가 secret 칸을 실어도 결과 타입에 남지 않는다", () => {
    const parsed = parseHostedDoorbellResponse({
      connectionId: CONNECTION,
      url: "https://hooks.example/a",
      secretMasked: "••••abcd",
      registeredAtMs: 2,
      secret: SECRET,
      doorbellSecret: SECRET,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "connectionId",
      "registeredAtMs",
      "secretMasked",
      "url",
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(parsed.secretMasked).toBe("••••abcd");
  });

  it("필수 칸이 없으면 반쯤 그린 등록으로 읽지 않는다", () => {
    expect(() =>
      parseHostedDoorbellResponse({
        connectionId: CONNECTION,
        url: "https://hooks.example/a",
        secretMasked: "••••abcd",
      })
    ).toThrow(WireShapeError);
  });
});

describe("등록을 커넥션 줄에 반영", () => {
  const registered: HostedDoorbellRegistration = {
    connectionId: CONNECTION,
    url: "https://hooks.example/b",
    secretMasked: "••••wxyz",
    registeredAtMs: 8,
  };

  it("옛 발화 칸을 남기지 않는다", () => {
    const next = applyDoorbellRegistration(
      connection({
        doorbellUrl: "https://hooks.example/a",
        doorbellSecretMasked: "••••abcd",
        doorbellLastFiredAtMs: 9,
        doorbellLastStatus: "ok_200",
      }),
      registered
    );
    expect(next.doorbellUrl).toBe("https://hooks.example/b");
    expect(next.doorbellSecretMasked).toBe("••••wxyz");
    expect(next.doorbellLastFiredAtMs).toBeUndefined();
    expect(next.doorbellLastStatus).toBeUndefined();
    expect(JSON.stringify(next)).not.toContain(SECRET);
  });

  it("해제는 네 칸을 모두 뗀다", () => {
    const next = applyDoorbellRegistration(
      connection({
        doorbellUrl: "https://hooks.example/a",
        doorbellSecretMasked: "••••abcd",
        doorbellLastFiredAtMs: 9,
        doorbellLastStatus: "ok_200",
      }),
      null
    );
    expect(next.doorbellUrl).toBeUndefined();
    expect(next.doorbellSecretMasked).toBeUndefined();
    expect(next.doorbellLastFiredAtMs).toBeUndefined();
    expect(next.doorbellLastStatus).toBeUndefined();
  });
});

describe("입력 규칙", () => {
  it("https 만 받는다", () => {
    expect(doorbellUrlIssue("")).toBe("https 주소를 입력하세요.");
    expect(doorbellUrlIssue("http://hooks.example/a")).toBe(
      "https 주소만 등록됩니다."
    );
    expect(doorbellUrlIssue("not a url")).toBe("https 주소를 입력하세요.");
    expect(doorbellUrlIssue("https://hooks.example/a")).toBeNull();
  });

  it("시크릿은 비면 안 되고 상한을 넘으면 안 된다", () => {
    expect(doorbellSecretIssue("")).toBe("sender key를 입력하세요.");
    expect(doorbellSecretIssue("   ")).toBe("sender key를 입력하세요.");
    expect(doorbellSecretIssue("crsr_ok")).toBeNull();
    expect(doorbellSecretIssue("x".repeat(4097))).toBe(
      "sender key가 너무 깁니다."
    );
  });
});

describe("게이트 닫힘과 실패 문구", () => {
  it("본문 없는 404 만 게이트 닫힘으로 읽는다", () => {
    expect(isDoorbellGateClosed(new ApiError(404, "HTTP 404"))).toBe(true);
    expect(isDoorbellGateClosed(new ApiError(404, ""))).toBe(true);
    expect(
      isDoorbellGateClosed(new ApiError(404, "doorbell is not registered"))
    ).toBe(false);
    expect(
      isDoorbellGateClosed(new ApiError(404, "hosted connection not found"))
    ).toBe(false);
    expect(isDoorbellGateClosed(new ApiError(400, "HTTP 400"))).toBe(false);
  });

  it("계약 문구는 한국어 문장으로 사상되고 wire 원문은 화면에 남지 않는다", () => {
    const empty = doorbellFailureMessage(
      "register",
      new ApiError(400, "doorbell secret must not be empty")
    );
    expect(empty).toBe(
      "도어벨을 등록하지 못했습니다. sender key가 비어 있습니다. 값을 넣고 다시 시도하세요."
    );
    const notActive = doorbellFailureMessage(
      "register",
      new ApiError(409, "doorbell requires an active hosted connection")
    );
    expect(notActive).toContain("활성 연결에서만");
    expect(notActive).not.toContain("hosted connection");
    const gone = doorbellFailureMessage(
      "unregister",
      new ApiError(404, "doorbell is not registered")
    );
    expect(gone).toContain("등록된 도어벨이 없습니다");
    expect(gone).not.toContain("not registered");
    const ssrf = doorbellFailureMessage(
      "register",
      new ApiError(400, "webhook URL resolves to a private or reserved address")
    );
    expect(ssrf).toContain("사설망·예약 대역");
    expect(ssrf).not.toContain("private or reserved");
    // 목록 밖 400 은 일반 안내로 떨어지고, 역시 wire 를 되뱉지 않는다.
    const unknown = doorbellFailureMessage(
      "register",
      new ApiError(400, "some future contract message")
    );
    expect(unknown).toContain("입력값이 서버 계약과 맞지 않습니다");
    expect(unknown).not.toContain("some future contract message");
  });

  it("시크릿 원문을 실패 문구에 잇지 않는다", () => {
    const message = doorbellFailureMessage(
      "register",
      new ApiError(500, SECRET)
    );
    expect(message).not.toContain(SECRET);
    expect(message).toContain("도어벨을 등록하지 못했습니다.");
  });

  it("아무도 답하지 않은 것과 서버가 거절한 것은 다른 문장이다", () => {
    const network = doorbellFailureMessage(
      "register",
      new NetworkError("timeout", 15_000)
    );
    expect(network).toContain("도어벨을 등록하지 못했습니다.");
    expect(network).toContain("15초");
    expect(
      doorbellFailureMessage("unregister", new WireShapeError())
    ).toContain("서버 응답을 확인하지 못했습니다");
  });
});

describe("마지막 상태 톤", () => {
  it("ok_ 만 성공이다", () => {
    expect(doorbellLastStatusTone("ok_200")).toBe("ok");
    expect(doorbellLastStatusTone("http_500")).toBe("warn");
    expect(doorbellLastStatusTone("ssrf")).toBe("warn");
    expect(doorbellLastStatusTone(undefined)).toBe("muted");
  });

  it("칩 본문은 한국어 낱말이다", () => {
    expect(doorbellLastStatusLabel("ok_200")).toBe("성공");
    expect(doorbellLastStatusLabel("http_500")).toBe("실패");
    expect(doorbellLastStatusLabel(undefined)).toBe("없음");
  });
});
