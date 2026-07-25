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

function rawRequest(
  path: string,
  init: RequestInit,
  token: string | null
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${apiBase()}${path}`, { ...init, headers });
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* non-JSON error body is a documented shape */
  }
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
      const pair = (await res.json()) as RefreshResponse;
      applyRotation(pair.accessToken, pair.refreshToken);
      return true;
    } catch {
      return false; // offline: the caller keeps rendering cached content (P15)
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
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
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
  if (!res.ok) throw await parseError(res);
  const loginResponse = (await res.json()) as LoginResponse;
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
  if (!res.ok) throw await parseError(res);
  const joinResponse = (await res.json()) as LoginResponse;
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
        const pair = (await rotated.json()) as RefreshResponse;
        await revoke(pair.accessToken, pair.refreshToken);
      }
    }
  } catch {
    // A network failure must not trap the user inside the session; the local
    // wipe above already happened and the tokens expire on their own.
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

/** One oldest-first page of thread replies (ascending channel seq). */
export function fetchThreadReplies(
  workspaceId: string,
  channelId: string,
  rootId: string,
  cursor?: number
): Promise<{ messages: Message[]; nextCursor?: number }> {
  const suffix = cursor === undefined ? "" : `?cursor=${cursor}`;
  return request<{ messages: Message[]; nextCursor?: number }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
      rootId
    )}/replies${suffix}`
  );
}

export function sendMessage(
  workspaceId: string,
  channelId: string,
  clientMsgId: string,
  bodyText: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ clientMsgId, type: "text", body: bodyText }),
    }
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
