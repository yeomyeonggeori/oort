// =============================================================================
// Pure logic behind the settings shell (R-1 §5 / MOMO-601): catalogs, input
// validation mirrored from the server, machine-reason to user-copy mapping,
// and the momo://join deep link assembly.
//
// Nothing here touches React or the network, so model.test.ts can hold the
// contract without a DOM: the slug rule has to match WorkspaceRoutes exactly
// (a client that accepts what the server rejects is a 400 the user cannot
// read), and the deep link has to match docs/onboarding-deeplink.md character
// for character (macOS/iOS parse the same string).
// =============================================================================

import { ApiError } from "@/lib/api";

// --- catalogs ---------------------------------------------------------------

export interface Choice {
  id: string;
  label: string;
  detail: string;
}

/** `AgentProviderMode` (server). Configuring a real key implies external. */
export const PROVIDER_MODES: Choice[] = [
  {
    id: "external-hermes",
    label: "외부 provider",
    detail: "저장한 주소와 키로 실제 provider에 연결합니다.",
  },
  {
    id: "internal-host-mock",
    label: "내부 호스트 목",
    detail: "서버가 자체 목 응답을 돌려줍니다. 실제 provider를 부르지 않습니다.",
  },
  {
    id: "local-mock",
    label: "로컬 목",
    detail: "개발용 목 응답입니다. 실제 provider를 부르지 않습니다.",
  },
];

/** `WorkHostEngineRoutes.allowedEngines` (migration 040 CHECK). */
export const WORK_ENGINES: Choice[] = [
  {
    id: "opencode",
    label: "opencode",
    detail: "동봉 엔진. 아무 것도 고르지 않으면 이 값이 쓰입니다.",
  },
  {
    id: "goose",
    label: "goose",
    detail: "동봉 엔진. opencode 대신 쓸 때 고릅니다.",
  },
  {
    id: "codex-local",
    label: "codex-local",
    detail: "호스트에 설치된 Codex에 붙습니다. 호스트 페어링이 먼저 필요합니다.",
  },
];

/** `InviteRoutes.normalizedRole`. */
export const INVITE_ROLES: Choice[] = [
  { id: "member", label: "멤버", detail: "채널을 읽고 씁니다." },
  { id: "admin", label: "관리자", detail: "초대와 워크스페이스 설정을 다룹니다." },
  { id: "guest", label: "게스트", detail: "초대받은 채널만 봅니다." },
];

export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;

export function choiceLabel(choices: Choice[], id: string): string {
  return choices.find((c) => c.id === id)?.label ?? id;
}

// --- provider link copy -----------------------------------------------------

/** Masked tail of the stored bearer. The full key never leaves the server. */
export function maskedBearer(last4: string | undefined): string {
  if (!last4) return "저장된 키 없음";
  return `••••${last4}`;
}

/** GET /v1/provider/link tells us where the effective config came from. */
export function providerSourceLabel(source: string): string {
  if (source === "database") return "이 서버에 저장됨";
  if (source === "environment") return "서버 환경값 사용 중";
  return source;
}

/**
 * POST /v1/provider/link/test returns a machine label. Turn it into what
 * happened plus the next step, never an apology.
 */
export function providerTestMessage(test: {
  ok: boolean;
  reason?: string;
  endpointLabel: string;
}): string {
  if (test.ok) return `${test.endpointLabel} 응답을 확인했습니다.`;
  switch (test.reason) {
    case "not_external_provider":
      return "지금은 목 모드입니다. 실제 provider를 쓰려면 모드를 외부 provider로 바꾸고 주소와 키를 저장하세요.";
    case "provider_not_configured":
      return "저장된 키가 없습니다. 키를 입력해 저장한 뒤 다시 확인하세요.";
    case "provider_unreachable":
      return `${test.endpointLabel} 에 연결하지 못했습니다. 주소를 확인하고, 이 서버에서 그 주소로 나갈 수 있는지 확인하세요.`;
    default:
      return `연결을 확인하지 못했습니다. 서버가 보고한 사유: ${test.reason ?? "알 수 없음"}`;
  }
}

// --- workspace input (mirrors WorkspaceRoutes.normalizedSlug/normalizedName) -

/** Server lowercases and trims before validating; do the same before sending. */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** null when valid. Same rule as infra/prod/create_workspace.sql. */
export function slugError(raw: string): string | null {
  const value = normalizeSlug(raw);
  if (value.length === 0) return "슬러그를 입력하세요.";
  if (value.length > 63) return "슬러그는 63자까지 쓸 수 있습니다.";
  if (!SLUG_PATTERN.test(value)) {
    return "슬러그는 영문 소문자, 숫자, 하이픈만 쓸 수 있고 하이픈으로 시작하거나 끝날 수 없습니다.";
  }
  return null;
}

/** Control characters are rejected by the server, so reject them here too. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

export function workspaceNameError(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "이름을 입력하세요.";
  if (value.length > 80) return "이름은 80자까지 쓸 수 있습니다.";
  if (hasControlCharacter(value)) return "이름에 쓸 수 없는 문자가 있습니다.";
  return null;
}

// --- momo://join deep link (docs/onboarding-deeplink.md is the contract) -----

/**
 * RFC 3986 percent-encoding: unreserved is `A-Z a-z 0-9 - . _ ~`.
 * encodeURIComponent leaves `!'()*` alone, which the contract does not, so
 * those five are encoded explicitly.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** `momo://join?server=<percent-encoded base URL>&code=<invite code>`. */
export function buildJoinLink(serverBaseUrl: string, code: string): string {
  return `momo://join?server=${percentEncode(serverBaseUrl)}&code=${percentEncode(code)}`;
}

/** Local calendar day as `YYYY-MM-DD`: unambiguous in a pasted invite. */
export function formatDay(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface InviteCardInput {
  workspaceName: string;
  serverBaseUrl: string;
  code: string;
  expiresAtMs: number;
  maxUses: number;
}

/**
 * The paste-anywhere invite card (온보딩 감사 W-O5): deep link first, manual
 * fallback second, expiry last. Plain text so it survives any chat client.
 */
export function inviteCardText(input: InviteCardInput): string {
  return [
    `${input.workspaceName} 워크스페이스에 초대합니다.`,
    "",
    "1. momo 앱을 설치하고 아래 링크를 엽니다.",
    `   ${buildJoinLink(input.serverBaseUrl, input.code)}`,
    "",
    "2. 링크가 앱에서 열리지 않으면 직접 입력하세요.",
    `   서버 주소: ${input.serverBaseUrl}`,
    `   초대 코드: ${input.code}`,
    "",
    `이 코드는 ${formatDay(input.expiresAtMs)}까지, ${input.maxUses}명까지 쓸 수 있습니다.`,
  ].join("\n");
}

/** mailto: with the same card as the body. No recipient: the operator picks. */
export function buildInviteMailto(input: InviteCardInput): string {
  const subject = `${input.workspaceName} 워크스페이스 초대`;
  return `mailto:?subject=${percentEncode(subject)}&body=${percentEncode(
    inviteCardText(input)
  )}`;
}

// --- error mapping ----------------------------------------------------------

/** 403 on an operator surface is a permission answer, not a failure. */
export function isOperatorDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isSlugConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/** Server message when there is one, a readable fallback when there is not. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "요청을 끝내지 못했습니다. 잠시 뒤에 다시 시도하세요.";
}

/** Invite status for the list, derived from the server row (never guessed). */
export function inviteStatus(invite: {
  revokedAtMs?: number;
  expiresAtMs: number;
  usedCount: number;
  maxUses: number;
}): { tone: "ok" | "warn" | "muted"; label: string } {
  if (invite.revokedAtMs) return { tone: "muted", label: "해지됨" };
  if (invite.usedCount >= invite.maxUses) return { tone: "muted", label: "모두 사용됨" };
  if (invite.expiresAtMs <= Date.now()) return { tone: "warn", label: "만료됨" };
  return { tone: "ok", label: "사용 가능" };
}
