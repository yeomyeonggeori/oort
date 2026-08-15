import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import type { ApprovalChannelInput } from "./approval";
import {
  buildOauthApprove,
  buildOauthDeny,
  isOauthAlreadyDecided,
  isOauthRequestUnavailable,
  isOauthSessionExpired,
  normalizeOauthScopes,
  oauthConsentConsequence,
  oauthConsentFacts,
  oauthConsentFailureMessage,
  oauthRequestExpiry,
  oauthScopeChoices,
  parseOauthConsentPreview,
  parseOauthDecision,
} from "./oauthConsent";

// =============================================================================
// #1369 HAP-UX4 — resource-owner OAuth consent 판정.
//
// RED PROOF 다섯:
//
//   ① preview 는 이름 붙은 필드만 다시 짓는다. 필수 칸이 빠지거나 접속 상한이
//      없으면 `WireShapeError`. 스프레드로 바꾸면 붉어진다.
//   ② 승인 범위는 요청된 상한을 넘지 못하고 접속을 반드시 포함한다.
//      `normalizeOauthScopes` 의 상한 필터를 지우면 붉어진다.
//   ③ decision 의 redirectTo 는 절대 http(s) 여야 한다. javascript:/data: 를
//      통과시키면 붉어진다.
//   ④ 404 와 403 은 한 문장이다(non-enumerable). 어떤 실패 문구도 static bearer 로
//      내려가라고 말하지 않는다.
//   ⑤ 결과 문장은 닫히는 쪽을 말한다.
// =============================================================================

const REQUEST = "signed.envelope.value";
const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const DM = "00000000-0000-7000-8000-0000000002d1";

function previewWire(overrides: Record<string, unknown> = {}): unknown {
  return {
    clientId: "grok-bot",
    redirectUri: "https://grok.example/callback",
    resource: "https://oort.example/v1/mcp/agent-port",
    issuer: "https://oort.example",
    requestedScopes: ["agent:port:connect", "agent:inbox:read", "messages:write"],
    expiresAtMs: 1_000_000,
    candidates: [
      {
        connectionId: CONNECTION,
        agentMemberId: AGENT,
        agentDisplayName: "Grok 리서치",
        createdAtMs: 10,
      },
    ],
    ...overrides,
  };
}

function channels(): ApprovalChannelInput[] {
  return [
    { id: GENERAL, label: "#general", kind: "public" },
    { id: DM, label: "성재", kind: "dm" },
  ];
}

describe("RED PROOF ① preview 는 이름 붙은 필드만 다시 짓는다", () => {
  it("필드를 그대로 읽고 candidate 를 파싱한다", () => {
    const preview = parseOauthConsentPreview(previewWire());
    expect(preview.clientId).toBe("grok-bot");
    expect(preview.redirectUri).toBe("https://grok.example/callback");
    expect(preview.resource).toBe("https://oort.example/v1/mcp/agent-port");
    expect(preview.issuer).toBe("https://oort.example");
    expect(preview.expiresAtMs).toBe(1_000_000);
    expect(preview.requestedScopes).toEqual([
      "agent:port:connect",
      "agent:inbox:read",
      "messages:write",
    ]);
    expect(preview.candidates).toEqual([
      {
        connectionId: CONNECTION,
        agentMemberId: AGENT,
        agentDisplayName: "Grok 리서치",
        createdAtMs: 10,
      },
    ]);
  });

  it("서버가 몰래 더 실은 필드는 타입에 닿지 못한다", () => {
    const preview = parseOauthConsentPreview(
      previewWire({ accessToken: "momo_oauth_at_v1.leak", code: "leak" })
    );
    expect(Object.keys(preview)).toEqual([
      "clientId",
      "redirectUri",
      "resource",
      "issuer",
      "requestedScopes",
      "expiresAtMs",
      "candidates",
    ]);
  });

  it("이 빌드가 모르는 scope 는 버린다", () => {
    const preview = parseOauthConsentPreview(
      previewWire({
        requestedScopes: ["agent:port:connect", "work:control", "messages:write"],
      })
    );
    expect(preview.requestedScopes).toEqual([
      "agent:port:connect",
      "messages:write",
    ]);
  });

  it("필수 칸이 빠지면 형상 오류다", () => {
    for (const missing of [
      "clientId",
      "redirectUri",
      "resource",
      "issuer",
      "requestedScopes",
      "expiresAtMs",
      "candidates",
    ]) {
      const wire = previewWire();
      delete (wire as Record<string, unknown>)[missing];
      expect(() => parseOauthConsentPreview(wire)).toThrow(WireShapeError);
    }
  });

  it("접속 상한이 없는 요청은 그리지 않는다", () => {
    expect(() =>
      parseOauthConsentPreview(previewWire({ requestedScopes: ["messages:write"] }))
    ).toThrow(WireShapeError);
  });

  it("반쯤 그린 candidate 는 조용히 빠진다", () => {
    const preview = parseOauthConsentPreview(
      previewWire({
        candidates: [
          { connectionId: CONNECTION, agentMemberId: AGENT, agentDisplayName: "온전" , createdAtMs: 1 },
          { connectionId: "x", agentDisplayName: "빠진 멤버id", createdAtMs: 2 },
        ],
      })
    );
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.agentDisplayName).toBe("온전");
  });
});

describe("RED PROOF ② 승인 범위는 요청된 상한을 넘지 못한다", () => {
  const requested = ["agent:port:connect", "agent:inbox:read", "messages:write"] as const;

  it("요청 밖 scope 는 버리고 접속은 반드시 넣는다", () => {
    const scopes = normalizeOauthScopes(requested, [
      "messages:write",
      "messages:read", // 요청되지 않음
      "agent:jobs:read", // 요청되지 않음
    ]);
    expect(scopes).toEqual(["agent:port:connect", "messages:write"]);
  });

  it("아무것도 안 골라도 접속은 남는다", () => {
    expect(normalizeOauthScopes(requested, [])).toEqual(["agent:port:connect"]);
  });

  it("정규 순서로 정렬하고 중복을 없앤다", () => {
    const scopes = normalizeOauthScopes(requested, [
      "messages:write",
      "agent:inbox:read",
      "messages:write",
    ]);
    expect(scopes).toEqual([
      "agent:port:connect",
      "agent:inbox:read",
      "messages:write",
    ]);
  });

  it("권한 줄은 요청된 상한만 세우고 접속은 잠긴다", () => {
    const rows = oauthScopeChoices(requested);
    expect(rows.map((row) => row.id)).toEqual([
      "agent:port:connect",
      "agent:inbox:read",
      "messages:write",
    ]);
    expect(rows[0]?.required).toBe(true);
  });

  it("approve 본문은 자격 없는 채널과 요청 밖 scope 를 싣지 않는다", () => {
    const body = buildOauthApprove(
      REQUEST,
      CONNECTION,
      requested,
      ["messages:write", "agent:jobs:read"],
      channels(),
      [GENERAL, DM] // DM 은 승인 대상이 아니다
    );
    expect(body).toEqual({
      request: REQUEST,
      connectionId: CONNECTION,
      approvedScopes: ["agent:port:connect", "messages:write"],
      approvedChannelIds: [GENERAL],
    });
  });

  it("deny 본문은 scope·channel 을 싣지 않는다", () => {
    expect(buildOauthDeny(REQUEST, CONNECTION)).toEqual({
      request: REQUEST,
      connectionId: CONNECTION,
    });
  });
});

describe("RED PROOF ③ decision 의 redirectTo 는 절대 http(s) 여야 한다", () => {
  it("정상 응답을 읽는다", () => {
    const result = parseOauthDecision(
      { redirectTo: "https://grok.example/callback?code=abc&state=s&iss=i", connectionId: CONNECTION },
      { connectionId: CONNECTION }
    );
    expect(result.redirectTo).toContain("https://grok.example/callback");
    expect(result.connectionId).toBe(CONNECTION);
  });

  it("javascript: 나 data: scheme 을 통과시키지 않는다", () => {
    for (const redirectTo of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "not a url",
      "",
    ]) {
      expect(() =>
        parseOauthDecision({ redirectTo, connectionId: CONNECTION }, { connectionId: CONNECTION })
      ).toThrow(WireShapeError);
    }
  });

  it("다른 연결의 결정이면 그 redirect 를 따라가지 않는다", () => {
    expect(() =>
      parseOauthDecision(
        { redirectTo: "https://grok.example/cb", connectionId: AGENT },
        { connectionId: CONNECTION }
      )
    ).toThrow(WireShapeError);
  });

  it("대소문자만 다른 연결 id 는 같은 것으로 본다", () => {
    const result = parseOauthDecision(
      { redirectTo: "https://grok.example/cb", connectionId: CONNECTION.toUpperCase() },
      { connectionId: CONNECTION }
    );
    expect(result.connectionId).toBe(CONNECTION.toUpperCase());
  });
});

describe("RED PROOF ④ 없는 것과 거절된 것은 한 문장이고 fallback 이 없다", () => {
  it("403 과 404 는 글자까지 같은 문구다", () => {
    const at403 = oauthConsentFailureMessage("approve", new ApiError(403, "x"));
    const at404 = oauthConsentFailureMessage("approve", new ApiError(404, "y"));
    expect(at403).toBe(at404);
    expect(isOauthRequestUnavailable(new ApiError(404, ""))).toBe(true);
    expect(isOauthRequestUnavailable(new ApiError(403, ""))).toBe(true);
    expect(isOauthRequestUnavailable(new ApiError(409, ""))).toBe(false);
  });

  it("409 는 이미 끝난 하나의 결정으로 읽는다", () => {
    expect(isOauthAlreadyDecided(new ApiError(409, ""))).toBe(true);
    expect(oauthConsentFailureMessage("approve", new ApiError(409, ""))).toContain(
      "이미 처리됐습니다"
    );
  });

  it("401 만 로그인으로 되돌린다", () => {
    expect(isOauthSessionExpired(new ApiError(401, ""))).toBe(true);
    expect(isOauthSessionExpired(new ApiError(404, ""))).toBe(false);
  });

  it("어떤 실패 문구도 static bearer 로 내려가라고 말하지 않는다", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      const message = oauthConsentFailureMessage("approve", new ApiError(status, ""));
      expect(message).not.toMatch(/고정 bearer|static/i);
    }
    expect(
      oauthConsentFailureMessage("preview", new NetworkError("unreachable", 15_000))
    ).not.toMatch(/고정 bearer|static/i);
    expect(
      oauthConsentFailureMessage("deny", new WireShapeError())
    ).not.toMatch(/고정 bearer|static/i);
  });

  it("네트워크 실패는 자기 문구를 잇는다", () => {
    const message = oauthConsentFailureMessage(
      "preview",
      new NetworkError("timeout", 15_000)
    );
    expect(message).toContain("응답하지 않았습니다");
  });
});

describe("RED PROOF ⑤ 결과 문장은 닫히는 쪽을 말한다", () => {
  it("승인이 여는 것과 닫는 것을 함께 말한다", () => {
    const sentence = oauthConsentConsequence("Grok 리서치", 2, [
      "agent:port:connect",
      "messages:write",
    ]);
    expect(sentence).toContain("2개 채널");
    expect(sentence).toContain("승인하지 않은 채널");
  });

  it("채널이 없으면 아무 데도 닿지 못한다고 말한다", () => {
    const sentence = oauthConsentConsequence("Grok 리서치", 0, ["agent:port:connect"]);
    expect(sentence).toContain("접속만 하고");
  });

  it("주어를 두 번 표지하지 않는다 (design-review M1)", () => {
    // 조사는 koreanParticle 이 정한다(라틴 종성 처리). 핵심은 앞에 별도 주어를
    // 덧대 한 대상에 표지가 겹치지 않는 것이다.
    const sentence = oauthConsentConsequence("Grok", 1, [
      "agent:port:connect",
      "messages:write",
    ]);
    expect(sentence).not.toContain("이 외부 에이전트가");
    expect(sentence.startsWith("승인하면 Grok")).toBe(true);
  });
});

describe("만료와 사실 목록", () => {
  it("만료 라벨은 분으로 반올림한다", () => {
    expect(oauthRequestExpiry(1000, 2000).expired).toBe(true);
    expect(oauthRequestExpiry(5 * 60_000, 0).label).toBe("약 5분 뒤 만료");
    expect(oauthRequestExpiry(30_000, 0).label).toBe("1분 안에 만료");
  });

  it("사실 목록은 clientId·redirect 를 운영자 등록 값으로 세운다", () => {
    const facts = oauthConsentFacts(parseOauthConsentPreview(previewWire()));
    expect(facts.map((fact) => fact.value)).toContain("grok-bot");
    expect(facts.map((fact) => fact.value)).toContain("https://grok.example/callback");
    expect(facts.every((fact) => fact.token === true)).toBe(true);
  });
});
