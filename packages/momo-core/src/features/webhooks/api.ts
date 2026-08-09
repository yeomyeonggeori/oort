// =============================================================================
// REST client for incoming webhook installations (#1202, openapi `webhooks`).
//
// Four operations, all already on the server and all documented; nothing here
// invents wire. Transcribed from docs/api/openapi.yaml, not guessed:
//   GET    /v1/workspaces/{ws}/webhooks                     listWebhookInstallations
//   POST   /v1/workspaces/{ws}/webhooks                     createWebhookInstallation
//   POST   /v1/workspaces/{ws}/webhooks/{id}/rotate         rotateWebhookSecret
//   DELETE /v1/workspaces/{ws}/webhooks/{id}                revokeWebhookInstallation
//
// The transport is a small funnel of its own rather than an addition to
// features/settings/api.ts, for the same reason that file states in its own
// header: parallel tickets edit the settings surface, and the shared client is
// the file most likely to collide. It reuses `ApiError`, `fetchWithDeadline`
// and the in-memory access token, so there is still exactly one auth path.
//
// ## The secret boundary (ADR-0004 in spirit, ADR-0115 in letter)
//
// Exactly two of these four responses can carry a credential — create and
// rotate — and the server reveals it once, never persists it in raw form, and
// answers `no-store`. Two consequences are held here rather than left to the
// caller:
//
//   1. Those two requests are sent with `cache: "no-store"`, so the browser's
//      HTTP cache is not asked to hold a body that the server refuses to hold.
//   2. NOTHING in this file logs. Not the URL, not the body, not the failure.
//      A `console.warn(error)` on a create failure would be enough to put a
//      one-time secret into a devtools buffer that outlives the panel.
//
// The list response carries no secret by contract ("Secrets and Slack URL
// tokens are never returned"), and `parseInstallations` (./model) rebuilds each
// row field by field so a server that broke that promise still cannot paint one.
// =============================================================================

import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";
import { responseRecord } from "../../lib/wire";

async function webhookRequest(
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    // The wire message is read for the STATUS only. Callers render Korean copy
    // keyed by status (`webhookFailureMessage`) instead of this string, so an
    // operator English sentence — or anything a broken server put in it — never
    // reaches the panel. It stays on the error for diagnostics.
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return responseRecord(res.json<unknown>());
}

function collection(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/webhooks`;
}

function installation(workspaceId: string, installationId: string): string {
  return `${collection(workspaceId)}/${encodeURIComponent(installationId)}`;
}

/** Human workspace owner/admin only; a member gets 403 and the panel says who can. */
export function listWebhookInstallations(workspaceId: string): Promise<unknown> {
  return webhookRequest(collection(workspaceId));
}

export interface CreateWebhookInput {
  channelId: string;
  mode: string;
  label: string;
}

/** 201. The only response besides rotate that ever carries a raw credential. */
export function createWebhookInstallation(
  workspaceId: string,
  input: CreateWebhookInput
): Promise<unknown> {
  return webhookRequest(collection(workspaceId), {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

/**
 * Replacement credential, revealed once. `overlapSeconds` is how long the
 * PREVIOUS credential keeps working, so a sender can be updated without a gap;
 * 0..604800 per the spec, and the panel offers one day.
 */
export function rotateWebhookSecret(
  workspaceId: string,
  installationId: string,
  overlapSeconds: number
): Promise<unknown> {
  return webhookRequest(`${installation(workspaceId, installationId)}/rotate`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ overlapSeconds }),
  });
}

/** Irreversible: every credential for this installation dies immediately. */
export function revokeWebhookInstallation(
  workspaceId: string,
  installationId: string
): Promise<unknown> {
  return webhookRequest(installation(workspaceId, installationId), {
    method: "DELETE",
  });
}
