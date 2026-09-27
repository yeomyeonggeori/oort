import type { ProviderFormat, ProviderLink } from "./api";

// =============================================================================
// 팀 키 넣기 폼의 프리셋 (#2944 GC-3, 서버 #2872).
//
// 프리셋은 서버가 `GET /v1/provider/link` 응답의 `presets`로 준다
// (`momo-settings/src/presets.rs`). 클라이언트는 주소를 지어내지 않는다: 이
// 파일은 와이어를 **읽기만** 하고, 모르는 모양은 버린다. 서버가 프리셋을 주지
// 않으면(#2872 전 서버) 빈 목록이고, 폼은 저장된 주소를 그대로 쓰거나 설정으로
// 보낸다.
// =============================================================================

export interface TeamKeyPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly format: ProviderFormat;
}

function isFormat(value: unknown): value is ProviderFormat {
  return value === "openai" || value === "anthropic";
}

/** 링크 응답의 `presets`를 읽는다. 모르는 줄은 건너뛴다. */
export function teamKeyPresets(link: ProviderLink | undefined): TeamKeyPreset[] {
  const raw = link ? (link as unknown as Record<string, unknown>).presets : undefined;
  if (!Array.isArray(raw)) return [];
  const out: TeamKeyPreset[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== "object") continue;
    const { id, label, baseUrl, format } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || typeof baseUrl !== "string") continue;
    if (!/^https:\/\//.test(baseUrl)) continue;
    out.push({ id, label, baseUrl, format: isFormat(format) ? format : "openai" });
  }
  return out;
}

/**
 * 폼을 열 때 고를 프리셋: 저장된 주소와 같은 프리셋, 없으면 첫 프리셋, 프리셋이
 * 없으면 null(저장된 주소를 쓴다).
 */
export function initialPresetId(
  presets: readonly TeamKeyPreset[],
  link: ProviderLink | undefined
): string | null {
  if (presets.length === 0) return null;
  const saved = link?.configured ? link.baseUrl.replace(/\/+$/, "") : null;
  const match = saved ? presets.find((preset) => preset.baseUrl.replace(/\/+$/, "") === saved) : undefined;
  return (match ?? presets[0]).id;
}
