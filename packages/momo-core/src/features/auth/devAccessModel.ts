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

import type { LocaleService } from "../../i18n/context";
import type { MessageKey } from "../../i18n/generated/messages";
import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
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

/**
 * One sentence this model hands to a screen: a dictionary key and, when the sentence has values, those values.
 * The model never returns the sentence itself; the screen formats it when it draws, in the language it shows
 * (`formatMessage(message.key, message.values as never)`). Only keys of this feature's own group fit.
 */
export type DevMessage = MessageRef<Extract<MessageKey, `auth.devAccess${string}`>>;

/** Result of one field check: the normalised value, or one sentence for that field. */
export type DevValidation<T> = { ok: true; value: T } | { ok: false; message: DevMessage };

// ---- presets and scope labels ---------------------------------------------------------

export interface DevPreset {
  id: DevPresetId;
  labelKey: PlainMessageKey;
  descriptionKey: PlainMessageKey;
  scopes: readonly DevScope[];
}

/** The two presets, in the order a screen lists them. The first is the default. */
export const DEV_PRESETS: readonly DevPreset[] = [
  {
    id: "read",
    labelKey: "auth.devAccessPreset.readLabel",
    descriptionKey: "auth.devAccessPreset.readDescription",
    scopes: DEV_READ_SCOPES,
  },
  {
    id: "read_write",
    labelKey: "auth.devAccessPreset.readWriteLabel",
    descriptionKey: "auth.devAccessPreset.readWriteDescription",
    scopes: DEV_READ_WRITE_SCOPES,
  },
];

export const DEV_DEFAULT_PRESET: DevPresetId = "read";

/** A restriction laid over either preset, not a third preset. */
export const DEV_CHANNEL_RESTRICTION_COPY = {
  labelKey: "auth.devAccessRestriction.label",
  helpKey: "auth.devAccessRestriction.help",
} as const satisfies Record<string, PlainMessageKey>;

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

const SCOPE_NAME_KEYS = {
  "dev:identity": "auth.devAccessScope.identity",
  "dev:channels:read": "auth.devAccessScope.channelsRead",
  "dev:messages:read": "auth.devAccessScope.messagesRead",
  "dev:messages:write": "auth.devAccessScope.messagesWrite",
  "dev:inbox:read": "auth.devAccessScope.inboxRead",
} as const satisfies Record<DevScope, PlainMessageKey>;

const UNKNOWN_SCOPE_KEY = "auth.devAccessScope.unknown" satisfies PlainMessageKey;

export function devScopeNameKey(scope: string): PlainMessageKey {
  return isDevScope(scope) ? SCOPE_NAME_KEYS[scope] : UNKNOWN_SCOPE_KEY;
}

/**
 * Every power of a stored scope list, in plain words. An unknown name is said, not hidden. The names are
 * joined into one line, so this takes the formatter (the one exception to returning keys).
 */
export function devScopeDetail(
  formatMessage: LocaleService["formatMessage"],
  scopes: readonly string[]
): string {
  const set = new Set(scopes);
  const names: string[] = DEV_SCOPES.filter((scope) => set.has(scope)).map((scope) =>
    formatMessage(SCOPE_NAME_KEYS[scope])
  );
  if (scopes.some((scope) => !isDevScope(scope))) names.push(formatMessage(UNKNOWN_SCOPE_KEY));
  return names.join(", ");
}

const SCOPE_LABEL_KEYS = {
  read: "auth.devAccessScopeLabel.read",
  read_write: "auth.devAccessScopeLabel.readWrite",
  custom: "auth.devAccessScopeLabel.custom",
} as const satisfies Record<DevScopeKind, PlainMessageKey>;

const SCOPE_LABEL_CHANNEL_KEYS = {
  read: "auth.devAccessScopeLabel.readChannelOnly",
  read_write: "auth.devAccessScopeLabel.readWriteChannelOnly",
  custom: "auth.devAccessScopeLabel.customChannelOnly",
} as const satisfies Record<DevScopeKind, PlainMessageKey>;

/**
 * The key of 「읽기만」 or 「읽기 + 보내기」, plus 「 · 고른 채널만」 when the token is limited to chosen
 * channels. A combination that is neither preset says so (「직접 정한 범위」) instead of
 * borrowing the nearest preset's name.
 */
export function devScopeLabelKey(
  scopes: readonly string[],
  channelRestricted: boolean
): PlainMessageKey {
  const kind = devScopeKind(scopes);
  return channelRestricted ? SCOPE_LABEL_CHANNEL_KEYS[kind] : SCOPE_LABEL_KEYS[kind];
}

// ---- tools ------------------------------------------------------------------------------

const TOOL_LABEL_KEYS = {
  claude_code: "auth.devAccessTool.claudeCode",
  codex: "auth.devAccessTool.codex",
  cli: "auth.devAccessTool.cli",
  other: "auth.devAccessTool.other",
} as const satisfies Record<DevTool, PlainMessageKey>;

/** The tools a screen offers. `other` exists on the wire and in old rows, but is not offered. */
export const DEV_TOOL_CHOICES: readonly DevTool[] = ["claude_code", "codex", "cli"];

export function devToolLabelKey(tool: DevTool): PlainMessageKey {
  return TOOL_LABEL_KEYS[tool];
}

/**
 * A starting name for the name field. It is the tool's own name, never a device or host
 * name: nothing here can know which machine the person is on, and a guessed one would
 * read as a fact in the list. The person sees and may edit it before it is sent, so it
 * follows the app language; it is a string, so it takes the formatter.
 */
export function defaultDevCredentialName(
  formatMessage: LocaleService["formatMessage"],
  tool: DevTool
): string {
  return formatMessage(devToolLabelKey(tool));
}

// ---- expiry -------------------------------------------------------------------------------

/** The lifetimes a screen offers as buttons. A typed number from 1 to the maximum is also valid. */
export const DEV_EXPIRY_CHOICES: readonly number[] = [7, DEV_EXPIRY_DEFAULT_DAYS, 60, DEV_EXPIRY_MAX_DAYS];

export function devExpiryChoiceMessage(days: number): DevMessage {
  return { key: "auth.devAccessExpiry.days", values: { days } };
}

/** `raw` is the typed text, or a number from a button. */
export function validateExpiryDays(raw: string | number): DevValidation<number> {
  if (typeof raw === "string" && raw.trim() === "") {
    return {
      ok: false,
      message: { key: "auth.devAccessValidation.expiryRequired", values: { max: DEV_EXPIRY_MAX_DAYS } },
    };
  }
  const days = typeof raw === "number" ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(days) || days < 1) {
    return {
      ok: false,
      message: { key: "auth.devAccessValidation.expiryNotInteger", values: { max: DEV_EXPIRY_MAX_DAYS } },
    };
  }
  if (days > DEV_EXPIRY_MAX_DAYS) {
    return {
      ok: false,
      message: { key: "auth.devAccessValidation.expiryTooLong", values: { max: DEV_EXPIRY_MAX_DAYS } },
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
export function devExpiry(
  expiresAtMs: number,
  nowMs: number
): { message: DevMessage; expired: boolean } {
  if (expiresAtMs <= nowMs) return { message: { key: "auth.devAccessExpiry.passed" }, expired: true };
  const days = Math.round((startOfLocalDay(expiresAtMs) - startOfLocalDay(nowMs)) / DAY_MS);
  return {
    message:
      days <= 0
        ? { key: "auth.devAccessExpiry.today" }
        : { key: "auth.devAccessExpiry.daysAway", values: { days } },
    expired: false,
  };
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
    return { ok: false, message: { key: "auth.devAccessValidation.nameRequired" } };
  }
  if (length > DEV_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: {
        key: "auth.devAccessValidation.nameTooLong",
        values: { max: DEV_NAME_MAX_LENGTH, length },
      },
    };
  }
  if (/\p{Cc}/u.test(name)) {
    return { ok: false, message: { key: "auth.devAccessValidation.nameControl" } };
  }
  const lower = name.toLowerCase();
  if (ENVELOPE_MARKERS.some((marker) => lower.includes(marker))) {
    return { ok: false, message: { key: "auth.devAccessValidation.nameEnvelope" } };
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
    return { ok: false, message: { key: "auth.devAccessValidation.channelsRequired" } };
  }
  if (unique.length > DEV_CHANNEL_MAX) {
    return {
      ok: false,
      message: {
        key: "auth.devAccessValidation.channelsTooMany",
        values: {
          max: DEV_CHANNEL_MAX,
          count: unique.length,
          excess: unique.length - DEV_CHANNEL_MAX,
        },
      },
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
    return { ok: false, message: { key: "auth.devAccessValidation.passwordRequired" } };
  }
  if (length > DEV_PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: {
        key: "auth.devAccessValidation.passwordTooLong",
        // A string, not `{max, number}`: the Korean screen says 1024, and a number format would say 1,024.
        values: { max: String(DEV_PASSWORD_MAX_LENGTH) },
      },
    };
  }
  return { ok: true, value: raw };
}

// ---- list rows ----------------------------------------------------------------------------

const KIND_LABEL_KEYS = {
  card: "auth.devAccessKind.card",
  session: "auth.devAccessKind.session",
} as const satisfies Record<DevCredentialKind, PlainMessageKey>;

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

/**
 * The row's labels are strings (the list joins several messages and a relative time), so this takes the
 * formatter. The last-used time still reads through the inbox's `relativeLabel`, which stays Korean until
 * the inbox cell moves it.
 */
export function devCredentialRow(
  formatMessage: LocaleService["formatMessage"],
  credential: DevCredential,
  options: { now: number; memberName?: string }
): DevCredentialRow {
  const scopeKind = devScopeKind(credential.scopes);
  const expiry = devExpiry(credential.expiresAtMs, options.now);
  const neverUsed = credential.lastUsedAtMs === undefined;
  return {
    id: credential.id,
    kind: credential.kind,
    kindLabel: formatMessage(KIND_LABEL_KEYS[credential.kind]),
    name: credential.name,
    ...(credential.tool === undefined
      ? {}
      : { toolLabel: formatMessage(devToolLabelKey(credential.tool)) }),
    scopeLabel: formatMessage(devScopeLabelKey(credential.scopes, credential.channelRestricted)),
    ...(scopeKind === "custom"
      ? { scopeDetail: devScopeDetail(formatMessage, credential.scopes) }
      : {}),
    channelRestricted: credential.channelRestricted,
    ...(credential.deviceName === undefined ? {} : { deviceName: credential.deviceName }),
    lastUsedLabel:
      credential.lastUsedAtMs === undefined
        ? formatMessage("auth.devAccessRow.neverUsed")
        : relativeLabel(credential.lastUsedAtMs, options.now),
    neverUsed,
    expiryLabel: formatMessage(expiry.message.key, expiry.message.values as never),
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
export const DEV_LIST_SCOPE_LABEL_KEYS = {
  mine: "auth.devAccessList.mine",
  all: "auth.devAccessList.all",
} as const satisfies Record<string, PlainMessageKey>;

// ---- policy gate ------------------------------------------------------------------------------

export type DevAccessGateState = "open" | "needs_admin" | "off";

export interface DevAccessGate {
  state: DevAccessGateState;
  message: DevMessage;
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
      message: {
        key:
          policy.policy === "members"
            ? "auth.devAccessGate.membersOpen"
            : policy.policy === "admins"
              ? "auth.devAccessGate.adminsOpen"
              : "auth.devAccessGate.open",
      },
    };
  }
  if (policy.policy === "off") {
    return { state: "off", message: { key: "auth.devAccessGate.off" } };
  }
  if (policy.policy === "members") {
    return { state: "needs_admin", message: { key: "auth.devAccessGate.membersDenied" } };
  }
  return { state: "needs_admin", message: { key: "auth.devAccessGate.adminsOnly" } };
}

// ---- fixed notices ----------------------------------------------------------------------------

/** Facts the screen states as they are. Each one is something the server does. */
export const DEV_NOTICES = {
  passwordChangeEndsAll: { key: "auth.devAccessNotice.passwordChangeEndsAll" },
  logoutKeepsConnections: { key: "auth.devAccessNotice.logoutKeepsConnections" },
  toolIsOnlyALabel: { key: "auth.devAccessNotice.toolIsOnlyALabel" },
  fixedAfterIssue: { key: "auth.devAccessNotice.fixedAfterIssue" },
  cardLimit: { key: "auth.devAccessNotice.cardLimit", values: { limit: DEV_CARD_LIMIT } },
  revokeWarning: { key: "auth.devAccessNotice.revokeWarning" },
} as const satisfies Record<string, DevMessage>;

/** The screen that shows a new token once. */
export const DEV_ONE_TIME_COPY = {
  warningKey: "auth.devAccessOneTime.warning",
  cautionKey: "auth.devAccessOneTime.caution",
  confirmKey: "auth.devAccessOneTime.confirm",
} as const satisfies Record<string, PlainMessageKey>;

// ---- failure sentences ------------------------------------------------------------------------

export type DevAccessAction = "policy" | "list" | "create" | "revoke";

/**
 * The wait a failure sentence names, as the values its message branches on: 「30초 뒤」, 「2분 뒤」, 「1시간 뒤」,
 * or 「잠시 뒤」 (`soon`) when the server named no usable wait.
 */
export function retryAfterWait(seconds: number | undefined): {
  unit: "soon" | "second" | "minute" | "hour";
  amount: number;
} {
  if (seconds === undefined || seconds < 1) return { unit: "soon", amount: 0 };
  if (seconds < 60) return { unit: "second", amount: seconds };
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return { unit: "minute", amount: minutes };
  return { unit: "hour", amount: Math.ceil(seconds / 3600) };
}

/**
 * One sentence for a classified failure: what happened and what to do next. The wrong
 * password is the one failure a screen binds to its field; every other kind reads
 * differently on purpose, so a person is never told to retry what retrying cannot fix.
 */
export function devAccessErrorMessage(
  failure: DevAccessFailure,
  action: DevAccessAction
): DevMessage {
  switch (failure.kind) {
    case "password_incorrect":
      return { key: "auth.devAccessError.passwordIncorrect" };
    case "password_unavailable":
      return { key: "auth.devAccessError.passwordUnavailable" };
    case "access_denied":
      return {
        key:
          action === "create"
            ? "auth.devAccessError.accessDeniedCreate"
            : "auth.devAccessError.accessDenied",
      };
    case "limit":
      return { key: "auth.devAccessError.limit", values: { limit: DEV_CARD_LIMIT } };
    case "rate_limited":
      return {
        key: "auth.devAccessError.rateLimited",
        values: retryAfterWait(failure.retryAfterSeconds),
      };
    case "busy":
      return { key: "auth.devAccessError.busy", values: retryAfterWait(failure.retryAfterSeconds) };
    case "invalid":
      return {
        key:
          action === "create"
            ? "auth.devAccessError.invalidCreate"
            : "auth.devAccessError.invalid",
      };
    case "unauthorized":
      return { key: "auth.devAccessError.unauthorized" };
    case "forbidden":
      return {
        key:
          action === "revoke"
            ? "auth.devAccessError.forbiddenRevoke"
            : "auth.devAccessError.forbidden",
      };
    case "not_found":
      return {
        key:
          action === "revoke"
            ? "auth.devAccessError.notFoundRevoke"
            : "auth.devAccessError.notFound",
      };
    case "network":
      // A create that timed out may still have reached the server, and its one secret is then
      // unseen. Say so instead of inviting a blind second try.
      return {
        key:
          action === "create"
            ? "auth.devAccessError.networkCreate"
            : "auth.devAccessError.network",
      };
    case "unknown":
      return {
        key:
          action === "create"
            ? "auth.devAccessError.unknownCreate"
            : "auth.devAccessError.unknown",
      };
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

/** Where a code step goes: a terminal, or a file path. A path is not copy: it is named as it is. */
export type DevCommandLabel = { kind: "terminal" } | { kind: "file"; path: string };

export type DevCommandStep =
  | { kind: "prose"; message: DevMessage }
  | {
      kind: "code";
      /** The snippet itself: commands, paths and identifiers, never translated. */
      text: string;
      /** The file it goes in, or where to run it. */
      label?: DevCommandLabel;
    };

/** The label of the terminal on a code step. */
export const DEV_TERMINAL_LABEL_KEY = "auth.devAccessCommand.terminal" satisfies PlainMessageKey;

export interface DevCommandOption {
  id: DevCommandOptionId;
  /** 1 is the way ADR-0216 D10 prefers (nothing secret in a file), 3 the last resort. */
  rank: 1 | 2 | 3;
  /** False for an option that is written but must not be shown yet. */
  available: boolean;
  titleKey: PlainMessageKey;
  steps: DevCommandStep[];
}

export interface DevCommandContext {
  /** An absolute http(s) origin. A trailing slash is tidied away. Never a relative base. */
  serverOrigin: string;
  workspaceId: string;
}

/** Shown when the origin or workspace id is not usable, so there is nothing safe to write. */
export const DEV_COMMANDS_UNAVAILABLE_KEY =
  "auth.devAccessCommand.unavailable" satisfies PlainMessageKey;

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

function prose(message: DevMessage): DevCommandStep {
  return { kind: "prose", message };
}

function code(text: string, label?: DevCommandLabel): DevCommandStep {
  return label === undefined ? { kind: "code", text } : { kind: "code", text, label };
}

function file(path: string): DevCommandLabel {
  return { kind: "file", path };
}

const CODEX_CONFIG_PATH = "~/.codex/config.toml";
const MCP_JSON_PATH = ".mcp.json";

/**
 * How a tool reads the value from the environment. The text holds the NAME of the variable
 * and a reference to it, never a value: a token in a file or on a command line leaks through
 * the file, the process list and the shell history (ADR-0190 D3-h measured it).
 */
const ENV_REFERENCE = "Bearer ${" + TOKEN_ENV + "}";

const TERMINAL_LABEL: DevCommandLabel = { kind: "terminal" };

function readIntoEnvironment(): DevCommandStep[] {
  return [
    prose({ key: "auth.devAccessCommand.readIntoEnv", values: { env: TOKEN_ENV } }),
    code(`read -rs ${TOKEN_ENV} && export ${TOKEN_ENV}`, TERMINAL_LABEL),
    prose({ key: "auth.devAccessCommand.pasteAndEnter" }),
  ];
}

const ENVIRONMENT_CAVEAT = prose({ key: "auth.devAccessCommand.environmentCaveat" });

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
    prose({ key: "auth.devAccessCommand.stdioLogin" }),
    code(
      `read -rs ${TOKEN_ENV} && printf '%s' "$${TOKEN_ENV}" | oort login --server ${e.origin} --with-token`,
      TERMINAL_LABEL
    ),
  ];
  if (tool === "claude_code") {
    steps.push(
      prose({ key: "auth.devAccessCommand.stdioClaude", values: { command: "oort mcp" } }),
      code("claude mcp add oort -- oort mcp", TERMINAL_LABEL)
    );
  } else {
    steps.push(
      prose({
        key: "auth.devAccessCommand.stdioCodex",
        values: { path: CODEX_CONFIG_PATH, command: "oort mcp" },
      }),
      code('[mcp_servers.oort]\ncommand = "oort"\nargs = ["mcp"]', file(CODEX_CONFIG_PATH))
    );
  }
  return {
    id: "stdio",
    rank: 1,
    available: OORT_CLI_VERIFIED,
    titleKey: "auth.devAccessCommand.stdioTitle",
    steps,
  };
}

function helperOption(tool: DevTool, e: Endpoints): DevCommandOption {
  const login = [
    prose({ key: "auth.devAccessCommand.helperLogin" }),
    code(
      `read -rs ${TOKEN_ENV} && printf '%s' "$${TOKEN_ENV}" | oort login --server ${e.origin} --with-token`,
      TERMINAL_LABEL
    ),
  ];
  let steps: DevCommandStep[];
  if (tool === "claude_code") {
    const mcpFile = {
      mcpServers: { oort: { type: "http", url: e.mcpUrl, headersHelper: "oort token --headers" } },
    };
    steps = [
      ...login,
      prose({
        key: "auth.devAccessCommand.helperClaude",
        values: { path: MCP_JSON_PATH, command: "oort token" },
      }),
      code(JSON.stringify(mcpFile, null, 2), file(MCP_JSON_PATH)),
    ];
  } else if (tool === "codex") {
    steps = [
      ...login,
      prose({
        key: "auth.devAccessCommand.helperCodex",
        values: { path: CODEX_CONFIG_PATH, command: "oort token" },
      }),
      code(
        `[mcp_servers.oort]\nurl = "${e.mcpUrl}"\nhttp_headers_helper = "oort token --headers"`,
        file(CODEX_CONFIG_PATH)
      ),
    ];
  } else {
    steps = [
      ...login,
      prose({ key: "auth.devAccessCommand.helperCli", values: { command: "oort token" } }),
      code(curlWithHeader("$(oort token)", e.selfUrl), TERMINAL_LABEL),
    ];
  }
  return {
    id: "helper",
    rank: 2,
    available: OORT_CLI_VERIFIED,
    titleKey: "auth.devAccessCommand.helperTitle",
    steps,
  };
}

function envOption(tool: DevTool, e: Endpoints): DevCommandOption {
  const steps = readIntoEnvironment();
  if (tool === "claude_code") {
    const mcpFile = {
      mcpServers: {
        oort: { type: "http", url: e.mcpUrl, headers: { Authorization: ENV_REFERENCE } },
      },
    };
    steps.push(
      prose({ key: "auth.devAccessCommand.envClaude", values: { path: MCP_JSON_PATH } }),
      code(JSON.stringify(mcpFile, null, 2), file(MCP_JSON_PATH)),
      prose({ key: "auth.devAccessCommand.envClaudeRun" })
    );
  } else if (tool === "codex") {
    steps.push(
      prose({ key: "auth.devAccessCommand.envCodex", values: { path: CODEX_CONFIG_PATH } }),
      code(
        `[mcp_servers.oort]\nurl = "${e.mcpUrl}"\nbearer_token_env_var = "${TOKEN_ENV}"`,
        file(CODEX_CONFIG_PATH)
      ),
      prose({ key: "auth.devAccessCommand.envCodexRun" })
    );
  } else {
    steps.push(
      prose({ key: "auth.devAccessCommand.envCli" }),
      code(curlWithHeader("$" + TOKEN_ENV, e.selfUrl), TERMINAL_LABEL),
      prose({ key: "auth.devAccessCommand.envCliDone" })
    );
  }
  steps.push(ENVIRONMENT_CAVEAT);
  return {
    id: "env",
    rank: 3,
    available: true,
    titleKey: "auth.devAccessCommand.envTitle",
    steps,
  };
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
