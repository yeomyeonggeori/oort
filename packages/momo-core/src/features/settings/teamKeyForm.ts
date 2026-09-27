import type { ProviderFormat, ProviderLink, ProviderLinkTest } from "./api";

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

// =============================================================================
// 확인 결과 줄 (#2880 AA-7). 설정 곁판과 채팅 연결 카드가 **같은 문장**을 말한다:
// 결과 줄을 짓는 일은 여기 한 곳이고, 두 표면은 그리기만 한다.
// =============================================================================

/**
 * 확인 호출이 키에서 직접 읽은 숫자(#2960 `entries[].probe`). 서버가 실제 호출을
 * 하지 않으면(`probe_not_run`) 없다. 있는 숫자만 싣고 지어내지 않는다(제안서 Q5).
 */
export interface TeamProbeDetail {
  readonly modelCount?: number;
  readonly requestsLimit?: number;
  readonly requestsRemaining?: number;
  readonly creditRemaining?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 첫 칸(팀 기본 키)의 확인 세부. 모르는 모양이면 null(한 줄 문장으로 물러선다). */
export function teamProbeDetail(probe: ProviderLinkTest | null | undefined): TeamProbeDetail | null {
  if (!probe) return null;
  const entries = (probe as unknown as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return null;
  const head = entries.find(
    (row) => row !== null && typeof row === "object" && (row as Record<string, unknown>).position === 0
  ) as Record<string, unknown> | undefined;
  const raw = head?.probe;
  if (raw === null || typeof raw !== "object") return null;
  const detail = raw as Record<string, unknown>;
  const rate = (detail.rateLimit ?? null) as Record<string, unknown> | null;
  const credit = (detail.credit ?? null) as Record<string, unknown> | null;
  const out: {
    modelCount?: number;
    requestsLimit?: number;
    requestsRemaining?: number;
    creditRemaining?: number;
  } = {};
  const models = finiteNumber(detail.modelCount);
  if (models !== undefined) out.modelCount = models;
  if (rate && typeof rate === "object") {
    const limit = finiteNumber(rate.requestsLimit);
    const remaining = finiteNumber(rate.requestsRemaining);
    if (limit !== undefined) out.requestsLimit = limit;
    if (remaining !== undefined) out.requestsRemaining = remaining;
  }
  if (credit && typeof credit === "object") {
    const left = finiteNumber(credit.limitRemaining);
    if (left !== undefined) out.creditRemaining = left;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 「쓸 수 있는 모델 6개 · 요청 한도 50 · 잔액 12.5」. 없는 칸은 빠진다. */
export function teamProbeDetailText(detail: TeamProbeDetail | null): string | null {
  if (!detail) return null;
  const parts: string[] = [];
  if (detail.modelCount !== undefined) parts.push(`쓸 수 있는 모델 ${detail.modelCount}개`);
  if (detail.requestsLimit !== undefined) {
    parts.push(
      detail.requestsRemaining !== undefined
        ? `요청 한도 ${detail.requestsLimit} 중 ${detail.requestsRemaining} 남음`
        : `요청 한도 ${detail.requestsLimit}`
    );
  }
  if (detail.creditRemaining !== undefined) parts.push(`남은 잔액 ${detail.creditRemaining}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 「15:42」. 결과 줄의 시각은 이 화면에서 본 것이라 날짜를 싣지 않는다. */
export function teamCheckClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 결과 줄의 때: 1분 안이면 「방금」(brief §6), 아니면 「15:42」. */
export function teamCheckSince(ms: number, nowMs: number): string {
  return nowMs - ms < 60_000 ? "방금" : teamCheckClock(ms);
}

export interface TeamCheckResult {
  readonly tone: "ok" | "bad";
  /** 곁판 결과 칸의 굵은 머리(시안 §4 2b `.check b`). */
  readonly headline: string;
  /** 두 표면이 똑같이 그리는 문장. */
  readonly text: string;
}

/**
 * 확인 결과 한 줄. `justSaved`는 「저장하고 확인」 직후인가: 그때 실패하면 저장한
 * 키가 남아 있다는 사실을 함께 말한다(저장 전 판정 경로가 서버에 없다).
 * `probe_not_run`(#2960 전 서버)은 실패로 칠하지만 문장은 「확인이 끝나지 않았어요」다:
 * 키가 거절됐다고 말하지 않는다.
 */
export function teamCheckResult(input: {
  probe: ProviderLinkTest;
  justSaved: boolean;
  nowMs: number;
}): TeamCheckResult {
  const { probe, justSaved, nowMs } = input;
  if (probe.ok) {
    const detail = teamProbeDetailText(teamProbeDetail(probe));
    return {
      tone: "ok",
      headline: "키 확인됨",
      text: `응답을 확인했어요 · ${teamCheckSince(probe.checkedAtMs, nowMs)}${detail ? ` · ${detail}` : ""}`,
    };
  }
  const why = teamCheckReason(probe.reason);
  const notRun = probe.reason === "probe_not_run";
  return {
    tone: "bad",
    headline: notRun ? "확인 전" : "확인 실패",
    text: !justSaved
      ? why
      : notRun
        ? `${why} 키는 저장됐어요.`
        : `${why} 저장한 키는 그대로 남아 있어요. 키를 바꾸려면 새로 넣으세요.`,
  };
}
