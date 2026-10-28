import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  buildCliApprove,
  buildCliDeny,
  classifyCliDecisionError,
  CLI_CONSENT_CREDENTIAL_LIMIT,
  CLI_CONSENT_RERUN,
  CLI_CONSENT_RETRY_LATER,
  CLI_PRESET_SEND_UNAVAILABLE,
  CLI_SCOPES,
  cliCanApprove,
  cliCanDeny,
  CliLoginApiError,
  cliConsentLifetime,
  cliConsentScreen,
  cliGrantedScopes,
  cliRetryWhen,
  cliScopePresetChoices,
  cliScopeSentences,
  CliRedirectRefusedError,
  displayDeviceName,
  effectiveCliPreset,
  parseCliConsentPreview,
  parseCliDecision,
  safeCliRedirect,
  type CliConsentPreview,
  type CliScope,
} from "./consent";

// =============================================================================
// oort CLI 브라우저 로그인 동의: 파서·허용 범위·돌아갈 곳 방어·오류 분류·화면 선택.
// 전부 순수 함수라 DOM 없이 호출자가 보는 결과(반환값·던진 오류)만 단정한다.
// =============================================================================

const WRITE: CliScope = "dev:messages:write";

function wirePreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientName: "oort CLI",
    clientId: "oort-cli",
    issuer: "https://oort.dalmuri.example",
    serverHost: "oort.dalmuri.example",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    workspaceName: "달무리 스튜디오",
    memberDisplayName: "이도현",
    role: "owner",
    deviceName: "oort CLI · macOS",
    requestedScopes: [...CLI_SCOPES],
    canSend: true,
    expiresAtMs: 1_000_000,
    accessMinutes: 15,
    idleDays: 30,
    maxDays: 90,
    ...overrides,
  };
}

function preview(overrides: Partial<CliConsentPreview> = {}): CliConsentPreview {
  return { ...parseCliConsentPreview(wirePreview()), ...overrides };
}

function apiError(
  status: number,
  code?: string,
  retryAfterSeconds?: number
): CliLoginApiError {
  return new CliLoginApiError(status, "server sentence", code, retryAfterSeconds);
}

describe("parseCliConsentPreview", () => {
  it("서버 사실을 이름 붙은 필드로 다시 짓는다", () => {
    const parsed = parseCliConsentPreview(wirePreview());
    expect(parsed).toEqual({
      clientName: "oort CLI",
      serverHost: "oort.dalmuri.example",
      workspaceName: "달무리 스튜디오",
      memberDisplayName: "이도현",
      roleLabel: "소유자",
      deviceName: "oort CLI · macOS",
      requestedScopes: [...CLI_SCOPES],
      canSend: true,
      expiresAtMs: 1_000_000,
      accessMinutes: 15,
      idleDays: 30,
      maxDays: 90,
    });
  });

  it("모르는 필드는 버린다(비밀값이 섞여 와도 타입에 실리지 않는다)", () => {
    const parsed = parseCliConsentPreview(
      wirePreview({ code: "leak", accessToken: "leak", clientId: "oort-cli" })
    );
    expect(Object.keys(parsed)).not.toContain("code");
    expect(Object.keys(parsed)).not.toContain("accessToken");
  });

  it("모르는 범위는 거르고 정규 순서로 중복 없이 남긴다", () => {
    const parsed = parseCliConsentPreview(
      wirePreview({
        requestedScopes: [
          "dev:inbox:read",
          "dev:admin",
          "messages:read",
          "dev:identity",
          "dev:inbox:read",
          "dev:channels:read",
        ],
      })
    );
    expect(parsed.requestedScopes).toEqual([
      "dev:identity",
      "dev:channels:read",
      "dev:inbox:read",
    ]);
  });

  it("아는 범위가 하나도 없으면 읽지 못한 응답이다", () => {
    expect(() =>
      parseCliConsentPreview(wirePreview({ requestedScopes: ["dev:admin"] }))
    ).toThrow(WireShapeError);
  });

  it("보내기는 서버가 허락했고 요청에 쓰기가 있을 때만 고를 수 있다", () => {
    const readOnly = [
      "dev:identity",
      "dev:channels:read",
      "dev:messages:read",
      "dev:inbox:read",
    ];
    expect(
      parseCliConsentPreview(wirePreview({ requestedScopes: readOnly, canSend: true }))
        .canSend
    ).toBe(false);
    expect(
      parseCliConsentPreview(wirePreview({ canSend: false })).canSend
    ).toBe(false);
    expect(parseCliConsentPreview(wirePreview({ canSend: true })).canSend).toBe(true);
  });

  it.each([
    "clientName",
    "serverHost",
    "workspaceName",
    "memberDisplayName",
    "requestedScopes",
    "canSend",
    "expiresAtMs",
    "accessMinutes",
    "idleDays",
    "maxDays",
  ])("%s 가 빠진 응답은 반쯤 그리지 않고 던진다", (key) => {
    const wire = wirePreview();
    delete wire[key];
    expect(() => parseCliConsentPreview(wire)).toThrow(WireShapeError);
  });

  it("객체가 아닌 응답과 잘못된 칸 형식도 던진다", () => {
    expect(() => parseCliConsentPreview(null)).toThrow(WireShapeError);
    expect(() => parseCliConsentPreview("x")).toThrow(WireShapeError);
    expect(() => parseCliConsentPreview(wirePreview({ canSend: "yes" }))).toThrow(
      WireShapeError
    );
    expect(() => parseCliConsentPreview(wirePreview({ deviceName: 7 }))).toThrow(
      WireShapeError
    );
  });

  it("기기 이름이 없거나 null 이면 null 이다", () => {
    expect(parseCliConsentPreview(wirePreview({ deviceName: null })).deviceName).toBeNull();
    const wire = wirePreview();
    delete wire.deviceName;
    expect(parseCliConsentPreview(wire).deviceName).toBeNull();
  });

  it("모르는 역할은 이름만 그리고 역할 말은 비운다", () => {
    expect(parseCliConsentPreview(wirePreview({ role: "admin" })).roleLabel).toBe("관리자");
    expect(parseCliConsentPreview(wirePreview({ role: "guest" })).roleLabel).toBe("게스트");
    expect(parseCliConsentPreview(wirePreview({ role: "root" })).roleLabel).toBeNull();
    expect(parseCliConsentPreview(wirePreview({ role: "__proto__" })).roleLabel).toBeNull();
    const wire = wirePreview();
    delete wire.role;
    expect(parseCliConsentPreview(wire).roleLabel).toBeNull();
  });
});

describe("displayDeviceName", () => {
  it("보이는 순서를 뒤집는 방향 문자와 너비 없는 문자를 걷어낸다", () => {
    expect(displayDeviceName("oort CLI ‮skcolb‬")).toBe("oort CLI skcolb");
    expect(displayDeviceName("ma​c⁦book⁩﻿")).toBe("macbook");
  });

  it("제어 문자와 줄바꿈은 공백 한 칸으로 모은다", () => {
    expect(displayDeviceName("  oort\tCLI \n macOS  ")).toBe("oort CLI macOS");
    expect(displayDeviceName("a\u0000b\u007Fc")).toBe("abc");
  });

  it("남는 것이 없으면 이름이 없는 것과 같다", () => {
    expect(displayDeviceName("")).toBeNull();
    expect(displayDeviceName(" ‮​ ")).toBeNull();
  });

  it("보통의 이름은 그대로 둔다", () => {
    expect(displayDeviceName("oort CLI · macOS")).toBe("oort CLI · macOS");
    expect(displayDeviceName("이도현의 작업실 맥")).toBe("이도현의 작업실 맥");
  });
});

describe("허용 범위 프리셋", () => {
  it("읽기만은 요청 ∩ 읽기이고, 읽기와 보내기는 요청 전체다", () => {
    expect(cliGrantedScopes([...CLI_SCOPES], "read")).toEqual([
      "dev:identity",
      "dev:channels:read",
      "dev:messages:read",
      "dev:inbox:read",
    ]);
    expect(cliGrantedScopes([...CLI_SCOPES], "read-send")).toEqual([...CLI_SCOPES]);
    expect(cliGrantedScopes(["dev:identity", WRITE], "read")).toEqual(["dev:identity"]);
  });

  it("읽기만 본문은 approvedScopes 키 자체를 싣지 않는다", () => {
    const body = buildCliApprove({
      request: "signed.envelope",
      currentPassword: "pw",
      preset: "read",
      requestedScopes: [...CLI_SCOPES],
    });
    expect(body).toEqual({ request: "signed.envelope", currentPassword: "pw" });
    expect("approvedScopes" in body).toBe(false);
  });

  it("읽기와 보내기 본문은 요청 범위 전체를 싣는다", () => {
    const requested: CliScope[] = ["dev:identity", "dev:messages:read", WRITE];
    const body = buildCliApprove({
      request: "signed.envelope",
      currentPassword: "pw",
      preset: "read-send",
      requestedScopes: requested,
    });
    expect(body.approvedScopes).toEqual(requested);
    expect(body.approvedScopes).not.toBe(requested);
  });

  it("거절 본문은 요청 봉투 하나뿐이다(비밀번호도 범위도 없다)", () => {
    expect(buildCliDeny("signed.envelope")).toEqual({ request: "signed.envelope" });
  });

  it("보낼 수 없는 요청에서는 읽기와 보내기가 이유와 함께 막힌다", () => {
    const blocked = cliScopePresetChoices({
      canSend: false,
      requestedScopes: [...CLI_SCOPES],
    });
    expect(blocked.map((choice) => choice.id)).toEqual(["read", "read-send"]);
    expect(blocked[0]?.disabled).toBeUndefined();
    expect(blocked[1]?.disabled).toBe(true);
    expect(blocked[1]?.detail).toBe(CLI_PRESET_SEND_UNAVAILABLE);
    const open = cliScopePresetChoices({
      canSend: true,
      requestedScopes: [...CLI_SCOPES],
    });
    expect(open[1]?.disabled).toBeUndefined();
    expect(open[1]?.detail).not.toBe(CLI_PRESET_SEND_UNAVAILABLE);
  });

  it("프리셋 설명은 이 요청이 실제로 담은 범위를 풀어쓴다", () => {
    const requested: CliScope[] = [
      "dev:identity",
      "dev:channels:read",
      "dev:messages:read",
      "dev:messages:write",
    ];
    const [read, readSend] = cliScopePresetChoices({
      canSend: true,
      requestedScopes: requested,
    });
    const all = cliScopeSentences([...CLI_SCOPES]);
    const [identity, channels, messages, write, inbox] = [
      all[0],
      all[1],
      all[2],
      all[3],
      all[4],
    ] as string[];
    // 읽기만: 요청 ∩ 읽기. 받은 편지함은 요청에 없어서 없고, 쓰기는 이 프리셋 밖이다.
    for (const line of [identity, channels, messages]) expect(read?.detail).toContain(line);
    for (const line of [inbox, write]) expect(read?.detail).not.toContain(line);
    // 읽기와 보내기: 요청 전체. 요청에 없는 받은 편지함은 여기에도 없다.
    for (const line of [identity, channels, messages, write]) {
      expect(readSend?.detail).toContain(line);
    }
    expect(readSend?.detail).not.toContain(inbox);
  });

  it("고를 수 없게 된 프리셋은 읽기만으로 돌아간다", () => {
    expect(effectiveCliPreset("read-send", { canSend: false })).toBe("read");
    expect(effectiveCliPreset("read-send", { canSend: true })).toBe("read-send");
    expect(effectiveCliPreset("read", { canSend: true })).toBe("read");
  });

  it("범위를 사람 말로 정규 순서로 풀어쓴다", () => {
    const read = cliScopeSentences(cliGrantedScopes([...CLI_SCOPES], "read"));
    const send = cliScopeSentences(cliGrantedScopes([...CLI_SCOPES], "read-send"));
    expect(read).toHaveLength(4);
    expect(send).toHaveLength(5);
    expect(new Set(send).size).toBe(5);
    expect(send.filter((line) => !read.includes(line))).toHaveLength(1);
  });
});

describe("safeCliRedirect: 따라가도 되는 콜백", () => {
  const OK =
    "http://127.0.0.1:24681/callback?code=abc&state=xyz&iss=https%3A%2F%2Foort.dalmuri.example";

  it("루프백 콜백(허용)과 error 콜백(거절)을 직렬화한 주소로 돌려준다", () => {
    expect(safeCliRedirect(OK)).toBe(OK);
    const denied =
      "http://127.0.0.1:24685/callback?error=access_denied&state=xyz&iss=https%3A%2F%2Foort.dalmuri.example";
    expect(safeCliRedirect(denied)).toBe(denied);
  });

  it("검사한 것과 브라우저가 여는 것이 같은 한 줄이다(파서가 지우는 문자는 돌려주는 값에 없다)", () => {
    const tricky = "http://127.0.0.1:24681/call\tback?code=a\nb";
    const safe = safeCliRedirect(tricky);
    expect(safe).toBe("http://127.0.0.1:24681/callback?code=ab");
    expect(safe).not.toContain("\t");
    expect(safe).not.toContain("\n");
  });

  it.each([
    ["localhost", "http://localhost:24681/callback?code=a"],
    ["IPv6 루프백", "http://[::1]:24681/callback?code=a"],
    ["https", "https://127.0.0.1:24681/callback?code=a"],
    ["다른 경로", "http://127.0.0.1:24681/other?code=a"],
    ["끝 슬래시", "http://127.0.0.1:24681/callback/?code=a"],
    ["하위 경로", "http://127.0.0.1:24681/callback/extra?code=a"],
    ["포트 없음", "http://127.0.0.1/callback?code=a"],
    ["기본 포트", "http://127.0.0.1:80/callback?code=a"],
    ["계정 정보", "http://user@127.0.0.1:24681/callback?code=a"],
    ["계정 정보와 비밀번호", "http://user:pw@127.0.0.1:24681/callback?code=a"],
    ["@ 뒤의 다른 호스트", "http://127.0.0.1:24681@evil.test/callback?code=a"],
    ["이어 붙인 호스트", "http://127.0.0.1.evil.test:24681/callback?code=a"],
    ["백슬래시 우회", "http://127.0.0.1:24681\\@evil.test/callback?code=a"],
    ["다른 호스트", "http://evil.test:24681/callback?code=a"],
    ["조각", "http://127.0.0.1:24681/callback?code=a#frag"],
    ["프로토콜 상대", "//127.0.0.1:24681/callback?code=a"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,x"],
    ["빈 문자열", ""],
    ["주소가 아님", "not a url"],
  ])("%s 는 따라가지 않는다", (_name, url) => {
    expect(safeCliRedirect(url)).toBeNull();
  });
});

describe("parseCliDecision", () => {
  it("안전한 콜백이면 그 주소를 돌려준다", () => {
    const url = "http://127.0.0.1:24681/callback?code=abc&state=xyz&iss=i";
    expect(parseCliDecision({ redirectTo: url })).toEqual({ redirectTo: url });
  });

  it("칸이 없거나 비면 읽지 못한 응답이다", () => {
    expect(() => parseCliDecision({})).toThrow(WireShapeError);
    expect(() => parseCliDecision({ redirectTo: "" })).toThrow(WireShapeError);
    expect(() => parseCliDecision({ redirectTo: 7 })).toThrow(WireShapeError);
    expect(() => parseCliDecision(null)).toThrow(WireShapeError);
  });

  it("안전하지 않은 주소는 거절 오류로 던진다", () => {
    expect(() =>
      parseCliDecision({ redirectTo: "https://evil.test/callback?code=abc" })
    ).toThrow(CliRedirectRefusedError);
    expect(() =>
      parseCliDecision({ redirectTo: "http://localhost:24681/callback?code=abc" })
    ).toThrow(CliRedirectRefusedError);
  });
});

describe("classifyCliDecisionError", () => {
  it("401 은 다시 로그인으로 되돌린다", () => {
    expect(classifyCliDecisionError("approve", apiError(401))).toEqual({
      kind: "session-expired",
    });
  });

  it("틀린 비밀번호는 폼에 남아 비밀번호만 다시 받는다", () => {
    expect(
      classifyCliDecisionError("approve", apiError(403, "current_password_incorrect"))
    ).toEqual({ kind: "wrong-password" });
  });

  it.each([
    [403, "current_password_unavailable", "password-unavailable"],
    [403, "dev_access_denied", "access-denied"],
    [403, undefined, "access-denied"],
    [404, "dev_login_request_not_found", "not-found"],
    [404, undefined, "not-found"],
    [409, "dev_login_already_decided", "already-decided"],
    [409, undefined, "already-decided"],
  ] as const)("%i %s 는 종료 화면 %s 로 접힌다", (status, code, terminal) => {
    expect(classifyCliDecisionError("approve", apiError(status, code))).toEqual({
      kind: "terminal",
      terminal,
    });
  });

  it("로그인 기기 한도는 종료가 아니라 폼 위 안내다", () => {
    expect(
      classifyCliDecisionError("approve", apiError(409, "dev_credential_limit"))
    ).toEqual({ kind: "failure", message: CLI_CONSENT_CREDENTIAL_LIMIT });
  });

  it("429 와 503 은 서버가 알려 준 기다릴 시간을 말한다", () => {
    const limited = classifyCliDecisionError("approve", apiError(429, undefined, 42));
    expect(limited.kind).toBe("failure");
    expect(limited.kind === "failure" && limited.message).toContain("42");
    const busy = classifyCliDecisionError("approve", apiError(503, undefined, 2));
    expect(busy.kind === "failure" && busy.message).toContain("2");
  });

  it("기다릴 시간을 모르면 일반 문구로 말한다", () => {
    for (const status of [429, 503]) {
      const outcome = classifyCliDecisionError("approve", apiError(status));
      expect(outcome.kind === "failure" && outcome.message).toContain(
        CLI_CONSENT_RETRY_LATER
      );
    }
  });

  it("거절 실패는 거절이라고, 허용 실패는 허용이라고 말한다", () => {
    const approve = classifyCliDecisionError("approve", apiError(500));
    const deny = classifyCliDecisionError("deny", apiError(500));
    expect(approve.kind === "failure" && deny.kind === "failure").toBe(true);
    expect(approve).not.toEqual(deny);
  });

  it("400 은 터미널에서 다시 시작하라고 말한다", () => {
    const outcome = classifyCliDecisionError("approve", apiError(400));
    expect(outcome.kind === "failure" && outcome.message).toContain(CLI_CONSENT_RERUN);
  });

  it("네트워크 실패는 그 문장을 그대로 싣고 폼에 남는다", () => {
    const network = new NetworkError("unreachable", 15_000);
    const outcome = classifyCliDecisionError("approve", network);
    expect(outcome.kind).toBe("failure");
    expect(outcome.kind === "failure" && outcome.message).toContain(network.message);
  });

  it("200 인데 읽을 수 없는 응답과 안전하지 않은 돌아갈 곳은 다시 시도시키지 않는다", () => {
    const expected = { kind: "terminal", terminal: "redirect-refused" };
    expect(classifyCliDecisionError("approve", new WireShapeError())).toEqual(expected);
    expect(classifyCliDecisionError("deny", new CliRedirectRefusedError())).toEqual(
      expected
    );
  });

  it("서버 문장은 어느 경우에도 화면 문구에 이어 붙지 않는다", () => {
    const outcomes = [
      classifyCliDecisionError("approve", apiError(500)),
      classifyCliDecisionError("approve", apiError(429, undefined, 5)),
      classifyCliDecisionError("approve", apiError(409, "dev_credential_limit")),
    ];
    for (const outcome of outcomes) {
      expect(outcome.kind === "failure" && outcome.message).not.toContain(
        "server sentence"
      );
    }
  });

  it("ApiError 가 아닌 오류는 일반 실패다", () => {
    const outcome = classifyCliDecisionError("approve", new Error("boom"));
    expect(outcome.kind).toBe("failure");
    expect(outcome.kind === "failure" && outcome.message).not.toContain("boom");
    expect(
      classifyCliDecisionError("approve", new ApiError(401, "x")).kind
    ).toBe("session-expired");
  });
});

describe("cliRetryWhen", () => {
  it("초는 초로, 길면 분으로 올려 말한다", () => {
    expect(cliRetryWhen(1)).toBe("1초 뒤");
    expect(cliRetryWhen(41.2)).toBe("42초 뒤");
    expect(cliRetryWhen(90)).toBe("90초 뒤");
    expect(cliRetryWhen(91)).toBe("약 2분 뒤");
    expect(cliRetryWhen(600)).toBe("약 10분 뒤");
  });

  it("모르거나 쓸 수 없는 값은 null 이다", () => {
    expect(cliRetryWhen(undefined)).toBeNull();
    expect(cliRetryWhen(0)).toBeNull();
    expect(cliRetryWhen(Number.NaN)).toBeNull();
    expect(cliRetryWhen(-3)).toBeNull();
  });
});

describe("cliConsentScreen", () => {
  const NOW = 500_000;
  const base = {
    decisionTerminal: null,
    returning: false,
    previewPending: false,
    previewError: null,
    data: preview(),
    nowMs: NOW,
  } as const;

  it("정상이고 만료 전이면 폼이다", () => {
    expect(cliConsentScreen(base)).toEqual({ kind: "form" });
  });

  it("불러오는 동안과 데이터가 아직 없을 때는 로딩이다", () => {
    expect(cliConsentScreen({ ...base, previewPending: true, data: null })).toEqual({
      kind: "loading",
    });
    expect(cliConsentScreen({ ...base, data: null })).toEqual({ kind: "loading" });
  });

  it("결정이 낸 종료와 돌아가는 중은 preview 상태보다 앞선다", () => {
    expect(
      cliConsentScreen({ ...base, decisionTerminal: "already-decided" })
    ).toEqual({ kind: "terminal", terminal: "already-decided" });
    expect(cliConsentScreen({ ...base, returning: true })).toEqual({ kind: "returning" });
    expect(
      cliConsentScreen({
        ...base,
        returning: true,
        decisionTerminal: "redirect-refused",
      })
    ).toEqual({ kind: "terminal", terminal: "redirect-refused" });
  });

  it("preview 의 401 은 재시도 배너 대신 로딩으로 덮는다(로그인으로 되돌리는 중)", () => {
    expect(
      cliConsentScreen({ ...base, data: null, previewError: apiError(401) })
    ).toEqual({ kind: "loading" });
  });

  it("preview 의 404·409·403 은 종료다", () => {
    expect(
      cliConsentScreen({ ...base, data: null, previewError: apiError(404) })
    ).toEqual({ kind: "terminal", terminal: "not-found" });
    expect(
      cliConsentScreen({ ...base, data: null, previewError: apiError(403, "dev_access_denied") })
    ).toEqual({ kind: "terminal", terminal: "access-denied" });
  });

  it("preview 의 503·네트워크·읽지 못한 응답은 다시 시도 배너다", () => {
    for (const previewError of [
      apiError(503, undefined, 3),
      new NetworkError("timeout", 15_000),
      new WireShapeError(),
    ]) {
      const screen = cliConsentScreen({ ...base, data: null, previewError });
      expect(screen.kind).toBe("retry");
    }
    const busy = cliConsentScreen({
      ...base,
      data: null,
      previewError: apiError(503, undefined, 3),
    });
    expect(busy.kind === "retry" && busy.message).toContain("3");
  });

  it("만료된 요청에는 폼을 세우지 않는다", () => {
    expect(cliConsentScreen({ ...base, nowMs: 1_000_000 })).toEqual({
      kind: "terminal",
      terminal: "expired",
    });
    expect(cliConsentScreen({ ...base, nowMs: 999_999 }).kind).toBe("form");
  });
});

describe("cliCanApprove / cliCanDeny", () => {
  const idle = { hasPassword: true, offline: false, busy: false, decided: false };

  it("허용은 비밀번호가 있고 막는 것이 없을 때만 누를 수 있다", () => {
    expect(cliCanApprove(idle)).toBe(true);
    expect(cliCanApprove({ ...idle, hasPassword: false })).toBe(false);
    expect(cliCanApprove({ ...idle, offline: true })).toBe(false);
    expect(cliCanApprove({ ...idle, busy: true })).toBe(false);
    expect(cliCanApprove({ ...idle, decided: true })).toBe(false);
  });

  it("거절은 비밀번호 없이도 누를 수 있고, 나머지는 같다", () => {
    expect(cliCanDeny({ offline: false, busy: false, decided: false })).toBe(true);
    expect(cliCanDeny({ offline: true, busy: false, decided: false })).toBe(false);
    expect(cliCanDeny({ offline: false, busy: true, decided: false })).toBe(false);
    expect(cliCanDeny({ offline: false, busy: false, decided: true })).toBe(false);
  });
});

describe("cliConsentLifetime", () => {
  it("서버가 준 숫자를 그대로 말한다", () => {
    const text = cliConsentLifetime({ maxDays: 90, idleDays: 30, accessMinutes: 15 });
    for (const value of ["90", "30", "15"]) expect(text).toContain(value);
    const other = cliConsentLifetime({ maxDays: 7, idleDays: 3, accessMinutes: 5 });
    expect(other).not.toContain("90");
    for (const value of ["7", "3", "5"]) expect(other).toContain(value);
  });
});
