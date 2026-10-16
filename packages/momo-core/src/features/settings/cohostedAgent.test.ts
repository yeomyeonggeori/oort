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
