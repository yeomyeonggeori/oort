import { ApiError, authedRequest, type Channel, type MembershipRole } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { arrayField, bool, num, record, responseRecord, str, WireShapeError } from "../../lib/wire";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// 공개 채널 둘러보기 · 스스로 참여 (ADR-0224 D3 · D4 · D8). 웹(#5842)과 폰(#5846)이 같이 쓴다.
//
// 서버 계약은 E2(#5838)의 두 라우트다.
//   GET  /v1/workspaces/{ws}/channels/browse?q=&cursor=&limit=   켜진(browse_listed) · 보관 안 된 공개 채널
//   POST /v1/workspaces/{ws}/channels/{ch}/members/me             본문 없음, 늘 200 { channel, newlyJoined }
//
// 서버는 참여 여부로 줄을 세우지 않는다(차례 `lower(name)` → `id`). 「참여하지 않은 채널 먼저」는 화면의 일이고
// 그 나눔은 여기 한 곳(`splitBrowseRows`)이다. 오류에 `error.code` 가 없어서 거절은 상태 코드로만 가른다:
// 403 은 게스트 · 정지 · 사람 아닌 토큰이 모두 같은 한 종류다(화면은 그 사람에게 문을 세우지 않으므로 거의 오지 않는다).
// =============================================================================

/** 서버가 받는 `q` 의 길이 상한(넘으면 400). 입력 칸이 이 길이에서 멈춘다. */
export const CHANNEL_BROWSE_QUERY_MAX = 100;

/** 둘러보기 목록의 한 줄. `topic` 은 없으면 빠진다. */
export interface BrowseChannel {
  id: string;
  name: string;
  topic?: string;
  /** 살아 있는 멤버십 가운데 활성 · 삭제 안 된 멤버(사람 + 에이전트). */
  memberCount: number;
  isMember: boolean;
  isDefault: boolean;
}

export interface BrowseChannelsPage {
  channels: BrowseChannel[];
  /** 다음 쪽을 여는 열쇠. 마지막 쪽이면 없다. 서버가 준 그대로 돌려보낸다. */
  nextCursor?: string;
}

export interface BrowseChannelsInput {
  /** 이름 · 주제에 들어 있는 글자. 앞뒤 빈칸은 여기서 잘라 보내고, 비면 보내지 않는다. */
  q?: string;
  cursor?: string;
  /** 1..200, 서버 기본 100. */
  limit?: number;
}

export interface JoinChannelResult {
  /** `GET …/channels` 의 그 채널 줄과 같은 모양 — 사이드바에 그대로 세운다. */
  channel: Channel;
  /** false 면 이미 멤버였고 아무것도 바뀌지 않았다(두 번 누른 늦은 쪽 포함). */
  newlyJoined: boolean;
}

export function browseChannelFromWire(value: unknown): BrowseChannel {
  const source = record(value);
  const id = str(source, "id");
  const name = str(source, "name");
  const memberCount = num(source, "memberCount");
  const isMember = bool(source, "isMember");
  const isDefault = bool(source, "isDefault");
  if (
    id === undefined ||
    name === undefined ||
    memberCount === undefined ||
    isMember === undefined ||
    isDefault === undefined
  ) {
    throw new WireShapeError();
  }
  const topic = str(source, "topic");
  return {
    id,
    name,
    ...(topic !== undefined && topic !== "" ? { topic } : {}),
    memberCount,
    isMember,
    isDefault,
  };
}

export function browseChannelsPageFromWire(value: unknown): BrowseChannelsPage {
  const source = responseRecord(value);
  const rows = arrayField(source, "channels");
  if (rows === null) throw new WireShapeError();
  const nextCursor = str(source, "nextCursor");
  return {
    channels: rows.map(browseChannelFromWire),
    ...(nextCursor !== undefined && nextCursor !== "" ? { nextCursor } : {}),
  };
}

export function joinChannelResultFromWire(value: unknown): JoinChannelResult {
  const source = responseRecord(value);
  const channel = record(source.channel);
  const newlyJoined = bool(source, "newlyJoined");
  if (
    channel === null ||
    newlyJoined === undefined ||
    str(channel, "id") === undefined ||
    str(channel, "workspaceId") === undefined ||
    str(channel, "kind") === undefined
  ) {
    throw new WireShapeError();
  }
  return { channel: channel as unknown as Channel, newlyJoined };
}

function browsePath(workspaceId: string, input: BrowseChannelsInput): string {
  const params = new URLSearchParams();
  const q = input.q?.trim() ?? "";
  if (q !== "") params.set("q", q);
  if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const query = params.toString();
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/browse${query === "" ? "" : `?${query}`}`;
}

/** 둘러보기 목록 한 쪽. */
export async function browseChannels(
  workspaceId: string,
  input: BrowseChannelsInput = {}
): Promise<BrowseChannelsPage> {
  const res = await authedRequest(browsePath(workspaceId, input));
  return browseChannelsPageFromWire(res.json<unknown>());
}

/** 스스로 참여. 비공개 · DM · 꺼진 · 보관된 · 없는 채널은 모두 같은 404 다. */
export async function joinChannel(workspaceId: string, channelId: string): Promise<JoinChannelResult> {
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/members/me`,
    { method: "POST" }
  );
  return joinChannelResultFromWire(res.json<unknown>());
}

// ---- 누구에게 문이 서나 -------------------------------------------------------

/**
 * 둘러보기 문(사이드바 「채널」 머리의 +, ⌘K 줄)이 서는가. 정식 멤버(소유자 · 관리자 · 멤버)만이고, 명부가 오기 전에는
 * 아무에게도 서지 않는다. `canCreateChannel` 과 달리 역할을 모르면(명부에 역할 칸이 없으면) 세우지 않는다 —
 * 게스트에게 문을 세우는 쪽으로 틀리지 않게(ADR-0224 D8, 서버도 403).
 */
export function canBrowseChannelsNow(rosterSettled: boolean, role: MembershipRole | undefined): boolean {
  if (!rosterSettled) return false;
  return role === "owner" || role === "admin" || role === "member";
}

// ---- 화면의 차례 --------------------------------------------------------------

/** 서버 차례를 지킨 채 참여하지 않은 줄을 위로. 쪽이 늘어도 각 묶음 안 차례는 서버 것 그대로다. */
export function splitBrowseRows(rows: readonly BrowseChannel[]): {
  notJoined: BrowseChannel[];
  joined: BrowseChannel[];
} {
  const notJoined: BrowseChannel[] = [];
  const joined: BrowseChannel[] = [];
  for (const row of rows) (row.isMember ? joined : notJoined).push(row);
  return { notJoined, joined };
}

// ---- 실패 ---------------------------------------------------------------------

export type ChannelBrowseFailureKind = "forbidden" | "notFound" | "rateLimited" | "network" | "generic";

export type ChannelBrowseFailureKey = Extract<MessageKey, `channels.browse.${string}`>;

export interface ChannelBrowseFailure {
  kind: ChannelBrowseFailureKind;
  key: ChannelBrowseFailureKey;
  /** `network` 의 `{reason}`: 전송 계층이 이미 쓴 「아무도 답하지 않았다」 문장(시간 초과 대 닿지 못함). */
  values?: { reason: string };
}

function failureKind(error: unknown): ChannelBrowseFailureKind {
  if (error instanceof ApiError) {
    if (error.status === 403) return "forbidden";
    if (error.status === 404) return "notFound";
    if (error.status === 429) return "rateLimited";
    return "generic";
  }
  if (error instanceof NetworkError) return "network";
  return "generic";
}

const LOAD_KEYS: Record<ChannelBrowseFailureKind, ChannelBrowseFailureKey> = {
  forbidden: "channels.browse.loadForbidden",
  // 목록 라우트에는 404 가 없다. 온다면 이 서버가 둘러보기를 모르는 옛 판이다.
  notFound: "channels.browse.loadUnsupported",
  rateLimited: "channels.browse.rateLimited",
  network: "channels.browse.loadNetwork",
  generic: "channels.browse.loadGeneric",
};

const JOIN_KEYS: Record<ChannelBrowseFailureKind, ChannelBrowseFailureKey> = {
  forbidden: "channels.browse.joinForbidden",
  notFound: "channels.browse.joinNotFound",
  rateLimited: "channels.browse.rateLimited",
  network: "channels.browse.joinNetwork",
  generic: "channels.browse.joinGeneric",
};

function failureOf(error: unknown, keys: Record<ChannelBrowseFailureKind, ChannelBrowseFailureKey>): ChannelBrowseFailure {
  const kind = failureKind(error);
  if (kind === "network") {
    return { kind, key: keys.network, values: { reason: (error as NetworkError).message } };
  }
  return { kind, key: keys[kind] };
}

/** 목록을 못 읽었을 때 창이 하는 말. */
export function channelBrowseLoadFailure(error: unknown): ChannelBrowseFailure {
  return failureOf(error, LOAD_KEYS);
}

/**
 * 참여가 실패했을 때 그 줄이 하는 말. `notFound` 는 그 사이 꺼졌거나 보관된 채널이라 줄을 걷고, 나머지(429 · 망 ·
 * 그 밖)는 줄에 남아 다시 시도를 받는다.
 */
export function channelJoinFailure(error: unknown): ChannelBrowseFailure {
  return failureOf(error, JOIN_KEYS);
}

// ---- 「둘러보기에 보이기」 스위치 (ADR-0224 D2, #5843) -------------------------------

/**
 * 한 공개 채널을 둘러보기에 보이거나 숨긴다. `PATCH …/channels/{ch}` 의 `browseListed` 한 칸이고 소유자 · 관리자만 부른다
 * (서버 계약: #5839 인계 0절). 답의 `channel` 은 `GET …/channels` 의 줄과 같은 모양이라 캐시에 그대로 세운다.
 * 이미 그 값이면 서버가 아무것도 쓰지 않고 200 으로 같은 줄을 돌려준다.
 */
export async function setChannelBrowseListed(
  workspaceId: string,
  channelId: string,
  listed: boolean
): Promise<Channel> {
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
    { method: "PATCH", body: JSON.stringify({ browseListed: listed }) }
  );
  const source = responseRecord(res.json<unknown>());
  const channel = record(source.channel);
  if (
    channel === null ||
    str(channel, "id") === undefined ||
    str(channel, "workspaceId") === undefined ||
    str(channel, "kind") === undefined
  ) {
    throw new WireShapeError();
  }
  return channel as unknown as Channel;
}

/**
 * 스위치를 세울 채널인가: 소유자 · 관리자가 든 **공개** 채널이고, 이 서버가 표시를 싣는다(`browseListed` 가 있다).
 * 옛 서버는 칸을 싣지 않으므로 문을 세우지 않는다(켜 봐야 서버가 모르는 칸이다). 역할을 모르면 세우지 않는다.
 */
export function canSetBrowseListed(
  channel: Pick<Channel, "kind" | "browseListed" | "archivedAtMs">,
  role: MembershipRole | undefined
): boolean {
  return (
    (role === "owner" || role === "admin") &&
    channel.kind === "public" &&
    channel.archivedAtMs === undefined &&
    channel.browseListed !== undefined
  );
}

/** 둘러보기 창 관리자 묶음의 줄: 내가 든 꺼진 공개 채널. 서버의 둘러보기 목록이 아니라 내 채널 목록에서 거른다. */
export function hiddenPublicChannels<T extends Pick<Channel, "kind" | "browseListed" | "archivedAtMs">>(
  channels: readonly T[]
): T[] {
  return channels.filter(
    (channel) => channel.kind === "public" && channel.browseListed === false && channel.archivedAtMs === undefined
  );
}

export type ChannelBrowseSwitchFailureKind =
  | "forbidden"
  | "notFound"
  | "notListable"
  | "rateLimited"
  | "network"
  | "generic";

export interface ChannelBrowseSwitchFailure {
  kind: ChannelBrowseSwitchFailureKind;
  key: ChannelBrowseFailureKey;
  /** `network` 의 `{reason}` (`ChannelBrowseFailure.values` 와 같다). */
  values?: { reason: string };
}

/**
 * 스위치가 실패했을 때 하는 말. 403 은 소유자 · 관리자가 아니거나 사람이 아닌 토큰, 404 는 닿지 않는 채널(보관 · 사라짐),
 * 409 `channel_not_listable` 은 그 사이 공개가 아니게 된 경합(스위치는 공개 채널에만 서므로 보통 오지 않는다). 다른 409 는 그 밖이다.
 */
export function channelBrowseSwitchFailure(error: unknown): ChannelBrowseSwitchFailure {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: "forbidden", key: "channels.browse.switchForbidden" };
    if (error.status === 404) return { kind: "notFound", key: "channels.browse.switchNotFound" };
    if (error.status === 409 && error.code === "channel_not_listable") {
      return { kind: "notListable", key: "channels.browse.switchNotListable" };
    }
    if (error.status === 429) return { kind: "rateLimited", key: "channels.browse.rateLimited" };
    return { kind: "generic", key: "channels.browse.switchGeneric" };
  }
  if (error instanceof NetworkError) {
    return { kind: "network", key: "channels.browse.switchNetwork", values: { reason: error.message } };
  }
  return { kind: "generic", key: "channels.browse.switchGeneric" };
}

// =============================================================================
// 참여 전 미리 보기 (ADR-0224 D5, 서버 E3 #5840). 웹(#5844)과 폰(#5847)이 같이 쓴다.
//
//   GET /v1/workspaces/{ws}/channels/{ch}/preview   켜진 공개 채널만. 최상위 글 최신 50개, **최신 먼저**, 쪽 나눔 없음.
//
// 읽기만 한다 — 읽음 위치 · 멤버십 · 실시간 구독을 건드리지 않고, 첨부는 이름만 온다(내용은 참여해야 열린다).
// 오류는 참여(`joinChannel`)와 같은 갈래라 실패 갈래(`ChannelBrowseFailureKind`)를 그대로 쓴다.
// =============================================================================

export interface PreviewAuthor {
  /** 글쓴이가 지금 활성 멤버가 아니면(정지 · 삭제) 서버가 이름을 빼서 없다. 화면은 기존 「나간 멤버」 말씨로 그린다. */
  displayName?: string;
  kind: "human" | "agent";
}

export interface PreviewMessage {
  id: string;
  /** 지워진 글이면 없다. */
  body?: string;
  author: PreviewAuthor;
  createdAtMs: number;
  edited: boolean;
  deleted: boolean;
  /** 스레드 답글 수(답글 자체는 오지 않는다). */
  replyCount: number;
  /** 첨부는 이름만 온다. 빈 배열일 수 있다. */
  attachmentNames: string[];
}

export interface ChannelPreview {
  channel: { id: string; name: string; topic?: string; memberCount: number; isMember: boolean };
  /** 서버 차례 그대로: 0번이 가장 최근. 화면은 `previewInReadingOrder` 로 뒤집는다. */
  messages: PreviewMessage[];
}

function previewMessageFromWire(value: unknown): PreviewMessage {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const author = record(source.author);
  const kind = author === null ? undefined : str(author, "kind");
  const createdAtMs = num(source, "createdAtMs");
  const edited = bool(source, "edited");
  const deleted = bool(source, "deleted");
  const replyCount = num(source, "replyCount");
  const names = arrayField(source, "attachmentNames");
  if (
    id === undefined ||
    author === null ||
    (kind !== "human" && kind !== "agent") ||
    createdAtMs === undefined ||
    edited === undefined ||
    deleted === undefined ||
    replyCount === undefined ||
    names === null
  ) {
    throw new WireShapeError();
  }
  const displayName = str(author, "displayName");
  const body = str(source, "body");
  return {
    id,
    ...(!deleted && body !== undefined ? { body } : {}),
    author: { ...(displayName !== undefined && displayName !== "" ? { displayName } : {}), kind },
    createdAtMs,
    edited,
    deleted,
    replyCount,
    attachmentNames: names.filter((name): name is string => typeof name === "string"),
  };
}

export function channelPreviewFromWire(value: unknown): ChannelPreview {
  const source = responseRecord(value);
  const channel = record(source.channel);
  const rows = arrayField(source, "messages");
  const id = channel === null ? undefined : str(channel, "id");
  const name = channel === null ? undefined : str(channel, "name");
  const memberCount = channel === null ? undefined : num(channel, "memberCount");
  const isMember = channel === null ? undefined : bool(channel, "isMember");
  if (
    channel === null ||
    rows === null ||
    id === undefined ||
    name === undefined ||
    memberCount === undefined ||
    isMember === undefined
  ) {
    throw new WireShapeError();
  }
  const topic = str(channel, "topic");
  return {
    channel: { id, name, ...(topic !== undefined && topic !== "" ? { topic } : {}), memberCount, isMember },
    messages: rows.map(previewMessageFromWire),
  };
}

/** 미리 보기 한 번. 쪽 나눔 · 실시간이 없어 호출 하나가 전부다. */
export async function previewChannel(workspaceId: string, channelId: string): Promise<ChannelPreview> {
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/preview`
  );
  return channelPreviewFromWire(res.json<unknown>());
}

/** 대화 화면과 같은 차례(오래된 글이 위, 최신이 아래). 서버는 최신 먼저 준다. */
export function previewInReadingOrder(messages: readonly PreviewMessage[]): PreviewMessage[] {
  return [...messages].reverse();
}

export type ChannelPreviewFailureKey = Extract<MessageKey, `channels.preview.${string}` | "channels.browse.rateLimited">;

export interface ChannelPreviewFailure {
  kind: ChannelBrowseFailureKind;
  key: ChannelPreviewFailureKey;
  values?: { reason: string };
}

const PREVIEW_KEYS: Record<ChannelBrowseFailureKind, ChannelPreviewFailureKey> = {
  forbidden: "channels.preview.loadForbidden",
  // 그 사이 꺼졌거나 보관된 채널(둘러보기의 404 와 같다). 다시 시도로 낫지 않는다.
  notFound: "channels.preview.notFound",
  rateLimited: "channels.browse.rateLimited",
  network: "channels.preview.loadNetwork",
  generic: "channels.preview.loadGeneric",
};

/** 미리 보기를 못 읽었을 때 화면이 하는 말. `notFound` 만 다시 시도 없이 끝난다. */
export function channelPreviewFailure(error: unknown): ChannelPreviewFailure {
  const kind = failureKind(error);
  if (kind === "network") {
    return { kind, key: PREVIEW_KEYS.network, values: { reason: (error as NetworkError).message } };
  }
  return { kind, key: PREVIEW_KEYS[kind] };
}