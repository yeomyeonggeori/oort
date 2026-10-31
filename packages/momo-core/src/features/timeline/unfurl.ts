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
  // ADR-0170 amendment 2026-10-31. Every field below is optional: an older server omits
  // them all, and a missing one means "not known", never "empty".
  /** og:site_name, at most 100 characters. */
  siteName?: string;
  /** Authenticated same-origin proxy path of the site icon. Never a remote icon URL. */
  iconUrl?: string;
  /** Pixels, 1..16384. Present together with `imageHeight`, or not at all. */
  imageWidth?: number;
  imageHeight?: number;
  /** The server only ever sends `true`; absent means "not known to be a video". */
  isVideo?: boolean;
}

/** The server's bound for a picture side (the migration's CHECK says the same). */
export const UNFURL_IMAGE_SIDE_MAX = 16_384;

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

/** The site-icon proxy path (`…/unfurls/{id}/icon`), the only form an icon is ever given in. */
export function isUnfurlIconPath(value: string): boolean {
  return /^\/v1\/workspaces\/[^/?#]+\/unfurls\/[^/?#]+\/icon$/.test(value);
}

/** Either of a card's two proxy paths: the preview picture or the site icon. */
export function isUnfurlProxyPath(value: string): boolean {
  return isUnfurlImagePath(value) || isUnfurlIconPath(value);
}

function sizeField(
  source: Record<string, unknown>,
  camel: string,
  snake: string
): number | undefined {
  const value = source[camel] ?? source[snake];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= UNFURL_IMAGE_SIDE_MAX
    ? value
    : undefined;
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
  const siteName = stringField(source, "siteName", "site_name");
  const iconUrl = stringField(source, "iconUrl", "icon_url");
  // A size is a pair: half of one, or a value outside the server's bound, is no size.
  const imageWidth = sizeField(source, "imageWidth", "image_width");
  const imageHeight = sizeField(source, "imageHeight", "image_height");
  const isVideo = (source.isVideo ?? source.is_video) === true;
  return {
    id,
    messageId,
    url,
    status,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(domain ? { domain } : {}),
    ...(imageUrl && isUnfurlImagePath(imageUrl) ? { imageUrl } : {}),
    ...(siteName ? { siteName } : {}),
    ...(iconUrl && isUnfurlIconPath(iconUrl) ? { iconUrl } : {}),
    ...(imageWidth !== undefined && imageHeight !== undefined
      ? { imageWidth, imageHeight }
      : {}),
    ...(isVideo ? { isVideo: true } : {}),
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
