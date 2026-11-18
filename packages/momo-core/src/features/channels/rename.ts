import { ApiError, authedRequest, type Channel, type MembershipRole } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { record, responseRecord, str, WireShapeError } from "../../lib/wire";
import type { MessageKey } from "../../i18n/generated/messages";
import { CHANNEL_CREATE_FAILURE_KEYS, CHANNEL_NAME_SERVER_REJECTED_KEY } from "./model";

// =============================================================================
// 채널 이름 바꾸기 (ADR-0225 D10 · D13, #5835). 웹 · 데스크탑과 폰이 같이 쓴다.
//
// 서버 계약은 `PATCH /v1/workspaces/{ws}/channels/{ch}` 의 `name` 한 칸(#5831, 응답은 #5839 가 `Channel` 모양으로 맞춤)이다.
// 누가: 소유자 · 관리자(사람). 무엇을: 보관되지 않은 공개 · 비공개 채널. DM 은 이 길로 바꾸지 않는다. `general` 은 잠겼다(409
// `general_channel_locked`). 실시간 이벤트는 없다 — 다른 사람은 다음 채널 목록 조회에서 새 이름을 받는다.
// =============================================================================

/** 서버가 이름을 잠근 채널의 이름(환영 글이 이 이름으로 찾는다, ADR-0225 D10). */
export const GENERAL_CHANNEL_NAME = "general";

/**
 * 「이름 바꾸기」 문을 세울 채널인가: 소유자 · 관리자가 든 공개 · 비공개 채널이고, 이름이 `general` 이 아니다. 보관된 채널과 DM 에는
 * 문이 없다. 역할을 모르면 세우지 않는다(서버가 마지막 말을 하지만, 눌러도 거절될 문을 먼저 세우지 않는다).
 */
export function canRenameChannel(
  channel: Pick<Channel, "kind" | "name" | "archivedAtMs">,
  role: MembershipRole | undefined
): boolean {
  return (
    (role === "owner" || role === "admin") &&
    (channel.kind === "public" || channel.kind === "private") &&
    channel.archivedAtMs === undefined &&
    channel.name !== GENERAL_CHANNEL_NAME
  );
}

/**
 * 한 채널의 이름을 바꾼다. 보낼 이름은 호출부가 `normalizeChannelName` 으로 접은 값이다(서버도 같은 규칙으로 다시 접는다). 답의
 * `channel` 은 `GET …/channels` 의 줄과 같은 모양이라 캐시에 그대로 세운다. 이미 그 이름이면 서버가 아무것도 쓰지 않고 200 으로
 * 같은 줄을 돌려준다.
 */
export async function renameChannel(workspaceId: string, channelId: string, name: string): Promise<Channel> {
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) }
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

export type ChannelRenameFailureKind =
  | "generalLocked"
  | "duplicate"
  | "rejected"
  | "forbidden"
  | "notFound"
  | "rateLimited"
  | "network"
  | "generic";

export type ChannelRenameFailureKey = Extract<MessageKey, `channels.rename.${string}`> | typeof CHANNEL_NAME_SERVER_REJECTED_KEY | typeof CHANNEL_CREATE_FAILURE_KEYS.duplicate | typeof CHANNEL_CREATE_FAILURE_KEYS.rateLimited;

export interface ChannelRenameFailure {
  kind: ChannelRenameFailureKind;
  key: ChannelRenameFailureKey;
  /** `network` 의 `{reason}`: 전송 계층이 이미 쓴 「아무도 답하지 않았다」 문장(시간 초과 대 닿지 못함). */
  values?: { reason: string };
}

/**
 * 이름 바꾸기가 거절됐을 때 칸 아래가 하는 말. 409 는 `error.code` 로 가른다: `general_channel_locked` 가 잠금이고 나머지 409 는
 * 이름 겹침이다(만들기와 같은 문장 키). 400 은 서버가 이 이름을 받지 않은 것(만들기와 같은 키), 403 은 소유자 · 관리자가 아니거나
 * 사람이 아닌 토큰, 404 는 닿지 않는 채널(사라짐 · 보관 · 둘러보기에서 내려간 채널을 멤버 아닌 관리자가 고치던 길)이다.
 */
export function channelRenameFailure(error: unknown): ChannelRenameFailure {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return error.code === "general_channel_locked"
        ? { kind: "generalLocked", key: "channels.rename.generalLocked" }
        : { kind: "duplicate", key: CHANNEL_CREATE_FAILURE_KEYS.duplicate };
    }
    if (error.status === 400) return { kind: "rejected", key: CHANNEL_NAME_SERVER_REJECTED_KEY };
    if (error.status === 403) return { kind: "forbidden", key: "channels.rename.forbidden" };
    if (error.status === 404) return { kind: "notFound", key: "channels.rename.notFound" };
    if (error.status === 429) return { kind: "rateLimited", key: CHANNEL_CREATE_FAILURE_KEYS.rateLimited };
    return { kind: "generic", key: "channels.rename.generic" };
  }
  if (error instanceof NetworkError) {
    return { kind: "network", key: "channels.rename.network", values: { reason: error.message } };
  }
  return { kind: "generic", key: "channels.rename.generic" };
}
