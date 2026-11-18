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
