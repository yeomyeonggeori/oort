// =============================================================================
// REST client for the canonical web UI (ADR-0133 §1; originated in the MOMO-595
// P0 spike against momowebqa).
//
// Contract source of truth: server Routes + docs/api/openapi.yaml, mirrored by
// the ADR-0119 client at clients/web-legacy/src/api. Quirks preserved on purpose:
//   - message ordering authority is `seq` (gapless per channel);
//   - `?before=<seq>` reads OLDER history DESCENDING; `?after=<seq>` backfill is
//     ASCENDING (used to heal realtime gaps);
//   - UUID casing crosses the wire mixed (Swift = UPPER, PG JSON = lower):
//     compare case-insensitively (uuidEq);
//   - the realtime WS URL is authoritative from login, never derived.
//
// Token policy (M9): the access token is kept in memory only and the refresh
// token rotates single-use through POST /v1/auth/refresh. Storage, the XSS
// bound and the deferred Tauri keychain path are documented in ./session.ts,
// ported from clients/web-legacy/src/api/client.ts.
//
// Base address (P2, MOMO-604): every path below is relative to `apiBase()`,
// read at call time rather than captured at import. Same-origin stays the
// default (empty base = the existing web deployment and dev proxy); the connect
// screen can point this device at another server, and the Tauri shell must.
// =============================================================================

import { fetchWithDeadline, type HttpResponse } from "./http";
import { apiBase } from "./serverBase";
import {
  applyLogin,
  applyRotation,
  clearSession,
  getAccessToken,
  getPersistedSession,
  getRefreshToken,
  markAuthExpired,
  restoredLoginResponse,
} from "./session";
import {
  arrayField,
  bool,
  num,
  record,
  responseRecord,
  str,
  stringArrayField,
  WireShapeError,
} from "./wire";

export interface Member {
  id: string;
  workspaceId: string;
  kind: "human" | "agent";
  displayName: string;
  handle: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  member: Member;
  realtimeWebSocketUrl: string;
}

/** Workspace membership role (openapi MembershipRole). Absent on older rows. */
export type MembershipRole = "owner" | "admin" | "member" | "guest";

/**
 * Roster entry (GET /roster). Superset of `Member`: adds the agent/human split
 * fields the sidebar and timeline need to attribute a message to a real member
 * (display name, handle, owner) instead of a raw uuid prefix.
 */
export interface RosterMember {
  id: string;
  workspaceId: string;
  kind: "human" | "agent";
  status: "active" | "invited" | "suspended" | "deleted";
  displayName: string;
  handle: string;
  avatarUrl?: string;
  /** Workspace role, as the roster projection reports it. */
  role?: MembershipRole;
  channelCount: number;
  channelIds: string[];
  capabilities: string[];
  /** Agents only: the human accountable for this agent (ADR-0131). */
  ownerHumanId?: string;
  agentModel?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

function isRosterMember(value: unknown): value is RosterMember {
  const kind = str(value, "kind");
  const status = str(value, "status");
  const channelIds = arrayField(value, "channelIds");
  const capabilities = arrayField(value, "capabilities");
  return (
    str(value, "id") !== undefined &&
    str(value, "workspaceId") !== undefined &&
    (kind === "human" || kind === "agent") &&
    (status === "active" || status === "invited" || status === "suspended" || status === "deleted") &&
    str(value, "displayName") !== undefined &&
    str(value, "handle") !== undefined &&
    num(value, "channelCount") !== undefined &&
    num(value, "createdAtMs") !== undefined &&
    num(value, "updatedAtMs") !== undefined &&
    channelIds !== null && channelIds.every((id) => typeof id === "string") &&
    capabilities !== null && capabilities.every((capability) => typeof capability === "string")
  );
}

export interface Channel {
  id: string;
  workspaceId: string;
  kind: "public" | "private" | "dm";
  name?: string;
  topic?: string;
  dmKey?: string;
  memberIds?: string[];
  muted: boolean;
  archivedAtMs?: number;
}

/**
 * Read-state projection (ADR-0109 / P7). Unread is SERVER truth, never a local
 * guess: the sidebar renders a count only when this projection supplies one.
 * Wire shape is snake_case here (unlike the camelCase message/channel bodies),
 * so it is normalised on the way in.
 */
export interface ReadState {
  channelId: string;
  lastReadSeq: number;
  latestSeq: number;
  unreadCount: number;
  mentionCount: number;
}

/** Thread rollup embedded in a message page (snake_case on the wire). */
export interface ThreadRollup {
  replyCount: number;
  lastReplySeq: number;
  lastReplyAtMs: number;
}

export interface Message {
  id: string;
  channelId: string;
  rootId?: string;
  seq: number;
  hlcTs: number;
  hlcCount: number;
  authorMemberId: string;
  type:
    | "text"
    | "tool_call"
    | "tool_result"
    | "diff"
    | "artifact"
    | "approval_request"
    | "system";
  body?: string;
  state?: "sent" | "edited" | "deleted" | "failed";
  props?: Record<string, unknown>;
  createdAtMs: number;
  editedAtMs?: number;
  deletedAtMs?: number;
  /** 2-hop closure: the reply rollup rides the page, no extra round trip. */
  thread?: {
    reply_count: number;
    last_reply_seq: number;
    last_reply_at: number;
  };
}

function isMessage(value: unknown): value is Message {
  const type = str(value, "type");
  return (
    str(value, "id") !== undefined &&
    str(value, "channelId") !== undefined &&
    str(value, "authorMemberId") !== undefined &&
    num(value, "seq") !== undefined &&
    num(value, "hlcTs") !== undefined &&
    num(value, "hlcCount") !== undefined &&
    num(value, "createdAtMs") !== undefined &&
    (type === "text" || type === "tool_call" || type === "tool_result" || type === "diff" ||
      type === "artifact" || type === "approval_request" || type === "system")
  );
}

/** Normalised reply rollup, or null when the message has no replies. */
export function threadRollup(message: Message): ThreadRollup | null {
  const raw = message.thread;
  if (!raw || !raw.reply_count) return null;
  return {
    replyCount: raw.reply_count,
    lastReplySeq: raw.last_reply_seq,
    lastReplyAtMs: raw.last_reply_at,
  };
}

export interface MessagePage {
  messages: Message[];
  nextBefore?: number;
}

export interface RealtimeTokenResponse {
  token: string;
  tokenType: string;
  expiresAtMs: number;
  ttlSeconds: number;
  workspaceId: string;
  memberId: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** UUIDs cross the wire in mixed case by design; always compare this way. */
export function uuidEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// ---- Huddles: channel-bound, temporary LiveKit audio rooms -----------------
// GET  /v1/workspaces/{ws}/channels/{channel}/huddles/active
// POST /v1/workspaces/{ws}/channels/{channel}/huddles
// POST /v1/workspaces/{ws}/huddles/{huddle}/join
// POST /v1/workspaces/{ws}/huddles/{huddle}/leave
//
// The join response is the only authority for the LiveKit address. It must not
// be derived from apiBase(), the page origin, or the realtime URL (ADR-0122 and
// the same address-authority boundary as ADR-0110).

export interface HuddleParticipant {
  memberId: string;
  displayName: string;
  joinedAtMs: number;
}

export interface Huddle {
  id: string;
  workspaceId: string;
  channelId: string;
  startedBy: string;
  startedAtMs: number;
  endedAtMs?: number;
  participants: HuddleParticipant[];
}

export interface JoinedHuddle {
  huddle: Huddle;
  livekitUrl: string;
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
}

export interface LeftHuddle {
  huddle: Huddle;
  ended: boolean;
}

function huddleParticipantFromWire(value: unknown): HuddleParticipant {
  const memberId = str(value, "memberId");
  const displayName = str(value, "displayName");
  const joinedAtMs = num(value, "joinedAtMs");
  if (
    memberId === undefined ||
    displayName === undefined ||
    joinedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return { memberId, displayName, joinedAtMs };
}

/** Defensive huddle decoder shared by all four REST projections. */
export function huddleFromWire(value: unknown): Huddle {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const channelId = str(source, "channelId");
  const startedBy = str(source, "startedBy");
  const startedAtMs = num(source, "startedAtMs");
  const endedAtMs = num(source, "endedAtMs");
  const participants = arrayField(source, "participants");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    startedBy === undefined ||
    startedAtMs === undefined ||
    participants === null ||
    (source.endedAtMs !== undefined &&
      source.endedAtMs !== null &&
      typeof source.endedAtMs !== "number")
  ) {
    throw new WireShapeError();
  }
  return {
    id,
    workspaceId,
    channelId,
    startedBy,
    startedAtMs,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
    participants: participants.map(huddleParticipantFromWire),
  };
}

function huddleResponse(value: unknown): Huddle {
  const source = responseRecord(value);
  return huddleFromWire(source.huddle);
}

export async function fetchActiveHuddle(
  workspaceId: string,
  channelId: string
): Promise<Huddle | null> {
  const source = await request<Record<string, unknown>>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/huddles/active`
  );
  if (source.huddle === null) return null;
  return huddleFromWire(source.huddle);
}

export async function startHuddle(
  workspaceId: string,
  channelId: string
): Promise<Huddle> {
  const source = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/huddles`,
    { method: "POST", body: "{}" }
  );
  return huddleResponse(source);
}

export async function joinHuddle(
  workspaceId: string,
  huddleId: string
): Promise<JoinedHuddle> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/huddles/${encodeURIComponent(huddleId)}/join`,
      { method: "POST", body: "{}" }
    )
  );
  const livekitUrl = str(source, "livekitUrl");
  const token = str(source, "token");
  const expiresAtMs = num(source, "expiresAtMs");
  const ttlSeconds = num(source, "ttlSeconds");
  let livekitAddress: URL;
  try {
    livekitAddress = new URL(livekitUrl ?? "");
  } catch {
    throw new WireShapeError();
  }
  if (
    token === undefined ||
    expiresAtMs === undefined ||
    ttlSeconds === undefined ||
    !["ws:", "wss:", "http:", "https:"].includes(livekitAddress.protocol)
  ) {
    throw new WireShapeError();
  }
  return {
    huddle: huddleFromWire(source.huddle),
    livekitUrl: livekitAddress.toString(),
    token,
    expiresAtMs,
    ttlSeconds,
  };
}

export async function leaveHuddle(
  workspaceId: string,
  huddleId: string
): Promise<LeftHuddle> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/huddles/${encodeURIComponent(huddleId)}/leave`,
      { method: "POST", body: "{}" }
    )
  );
  const ended = bool(source, "ended");
  if (ended === undefined) throw new WireShapeError();
  return { huddle: huddleFromWire(source.huddle), ended };
}

/**
 * Page/Tauri-webview teardown cannot await React cleanup. A keepalive fetch is
 * the browser primitive that lets the authenticated leave finish after the
 * document starts unloading. The normal awaited leave remains the primary
 * path; this is its last-chance duplicate and the server transition is safe to
 * observe twice (the second request can answer conflict after the first won).
 */
export function leaveHuddleOnPageExit(
  workspaceId: string,
  huddleId: string
): void {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  void fetch(
    `${apiBase()}/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/huddles/${encodeURIComponent(huddleId)}/leave`,
    { method: "POST", headers, body: "{}", keepalive: true }
  ).catch(() => {
    // The document is leaving and cannot present a retry. The durable path is
    // attempted above; the next active projection heals any missed departure.
  });
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

// Every call below goes through `fetchWithDeadline` (./http.ts): a request that
// cannot reach the server fails as a `NetworkError` within seconds instead of
// pending forever, which is what made a `.local` address look like a hung app
// rather than a wrong address (MOMO-609 / G-1).
function rawRequest(
  path: string,
  init: RequestInit,
  token: string | null
): Promise<HttpResponse> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
}

function parseError(res: HttpResponse): ApiError {
  const body = res.jsonOrNull<{ error?: { message?: string } }>();
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  return new ApiError(res.status, message);
}

// ---- refresh rotation (single flight) ---------------------------------------
// The refresh token is single-use (MOMO-300): the server revokes the presented
// token as it issues the new pair. Concurrent 401s must therefore funnel into
// ONE rotation, because a second concurrent call would present an
// already-revoked token and end the session. Cross-TAB races stay possible
// while the token lives in localStorage; see ./session.ts.

let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      const res = await rawRequest(
        "/v1/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken }) },
        null
      );
      if (!res.ok) {
        markAuthExpired();
        return false;
      }
      const pair = refreshResponseFromWire(res.json<unknown>());
      applyRotation(pair.accessToken, pair.refreshToken);
      return true;
    } catch {
      // Offline, unreachable server, or a blown deadline: the caller keeps
      // rendering cached content (P15) and the session is not declared dead,
      // because nothing answered to say it is.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Authenticated request. On 401 it attempts exactly one rotation and retries
 * once; a 401 that survives the rotation ends the session. `init.body` is
 * always a string here, so replaying it on the retry is safe.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, init, getAccessToken());
  if (res.status === 401 && getRefreshToken()) {
    if (await refreshSession()) {
      res = await rawRequest(path, init, getAccessToken());
    }
  }
  if (res.status === 401) markAuthExpired();
  if (!res.ok) throw parseError(res);
  return responseRecord(res.json<unknown>()) as T;
}

function loginResponseFromWire(value: unknown): LoginResponse {
  const source = responseRecord(value);
  const member = record(source.member);
  if (
    member === null ||
    typeof source.accessToken !== "string" ||
    typeof source.refreshToken !== "string" ||
    typeof source.realtimeWebSocketUrl !== "string" ||
    typeof member.id !== "string" ||
    typeof member.workspaceId !== "string" ||
    (member.kind !== "human" && member.kind !== "agent") ||
    typeof member.displayName !== "string" ||
    typeof member.handle !== "string"
  ) {
    throw new WireShapeError();
  }
  return {
    accessToken: source.accessToken,
    refreshToken: source.refreshToken,
    realtimeWebSocketUrl: source.realtimeWebSocketUrl,
    member: {
      id: member.id,
      workspaceId: member.workspaceId,
      kind: member.kind,
      displayName: member.displayName,
      handle: member.handle,
    },
  };
}

function refreshResponseFromWire(value: unknown): RefreshResponse {
  const source = responseRecord(value);
  if (typeof source.accessToken !== "string" || typeof source.refreshToken !== "string") {
    throw new WireShapeError();
  }
  return { accessToken: source.accessToken, refreshToken: source.refreshToken };
}

export async function login(
  email: string,
  password: string,
  workspace?: string
): Promise<LoginResponse> {
  const body: Record<string, string> = { email, password };
  if (workspace && workspace.trim()) body.workspace = workspace.trim();
  const res = await rawRequest(
    "/v1/auth/login",
    { method: "POST", body: JSON.stringify(body) },
    null
  );
  if (!res.ok) throw parseError(res);
  const loginResponse = loginResponseFromWire(res.json<unknown>());
  applyLogin(loginResponse);
  return loginResponse;
}

// ---- invite self-signup (POST /v1/join) -------------------------------------
// Public route, mounted outside AuthMiddleware: the invite code IS the only
// credential, and it leaves the client only inside this request body. Success
// returns a full session token pair (openapi.yaml JoinResponse), so applying it
// here is the spec'd join-login path, not an invented auto-login.

/** Display name from the email local part, same derivation as the mac client. */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(".")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Handle from the email local part: a-z, 0-9 and hyphen, never empty. */
export function handleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? email).toLowerCase();
  const mapped = Array.from(local)
    .map((ch) => (/[a-z0-9-]/.test(ch) ? ch : "-"))
    .join("");
  const trimmed = mapped.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed === "" ? "oort-user" : trimmed;
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Redeem an invite code and land in the workspace it belongs to. The person
 * supplies only an email and a password: display name and handle are derived
 * from the email exactly as the mac chooser derives them, so the same person
 * joining from either client gets the same identity.
 */
export async function joinWithInvite(
  code: string,
  email: string,
  password: string
): Promise<LoginResponse> {
  const trimmedEmail = email.trim();
  const res = await rawRequest(
    "/v1/join",
    {
      method: "POST",
      body: JSON.stringify({
        code: code.trim(),
        email: trimmedEmail,
        displayName: displayNameFromEmail(trimmedEmail),
        handle: handleFromEmail(trimmedEmail),
        password,
        timeZone: browserTimeZone(),
      }),
    },
    null
  );
  if (!res.ok) throw parseError(res);
  const joinResponse = loginResponseFromWire(res.json<unknown>());
  applyLogin(joinResponse);
  return joinResponse;
}

/**
 * Resume a stored session after a reload or a webview restart (M9). The access
 * token was never persisted, so resuming IS one refresh rotation; identity and
 * the websocket address come from the stored login response.
 *
 * Returns null when there is nothing to resume or the stored refresh token is
 * dead, and wipes local state in that case so the login screen is not shown
 * beside a token that still looks valid.
 */
export async function restoreSession(): Promise<LoginResponse | null> {
  if (!getPersistedSession()) return null;
  const rotated = await refreshSession();
  const persisted = getPersistedSession();
  const token = getAccessToken();
  if (!rotated || !persisted || !token) {
    clearSession();
    return null;
  }
  return restoredLoginResponse(persisted, token);
}

/**
 * Log out completely. The local wipe happens FIRST and unconditionally, so a
 * slow or failing network can never leave a usable token on the device; the
 * server revocation then runs with the captured pair as a best effort.
 */
export async function logout(): Promise<void> {
  const access = getAccessToken();
  const refresh = getRefreshToken();
  clearSession();
  if (!access) return; // nothing the server will accept a revocation for
  const revoke = (accessToken: string, refreshToken: string | null) =>
    rawRequest(
      "/v1/auth/logout",
      {
        method: "POST",
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      },
      accessToken
    );
  try {
    const res = await revoke(access, refresh);
    if (res.status === 401 && refresh) {
      // The access token expired before the server revoked anything, while the
      // refresh token is alive for 30 days. Rotate that pair once and revoke
      // the result, otherwise the session stays valid on the server. The store
      // is already wiped, so this rotation is carried by locals only.
      const rotated = await rawRequest(
        "/v1/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken: refresh }) },
        null
      );
      if (rotated.ok) {
        const pair = refreshResponseFromWire(rotated.json<unknown>());
        await revoke(pair.accessToken, pair.refreshToken);
      }
    }
  } catch {
    // A network failure must not trap the user inside the session; the local
    // wipe above already happened and the tokens expire on their own. With a
    // deadline on every call this now also ENDS: before, a logout aimed at an
    // unreachable server left a promise pending for the life of the app.
  }
}

export async function fetchRealtimeToken(): Promise<string> {
  const res = await request<RealtimeTokenResponse>("/v1/auth/realtime-token", {
    method: "POST",
  });
  return res.token;
}

export async function listChannels(workspaceId: string): Promise<Channel[]> {
  const res = await request<{ channels: Channel[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`
  );
  return arrayField<Channel>(res, "channels") ?? [];
}

/** Channel membership row, as the write endpoints return it. */
export interface ChannelMembership {
  id: string;
  workspaceId: string;
  channelId: string;
  memberId: string;
  role: MembershipRole;
  joinedAtMs: number;
  leftAtMs?: number;
}

/**
 * Result of POST /v1/workspaces/{ws}/channels (server CreateChannelResponse).
 * The creator is inserted as `owner` of the new channel in the same
 * transaction, so the caller is already a member when this resolves.
 */
export interface CreatedChannel {
  channel: Channel;
  creatorMembership: ChannelMembership;
}

export interface CreateChannelInput {
  kind: "public" | "private";
  /**
   * Already trimmed and lowercased by the caller. The server normalises again
   * and rejects anything outside `[a-z0-9]` plus hyphen/underscore, so the
   * client applies the same rule up front instead of showing an English 400.
   */
  name: string;
  /** Optional; omitted rather than sent empty, which the server reads as null. */
  topic?: string;
}

/**
 * Create a channel. Requires workspace owner/admin (ChannelRoutes guards it),
 * answers 409 when an unarchived non-DM channel already carries the name
 * case-insensitively, and 201 with the created row otherwise.
 */
export function createChannel(
  workspaceId: string,
  input: CreateChannelInput
): Promise<CreatedChannel> {
  return request<CreatedChannel>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

/**
 * Result of POST /v1/workspaces/{ws}/dms. The call is idempotent per participant
 * pair: it creates the channel on the first call (201) and returns the existing
 * one afterwards (200). `created` tells the two apart; `channel.id` is the
 * SERVER's answer to "which DM is this", so a client never has to match a pair
 * against its own channel list to find out.
 */
export interface OpenedDirectMessage {
  channel: Channel;
  created: boolean;
}

/** Open (or reuse) the 1:1 DM channel with another member. */
export function openDirectMessage(
  workspaceId: string,
  memberId: string
): Promise<OpenedDirectMessage> {
  return request<OpenedDirectMessage>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/dms`,
    { method: "POST", body: JSON.stringify({ memberId }) }
  );
}

/** Active workspace members, humans and agents alike (agents are members). */
export async function fetchRoster(workspaceId: string): Promise<RosterMember[]> {
  const res = await request<{ members: RosterMember[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/roster`
  );
  return (arrayField(res, "members") ?? []).filter(isRosterMember);
}

// ---- 에이전트 만들기 · 채널 배치 -------------------------------------------
// POST   /v1/workspaces/{ws}/agents                        (AgentRoutes.create)
// POST   /v1/workspaces/{ws}/channels/{ch}/members         (ChannelRoutes.addMember)
// DELETE /v1/workspaces/{ws}/channels/{ch}/members/{member} (ChannelRoutes.removeMember)
//
// There is no bot to install (ADR-0004, invariant #5): creating an agent creates
// a `member` with `kind='agent'`, which is why the answer below is a roster row
// and not an installation receipt. Creation stops at the identity boundary on
// purpose, so the agent is mentionable only once it is added to a channel; that
// second half is the membership pair, and it is why the two live together here.
//
// No credential crosses this surface in either direction. The create body is
// closed-world server side and every key whose normalized spelling looks like a
// credential is refused at any depth, so a client that tries to be helpful by
// forwarding a key gets a 400 rather than a stored secret.

/** `POST …/agents` body (server `CreateAgentRequest`, camelCase on the wire). */
export interface CreateAgentInput {
  displayName: string;
  handle: string;
  model: string;
  baseUrl: string;
  /** Blank means absent: the server stores `null`, never an empty section. */
  systemPrompt?: string;
  /** The human accountable for this agent. Defaults to the caller. */
  ownerHumanId?: string;
  /** Optional initial profile. `instructions` is the only field this form sets. */
  profile?: { instructions: string };
}

/** What `POST …/agents` answers with (server `AgentMemberDTO`). */
export interface CreatedAgent {
  id: string;
  handle: string;
  displayName: string;
}

export function createdAgentFromWire(value: unknown): CreatedAgent {
  const source = responseRecord(value);
  const agent = record(source.agent);
  const id = agent === null ? undefined : str(agent, "id");
  const handle = agent === null ? undefined : str(agent, "handle");
  const displayName = agent === null ? undefined : str(agent, "displayName");
  if (id === undefined || handle === undefined || displayName === undefined) {
    throw new WireShapeError();
  }
  return { id: id.toLowerCase(), handle, displayName };
}

/**
 * Create an agent member. Requires a HUMAN workspace owner/admin: minting an
 * identity that can post into channels is not a member-level act, so the server
 * answers 403 for anyone else and 409 when the handle is taken.
 */
export async function createAgent(
  workspaceId: string,
  input: CreateAgentInput
): Promise<CreatedAgent> {
  return createdAgentFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`,
      { method: "POST", body: JSON.stringify(input) }
    )
  );
}

export function channelMembershipFromWire(value: unknown): ChannelMembership {
  const source = responseRecord(value);
  const membership = record(source.membership);
  if (membership === null) throw new WireShapeError();
  const id = str(membership, "id");
  const workspaceId = str(membership, "workspaceId");
  const channelId = str(membership, "channelId");
  const memberId = str(membership, "memberId");
  const role = str(membership, "role");
  const joinedAtMs = num(membership, "joinedAtMs");
  const leftAtMs = num(membership, "leftAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    memberId === undefined ||
    joinedAtMs === undefined ||
    (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest")
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    memberId: memberId.toLowerCase(),
    role,
    joinedAtMs,
    ...(leftAtMs === undefined ? {} : { leftAtMs }),
  };
}

/**
 * Put a member (person or agent) into a channel. Upsert by `(channel, member)`:
 * re-adding someone who left clears `left_at` rather than creating a second row,
 * so the button is safe to press twice. Requires workspace owner/admin, and the
 * target channel must be a public/private channel that is not archived, which is
 * why a DM answers 404 rather than silently succeeding.
 */
export async function addChannelMember(
  workspaceId: string,
  channelId: string,
  memberId: string,
  role: MembershipRole = "member"
): Promise<ChannelMembership> {
  return channelMembershipFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/members`,
      { method: "POST", body: JSON.stringify({ memberId, role }) }
    )
  );
}

/**
 * Take a member out of a channel. The row is marked `left_at`, not deleted, so
 * the history that member wrote keeps its author. 404 means there was no active
 * membership to end.
 */
export async function removeChannelMember(
  workspaceId: string,
  channelId: string,
  memberId: string
): Promise<ChannelMembership> {
  return channelMembershipFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(
        memberId
      )}`,
      { method: "DELETE" }
    )
  );
}

// ---- Plugin registry: catalog, manifest and caller-owned grants ------------
//
// `PluginRoutes` deliberately separates these projections. The catalog carries
// only installation state plus the calling member's effective tool policy;
// declared scopes and publisher metadata stay in the manifest detail. Keep
// that split here instead of inferring a grant from an installation.

export interface PluginCatalogItem {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  official: boolean;
  recommended: boolean;
  egressDomains: string[];
  recommendedFor: string[];
  installed: boolean;
  enabled: boolean;
  termsURL?: string;
  privacyPolicyURL?: string;
  iconText?: string;
}

export interface PluginPolicyTool {
  name: string;
  risk: string;
  approvalTier: string;
}

export interface PluginCatalog {
  plugins: PluginCatalogItem[];
  /** Present only for scopes this calling member currently has. */
  toolsByPlugin: Map<string, PluginPolicyTool[]>;
}

export interface PluginManifestTool {
  name: string;
  description?: string;
  scopes: string[];
  risk?: string;
  approvalTier?: string;
}

export interface PluginDetail {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  official: boolean;
  egressDomains: string[];
  recommendedFor: string[];
  installed: boolean;
  enabled: boolean;
  termsURL?: string;
  privacyPolicyURL?: string;
  iconText?: string;
  publisherName?: string;
  publisherVerified?: boolean;
  license?: string;
  provenanceURL?: string;
  tools: PluginManifestTool[];
}

export interface PluginMutation {
  pluginId: string;
  memberId?: string;
  scope?: string;
  status: string;
  enabled: boolean;
  capabilities: string[];
}

/** Manifest display links are navigation only, and must never become script URLs. */
function httpsURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function requiredPluginItem(value: unknown): PluginCatalogItem | null {
  const pluginId = str(value, "pluginId");
  const name = str(value, "name");
  const version = str(value, "version");
  const description = str(value, "description");
  const official = bool(value, "official");
  const recommended = bool(value, "recommended");
  const egressDomains = stringArrayField(value, "egressDomains");
  const recommendedFor = stringArrayField(value, "recommendedFor");
  const installed = bool(value, "installed");
  const enabled = bool(value, "enabled");
  if (
    pluginId === undefined || name === undefined || version === undefined ||
    description === undefined || official === undefined || recommended === undefined ||
    egressDomains === null || recommendedFor === null || installed === undefined ||
    enabled === undefined
  ) return null;
  return {
    pluginId, name, version, description, official, recommended,
    egressDomains, recommendedFor, installed, enabled,
    termsURL: httpsURL(str(value, "termsURL")),
    privacyPolicyURL: httpsURL(str(value, "privacyPolicyURL")),
    iconText: str(value, "iconText"),
  };
}

function policyTool(value: unknown): PluginPolicyTool | null {
  const name = str(value, "name");
  const risk = str(value, "risk");
  const approvalTier = str(value, "approvalTier");
  return name === undefined || risk === undefined || approvalTier === undefined
    ? null
    : { name, risk, approvalTier };
}

/** Exported for the wire contract test; every field read uses lib/wire helpers. */
export function pluginCatalogFromWire(value: unknown): PluginCatalog {
  const root = responseRecord(value);
  const plugins = arrayField(root, "plugins");
  if (plugins === null) throw new WireShapeError();
  const parsedPlugins = plugins.map(requiredPluginItem);
  if (parsedPlugins.some((plugin) => plugin === null)) throw new WireShapeError();

  const toolsByPlugin = new Map<string, PluginPolicyTool[]>();
  const policy = record(root.toolPolicy);
  const descriptors = policy === null ? null : arrayField(policy, "plugins");
  if (descriptors !== null) {
    for (const descriptor of descriptors) {
      const pluginId = str(descriptor, "pluginId");
      const tools = arrayField(descriptor, "tools");
      if (pluginId === undefined || tools === null) continue;
      const parsedTools = tools.map(policyTool);
      if (parsedTools.some((tool) => tool === null)) continue;
      toolsByPlugin.set(pluginId, parsedTools as PluginPolicyTool[]);
    }
  }
  return { plugins: parsedPlugins as PluginCatalogItem[], toolsByPlugin };
}

function manifestTool(value: unknown, approvalTiers: Record<string, unknown> | null): PluginManifestTool | null {
  const name = str(value, "name");
  const scopes = stringArrayField(value, "scopes");
  if (name === undefined || scopes === null) return null;
  const approvalTier = approvalTiers ? approvalTiers[name] : undefined;
  return {
    name,
    description: str(value, "description"),
    scopes,
    risk: str(value, "risk"),
    approvalTier: typeof approvalTier === "string" ? approvalTier : undefined,
  };
}

/** Parse only the manifest fields the product is allowed to display. */
export function pluginDetailFromWire(value: unknown): PluginDetail {
  const root = responseRecord(value);
  const detail = record(root.plugin);
  // Detail intentionally omits the catalog-only `recommended` bit. Supply no
  // meaning beyond a type placeholder while sharing the required field check.
  const item = detail === null ? null : requiredPluginItem({ ...detail, recommended: false });
  const manifest = record(detail?.manifest);
  if (item === null || manifest === null) throw new WireShapeError();
  const plugin = record(manifest.plugin);
  const publisher = record(plugin?.publisher);
  const license = record(plugin?.license);
  const provenance = record(plugin?.provenance);
  const mcp = record(manifest.mcp);
  const momo = record(manifest.momo);
  const tools = mcp === null ? null : arrayField(mcp, "tools");
  if (tools === null) throw new WireShapeError();
  const approvalTiers = record(momo?.approvalTier);
  const parsedTools = tools.map((tool) => manifestTool(tool, approvalTiers));
  if (parsedTools.some((tool) => tool === null)) throw new WireShapeError();
  return {
    ...item,
    publisherName: str(publisher, "name"),
    publisherVerified: bool(publisher, "verified"),
    license: str(license, "spdx"),
    provenanceURL: httpsURL(str(provenance, "sourceURL")),
    tools: parsedTools as PluginManifestTool[],
  };
}

function pluginMutationFromWire(value: unknown): PluginMutation {
  const root = responseRecord(value);
  const pluginId = str(root, "pluginId");
  const status = str(root, "status");
  const enabled = bool(root, "enabled");
  const capabilities = stringArrayField(root, "capabilities");
  if (pluginId === undefined || status === undefined || enabled === undefined || capabilities === null) {
    throw new WireShapeError();
  }
  return {
    pluginId,
    status,
    enabled,
    capabilities,
    memberId: str(root, "memberId"),
    scope: str(root, "scope"),
  };
}

/** GET /plugins: catalog plus this caller's effective, credential-free policy. */
export async function listPlugins(workspaceId: string): Promise<PluginCatalog> {
  return pluginCatalogFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins`
  ));
}

/** GET /plugins/:plugin: registry manifest, never a credential. */
export async function getPlugin(workspaceId: string, pluginId: string): Promise<PluginDetail> {
  return pluginDetailFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}`
  ));
}

export async function installPlugin(workspaceId: string, pluginId: string): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/install`,
    { method: "POST", body: JSON.stringify({ enabled: true }) }
  ));
}

export async function revokePluginInstall(workspaceId: string, pluginId: string): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/install`,
    { method: "DELETE" }
  ));
}

export async function grantPluginScope(
  workspaceId: string,
  pluginId: string,
  scope: string
): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/grants`,
    { method: "POST", body: JSON.stringify({ scope }) }
  ));
}

export async function revokePluginScope(
  workspaceId: string,
  pluginId: string,
  scope: string
): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/grants/${encodeURIComponent(scope)}`,
    { method: "DELETE" }
  ));
}

interface WireReadState {
  channel_id: string;
  last_read_seq: number;
  latest_seq: number;
  unread_count: number;
  mention_count: number;
}

function toReadState(wire: WireReadState): ReadState {
  return {
    channelId: wire.channel_id,
    lastReadSeq: wire.last_read_seq,
    latestSeq: wire.latest_seq,
    unreadCount: wire.unread_count,
    mentionCount: wire.mention_count,
  };
}

/** Bulk read-state, one entry per membership (P7 server single truth). */
export async function fetchReadStates(
  workspaceId: string
): Promise<ReadState[]> {
  const res = await request<{ read_states: WireReadState[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`
  );
  const states = arrayField(res, "read_states");
  return states === null ? [] : states.filter((state): state is WireReadState => {
    return typeof state === "object" && state !== null &&
      typeof (state as Record<string, unknown>).channel_id === "string" &&
      typeof (state as Record<string, unknown>).last_read_seq === "number" &&
      typeof (state as Record<string, unknown>).latest_seq === "number" &&
      typeof (state as Record<string, unknown>).unread_count === "number" &&
      typeof (state as Record<string, unknown>).mention_count === "number";
  }).map(toReadState);
}

/**
 * Advance the caller's read cursor. The server clamps to
 * `max(current, min(requested, latestSeq))`, so it can never regress.
 */
export async function updateReadState(
  workspaceId: string,
  channelId: string,
  lastReadSeq: number
): Promise<ReadState> {
  const res = await request<WireReadState>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/read-state`,
    { method: "PUT", body: JSON.stringify({ last_read_seq: lastReadSeq }) }
  );
  return toReadState(res);
}

export interface MessageQuery {
  limit?: number;
  /** Older history: seq strictly BELOW this (descending page). */
  before?: number;
  /** Realtime-gap backfill: seq strictly ABOVE this (ascending page). */
  after?: number;
}

export async function fetchMessages(
  workspaceId: string,
  channelId: string,
  query: MessageQuery = {}
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.after !== undefined) params.set("after", String(query.after));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const page = await request<MessagePage>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
  );
  const messages = arrayField<Message>(page, "messages");
  return { ...page, messages: (messages ?? []).filter(isMessage) };
}

// ---- 메시지 검색 (goal B12 H5) ----------------------------------------------
// GET /v1/workspaces/{ws}/search/messages?q=&limit=&cursor=
//
// 서버가 **이미** 싣고 있는 경로다(routes::search::messages, 도메인
// crates/momo-messaging/src/search.rs). 아래 모양은 그 두 파일에서 읽은 것이고
// 추측이 없다:
//
//   q       공백을 걷어낸 뒤 2자 미만이면 서버가 400. 그래서 이 클라이언트도
//           2자 미만은 아예 보내지 않는다(features/search/searchModel.ts).
//   limit   기본 20, 서버가 1..50으로 clamp한다.
//   cursor  불투명 문자열. 깨진 커서는 400이지 1페이지로 조용히 되감기지 않는다.
//
// 응답은 `{ hits: [...], nextCursor?: string }`이고 **마지막 페이지는
// `nextCursor` 키 자체가 없다**(null이 아니다). 서버 테스트가 그 사실을 못으로
// 박아 두었다(`a_last_page_omits_the_cursor_key`), 그래서 여기서도 `undefined`로
// 읽는다.
//
// 범위는 워크스페이스 전체지만 **호출자가 떠나지 않은 채널로 JOIN이 한정**된다.
// 즉 검색은 비공개 채널을 여는 구멍이 될 수 없다. 결과 없음 문구는 그 사실을
// 말해야 한다: 사용자는 "그런 말이 없었다"와 "내가 속하지 않은 채널의 말은 안
// 보인다"를 구분할 수 있어야 한다.
//
// 매칭은 pg_trgm ILIKE 부분일치라 단어 안쪽과 한국어에도 걸리고, `%`/`_`는
// 와일드카드가 아니라 **글자 그대로** 찾는다(서버가 이스케이프한다).

/** 서버 기본 페이지 크기. 서버가 1..50으로 clamp한다. */
export const SEARCH_LIMIT_DEFAULT = 20;

/** 결과 한 건 (서버 `WorkspaceMessageSearchHitDto`). */
export interface MessageSearchHit {
  channelId: string;
  messageId: string;
  seq: number;
  authorMemberId: string;
  /** 에포크 밀리초. 커서는 마이크로초를 들지만 와이어는 늘 ms다. */
  createdAtMs: number;
  /** 첫 일치 주변으로 서버가 잘라 준 본문 조각. */
  snippet: string;
  /** `snippet` 안에서 일치가 시작하는 0-기준 위치. */
  matchOffset: number;
}

export interface MessageSearchPage {
  hits: MessageSearchHit[];
  /** 다음 페이지가 없으면 서버가 이 키를 아예 빼고 보낸다. */
  nextCursor?: string;
}

function searchHitFromWire(value: unknown): MessageSearchHit | null {
  const channelId = str(value, "channelId");
  const messageId = str(value, "messageId");
  const authorMemberId = str(value, "authorMemberId");
  const seq = num(value, "seq");
  const createdAtMs = num(value, "createdAtMs");
  const snippet = str(value, "snippet");
  const matchOffset = num(value, "matchOffset");
  if (
    channelId === undefined ||
    messageId === undefined ||
    authorMemberId === undefined ||
    seq === undefined ||
    createdAtMs === undefined ||
    snippet === undefined
  ) {
    return null;
  }
  return {
    channelId: channelId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    authorMemberId: authorMemberId.toLowerCase(),
    seq,
    createdAtMs,
    snippet,
    // 위치를 못 읽으면 강조만 포기한다. 결과 한 건을 통째로 버릴 이유는 아니다.
    matchOffset: matchOffset ?? 0,
  };
}

export async function searchMessages(
  workspaceId: string,
  query: string,
  options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}
): Promise<MessageSearchPage> {
  const params = new URLSearchParams({ q: query });
  params.set("limit", String(options.limit ?? SEARCH_LIMIT_DEFAULT));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/search/messages?${params.toString()}`,
    options.signal === undefined ? {} : { signal: options.signal }
  );
  const source = responseRecord(res);
  const hits = arrayField<unknown>(source, "hits") ?? [];
  const nextCursor = str(source, "nextCursor");
  return {
    hits: hits
      .map(searchHitFromWire)
      .filter((hit): hit is MessageSearchHit => hit !== null),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/**
 * One oldest-first page of thread replies (ascending channel seq). `limit` is
 * clamped to 1...200 by the server; the work session panel asks for the ceiling
 * because a session thread is an event log, not a conversation.
 */
export function fetchThreadReplies(
  workspaceId: string,
  channelId: string,
  rootId: string,
  cursor?: number,
  limit?: number
): Promise<{ messages: Message[]; nextCursor?: number }> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set("cursor", String(cursor));
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ messages: Message[]; nextCursor?: number }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
      rootId
    )}/replies${suffix}`
  );
}

/**
 * Per-request model/effort override (ADR-0134 D1 `routing`).
 *
 * Contract of record for THIS surface is the mention tier, MOMO-625: it adds
 * exactly one key to `SendMessageRequest.allowedKeys` and makes that request
 * closed-world in the same commit, so a server that knows the key answers 400
 * for a bad value and a server that does not know it drops the key in silence.
 * Which of the two is on the other end is not guessable from a GET, so the
 * composer never sends this block until `probeSendRouting` has proved the
 * surface (features/routing/capability.ts).
 *
 * Optional on the wire and omitted entirely when nothing is overridden, so a
 * send that inherits carries the exact body it carried before this ticket.
 */
export interface RequestRouting {
  model?: string;
  effort?: string;
}

export function sendMessage(
  workspaceId: string,
  channelId: string,
  clientMsgId: string,
  bodyText: string,
  routing?: RequestRouting
): Promise<Message> {
  // The key is absent, not null, when there is no override: the server's send
  // path is closed-world, so a key it does not know is a 400 whether its value
  // is meaningful or not.
  const body: Record<string, unknown> = {
    clientMsgId,
    type: "text",
    body: bodyText,
  };
  if (routing) body.routing = routing;
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

/**
 * Reply inside a thread. The SAME write path as `sendMessage` with `rootId`
 * set (server `SendMessageRequest.rootId`), which is exactly how the mac client
 * shares a work excerpt into a session thread (ChatViewModel.shareWorkExcerpt
 * calls sendReply with the session's root message). There is no dedicated
 * excerpt endpoint on the server, and inventing one client-side would be a
 * second write path into the same ledger.
 */
export function sendThreadReply(
  workspaceId: string,
  channelId: string,
  rootId: string,
  clientMsgId: string,
  bodyText: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ clientMsgId, rootId, type: "text", body: bodyText }),
    }
  );
}

// ---- Message actions (B11): edit, delete, react ----------------------------
// PATCH  /v1/workspaces/{ws}/messages/{id}
// DELETE /v1/workspaces/{ws}/messages/{id}
// PUT    /v1/workspaces/{ws}/messages/{id}/reactions/{emoji}
// DELETE /v1/workspaces/{ws}/messages/{id}/reactions/{emoji}
// GET    /v1/workspaces/{ws}/channels/{ch}/reactions
//
// Note the shape of the first four: **message-scoped, not channel-scoped**. A
// message id is already unique inside a tenant and its channel is a fact about
// the row, not something the caller asserts — so none of these takes a channel,
// and no client can move a message by naming the wrong one.

/**
 * Rewrite one's own message. The server is the authority on who may — it answers
 * 403 for anyone but the author — and the action bar's visibility rule is only
 * an affordance layered on top of that.
 *
 * Answers with the updated message so the caller replaces the row with what was
 * actually stored, rather than with what it hoped the edit did.
 */
export function editMessage(
  workspaceId: string,
  messageId: string,
  bodyText: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: JSON.stringify({ body: bodyText }) }
  );
}

/**
 * Soft-delete one's own message. Answers with the **tombstone** (`state:
 * "deleted"`, no body), not 204: the timeline replaces the row instead of
 * dropping it, because a message that silently vanishes leaves what reads as a
 * hole in `seq`.
 */
export function deleteMessage(
  workspaceId: string,
  messageId: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" }
  );
}

/** One member's reaction moving one way (server `ReactionDeltaDto`). */
export interface ReactionDelta {
  action: "added" | "removed";
  messageId: string;
  memberId: string;
  emoji: string;
}

/**
 * Toggle one reaction. Idempotent server-side: a duplicate add and a removal of
 * something that was never there both answer 200 having changed nothing, so a
 * double-tap is harmless rather than an error the UI has to explain away.
 *
 * The emoji is a path segment, percent-encoded here — `encodeURIComponent`
 * covers both unicode emoji and the `:shortcode:` form the schema allows.
 */
export function setReaction(
  workspaceId: string,
  messageId: string,
  emoji: string,
  action: "added" | "removed"
): Promise<ReactionDelta> {
  return request<ReactionDelta>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(
      messageId
    )}/reactions/${encodeURIComponent(emoji)}`,
    { method: action === "added" ? "PUT" : "DELETE" }
  );
}

/**
 * The cold-load reaction map for a channel: `message id -> emoji -> member ids`.
 *
 * Encoded as the mapping itself with no wrapper key (the server's
 * `ReactionSnapshotDTO` uses a single-value container), which is why this is the
 * record and not `{ snapshot: … }`.
 *
 * **Ids arrive UPPERCASE here** and lowercase from the message projections — the
 * same mixed-case wire `uuidEq` exists for. `normalizeReactionSnapshot`
 * (`features/timeline/reactions.ts`) is the one place that case is folded.
 */
export type ReactionSnapshotWire = Record<string, Record<string, string[]>>;

export function fetchReactionSnapshot(
  workspaceId: string,
  channelId: string
): Promise<ReactionSnapshotWire> {
  return request<ReactionSnapshotWire>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(
      channelId
    )}/reactions`
  );
}

// ---- Work sessions: the ADR-0114 session ledger (AX-3 / MOMO-618) ----------
// GET   /v1/workspaces/{ws}/work-sessions[?active=1]   (WorkSessionRoutes.list)
// PATCH /v1/workspaces/{ws}/work-sessions/{session}     (owner ends it)
//
// camelCase on the wire, ids UPPERCASE (Swift `uuidString`) while the ids
// inside a projected ACP event payload are lowercase Postgres JSON: measured
// against momowebqa on 2026-07-26, which is why every comparison here folds
// case through `uuidEq`.
//
// The list is workspace-wide and already scoped to the caller's channel
// memberships server-side (it JOINs `membership`), so a channel filter is a
// presentation choice, never an access control.

/**
 * `idle` still belongs to the live host and keeps its PTY attached. It is not
 * an ended session: `exitCode` is the last tool result across every state.
 */
export type WorkSessionStatusWire = "running" | "idle" | "orphaned" | "ended";

export interface WorkSession {
  id: string;
  workspaceId: string;
  channelId: string;
  /** The HUMAN who owns the session; only they may end it. */
  memberId: string;
  hostId: string;
  /** The channel card this session hangs under; its thread carries the events. */
  rootMessageId: string;
  tool: string;
  label: string;
  status: WorkSessionStatusWire;
  observation: "open" | "owner_only";
  observerGrantCount: number;
  remoteAttachAvailable: boolean;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  endReason?: string;
  resumedFromSessionId?: string;
}

export async function fetchWorkSessions(
  workspaceId: string,
  activeOnly = false
): Promise<WorkSession[]> {
  const suffix = activeOnly ? "?active=1" : "";
  const res = await request<{ workSessions: WorkSession[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions${suffix}`
  );
  return res.workSessions;
}

/**
 * End a session. This is the PROCESS side of the ledger (the host stops holding
 * it), not "stop the current turn": the server has no turn-scoped stop for a
 * work session, and the two are deliberately different words in the UI.
 */
export async function endWorkSession(
  workspaceId: string,
  sessionId: string
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ status: "ended" }) }
  );
  return res.workSession;
}

/** Continue an orphaned git lineage on an explicitly chosen eligible host. */
export async function resumeWorkSession(
  workspaceId: string,
  sessionId: string,
  targetHostId: string
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ targetHostId }),
    }
  );
  return res.workSession;
}

/**
 * Who may watch this session's terminal (ADR-0126 D1). `open` is the default and
 * matches the fact that the session thread is already public in the channel;
 * `owner_only` is the owner closing it, which also revokes every observer
 * capability already issued (server `updateObservation`).
 */
export async function setWorkSessionObservation(
  workspaceId: string,
  sessionId: string,
  observation: WorkSession["observation"]
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ observation }) }
  );
  return res.workSession;
}

// ---- Terminal attach capability (ADR-0126 D1 / ADR-0125 D10) ----------------
// POST /v1/workspaces/{ws}/work-sessions/{session}/terminal-attach
//
// This is a CONTROL PLANE call and nothing else. The server mints a 60 second
// opaque bearer and hands back the host's own endpoint; it carries no stream,
// no socket and no relay (TerminalAttachRoutes: "There is intentionally no
// stream, websocket, stdin, stdout, resize, or relay route in this server").
// The bytes then flow client <-> host directly, which is the invariant that
// keeps raw terminal output off momo's servers.
//
// The response is snake_case, unlike every camelCase body above; it is the
// wire shape the mac client already consumes, and renaming it here would hide
// which fields came from the server.
//
// `mode` is the D1 grade. The web client only ever asks for `observer`: a
// controller grant carries stdin/resize/kill rights this client has no code to
// use (see features/work/observerStream.ts, which cannot encode those frames).

export interface TerminalAttachGrant {
  /** The HOST's endpoint, https/wss, credential free (server-validated). */
  attach_endpoint: string;
  /** Opaque bearer, 60s TTL, validated by the host against this server. */
  capability_token: string;
  pty_id: string;
}

export async function issueObserverTerminalAttach(
  workspaceId: string,
  sessionId: string
): Promise<TerminalAttachGrant> {
  return request<TerminalAttachGrant>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/terminal-attach`,
    { method: "POST", body: JSON.stringify({ mode: "observer" }) }
  );
}

/**
 * Registered execution host (ADR-0125 D1). `type` is what decides whether the
 * ACP event relay behind a session is a verified path: `app` is the local
 * client host, everything else is a remote workd/cloud host whose normalised
 * ACP relay is still in flight (X-11 / MOMO-546), so the panel must not draw a
 * remote session's silence as "quiet".
 */
export interface WorkHost {
  id: string;
  workspaceId: string;
  scope: "member" | "workspace";
  ownerMemberId: string;
  type: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  lastSeenAtMs?: number;
  revokedAtMs?: number;
  createdAtMs: number;
  online: boolean;
}

export async function fetchWorkHosts(workspaceId: string): Promise<WorkHost[]> {
  const res = await request<{ workHosts: WorkHost[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-hosts`
  );
  return arrayField<WorkHost>(res, "workHosts") ?? [];
}

// ---- Workstreams: the goal layer over Runs (ADR-0143, WorkstreamRoutes) -----
// GET /v1/workspaces/{ws}/workstreams?status=&channelId=&sessionId=&limit=
// GET /v1/workspaces/{ws}/workstreams/{workstream}
// GET /v1/workspaces/{ws}/workstreams/{workstream}/runs
//
// A workstream is one GOAL anchored on a thread root message; a work session is
// one RUN of it. `run.memberId` is that Run's actor and is never transferred
// (D2), so the run list is the evidence that a goal outlived the person who
// started it: A's run and B's run stand side by side under one goal.
//
// THE THREE READS ARE DELIBERATELY ASYMMETRIC AND A CLIENT MUST NOT EVEN THEM
// OUT (WorkstreamRoutes "minimum exposure"): a caller outside the anchor channel
// gets ZERO rows from the list and 404 — not 403 — from the detail and the run
// list, so these reads cannot be used to probe for other people's work. Only
// `resumeWorkSession` answers 403, and only because by then the caller is acting
// on a session they were shown. `isNotFound` is exported so a surface can say
// "찾을 수 없습니다" for the first case and talk about permission only for the
// second; a UI that renders 404 as "권한이 없습니다" hands back exactly the
// existence signal the server refused.
//
// There is no write here on purpose: explicit create/split/merge is ADR-0143 P2,
// and continuing a workstream reuses the lineage resume above rather than
// inventing a second verb for the same act.

export const WORKSTREAM_STATUSES = [
  "active",
  "paused",
  "done",
  "cancelled",
] as const;

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export interface Workstream {
  id: string;
  workspaceId: string;
  channelId: string;
  /** The anchor thread. The workstream extends the thread, never replaces it. */
  rootMessageId: string;
  goal: string;
  status: WorkstreamStatus;
  /** Provenance only. Eligibility to continue is channel membership (D3). */
  createdByMemberId: string;
  createdAtMs: number;
  updatedAtMs: number;
  runCount: number;
  activeRunCount: number;
}

/**
 * One Run of a workstream. `status` stays a plain string rather than the work
 * session union: `workSessionStatus()` already answers "상태 확인 필요" for a
 * value it does not know, and a goal's whole history failing to render because
 * the ledger grew a fifth state is a worse answer than one unnamed row.
 */
export interface WorkstreamRun {
  id: string;
  memberId: string;
  hostId: string;
  tool: string;
  label: string;
  status: string;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  endReason?: string;
  /** Set when this Run continued another one — the lineage, inside one goal. */
  resumedFromSessionId?: string;
}

export interface WorkstreamRunList {
  workstreamId: string;
  runs: WorkstreamRun[];
}

export interface WorkstreamQuery {
  status?: WorkstreamStatus;
  channelId?: string;
  sessionId?: string;
  limit?: number;
}

function isWorkstreamStatus(value: string): value is WorkstreamStatus {
  return (WORKSTREAM_STATUSES as readonly string[]).includes(value);
}

export function workstreamFromWire(value: unknown): Workstream {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const channelId = str(source, "channelId");
  const rootMessageId = str(source, "rootMessageId");
  const goal = str(source, "goal");
  const status = str(source, "status");
  const createdByMemberId = str(source, "createdByMemberId");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  const runCount = num(source, "runCount");
  const activeRunCount = num(source, "activeRunCount");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    rootMessageId === undefined ||
    goal === undefined ||
    status === undefined ||
    !isWorkstreamStatus(status) ||
    createdByMemberId === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    runCount === undefined ||
    activeRunCount === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    rootMessageId: rootMessageId.toLowerCase(),
    goal,
    status,
    createdByMemberId: createdByMemberId.toLowerCase(),
    createdAtMs,
    updatedAtMs,
    runCount,
    activeRunCount,
  };
}

export function workstreamListFromWire(value: unknown): Workstream[] {
  const source = responseRecord(value);
  const workstreams = arrayField(source, "workstreams");
  if (workstreams === null) throw new WireShapeError();
  return workstreams.map(workstreamFromWire);
}

export function workstreamRunFromWire(value: unknown): WorkstreamRun {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const memberId = str(source, "memberId");
  const hostId = str(source, "hostId");
  const tool = str(source, "tool");
  const label = str(source, "label");
  const status = str(source, "status");
  const startedAtMs = num(source, "startedAtMs");
  if (
    id === undefined ||
    memberId === undefined ||
    hostId === undefined ||
    tool === undefined ||
    label === undefined ||
    status === undefined ||
    startedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  const endedAtMs = optionalFiniteNumber(source, "endedAtMs");
  const exitCode = optionalFiniteNumber(source, "exitCode");
  const endReason = optionalString(source, "endReason");
  const resumedFromSessionId = optionalString(source, "resumedFromSessionId");
  return {
    id: id.toLowerCase(),
    memberId: memberId.toLowerCase(),
    hostId: hostId.toLowerCase(),
    tool,
    label,
    status,
    startedAtMs,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(endReason === undefined ? {} : { endReason }),
    ...(resumedFromSessionId === undefined
      ? {}
      : { resumedFromSessionId: resumedFromSessionId.toLowerCase() }),
  };
}

export function workstreamRunListFromWire(value: unknown): WorkstreamRunList {
  const source = responseRecord(value);
  const workstreamId = str(source, "workstreamId");
  const runs = arrayField(source, "runs");
  if (workstreamId === undefined || runs === null) throw new WireShapeError();
  return {
    workstreamId: workstreamId.toLowerCase(),
    runs: runs.map(workstreamRunFromWire),
  };
}

export async function fetchWorkstreams(
  workspaceId: string,
  query: WorkstreamQuery = {}
): Promise<Workstream[]> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.channelId !== undefined) {
    params.set("channelId", query.channelId.toLowerCase());
  }
  if (query.sessionId !== undefined) {
    params.set("sessionId", query.sessionId.toLowerCase());
  }
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  return workstreamListFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId.toLowerCase())}/workstreams${
        search === "" ? "" : `?${search}`
      }`
    )
  );
}

export async function fetchWorkstream(
  workspaceId: string,
  workstreamId: string
): Promise<Workstream> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/workstreams/${encodeURIComponent(workstreamId.toLowerCase())}`
    )
  );
  return workstreamFromWire(source.workstream);
}

export async function fetchWorkstreamRuns(
  workspaceId: string,
  workstreamId: string
): Promise<WorkstreamRunList> {
  return workstreamRunListFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/workstreams/${encodeURIComponent(workstreamId.toLowerCase())}/runs`
    )
  );
}

// ---- Approvals: read projection over the decision ledger --------------------
// GET /v1/workspaces/{ws}/approvals?status=&limit= (ApprovalDecisionRoutes).
// Rows are scoped by channel membership server-side, snake_case on the wire,
// and ordered `expires_at NULLS LAST, created_at DESC`.
//
// Two things the projection deliberately does NOT give a client, and this
// module does not invent: there is no `created_at`, so a pending row has no
// "how long ago" (only `expires_at`), and `payload` is left out of the type
// because tool arguments/paths stay opaque in product UI.

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface Approval {
  id: string;
  workspaceId: string;
  runId: string;
  channelId: string;
  /** The message carrying the approval card, when the run wrote one. */
  requestMessageId?: string;
  /** The AGENT member that asked. Agents are members (ADR-0004). */
  requestedBy: string;
  /** The human the agent acted for, when the run recorded one. */
  onBehalfOf?: string;
  /** Tool or control name, e.g. `work.spawn`. */
  actionType: string;
  status: ApprovalStatus;
  /** Server risk flag; false means the action cannot be undone. */
  isReversible?: boolean;
  decidedBy?: string;
  decidedAtMs?: number;
  decisionReason?: string;
  expiresAtMs?: number;
}

interface WireApproval {
  id: string;
  workspace_id: string;
  run_id: string;
  channel_id: string;
  request_message_id?: string | null;
  requested_by: string;
  on_behalf_of?: string | null;
  action_type: string;
  status: string;
  is_reversible?: boolean | null;
  decided_by?: string | null;
  decided_at_ms?: number | null;
  decision_reason?: string | null;
  expires_at_ms?: number | null;
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

function toApproval(wire: WireApproval): Approval {
  return {
    id: wire.id,
    workspaceId: wire.workspace_id,
    runId: wire.run_id,
    channelId: wire.channel_id,
    requestMessageId: optional(wire.request_message_id),
    requestedBy: wire.requested_by,
    onBehalfOf: optional(wire.on_behalf_of),
    actionType: wire.action_type,
    status: wire.status as ApprovalStatus,
    isReversible: optional(wire.is_reversible),
    decidedBy: optional(wire.decided_by),
    decidedAtMs: optional(wire.decided_at_ms),
    decisionReason: optional(wire.decision_reason),
    expiresAtMs: optional(wire.expires_at_ms),
  };
}

function isWireApproval(value: unknown): value is WireApproval {
  return (
    str(value, "id") !== undefined &&
    str(value, "workspace_id") !== undefined &&
    str(value, "run_id") !== undefined &&
    str(value, "channel_id") !== undefined &&
    str(value, "requested_by") !== undefined &&
    str(value, "action_type") !== undefined &&
    str(value, "status") !== undefined
  );
}

/** One approval status page. The server clamps `limit` to 1...500. */
export async function fetchApprovals(
  workspaceId: string,
  status: ApprovalStatus = "pending",
  limit = 50
): Promise<Approval[]> {
  const res = await request<{ approvals: WireApproval[] }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/approvals?status=${status}&limit=${limit}`
  );
  const approvals = arrayField(res, "approvals");
  return approvals === null ? [] : approvals.filter(isWireApproval).map(toApproval);
}

// ---- Agent runs: work projection ------------------------------------------
// GET /v1/workspaces/{ws}/channels/{ch}/agent-runs (type=work only, the server
// rejects any other value). camelCase on the wire, unlike read-state/approvals.

export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AgentRun {
  id: string;
  workspaceId: string;
  agentMemberId: string;
  channelId: string;
  triggerMessageId?: string;
  status: AgentRunStatus;
  stepCount: number;
  maxSteps: number;
  /** Validated work input: `{ type, title, brief, repo?, branch? }`. */
  input?: Record<string, unknown>;
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentRunSummary {
  id: string;
  channelId: string;
  triggerMessageId?: string;
  triggerSummary?: string;
  status: AgentRunStatus;
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentRunSummaryPage {
  runs: AgentRunSummary[];
  nextCursor?: string;
}

const AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function optionalFiniteNumber(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireShapeError();
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new WireShapeError();
  return value;
}

function agentRunSummaryFromWire(value: unknown): AgentRunSummary {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const channelId = str(source, "channelId");
  const status = str(source, "status");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  if (
    id === undefined ||
    channelId === undefined ||
    status === undefined ||
    !AGENT_RUN_STATUSES.has(status as AgentRunStatus) ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    channelId: channelId.toLowerCase(),
    status: status as AgentRunStatus,
    createdAtMs,
    updatedAtMs,
    ...(optionalString(source, "triggerMessageId") === undefined
      ? {}
      : { triggerMessageId: optionalString(source, "triggerMessageId")?.toLowerCase() }),
    ...(optionalString(source, "triggerSummary") === undefined
      ? {}
      : { triggerSummary: optionalString(source, "triggerSummary") }),
    ...(optionalFiniteNumber(source, "startedAtMs") === undefined
      ? {}
      : { startedAtMs: optionalFiniteNumber(source, "startedAtMs") }),
    ...(optionalFiniteNumber(source, "finishedAtMs") === undefined
      ? {}
      : { finishedAtMs: optionalFiniteNumber(source, "finishedAtMs") }),
  };
}

/** Parse the bounded MOMO-653 history page without accepting partial rows. */
export function agentRunSummaryPageFromWire(value: unknown): AgentRunSummaryPage {
  const source = responseRecord(value);
  const runs = arrayField(source, "runs");
  if (runs === null) throw new WireShapeError();
  const nextCursor = optionalString(source, "nextCursor");
  return {
    runs: runs.map(agentRunSummaryFromWire),
    ...(nextCursor === undefined ? {} : { nextCursor: nextCursor.toLowerCase() }),
  };
}

export async function fetchAgentRuns(
  workspaceId: string,
  channelId: string,
  limit = 20
): Promise<AgentRun[]> {
  const res = await request<{ runs: AgentRun[] }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/agent-runs?limit=${limit}`
  );
  return res.runs;
}

export async function fetchAgentRunSummaries(
  workspaceId: string,
  agentMemberId: string,
  cursor?: string,
  limit = 20
): Promise<AgentRunSummaryPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor.toLowerCase());
  return agentRunSummaryPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agents/${encodeURIComponent(
      agentMemberId.toLowerCase()
    )}/runs?${query.toString()}`
  ));
}

function agentRunDetailFromWire(value: unknown): AgentRun {
  const source = responseRecord(value);
  const summary = agentRunSummaryFromWire(source);
  const workspaceId = str(source, "workspaceId");
  const agentMemberId = str(source, "agentMemberId");
  const stepCount = num(source, "stepCount");
  const maxSteps = num(source, "maxSteps");
  if (
    workspaceId === undefined ||
    agentMemberId === undefined ||
    stepCount === undefined ||
    maxSteps === undefined
  ) {
    throw new WireShapeError();
  }
  const input = record(source.input);
  return {
    ...summary,
    workspaceId: workspaceId.toLowerCase(),
    agentMemberId: agentMemberId.toLowerCase(),
    stepCount,
    maxSteps,
    ...(input === null ? {} : { input }),
  };
}

export async function fetchAgentRunDetail(
  workspaceId: string,
  runId: string
): Promise<AgentRun> {
  return agentRunDetailFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agent-runs/${encodeURIComponent(runId.toLowerCase())}`
  ));
}

// ---- 모델·추론 강도 라우팅 (ADR-0134) ---------------------------------------
// GET     /v1/provider/effort-table                    (D2, MOMO-621)
// GET/PUT /v1/workspaces/{ws}/agents/{agent}/profile    (D3 상속 체인의 2층)
//
// The effort table is the ONE endpoint of this surface that is safe to probe:
// no side effect, no tenant row, no credential-shaped field (ADR-0004), and any
// authenticated principal may read it. features/routing/capability.ts uses that
// property to decide what this server can honestly be asked for.
//
// The body is returned untyped and shaped by `parseEffortTable`
// (features/routing/routingModel.ts), which is where the contract is pinned and
// fixture-tested, the same split the usage summary uses.

export function fetchEffortTable(signal?: AbortSignal): Promise<unknown> {
  return request<unknown>("/v1/provider/effort-table", { signal });
}

/**
 * The agent profile projection (openapi `AgentProfile`).
 *
 * `effortPref` is ADR-0134 D3's new tier and is absent from a server that
 * predates it. Absent is not "none": the two are told apart by the routing
 * capability probe, never by guessing from a missing key.
 */
export interface AgentProfile {
  agentMemberId: string;
  workspaceId: string;
  instructions: string;
  modelPref?: string;
  effortPref?: string;
  enabledTools: string[];
  /**
   * `mention` is pinned to true by the contract on both ends (openapi
   * `AgentProfileTriggers.mention` is `enum: [true]`, and the server rejects
   * anything else), so the only part that varies is `schedule`. Typed as the
   * literal because a caller echoing this object back into a PUT is doing the
   * right thing, and the type should not make it look like a re-decision.
   */
  triggers: AgentProfileTriggers;
  paused: boolean;
  version: number;
  updatedBy: string;
  updatedAtMs: number;
}

/**
 * `schedule` is defined but not executed in v0 (openapi says so in as many
 * words). It is still round-tripped verbatim: a client that edits routing and
 * drops the key would delete a stored schedule, because the server upsert is
 * `triggers = EXCLUDED.triggers` (AgentProfileRoutes.swift), not a merge.
 */
export interface AgentProfileTriggers {
  mention: true;
  schedule?: unknown;
}

/**
 * Closed-world PUT body (`AgentProfileInput`): a key the server does not know is
 * a 400, and it is a REPLACE, not a patch. `instructions` and `enabledTools`
 * are therefore always sent back as read, so editing one routing field cannot
 * erase the profile's instructions.
 */
export interface AgentProfileInput {
  instructions: string;
  enabledTools: string[];
  modelPref?: string;
  effortPref?: string;
  triggers?: AgentProfileTriggers;
}

export async function fetchAgentProfile(
  workspaceId: string,
  agentMemberId: string
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/profile`
  );
  return res.profile;
}

/**
 * The list is agent-specific (`agent.model ∪ allowed_agent_models`). `null`
 * means this server did not send a usable list, so routing keeps its compatible
 * broad-picker fallback rather than trapping a user behind an empty select.
 */
export async function fetchAgentAllowedModels(
  workspaceId: string,
  agentMemberId: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const response = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/allowed-models`,
    { signal }
  );
  const models = stringArrayField(response, "allowedAgentModels");
  if (
    models === null ||
    models.length === 0 ||
    models.some((model) => model.trim() === "") ||
    new Set(models).size !== models.length
  ) {
    return null;
  }
  return models;
}

export async function putAgentProfile(
  workspaceId: string,
  agentMemberId: string,
  input: AgentProfileInput
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/profile`,
    { method: "PUT", body: JSON.stringify(input) }
  );
  return res.profile;
}

export async function putAgentPause(
  workspaceId: string,
  agentMemberId: string,
  paused: boolean
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agents/${encodeURIComponent(
      agentMemberId.toLowerCase()
    )}/pause`,
    { method: "PUT", body: JSON.stringify({ paused }) }
  );
  return res.profile;
}

// ---- Agent-scoped memory browser (MOMO-652 / ADR-0129) --------------------

export type MemoryScope = "member" | "agent" | "workspace" | "conversation";

export interface MemorySourceRef {
  messageId: string;
  channelId: string;
}

export interface MemoryItem {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  subjectMemberId?: string;
  agentMemberId?: string;
  channelId?: string;
  kind: string;
  body: string;
  confidence: number;
  validAtMs: number;
  invalidAtMs?: number;
  invalidatedByMemoryId?: string;
  createdByKind: "human" | "agent" | "worker";
  createdByMemberId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  sourceRefs: MemorySourceRef[];
}

export interface MemorySearchHit {
  memory: MemoryItem;
  score: number;
}

export interface MemoryVisibilityGrant {
  id: string;
  workspaceId: string;
  memoryId: string;
  granteeKind: "member" | "agent";
  granteeId: string;
  grantedBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

const MEMORY_SCOPES = new Set<MemoryScope>([
  "member",
  "agent",
  "workspace",
  "conversation",
]);
const MEMORY_CREATORS = new Set<MemoryItem["createdByKind"]>([
  "human",
  "agent",
  "worker",
]);

function memorySourceRefFromWire(value: unknown): MemorySourceRef {
  const messageId = str(value, "messageId");
  const channelId = str(value, "channelId");
  if (messageId === undefined || channelId === undefined) {
    throw new WireShapeError();
  }
  return {
    messageId: messageId.toLowerCase(),
    channelId: channelId.toLowerCase(),
  };
}

function optionalLowerId(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  return optionalString(source, key)?.toLowerCase();
}

export function memoryItemFromWire(value: unknown): MemoryItem {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const scope = str(source, "scope");
  const kind = str(source, "kind");
  const body = str(source, "body");
  const confidence = num(source, "confidence");
  const validAtMs = num(source, "validAtMs");
  const createdByKind = str(source, "createdByKind");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  const refs = arrayField(source, "sourceRefs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    scope === undefined ||
    !MEMORY_SCOPES.has(scope as MemoryScope) ||
    kind === undefined ||
    body === undefined ||
    confidence === undefined ||
    validAtMs === undefined ||
    createdByKind === undefined ||
    !MEMORY_CREATORS.has(createdByKind as MemoryItem["createdByKind"]) ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    refs === null
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    scope: scope as MemoryScope,
    kind,
    body,
    confidence,
    validAtMs,
    createdByKind: createdByKind as MemoryItem["createdByKind"],
    createdAtMs,
    updatedAtMs,
    sourceRefs: refs.map(memorySourceRefFromWire),
    ...(optionalLowerId(source, "subjectMemberId") === undefined
      ? {}
      : { subjectMemberId: optionalLowerId(source, "subjectMemberId") }),
    ...(optionalLowerId(source, "agentMemberId") === undefined
      ? {}
      : { agentMemberId: optionalLowerId(source, "agentMemberId") }),
    ...(optionalLowerId(source, "channelId") === undefined
      ? {}
      : { channelId: optionalLowerId(source, "channelId") }),
    ...(optionalFiniteNumber(source, "invalidAtMs") === undefined
      ? {}
      : { invalidAtMs: optionalFiniteNumber(source, "invalidAtMs") }),
    ...(optionalLowerId(source, "invalidatedByMemoryId") === undefined
      ? {}
      : {
          invalidatedByMemoryId: optionalLowerId(
            source,
            "invalidatedByMemoryId"
          ),
        }),
    ...(optionalLowerId(source, "createdByMemberId") === undefined
      ? {}
      : { createdByMemberId: optionalLowerId(source, "createdByMemberId") }),
  };
}

export function memoryPageFromWire(value: unknown): MemoryItem[] {
  const memories = arrayField(responseRecord(value), "memories");
  if (memories === null) throw new WireShapeError();
  return memories.map(memoryItemFromWire);
}

export function memorySearchFromWire(value: unknown): MemorySearchHit[] {
  const hits = arrayField(responseRecord(value), "hits");
  if (hits === null) throw new WireShapeError();
  return hits.map((value) => {
    const source = record(value);
    const score = num(source, "score");
    if (source === null || score === undefined) throw new WireShapeError();
    return { memory: memoryItemFromWire(source.memory), score };
  });
}

function memoryGrantFromWire(value: unknown): MemoryVisibilityGrant {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const memoryId = str(source, "memoryId");
  const granteeKind = str(source, "granteeKind");
  const granteeId = str(source, "granteeId");
  const grantedBy = str(source, "grantedBy");
  const createdAtMs = num(source, "createdAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    memoryId === undefined ||
    (granteeKind !== "member" && granteeKind !== "agent") ||
    granteeId === undefined ||
    grantedBy === undefined ||
    createdAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    memoryId: memoryId.toLowerCase(),
    granteeKind,
    granteeId: granteeId.toLowerCase(),
    grantedBy: grantedBy.toLowerCase(),
    createdAtMs,
    ...(optionalFiniteNumber(source, "revokedAtMs") === undefined
      ? {}
      : { revokedAtMs: optionalFiniteNumber(source, "revokedAtMs") }),
  };
}

export function memoryGrantPageFromWire(value: unknown): MemoryVisibilityGrant[] {
  const grants = arrayField(responseRecord(value), "grants");
  if (grants === null) throw new WireShapeError();
  return grants.map(memoryGrantFromWire);
}

export async function listAgentMemories(
  workspaceId: string,
  agentMemberId: string,
  limit = 50
): Promise<MemoryItem[]> {
  const query = new URLSearchParams({
    agent: agentMemberId.toLowerCase(),
    limit: String(limit),
  });
  return memoryPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories?${query.toString()}`
  ));
}

export async function searchAgentMemories(
  workspaceId: string,
  agentMemberId: string,
  queryText: string,
  limit = 20
): Promise<MemorySearchHit[]> {
  const query = new URLSearchParams({
    q: queryText,
    agent: agentMemberId.toLowerCase(),
    limit: String(limit),
  });
  return memorySearchFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/search?${query.toString()}`
  ));
}

export async function invalidateMemory(
  workspaceId: string,
  memoryId: string
): Promise<MemoryItem> {
  const source = responseRecord(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/${encodeURIComponent(
      memoryId.toLowerCase()
    )}/invalidate`,
    { method: "POST", body: "{}" }
  ));
  return memoryItemFromWire(source.memory);
}

export async function listMemoryVisibilityGrants(
  workspaceId: string,
  memoryId: string
): Promise<MemoryVisibilityGrant[]> {
  return memoryGrantPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/${encodeURIComponent(
      memoryId.toLowerCase()
    )}/grants`
  ));
}

// ---- 전송 표면이 `routing`을 받는가 (ADR-0134 D1 멘션 tier, MOMO-625) --------
//
// GET 하나로 답할 수 없는 질문이다. `routing`은 `POST .../messages`의 본문 키이고
// (MOMO-625가 `SendMessageRequest.allowedKeys`에 더한 단 하나의 키), 그 키를 모르는
// 세대의 서버는 400을 주지 않고 **조용히 무시한다**. 즉 "거절이 없었다"는 사실은
// 성공의 근거가 되지 못한다. 그래서 그 표면에 직접, 그러나 아무것도 남기지 않는
// 방식으로 물어본다.
//
// 물음의 형태: **두 세대 모두가 반드시 거절하는 요청** 하나.
//   rootId  이번에 만든 난수 UUID. 그런 메시지는 존재하지 않으므로 스레드 루트
//           조회가 404로 끝난다. 트랜잭션은 열리지만 INSERT까지 가지 않는다.
//   routing 유효 레벨 집합에 없는 effort 토큰.
//
// 그래서 답이 갈린다.
//   MOMO-625 이후  decode 직후 `RunRoutingInput.validate`가 400을 던진다
//                  (MessageRoutes.swift: 트랜잭션이 열리기 전).
//   MOMO-625 이전  `routing`은 모르는 키라 무시되고 404 "thread root not found".
//
// 두 경로 모두 메시지를 만들지 않는다. momowebqa(=main 형상)에서 실측했다:
// 404, 채널 seq 불변, 감사행 없음. 이 함수는 그래서 항상 throw한다.
// 판정은 `features/routing/capability.ts`의 `verdictFromSendProbe`가 한다.
//
// ---- 엔진 랜딩 시 재확인 (MOMO-625가 main에 들어오는 순간) -------------------
// 이 프로브의 무해함 가운데 **앞 세대(404)만** 이 브랜치에서 실측됐다. 뒤 세대의
// 근거는 아직 track/engine에 있으므로(R2 M6), MOMO-625 랜딩 직후 살아 있는 서버
// 한 대에 대고 아래 셋을 다시 재고 그 결과를 ENGINE_HANDOFF에 적는다.
//   ① 400이 트랜잭션 이전에 나는가: 프로브 전후로 채널 newest seq가 불변이고
//      message·agent_run·audit_log에 행이 생기지 않는다.
//   ② 400 문구가 `routing`을 이름으로 부르는가: `verdictFromSendProbe`의 ready
//      분기는 `/routing/i` 매칭이다. 서버가 그 리터럴 없이 거절하면 판정은
//      unknown으로 떨어진다(잠기지만 영구는 아니다: [다시 확인]이 있다).
//   ③ 검사 순서가 rootId 조회보다 앞인가: 뒤라면 랜딩한 서버도 404를 주고,
//      화면은 되는 기능을 없다고 말하게 된다.
// 셋 중 하나라도 어긋나면 프로브의 형태를 고치는 것이 맞고, 화면 문구가 아니다.

/** 어떤 모델에서도 유효할 수 없는 토큰. 32바이트 상한(마이그레이션 041) 안. */
const SEND_ROUTING_PROBE_EFFORT = "__momo-capability-probe__";

export async function probeSendRouting(
  workspaceId: string,
  channelId: string
): Promise<void> {
  await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        clientMsgId: crypto.randomUUID(),
        rootId: crypto.randomUUID(),
        type: "text",
        body: "",
        routing: { effort: SEND_ROUTING_PROBE_EFFORT },
      }),
    }
  );
}
