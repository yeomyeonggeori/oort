// =============================================================================
// REST client for team memory v2 (ADR-0196 / #3164). Server: routes/memory.rs.
//
//   GET   /v1/workspaces/{ws}/channels/{ch}/memory/digests
//   GET   /v1/workspaces/{ws}/memory/digests/{id}
//   GET   /v1/workspaces/{ws}/agent-runs/{run}/memory-receipt
//   GET   /v1/workspaces/{ws}/channels/{ch}/memory/proposals       「기억해 둘게요」 cards (#3169)
//   POST  /v1/workspaces/{ws}/memory/proposals/{id}/accept
//   POST  /v1/workspaces/{ws}/memory/proposals/{id}/reject
//   GET   /v1/workspaces/{ws}/memory/settings
//   PATCH /v1/workspaces/{ws}/memory/settings            workspace switch (admin)
//   PATCH /v1/workspaces/{ws}/memory/settings/me         personal pause
//   PATCH /v1/workspaces/{ws}/channels/{ch}/memory/settings   exclude / pause
//   GET   /v1/workspaces/{ws}/memory/notice              what memory sends to which provider (#3212)
//   POST  /v1/workspaces/{ws}/memory/reset               erase all memory of the workspace (owner/admin, #3212)
//
//   GET    /v1/workspaces/{ws}/memory/items                    memory browser list / search   (#3208)
//   GET    /v1/workspaces/{ws}/memory/items/{id}               one item + evidence back-links
//   GET    /v1/workspaces/{ws}/memory/items/{id}/evidence      source messages
//   GET    /v1/workspaces/{ws}/memory/items/{id}/events        lifecycle ledger
//   PATCH  /v1/workspaces/{ws}/memory/items/{id}               edit (new item supersedes the old)
//   DELETE /v1/workspaces/{ws}/memory/items/{id}               forget (permanent)
//   POST   /v1/workspaces/{ws}/memory/items/{id}/events/{event}/revert   undo a consolidation event (#3172)
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
  parseEditedMemoryItem,
  parseForgottenCount,
  parseRevertedConsolidation,
  parseMemoryItemDetail,
  parseMemoryItemEvents,
  parseMemoryItemEvidence,
  parseMemoryItemPage,
  parseMemberMemorySettings,
  parseMemoryDigestPage,
  parseMemoryDigestResponse,
  parseMemoryProposalDecision,
  parseMemoryProposalList,
  parseMemoryNotice,
  parseMemoryReceiptResponse,
  parseMemoryResetResult,
  parseMemorySettings,
  parseWorkspaceMemorySettings,
  type ChannelMemorySettings,
  type EditedMemoryItem,
  type EditMemoryItemInput,
  type ListMemoryDigestsOptions,
  type ListMemoryItemsOptions,
  type MemoryEvidenceLink,
  type MemoryItemDetail,
  type MemoryItemEvent,
  type MemoryItemPage,
  type MemoryNotice,
  type MemoryResetResult,
  type RevertedConsolidation,
  type ListMemoryProposalsOptions,
  type MemberMemorySettings,
  type MemoryDigest,
  type MemoryDigestPage,
  type MemoryProposal,
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

/**
 * The 「기억해 둘게요」 proposals of a channel, newest first (default: the pending ones). An agent
 * only proposes; nothing here is a memory until a person accepts. A channel the caller cannot read
 * is an empty list, not an error — do not treat empty as "no proposals exist".
 */
export function listMemoryProposals(
  workspaceId: string,
  channelId: string,
  options: ListMemoryProposalsOptions = {}
): Promise<MemoryProposal[]> {
  const query = new URLSearchParams();
  if (options.status !== undefined) query.set("status", options.status);
  if (options.runId !== undefined) query.set("runId", options.runId);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.toString();
  const path = `${channelMemoryPath(workspaceId, channelId)}/proposals${suffix === "" ? "" : `?${suffix}`}`;
  return memoryRequest(path).then(parseMemoryProposalList);
}

/**
 * Accept a proposal — it becomes a confirmed memory of the channel. Any active member who can read
 * the channel may; the deciding member is the credential's (none is sent). 403 when the caller may
 * not decide (or the id is unknown), 409 when it was already decided, expired, memory is off for the
 * channel, or its messages changed since.
 */
export function acceptMemoryProposal(
  workspaceId: string,
  proposalId: string
): Promise<MemoryProposal> {
  return memoryRequest(
    `${workspacePath(workspaceId)}/memory/proposals/${encodeURIComponent(proposalId)}/accept`,
    { method: "POST", body: JSON.stringify({}) }
  ).then(parseMemoryProposalDecision);
}

/** Reject a proposal — nothing is remembered. Same authority and errors as accepting. */
export function rejectMemoryProposal(
  workspaceId: string,
  proposalId: string
): Promise<MemoryProposal> {
  return memoryRequest(
    `${workspacePath(workspaceId)}/memory/proposals/${encodeURIComponent(proposalId)}/reject`,
    { method: "POST", body: JSON.stringify({}) }
  ).then(parseMemoryProposalDecision);
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

function itemPath(workspaceId: string, itemId: string): string {
  return `${workspacePath(workspaceId)}/memory/items/${encodeURIComponent(itemId)}`;
}

/**
 * Memory browser list (newest first, keyset `nextCursor`), or — with `q` — the ranked keyword
 * search over current items. Empty when nothing is readable; never an error for a hidden channel.
 */
export function listMemoryItems(
  workspaceId: string,
  options: ListMemoryItemsOptions = {}
): Promise<MemoryItemPage> {
  const query = new URLSearchParams();
  if (options.channelId !== undefined) query.set("channelId", options.channelId);
  if (options.kind !== undefined) query.set("kind", options.kind);
  if (options.status !== undefined) query.set("status", options.status);
  if (options.q !== undefined && options.q.trim() !== "") query.set("q", options.q.trim());
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.toString();
  return memoryRequest(
    `${workspacePath(workspaceId)}/memory/items${suffix === "" ? "" : `?${suffix}`}`
  ).then(parseMemoryItemPage);
}

/** One item with its evidence; a 404 `ApiError` when it is missing or hidden (indistinguishable). */
export function getMemoryItem(workspaceId: string, itemId: string): Promise<MemoryItemDetail> {
  return memoryRequest(itemPath(workspaceId, itemId)).then(parseMemoryItemDetail);
}

/** Source message ids (with channel and seq) to link back to; never message text. */
export function getMemoryItemEvidence(
  workspaceId: string,
  itemId: string
): Promise<MemoryEvidenceLink[]> {
  return memoryRequest(`${itemPath(workspaceId, itemId)}/evidence`).then(parseMemoryItemEvidence);
}

/** The lifecycle ledger of an item, oldest first. */
export function getMemoryItemEvents(
  workspaceId: string,
  itemId: string
): Promise<MemoryItemEvent[]> {
  return memoryRequest(`${itemPath(workspaceId, itemId)}/events`).then(parseMemoryItemEvents);
}

/**
 * Edit an item: the server adds a new curated item (same evidence) that supersedes it and keeps the
 * old one as history. Anyone who can read the item may edit it; a 404 `ApiError` otherwise (and for
 * a missing id), 409 when the item is no longer current or an identical one exists, 422 for text
 * the server refuses (empty, over 600 characters, unchanged, secret-shaped).
 */
export function editMemoryItem(
  workspaceId: string,
  itemId: string,
  input: EditMemoryItemInput
): Promise<EditedMemoryItem> {
  const body: Record<string, unknown> = { body: input.body };
  if (input.kind !== undefined) body.kind = input.kind;
  return memoryRequest(itemPath(workspaceId, itemId), {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(parseEditedMemoryItem);
}

/**
 * Forget an item for good (the item and its older versions are deleted; there is no undo).
 * Resolves to how many versions were removed. 404 like edit; 409 when a newer version exists.
 */
export function forgetMemoryItem(workspaceId: string, itemId: string): Promise<number> {
  return memoryRequest(itemPath(workspaceId, itemId), { method: "DELETE" }).then(
    parseForgottenCount
  );
}

/**
 * Undo one consolidation event of an item — a merge, a decision closing or a decay (ADR-0196 D4/D9).
 * Anyone who can read the item may (guests: 403); a 404 `ApiError` for a missing/unreadable item or event,
 * 409 when the change no longer stands or would bring back forgotten content.
 */
export function revertMemoryConsolidation(
  workspaceId: string,
  itemId: string,
  eventId: string
): Promise<RevertedConsolidation> {
  return memoryRequest(`${itemPath(workspaceId, itemId)}/events/${encodeURIComponent(eventId)}/revert`, {
    method: "POST",
  }).then(parseRevertedConsolidation);
}

/**
 * 「팀 고지」: what team memory sends to which provider (provider host + model id, local embeddings, the
 * kinds of content read). Any active human member may read it; agents get 403.
 */
export function getMemoryNotice(workspaceId: string): Promise<MemoryNotice> {
  return memoryRequest(`${workspacePath(workspaceId)}/memory/notice`).then(parseMemoryNotice);
}

/**
 * Erase every memory row of the workspace for good (owner/admin only; 403 otherwise). The caller passes the
 * `resetEpoch` it displayed: a stale value is a 409 and erases nothing (a double click, a retry after success).
 * There is no undo. Resolves to the new epoch and per-table counts.
 */
export function resetWorkspaceMemory(
  workspaceId: string,
  expectedEpoch: number
): Promise<MemoryResetResult> {
  return memoryRequest(`${workspacePath(workspaceId)}/memory/reset`, {
    method: "POST",
    body: JSON.stringify({ confirm: true, expectedEpoch }),
  }).then(parseMemoryResetResult);
}
