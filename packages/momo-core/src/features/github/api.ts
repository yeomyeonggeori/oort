// =============================================================================
// REST client for the GitHub App notification surface (ADR-0205, server #3954/#3947).
//
//   GET    /v1/integrations/github/app                          operator: status
//   POST   /v1/integrations/github/app/manifest                 operator: start registration
//   PUT    /v1/integrations/github/app                          operator: paste an App (write-only)
//   GET    /v1/integrations/github/installations                operator: unlinked installations
//   POST   /v1/integrations/github/installations/{id}/link      operator: attach to a workspace
//   GET    /v1/workspaces/{ws}/github[?channelId=]              owner/admin: installations + subscriptions
//   POST   /v1/workspaces/{ws}/github/link                      owner/admin: mint the install URL
//   POST   /v1/workspaces/{ws}/github/subscriptions             owner/admin: subscribe a channel
//   DELETE /v1/workspaces/{ws}/github/subscriptions/{id}        owner/admin
//
// The routes were transcribed from the server source of PR #4070 (this tree has no engine yet),
// so every response is `runtime-unverified` until the two meet. Failures keep the server's
// `error.code`: the 409s of this surface are told apart by code only.
//
// ## What never travels through here
// The pasted private key and webhook secret go out in one PUT body and are not kept: nothing in
// this file logs, caches or returns them. The response is the status again (no secret by contract),
// and `parseAppStatus` rebuilds it field by field.
// =============================================================================

import { authedRequest } from "../../lib/api";
import {
  parseAppStatus,
  parseLinkStart,
  parseManifestStart,
  parseSubscription,
  parseUnlinkedInstallations,
  parseWorkspaceOverview,
  type GithubAppStatus,
  type GithubLinkStart,
  type GithubManifestStart,
  type GithubSubscription,
  type GithubUnlinkedInstallation,
  type GithubWorkspaceOverview,
} from "./model";

const APP = "/v1/integrations/github/app";

function workspaceBase(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/github`;
}

async function json(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await authedRequest(path, init);
  return res.json<unknown>();
}

// ---- instance operator ---------------------------------------------------------

export async function fetchGithubAppStatus(): Promise<GithubAppStatus> {
  return parseAppStatus(await json(APP));
}

export type GithubOwnerChoice =
  | { ownerType: "user" }
  | { ownerType: "organization"; organization: string };

export async function startGithubManifest(owner: GithubOwnerChoice): Promise<GithubManifestStart> {
  return parseManifestStart(
    await json(`${APP}/manifest`, { method: "POST", body: JSON.stringify(owner) })
  );
}

export interface PasteGithubAppInput {
  appId: number;
  slug: string;
  clientId: string;
  ownerLogin: string;
  ownerType: "User" | "Organization";
  privateKey: string;
  webhookSecret: string;
}

export async function pasteGithubApp(input: PasteGithubAppInput): Promise<GithubAppStatus> {
  return parseAppStatus(await json(APP, { method: "PUT", body: JSON.stringify(input) }));
}

export async function listUnlinkedInstallations(): Promise<GithubUnlinkedInstallation[]> {
  return parseUnlinkedInstallations(await json("/v1/integrations/github/installations"));
}

export async function linkInstallationToWorkspace(
  installationId: number,
  workspaceId: string
): Promise<void> {
  await authedRequest(
    `/v1/integrations/github/installations/${encodeURIComponent(String(installationId))}/link`,
    { method: "POST", body: JSON.stringify({ workspaceId }) }
  );
}

// ---- workspace owner/admin --------------------------------------------------------

export async function fetchGithubOverview(
  workspaceId: string,
  channelId?: string
): Promise<GithubWorkspaceOverview> {
  const query = channelId === undefined ? "" : `?channelId=${encodeURIComponent(channelId)}`;
  return parseWorkspaceOverview(await json(`${workspaceBase(workspaceId)}${query}`));
}

export async function startGithubLink(workspaceId: string): Promise<GithubLinkStart> {
  return parseLinkStart(
    await json(`${workspaceBase(workspaceId)}/link`, { method: "POST", body: "{}" })
  );
}

export interface SubscribeInput {
  channelId: string;
  installationId: number;
  /** `owner/name`. */
  repository: string;
  features: readonly string[];
  /**
   * 비공개 저장소를 공개 채널에 연결하는 것을 사람이 두 번째 단계에서 확인했다.
   * 확인하지 않았으면 이 칸을 보내지 않는다(서버는 false 를 기본으로 보고 409 로 답한다).
   */
  confirmPrivate?: boolean;
}

export async function subscribeGithub(
  workspaceId: string,
  input: SubscribeInput
): Promise<GithubSubscription> {
  const body: Record<string, unknown> = {
    channelId: input.channelId,
    installationId: input.installationId,
    repository: input.repository,
    features: [...input.features],
  };
  if (input.confirmPrivate === true) body.confirmPrivate = true;
  return parseSubscription(
    await json(`${workspaceBase(workspaceId)}/subscriptions`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

export async function unsubscribeGithub(workspaceId: string, subscriptionId: string): Promise<void> {
  await authedRequest(
    `${workspaceBase(workspaceId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" }
  );
}
