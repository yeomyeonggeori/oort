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

/**
 * A preview's picture path (`…/unfurl-previews/{id}/image`, ADR-0170 증보 2026-11-01): the card
 * of a link that is still in the composer has no card row, so its picture has a path of its own.
 */
export function isUnfurlPreviewImagePath(value: string): boolean {
  return /^\/v1\/workspaces\/[^/?#]+\/unfurl-previews\/[^/?#]+\/image$/.test(value);
}

/** A preview's site-icon path (`…/unfurl-previews/{id}/icon`). */
export function isUnfurlPreviewIconPath(value: string): boolean {
  return /^\/v1\/workspaces\/[^/?#]+\/unfurl-previews\/[^/?#]+\/icon$/.test(value);
}

/**
 * Any of the four paths a client is ever given for a link card's remote image: a stored card's
 * picture or icon, or a preview's picture or icon. Nothing else may carry a bearer token.
 */
export function isUnfurlProxyPath(value: string): boolean {
  return (
    isUnfurlImagePath(value) ||
    isUnfurlIconPath(value) ||
    isUnfurlPreviewImagePath(value) ||
    isUnfurlPreviewIconPath(value)
  );
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
 * The optional keys a card and a preview share, decoded the same way: bad optional metadata is
 * dropped, never fatal. `imagePath`/`iconPath` say which proxy path family is the only one a
 * picture or icon may name (a stored card's, or a preview's).
 */
function optionalCardFields(
  source: Record<string, unknown>,
  imagePath: (value: string) => boolean,
  iconPath: (value: string) => boolean
): Omit<MessageUnfurl, "id" | "messageId" | "url" | "status"> {
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
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(domain ? { domain } : {}),
    ...(imageUrl && imagePath(imageUrl) ? { imageUrl } : {}),
    ...(siteName ? { siteName } : {}),
    ...(iconUrl && iconPath(iconUrl) ? { iconUrl } : {}),
    ...(imageWidth !== undefined && imageHeight !== undefined
      ? { imageWidth, imageHeight }
      : {}),
    ...(isVideo ? { isVideo: true } : {}),
  };
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

  return {
    id,
    messageId,
    url,
    status,
    ...optionalCardFields(source, isUnfurlImagePath, isUnfurlIconPath),
  };
}

// -----------------------------------------------------------------------------
// The card of a link that is still in the composer (ADR-0170 증보 2026-11-01, #4884).
//
// The server answers `POST …/channels/{ch}/unfurl-previews` with `ok` and a card, or with `failed`
// and nothing else: a preview never says why there is none, so neither state is an error to show.
// The picture and icon of an `ok` preview come through the two preview paths and no others.
// -----------------------------------------------------------------------------

/** A preview that has a card: the keys of a stored card without `messageId`, plus its own `id`. */
export interface UnfurlPreviewCard
  extends Omit<MessageUnfurl, "messageId" | "status"> {
  status: "ok";
}

/** No preview, whatever the reason. Render nothing. */
export interface UnfurlPreviewFailed {
  status: "failed";
  url: string;
}

export type UnfurlPreview = UnfurlPreviewCard | UnfurlPreviewFailed;

/**
 * Decode the answer of the preview request. A bad status or address drops the whole answer
 * (`null`); an `ok` without an `id` is dropped too, since nothing it names could be fetched.
 * Optional metadata is decoded as for a stored card, except that a picture or icon may name a
 * preview path only.
 */
export function unfurlPreviewFromWire(value: unknown): UnfurlPreview | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const url = stringField(source, "url");
  const status = stringField(source, "status");
  if (!url || !isHttpUrl(url)) return null;
  if (status === "failed") return { status: "failed", url };
  if (status !== "ok") return null;
  const id = stringField(source, "id");
  if (!id) return null;
  return {
    id,
    url,
    status: "ok",
    ...optionalCardFields(
      source,
      isUnfurlPreviewImagePath,
      isUnfurlPreviewIconPath
    ),
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

// =============================================================================
// Link card display model (#4882, owner 2026-10-31).
//
// The decoder above says what the server *knows*. This section says what a
// person *sees* when a piece is missing, decided once so the web and the phone
// (#4883) cannot drift. It still knows neither React nor a transport: the web
// renders a model with classes, the phone with styles.
//
// `docs/design-system/link-cards.md` is the readable form of the table. Every
// row of it is a branch below, and `unfurl.test.ts` has one case per row.
//
//   picture missing            -> an icon tile (site icon, else the globe)
//   picture failed to load     -> the same tile, never a broken image
//   description missing/same   -> no description line
//   title missing              -> site name, then the domain, in the title slot
//   site name                  -> never in the address line, which is the real
//                                 domain every time (a page cannot change it)
//   small or square picture    -> shown whole in a 64 box, never cropped
//   video                      -> a play mark on the picture, link opens the page
//   no title and no picture    -> no card, only the link (no error text)
//   many links                 -> cards for the first 3 distinct links
// =============================================================================

/** This device's choice: small cards (the default), large cards, or none. */
export type UnfurlSize = "compact" | "rich" | "off";

export const DEFAULT_UNFURL_SIZE: UnfurlSize = "compact";

/** Cards per message: the first distinct links in link order, never more. */
export const UNFURL_MAX_CARDS = 3;

/** A picture is "wide" only at this width or more AND at this ratio or more. */
export const UNFURL_WIDE_PICTURE_MIN_WIDTH = 300;
export const UNFURL_WIDE_PICTURE_MIN_RATIO = 1.3;

/** `wide` may be cropped to its box; `small` is shown whole inside a square box. */
export type UnfurlPictureShape = "wide" | "small";

export type UnfurlPicture =
  | { kind: "image"; imageUrl: string; shape: UnfurlPictureShape }
  | { kind: "tile" };

/** `rich` puts the text above a large picture; `compact` is the small row. */
export type UnfurlLayout = "compact" | "rich";

export interface UnfurlCardModel {
  id: string;
  /** The original page. A video card opens it as well; nothing plays inside the card. */
  url: string;
  layout: UnfurlLayout;
  /** The real address host, never the site name: server `domain`, else read from `url`. */
  domain: string;
  /** Page title, else site name, else the domain. Plain text, never markup. */
  title: string;
  /** Absent when the page gave none or it only repeats the title. */
  description?: string;
  picture: UnfurlPicture;
  /** Authenticated icon proxy path. Absent means the globe. */
  iconUrl?: string;
  isVideo: boolean;
}

export interface UnfurlCardOptions {
  size: UnfurlSize;
  /** The picture could not be fetched or decoded: draw the icon tile instead. */
  imageFailed?: boolean;
}

// The server strips these from titles it extracts now; rows stored before that
// still carry them, and a right-to-left override can reorder what follows it.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

function plainText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

function hostOfUrl(url: string): string | undefined {
  const match = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/i.exec(url);
  const host = match?.[1]?.toLowerCase();
  return host ? host : undefined;
}

/** Same page, same key: host case, a bare `/` path and the `#fragment` do not make a new link. */
function distinctKey(url: string): string {
  const noFragment = url.trim().replace(/#.*$/, "");
  const match = /^(https?:\/\/[^/?#]*)(.*)$/i.exec(noFragment);
  if (!match) return noFragment;
  const rest = match[2] ?? "";
  const path = rest === "" || rest.startsWith("?") ? `/${rest}` : rest;
  return `${(match[1] ?? "").toLowerCase()}${path}`;
}

/**
 * A declared size is a claim by the page, so it is used only to sort the picture
 * into a box, never to size one. A missing size is "not known", which is the old
 * behavior: the picture is cropped to its box.
 */
function pictureShape(width: number | undefined, height: number | undefined): UnfurlPictureShape {
  if (width === undefined || height === undefined) return "wide";
  return width < UNFURL_WIDE_PICTURE_MIN_WIDTH || width / height < UNFURL_WIDE_PICTURE_MIN_RATIO
    ? "small"
    : "wide";
}

/** An `ok` row with neither a title nor a picture has nothing to put in a card. */
function hasCardContent(unfurl: MessageUnfurl): boolean {
  return plainText(unfurl.title) !== undefined || Boolean(unfurl.imageUrl);
}

export function isUnfurlPending(unfurl: MessageUnfurl): boolean {
  return unfurl.status === "pending";
}

/**
 * The rows a message may draw, in link order: the first 3 distinct links, then
 * only those that are loading or have something to show. A failed, blocked or
 * empty one leaves just the link. The server stops at 3 too (ADR-0170 D10); this
 * keeps an old or odd answer from drawing a fourth.
 */
export function visibleUnfurls(unfurls: readonly MessageUnfurl[]): MessageUnfurl[] {
  const seen = new Set<string>();
  const firstDistinct: MessageUnfurl[] = [];
  for (const unfurl of unfurls) {
    const key = distinctKey(unfurl.url);
    if (seen.has(key)) continue;
    seen.add(key);
    firstDistinct.push(unfurl);
    if (firstDistinct.length === UNFURL_MAX_CARDS) break;
  }
  return firstDistinct.filter(
    (unfurl) => isUnfurlPending(unfurl) || (unfurl.status === "ok" && hasCardContent(unfurl))
  );
}

/** What one `ok` card shows, or `null` when it draws no card at all. */
export function unfurlCardModel(
  unfurl: MessageUnfurl,
  { size, imageFailed = false }: UnfurlCardOptions
): UnfurlCardModel | null {
  if (size === "off" || unfurl.status !== "ok" || !hasCardContent(unfurl)) return null;
  const domain =
    plainText(unfurl.domain) ?? hostOfUrl(unfurl.url) ?? unfurl.url;
  const title = plainText(unfurl.title) ?? plainText(unfurl.siteName) ?? domain;
  const said = plainText(unfurl.description);
  const description =
    said !== undefined && said.toLowerCase() !== title.toLowerCase() ? said : undefined;
  const picture: UnfurlPicture =
    unfurl.imageUrl && !imageFailed
      ? {
          kind: "image",
          imageUrl: unfurl.imageUrl,
          shape: pictureShape(unfurl.imageWidth, unfurl.imageHeight),
        }
      : { kind: "tile" };
  // Large needs a picture that can fill the 1.91:1 frame; anything else is the
  // small row, so a large card never opens an empty or heavily cropped frame.
  const layout: UnfurlLayout =
    size === "rich" && picture.kind === "image" && picture.shape === "wide"
      ? "rich"
      : "compact";
  return {
    id: unfurl.id,
    url: unfurl.url,
    layout,
    domain,
    title,
    ...(description !== undefined ? { description } : {}),
    picture,
    ...(unfurl.iconUrl ? { iconUrl: unfurl.iconUrl } : {}),
    isVideo: unfurl.isVideo === true,
  };
}
