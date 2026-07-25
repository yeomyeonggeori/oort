// =============================================================================
// REST client for the settings shell (R-1 §5 / MOMO-601).
//
// Every endpoint below already exists on the server and was verified against
// momowebqa before this file was written; the response types are transcribed
// from the Swift DTOs, not guessed:
//   server/Sources/MomoServer/Routes/ProviderLinkRoutes.swift   (link + test)
//   server/Sources/MomoServer/Routes/WorkHostEngineRoutes.swift (engine)
//   server/Sources/MomoServer/Routes/WorkspaceRoutes.swift      (create/read)
//   server/Sources/MomoServer/Routes/InviteRoutes.swift         (invites)
//
// The transport is duplicated here rather than added to src/lib/api.ts on
// purpose: four P1 wave2 tickets edit clients/web in parallel and the shared
// client is the file most likely to collide. It reuses the shared ApiError and
// the in-memory access token, so there is still exactly one auth path.
//
// ADR-0004 boundary held on the client too: the bearer is only ever written
// (PUT body). Nothing here reads it back, and the GET response deliberately
// carries just a boolean plus a 4-character tail.
// =============================================================================

import { ApiError, getAccessToken } from "@/lib/api";
import { API_BASE } from "@/lib/env";

async function settingsRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
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

/**
 * The API origin a new member has to point their client at. Empty API_BASE
 * means same-origin relative paths (the dev/preview proxy), so the browser
 * origin is the honest answer for the invite deep link.
 */
export function resolveServerBaseUrl(): string {
  if (API_BASE) return API_BASE;
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

// --- AI 연결: GET/PUT/DELETE /v1/provider/link, POST /v1/provider/link/test --

/** `momo.provider_link.v0`. `source` is "database" once an operator saves. */
export interface ProviderLink {
  schema: string;
  configured: boolean;
  source: string;
  mode: string;
  baseUrl: string;
  endpointLabel: string;
  bearerConfigured: boolean;
  /** Last 4 characters of the stored bearer. Absent unless source=database. */
  bearerLast4?: string;
  availability: string;
  keyConfigured: boolean;
  updatedAtMs?: number;
  updatedBy?: string;
  diagnostics: string[];
}

/** `momo.provider_link.test.v0`. `reason` is a machine label, not user copy. */
export interface ProviderLinkTest {
  schema: string;
  ok: boolean;
  reason?: string;
  source: string;
  mode: string;
  endpointLabel: string;
  checkedAtMs: number;
}

/** Closed-world PUT body: the server rejects any other key with a 400. */
export interface ProviderLinkInput {
  baseUrl: string;
  bearer: string;
  mode: string;
}

export function fetchProviderLink(): Promise<ProviderLink> {
  return settingsRequest<ProviderLink>("/v1/provider/link");
}

export function putProviderLink(input: ProviderLinkInput): Promise<ProviderLink> {
  return settingsRequest<ProviderLink>("/v1/provider/link", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteProviderLink(): Promise<ProviderLink> {
  return settingsRequest<ProviderLink>("/v1/provider/link", {
    method: "DELETE",
  });
}

export function testProviderLink(): Promise<ProviderLinkTest> {
  return settingsRequest<ProviderLinkTest>("/v1/provider/link/test", {
    method: "POST",
  });
}

// --- 코드 실행 호스트: GET/PUT /v1/provider/work-host-engine ----------------

/** `momo.work_host_engine.v0`. source="default" means no row was ever written. */
export interface WorkHostEngine {
  engine: string;
  source: string;
  updatedBy?: string;
  updatedAtMs?: number;
  schema: string;
}

export function fetchWorkHostEngine(): Promise<WorkHostEngine> {
  return settingsRequest<WorkHostEngine>("/v1/provider/work-host-engine");
}

export function putWorkHostEngine(engine: string): Promise<WorkHostEngine> {
  return settingsRequest<WorkHostEngine>("/v1/provider/work-host-engine", {
    method: "PUT",
    body: JSON.stringify({ engine }),
  });
}

// --- 워크스페이스: POST /v1/workspaces, GET /v1/workspaces/:ws -------------

export interface CreatedWorkspace {
  schema: string;
  /** Server-side UUIDs arrive upper-cased; compare with uuidEq, never ===. */
  workspaceId: string;
  slug: string;
  name: string;
}

export interface WorkspaceIdentity {
  id: string;
  slug: string;
  name: string;
  updatedAtMs: number;
}

export function createWorkspace(
  slug: string,
  name: string
): Promise<CreatedWorkspace> {
  return settingsRequest<CreatedWorkspace>("/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ slug, name }),
  });
}

export async function fetchWorkspace(
  workspaceId: string
): Promise<WorkspaceIdentity> {
  const res = await settingsRequest<{ workspace: WorkspaceIdentity }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  );
  return res.workspace;
}

// --- 초대: GET/POST /v1/workspaces/:ws/invites ------------------------------

export interface InviteCode {
  id: string;
  workspaceId: string;
  /** Last 6 characters of the code. The code itself is returned only once. */
  codePreview: string;
  role: string;
  maxUses: number;
  usedCount: number;
  expiresAtMs: number;
  revokedAtMs?: number;
  revokedBy?: string;
  revocationReason?: string;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The only response that ever carries the raw code (server stores a hash). */
export interface CreatedInvite {
  invite: InviteCode;
  code: string;
}

export interface InviteInput {
  role: string;
  maxUses: number;
  expiresAtMs: number;
}

export async function listInvites(workspaceId: string): Promise<InviteCode[]> {
  const res = await settingsRequest<{ invites: InviteCode[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/invites?limit=20`
  );
  return res.invites;
}

export function createInvite(
  workspaceId: string,
  input: InviteInput
): Promise<CreatedInvite> {
  return settingsRequest<CreatedInvite>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/invites`,
    { method: "POST", body: JSON.stringify(input) }
  );
}
