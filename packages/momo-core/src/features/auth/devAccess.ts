// Developer access: the developer tokens a person makes for command-line and AI
// tools (ADR-0216 D2, D3, D6, D7). The server is #4660, the settings screen is
// #4663. Transport is the shared rotating client (`authedRequest` in lib/api.ts):
// a 401 rotates once, and only a 401 that survives rotation may mean expiry.
//
// GET    /v1/workspaces/{ws}/dev-access
//          { policy: "admins" | "members" | "off", canCreate, canManageAll }
// POST   /v1/workspaces/{ws}/dev-access/credentials
//          201 { id, kind: "card", name, tool, scopes, channelIds?, createdAtMs,
//                expiresAtMs, token }
// GET    /v1/workspaces/{ws}/dev-access/credentials[?scope=all]
//          { credentials: DevCredential[] }   (live ones only, newest first)
// DELETE /v1/workspaces/{ws}/dev-access/credentials/{id}
//          { id, kind, revokedNow }           (idempotent, a repeat is 200)
//
// Not here: GET and DELETE `.../dev-access/self`. A developer token calls those
// (`oort whoami`, `oort logout`), the app never does.
//
// ## The secret
//
// `CreatedDevCredential.token` is the only copy of a secret that exists. The server
// keeps a hash, no route shows it again, and this file never logs, stores or echoes
// it. The caller keeps it in one place that dies with the screen (a mutation result)
// and never in a query cache, storage, a URL or a log. The same goes for the
// password typed into `CreateDevCredentialInput.currentPassword`.
//
// A create response is never rejected for the shape of `token` itself. The envelope
// is `momo_dev_v1.<workspace>.<secret>` today, but a stricter check here would turn a
// future prefix into a lost secret that exists on the server and can no longer be
// shown. `token` only has to be a non-empty string.
//
// ## What the parsers tolerate
//
// A field the server sent must have its documented type, or the answer is a
// `WireShapeError`. Two open vocabularies are read leniently, because rejecting them
// would hide the whole list, and a list that cannot be read cannot be revoked from:
//   - `tool`: a value this client does not know reads as `other`. It is a label the
//     maker chose, never a verified fact.
//   - `scopes`: an unknown name stays in the array as a string. The label then says
//     the combination is not one this app names, instead of dropping a power it
//     cannot describe.
// `kind` is closed (it decides which actions exist), so an unknown kind is an error.

import { ApiError, authedRequest } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  arrayField,
  bool,
  num,
  record,
  str,
  stringArrayField,
  WireShapeError,
} from "../../lib/wire";

// ---- vocabulary --------------------------------------------------------------

export const DEV_TOOLS = ["claude_code", "codex", "cli", "other"] as const;
/** What the maker says a token is for. A value they chose, never a verified fact. */
export type DevTool = (typeof DEV_TOOLS)[number];

export function isDevTool(value: unknown): value is DevTool {
  return typeof value === "string" && (DEV_TOOLS as readonly string[]).includes(value);
}

export const DEV_SCOPES = [
  "dev:identity",
  "dev:channels:read",
  "dev:messages:read",
  "dev:messages:write",
  "dev:inbox:read",
] as const;
export type DevScope = (typeof DEV_SCOPES)[number];

export function isDevScope(value: unknown): value is DevScope {
  return typeof value === "string" && (DEV_SCOPES as readonly string[]).includes(value);
}

/** The two presets a screen offers. The server only ever sees the scope list. */
export type DevPresetId = "read" | "read_write";

/**
 * 「읽기만」: what the server grants when `scopes` is omitted. `dev:identity` is always
 * included by the server, so it is part of both sets.
 */
export const DEV_READ_SCOPES: readonly DevScope[] = [
  "dev:identity",
  "dev:channels:read",
  "dev:messages:read",
  "dev:inbox:read",
];

/** 「읽기 + 보내기」: the read set plus `dev:messages:write`, the scope that speaks as the person. */
export const DEV_READ_WRITE_SCOPES: readonly DevScope[] = [
  ...DEV_READ_SCOPES,
  "dev:messages:write",
];

/** The server's default lifetime. Omitting `expiresInDays` is how a caller asks for it. */
export const DEV_EXPIRY_DEFAULT_DAYS = 30;
/** The longest lifetime the server accepts (a database CHECK holds it too). */
export const DEV_EXPIRY_MAX_DAYS = 90;

export type DevAccessPolicyValue = "admins" | "members" | "off";

export interface DevAccessPolicy {
  /** The workspace switch. */
  policy: DevAccessPolicyValue;
  /** The switch admits the caller's role today, so making a token is open to them. */
  canCreate: boolean;
  /** The caller is an owner or admin: may list everyone's tokens (`?scope=all`). */
  canManageAll: boolean;
}

export type DevCredentialKind = "card" | "session";

/** One live developer token. Never carries the secret, its hash or the channel ids. */
export interface DevCredential {
  id: string;
  /** The member the token acts as. Compare ids case-insensitively (`uuidEq`). */
  memberId: string;
  kind: DevCredentialKind;
  name: string;
  /** Absent for a login session, which has no maker-chosen tool. */
  tool?: DevTool;
  /** Known names are `DevScope`; an unknown name is kept as it arrived. */
  scopes: string[];
  channelRestricted: boolean;
  /** A login session's device name, a label the connecting side chose. Never on a card. */
  deviceName?: string;
  createdAtMs: number;
  /** Absent means the token was never used. */
  lastUsedAtMs?: number;
  expiresAtMs: number;
  /** A login session's absolute cap. Absent on a card. */
  lineageExpiresAtMs?: number;
}

export interface CreateDevCredentialInput {
  /** Trimmed before sending. Validate with the model's `validateDevName` first. */
  name: string;
  tool: DevTool;
  preset: DevPresetId;
  /** Empty or absent means no channel restriction. */
  channelIds?: readonly string[];
  /** Absent or the default means the server's default lifetime. */
  expiresInDays?: number;
  /** Typed again on every create. Never trimmed, never kept after the call. */
  currentPassword: string;
}

/** The JSON body of `POST .../dev-access/credentials`. A key is absent when the default applies. */
export interface CreateDevCredentialBody {
  name: string;
  tool: DevTool;
  scopes?: DevScope[];
  channelIds?: string[];
  expiresInDays?: number;
  currentPassword: string;
}

/** The 201 answer. `token` is the only copy of the secret. */
export interface CreatedDevCredential {
  id: string;
  kind: "card";
  name: string;
  tool: DevTool;
  scopes: string[];
  /** The caller's own choice, echoed once. Absent when there is no restriction. */
  channelIds?: string[];
  createdAtMs: number;
  expiresAtMs: number;
  token: string;
}

export interface RevokeDevCredentialResult {
  id: string;
  kind: DevCredentialKind;
  /** False when it had already ended (a repeated call, or a sweep got there first). */
  revokedNow: boolean;
}

// ---- parsers -------------------------------------------------------------------

function required(source: unknown, key: string): string {
  const value = str(source, key);
  if (value === undefined || value === "") throw new WireShapeError();
  return value;
}

function requiredNumber(source: unknown, key: string): number {
  const value = num(source, key);
  if (value === undefined) throw new WireShapeError();
  return value;
}

function requiredBool(source: unknown, key: string): boolean {
  const value = bool(source, key);
  if (value === undefined) throw new WireShapeError();
  return value;
}

/** Absent or `null` is absence. A value of the wrong type is a broken answer. */
function optionalNumber(source: unknown, key: string): number | undefined {
  const raw = record(source)?.[key];
  if (raw === undefined || raw === null) return undefined;
  return requiredNumber(source, key);
}

function optionalString(source: unknown, key: string): string | undefined {
  const raw = record(source)?.[key];
  if (raw === undefined || raw === null) return undefined;
  const value = str(source, key);
  if (value === undefined) throw new WireShapeError();
  return value === "" ? undefined : value;
}

function requiredScopes(source: unknown): string[] {
  const scopes = stringArrayField(source, "scopes");
  if (scopes === null) throw new WireShapeError();
  return scopes;
}

/** Absent stays absent. A value this client does not know is `other`. */
function readTool(source: unknown): DevTool | undefined {
  const raw = record(source)?.["tool"];
  if (raw === undefined || raw === null) return undefined;
  return isDevTool(raw) ? raw : "other";
}

function readKind(source: unknown): DevCredentialKind {
  const kind = str(source, "kind");
  if (kind !== "card" && kind !== "session") throw new WireShapeError();
  return kind;
}

export function parseDevAccessPolicy(value: unknown): DevAccessPolicy {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const policy = str(source, "policy");
  if (policy !== "admins" && policy !== "members" && policy !== "off") {
    throw new WireShapeError();
  }
  return {
    policy,
    canCreate: requiredBool(source, "canCreate"),
    canManageAll: requiredBool(source, "canManageAll"),
  };
}

export function parseDevCredential(value: unknown): DevCredential {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = required(source, "id");
  const memberId = required(source, "memberId");
  const kind = readKind(source);
  const name = required(source, "name");
  const scopes = requiredScopes(source);
  const channelRestricted = requiredBool(source, "channelRestricted");
  const createdAtMs = requiredNumber(source, "createdAtMs");
  const expiresAtMs = requiredNumber(source, "expiresAtMs");
  const tool = readTool(source);
  const deviceName = optionalString(source, "deviceName");
  const lastUsedAtMs = optionalNumber(source, "lastUsedAtMs");
  const lineageExpiresAtMs = optionalNumber(source, "lineageExpiresAtMs");
  return {
    id,
    memberId,
    kind,
    name,
    ...(tool === undefined ? {} : { tool }),
    scopes,
    channelRestricted,
    ...(deviceName === undefined ? {} : { deviceName }),
    createdAtMs,
    ...(lastUsedAtMs === undefined ? {} : { lastUsedAtMs }),
    expiresAtMs,
    ...(lineageExpiresAtMs === undefined ? {} : { lineageExpiresAtMs }),
  };
}

export function parseDevCredentialList(value: unknown): DevCredential[] {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const rows = arrayField(source, "credentials");
  if (rows === null) throw new WireShapeError();
  return rows.map(parseDevCredential);
}

export function parseCreatedDevCredential(value: unknown): CreatedDevCredential {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = required(source, "id");
  if (str(source, "kind") !== "card") throw new WireShapeError();
  const name = required(source, "name");
  const tool = readTool(source);
  if (tool === undefined) throw new WireShapeError();
  const scopes = requiredScopes(source);
  const createdAtMs = requiredNumber(source, "createdAtMs");
  const expiresAtMs = requiredNumber(source, "expiresAtMs");
  const token = required(source, "token");
  let channelIds: string[] | undefined;
  const rawChannels = record(source)?.["channelIds"];
  if (rawChannels !== undefined && rawChannels !== null) {
    const parsed = stringArrayField(source, "channelIds");
    if (parsed === null) throw new WireShapeError();
    if (parsed.length > 0) channelIds = parsed;
  }
  return {
    id,
    kind: "card",
    name,
    tool,
    scopes,
    ...(channelIds === undefined ? {} : { channelIds }),
    createdAtMs,
    expiresAtMs,
    token,
  };
}

export function parseRevokeDevCredential(value: unknown): RevokeDevCredentialResult {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  return {
    id: required(source, "id"),
    kind: readKind(source),
    revokedNow: requiredBool(source, "revokedNow"),
  };
}

// ---- request body ----------------------------------------------------------------

/**
 * The create body, with every default left out.
 *
 * The server tells "omitted" from an explicit value on purpose: `scopes`, `channelIds`
 * and `expiresInDays` as `null`, `[]`, `0` or `91` are a 400, because a `null` must
 * not quietly become 30 days, "every channel" or "identity only". So the default is
 * expressed as a missing key, never as a neutral value:
 *   - 「읽기만」 sends no `scopes` (the server's default is exactly that preset);
 *   - 「읽기 + 보내기」 sends the five scopes, spelled out;
 *   - no channel restriction sends no `channelIds`;
 *   - the default lifetime sends no `expiresInDays`.
 * Input is assumed to have passed the model's validators already.
 */
export function buildCreateDevCredentialBody(
  input: CreateDevCredentialInput
): CreateDevCredentialBody {
  const body: CreateDevCredentialBody = {
    name: input.name.trim(),
    tool: input.tool,
    currentPassword: input.currentPassword,
  };
  if (input.preset === "read_write") body.scopes = [...DEV_READ_WRITE_SCOPES];
  const channelIds = uniqueIds(input.channelIds ?? []);
  if (channelIds.length > 0) body.channelIds = channelIds;
  if (input.expiresInDays !== undefined && input.expiresInDays !== DEV_EXPIRY_DEFAULT_DAYS) {
    body.expiresInDays = input.expiresInDays;
  }
  return body;
}

/** Ids cross the wire in mixed case. A repeat counts against the server's 50, so drop it. */
function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

// ---- client ------------------------------------------------------------------------
//
// A body that is empty or not JSON reads as `null` here, and every parser refuses `null`
// with a `WireShapeError`, so a gateway's HTML page never surfaces as a `SyntaxError`.

function root(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/dev-access`;
}

export async function getDevAccessPolicy(workspaceId: string): Promise<DevAccessPolicy> {
  const res = await authedRequest(root(workspaceId), { cache: "no-store" });
  return parseDevAccessPolicy(res.jsonOrNull<unknown>());
}

/** The caller's own tokens, or with `all` every member's (owner and admin only). */
export async function listDevCredentials(
  workspaceId: string,
  options: { all?: boolean } = {}
): Promise<DevCredential[]> {
  const query = options.all === true ? "?scope=all" : "";
  const res = await authedRequest(`${root(workspaceId)}/credentials${query}`, {
    cache: "no-store",
  });
  return parseDevCredentialList(res.jsonOrNull<unknown>());
}

/**
 * Makes one card token. The 201 holds the only copy of the secret: keep it in the
 * mutation result and nowhere else.
 */
export async function createDevCredential(
  workspaceId: string,
  input: CreateDevCredentialInput
): Promise<CreatedDevCredential> {
  const res = await authedRequest(`${root(workspaceId)}/credentials`, {
    method: "POST",
    body: JSON.stringify(buildCreateDevCredentialBody(input)),
    cache: "no-store",
  });
  return parseCreatedDevCredential(res.jsonOrNull<unknown>());
}

export async function revokeDevCredential(
  workspaceId: string,
  id: string
): Promise<RevokeDevCredentialResult> {
  const res = await authedRequest(
    `${root(workspaceId)}/credentials/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  return parseRevokeDevCredential(res.jsonOrNull<unknown>());
}

// ---- failures ------------------------------------------------------------------------

export type DevAccessFailureKind =
  /** 403 `current_password_incorrect`: the one failure that belongs to a field. */
  | "password_incorrect"
  /** 403 `current_password_unavailable`: the account has no password to confirm. */
  | "password_unavailable"
  /** 403 `dev_access_denied`: the workspace switch does not admit this role. */
  | "access_denied"
  /** 409 `dev_credential_limit`: 20 card tokens are already live. */
  | "limit"
  /** 429. */
  | "rate_limited"
  /** 503: a membership change holds the lock. Retrying is safe. */
  | "busy"
  /** 400: the server refused a value. It never quotes the body. */
  | "invalid"
  /** 401 that survived rotation. */
  | "unauthorized"
  /** Any other 403, including a refused revoke of an owner's or another admin's token. */
  | "forbidden"
  | "not_found"
  /** Nothing answered: no connection, or a blown deadline. */
  | "network"
  | "unknown";

export interface DevAccessFailure {
  kind: DevAccessFailureKind;
  /**
   * 429 and 503 only: the whole seconds the server asked for. Absent when it did not
   * send an integer `Retry-After`, which is not the same as "no wait".
   */
  retryAfterSeconds?: number;
}

/**
 * Classifies an error from the four calls above. Decides on `ApiError.status` and
 * `.code` only, never on message text (a server may reword a message, not a code).
 * Pure.
 */
export function devAccessError(error: unknown): DevAccessFailure {
  if (error instanceof NetworkError) return { kind: "network" };
  if (!(error instanceof ApiError)) return { kind: "unknown" };
  switch (error.status) {
    case 400:
      return { kind: "invalid" };
    case 401:
      return { kind: "unauthorized" };
    case 403:
      if (error.code === "current_password_incorrect") return { kind: "password_incorrect" };
      if (error.code === "current_password_unavailable") return { kind: "password_unavailable" };
      if (error.code === "dev_access_denied") return { kind: "access_denied" };
      return { kind: "forbidden" };
    case 404:
      return { kind: "not_found" };
    case 409:
      return error.code === "dev_credential_limit" ? { kind: "limit" } : { kind: "unknown" };
    case 429:
      return withRetryAfter("rate_limited", error.retryAfterSeconds);
    case 503:
      return withRetryAfter("busy", error.retryAfterSeconds);
    default:
      return { kind: "unknown" };
  }
}

function withRetryAfter(
  kind: "rate_limited" | "busy",
  retryAfterSeconds: number | undefined
): DevAccessFailure {
  return retryAfterSeconds === undefined ? { kind } : { kind, retryAfterSeconds };
}
