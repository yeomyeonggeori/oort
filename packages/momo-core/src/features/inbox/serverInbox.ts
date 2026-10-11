import { arrayField, bool, num, record, str } from "../../lib/wire";

// =============================================================================
// 서버 인박스 투영의 와이어 모양 (ADR-0199 D6, E2 #3683). 순수 파서다.
//
//   GET  /v1/workspaces/{ws}/inbox?filter=&cursor=&limit=&muted=
//   PUT  /v1/workspaces/{ws}/inbox/{id}/read
//   POST /v1/workspaces/{ws}/inbox/read-all?filter=&muted=
//
// 서버가 준 사실만 옮긴다. 커서는 불투명 토큰이라 해석하지 않고 그대로 돌려보낸다.
// 시각은 RFC3339 마이크로초(`…:07.123456Z`)인데, 소수 3자리를 넘는 문자열을
// `Date.parse`가 어떻게 읽는지는 엔진마다 다르다(Hermes 포함). 그래서 밀리초까지만
// 남기고 읽는다.
// =============================================================================

/** 서버 항목 종류(D2). `kind`는 `reasons[0]`과 같다. */
export type InboxWireKind = "reply_to_me" | "mention" | "thread_reply" | "dm";

export const INBOX_WIRE_KINDS: readonly InboxWireKind[] = [
  "reply_to_me",
  "mention",
  "thread_reply",
  "dm",
];

/** 서버가 받는 필터 값. 「처리할 일」은 서버 필터가 아니다(승인은 따로 합친다). */
export type InboxServerFilter =
  | "all"
  | "unread"
  | "mention"
  | "reply"
  | "dm"
  | "thread";

export interface InboxQuery {
  filter?: InboxServerFilter;
  cursor?: string;
  limit?: number;
  muted?: "hide" | "show";
}

export interface ServerInboxQuoted {
  id: string;
  authorMemberId: string;
  preview: string;
  deleted: boolean;
}

export interface ServerInboxItem {
  id: string;
  kind: InboxWireKind;
  reasons: InboxWireKind[];
  channel: { id: string; name: string | null; kind: string };
  message: {
    id: string;
    seq: number;
    authorMemberId: string;
    preview: string;
    deleted: boolean;
  };
  quotedMessage?: ServerInboxQuoted;
  rootId?: string;
  actorMemberId: string;
  createdAtMs: number;
  readAtMs: number | null;
}

export interface ServerInboxPage {
  items: ServerInboxItem[];
  nextCursor: string | null;
  /** 보이는 안 읽음 수(서버 상한 1000). 필터와 무관한 전체 수다. */
  unreadCount: number;
}

export interface InboxItemReadResult {
  id: string;
  readAtMs: number;
  unreadCount: number;
}

export interface InboxReadAllResult {
  marked: number;
  unreadCount: number;
}

/** RFC3339 → epoch ms. 소수부는 3자리로 자른다. 읽을 수 없으면 `null`. */
export function parseInboxTimeMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function wireKind(raw: unknown): InboxWireKind | null {
  return INBOX_WIRE_KINDS.find((kind) => kind === raw) ?? null;
}

function parseQuoted(raw: unknown): ServerInboxQuoted | undefined {
  const id = str(raw, "id");
  const authorMemberId = str(raw, "authorMemberId");
  if (id === undefined || authorMemberId === undefined) return undefined;
  return {
    id,
    authorMemberId,
    preview: str(raw, "preview") ?? "",
    deleted: bool(raw, "deleted") ?? false,
  };
}

/** 모양이 어긋난 항목은 `null`. 한 줄이 깨졌다고 목록 전체를 버리지 않는다. */
export function parseInboxItem(raw: unknown): ServerInboxItem | null {
  const id = str(raw, "id");
  const kind = wireKind(str(raw, "kind"));
  const channel = record(record(raw)?.channel);
  const message = record(record(raw)?.message);
  const actorMemberId = str(raw, "actorMemberId");
  const createdAtMs = parseInboxTimeMs(str(raw, "createdAt"));
  const channelId = str(channel, "id");
  const messageId = str(message, "id");
  const seq = num(message, "seq");
  const authorMemberId = str(message, "authorMemberId");
  if (
    id === undefined ||
    kind === null ||
    channelId === undefined ||
    messageId === undefined ||
    seq === undefined ||
    authorMemberId === undefined ||
    actorMemberId === undefined ||
    createdAtMs === null
  ) {
    return null;
  }
  const reasons = (arrayField(raw, "reasons") ?? [])
    .map(wireKind)
    .filter((reason): reason is InboxWireKind => reason !== null);
  const readAtRaw = str(raw, "readAt");
  const readAtMs = parseInboxTimeMs(readAtRaw);
  const quoted = parseQuoted(record(raw)?.quotedMessage);
  const rootId = str(raw, "rootId");
  return {
    id,
    kind,
    reasons: reasons.length > 0 ? reasons : [kind],
    channel: {
      id: channelId,
      name: str(channel, "name") ?? null,
      kind: str(channel, "kind") ?? "",
    },
    message: {
      id: messageId,
      seq,
      authorMemberId,
      preview: str(message, "preview") ?? "",
      deleted: bool(message, "deleted") ?? false,
    },
    ...(quoted === undefined ? {} : { quotedMessage: quoted }),
    ...(rootId === undefined ? {} : { rootId }),
    actorMemberId,
    createdAtMs,
    // readAt이 문자열인데 못 읽으면 읽은 것으로 본다(안 읽음으로 되돌려 알림처럼 굴지 않는다).
    readAtMs: readAtRaw === undefined ? null : (readAtMs ?? 0),
  };
}

export function parseInboxPage(raw: unknown): ServerInboxPage | null {
  const items = arrayField(raw, "items");
  if (items === null) return null;
  const nextCursor = str(raw, "nextCursor");
  return {
    items: items
      .map(parseInboxItem)
      .filter((item): item is ServerInboxItem => item !== null),
    nextCursor: nextCursor === undefined || nextCursor === "" ? null : nextCursor,
    unreadCount: Math.max(0, num(raw, "unreadCount") ?? 0),
  };
}

export function parseInboxItemRead(raw: unknown): InboxItemReadResult | null {
  const id = str(raw, "id");
  const readAtMs = parseInboxTimeMs(str(raw, "readAt"));
  if (id === undefined || readAtMs === null) return null;
  return { id, readAtMs, unreadCount: Math.max(0, num(raw, "unreadCount") ?? 0) };
}

export function parseInboxReadAll(raw: unknown): InboxReadAllResult | null {
  const marked = num(raw, "marked");
  if (marked === undefined) return null;
  return { marked, unreadCount: Math.max(0, num(raw, "unreadCount") ?? 0) };
}

export function inboxQueryString(query: InboxQuery): string {
  const params = new URLSearchParams();
  if (query.filter !== undefined && query.filter !== "all") {
    params.set("filter", query.filter);
  }
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.muted !== undefined) params.set("muted", query.muted);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

// ---- 구 서버 판별 ---------------------------------------------------------

/**
 * `GET …/inbox`가 404면 이 서버에는 인박스 투영이 없다(v0.1.20 이하). 404만 그렇다:
 * 5xx·네트워크 오류는 「서버가 없다」가 아니라 장애이므로 후퇴하지 않는다.
 */
export function isInboxAbsentStatus(status: number): boolean {
  return status === 404;
}

// ---- 실시간 ---------------------------------------------------------------

/** 개인 채널. 접미사는 연결 토큰의 `sub`와 바이트 단위로 같아야 해서 대문자다. */
export function readStateRailChannelName(memberId: string): string {
  return `user:read-state#${memberId.toUpperCase()}`;
}

export type InboxEventType =
  | "inbox_item.created"
  | "inbox_item.read"
  | "inbox.read_all";

export interface InboxEvent {
  type: InboxEventType;
  /** `inbox_item.*`의 항목 id. read_all에는 없다. */
  itemId?: string;
}

/**
 * 개인 채널의 발행물이 인박스 신호인가. 페이로드는 id와 시각뿐이고 본문이 없어서,
 * 받으면 목록을 다시 조회한다. 같은 채널의 read-state 프레임 등은 `null`.
 */
export function asInboxEvent(data: unknown): InboxEvent | null {
  const frame = record(data);
  const type = str(frame, "type");
  if (
    type !== "inbox_item.created" &&
    type !== "inbox_item.read" &&
    type !== "inbox.read_all"
  ) {
    return null;
  }
  const itemId = str(record(frame?.payload), "item_id");
  return itemId === undefined ? { type } : { type, itemId };
}
