import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsRequest: request,
}));

import {
  completeLogin,
  fetchLoginTargets,
  loginErrorMessage,
  loginReasonLine,
  pasteLooksSendable,
  safeLoginUrl,
  secondsLeft,
  appLoginTarget,
  appShellCommand,
  loginTtlSeconds,
  MODEL_LOGIN_HOSTS,
  startFromWire,
  startLogin,
  statusFromLoginWire,
  targetsFromWire,
} from "./loginRelay";

// #4080/#4074: 붙여넣은 값은 한 번 보내고 돌려받지 않는다. 읽기는 403이면 보이지 않고, 409 login_relay_off 면
// 셸 안내로 간다. 주소는 https 만 연다.

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT = "00000000-0000-7000-8000-0000000000aa";

beforeEach(() => request.mockReset());

describe("wire", () => {
  it("reads the three schemas in camelCase", () => {
    expect(
      startFromWire({
        schema: "momo.login_relay.start.v0",
        loginId: "abc",
        mode: "device",
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: 1760000000,
      })
    ).toEqual({
      loginId: "abc",
      mode: "device",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: 1760000000,
    });
    expect(statusFromLoginWire({ schema: "momo.login_relay.status.v0", status: "failed", reason: "vendor_denied" })).toEqual({
      status: "failed",
      reason: "vendor_denied",
    });
    expect(
      targetsFromWire({
        schema: "momo.login_relay.targets.v0",
        targets: [{ target: "openai-codex", connected: true }],
      })
    ).toEqual([{ target: "openai-codex", connected: true }]);
  });

  it("refuses a wrong schema or an unknown status", () => {
    expect(startFromWire({ schema: "x", loginId: "a", mode: "paste", url: "u", expiresAt: 1 })).toBeNull();
    expect(statusFromLoginWire({ schema: "momo.login_relay.status.v0", status: "weird" })).toBeNull();
  });
});

describe("fetchLoginTargets", () => {
  it("maps 403 to hidden (not an operator) and 409 codes to off / not_cohosted", async () => {
    request.mockRejectedValueOnce(new ApiError(403, "no"));
    expect(await fetchLoginTargets(WS, AGENT, "model")).toEqual({ kind: "hidden" });
    request.mockRejectedValueOnce(new ApiError(409, "off", "login_relay_off"));
    expect(await fetchLoginTargets(WS, AGENT, "model")).toEqual({ kind: "off" });
    request.mockRejectedValueOnce(new ApiError(409, "x", "login_not_cohosted"));
    expect(await fetchLoginTargets(WS, AGENT, "app")).toEqual({ kind: "not_cohosted" });
    request.mockRejectedValueOnce(new ApiError(502, "x"));
    expect(await fetchLoginTargets(WS, AGENT, "model")).toEqual({ kind: "unknown" });
  });

  it("uses the model-login path for model and app-login for app", async () => {
    request.mockResolvedValue({ schema: "momo.login_relay.targets.v0", targets: [] });
    await fetchLoginTargets(WS, AGENT, "model");
    await fetchLoginTargets(WS, AGENT, "app");
    expect(request.mock.calls[0]?.[0]).toBe(`/v1/workspaces/${WS}/agents/${AGENT}/model-login`);
    expect(request.mock.calls[1]?.[0]).toBe(`/v1/workspaces/${WS}/agents/${AGENT}/app-login`);
  });
});

describe("startLogin / completeLogin", () => {
  it("names the target with provider for model and app for app", async () => {
    request.mockResolvedValue({
      schema: "momo.login_relay.start.v0",
      loginId: "abc",
      mode: "paste",
      url: "https://claude.ai/oauth/authorize",
      expiresAt: 1,
    });
    await startLogin(WS, AGENT, "model", "anthropic");
    await startLogin(WS, AGENT, "app", "gmail");
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ provider: "anthropic" });
    expect(JSON.parse(request.mock.calls[1]?.[1].body)).toEqual({ app: "gmail" });
  });

  it("sends the pasted value once and returns only a status", async () => {
    request.mockResolvedValue({ schema: "momo.login_relay.status.v0", status: "submitted" });
    const result = await completeLogin(WS, AGENT, "model", "login_id_0123456789", "MARKER-PASTE-1#state");
    expect(JSON.stringify(result)).not.toContain("MARKER-PASTE");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatch(/\/complete$/);
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ pasted: "MARKER-PASTE-1#state" });
  });

  it("an error carries a fixed sentence and never the value", async () => {
    const error = new ApiError(400, "server said MARKER-PASTE-2", "state_mismatch");
    expect(loginErrorMessage(error)).not.toContain("MARKER");
    expect(loginErrorMessage(new ApiError(400, "MARKER-PASTE-2"))).not.toContain("MARKER");
  });
});

describe("helpers", () => {
  it("opens only https addresses without credentials", () => {
    expect(safeLoginUrl("https://claude.ai/oauth/authorize?x=1")?.host).toBe("claude.ai");
    expect(safeLoginUrl("http://claude.ai/")).toBeNull();
    expect(safeLoginUrl("javascript:alert(1)")).toBeNull();
    expect(safeLoginUrl("https://claude.ai@evil.example/")).toBeNull();
    expect(safeLoginUrl("not a url")).toBeNull();
  });

  it("limits model logins to the vendor hosts and turns the server clock into a length once", () => {
    expect(safeLoginUrl("https://claude.ai/x", MODEL_LOGIN_HOSTS)?.host).toBe("claude.ai");
    expect(safeLoginUrl("https://claude.ai.evil.example/x", MODEL_LOGIN_HOSTS)).toBeNull();
    expect(loginTtlSeconds(1000 + 290, 1_000_000)).toBe(290);
    expect(loginTtlSeconds(1, 1_000_000)).toBe(300);
    expect(loginTtlSeconds(9_999_999_999, 1_000_000)).toBe(300);
  });

  it("maps the three Google apps to the probe command and leaves other apps to hermes mcp login", () => {
    expect(appLoginTarget("com.momo.plugins.gmail")).toBe("gmail");
    expect(appLoginTarget("com.momo.plugins.github")).toBeNull();
    expect(appShellCommand("google_calendar")).toContain("mcp_login_probe.py google_calendar");
    expect(appShellCommand("notion")).toBe("railway ssh -- hermes mcp login -- notion");
  });

  it("checks the paste shape like the server", () => {
    expect(pasteLooksSendable("abc#def")).toBe(true);
    expect(pasteLooksSendable("  ")).toBe(false);
    expect(pasteLooksSendable("a\nb")).toBe(false);
    expect(pasteLooksSendable("a".repeat(2049))).toBe(false);
  });

  it("counts down to zero", () => {
    expect(secondsLeft(100, 99_000)).toBe(1);
    expect(secondsLeft(100, 101_000)).toBe(0);
  });

  it("explains an ended login with a closed word set", () => {
    expect(loginReasonLine({ status: "failed", reason: "state_mismatch" })).toContain("이 로그인에서 받은 것이 아니었어요");
    expect(loginReasonLine({ status: "done", reason: null })).toBe("로그인됐어요.");
  });
});
