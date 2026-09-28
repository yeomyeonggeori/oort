import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import { permissionFailure } from "../workbench/agentPane";
import { fetchHumanControlSignatureRequired, parseSigningContext } from "./deviceKeys";
import {
  HUMAN_SIGNATURE_REFUSAL,
  humanSignatureRefusal,
  INSTRUCT_IN_APP_LINE,
  instructFrom,
} from "./humanSignature";

// #3029 (R2-E9) · #3028 E3 인계. 서명 오류 코드와 status는 E3 골든
// (`work-permission-decision.golden.json` `device_signature_error_codes`, PR #3075)을
// 옮겨 적는다. track/uxui의 골든은 E3 이전이라 여기서 import하지 않는다.
const SIGNATURE_CODES: ReadonlyArray<readonly [string, number]> = [
  ["device_signature_required", 403],
  ["device_signature_invalid", 403],
  ["device_key_revoked", 403],
  ["device_key_not_endorsed", 403],
  ["device_signature_expired", 403],
  ["device_nonce_replayed", 409],
  ["instance_id_unconfigured", 503],
];

const OWNER_ONLY = permissionFailure(new ApiError(403, "", "permission_owner_only")).text;
const CLOSED = permissionFailure(new ApiError(409, "", "permission_request_closed")).text;
const GENERIC = permissionFailure(new TypeError("fetch failed")).text;

describe("device-signature refusals (E3 golden codes)", () => {
  it("the constant list is the golden list", () => {
    expect(Object.values(HUMAN_SIGNATURE_REFUSAL).sort()).toEqual(SIGNATURE_CODES.map(([c]) => c).sort());
  });

  it.each(SIGNATURE_CODES)("%s → its own sentence on the permission card, never owner-only or closed", (code, status) => {
    const failure = permissionFailure(new ApiError(status, "server words", code));
    expect(failure.text).not.toBe(OWNER_ONLY);
    expect(failure.text).not.toBe(CLOSED);
    expect(failure.text).not.toBe(GENERIC);
    expect(failure.text).toBe(humanSignatureRefusal({ code })!.text);
    // 서명 거부는 요청을 닫지 않는다: 거부(서명 없음)는 여전히 보낼 수 있다.
    expect(failure.closed).toBe(false);
    expect(failure.text).not.toContain(code);
    expect(failure.text).toMatch(/요\.$/);
  });

  it("every code has a distinct sentence and a distinct next action", () => {
    const refusals = SIGNATURE_CODES.map(([code]) => humanSignatureRefusal({ code })!);
    expect(new Set(refusals.map((r) => r.text)).size).toBe(SIGNATURE_CODES.length);
    expect(new Set(refusals.map((r) => r.fix)).size).toBe(SIGNATURE_CODES.length);
  });

  it("names the action the person takes", () => {
    const text = (code: string) => humanSignatureRefusal({ code })!.text;
    expect(text("device_signature_required")).toContain(INSTRUCT_IN_APP_LINE);
    expect(text("device_key_revoked")).toContain("설정 › 기기 › 지시 서명");
    expect(text("device_key_revoked")).toContain("다시 등록");
    expect(text("device_key_not_endorsed")).toContain("맥의 oort 앱");
    expect(text("device_signature_expired")).toContain("시계");
  });

  it("other errors are not signature refusals", () => {
    expect(humanSignatureRefusal(new ApiError(403, "", "permission_owner_only"))).toBeNull();
    expect(humanSignatureRefusal(new ApiError(403, "device_signature_required"))).toBeNull();
    expect(humanSignatureRefusal(null)).toBeNull();
    expect(humanSignatureRefusal("device_key_revoked")).toBeNull();
  });

  it("a plain 403 and 409 keep their old sentences", () => {
    expect(permissionFailure(new ApiError(403, "")).text).toBe(OWNER_ONLY);
    expect(permissionFailure(new ApiError(409, "")).text).toBe(CLOSED);
  });
});

describe("instructFrom (ADR-0146 개정 D-4 · D-11)", () => {
  it.each([
    [false, true, "app"],
    [false, false, "here"],
    [false, null, "here"],
    [true, true, "here"],
    [true, false, "here"],
    [true, null, "here"],
  ] as const)("desktopShell=%s required=%s → %s", (desktopShell, signatureRequired, expected) => {
    expect(instructFrom({ desktopShell, signatureRequired })).toBe(expected);
  });
});

function installHost() {
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const WS = "00000000-0000-7000-8000-000000000001";
const CONTEXT = {
  instanceId: "oort-team",
  serverTimeMs: 1_790_550_000_000,
  maxLifetimeMs: 600_000,
  maxClockSkewMs: 300_000,
  humanControlSignatureRequired: true,
  hostRegisterSignatureRequired: false,
};

describe("signing context (E3 SigningContextResponse)", () => {
  it("parses the flag and rejects a body without it", () => {
    expect(parseSigningContext(CONTEXT).humanControlSignatureRequired).toBe(true);
    expect(() => parseSigningContext({ ...CONTEXT, humanControlSignatureRequired: "yes" })).toThrow();
    expect(() => parseSigningContext({ ...CONTEXT, instanceId: "" })).toThrow();
  });

  it.each([
    [200, CONTEXT, true],
    [200, { ...CONTEXT, humanControlSignatureRequired: false }, false],
    [200, { nope: 1 }, null],
    [404, { error: { message: "not found" } }, null],
    [503, { error: { message: "x", code: "instance_id_unconfigured" } }, null],
  ] as const)("HTTP %s → %s", async (status, body, expected) => {
    installHost();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHumanControlSignatureRequired(WS)).resolves.toBe(expected);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://oort.test/v1/workspaces/${WS}/device-keys/signing-context`
    );
  });

  it("a network error is unknown, not off", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(fetchHumanControlSignatureRequired(WS)).resolves.toBeNull();
  });
});
