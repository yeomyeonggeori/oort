import {
  canLeaveChannel,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_TOPIC_VIEW_LABEL,
  channelCopyNameLabel,
  channelMuteToggleLabel,
  normalizeChannelTopic,
} from "@momo/core/features/channels/model";
import { copyLinkActionLabel } from "@momo/core/features/timeline/copyLabels";
import type { Channel, MembershipRole } from "@momo/core/lib/api";

// =============================================================================
// 채널 액션 인벤토리 (BT-1 / #1929).
//
// oort 의 채널 액션은 헤더 ⋮ 메뉴에만 있었다 — 「채널을 열지 않고 조작한다」는
// 문법 자체가 없었다(버즈 패리티 감사 §3-S2). 사이드바 행의 우클릭이 그 문을
// 열면서 같은 일을 하는 표면이 둘이 되었으므로, **무엇이 있고 어떻게 불리고
// 언제 그려지는가**는 여기 한 곳에서만 답한다. `messageActionModel.ts` 가
// 메시지 쪽에서 이미 같은 자리에 있고, 그 파일 머리말이 적은 이유가 그대로
// 여기서도 이유다: 두 번째 표면은 인벤토리를 **복사**해서 시작하고, 복사본은
// 반드시 갈라진다.
//
// 낱말은 이 파일에도 없다. 코어(`features/channels/model.ts`)가 갖고,
// 링크 복사는 메시지 쪽이 이미 쓰는 `copyLabels.ts` 것을 그대로 든다 — 같은
// 뜻에 두 번째 이름을 만들지 않는다.
//
// ## 표면이 둘인데 항목이 다른 이유
//
// 헤더 메뉴는 **이미 그 채널 안에 있는 사람**의 것이다. 「읽음 처리」는 지금
// 읽고 있는 채널에 대고 하는 말이 아니고(ChatShell 이 이미 커서를 밀고 있다),
// 「주제 보기」는 반대로 그 채널을 읽고 있는 사람의 물음이라 행에서는 묻지
// 않는다. 그래서 인벤토리는 하나, 표면별 열쇠 집합은 둘이다 —
// `messageActionItemsForSurface` 와 같은 갈래.
//
// ## 자리 예약 (ADR-0177 결재 전)
//
// 별표·섹션 이동은 이번 티켓 몫이 아니다. 그 둘이 들어올 자리는 `ChannelActionKey`
// 에 열쇠 하나, `channelActionItems` 에 분기 하나, `SURFACE_KEYS` 에 항목 하나다
// — 표면 컴포넌트는 손대지 않는다. 확장점은 그 세 줄이고, 그것이 여기 배열 합성이
// 컴포넌트가 아닌 이유다.
// =============================================================================

export type ChannelActionKey =
  | "topic"
  | "mark-read"
  | "mute"
  | "copy-link"
  | "copy-name"
  | "leave";

export interface ChannelActionItem {
  key: ChannelActionKey;
  /** `data-testid` 접미사. 표면이 접두사를 붙인다(`channel-` / `channel-row-`). */
  testKey: string;
  label: string;
  /** 파괴적 액션. 메뉴 행이 --danger 를 입는다. */
  tone?: "danger";
  /** 이 항목 위에 구분선을 세운다. 무리가 바뀌는 자리에서만. */
  separatorBefore?: boolean;
}

export const CHANNEL_ACTION_SURFACES = ["header", "row"] as const;
export type ChannelActionSurface = (typeof CHANNEL_ACTION_SURFACES)[number];

/**
 * 무엇을 **내놓을 수 있는가**. 권한이 아니라 어포던스다 — 서버가 마지막 말을
 * 하고(`canLeaveChannel` 머리말), 여기서는 누를 수 없는 항목을 그리지 않는
 * 것까지가 일이다.
 */
export interface ChannelActionAvailability {
  topic: boolean;
  markRead: boolean;
  mute: boolean;
  copyLink: boolean;
  copyName: boolean;
  leave: boolean;
}

/** 낱말이 상태인 항목들이 읽는 지금. */
export interface ChannelActionState {
  muted: boolean;
  copiedLink: boolean;
  copiedName: boolean;
}

/**
 * 이 채널·이 사람에게 무엇이 있는가.
 *
 * **DM 분기** (2026-09-01 실측): DM 행에는 「채널 나가기」를 그리지 않는다.
 * 서버의 `remove_member`(`routes/channels.rs`)에는 DM 분기가 없어서 호출하면
 * 그냥 멤버십이 지워지는데, DM 은 그것으로 「대화를 닫는」 것이 아니라 상대가
 * 빈 방에 남는 것이고, 되돌아올 길도 없다(`add_member` 도 관리자 전용). 버즈의
 * 「대화 닫기」에 해당하는 라우트는 이 서버에 없다. 없는 문을 그리는 것은 없는
 * 것보다 나쁘므로, DM 은 나가기 자리를 비우고 아무것도 대신 넣지 않는다.
 *
 * 「주제 보기」도 같은 갈래로 DM 에는 없다: DM 에는 토픽이 없다.
 */
export function channelActionAvailability(input: {
  channel: Pick<Channel, "kind" | "topic">;
  /** 로그인 멤버의 워크스페이스 역할. undefined 면 내놓고 서버가 답하게 둔다. */
  selfRole: MembershipRole | undefined;
  /** 서버 read-state 가 이 채널에 실어 준 안 읽음. 투영이 없으면 0. */
  unreadCount: number;
}): ChannelActionAvailability {
  const isDm = input.channel.kind === "dm";
  return {
    topic: !isDm && normalizeChannelTopic(input.channel.topic ?? "") !== "",
    // 이미 다 읽은 채널에 「읽음 처리」는 아무 일도 하지 않는 항목이다.
    markRead: input.unreadCount > 0,
    mute: true,
    copyLink: true,
    copyName: true,
    leave: !isDm && canLeaveChannel(input.selfRole),
  };
}

/**
 * 인벤토리 전량, 정본 순서로. 표면은 이 배열을 **거르기만** 한다 — 순서를
 * 표면이 다시 정하면 같은 두 메뉴가 다른 차례로 읽힌다.
 *
 * 무리: ①상태를 바꾸는 것(읽음·알림) ②밖으로 꺼내는 것(링크·이름) ③파괴적인 것
 * (나가기). 구분선은 무리가 바뀌는 자리에만 선다.
 */
export function channelActionItems(
  available: ChannelActionAvailability,
  state: ChannelActionState
): ChannelActionItem[] {
  const items: ChannelActionItem[] = [];
  if (available.topic) {
    items.push({ key: "topic", testKey: "topic", label: CHANNEL_TOPIC_VIEW_LABEL });
  }
  if (available.markRead) {
    items.push({
      key: "mark-read",
      testKey: "mark-read",
      label: CHANNEL_MARK_READ_LABEL,
      separatorBefore: items.length > 0,
    });
  }
  if (available.mute) {
    items.push({
      key: "mute",
      testKey: "mute-toggle",
      label: channelMuteToggleLabel(state.muted),
      separatorBefore: items.length > 0 && items[items.length - 1].key === "topic",
    });
  }
  if (available.copyLink) {
    items.push({
      key: "copy-link",
      testKey: "copy-link",
      label: copyLinkActionLabel(state.copiedLink),
      separatorBefore: items.length > 0,
    });
  }
  if (available.copyName) {
    items.push({
      key: "copy-name",
      testKey: "copy-name",
      label: channelCopyNameLabel(state.copiedName),
      separatorBefore: items.length > 0 && items[items.length - 1].key !== "copy-link",
    });
  }
  if (available.leave) {
    items.push({
      key: "leave",
      testKey: "leave",
      label: CHANNEL_LEAVE_LABEL,
      tone: "danger",
      separatorBefore: items.length > 0,
    });
  }
  return items;
}

/**
 * 표면이 소비하는 열쇠 집합. 두 메뉴의 차이는 **이 표 하나**이고, 그래서 차이가
 * 컴포넌트 안에 흩어지지 않는다.
 */
const SURFACE_KEYS: Record<ChannelActionSurface, ReadonlySet<ChannelActionKey>> = {
  // 헤더 ⋮ 는 BZ-2 가 세운 그대로다. 이 티켓은 헤더의 항목을 늘리지 않는다:
  // 채널을 열어 둔 사람에게 「읽음 처리」와 「이름 복사」는 다른 물음이다.
  header: new Set<ChannelActionKey>(["topic", "mute", "leave"]),
  // 행 우클릭은 「열지 않고 조작한다」가 전부다.
  row: new Set<ChannelActionKey>([
    "mark-read",
    "mute",
    "copy-link",
    "copy-name",
    "leave",
  ]),
};

export function channelActionItemsForSurface(
  surface: ChannelActionSurface,
  available: ChannelActionAvailability,
  state: ChannelActionState
): ChannelActionItem[] {
  const keys = SURFACE_KEYS[surface];
  const kept = channelActionItems(available, state).filter((item) =>
    keys.has(item.key)
  );
  // 거르고 나면 첫 항목이 구분선을 이고 있을 수 있다. 메뉴 맨 위의 구분선은
  // 무리를 나누지 않고 그냥 선이다.
  return kept.map((item, index) =>
    index === 0 && item.separatorBefore
      ? { ...item, separatorBefore: false }
      : item
  );
}

/**
 * 이 항목을 고르면 메뉴가 열린 채로 남는가.
 *
 * 남아야 하는 이유는 둘뿐이다: **왕복이 그 자리에서 실패를 말해야 하거나**
 * (읽음·알림 — 실패 배너는 메뉴가 열려 있어야 읽힌다), **영수증이 그 자리에서
 * 읽혀야 하거나**(복사 — 「복사됨」은 항목 자신의 낱말이다). 나머지는 다이얼로그로
 * 넘기므로 메뉴가 닫히는 것이 옳다.
 */
export function channelActionKeepsMenuOpen(key: ChannelActionKey): boolean {
  return key !== "leave" && key !== "topic";
}
