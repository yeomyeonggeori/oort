import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsRequest: request,
}));

import {
  COHOSTED_COPY,
  connectCohosted,
  connectErrorMessage,
  fetchCohostedStatus,
  probeCohosted,
  probeFromWire,
  probeLine,
  statusFromWire,
} from "./cohostedAgent";

// #3883 짝 UI: 카드는 선언·운영자·길이 없으면 아무것도 그리지 않고(hidden), 잠금 확인 전에는
// 「연결할 수 있다」고 암시하지 않으며, 도구 신호는 증명이 아니다.

const STATUS = {
  schema: "momo.cohosted_agent.status.v0",
  declaration: "ready",
  endpointLabel: "http://hermes.railway.internal:8642/v1",
  toolsLockAttested: true,
  connectable: true,
};
const PROBE = {
  schema: "momo.cohosted_agent.probe.v0",
  state: "ok",
  requestsSent: 3,
  modelCount: 2,
  toolsLockAttested: true,
  toolsets: { signal: "dangerous_listed", listed: ["terminal"], proof: false },
  connectable: true,
};

beforeEach(() => request.mockReset());

describe("status", () => {
  it("is hidden for a stranger, an old server and an undeclared instance", async () => {
    request.mockRejectedValueOnce(new ApiError(403, "no"));
    expect(await fetchCohostedStatus("w")).toEqual({ kind: "hidden" });
    request.mockRejectedValueOnce(new ApiError(404, "no"));
    expect(await fetchCohostedStatus("w")).toEqual({ kind: "hidden" });
    request.mockResolvedValueOnce({ ...STATUS, declaration: "not_declared", toolsLockAttested: false, connectable: false });
    expect(await fetchCohostedStatus("w")).toEqual({ kind: "hidden" });
  });

  it("shows when declared, and treats a body it cannot read as unknown rather than hidden", async () => {
    request.mockResolvedValueOnce(STATUS);
    expect((await fetchCohostedStatus("w")).kind).toBe("ready");
    request.mockResolvedValueOnce({ schema: "proxy" });
    expect((await fetchCohostedStatus("w")).kind).toBe("unknown");
    request.mockRejectedValueOnce(new ApiError(500, "boom"));
    expect((await fetchCohostedStatus("w")).kind).toBe("unknown");
    // 연결 자체가 끊긴 것은 이 카드가 말할 일이 아니다(다른 절이 오프라인을 말한다).
    request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await fetchCohostedStatus("w")).kind).toBe("hidden");
  });

  it("refuses an unknown declaration word", () => {
    expect(statusFromWire({ ...STATUS, declaration: "maybe" })).toBeNull();
  });
});

// #4337 (ADR-0203 증보 2026-10-25 F2·수용 기준 11): `environment`는 안내 문구를 고르는 값이다. 옛 서버·깨진 답·미래 서버에서
// 그 필드만 「모름」으로 접히고 상태 읽기는 살아 있어야 한다. 서버 쪽 모양의 정본은 docs/api/cohosted-agent-status.golden.json
// (이 패키지는 파일을 읽을 수 없어 사례를 직접 적는다).
describe("environment", () => {
  const UNKNOWN = { platform: "unknown", loginRelay: "unknown" };

  it("reads every word the server can say, field by field", () => {
    for (const platform of ["railway", "compose", "unknown"] as const) {
      for (const loginRelay of ["on", "off"] as const) {
        const status = statusFromWire({ ...STATUS, environment: { platform, loginRelay } });
        expect(status?.environment).toEqual({ platform, loginRelay });
      }
    }
  });

  it("reads an old server (no environment) as unknown without losing the status", async () => {
    const status = statusFromWire(STATUS);
    expect(status).toMatchObject({ declaration: "ready", connectable: true, toolsLockAttested: true });
    expect(status?.environment).toEqual(UNKNOWN);
    request.mockResolvedValueOnce(STATUS);
    const read = await fetchCohostedStatus("w");
    expect(read.kind).toBe("ready");
    expect(read.kind === "ready" && read.status.environment).toEqual(UNKNOWN);
  });

  it("reads a body that is not an object as unknown, whatever it is", () => {
    for (const broken of ["railway", 7, true, null, [], ["platform", "railway"], [{ platform: "railway" }]]) {
      const status = statusFromWire({ ...STATUS, environment: broken });
      expect(status, JSON.stringify(broken)).not.toBeNull();
      expect(status?.environment, JSON.stringify(broken)).toEqual(UNKNOWN);
    }
  });

  it("folds a future server's words outside the allow-list, only the field that is outside", () => {
    // 미래 서버가 플랫폼을 하나 더 알아도 로그인 중계 값은 그대로 읽는다. 반대도 같다.
    expect(statusFromWire({ ...STATUS, environment: { platform: "render", loginRelay: "on" } })?.environment).toEqual({
      platform: "unknown",
      loginRelay: "on",
    });
    expect(statusFromWire({ ...STATUS, environment: { platform: "railway", loginRelay: "maybe" } })?.environment).toEqual({
      platform: "railway",
      loginRelay: "unknown",
    });
    // 낱말은 있는 그대로만 통과한다: 대소문자·공백·불리언·숫자는 허용 목록 밖이다.
    for (const platform of ["Railway", " railway", "railway ", "RAILWAY", "", 1, true, null]) {
      expect(statusFromWire({ ...STATUS, environment: { platform, loginRelay: "off" } })?.environment, String(platform)).toEqual({
        platform: "unknown",
        loginRelay: "off",
      });
    }
    for (const loginRelay of ["ON", "true", "", 1, true, false, null]) {
      expect(statusFromWire({ ...STATUS, environment: { platform: "compose", loginRelay } })?.environment, String(loginRelay)).toEqual({
        platform: "compose",
        loginRelay: "unknown",
      });
    }
    // 읽기 전체는 그대로 산다.
    expect(statusFromWire({ ...STATUS, environment: { platform: "render", loginRelay: "maybe" } })).not.toBeNull();
  });

  it("reads one-sided answers: the missing field is unknown, the other is kept", () => {
    expect(statusFromWire({ ...STATUS, environment: { platform: "compose" } })?.environment).toEqual({
      platform: "compose",
      loginRelay: "unknown",
    });
    expect(statusFromWire({ ...STATUS, environment: { loginRelay: "off" } })?.environment).toEqual({
      platform: "unknown",
      loginRelay: "off",
    });
    expect(statusFromWire({ ...STATUS, environment: {} })?.environment).toEqual(UNKNOWN);
  });

  it("lets no string through: an extra key or a stray value never reaches the parsed status", () => {
    const status = statusFromWire({
      ...STATUS,
      environment: { platform: "railway", loginRelay: "on", stamp: "MARKER-STAMP-4337", id: "MARKER-RWENV-4337" },
    });
    expect(Object.keys(status?.environment ?? {}).sort()).toEqual(["loginRelay", "platform"]);
    expect(JSON.stringify(status)).not.toContain("MARKER");
    const odd = statusFromWire({ ...STATUS, environment: { platform: "MARKER-PLATFORM-4337", loginRelay: "MARKER-RELAY-4337" } });
    expect(odd?.environment).toEqual(UNKNOWN);
    expect(JSON.stringify(odd)).not.toContain("MARKER");
  });

  it("changes nothing else about the read: undeclared stays hidden, the other answers keep their meaning", async () => {
    request.mockResolvedValueOnce({
      ...STATUS,
      declaration: "not_declared",
      toolsLockAttested: false,
      connectable: false,
      environment: { platform: "compose", loginRelay: "off" },
    });
    expect(await fetchCohostedStatus("w")).toEqual({ kind: "hidden" });
    request.mockResolvedValueOnce({ ...STATUS, environment: { platform: "railway", loginRelay: "on" } });
    const read = await fetchCohostedStatus("w");
    expect(read.kind === "ready" && read.status).toMatchObject({ declaration: "ready", connectable: true, environment: { platform: "railway" } });
    // 모양이 틀린 본문은 여전히 unknown이고, 환경 때문에 새로 버려지는 일은 없다.
    request.mockResolvedValueOnce({ schema: "proxy", environment: { platform: "railway", loginRelay: "on" } });
    expect((await fetchCohostedStatus("w")).kind).toBe("unknown");
  });
});

describe("probe", () => {
  it("reads the closed vocabulary and says a toolsets signal is not proof", () => {
    const probe = probeFromWire(PROBE);
    expect(probe).toMatchObject({ state: "ok", toolsets: "dangerous_listed", toolsetsListed: ["terminal"] });
    expect(probeFromWire({ ...PROBE, state: "who-knows" })).toBeNull();
    expect(COHOSTED_COPY.toolsetsNone).toContain("증명은 아니에요");
  });

  it("asks for the toolsets signal only when told to", async () => {
    request.mockResolvedValue(PROBE);
    await probeCohosted("w", true);
    expect(JSON.parse(String((request.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ checkToolsets: true });
    expect((request.mock.calls[0] as [string, RequestInit])[0]).toBe("/v1/workspaces/w/cohosted-agent/probe");
  });

  it("has a next step for every failure class", () => {
    for (const state of ["rejected", "unreachable", "rate_limited", "key_missing", "url_refused", "unknown"] as const) {
      expect(probeLine(state, null)).toMatch(/[가-힣]/);
    }
    expect(probeLine("ok", null)).toBeNull();
  });
});

describe("connect", () => {
  it("posts an empty body (no name, URL or key rides along)", async () => {
    request.mockResolvedValueOnce({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" });
    expect(await connectCohosted("w")).toMatchObject({ agentId: "a1" });
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/workspaces/w/cohosted-agent/connect");
    expect(init.body).toBe("{}");
  });

  it("names refusals by code", () => {
    expect(connectErrorMessage(new ApiError(409, "x", "cohosted_tools_lock_not_attested"))).toContain("도구 잠금 선언");
    expect(connectErrorMessage(new ApiError(409, "x", "cohosted_agent_already_connected"))).toContain("이미");
    expect(connectErrorMessage(new ApiError(403, "x"))).toContain("운영자");
    expect(connectErrorMessage(new Error("net"))).toContain("연결하지 못했어요");
  });
});

describe("honest labels", () => {
  it("never claims oort verified the tool lock, and offers no connect before attestation", () => {
    expect(COHOSTED_COPY.attestNote).toContain("운영자님이 서버에 직접 선언한 값");
    expect(COHOSTED_COPY.attestNote).toContain("확인한 것이 아니에요");
    expect(COHOSTED_COPY.checklistLead).not.toContain("연결할까요");
  });
});
