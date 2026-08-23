// =============================================================================
// Link-unfurl state shared by web and the future phone surface (ADR-0170 D5).
//
// This module deliberately knows neither React nor a network transport. The
// server owns fetching and sanitising remote pages; clients only merge the
// resulting projection. A failed/blocked fetch and a server with unfurls
// disabled both render as absence, so neither state invents an error card.
// =============================================================================

export type UnfurlStatus = "pending" | "ok" | "failed" | "blocked";

export interface MessageUnfurl {
  id: string;
  messageId: string;
  url: string;
  status: UnfurlStatus;
  title?: string;
  description?: string;
  domain?: string;
  /** Authenticated same-origin proxy path. Never a remote image URL. */
  imageUrl?: string;
}

export interface WorkspaceUnfurlSettings {
  enabled: boolean;
  updatedAtMs?: number;
}

/** message id (case-folded) -> server projection; an empty list is a tombstone. */
export type UnfurlMap = Record<string, readonly MessageUnfurl[]>;

export function emptyUnfurls(): UnfurlMap {
  return {};
}

function stringField(
  source: Record<string, unknown>,
  camel: string,
  snake?: string
): string | undefined {
  const value = source[camel] ?? (snake ? source[snake] : undefined);
  return typeof value === "string" ? value : undefined;
}

export function isUnfurlImagePath(value: string): boolean {
  return /^\/v1\/workspaces\/[^/?#]+\/unfurls\/[^/?#]+\/image$/.test(value);
}

/** Strict enough to prevent a client from turning an unfurl into a script URL. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * Decode either the REST camelCase row or the realtime snake_case row.
 * Optional bad metadata is dropped; a bad identity/status drops the whole row.
 */
export function messageUnfurlFromWire(value: unknown): MessageUnfurl | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = stringField(source, "id");
  const messageId = stringField(source, "messageId", "message_id");
  const url = stringField(source, "url");
  const status = stringField(source, "status");
  if (
    !id ||
    !messageId ||
    !url ||
    !isHttpUrl(url) ||
    (status !== "pending" &&
      status !== "ok" &&
      status !== "failed" &&
      status !== "blocked")
  ) {
    return null;
  }

  const title = stringField(source, "title");
  const description = stringField(source, "description");
  const domain = stringField(source, "domain");
  const imageUrl = stringField(source, "imageUrl", "image_url");
  return {
    id,
    messageId,
    url,
    status,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(domain ? { domain } : {}),
    ...(imageUrl && isUnfurlImagePath(imageUrl) ? { imageUrl } : {}),
  };
}

function key(messageId: string): string {
  return messageId.toLowerCase();
}

export function unfurlsFor(
  map: UnfurlMap,
  messageId: string
): readonly MessageUnfurl[] {
  return map[key(messageId)] ?? [];
}

/** Live frames are newer than any cold read they may race, so they replace. */
export function replaceMessageUnfurls(
  map: UnfurlMap,
  messageId: string,
  unfurls: readonly MessageUnfurl[]
): UnfurlMap {
  return { ...map, [key(messageId)]: unfurls };
}

/**
 * Merge a REST answer only when no live answer (including a removal tombstone)
 * has already arrived for this message.
 */
export function mergeColdMessageUnfurls(
  map: UnfurlMap,
  messageId: string,
  unfurls: readonly MessageUnfurl[]
): UnfurlMap {
  const folded = key(messageId);
  if (Object.prototype.hasOwnProperty.call(map, folded)) return map;
  return { ...map, [folded]: unfurls };
}

export function clearMessageUnfurls(
  map: UnfurlMap,
  messageId: string
): UnfurlMap {
  return replaceMessageUnfurls(map, messageId, []);
}

/** The four rendering states required by ADR-0170 D5. */
export type UnfurlRenderState =
  | { kind: "empty" }
  | { kind: "pending"; unfurl: MessageUnfurl }
  | { kind: "ok"; unfurl: MessageUnfurl }
  | { kind: "quiet"; reason: "failed" | "blocked" };

export function unfurlRenderState(
  unfurl: MessageUnfurl | null | undefined
): UnfurlRenderState {
  if (!unfurl) return { kind: "empty" };
  if (unfurl.status === "pending") return { kind: "pending", unfurl };
  if (unfurl.status === "ok") return { kind: "ok", unfurl };
  return { kind: "quiet", reason: unfurl.status };
}

/** Avoid accessory requests for messages that cannot possibly contain a link. */
export function messageMayHaveUnfurls(body: string | undefined): boolean {
  return typeof body === "string" && /https?:\/\/\S+/i.test(body);
}
