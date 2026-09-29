// =============================================================================
// REST client for team memory v2 (ADR-0196 / #3164). Server: routes/memory.rs.
//
//   GET   /v1/workspaces/{ws}/channels/{ch}/memory/digests
//   GET   /v1/workspaces/{ws}/memory/digests/{id}
//   GET   /v1/workspaces/{ws}/agent-runs/{run}/memory-receipt
//   GET   /v1/workspaces/{ws}/memory/settings
//   PATCH /v1/workspaces/{ws}/memory/settings            workspace switch (admin)
//   PATCH /v1/workspaces/{ws}/memory/settings/me         personal pause
//   PATCH /v1/workspaces/{ws}/channels/{ch}/memory/settings   exclude / pause
//
// Permission failures are 403, hidden rows are 404 or an empty list; callers
// branch on `ApiError.status`, they do not filter results themselves.
// =============================================================================

import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { responseRecord } from "../../lib/wire";
import { apiBase, coreSession } from "../../runtime/host";
import {
  parseChannelMemorySettings,
  parseMemberMemorySettings,
  parseMemoryDigestPage,
  parseMemoryDigestResponse,
  parseMemoryReceiptResponse,
  parseMemorySettings,
  parseWorkspaceMemorySettings,
  type ChannelMemorySettings,
  type ListMemoryDigestsOptions,
  type MemberMemorySettings,
  type MemoryDigest,
  type MemoryDigestPage,
  type MemoryReceipt,
  type MemorySettings,
  type PatchChannelMemorySettingsInput,
  type PatchWorkspaceMemorySettingsInput,
  type WorkspaceMemorySettings,
} from "./model";

async function memoryRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return responseRecord(res.json<unknown>());
}

function workspacePath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function channelMemoryPath(workspaceId: string, channelId: string): string {
  return `${workspacePath(workspaceId)}/channels/${encodeURIComponent(channelId)}/memory`;
}

/** Digests of a channel or thread, newest first. Empty when nothing is readable. */
export function listMemoryDigests(
  workspaceId: string,
  channelId: string,
  options: ListMemoryDigestsOptions = {}
): Promise<MemoryDigestPage> {
  const query = new URLSearchParams();
  if (options.level !== undefined) query.set("level", options.level);
  if (options.threadRootId !== undefined) query.set("threadRootId", options.threadRootId);
  if (options.sinceSeq !== undefined) query.set("sinceSeq", String(options.sinceSeq));
  if (options.sinceLastRead === true) query.set("sinceLastRead", "true");
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.toString();
  const path = `${channelMemoryPath(workspaceId, channelId)}/digests${suffix === "" ? "" : `?${suffix}`}`;
  return memoryRequest(path).then(parseMemoryDigestPage);
}

/** One digest; a 404 `ApiError` when it is missing or hidden. */
export function getMemoryDigest(workspaceId: string, digestId: string): Promise<MemoryDigest> {
  return memoryRequest(
    `${workspacePath(workspaceId)}/memory/digests/${encodeURIComponent(digestId)}`
  ).then(parseMemoryDigestResponse);
}

/** The receipt behind an agent reply's chip; a 404 `ApiError` when there is none. */
export function getRunMemoryReceipt(workspaceId: string, runId: string): Promise<MemoryReceipt> {
  return memoryRequest(
    `${workspacePath(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/memory-receipt`
  ).then(parseMemoryReceiptResponse);
}

export function getMemorySettings(workspaceId: string): Promise<MemorySettings> {
  return memoryRequest(`${workspacePath(workspaceId)}/memory/settings`).then(parseMemorySettings);
}

/** Workspace owner/admin only; a 403 `ApiError` otherwise. */
export function patchWorkspaceMemorySettings(
  workspaceId: string,
  input: PatchWorkspaceMemorySettingsInput
): Promise<WorkspaceMemorySettings> {
  const body: Record<string, unknown> = {};
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.paused !== undefined) body.paused = input.paused;
  return memoryRequest(`${workspacePath(workspaceId)}/memory/settings`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(parseWorkspaceMemorySettings);
}

/** Workspace or channel admin who can read the channel; a 403 `ApiError` otherwise. */
export function patchChannelMemorySettings(
  workspaceId: string,
  channelId: string,
  input: PatchChannelMemorySettingsInput
): Promise<ChannelMemorySettings> {
  const body: Record<string, unknown> = {};
  if (input.excluded !== undefined) body.excluded = input.excluded;
  if (input.paused !== undefined) body.paused = input.paused;
  return memoryRequest(`${channelMemoryPath(workspaceId, channelId)}/settings`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(parseChannelMemorySettings);
}

/** The caller's own pause. The member is the credential's; none is sent. */
export function patchMyMemorySettings(
  workspaceId: string,
  paused: boolean
): Promise<MemberMemorySettings> {
  return memoryRequest(`${workspacePath(workspaceId)}/memory/settings/me`, {
    method: "PATCH",
    body: JSON.stringify({ paused }),
  }).then(parseMemberMemorySettings);
}
