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
 * 한 사유의 사람 말: 무슨 일이 있었는지(`fact`)와 그다음 할 일(`action`). 해결할
 * 행동이 없는 사유(확인 전·모의 모드처럼 고칠 것이 없는 것)는 `action`이 null이다.
 * 사유 어휘는 OpenAPI `ProviderLinkTestResponse.reason`(#2960)이 정본이다.
 */
export interface TeamCheckReasonCopy {
  readonly fact: string;
  readonly action: string | null;
}

/** 「30초 뒤」·「2분 뒤」. provider가 밝힌 Retry-After만 쓴다. */
function retryWhen(seconds: number): string {
  return seconds < 90 ? `${seconds}초 뒤` : `${Math.ceil(seconds / 60)}분 뒤`;
}

/**
 * 카드의 결과 줄 문장(해요체, brief §6). 서버 사유는 기계 낱말이다: 아는 것만
 * 사람 말로 옮기고, 모르는 것은 사유 이름을 그대로 둔다(지어내지 않는다).
 * `retryAfterSeconds`는 한도에 걸린 확인에서 provider가 밝힌 기다릴 시간이다.
 */
export function teamCheckReasonCopy(
  reason: string | undefined,
  hints: { retryAfterSeconds?: number } = {}
): TeamCheckReasonCopy {
  switch (reason) {
    case "provider_auth_failed":
      return {
        fact: "provider가 키를 거절했어요.",
        action: "키가 맞는지, 만료되지 않았는지 확인하고 새 키를 넣어 주세요.",
      };
    case "provider_unreachable":
      return {
        fact: "주소에 닿지 못했어요.",
        action: "주소가 맞는지, 이 서버에서 그 주소로 나갈 수 있는지 확인해 주세요.",
      };
    case "provider_rate_limited":
      return {
        fact: "요청 한도에 걸렸어요.",
        action:
          hints.retryAfterSeconds !== undefined
            ? `${retryWhen(hints.retryAfterSeconds)}에 다시 확인해 주세요.`
            : "잠시 뒤에 다시 확인해 주세요.",
      };
    case "provider_egress_denied":
      // #2960: 서버의 egress 가드가 부르기 전에 막았다. 키는 판정되지 않았다.
      return {
        fact: "사설·루프백·메타데이터 주소라 서버가 부르지 않았어요.",
        action:
          "같은 망의 provider를 쓰려면 서버 운영자가 AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1을 켜고 그 호스트를 AGENT_PROVIDER_LOCAL_HOSTS에 넣어야 해요.",
      };
    case "provider_invalid_response":
      // #2960: 2xx였지만 모델 목록 모양이 아니다(웹페이지·다른 서비스 주소).
      return {
        fact: "주소가 provider API가 아닌 것 같아요.",
        action: "API 주소(예: …/v1)가 맞는지 확인해 주세요.",
      };
    case "provider_not_configured":
      return { fact: "주소나 키가 비어 있어요.", action: "키를 넣고 다시 확인해 주세요." };
    case "not_external_provider":
      return {
        fact: "모의 모드라 실제 provider를 부르지 않아요.",
        action: "실제 provider를 쓰려면 설정에서 모드를 외부 provider로 바꿔 주세요.",
      };
    case "hop_disabled":
      return { fact: "꺼 둔 연결이라 확인하지 않았어요.", action: null };
    case "probe_not_run":
      // 서버가 실제 provider를 부르지 않았다(#2960 전 서버, 또는 #2960 뒤에도
      // 레거시 oauth-openai 머리 연결). 「끝나지 않았다」고 하면 다시 누르면 끝날
      // 것처럼 읽힌다(design-review #2880 M1).
      return { fact: "이 서버는 아직 키를 직접 확인하지 않아요.", action: null };
    case undefined:
    case "":
      return { fact: "연결을 확인하지 못했어요.", action: null };
    default: {
      const status = /^provider_status_(\d{3})$/.exec(reason);
      if (status) {
        const code = Number(status[1]);
        const action =
          code === 404
            ? "API 주소(예: …/v1)가 맞는지 확인해 주세요."
            : code >= 500
              ? "provider 쪽 문제일 수 있어요. 잠시 뒤에 다시 확인해 주세요."
              : null;
        return { fact: `provider가 ${status[1]} 응답을 줬어요.`, action };
      }
      return { fact: `연결을 확인하지 못했어요(서버 사유: ${reason}).`, action: null };
    }
  }
}

/** 사유 한 줄(사실 + 할 일). 폰 제안 카드가 그대로 쓴다. */
export function teamCheckReason(
  reason: string | undefined,
  hints: { retryAfterSeconds?: number } = {}
): string {
  const copy = teamCheckReasonCopy(reason, hints);
  return copy.action ? `${copy.fact} ${copy.action}` : copy.fact;
}

// =============================================================================
// 확인 결과 줄 (#2880 AA-7). 설정 곁판과 채팅 연결 카드가 **같은 문장**을 말한다:
// 결과 줄을 짓는 일은 여기 한 곳이고, 두 표면은 그리기만 한다.
// =============================================================================

/**
 * 확인 호출이 키에서 직접 읽은 숫자(#2960 `entries[].probe`). 서버가 실제 호출을
 * 하지 않으면(`probe_not_run`) 없다. 있는 숫자만 싣고 지어내지 않는다(제안서 Q5).
 * 한도 헤더에는 기간이 실려 오지 않는다: 「분당」이라고 붙이지 않는다.
 */
export interface TeamProbeDetail {
  readonly modelCount?: number;
  readonly requestsLimit?: number;
  readonly requestsRemaining?: number;
  readonly tokensLimit?: number;
  readonly tokensRemaining?: number;
  readonly retryAfterSeconds?: number;
  /** OpenRouter 크레딧. `creditLimit: null`은 provider가 밝힌 「한도 없음」이다. */
  readonly creditLimit?: number | null;
  readonly creditRemaining?: number;
  readonly creditUsage?: number;
  /** 서버가 20초 안의 직전 결과를 다시 준 것. */
  readonly cached?: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 첫 칸(팀 기본 키)의 확인 세부. 모르는 모양이면 null(한 줄 문장으로 물러선다). */
export function teamProbeDetail(probe: ProviderLinkTest | null | undefined): TeamProbeDetail | null {
  if (!probe) return null;
  const entries = (probe as unknown as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return null;
  const head = entries.find((row) => objectOf(row)?.position === 0) as Record<string, unknown> | undefined;
  const detail = objectOf(head?.probe);
  if (detail === null) return null;
  const rate = objectOf(detail.rateLimit);
  const credit = objectOf(detail.credit);
  const out: {
    -readonly [K in keyof TeamProbeDetail]: TeamProbeDetail[K];
  } = {};
  const put = <K extends keyof TeamProbeDetail>(key: K, value: TeamProbeDetail[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put("modelCount", finiteNumber(detail.modelCount));
  put("retryAfterSeconds", finiteNumber(detail.retryAfterSeconds));
  if (rate) {
    put("requestsLimit", finiteNumber(rate.requestsLimit));
    put("requestsRemaining", finiteNumber(rate.requestsRemaining));
    put("tokensLimit", finiteNumber(rate.tokensLimit));
    put("tokensRemaining", finiteNumber(rate.tokensRemaining));
  }
  if (credit) {
    // `limit`은 null이 뜻이 있다(한도 없음). 키가 없거나 숫자가 아니면 싣지 않는다.
    if (credit.limit === null) out.creditLimit = null;
    else put("creditLimit", finiteNumber(credit.limit));
    put("creditRemaining", finiteNumber(credit.limitRemaining));
    put("creditUsage", finiteNumber(credit.usage));
  }
  if (detail.cached === true) out.cached = true;
  return Object.keys(out).length > 0 ? out : null;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function credits(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/** 「쓸 수 있는 모델 6개 · 요청 한도 50 중 49 남음 · 남은 크레딧 12.5」. 없는 칸은 빠진다. */
export function teamProbeDetailText(detail: TeamProbeDetail | null): string | null {
  const parts = teamProbeDetailParts(detail);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 숫자 줄의 칸들. 표면은 칸 안에서 줄을 바꾸지 않는다(「198 남음 ·」이 매달리지 않게). */
export function teamProbeDetailParts(detail: TeamProbeDetail | null): string[] {
  if (!detail) return [];
  const parts: string[] = [];
  if (detail.modelCount !== undefined) parts.push(`쓸 수 있는 모델 ${count(detail.modelCount)}개`);
  if (detail.requestsLimit !== undefined) {
    parts.push(
      detail.requestsRemaining !== undefined
        ? `요청 한도 ${count(detail.requestsLimit)} 중 ${count(detail.requestsRemaining)} 남음`
        : `요청 한도 ${count(detail.requestsLimit)}`
    );
  }
  if (detail.tokensLimit !== undefined) {
    parts.push(
      detail.tokensRemaining !== undefined
        ? `토큰 한도 ${count(detail.tokensLimit)} 중 ${count(detail.tokensRemaining)} 남음`
        : `토큰 한도 ${count(detail.tokensLimit)}`
    );
  }
  if (detail.creditRemaining !== undefined) {
    parts.push(
      typeof detail.creditLimit === "number"
        ? `남은 크레딧 ${credits(detail.creditRemaining)} / ${credits(detail.creditLimit)}`
        : `남은 크레딧 ${credits(detail.creditRemaining)}`
    );
  } else if (detail.creditLimit === null) {
    parts.push("크레딧 한도 없음");
  }
  if (detail.creditUsage !== undefined) parts.push(`쓴 크레딧 ${credits(detail.creditUsage)}`);
  return parts;
}

/**
 * 문장을 글자 조각과 **그대로 쳐야 하는 이름**(서버 환경 변수)으로 나눈다. 표면은
 * 이름 조각을 고정폭·줄바꿈 없이 그린다: `…LOO|PBACK`처럼 이름 가운데서 줄이
 * 갈리면 두 낱말로 읽힌다(design-review #2975 M1).
 */
export function literalSegments(text: string): { text: string; literal: boolean }[] {
  return text
    .split(/(AGENT_[A-Z_]+(?:=\d+)?)/)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, literal: /^AGENT_[A-Z_]+(?:=\d+)?$/.test(part) }));
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
  /** `mute`는 확인이 돌지 않은 것(`probe_not_run`): 실패색으로 칠하지 않는다. */
  readonly tone: "ok" | "bad" | "mute";
  /** 곁판 결과 칸의 굵은 머리(시안 §4 2b `.check b`). */
  readonly headline: string;
  /** 두 표면이 똑같이 그리는 문장. */
  readonly text: string;
  /**
   * provider가 밝힌 숫자 한 줄(모델 수·한도·크레딧). 성공한 확인에만 있고, 숫자가
   * 하나도 없으면 null이다. 두 표면은 null이면 그 줄을 그리지 않는다.
   */
  readonly detail: string | null;
  /** `detail`의 칸들(`detail`은 이것을 「 · 」로 이은 것). 없으면 빈 배열. */
  readonly detailParts: readonly string[];
}

/**
 * 확인 결과 한 줄. `justSaved`는 「저장하고 확인」 직후인가: 그때 실패하면 저장한
 * 키가 남아 있다는 사실을 함께 말한다(저장 전 판정 경로가 서버에 없다). 할 일은
 * 사유마다 다르다(키·주소·서버 설정): 사유 문장이 정하고 여기서 덧붙이지 않는다.
 * `probe_not_run`(#2960 전 서버·레거시 oauth 연결)은 `mute`(「확인 전」)이고, 문장은
 * 서버가 확인하지 않는다는 사실이다: 키가 거절됐다고 말하지 않는다.
 */
export function teamCheckResult(input: {
  probe: ProviderLinkTest;
  justSaved: boolean;
  nowMs: number;
}): TeamCheckResult {
  const { probe, justSaved, nowMs } = input;
  const numbers = teamProbeDetail(probe);
  if (probe.ok) {
    const when = numbers?.cached ? "방금 확인한 결과" : teamCheckSince(probe.checkedAtMs, nowMs);
    return {
      tone: "ok",
      headline: "키 확인됨",
      text: `응답을 확인했어요 · ${when}`,
      detail: teamProbeDetailText(numbers),
      detailParts: teamProbeDetailParts(numbers),
    };
  }
  const copy = teamCheckReasonCopy(probe.reason, { retryAfterSeconds: numbers?.retryAfterSeconds });
  const notRun = probe.reason === "probe_not_run";
  const saved = !justSaved ? "" : notRun ? " 키는 저장됐어요." : " 저장한 키는 그대로 남아 있어요.";
  return {
    tone: notRun ? "mute" : "bad",
    headline: notRun ? "확인 전" : "확인 실패",
    text: `${copy.fact}${saved}${copy.action ? ` ${copy.action}` : ""}`,
    detail: null,
    detailParts: [],
  };
}
