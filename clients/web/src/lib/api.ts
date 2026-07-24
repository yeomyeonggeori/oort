// =============================================================================
// REST client for the canonical web UI (ADR-0133 §1; originated in the MOMO-595
// P0 spike against momowebqa).
//
// Contract source of truth: server Routes + docs/api/openapi.yaml, mirrored by
// the ADR-0119 client at clients/web-legacy/src/api. Quirks preserved on purpose:
//   - message ordering authority is `seq` (gapless per channel);
//   - `?before=<seq>` reads OLDER history DESCENDING; `?after=<seq>` backfill is
//     ASCENDING (used to heal realtime gaps);
//   - UUID casing crosses the wire mixed (Swift = UPPER, PG JSON = lower) —
//     compare case-insensitively (uuidEq);
//   - the realtime WS URL is authoritative from login, never derived.
//
// Current scope (inherited from the spike): access token kept in memory only.
// No refresh rotation yet — clients/web-legacy/src/api/client.ts is the working
// reference implementation to port during P1.
// =============================================================================

import { API_BASE } from "./env";

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

export interface Channel {
  id: string;
  workspaceId: string;
  kind: "public" | "private" | "dm";
  name?: string;
  topic?: string;
  memberIds?: string[];
  muted: boolean;
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

let accessToken: string | null = null;
export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body is a documented shape */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export async function login(
  email: string,
  password: string,
  workspace?: string
): Promise<LoginResponse> {
  const body: Record<string, string> = { email, password };
  if (workspace && workspace.trim()) body.workspace = workspace.trim();
  const res = await request<LoginResponse>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
  accessToken = res.accessToken;
  return res;
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
