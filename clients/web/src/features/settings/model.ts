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

/**
 * `WorkTierPolicyRoutes.validatedMode`. The tier NUMBERS (T1/T2/T3) are an
 * internal ADR-0125 vocabulary and stay out of user copy, exactly as on macOS:
 * the person picks a behaviour, not a tier. Two of the three labels are the mac
 * strings verbatim (MomoWorkConsoleCopy.swift). The first is not: the mac says
 * "이 Mac에서만" because there the client IS the host, while a browser or a
 * Tauri window can be looking at a Linux workd it will never run code on, so
 * the web names the host by its role instead of by the reader's machine.
 */
export const WORK_TIER_MODES: Choice[] = [
  {
    id: "t1_only",
    label: "처음 시작한 호스트에서만",
    detail: "연결이 끊겨도 다른 곳으로 옮기지 않고, 그 호스트가 돌아오기를 기다립니다.",
  },
  {
    id: "ask",
    label: "연결 끊김 시 묻기",
    detail: "호스트를 잃으면 어디서 이어갈지 물어봅니다. 고르지 않으면 이 값이 쓰입니다.",
  },
  {
    id: "auto",
    label: "자동 재개",
    detail: "고른 호스트에서 마지막 push 커밋으로 새 세션을 시작합니다. 비용이 생길 수 있습니다.",
  },
];

/** Reserved target selector in `validatedAutoTarget`, alongside a host id. */
export const CLOUD_TARGET = "cloud";

/** `WorkHostRoutes.validatedType`. */
export function workHostTypeLabel(type: string): string {
  if (type === "app") return "데스크톱 앱";
  if (type === "workd") return "workd 데몬";
  if (type === "cloud") return "momo Cloud";
  return type;
}

/** `WorkHostRoutes.validatedScope`. */
export function workHostScopeLabel(scope: string): string {
  if (scope === "workspace") return "워크스페이스 공용";
  if (scope === "member") return "개인";
  return scope;
}

/**
 * Host status from the server row only. `online` is the server's 90 second
 * heartbeat window (`WorkHostRoutes.onlineWindowSeconds`), never a client clock
 * comparison, and a revoked row outranks it: a revoked host is gone whatever
 * its last heartbeat said.
 */
export function workHostStatus(host: {
  online: boolean;
  revokedAtMs?: number;
  lastSeenAtMs?: number;
}): { tone: "ok" | "warn" | "muted"; label: string } {
  if (host.revokedAtMs) return { tone: "muted", label: "해지됨" };
  if (host.online) return { tone: "ok", label: "온라인" };
  if (host.lastSeenAtMs) return { tone: "warn", label: "오프라인" };
  return { tone: "muted", label: "연결된 적 없음" };
}

/**
 * Last 6 characters of a work host id.
 *
 * The registry re-registers a host as a NEW row every time it pairs, so three
 * live rows can carry the identical `displayName` (the momowebqa ledger has
 * exactly that: "성재 iMac, 집 작업실" three times). A name is therefore not a
 * discriminator, in the row and least of all in an accessible name, where three
 * buttons called "성재 iMac, 집 작업실 호스트 ID 복사" are three indistinguishable
 * stops in the tab order. UUIDv7 ids share their prefix (time-ordered) and
 * differ in the tail, so the tail is what identifies a row.
 */
export function workHostIdTail(id: string, length = 6): string {
  return id.length <= length ? id.toLowerCase() : id.slice(-length).toLowerCase();
}

export interface WorkHostLiveness {
  online: boolean;
  revokedAtMs?: number;
  lastSeenAtMs?: number;
}

/**
 * Registry rank: online, offline, never connected, revoked.
 *
 * The server returns creation order, so whether a usable host is on the first
 * screen is an accident of when it happened to be registered. A registry whose
 * top rows are four revoked hosts answers "어디에 붙지" with the four answers
 * that cannot be picked.
 */
function livenessRank(host: WorkHostLiveness): number {
  if (host.revokedAtMs) return 3;
  if (host.online) return 0;
  return host.lastSeenAtMs ? 1 : 2;
}

/** Stable within a rank: same-rank rows keep the order the server sent. */
export function sortWorkHosts<T extends WorkHostLiveness>(hosts: T[]): T[] {
  return hosts
    .map((host, index) => ({ host, index }))
    .sort((a, b) => livenessRank(a.host) - livenessRank(b.host) || a.index - b.index)
    .map((entry) => entry.host);
}

/**
 * What "등록 6대" hides. Four of those six are revoked in the live workspace, so
 * one number reads as "이 워크스페이스에 호스트가 여섯 대 있다" when the true
 * answer is two.
 */
export function workHostCounts(hosts: WorkHostLiveness[]): {
  usable: number;
  revoked: number;
} {
  const revoked = hosts.filter((host) => host.revokedAtMs).length;
  return { usable: hosts.length - revoked, revoked };
}

/** "방금", "12분 전", or a calendar day once it stops being a recent event. */
export function relativeSince(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "방금";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return formatDay(epochMs);
}

export interface AutoTargetHost {
  id: string;
  scope: string;
  ownerMemberId: string;
  displayName: string;
  revokedAtMs?: number;
}

/**
 * Which hosts the server will accept as an auto target for a scope, mirroring
 * `WorkTierPolicyRoutes.requireAllowedTarget`: the workspace default may only
 * point at a workspace-scoped host, a member override may also point at a host
 * that member owns, and a revoked host is never eligible. Offering a target the
 * server answers 409 for is the same bug as showing a form that cannot save.
 *
 * Every id comparison is lower-cased: work host ids arrive lower-cased from the
 * registry while member ids can arrive upper-cased from login, and `===` on the
 * raw strings silently drops the owner's own host out of the list.
 */
export function eligibleAutoTargets<T extends AutoTargetHost>(
  hosts: T[],
  scope: "member" | "workspace",
  memberId: string
): T[] {
  return hosts.filter((host) => {
    if (host.revokedAtMs) return false;
    if (host.scope === "workspace") return true;
    if (scope === "workspace") return false;
    return host.ownerMemberId.toLowerCase() === memberId.toLowerCase();
  });
}

/**
 * Target as the person named it, not as the ledger stores it.
 *
 * Only ever called with a registry that actually loaded: "이 호스트는 등록에
 * 없다" is a claim about the registry, and an empty array can also mean the read
 * is still in flight or failed, so the caller decides that first (see
 * `registryState` in WorkHostSection). A stored id that survives that check is
 * named as missing WITHOUT the raw UUID: the id belongs in the 등록된 호스트 row
 * where it can be copied, not in a sentence.
 *
 * A revoked host keeps its name and gains the same 해지됨 word the registry row
 * uses, because the server will answer 409 for it and a bare display name reads
 * as a healthy choice.
 */
export function autoTargetLabel(
  target: string | undefined,
  hosts: AutoTargetHost[]
): string {
  if (!target) return "고른 대상 없음";
  if (target === CLOUD_TARGET) return "momo Cloud";
  const host = hosts.find((h) => h.id.toLowerCase() === target.toLowerCase());
  if (!host) return "등록 목록에 없는 호스트";
  return host.revokedAtMs ? `${host.displayName} (해지됨)` : host.displayName;
}

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

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/**
 * 코드 실행 호스트 surfaces answer in Korean, not in the wire message.
 *
 * WorkTierPolicyRoutes and WorkHostRoutes speak operator English ("auto target
 * work host is unavailable", "not a workspace member"), which is the right
 * thing to log and the wrong thing to put on screen next to a select. Each
 * status the client can actually provoke gets copy that says what happened and
 * the next move; anything unmapped falls back to the generic line rather than
 * leaking the wire string.
 */
export function workTierPolicySaveMessage(error: unknown): string {
  switch (statusOf(error)) {
    case 400:
      return "자동 재개는 재개 대상을 함께 골라야 저장됩니다. 대상을 고른 뒤 다시 저장하세요.";
    case 403:
      return "워크스페이스 기본값은 오너나 관리자만 바꿀 수 있습니다. 내 정책은 그대로 바꿀 수 있습니다.";
    case 409:
      // The next step names a control that exists: 등록된 호스트 블록의
      // '등록 목록 다시 불러오기'. Before MOMO-617 R2 that sentence asked for an
      // action the panel had no button for, so the only way to do it was a
      // browser reload.
      return "고른 호스트는 지금 재개 대상이 될 수 없습니다. 해지됐거나 이 정책이 쓸 수 없는 호스트입니다. 등록된 호스트에서 등록 목록 다시 불러오기를 누른 뒤 고르세요.";
    default:
      return "정책을 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
  }
}

/** 403 is answered by OperatorNotice, so this is only the non-permission half. */
export function workHostRegistryMessage(): string {
  return "등록된 호스트 목록을 불러오지 못했습니다. 잠시 뒤에 다시 불러오세요.";
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
