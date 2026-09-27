import { describe, expect, it } from "vitest";
import type { ProviderLink } from "./api";
import { initialPresetId, teamKeyPresets } from "./teamKeyForm";

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
  });
});
