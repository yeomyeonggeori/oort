// =============================================================================
// REST client for the settings shell (R-1 §5 / MOMO-601).
//
// Every endpoint below already exists on the server and was verified against
// momowebqa before this file was written; the response types are transcribed
// from the Swift DTOs, not guessed:
//   server/Sources/MomoServer/Routes/ProviderLinkRoutes.swift   (link + test)
//   server/Sources/MomoServer/Routes/WorkHostEngineRoutes.swift (engine)
//   server/Sources/MomoServer/Routes/WorkTierPolicyRoutes.swift (tier policy)
//   server/Sources/MomoServer/Routes/WorkHostRoutes.swift       (host registry)
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

import { ApiError } from "@/lib/api";
import { fetchWithDeadline } from "@/lib/http";
import { absoluteApiBase, apiBase } from "@/lib/serverBase";
import { getAccessToken } from "@/lib/session";

// Same deadline as the shared client (MOMO-609): settings is where someone
// re-points a device at another server, so an address that answers nothing has
// to surface here as an error with a retry, not as a section that never loads.
async function settingsRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json<T>();
}

/**
 * The API origin a new member has to point their client at. An empty base means
 * same-origin relative paths (the dev/preview proxy), so the browser origin is
 * the honest answer for the invite deep link; a server chosen on the connect
 * screen (MOMO-604) wins over both.
 */
export function resolveServerBaseUrl(): string {
  return absoluteApiBase();
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

/**
 * One hop as the probe found it (`ProviderChainProbeDTO`, MOMO-622).
 *
 * `disposition` is what a REAL turn would do with this outcome, which is a
 * different question from `ok`: a 4xx hop is not ok AND does not fall over,
 * because retrying a caller error on the next provider spends a second budget
 * on the same guaranteed failure. The panel has to say which of the two it is
 * or an operator reads every red row as "the cascade will handle it".
 */
export interface ProviderChainProbe {
  position: number;
  source: string;
  mode: string;
  endpointLabel: string;
  enabled: boolean;
  ok: boolean;
  /** Machine label, not user copy. */
  reason?: string;
  /** `ok` | `fall_over` | `propagate` | `skipped`. */
  disposition: string;
}

/**
 * `momo.provider_link.test.v0`. `reason` is a machine label, not user copy.
 *
 * The first seven fields are the MOMO-572 contract and describe POSITION 0, so
 * they keep their exact old meaning. `cascadeOk` and `entries` are the ADR-0135
 * D1 extension and are OPTIONAL here for the same reason they are additive on
 * the wire: a server built before the chain landed answers the old body, and
 * the panel must read that as "this server has no chain", never as an empty
 * chain (which would be a claim, and a false one).
 */
export interface ProviderLinkTest {
  schema: string;
  ok: boolean;
  reason?: string;
  source: string;
  mode: string;
  endpointLabel: string;
  checkedAtMs: number;
  /** At least one hop in the cascade could serve a turn right now. */
  cascadeOk?: boolean;
  /** Per-hop probe results in attempt order, position 0 first. */
  entries?: ProviderChainProbe[];
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

// --- 프로바이더 체인: GET/PUT/DELETE /v1/provider/link/chain ------------------
//
// ADR-0135 D1 (MOMO-622), transcribed from ProviderLinkChainRoutes.swift.
//
// Two boundaries this client must not blur, both enforced by the server:
//   1. GET returns the WHOLE cascade including position 0, but position 0 is
//      the legacy `provider_link` singleton and PUT here rejects it with a 400.
//      The head is edited through PUT /v1/provider/link and nowhere else.
//   2. PUT replaces every fallback hop at once. `bearer` is write-only and may
//      be omitted to keep the key already stored AT THAT POSITION, so a hop's
//      position is its identity: moving a base URL to another position without
//      re-typing its key would pair it with a different provider's credential.
//      Positions of stored rows are therefore never rewritten by this client.

/** `ProviderChainEntryDTO`. Carries a masked 4-char tail, never a bearer. */
export interface ProviderChainEntry {
  /** 0 is the provider link singleton; fallback hops start at 1. */
  position: number;
  /** `provider_link` | `environment` | `chain`. */
  source: string;
  mode: string;
  baseUrl: string;
  endpointLabel: string;
  enabled: boolean;
  bearerConfigured: boolean;
  bearerLast4?: string;
  updatedAtMs?: number;
  updatedBy?: string;
}

/** `momo.provider_link.chain.v0`. */
export interface ProviderChain {
  schema: string;
  /** The whole cascade in attempt order, position 0 first. */
  entries: ProviderChainEntry[];
  /** Configured fallback hops (everything beyond position 0). */
  fallbackCount: number;
  /**
   * Hops a real turn would actually attempt: enabled AND usable, POSITION 0
   * INCLUDED. `ProviderCascade.attemptable` filters the whole plan and the plan
   * starts at the head, so two live fallbacks behind a live head answer 3, not
   * 2. Any sentence built from this number has to say so, or it reads as a
   * count of fallbacks and contradicts `fallbackCount` in the same breath.
   *
   * Optional, and absent means absent: it is a derived number, so a body that
   * omits it leaves this panel with nothing to say about attempts rather than
   * with a zero it would go on to state as a fact.
   */
  attemptableCount?: number;
  /**
   * 1-based indexes, in the order the server sent them, of entries this client
   * could not read. Absent when every entry parsed.
   *
   * It exists because dropping such an entry is not a display problem, it is a
   * DESTRUCTIVE one: `PUT /v1/provider/link/chain` replaces every fallback hop
   * at once, so a hop that never reached the draft is a hop the next save
   * deletes from the server along with the key stored at its position. A chain
   * carrying this is therefore read-only until the server answers something
   * this client can read in full.
   */
  unreadable?: number[];
}

/** Closed-world PUT entry: any other key is a 400 by contract. */
export interface ProviderChainEntryInput {
  position: number;
  baseUrl: string;
  /** Omit to keep the bearer already stored at this position. */
  bearer?: string;
  mode?: string;
  enabled?: boolean;
}

// All three answer the same body, and all three return it UNTYPED on purpose,
// shaped by `parseProviderChain` (./chainModel) exactly as the usage summary is
// shaped by `parseUsageSummary`.
//
// The reason is a measured crash, not caution. This route does not exist on the
// server yet, so anything in front of it that answers 200 with a different body
// (a proxy, a dev catch-all, a later schema) hands back an object with no
// `entries`. Trusting the type annotation there threw inside render and took the
// whole 설정 route down with it, which is a far worse answer than "this server
// sent something this panel cannot read".
export function fetchProviderChain(): Promise<unknown> {
  return settingsRequest<unknown>("/v1/provider/link/chain");
}

export function putProviderChain(
  entries: ProviderChainEntryInput[]
): Promise<unknown> {
  return settingsRequest<unknown>("/v1/provider/link/chain", {
    method: "PUT",
    body: JSON.stringify({ entries }),
  });
}

export function deleteProviderChain(): Promise<unknown> {
  return settingsRequest<unknown>("/v1/provider/link/chain", {
    method: "DELETE",
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

// --- 티어 정책: GET/PUT /v1/workspaces/:ws/work-tier-policy[/me] ------------
//
// ADR-0125 D11 policy ledger, transcribed from WorkTierPolicyRoutes.swift.
// Two scopes share one shape: `/me` is the signed-in member's override and the
// bare path is the workspace default (owner/admin only, 403 otherwise).
// `inherited: true` means no member row exists and the workspace default is the
// value in force, so the panel says that instead of implying a saved override.

export type WorkTierScope = "member" | "workspace";

/** `WorkTierPolicyDTO`. `mode` is t1_only | ask | auto; nothing else validates. */
export interface WorkTierPolicy {
  workspaceId: string;
  /** Absent on the workspace default row. Server casing varies: use uuidEq. */
  memberId?: string;
  mode: string;
  /** Only ever set in auto mode: "cloud" or a lower-cased work host id. */
  autoTarget?: string;
  inherited: boolean;
  updatedAtMs?: number;
}

/** Closed-world PUT body. autoTarget outside auto mode is a 400 by contract. */
export interface WorkTierPolicyInput {
  mode: string;
  autoTarget?: string;
}

function tierPolicyPath(workspaceId: string, scope: WorkTierScope): string {
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-tier-policy`;
  return scope === "member" ? `${base}/me` : base;
}

export async function fetchWorkTierPolicy(
  workspaceId: string,
  scope: WorkTierScope
): Promise<WorkTierPolicy> {
  const res = await settingsRequest<{ workTierPolicy: WorkTierPolicy }>(
    tierPolicyPath(workspaceId, scope)
  );
  return res.workTierPolicy;
}

export async function putWorkTierPolicy(
  workspaceId: string,
  scope: WorkTierScope,
  input: WorkTierPolicyInput
): Promise<WorkTierPolicy> {
  const res = await settingsRequest<{ workTierPolicy: WorkTierPolicy }>(
    tierPolicyPath(workspaceId, scope),
    { method: "PUT", body: JSON.stringify(input) }
  );
  return res.workTierPolicy;
}

// --- 등록된 호스트: GET /v1/workspaces/:ws/work-hosts -----------------------

/**
 * `WorkHostDTO`. The registry is a poll, not a realtime event: `online` is
 * computed by the server from a 90 second heartbeat window, so the client never
 * decides liveness on its own clock.
 *
 * `publicKey` is in the payload and is deliberately never rendered: it is the
 * host's signing identity, not something an operator acts on, and a settings
 * row is not a key dump. Revoked rows stay in the list (the server does not
 * filter them), which is why the panel has a 해지됨 state.
 */
export interface WorkHost {
  id: string;
  workspaceId: string;
  scope: string;
  ownerMemberId: string;
  type: string;
  displayName: string;
  publicKey: string;
  capabilities: Record<string, boolean>;
  lastSeenAtMs?: number;
  revokedAtMs?: number;
  createdAtMs: number;
  online: boolean;
}

export async function listWorkHosts(workspaceId: string): Promise<WorkHost[]> {
  const res = await settingsRequest<{ workHosts: WorkHost[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-hosts`
  );
  return res.workHosts;
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

// --- 사용량: GET /v1/workspaces/:ws/usage/summary ---------------------------

/**
 * Workspace usage summary (AX-7 1층, MOMO-616).
 *
 * Contract: docs/planning/handoffs/2026-07-25-usage-summary-contract.md, shared
 * with the engine ticket MOMO-615. Every workspace member may read it, so there
 * is no operator gate here; a 403 would still land on the shared error path.
 *
 * The body is returned untyped on purpose and shaped by `parseUsageSummary`
 * (./usageModel), which is where the contract is pinned and unit tested.
 */
export function fetchUsageSummary(
  workspaceId: string,
  query: { from: string; to: string; bucket: string }
): Promise<unknown> {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    bucket: query.bucket,
  });
  return settingsRequest<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage/summary?${params.toString()}`
  );
}
