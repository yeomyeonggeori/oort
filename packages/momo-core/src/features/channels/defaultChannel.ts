import { ApiError, authedRequest, uuidEq, type Channel, type MembershipRole } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { record, responseRecord, str, WireShapeError } from "../../lib/wire";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// 「기본 채널로 지정」 (ADR-0224 D6, #5845). 서버 계약은 #5841 의 `PATCH …/channels/{ch}` 의 `isDefault` 한 칸이다
// (`browseListed` · `name` 과 같은 요청에 함께 보낼 수 있지만 화면은 한 칸씩 보낸다).
//
// 켜도 이미 있는 멤버는 들어가지 않는다 — 새로 합류하는 사람에게만 적용된다(그래서 줄의 말이 「새로 합류하는 사람」이다).
// 서버는 워크스페이스의 **마지막** 살아 있는 기본 채널을 끄는 요청을 409 `last_default_channel` 로 거절한다. 기본 채널은
// 내가 들지 않은 채널일 수도 있어서 화면은 자기 목록의 셈으로 요청을 막지 않는다(`isOnlyVisibleDefault` 는 말을 거들 뿐이다).
// =============================================================================

/**
 * 한 공개 채널을 기본 채널로 지정하거나 푼다. 답의 `channel` 은 `GET …/channels` 의 줄과 같은 모양이라 캐시에 그대로 세운다.
 * 이미 그 값이면 서버가 아무것도 쓰지 않고 200 으로 같은 줄을 돌려준다.
 */
export async function setChannelDefault(
  workspaceId: string,
  channelId: string,
  isDefault: boolean
): Promise<Channel> {
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
    { method: "PATCH", body: JSON.stringify({ isDefault }) }
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
 * 줄을 세울 채널인가: 소유자 · 관리자가 든 보관 안 된 **공개** 채널이고, 이 서버가 기본 채널 표시를 싣는다(`isDefault` 가 있다).
 * 옛 서버는 칸을 싣지 않으므로 문을 세우지 않는다(켜 봐야 서버가 모르는 칸이다). 역할을 모르면 세우지 않는다.
 * 서버는 `isDefault` 를 싣는 서버라면 켜짐 · 꺼짐 모두 값을 실어 준다고 가정한다(#5837).
 */
export function canSetChannelDefault(
  channel: Pick<Channel, "kind" | "isDefault" | "archivedAtMs">,
  role: MembershipRole | undefined
): boolean {
  return (
    (role === "owner" || role === "admin") &&
    channel.kind === "public" &&
    channel.archivedAtMs === undefined &&
    channel.isDefault !== undefined
  );
}

/**
 * 이 채널이 **내 채널 목록에서 보이는 유일한** 기본 채널인가. 줄이 「하나 이상 있어야 해요」 까닭을 미리 말하는 데만 쓴다 —
 * 내가 들지 않은 기본 채널이 있을 수 있으므로 이 셈으로 요청을 막지 않는다(서버가 마지막 말을 한다). 목록을 모르면 거짓이다.
 */
export function isOnlyVisibleDefault(
  channel: Pick<Channel, "id" | "isDefault">,
  channels: readonly Pick<Channel, "id" | "kind" | "isDefault" | "archivedAtMs">[] | undefined
): boolean {
  if (channel.isDefault !== true || channels === undefined) return false;
  return !channels.some(
    (other) =>
      !uuidEq(other.id, channel.id) &&
      other.kind === "public" &&
      other.archivedAtMs === undefined &&
      other.isDefault === true
  );
}

export type ChannelDefaultFailureKind =
  | "forbidden"
  | "notFound"
  | "notDefaultable"
  | "lastDefault"
  | "rateLimited"
  | "network"
  | "generic";

export type ChannelDefaultFailureKey = Extract<MessageKey, `channels.default.${string}` | `channels.browse.${string}`>;

export interface ChannelDefaultFailure {
  kind: ChannelDefaultFailureKind;
  key: ChannelDefaultFailureKey;
  /** `network` 의 `{reason}`: 전송 계층이 이미 쓴 「아무도 답하지 않았다」 문장. */
  values?: { reason: string };
}

/**
 * 지정이 실패했을 때 하는 말. 403 은 소유자 · 관리자가 아니거나 사람이 아닌 토큰, 404 는 닿지 않는 채널, 409 는 `error.code` 로 가른다:
 * `last_default_channel`(마지막 기본 채널 끄기), `channel_not_defaultable`(그 사이 공개가 아니게 된 경합). 다른 409 는 그 밖이다.
 * 「바꾸지 못했어요」류 문장은 「둘러보기에 보이기」 스위치의 것을 그대로 쓴다(같은 메뉴 · 같은 말).
 */
export function channelDefaultFailure(error: unknown): ChannelDefaultFailure {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: "forbidden", key: "channels.browse.switchForbidden" };
    if (error.status === 404) return { kind: "notFound", key: "channels.browse.switchNotFound" };
    if (error.status === 409 && error.code === "last_default_channel") {
      return { kind: "lastDefault", key: "channels.default.lastDefault" };
    }
    if (error.status === 409 && error.code === "channel_not_defaultable") {
      return { kind: "notDefaultable", key: "channels.default.notDefaultable" };
    }
    if (error.status === 429) return { kind: "rateLimited", key: "channels.browse.rateLimited" };
    return { kind: "generic", key: "channels.browse.switchGeneric" };
  }
  if (error instanceof NetworkError) {
    return { kind: "network", key: "channels.browse.switchNetwork", values: { reason: error.message } };
  }
  return { kind: "generic", key: "channels.browse.switchGeneric" };
}
