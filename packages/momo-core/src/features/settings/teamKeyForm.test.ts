import { describe, expect, it } from "vitest";
import type { ProviderLink } from "./api";
import { initialPresetId, teamCheckReason, teamCheckResult, teamKeyPresets, teamProbeDetail } from "./teamKeyForm";

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

describe("teamCheckReason (#2944)", () => {
  it("아는 사유는 해요체 사람 말, 모르는 사유는 이름 그대로", () => {
    expect(teamCheckReason("provider_auth_failed")).toBe("provider가 키를 거절했어요.");
    expect(teamCheckReason("provider_status_429")).toBe("provider가 429 응답을 줬어요.");
    expect(teamCheckReason("probe_not_run")).toBe("이 서버는 아직 키를 직접 확인하지 않아요.");
    expect(teamCheckReason(undefined)).toBe("연결을 확인하지 못했어요.");
    expect(teamCheckReason("weird_x")).toBe("연결을 확인하지 못했어요(서버 사유: weird_x).");
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
    expect(result).toEqual({ tone: "mute", headline: "확인 전", text: "이 서버는 아직 키를 직접 확인하지 않아요. 키는 저장됐어요." });
    expect(result.text).not.toContain("거절");
  });

  it("거절은 저장한 키가 남아 있다는 사실을 함께 말한다", () => {
    const result = teamCheckResult({ probe: probe({ ok: false, reason: "provider_auth_failed" }), justSaved: true, nowMs: now });
    expect(result.headline).toBe("확인 실패");
    expect(result.text).toBe("provider가 키를 거절했어요. 저장한 키는 그대로 남아 있어요. 키를 바꾸려면 새로 넣으세요.");
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
      text: "응답을 확인했어요 · 방금 · 쓸 수 있는 모델 6개 · 요청 한도 50 중 49 남음",
    });
    expect(teamProbeDetail(probe({ entries: [{ position: 0, probe: { credit: { limitRemaining: 12.5 } } }] }))).toEqual({
      creditRemaining: 12.5,
    });
  });

  it("세부가 없거나 모르는 모양이면 한 줄 문장으로 물러선다", () => {
    expect(teamProbeDetail(probe({}))).toBeNull();
    expect(teamProbeDetail(probe({ entries: [{ position: 0, probe: { modelCount: "6" } }] }))).toBeNull();
    expect(teamCheckResult({ probe: probe({}), justSaved: false, nowMs: now }).text).toBe("응답을 확인했어요 · 방금");
  });
});
