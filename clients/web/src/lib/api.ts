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
      const pair = res.json<RefreshResponse>();
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
  return res.json<T>();
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
  const loginResponse = res.json<LoginResponse>();
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
  return trimmed === "" ? "momo-user" : trimmed;
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
  const joinResponse = res.json<LoginResponse>();
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
        const pair = rotated.json<RefreshResponse>();
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
  return res.channels;
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
  return res.members;
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
  return res.read_states.map(toReadState);
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

export function fetchMessages(
  workspaceId: string,
  channelId: string,
  query: MessageQuery = {}
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.after !== undefined) params.set("after", String(query.after));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<MessagePage>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
  );
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
 * Per-request model/effort override (ADR-0134 D1 `routing`). Optional on the
 * wire and omitted entirely when nothing is overridden, so a send that inherits
 * carries the exact body it carried before this ticket existed.
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

/** `running` while the host holds it, `orphaned` when the host went away. */
export type WorkSessionStatusWire = "running" | "orphaned" | "ended";

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
  return res.workHosts;
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
  return res.approvals.map(toApproval);
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
  triggers: { mention: boolean; schedule?: unknown };
  paused: boolean;
  version: number;
  updatedBy: string;
  updatedAtMs: number;
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
  triggers?: { mention: true; schedule?: unknown };
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
