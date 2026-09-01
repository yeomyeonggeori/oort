import {
  canLeaveChannel,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_BUSY_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_TOPIC_VIEW_LABEL,
  channelCopyNameLabel,
  channelMenuAccessibleLabel,
  channelMuteToggleBusyLabel,
  channelMuteToggleLabel,
  normalizeChannelTopic,
} from "@momo/core/features/channels/model";
import { copyLinkActionLabel } from "@momo/core/features/timeline/copyLabels";
import { SECTION_MOVE_GROUP_LABEL } from "@momo/core/features/sidebar/sidebarSections";
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
// ## 예약된 자리에 들어온 것 (BT-4 / #1932, ADR-0177 Accepted)
//
// 이 문단은 원래 「별표·섹션 이동이 들어올 자리는 열쇠 하나·분기 하나·SURFACE_KEYS
// 항목 하나」라고 예약해 둔 자리다. 섹션 이동이 그대로 그 세 줄로 들어왔다:
// `move-to-section` 열쇠, `channelActionItems` 의 분기 하나, `SURFACE_KEYS.row` 의
// 항목 하나. 별표 자리는 BT-5(#1933) 몫으로 여전히 비어 있고, 같은 세 줄이다.
//
// ### 왜 서브메뉴가 아닌가
//
// #1932 브리프의 스케치는 「섹션으로 이동 ▸」 **서브메뉴**였다. 실사해 보니 이
// 레포에는 서브메뉴 금지가 이유와 이슈 번호까지 달려 명문화돼 있다
// (`design/ui/dropdown-menu.tsx` 머리말, 이슈 #1383): *"Adopting submenus
// therefore means re-arguing that rule, which is ADR work and not a component
// change."* 그리고 그 문단이 **대체물까지 지정한다** — 「화면에 남는 행들 위의
// 제목」(`DropdownMenuLabel`).
//
// 그래서 여기 들어온 것은 제목 하나와 그 아래 라디오 행들이다. 서브메뉴를 들이는
// 것보다 이쪽이 「문법 동형」에 더 충실하다: 티켓 하나가 컴포넌트 변경으로 ADR급
// 결정을 뒤집지 않고, 목적지가 열지 않아도 보인다.
//
// 라디오인 이유는 `PresenceControl` 과 같다: 섹션 배치는 **여럿 중 하나**라
// 지금 속한 섹션이 `aria-checked` 로 들려야 한다. 평범한 항목 N 개는 스크린리더에
// 동등한 명령 N 개로 읽히고, 그 중 어디에 이미 있는지는 말해 주지 않는다.
// =============================================================================

export type ChannelActionKey =
  | "topic"
  | "mark-read"
  | "mute"
  | "move-to-section"
  | "copy-link"
  | "copy-name"
  | "leave";

/**
 * 「섹션으로 이동」의 한 목적지 (ADR-0177 D4).
 *
 * `id === null` 은 기본 「채널」 섹션이다. 커스텀 섹션에서 빼는 것과 기본 섹션에
 * 넣는 것은 payload 에서 같은 한 가지 일이라(배치를 푸는 것), 목적지 목록에서도
 * 한 행이다.
 */
export interface ChannelSectionChoice {
  id: string | null;
  label: string;
}

export interface ChannelActionItem {
  key: ChannelActionKey;
  /** `data-testid` 접미사. 표면이 접두사를 붙인다(`channel-` / `channel-row-`). */
  testKey: string;
  label: string;
  /**
   * 왕복이 도는 동안 이 항목이 하는 말 (design-review #1937 N-1). 없으면
   * 낱말이 바뀌지 않는다 — 왕복이 없는 항목(복사·다이얼로그 인계)이 그렇다.
   * 잠그거나 흐리게 하는 대신 **낱말과 `aria-busy`** 가 진행을 말한다.
   */
  busyLabel?: string;
  /** 파괴적 액션. 메뉴 행이 --danger 를 입는다. */
  tone?: "danger";
  /** 이 항목 위에 구분선을 세운다. 무리가 바뀌는 자리에서만. */
  separatorBefore?: boolean;
  /**
   * 이 항목이 **행 하나가 아니라 무리**라는 표식. `move-to-section` 만 갖는다.
   *
   * `label` 은 그 무리의 제목이 되고, 여기 목적지들이 그 아래 라디오 행으로
   * 선다. 표면이 이 배열의 길이나 차례를 다시 정하지 않는다 - 배치 규칙은
   * 코어(`deriveSidebarSections`)의 것이고 여기는 그 결과를 실어 나른다.
   */
  sections?: ChannelSectionChoice[];
  /** `sections` 가 있을 때 지금 체크된 목적지. 기본 섹션이면 `null`. */
  currentSectionId?: string | null;
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
  moveToSection: boolean;
  copyLink: boolean;
  copyName: boolean;
  leave: boolean;
}

/** 낱말이 상태인 항목들이 읽는 지금. */
export interface ChannelActionState {
  muted: boolean;
  copiedLink: boolean;
  copiedName: boolean;
  /**
   * 이 사람이 만든 커스텀 섹션들(ADR-0177 D1 - 멤버 소유). 비어 있으면
   * 「섹션으로 이동」은 목적지가 기본 섹션 하나뿐이라 무리가 되지 않고, 그래서
   * 그리지 않는다. 첫 섹션을 만드는 문은 사이드바 헤더의 「새 섹션」이다.
   */
  sections?: ChannelSectionChoice[];
  /** 이 채널이 지금 속한 커스텀 섹션. 기본 섹션이면 `null`. */
  currentSectionId?: string | null;
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
  /** 이 사람의 커스텀 섹션 수(ADR-0177). 0이면 옮길 곳이 없다. */
  sectionCount?: number;
}): ChannelActionAvailability {
  const isDm = input.channel.kind === "dm";
  return {
    topic: !isDm && normalizeChannelTopic(input.channel.topic ?? "") !== "",
    // 이미 다 읽은 채널에 「읽음 처리」는 아무 일도 하지 않는 항목이다.
    markRead: input.unreadCount > 0,
    mute: true,
    // **DM 은 옮기지 않는다** (ADR-0177 D4). 기본 섹션 두 종은 「채널」과 「DM」
    // 이고 DM 은 그 중 하나에 고정이다 - 커스텀 섹션에 DM 을 넣는 문을 열면
    // 코어의 파생이 그것을 무시하므로(`deriveSidebarSections`), 눌러도 아무 일도
    // 일어나지 않는 항목이 된다. 없는 문을 그리는 것은 없는 것보다 나쁘다.
    moveToSection: !isDm && (input.sectionCount ?? 0) > 0,
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
      busyLabel: CHANNEL_MARK_READ_BUSY_LABEL,
      separatorBefore: items.length > 0,
    });
  }
  if (available.mute) {
    items.push({
      key: "mute",
      testKey: "mute-toggle",
      label: channelMuteToggleLabel(state.muted),
      busyLabel: channelMuteToggleBusyLabel(state.muted),
      separatorBefore: items.length > 0 && items[items.length - 1].key === "topic",
    });
  }
  if (available.moveToSection) {
    // 무리 하나(제목 + 라디오 행들). 상태를 바꾸는 무리의 끝에 서고, 구분선은
    // 그 다음 무리(밖으로 꺼내는 것)가 이고 있으므로 여기서는 세우지 않는다.
    items.push({
      key: "move-to-section",
      testKey: "move-to-section",
      label: SECTION_MOVE_GROUP_LABEL,
      sections: state.sections ?? [],
      currentSectionId: state.currentSectionId ?? null,
      separatorBefore: items.length > 0,
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
  // 행 우클릭은 「열지 않고 조작한다」가 전부다. BT-4 의 섹션 배치가 여기 사는
  // 이유도 그것이다 - 채널을 어디에 둘지는 그 채널을 **보지 않고** 정하는 일이고,
  // 헤더 ⋮ 는 정의상 이미 그 안에 들어와 있는 사람의 것이다.
  row: new Set<ChannelActionKey>([
    "mark-read",
    "mute",
    "move-to-section",
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
  // `move-to-section` 은 왕복을 그 자리에서 기다리지 않는다: 배치는 즉시 화면에
  // 반영되고 저장은 디바운스로 뒤따르므로(ADR-0177 D2 - 이벤트가 없어 서버 답을
  // 기다릴 이유도 없다), 메뉴가 남아 있어 봐야 방금 고른 답만 다시 보여 준다.
  // 저장이 실패하면 사이드바가 배너로 말한다 - 그때 이 메뉴는 이미 없다.
  return key !== "leave" && key !== "topic" && key !== "move-to-section";
}

/**
 * 이 메뉴가 스크린리더에게 자기를 부르는 이름 (design-review #1937 M-1).
 *
 * 낱말은 코어가 갖고, 여기서 정하는 것은 **어느 낱말인가** 하나뿐이다 —
 * `channelActionAvailability` 가 이미 읽는 그 `kind === "dm"` 을 다시 읽는다.
 * 헤더 ⋮ 는 DM 에 서지 않으므로(ChatShell 의 `kind !== "dm"`) 이 갈래가 실제로
 * 갈라지는 자리는 사이드바 행뿐이고, 그래서 이 낱말이 DM 에 붙는 것도 처음이다.
 */
export function channelActionMenuLabel(
  title: string,
  channel: Pick<Channel, "kind">
): string {
  return channelMenuAccessibleLabel(title, channel.kind === "dm");
}
