import type { components } from "./schema";
import {
  applyLogin,
  applyRotation,
  clearSession,
  getAccessToken,
  getRefreshToken,
} from "../auth/session";

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
export type Member = components["schemas"]["Member"];
export type Channel = components["schemas"]["Channel"];
export type Message = components["schemas"]["Message"];
export type MessagePage = components["schemas"]["MessagePage"];
export type RosterMember = components["schemas"]["RosterMember"];
export type WorkspaceRosterResponse =
  components["schemas"]["WorkspaceRosterResponse"];
export type WorkspaceChannelsResponse =
  components["schemas"]["WorkspaceChannelsResponse"];
export type RealtimeTokenResponse =
  components["schemas"]["RealtimeTokenResponse"];
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
  return fetch(path, { ...init, headers });
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
        clearSession();
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
 * Authenticated JSON request against the same-origin /v1 surface.
 * On 401 it attempts exactly one refresh rotation, then retries once.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  let response = await rawRequest(path, init, getAccessToken());
  if (response.status === 401 && getRefreshToken()) {
    const rotated = await refreshSession();
    if (rotated) {
      response = await rawRequest(path, init, getAccessToken());
    }
  }
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw await parseError(response);
  }
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
