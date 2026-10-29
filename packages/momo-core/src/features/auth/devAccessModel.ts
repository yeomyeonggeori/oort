// Developer access, the pure model (ADR-0216 D2 to D10). No UI, no platform API:
// the web settings screen and the phone list read the same sentences, labels,
// validators and command snippets from here, so neither client can say something
// the other does not.
//
// The wire side (calls, parsers, the error classifier) is `./devAccess`.
//
// Copy rules held here: Korean in the 해요 register, no em-dash, no filler
// vocabulary, and a latin word is never followed by a spaced particle. The tool
// the maker names is a label they chose, never a verified fact, and no sentence
// in this file states it as one.

import { uuidEq } from "../../lib/api";
import { relativeLabel } from "../inbox/model";
import {
  DEV_EXPIRY_DEFAULT_DAYS,
  DEV_EXPIRY_MAX_DAYS,
  DEV_READ_SCOPES,
  DEV_READ_WRITE_SCOPES,
  DEV_SCOPES,
  isDevScope,
  type DevAccessFailure,
  type DevAccessPolicy,
  type DevCredential,
  type DevCredentialKind,
  type DevPresetId,
  type DevScope,
  type DevTool,
} from "./devAccess";

export { DEV_EXPIRY_DEFAULT_DAYS, DEV_EXPIRY_MAX_DAYS, DEV_READ_SCOPES, DEV_READ_WRITE_SCOPES };

/** The server's cap on live card tokens per member (409 `dev_credential_limit`). */
export const DEV_CARD_LIMIT = 20;

/** Result of one field check: the normalised value, or one sentence for that field. */
export type DevValidation<T> = { ok: true; value: T } | { ok: false; message: string };

// ---- presets and scope labels ---------------------------------------------------------

export interface DevPreset {
  id: DevPresetId;
  label: string;
  description: string;
  scopes: readonly DevScope[];
}

/** The two presets, in the order a screen lists them. The first is the default. */
export const DEV_PRESETS: readonly DevPreset[] = [
  {
    id: "read",
    label: "읽기만",
    description: "채널 목록, 메시지, 인박스를 읽기만 해요. 아무것도 보내지 못해요.",
    scopes: DEV_READ_SCOPES,
  },
  {
    id: "read_write",
    label: "읽기 + 보내기",
    description: "읽기에 더해 내 이름으로 메시지를 바로 보내요. 보내기 전에 따로 확인하지 않아요.",
    scopes: DEV_READ_WRITE_SCOPES,
  },
];

export const DEV_DEFAULT_PRESET: DevPresetId = "read";

/** A restriction laid over either preset, not a third preset. */
export const DEV_CHANNEL_RESTRICTION_COPY = {
  label: "고른 채널만 쓰기",
  help: "고른 채널 안에서만 읽고 보내요. 내가 들어가 있는 채널만 고를 수 있고, 채널에서 나가면 이 연결도 그 채널을 쓸 수 없어요.",
} as const;

/** The channel part of a list row's scope line. */
export const DEV_CHANNEL_ONLY_LABEL = "고른 채널만";

export type DevScopeKind = DevPresetId | "custom";

function sameScopes(scopes: ReadonlySet<string>, preset: readonly DevScope[]): boolean {
  return scopes.size === preset.length && preset.every((scope) => scopes.has(scope));
}

/**
 * Which preset a stored scope list is. Compares as a set: the server stores scopes in its
 * own order, which is not the order a client sends them in. Anything else, including a
 * list with a name this client does not know, is `custom`.
 */
export function devScopeKind(scopes: readonly string[]): DevScopeKind {
  const set = new Set(scopes);
  if (sameScopes(set, DEV_READ_SCOPES)) return "read";
  if (sameScopes(set, DEV_READ_WRITE_SCOPES)) return "read_write";
  return "custom";
}

const SCOPE_NAMES: Record<DevScope, string> = {
  "dev:identity": "내 정보 확인",
  "dev:channels:read": "채널 목록 읽기",
  "dev:messages:read": "메시지 읽기",
  "dev:messages:write": "메시지 보내기",
  "dev:inbox:read": "인박스 읽기",
};

export function devScopeName(scope: string): string {
  return isDevScope(scope) ? SCOPE_NAMES[scope] : "알 수 없는 범위";
}

/** Every power of a stored scope list, in plain words. An unknown name is said, not hidden. */
export function devScopeDetail(scopes: readonly string[]): string {
  const set = new Set(scopes);
  const names: string[] = DEV_SCOPES.filter((scope) => set.has(scope)).map(
    (scope) => SCOPE_NAMES[scope]
  );
  if (scopes.some((scope) => !isDevScope(scope))) names.push("알 수 없는 범위");
  return names.join(", ");
}

/**
 * 「읽기만」 or 「읽기 + 보내기」, plus 「 · 고른 채널만」 when the token is limited to chosen
 * channels. A combination that is neither preset says so (「직접 정한 범위」) instead of
 * borrowing the nearest preset's name.
 */
export function devScopeLabel(scopes: readonly string[], channelRestricted: boolean): string {
  const kind = devScopeKind(scopes);
  const base =
    kind === "read" ? "읽기만" : kind === "read_write" ? "읽기 + 보내기" : "직접 정한 범위";
  return channelRestricted ? `${base} · ${DEV_CHANNEL_ONLY_LABEL}` : base;
}

// ---- tools ------------------------------------------------------------------------------

const TOOL_LABELS: Record<DevTool, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cli: "직접 명령",
  other: "기타",
};

/** The tools a screen offers. `other` exists on the wire and in old rows, but is not offered. */
export const DEV_TOOL_CHOICES: readonly DevTool[] = ["claude_code", "codex", "cli"];

export function devToolLabel(tool: DevTool): string {
  return TOOL_LABELS[tool];
}

/**
 * A starting name for the name field. It is the tool's own name, never a device or host
 * name: nothing here can know which machine the person is on, and a guessed one would
 * read as a fact in the list.
 */
export function defaultDevCredentialName(tool: DevTool): string {
  return devToolLabel(tool);
}

// ---- expiry -------------------------------------------------------------------------------

/** The lifetimes a screen offers as buttons. A typed number from 1 to the maximum is also valid. */
export const DEV_EXPIRY_CHOICES: readonly number[] = [7, DEV_EXPIRY_DEFAULT_DAYS, 60, DEV_EXPIRY_MAX_DAYS];

export function devExpiryChoiceLabel(days: number): string {
  return `${days}일`;
}

const EXPIRY_RANGE = `1일부터 ${DEV_EXPIRY_MAX_DAYS}일까지`;

/** `raw` is the typed text, or a number from a button. */
export function validateExpiryDays(raw: string | number): DevValidation<number> {
  if (typeof raw === "string" && raw.trim() === "") {
    return { ok: false, message: `만료 기간을 입력해 주세요. ${EXPIRY_RANGE} 정할 수 있어요.` };
  }
  const days = typeof raw === "number" ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, message: `만료 기간은 ${EXPIRY_RANGE} 정수로 입력해 주세요.` };
  }
  if (days > DEV_EXPIRY_MAX_DAYS) {
    return {
      ok: false,
      message: `만료 기간은 최대 ${DEV_EXPIRY_MAX_DAYS}일이에요. 더 오래 쓰려면 만료 전에 새로 만들어 주세요.`,
    };
  }
  return { ok: true, value: days };
}

const DAY_MS = 86_400_000;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * When a token ends, in the reader's own calendar days: 「오늘」 until midnight, then
 * 「1일 뒤」 and up. A time that has already passed is said so, honestly, even though the
 * server lists live tokens only (a skewed clock is a fact worth showing, not hiding).
 * For a login session `expiresAtMs` is the live refresh half's expiry, so using it moves it.
 */
export function devExpiry(expiresAtMs: number, nowMs: number): { label: string; expired: boolean } {
  if (expiresAtMs <= nowMs) return { label: "만료 시각이 지났어요", expired: true };
  const days = Math.round((startOfLocalDay(expiresAtMs) - startOfLocalDay(nowMs)) / DAY_MS);
  return { label: days <= 0 ? "오늘" : `${days}일 뒤`, expired: false };
}

// ---- field validation ---------------------------------------------------------------------

export const DEV_NAME_MAX_LENGTH = 80;
export const DEV_CHANNEL_MAX = 50;
export const DEV_PASSWORD_MAX_LENGTH = 1024;

/** The server counts characters, so count code points, not UTF-16 units. */
function charCount(value: string): number {
  return Array.from(value).length;
}

/** The two developer-token envelopes. A name holding one would be a listable copy of a secret. */
const ENVELOPE_MARKERS = ["momo_dev_v1.", "momo_devr_v1."];

/** 1 to 80 characters after trimming, no control characters, no token envelope. */
export function validateDevName(raw: string): DevValidation<string> {
  const name = raw.trim();
  const length = charCount(name);
  if (length === 0) {
    return { ok: false, message: "이름을 입력해 주세요. 목록에서 이 연결을 알아볼 수 있는 이름이면 돼요." };
  }
  if (length > DEV_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `이름은 ${DEV_NAME_MAX_LENGTH}자까지 쓸 수 있어요. 지금 ${length}자예요. 조금 줄여 주세요.`,
    };
  }
  if (/\p{Cc}/u.test(name)) {
    return { ok: false, message: "이름에는 줄바꿈 같은 제어 문자를 쓸 수 없어요. 글자만 남기고 다시 입력해 주세요." };
  }
  const lower = name.toLowerCase();
  if (ENVELOPE_MARKERS.some((marker) => lower.includes(marker))) {
    return { ok: false, message: "이름에 토큰 값이 들어 있어요. 이름 칸에는 알아보기 쉬운 말만 넣어 주세요." };
  }
  return { ok: true, value: name };
}

/** 1 to 50 channels, a repeat counted once. The value is the list without repeats. */
export function validateChannelSelection(ids: readonly string[]): DevValidation<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  if (unique.length === 0) {
    return {
      ok: false,
      message: "채널을 1개 이상 골라 주세요. 채널을 가리지 않으려면 「고른 채널만 쓰기」를 꺼 주세요.",
    };
  }
  if (unique.length > DEV_CHANNEL_MAX) {
    return {
      ok: false,
      message: `채널은 ${DEV_CHANNEL_MAX}개까지 고를 수 있어요. 지금 ${unique.length}개를 골랐으니 ${unique.length - DEV_CHANNEL_MAX}개를 빼 주세요.`,
    };
  }
  return { ok: true, value: unique };
}

/**
 * The current password, typed again to make a token: 1 to 1024 characters. Never trimmed,
 * because a password may begin or end with a space, and the value is returned as typed.
 */
export function validatePassword(raw: string): DevValidation<string> {
  const length = charCount(raw);
  if (length === 0) {
    return { ok: false, message: "현재 비밀번호를 입력해 주세요. 연결을 만들 때마다 한 번 더 확인해요." };
  }
  if (length > DEV_PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `비밀번호는 ${DEV_PASSWORD_MAX_LENGTH}자까지 입력할 수 있어요. 입력한 내용을 다시 확인해 주세요.`,
    };
  }
  return { ok: true, value: raw };
}

// ---- list rows ----------------------------------------------------------------------------

const KIND_LABELS: Record<DevCredentialKind, string> = {
  card: "카드 토큰",
  session: "로그인 세션",
};

export interface DevCredentialRow {
  id: string;
  kind: DevCredentialKind;
  /** 「카드 토큰」 or 「로그인 세션」. */
  kindLabel: string;
  name: string;
  /** Absent when no tool is stored (a login session). Never filled in with a guess. */
  toolLabel?: string;
  /** 「읽기만」, 「읽기 + 보내기」 or 「직접 정한 범위」, plus 「 · 고른 채널만」 when limited. */
  scopeLabel: string;
  /** Every power in plain words, only for a combination that is not a preset. */
  scopeDetail?: string;
  channelRestricted: boolean;
  /** Only a login session has a device name. A card row has none and never gets an invented one. */
  deviceName?: string;
  /** 「아직 안 썼어요」, or how long ago. */
  lastUsedLabel: string;
  neverUsed: boolean;
  /** 「오늘」, 「N일 뒤」, or that the time has passed. */
  expiryLabel: string;
  expired: boolean;
  memberId: string;
  /** Passed through for the all-members view, where the caller resolved the id to a name. */
  memberName?: string;
}

export function devCredentialRow(
  credential: DevCredential,
  options: { now: number; memberName?: string }
): DevCredentialRow {
  const scopeKind = devScopeKind(credential.scopes);
  const expiry = devExpiry(credential.expiresAtMs, options.now);
  const neverUsed = credential.lastUsedAtMs === undefined;
  return {
    id: credential.id,
    kind: credential.kind,
    kindLabel: KIND_LABELS[credential.kind],
    name: credential.name,
    ...(credential.tool === undefined ? {} : { toolLabel: devToolLabel(credential.tool) }),
    scopeLabel: devScopeLabel(credential.scopes, credential.channelRestricted),
    ...(scopeKind === "custom" ? { scopeDetail: devScopeDetail(credential.scopes) } : {}),
    channelRestricted: credential.channelRestricted,
    ...(credential.deviceName === undefined ? {} : { deviceName: credential.deviceName }),
    lastUsedLabel:
      credential.lastUsedAtMs === undefined
        ? "아직 안 썼어요"
        : relativeLabel(credential.lastUsedAtMs, options.now),
    neverUsed,
    expiryLabel: expiry.label,
    expired: expiry.expired,
    memberId: credential.memberId,
    ...(options.memberName === undefined ? {} : { memberName: options.memberName }),
  };
}

/** Whether a row is the signed-in member's own (ids cross the wire in mixed case). */
export function isOwnDevCredential(credential: DevCredential, memberId: string): boolean {
  return uuidEq(credential.memberId, memberId);
}

/** The two views of the list. The second is for owners and admins (`canManageAll`). */
export const DEV_LIST_SCOPE_LABELS = { mine: "내 연결", all: "전체" } as const;

// ---- policy gate ------------------------------------------------------------------------------

export type DevAccessGateState = "open" | "needs_admin" | "off";

export interface DevAccessGate {
  state: DevAccessGateState;
  text: string;
}

/**
 * What the create area shows, from the workspace switch and what it lets the caller do.
 * `canCreate` decides first. Otherwise a switch that is `off` says it is off, and any other
 * refusal says an administrator has to open it.
 */
export function devAccessGate(policy: DevAccessPolicy): DevAccessGate {
  if (policy.canCreate) {
    return {
      state: "open",
      text:
        policy.policy === "members"
          ? "이 워크스페이스의 팀원은 모두 연결을 만들 수 있어요."
          : policy.policy === "admins"
            ? "지금은 소유자와 관리자가 연결을 만들 수 있어요."
            : "연결을 만들 수 있어요.",
    };
  }
  if (policy.policy === "off") {
    return {
      state: "off",
      text: "명령줄·AI 도구 연결이 꺼져 있어요. 다시 켜기 전에는 새로 만들 수 없어요.",
    };
  }
  if (policy.policy === "members") {
    return {
      state: "needs_admin",
      text: "이 계정으로는 연결을 만들 수 없어요. 자세한 내용은 관리자에게 물어봐 주세요.",
    };
  }
  return {
    state: "needs_admin",
    text: "관리자가 켜 줘야 해요. 지금은 소유자와 관리자만 연결을 만들 수 있어요.",
  };
}

// ---- fixed notices ----------------------------------------------------------------------------

/** Facts the screen states as they are. Each one is something the server does. */
export const DEV_NOTICES = {
  passwordChangeEndsAll: "비밀번호를 바꾸면 모든 연결이 끊겨요.",
  logoutKeepsConnections: "앱에서 로그아웃해도 연결은 끊기지 않아요. 여기서 따로 지워요.",
  toolIsOnlyALabel: "쓰는 도구는 만든 사람이 고른 값이에요. 확인된 사실은 아니에요.",
  fixedAfterIssue: "만든 뒤에는 범위, 채널, 만료를 바꿀 수 없어요. 바꾸려면 새로 만들고 옛것을 지워요.",
  cardLimit: `카드 토큰은 한 사람이 ${DEV_CARD_LIMIT}개까지 만들 수 있어요.`,
  revokeWarning: "지우면 되돌릴 수 없어요. 이 연결을 쓰던 도구는 바로 끊겨요.",
} as const;

/** The screen that shows a new token once. */
export const DEV_ONE_TIME_COPY = {
  warning: "이 화면을 닫으면 다시 볼 수 없어요. 지금 복사해서 안전한 곳에 넣어 두세요.",
  caution: "이 값을 아는 사람은 누구나 내 이름으로 이 연결이 허락한 일을 할 수 있어요. 다른 사람에게 보내지 마세요.",
  confirmLabel: "저장했어요",
} as const;

// ---- failure sentences ------------------------------------------------------------------------

export type DevAccessAction = "policy" | "list" | "create" | "revoke";

/** 「30초 뒤」, 「2분 뒤」, 「1시간 뒤」, or 「잠시 뒤」 when the server named no usable wait. */
export function retryAfterPhrase(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 1) return "잠시 뒤";
  if (seconds < 60) return `${seconds}초 뒤`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}분 뒤`;
  return `${Math.ceil(seconds / 3600)}시간 뒤`;
}

/**
 * One sentence for a classified failure: what happened and what to do next. The wrong
 * password is the one failure a screen binds to its field; every other kind reads
 * differently on purpose, so a person is never told to retry what retrying cannot fix.
 */
export function devAccessErrorText(failure: DevAccessFailure, action: DevAccessAction): string {
  switch (failure.kind) {
    case "password_incorrect":
      return "현재 비밀번호가 맞지 않아요. 다시 입력해 주세요.";
    case "password_unavailable":
      return "이 계정에는 확인할 비밀번호가 없어요. 비밀번호를 만든 뒤에 다시 시도해 주세요.";
    case "access_denied":
      return action === "create"
        ? "지금은 내 권한으로 연결을 만들 수 없어요. 관리자에게 켜 달라고 요청해 주세요."
        : "이 워크스페이스에서는 내 권한으로 이 기능을 쓸 수 없어요. 관리자에게 물어봐 주세요.";
    case "limit":
      return `카드 토큰은 한 사람이 ${DEV_CARD_LIMIT}개까지 만들 수 있어요. 안 쓰는 연결을 지운 뒤에 다시 만들어 주세요.`;
    case "rate_limited":
      return `너무 자주 시도해서 잠시 막았어요. ${retryAfterPhrase(failure.retryAfterSeconds)}에 다시 해 주세요.`;
    case "busy":
      return `팀 구성을 바꾸는 중이라 바로 처리하지 못했어요. ${retryAfterPhrase(failure.retryAfterSeconds)}에 다시 해 주세요.`;
    case "invalid":
      return action === "create"
        ? "입력한 값을 서버가 받아들이지 못했어요. 이름, 채널, 만료 기간을 확인하고 다시 눌러 주세요."
        : "요청을 서버가 받아들이지 못했어요. 화면을 새로 열고 다시 시도해 주세요.";
    case "unauthorized":
      return "로그인이 끝났어요. 다시 로그인한 뒤에 시도해 주세요.";
    case "forbidden":
      return action === "revoke"
        ? "이 연결은 내 권한으로 지울 수 없어요. 소유자나 만든 사람에게 물어봐 주세요."
        : "이 작업은 내 권한으로 할 수 없어요. 관리자에게 물어봐 주세요.";
    case "not_found":
      return action === "revoke"
        ? "이미 지워졌거나 찾을 수 없는 연결이에요. 목록을 새로 불러와 확인해 주세요."
        : "이 서버는 아직 명령줄·AI 도구 연결을 지원하지 않아요. 서버를 업데이트한 뒤에 다시 열어 주세요.";
    case "network":
      // A create that timed out may still have reached the server, and its one secret is then
      // unseen. Say so instead of inviting a blind second try.
      return action === "create"
        ? "서버에 닿지 못했어요. 연결이 만들어졌는지 알 수 없으니 목록을 확인한 뒤 다시 시도해 주세요."
        : "서버에 닿지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.";
    case "unknown":
      return action === "create"
        ? "알 수 없는 문제가 생겼어요. 연결이 만들어졌는지 알 수 없으니 목록을 확인한 뒤 다시 시도해 주세요."
        : "알 수 없는 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.";
  }
}

// ---- command snippets -----------------------------------------------------------------------------

/**
 * Whether the `oort` command-line tool's two secret-free ways in (`oort mcp` and
 * `oort token`) may be shown. They are written below so that turning this on is the only
 * change, but ADR-0216 D10 says not to advertise them before they are checked against the
 * real clients, and the tool itself is #4662. Flip it only after that check, and update the
 * test that pins the visible options to `env` alone.
 */
export const OORT_CLI_VERIFIED = false;

export type DevCommandOptionId = "stdio" | "helper" | "env";

export interface DevCommandStep {
  kind: "prose" | "code";
  text: string;
  /** For a code step: the file it goes in, or where to run it. */
  label?: string;
}

export interface DevCommandOption {
  id: DevCommandOptionId;
  /** 1 is the way ADR-0216 D10 prefers (nothing secret in a file), 3 the last resort. */
  rank: 1 | 2 | 3;
  /** False for an option that is written but must not be shown yet. */
  available: boolean;
  title: string;
  steps: DevCommandStep[];
}

export interface DevCommandContext {
  /** An absolute http(s) origin. A trailing slash is tidied away. Never a relative base. */
  serverOrigin: string;
  workspaceId: string;
}

/** Shown when the origin or workspace id is not usable, so there is nothing safe to write. */
export const DEV_COMMANDS_UNAVAILABLE_TEXT =
  "서버 주소를 확인하지 못해서 설정 조각을 만들 수 없어요. 앱을 다시 열고 시도해 주세요.";

const TOKEN_ENV = "OORT_TOKEN";

/**
 * The people's MCP address ADR-0216 D5 seals. The server side is #4661: until it is merged
 * and promoted, this path does not exist on a server, so every MCP snippet below points at
 * an address that answers nothing yet (runtime-unverified).
 */
const MCP_PATH = "/v1/mcp/me";

/** An origin is scheme, host and optional port or path. No quote, space or shell metacharacter. */
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9[][A-Za-z0-9.\-_~:/[\]]*$/;
const WORKSPACE_ID_PATTERN = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

interface Endpoints {
  origin: string;
  mcpUrl: string;
  selfUrl: string;
}

function endpoints(context: DevCommandContext): Endpoints | null {
  const origin = context.serverOrigin.trim().replace(/\/+$/, "");
  if (!ORIGIN_PATTERN.test(origin)) return null;
  if (!WORKSPACE_ID_PATTERN.test(context.workspaceId)) return null;
  return {
    origin,
    mcpUrl: `${origin}${MCP_PATH}`,
    selfUrl: `${origin}/v1/workspaces/${context.workspaceId}/dev-access/self`,
  };
}

function prose(text: string): DevCommandStep {
  return { kind: "prose", text };
}

function code(text: string, label?: string): DevCommandStep {
  return label === undefined ? { kind: "code", text } : { kind: "code", text, label };
}

/**
 * How a tool reads the value from the environment. The text holds the NAME of the variable
 * and a reference to it, never a value: a token in a file or on a command line leaks through
 * the file, the process list and the shell history (ADR-0190 D3-h measured it).
 */
const ENV_REFERENCE = "Bearer ${" + TOKEN_ENV + "}";

const TERMINAL_LABEL = "터미널";

function readIntoEnvironment(): DevCommandStep[] {
  return [
    prose(
      `복사한 값을 환경 변수 ${TOKEN_ENV}에 넣어요. 값은 명령이 아니라 입력으로만 받아서 터미널 기록에 남지 않아요.`
    ),
    code(`read -rs ${TOKEN_ENV} && export ${TOKEN_ENV}`, TERMINAL_LABEL),
    prose("붙여넣고 Enter를 누르면 돼요. 입력한 값은 화면에 보이지 않아요. bash와 zsh 기준이에요."),
  ];
}

const ENVIRONMENT_CAVEAT = prose(
  "환경 변수는 이 터미널에서 실행하는 다른 프로그램에도 전달돼요. 다 쓰고 나면 터미널을 닫아 주세요."
);

/** A line that hands curl its header through stdin, so the value is never an argument. */
function curlWithHeader(valueExpression: string, url: string): string {
  return (
    "printf 'header = \"Authorization: Bearer %s\"\\n' " +
    `"${valueExpression}" | curl -sS -K - "${url}"`
  );
}

function stdioOption(tool: DevTool, e: Endpoints): DevCommandOption | null {
  if (tool !== "claude_code" && tool !== "codex") return null;
  const steps: DevCommandStep[] = [
    prose("oort 명령줄 도구에 값을 한 번 저장해요. 값은 입력으로만 받고, 설정 파일에는 값이 들어가지 않아요."),
    code(
      `read -rs ${TOKEN_ENV} && printf '%s' "$${TOKEN_ENV}" | oort login --server ${e.origin} --with-token`,
      TERMINAL_LABEL
    ),
  ];
  if (tool === "claude_code") {
    steps.push(
      prose("그다음 Claude Code에 oort mcp를 붙여요."),
      code("claude mcp add oort -- oort mcp", TERMINAL_LABEL)
    );
  } else {
    steps.push(
      prose("그다음 ~/.codex/config.toml에 oort mcp를 더해요."),
      code('[mcp_servers.oort]\ncommand = "oort"\nargs = ["mcp"]', "~/.codex/config.toml")
    );
  }
  return {
    id: "stdio",
    rank: 1,
    available: OORT_CLI_VERIFIED,
    title: "oort mcp로 연결하기",
    steps,
  };
}

function helperOption(tool: DevTool, e: Endpoints): DevCommandOption {
  const login = [
    prose("oort 명령줄 도구에 값을 한 번 저장해요. 값은 입력으로만 받아요."),
    code(
      `read -rs ${TOKEN_ENV} && printf '%s' "$${TOKEN_ENV}" | oort login --server ${e.origin} --with-token`,
      TERMINAL_LABEL
    ),
  ];
  let steps: DevCommandStep[];
  if (tool === "claude_code") {
    const file = {
      mcpServers: { oort: { type: "http", url: e.mcpUrl, headersHelper: "oort token --headers" } },
    };
    steps = [
      ...login,
      prose("프로젝트 폴더의 .mcp.json에 oort token을 헤더 도우미로 적어요."),
      code(JSON.stringify(file, null, 2), ".mcp.json"),
    ];
  } else if (tool === "codex") {
    steps = [
      ...login,
      prose("~/.codex/config.toml에 oort token을 헤더 도우미로 적어요."),
      code(
        `[mcp_servers.oort]\nurl = "${e.mcpUrl}"\nhttp_headers_helper = "oort token --headers"`,
        "~/.codex/config.toml"
      ),
    ];
  } else {
    steps = [
      ...login,
      prose("값은 oort token이 그때그때 꺼내 줘요. curl에는 설정으로 넘겨서 명령 인자에 값이 실리지 않아요."),
      code(curlWithHeader("$(oort token)", e.selfUrl), TERMINAL_LABEL),
    ];
  }
  return {
    id: "helper",
    rank: 2,
    available: OORT_CLI_VERIFIED,
    title: "oort token으로 연결하기",
    steps,
  };
}

function envOption(tool: DevTool, e: Endpoints): DevCommandOption {
  const steps = readIntoEnvironment();
  if (tool === "claude_code") {
    const file = {
      mcpServers: {
        oort: { type: "http", url: e.mcpUrl, headers: { Authorization: ENV_REFERENCE } },
      },
    };
    steps.push(
      prose(
        "프로젝트 폴더의 .mcp.json에 아래 내용을 넣어요. 이 파일에는 값이 없지만 서버 주소가 들어 있으니 저장소에 올리지 말아 주세요."
      ),
      code(JSON.stringify(file, null, 2), ".mcp.json"),
      prose("값을 넣은 같은 터미널에서 Claude Code를 실행해요.")
    );
  } else if (tool === "codex") {
    steps.push(
      prose(
        "~/.codex/config.toml에 아래 내용을 더해요. 이 파일에는 값이 없지만 서버 주소가 들어 있으니 저장소에 올리지 말아 주세요."
      ),
      code(
        `[mcp_servers.oort]\nurl = "${e.mcpUrl}"\nbearer_token_env_var = "${TOKEN_ENV}"`,
        "~/.codex/config.toml"
      ),
      prose("값을 넣은 같은 터미널에서 Codex를 실행해요.")
    );
  } else {
    steps.push(
      prose(
        "아래 명령은 값을 명령 인자에 싣지 않고 curl 설정으로 넘겨요. 그래서 프로세스 목록에도 값이 보이지 않아요."
      ),
      code(curlWithHeader("$" + TOKEN_ENV, e.selfUrl), TERMINAL_LABEL),
      prose("이 연결의 이름과 범위가 응답으로 나오면 잘 연결된 거예요.")
    );
  }
  steps.push(ENVIRONMENT_CAVEAT);
  return { id: "env", rank: 3, available: true, title: "환경 변수로 연결하기", steps };
}

/**
 * Every way in for a tool, best first, with the ones that must not be shown yet marked
 * `available: false`. Empty when the origin is not an absolute http(s) address or the
 * workspace id is not an id: there is nothing safe to write then, and a relative address
 * in a config file would be a silent bug.
 *
 * No step ever holds a secret. A secret on a command line or in a config file is exposed
 * by the file, the process list and the shell history, so every snippet names an
 * environment variable or feeds the header through standard input.
 */
export function devCommandOptions(tool: DevTool, context: DevCommandContext): DevCommandOption[] {
  const e = endpoints(context);
  if (e === null) return [];
  const options = [stdioOption(tool, e), helperOption(tool, e), envOption(tool, e)];
  return options.filter((option): option is DevCommandOption => option !== null);
}

/** What the screen shows: only the options that are available. */
export function commandTabsFor(tool: DevTool, context: DevCommandContext): DevCommandOption[] {
  return devCommandOptions(tool, context).filter((option) => option.available);
}
