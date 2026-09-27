import { describe, expect, it } from "vitest";
import type { ProviderLink } from "./api";
import { probeReasonCopy } from "./chainModel";
import { providerTestMessage } from "./model";
import {
  initialPresetId,
  teamCheckReason,
  teamCheckReasonCopy,
  teamCheckResult,
  teamKeyPresets,
  teamProbeDetail,
  teamProbeDetailParts,
  teamProbeDetailText,
  literalSegments,
} from "./teamKeyForm";

const base: ProviderLink = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "environment",
  mode: "internal-host-mock",
  baseUrl: "",
  endpointLabel: "mock",
  bearerConfigured: false,
  availability: "mock",
  keyConfigured: false,
  diagnostics: [],
};

const withPresets = (presets: unknown): ProviderLink => ({ ...base, presets }) as unknown as ProviderLink;

describe("teamKeyPresets (#2944)", () => {
  it("서버가 준 프리셋만 읽고 모르는 줄은 버린다", () => {
    const link = withPresets([
      { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
      { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
      { id: "bad", label: "평문", baseUrl: "http://insecure.example/v1", format: "openai" },
      { id: 3 },
      null,
      { id: "odd", label: "Odd", baseUrl: "https://odd.example/v1", format: "gemini" },
    ]);
    expect(teamKeyPresets(link).map((p) => [p.id, p.format])).toEqual([
      ["openai", "openai"],
      ["anthropic", "anthropic"],
      ["odd", "openai"],
    ]);
  });

  it("#2872 전 서버(프리셋 없음)는 빈 목록", () => {
    expect(teamKeyPresets(base)).toEqual([]);
    expect(teamKeyPresets(undefined)).toEqual([]);
  });

  it("처음 고를 프리셋은 저장된 주소와 같은 것", () => {
    const presets = teamKeyPresets(
      withPresets([
        { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
        { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", format: "openai" },
      ])
    );
    expect(initialPresetId(presets, base)).toBe("openai");
    expect(initialPresetId(presets, { ...base, configured: true, baseUrl: "https://api.x.ai/v1/" })).toBe("xai");
    expect(initialPresetId([], base)).toBeNull();
    // 프리셋에 없는 저장된 주소(사내 프록시)는 첫 프리셋으로 옮기지 않는다(review #2961 M4).
    expect(initialPresetId(presets, { ...base, configured: true, baseUrl: "https://llm.corp.example/v1" })).toBeNull();
  });
});

describe("teamCheckReason (#2944 · #2975)", () => {
  it("아는 사유는 해요체 사람 말, 모르는 사유는 이름 그대로", () => {
    expect(teamCheckReason("provider_status_429")).toBe("provider가 429 응답을 줬어요.");
    expect(teamCheckReason("probe_not_run")).toBe("이 서버는 아직 키를 직접 확인하지 않아요.");
    expect(teamCheckReason(undefined)).toBe("연결을 확인하지 못했어요.");
    expect(teamCheckReason("weird_x")).toBe("연결을 확인하지 못했어요(서버 사유: weird_x).");
  });

  // 사유마다 사실 + 할 일. 문장 전체를 핀으로 박는다(부분 일치는 문구가 사라져도 초록).
  it.each([
    [
      "provider_auth_failed",
      "provider가 키를 거절했어요.",
      "키가 맞는지, 만료되지 않았는지 확인하고 새 키를 넣어 주세요.",
    ],
    [
      "provider_unreachable",
      "주소에 닿지 못했어요.",
      "주소가 맞는지, 이 서버에서 그 주소로 나갈 수 있는지 확인해 주세요.",
    ],
    ["provider_rate_limited", "요청 한도에 걸렸어요.", "잠시 뒤에 다시 확인해 주세요."],
    [
      "provider_egress_denied",
      "사설·루프백·메타데이터 주소라 서버가 부르지 않았어요.",
      "같은 망의 provider를 쓰려면 서버 운영자가 AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1을 켜고 그 호스트를 AGENT_PROVIDER_LOCAL_HOSTS에 넣어야 해요.",
    ],
    ["provider_invalid_response", "주소가 provider API가 아닌 것 같아요.", "API 주소(예: …/v1)가 맞는지 확인해 주세요."],
    ["provider_not_configured", "주소나 키가 비어 있어요.", "키를 넣고 다시 확인해 주세요."],
    [
      "not_external_provider",
      "모의 모드라 실제 provider를 부르지 않아요.",
      "실제 provider를 쓰려면 설정에서 모드를 외부 provider로 바꿔 주세요.",
    ],
    ["hop_disabled", "꺼 둔 연결이라 확인하지 않았어요.", null],
    ["probe_not_run", "이 서버는 아직 키를 직접 확인하지 않아요.", null],
    ["provider_status_404", "provider가 404 응답을 줬어요.", "API 주소(예: …/v1)가 맞는지 확인해 주세요."],
    ["provider_status_503", "provider가 503 응답을 줬어요.", "provider 쪽 문제일 수 있어요. 잠시 뒤에 다시 확인해 주세요."],
  ])("%s", (reason, fact, action) => {
    expect(teamCheckReasonCopy(reason)).toEqual({ fact, action });
    expect(teamCheckReason(reason)).toBe(action ? `${fact} ${action}` : fact);
  });

  it("한도에 걸린 확인은 provider가 밝힌 Retry-After로 때를 말한다", () => {
    expect(teamCheckReasonCopy("provider_rate_limited", { retryAfterSeconds: 30 }).action).toBe(
      "30초 뒤에 다시 확인해 주세요."
    );
    expect(teamCheckReasonCopy("provider_rate_limited", { retryAfterSeconds: 120 }).action).toBe(
      "2분 뒤에 다시 확인해 주세요."
    );
  });

  // OpenAPI `ProviderLinkTestResponse.reason`의 전 어휘(#2960). 어느 표면도 기본
  // 갈래(「서버 사유」)로 떨어지지 않는다.
  it.each([
    "provider_auth_failed",
    "provider_unreachable",
    "provider_rate_limited",
    "provider_status_500",
    "provider_egress_denied",
    "provider_invalid_response",
    "not_external_provider",
    "provider_not_configured",
    "hop_disabled",
    "probe_not_run",
  ])("%s는 세 문장 함수 어디서도 기본 갈래가 아니다", (reason) => {
    expect(teamCheckReason(reason)).not.toMatch(/서버 사유|서버가 보고한 사유/);
    expect(probeReasonCopy(reason)).not.toMatch(/서버 사유|서버가 보고한 사유/);
    expect(providerTestMessage({ ok: false, reason, endpointLabel: "x" })).not.toMatch(
      /서버 사유|서버가 보고한 사유/
    );
  });
});

describe("teamCheckResult · teamProbeDetail (#2880)", () => {
  const now = Date.UTC(2026, 8, 27, 6, 0, 0);
  const probe = (over: Record<string, unknown>) =>
    ({
      schema: "momo.provider_link.test.v0",
      ok: true,
      source: "database",
      mode: "external-hermes",
      endpointLabel: "api.openai.com",
      checkedAtMs: now - 5_000,
      ...over,
    }) as never;

  it("지금 서버(probe_not_run)는 실패가 아니라 「확인 전」이고 키를 거절했다고 말하지 않는다", () => {
    const result = teamCheckResult({ probe: probe({ ok: false, reason: "probe_not_run" }), justSaved: true, nowMs: now });
    expect(result).toEqual({
      tone: "mute",
      headline: "확인 전",
      text: "이 서버는 아직 키를 직접 확인하지 않아요. 키는 저장됐어요.",
      detail: null,
      detailParts: [],
    });
    expect(result.text).not.toContain("거절");
  });

  it("거절은 저장한 키가 남아 있다는 사실을 함께 말한다", () => {
    const result = teamCheckResult({ probe: probe({ ok: false, reason: "provider_auth_failed" }), justSaved: true, nowMs: now });
    expect(result.headline).toBe("확인 실패");
    expect(result.text).toBe(
      "provider가 키를 거절했어요. 저장한 키는 그대로 남아 있어요. 키가 맞는지, 만료되지 않았는지 확인하고 새 키를 넣어 주세요."
    );
    expect(result.detail).toBeNull();
  });

  it("#2960 모양의 세부(모델 수·요청 한도·잔액)는 있는 것만 싣는다", () => {
    const entries = [
      {
        position: 0,
        ok: true,
        probe: { outcome: "ok", modelCount: 6, rateLimit: { source: "x-ratelimit", requestsLimit: 50, requestsRemaining: 49 } },
      },
      { position: 1, ok: true, probe: { modelCount: 99 } },
    ];
    const result = teamCheckResult({ probe: probe({ entries }), justSaved: false, nowMs: now });
    expect(result).toEqual({
      tone: "ok",
      headline: "키 확인됨",
      text: "응답을 확인했어요 · 방금",
      detail: "쓸 수 있는 모델 6개 · 요청 한도 50 중 49 남음",
      detailParts: ["쓸 수 있는 모델 6개", "요청 한도 50 중 49 남음"],
    });
    expect(teamProbeDetail(probe({ entries: [{ position: 0, probe: { credit: { limitRemaining: 12.5 } } }] }))).toEqual({
      creditRemaining: 12.5,
    });
  });

  it("세부가 없거나 모르는 모양이면 한 줄 문장으로 물러선다", () => {
    expect(teamProbeDetail(probe({}))).toBeNull();
    expect(teamProbeDetail(probe({ entries: [{ position: 0, probe: { modelCount: "6" } }] }))).toBeNull();
    const plain = teamCheckResult({ probe: probe({}), justSaved: false, nowMs: now });
    expect(plain.text).toBe("응답을 확인했어요 · 방금");
    expect(plain.detail).toBeNull();
    // 확인은 했지만 provider가 숫자를 하나도 밝히지 않았다: 줄이 없다(0이나 「-」를 지어내지 않는다).
    const silent = teamCheckResult({
      probe: probe({ entries: [{ position: 0, probe: { outcome: "ok", method: "models", latencyMs: 80, probedAtMs: now, cached: false } }] }),
      justSaved: false,
      nowMs: now,
    });
    expect(silent.detail).toBeNull();
  });

  it("#2960 전 칸: 토큰 한도·OpenRouter 크레딧·천 단위", () => {
    const detail = teamProbeDetail(
      probe({
        entries: [
          {
            position: 0,
            probe: {
              outcome: "ok",
              method: "key",
              modelCount: 1200,
              rateLimit: { source: "anthropic-ratelimit", requestsLimit: 4000, tokensLimit: 400000, tokensRemaining: 399500 },
              credit: { limit: 20, limitRemaining: 12.5, usage: 7.5 },
              cached: false,
            },
          },
        ],
      })
    );
    expect(teamProbeDetailText(detail)).toBe(
      "쓸 수 있는 모델 1,200개 · 요청 한도 4,000 · 토큰 한도 400,000 중 399,500 남음 · 남은 크레딧 12.5 / 20 · 쓴 크레딧 7.5"
    );
    // limit null = provider가 밝힌 「한도 없음」. limitRemaining null은 싣지 않는다.
    expect(
      teamProbeDetailText(
        teamProbeDetail(probe({ entries: [{ position: 0, probe: { credit: { limit: null, limitRemaining: null, usage: 3.21 } } }] }))
      )
    ).toBe("크레딧 한도 없음 · 쓴 크레딧 3.21");
  });

  it("20초 안의 재확인(cached)은 「방금 확인한 결과」라고 말한다", () => {
    const result = teamCheckResult({
      probe: probe({ entries: [{ position: 0, probe: { outcome: "ok", modelCount: 3, cached: true } }] }),
      justSaved: false,
      nowMs: now,
    });
    expect(result.text).toBe("응답을 확인했어요 · 방금 확인한 결과");
    expect(result.detail).toBe("쓸 수 있는 모델 3개");
  });

  it("한도에 걸린 확인의 결과 줄은 Retry-After를 쓰고 숫자 줄은 없다", () => {
    const result = teamCheckResult({
      probe: probe({
        ok: false,
        reason: "provider_rate_limited",
        entries: [{ position: 0, probe: { outcome: "rate_limited", retryAfterSeconds: 20 } }],
      }),
      justSaved: false,
      nowMs: now,
    });
    expect(result).toEqual({
      tone: "bad",
      headline: "확인 실패",
      text: "요청 한도에 걸렸어요. 20초 뒤에 다시 확인해 주세요.",
      detail: null,
      detailParts: [],
    });
  });
});

describe("표면이 줄을 가르는 단위 (design-review #2975 M1·N2)", () => {
  it("환경 변수 이름은 통째 한 조각이다", () => {
    const segs = literalSegments(teamCheckReason("provider_egress_denied"));
    expect(segs.filter((seg) => seg.literal).map((seg) => seg.text)).toEqual([
      "AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1",
      "AGENT_PROVIDER_LOCAL_HOSTS",
    ]);
    expect(segs.map((seg) => seg.text).join("")).toBe(teamCheckReason("provider_egress_denied"));
    expect(literalSegments("주소에 닿지 못했어요.")).toEqual([{ text: "주소에 닿지 못했어요.", literal: false }]);
  });

  it("숫자 줄은 칸 단위로 나온다", () => {
    expect(teamProbeDetailParts({ modelCount: 6, requestsLimit: 50, requestsRemaining: 49 })).toEqual([
      "쓸 수 있는 모델 6개",
      "요청 한도 50 중 49 남음",
    ]);
    expect(teamProbeDetailParts(null)).toEqual([]);
  });
});
