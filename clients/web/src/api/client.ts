import type { components } from "./schema";
import {
  applyLogin,
  applyRotation,
  clearSession,
  getAccessToken,
  getRefreshToken,
  markAuthExpired,
} from "../auth/session";
import { apiUrl } from "../config/server";

// =============================================================================
// REST client for the web v0 surface (docs/api/openapi.yaml is the canonical
// contract; src/api/schema.d.ts is generated from it via openapi-typescript).
//
// Same-origin by design (ADR-0119 D1-A): every path is relative, the SPA and
// /v1/* share one origin behind Caddy, no CORS. The realtime websocket
// address is NEVER derived from this origin (ADR-0110).
//
// Contract quirks the server encodes on purpose (see the spec header):
//   - optional response fields are OMITTED, never null;
//   - UUID casing is mixed (Swift UUID = uppercase, PG JSON = lowercase) —
//     compare case-insensitively (uuidEq below);
//   - message ordering authority is `seq`; `?after=` backfill is ASCENDING.
// =============================================================================

export type LoginResponse = components["schemas"]["LoginResponse"];
export type JoinRequest = components["schemas"]["JoinRequest"];
export type JoinResponse = components["schemas"]["JoinResponse"];
export type Member = components["schemas"]["Member"];
export type Channel = components["schemas"]["Channel"];
export type Message = components["schemas"]["Message"];
export type MessagePage = components["schemas"]["MessagePage"];
export type ReactionSnapshot = components["schemas"]["ReactionSnapshot"];
export type RosterMember = components["schemas"]["RosterMember"];
export type WorkspaceRosterResponse =
  components["schemas"]["WorkspaceRosterResponse"];
export type WorkspaceChannelsResponse =
  components["schemas"]["WorkspaceChannelsResponse"];
export type RealtimeTokenResponse =
  components["schemas"]["RealtimeTokenResponse"];
export type SendMessageRequest = components["schemas"]["SendMessageRequest"];
export type ReadState = components["schemas"]["ReadState"];
export type ReadStateListResponse =
  components["schemas"]["ReadStateListResponse"];
export type OpenDirectMessageResponse =
  components["schemas"]["OpenDirectMessageResponse"];
export type ApprovalProjection = components["schemas"]["ApprovalProjection"];
export type ApprovalProjectionPage =
  components["schemas"]["ApprovalProjectionPage"];
export type ApprovalDecisionReceipt =
  components["schemas"]["ApprovalDecisionReceipt"];
export type ApprovalDecision = components["schemas"]["ApprovalDecisionRequest"];
type RefreshResponse = components["schemas"]["RefreshResponse"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

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

async function parseError(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as ErrorResponse;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Empty/non-JSON error body is a documented shape; keep the status text.
  }
  return new ApiError(response.status, message);
}

async function rawRequest(
  path: string,
  init: RequestInit,
  token: string | null
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(apiUrl(path), { ...init, headers });
}

// ---- refresh rotation (single flight) ---------------------------------------
// MOMO-300: the refresh token is single-use. Concurrent 401s must funnel into
// ONE rotation call — a second concurrent rotation would present an
// already-revoked token and kill the session. (Cross-TAB races remain
// possible with localStorage refresh storage; see README limitations.)

let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      const response = await rawRequest(
        "/v1/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken }) },
        null
      );
      if (!response.ok) {
        markAuthExpired();
        return false;
      }
      const pair = (await response.json()) as RefreshResponse;
      applyRotation(pair.accessToken, pair.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Authenticated request against the same-origin /v1 surface.
 * On 401 it attempts exactly one refresh rotation, then retries once; a
 * 401 that survives the rotation ends the session (D3-A).
 */
async function authorizedFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let response = await rawRequest(path, init, getAccessToken());
  if (response.status === 401 && getRefreshToken()) {
    const rotated = await refreshSession();
    if (rotated) {
      response = await rawRequest(path, init, getAccessToken());
    }
  }
  if (response.status === 401) markAuthExpired();
  return response;
}

/** authorizedFetch + JSON decode; every non-2xx becomes an ApiError. */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

// ---- auth --------------------------------------------------------------------

export async function login(
  email: string,
  password: string,
  workspace?: string
): Promise<LoginResponse> {
  const body: Record<string, string> = { email, password };
  // Omitted workspace => server falls back to the demo workspace
  // (single-tenant v0 convenience, AuthRoutes.swift).
  if (workspace && workspace.trim() !== "") body.workspace = workspace.trim();
  const response = await rawRequest(
    "/v1/auth/login",
    { method: "POST", body: JSON.stringify(body) },
    null
  );
  if (!response.ok) throw await parseError(response);
  const loginResponse = (await response.json()) as LoginResponse;
  applyLogin(loginResponse);
  return loginResponse;
}

/**
 * Public invite redemption (MOMO-401, ADR-0121 D2-B web landing). No auth:
 * the invite code is the only credential, and it travels ONLY in this
 * request body — never in a query string, never in a log line (bearer-secret
 * handling; the /join/<code> path segment is stripped from the address bar
 * before this call can happen, see App.tsx).
 *
 * 201 creates a member, 200 re-joins an existing one (same email). Both
 * return a session token pair per the canonical contract — openapi.yaml
 * JoinResponse REQUIRES accessToken/refreshToken/realtimeWebSocketUrl
 * ("issuing a session token pair") — so applying the session here IS the
 * spec'd login path, not an auto-login invented ahead of the spec.
 */
export async function joinInvite(request: JoinRequest): Promise<JoinResponse> {
  const response = await rawRequest(
    "/v1/join",
    { method: "POST", body: JSON.stringify(request) },
    null
  );
  if (!response.ok) throw await parseError(response);
  const joinResponse = (await response.json()) as JoinResponse;
  applyLogin(joinResponse);
  return joinResponse;
}

function postLogout(): Promise<Response> {
  // Read both tokens at call time: after a rotation the retry MUST carry the
  // refreshed pair, not a stale closure copy.
  const refreshToken = getRefreshToken();
  return rawRequest(
    "/v1/auth/logout",
    {
      method: "POST",
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    },
    getAccessToken()
  );
}

/** Server-side revocation first (best effort), then local wipe — D3-A. */
export async function logout(): Promise<void> {
  try {
    const response = await postLogout();
    // Expired access token => 401 before the server revokes anything, while
    // the refresh token stays alive for 30 days. Rotate once and retry with
    // the RE-READ pair. apiFetch is deliberately not reused here: it would
    // replay the original body, whose pre-rotation refresh token is already
    // dead, leaving the freshly rotated pair unrevoked. One retry only; on
    // failure we still fall through to the local wipe.
    if (response.status === 401 && getRefreshToken()) {
      const rotated = await refreshSession();
      if (rotated) await postLogout();
    }
  } catch {
    // Network failure must not trap the user in a session; local wipe wins.
  } finally {
    clearSession();
  }
}

export async function fetchRealtimeToken(): Promise<string> {
  const response = await apiFetch<RealtimeTokenResponse>(
    "/v1/auth/realtime-token",
    { method: "POST" }
  );
  return response.token;
}

// ---- workspace reads -----------------------------------------------------------

export function listChannels(
  workspaceId: string
): Promise<WorkspaceChannelsResponse> {
  return apiFetch<WorkspaceChannelsResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`
  );
}

export function fetchRoster(
  workspaceId: string
): Promise<WorkspaceRosterResponse> {
  return apiFetch<WorkspaceRosterResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/roster`
  );
}

export interface MessageQuery {
  limit?: number;
  /** Page older history: messages with seq strictly BELOW this (descending). */
  before?: number;
  /** Realtime-recovery backfill: seq strictly ABOVE this (ASCENDING). */
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
  return apiFetch<MessagePage>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
  );
}

export function fetchReactionSnapshot(
  workspaceId: string,
  channelId: string
): Promise<ReactionSnapshot> {
  return apiFetch<ReactionSnapshot>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/reactions`
  );
}

// ---- write path (MOMO-400) ---------------------------------------------------

/**
 * Single write path: POST -> PG (gapless seq) -> outbox -> relay. Retrying
 * with the SAME clientMsgId is idempotent — the server returns the original
 * message (201 either way). The response body IS the server echo (committed,
 * seq-authoritative); rendering it is not optimistic rendering.
 */
export function sendMessage(
  workspaceId: string,
  channelId: string,
  clientMsgId: string,
  body: string
): Promise<Message> {
  const request: SendMessageRequest = { clientMsgId, type: "text", body };
  return apiFetch<Message>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify(request) }
  );
}

// ---- read-state (ADR-0109) ---------------------------------------------------

export function fetchReadStates(
  workspaceId: string
): Promise<ReadStateListResponse> {
  return apiFetch<ReadStateListResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`
  );
}

/**
 * Advance the caller's cursor. Server-side the effective cursor is
 * `max(current, min(requested, latestSeq))` — it can never move backward;
 * the caller (useReadStates) additionally never REQUESTS a regression.
 */
export function updateReadState(
  workspaceId: string,
  channelId: string,
  lastReadSeq: number
): Promise<ReadState> {
  return apiFetch<ReadState>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/read-state`,
    { method: "PUT", body: JSON.stringify({ last_read_seq: lastReadSeq }) }
  );
}

// ---- DMs -----------------------------------------------------------------------

export function listDms(
  workspaceId: string
): Promise<WorkspaceChannelsResponse> {
  return apiFetch<WorkspaceChannelsResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/dms`
  );
}

/** Idempotent per pair: 201 creates, 200 returns the existing channel. */
export function openDm(
  workspaceId: string,
  memberId: string
): Promise<OpenDirectMessageResponse> {
  return apiFetch<OpenDirectMessageResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/dms`,
    { method: "POST", body: JSON.stringify({ memberId }) }
  );
}

// ---- approvals (ADR-0112 basic mode) -------------------------------------------

export function listApprovals(
  workspaceId: string,
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled" =
    "pending"
): Promise<ApprovalProjectionPage> {
  return apiFetch<ApprovalProjectionPage>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/approvals?status=${status}`
  );
}

export interface ApprovalDecisionResult {
  /** 200 committed/idempotent-retry; 403/404/409 expected receipt failures. */
  httpStatus: number;
  receipt: ApprovalDecisionReceipt;
}

/**
 * POST an approval decision. The contract (openapi.yaml, canonical) returns
 * the SAME receipt schema for 200 AND for the expected failures 403/404/409
 * — a 409 (decided elsewhere first / expired / idempotency conflict) is part
 * of the normal flow and must drive a card state transition, not an error
 * toast. Only 400/401/429 use the generic error envelope and throw.
 */
export async function decideApproval(
  workspaceId: string,
  approvalId: string,
  approve: boolean,
  clientDecisionId: string
): Promise<ApprovalDecisionResult> {
  const decision: ApprovalDecision = {
    approval_id: approvalId,
    approve,
    client_decision_id: clientDecisionId,
  };
  const response = await authorizedFetch(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify(decision),
    }
  );
  if (
    response.ok ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 409
  ) {
    return {
      httpStatus: response.status,
      receipt: (await response.json()) as ApprovalDecisionReceipt,
    };
  }
  throw await parseError(response);
}
