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
 * 폼을 열 때 고를 프리셋: 저장된 주소와 같은 프리셋. 저장된 주소가 있는데 프리셋에
 * 없으면(사내 프록시 등) null = 「지금 주소」를 그대로 쓴다: 키만 바꾸려던 운영자의
 * 주소를 조용히 첫 프리셋으로 옮기지 않는다(review #2961 M4). 저장된 주소가 없으면
 * 첫 프리셋, 프리셋이 없으면 null.
 */
export function initialPresetId(
  presets: readonly TeamKeyPreset[],
  link: ProviderLink | undefined
): string | null {
  if (presets.length === 0) return null;
  const saved = link?.configured ? link.baseUrl.replace(/\/+$/, "") : null;
  if (saved === null) return presets[0].id;
  const match = presets.find((preset) => preset.baseUrl.replace(/\/+$/, "") === saved);
  return match ? match.id : null;
}

/**
 * 카드의 결과 줄 문장(해요체, brief §6). 서버 사유는 기계 낱말이다: 아는 것만
 * 사람 말로 옮기고, 모르는 것은 사유 이름을 그대로 둔다(지어내지 않는다).
 */
export function teamCheckReason(reason: string | undefined): string {
  switch (reason) {
    case "provider_auth_failed":
      return "provider가 키를 거절했어요.";
    case "provider_unreachable":
      return "주소에 닿지 못했어요.";
    case "provider_rate_limited":
      return "요청 한도에 걸렸어요.";
    case "provider_not_configured":
      return "주소나 키가 비어 있어요.";
    case "not_external_provider":
      return "모의 모드라 실제 provider를 부르지 않아요.";
    case "probe_not_run":
      return "확인이 끝나지 않았어요.";
    case undefined:
    case "":
      return "연결을 확인하지 못했어요.";
    default: {
      const status = /^provider_status_(\d{3})$/.exec(reason);
      if (status) return `provider가 ${status[1]} 응답을 줬어요.`;
      return `연결을 확인하지 못했어요(서버 사유: ${reason}).`;
    }
  }
}
