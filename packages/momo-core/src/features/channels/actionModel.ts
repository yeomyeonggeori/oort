import {
  canLeaveChannel,
  CHANNEL_COPY_GROUP_LABEL,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_BUSY_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_MARK_UNREAD_BUSY_LABEL,
  CHANNEL_MARK_UNREAD_LABEL,
  CHANNEL_TOPIC_VIEW_LABEL,
  DM_CLOSE_LABEL,
  channelCopyIdLabel,
  channelCopyNameLabel,
  channelMenuAccessibleLabel,
  channelMuteToggleLabel,
  normalizeChannelTopic,
} from "./model";
import { copyLinkActionLabel } from "../timeline/copyLabels";
import {
  channelStarToggleLabel,
  SECTION_MOVE_GROUP_LABEL,
} from "../sidebar/sidebarSections";
import { CHANNEL_MEMORY_SETTINGS_LABEL } from "../memory/presentation";
import { CHANNEL_GITHUB_LABEL } from "../github/model";
import type { Channel, MembershipRole } from "../../lib/api";

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
// ## 예약된 자리에 들어온 것 (BT-4 / #1932 · BT-5 / #1933, ADR-0177 Accepted)
//
// 이 문단은 원래 「별표·섹션 이동이 들어올 자리는 열쇠 하나·분기 하나·SURFACE_KEYS
// 항목 하나」라고 예약해 둔 자리다. 섹션 이동이 그대로 그 세 줄로 들어왔고
// (`move-to-section`), 별표도 같은 세 줄로 들어왔다(`star`). 광고한 확장점이
// 실제로 그만큼만 들었다는 것이 이 표의 값이다.
//
// **별표는 행 메뉴에만 선다** (BT-5 실사 판정). 헤더 ⋮ 를 열어 두는 길도 있었지만
// 그 메뉴는 정의상 **이미 그 채널 안에 있는 사람**의 것이고, 별표는 사이드바를
// 정리하는 손짓이다 - BT-4 가 섹션 이동을 행에만 둔 그 이유가 그대로 같은 축에
// 적용된다(바로 아래 `SURFACE_KEYS.row` 산문). 별표를 헤더에 세우면 「채널을 열지
// 않고 조작한다」는 이 티켓의 문법이 「열어도 되고 안 열어도 되고」로 흐려진다.
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
//
// ## 무리(cluster)가 구분선을 정한다 (#3963)
//
// 앞 판은 구분선을 항목마다 「앞 항목이 누구인가」로 따로 정했고, 그 판정이 **표면 필터
// 앞**에서 돌았다. 항목이 늘 때마다 분기가 하나씩 늘었고, 거른 뒤에는 첫 항목만 보정됐다.
// 이제 모든 항목이 자기 무리를 들고(`CLUSTER_OF`), 구분선은 **거른 뒤의 이웃이 다른 무리일
// 때** 선다(`withClusterSeparators`). 정본 차례는 Buzz 의 우클릭 메뉴를 따른다:
//
//   복사(이름 · 링크 · ID) │ 섹션 이동 │ 읽음/읽지 않음 · 알림 · 별표 │ 닫기(DM) │ 나가기
//
// 헤더 ⋮ 는 같은 표를 다른 열쇠로 거른다 - `주제 │ 알림 · 기억 │ 나가기` 로 예전 그대로다.
// 복사 무리는 서브메뉴(Buzz 의 「복사 ▸」)가 아니라 **제목 + 화면에 남는 세 행**이다. 이유는
// 위 「왜 서브메뉴가 아닌가」와 같다.
// =============================================================================

export type ChannelActionKey =
  | "topic"
  | "mark-read"
  | "mark-unread"
  | "mute"
  | "memory"
  | "github"
  | "star"
  | "move-to-section"
  | "copy-link"
  | "copy-name"
  | "copy-id"
  | "close-dm"
  | "leave";

/**
 * 구분선의 단위. 정본 차례도 이 이름들의 차례다.
 *
 *   info   주제 보기 (헤더 전용)
 *   copy   이름 · 링크 · ID (행 전용, 제목 「복사」)
 *   place  섹션으로 이동 (행 전용, 채널만)
 *   state  읽음 · 읽지 않음 · 알림 · 기억 · 별표
 *   close  대화 닫기 (행 전용, DM 만)
 *   danger 채널 나가기
 */
export type ChannelActionCluster =
  | "info"
  | "copy"
  | "place"
  | "state"
  | "close"
  | "danger";

/** 열쇠 → 무리. 새 항목은 여기 한 줄을 적어야 구분선이 제자리에 선다. */
const CLUSTER_OF: Record<ChannelActionKey, ChannelActionCluster> = {
  topic: "info",
  "copy-name": "copy",
  "copy-link": "copy",
  "copy-id": "copy",
  "move-to-section": "place",
  "mark-read": "state",
  "mark-unread": "state",
  mute: "state",
  memory: "state",
  github: "state",
  star: "state",
  "close-dm": "close",
  leave: "danger",
};

/** 제목을 이고 서는 무리. 나머지는 제목 없이 행만 선다(`place` 는 항목이 자기 제목을 든다). */
const CLUSTER_TITLE: Partial<Record<ChannelActionCluster, string>> = {
  copy: CHANNEL_COPY_GROUP_LABEL,
};

export function channelActionClusterTitle(
  cluster: ChannelActionCluster
): string | undefined {
  return CLUSTER_TITLE[cluster];
}

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
  /** 이 항목이 속한 무리. 구분선과 복사 무리의 제목이 이것으로 선다. */
  cluster: ChannelActionCluster;
  /** `data-testid` 접미사. 표면이 접두사를 붙인다(`channel-` / `channel-row-`). */
  testKey: string;
  label: string;
  /** 폰에 대응하는 디자인 시스템 아이콘이 없는 경우의 상태 표지. */
  icon?: "🔔" | "🔕";
  /**
   * 왕복이 도는 동안 이 항목이 하는 말 (design-review #1937 N-1). 없으면
   * 낱말이 바뀌지 않는다 — 왕복이 없는 항목(복사·다이얼로그 인계)이 그렇다.
   * 잠그거나 흐리게 하는 대신 **낱말과 `aria-busy`** 가 진행을 말한다.
   */
  busyLabel?: string;
  /** 파괴적 액션. 메뉴 행이 --danger 를 입는다. */
  tone?: "danger";
  /** 이 항목 위에 구분선을 세운다. 거른 뒤의 이웃이 다른 무리일 때만(`withClusterSeparators`). */
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
  /**
   * 다 읽은 채널의 「읽지 않음으로 표시」 (#3963). `markRead` 와 같은 자리의 반대 방향이라
   * 둘이 함께 참일 수 없다.
   */
  markUnread: boolean;
  mute: boolean;
  /**
   * 「기억 설정」(ADR-0196 D9, #3165). 선택 칸이다: 이 서버가 팀 기억을 싣지
   * 않으면(`teamMemory` 표면) 항목이 없고, 채워 넣지 않은 호출부는 그대로 없다.
   */
  memory?: boolean;
  /**
   * 「GitHub 알림」(ADR-0205 D10, #3955). 선택 칸이다: 이 서버가 GitHub 알림을 싣지 않으면
   * (`githubNotifications` 표면) 항목이 없고, 채워 넣지 않은 호출부는 그대로 없다. 구독은
   * 소유자·관리자만 하므로 역할도 본다(서버가 마지막 말을 한다).
   */
  github?: boolean;
  star: boolean;
  moveToSection: boolean;
  copyLink: boolean;
  copyName: boolean;
  /** 채널·DM 의 ID 복사 (#3963). 어느 채널에든 있다. */
  copyId: boolean;
  /** DM 을 이 기기의 사이드바에서 닫는다 (#3963). DM 이고 닫을 손이 있을 때만. */
  closeDm: boolean;
  leave: boolean;
}

/** 낱말이 상태인 항목들이 읽는 지금. */
export interface ChannelActionState {
  muted: boolean;
  copiedLink: boolean;
  copiedName: boolean;
  /** ID 가 방금 클립보드에 올라갔는가 (#3963). 없으면 아직이다. */
  copiedId?: boolean;
  /** 이 채널에 별표가 붙어 있는가 (ADR-0177 / BT-5). 낱말이 이 값으로 뒤집힌다. */
  starred?: boolean;
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
 * 「대화 닫기」에 해당하는 **서버** 라우트는 지금도 없다.
 *
 * 그 자리를 #3963 이 **기기 로컬 닫기**(`close-dm`)로 채웠고, ADR-0177 증보(#4228)가 **서버가 기억하는 닫기**로 옮겼다:
 * 서버가 닫기를 싣는 동안 닫으면 모든 기기에서 닫히고(옛 서버에서만 이 기기의 원장), 멤버십도 상대 쪽도 건드리지 않으며, 새
 * 메시지가 오면 다시 나타난다. 그래서 나가기와 달리 확인 단계가 없고, 닫을 **손**(`canCloseDm`)을 넘긴 표면에만 선다.
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
  /** 별표를 받을 손이 있는가. 없으면 눌러도 아무 일이 없는 항목이 된다. */
  canStar?: boolean;
  /** 이 서버가 팀 기억을 싣는가. DM 은 요약 제외가 기본이라 여기서도 뺀다. */
  hasMemorySettings?: boolean;
  /** 이 서버가 GitHub 알림을 싣는가(#3955). DM 에는 알림을 보낼 수 없어 여기서도 뺀다. */
  hasGithubNotifications?: boolean;
  /**
   * 「읽지 않음으로 표시」를 받을 수 있는 채널인가 (#3963): 서버 투영이 있고 다 읽었고
   * 메시지가 하나라도 있다. 판정은 투영을 든 호출부가 한다(`composedUnreadCount`). 여기서는
   * `unreadCount` 와 겹치지 않는지만 한 번 더 막는다.
   */
  canMarkUnread?: boolean;
  /** DM 을 닫을 손이 있는가 (#3963). 없으면 눌러도 아무 일이 없는 항목이 된다. */
  canCloseDm?: boolean;
}): ChannelActionAvailability {
  const isDm = input.channel.kind === "dm";
  return {
    topic: !isDm && normalizeChannelTopic(input.channel.topic ?? "") !== "",
    // 이미 다 읽은 채널에 「읽음 처리」는 아무 일도 하지 않는 항목이다.
    markRead: input.unreadCount > 0,
    // 반대 방향: 안 읽음이 이미 있는 채널에는 「읽음 처리」가 서므로 둘이 겹치지 않는다.
    markUnread: input.unreadCount === 0 && (input.canMarkUnread ?? false),
    // **DM 은 별표를 받지 않는다.** 별표 섹션은 파생이고, 그 파생이 세는 것은
    // 비-DM 채널뿐이다(`deriveSidebarSections` — `byId` 에 DM 이 없다). 문을 열면
    // payload 에는 적히는데 화면에는 아무 일도 일어나지 않는다.
    star: !isDm && (input.canStar ?? false),
    mute: true,
    memory: !isDm && (input.hasMemorySettings ?? false),
    // 구독은 소유자·관리자의 일이다(서버 403). 역할을 아직 모르면(undefined) 내놓고 서버가 답하게 둔다.
    github:
      !isDm &&
      (input.hasGithubNotifications ?? false) &&
      (input.selfRole === undefined || input.selfRole === "owner" || input.selfRole === "admin"),
    // **DM 은 옮기지 않는다** (ADR-0177 D4). 기본 섹션 두 종은 「채널」과 「DM」
    // 이고 DM 은 그 중 하나에 고정이다 - 커스텀 섹션에 DM 을 넣는 문을 열면
    // 코어의 파생이 그것을 무시하므로(`deriveSidebarSections`), 눌러도 아무 일도
    // 일어나지 않는 항목이 된다. 없는 문을 그리는 것은 없는 것보다 나쁘다.
    moveToSection: !isDm && (input.sectionCount ?? 0) > 0,
    copyLink: true,
    copyName: true,
    copyId: true,
    closeDm: isDm && (input.canCloseDm ?? false),
    leave: !isDm && canLeaveChannel(input.selfRole),
  };
}

/**
 * 거른 뒤의 이웃이 **다른 무리일 때** 그 위에 구분선을 단다. 첫 항목은 구분선을 이지 않는다 -
 * 메뉴 맨 위의 구분선은 무리를 나누지 않고 그냥 선이다.
 *
 * 표면 필터 **뒤에** 다시 돌려야 한다. 필터 앞에서 정한 구분선은 사라진 항목을 기준으로
 * 서 있어서, 예를 들어 「주제」가 빠진 헤더에서 첫 항목이 선을 이고 서거나, 사이에 낀 무리가
 * 통째로 빠지고도 두 선이 겹쳐 서는 일이 생긴다.
 */
function withClusterSeparators(items: ChannelActionItem[]): ChannelActionItem[] {
  return items.map((item, index) => ({
    ...item,
    separatorBefore: index > 0 && items[index - 1].cluster !== item.cluster,
  }));
}

/**
 * 인벤토리 전량, 정본 순서로. 표면은 이 배열을 **거르기만** 한다 — 순서를
 * 표면이 다시 정하면 같은 두 메뉴가 다른 차례로 읽힌다.
 *
 * 차례는 무리의 차례다(위 머리말): 주제 │ 복사 │ 섹션 이동 │ 상태(읽음·읽지 않음·알림·
 * 기억·별표) │ 닫기 │ 나가기. 구분선은 `withClusterSeparators` 가 무리가 바뀌는 자리에 세운다.
 */
export function channelActionItems(
  available: ChannelActionAvailability,
  state: ChannelActionState
): ChannelActionItem[] {
  const items: ChannelActionItem[] = [];
  const push = (item: Omit<ChannelActionItem, "cluster" | "separatorBefore">) => {
    items.push({ ...item, cluster: CLUSTER_OF[item.key] });
  };
  if (available.topic) {
    push({ key: "topic", testKey: "topic", label: CHANNEL_TOPIC_VIEW_LABEL });
  }
  // 복사 무리: 이름 → 링크 → ID. Buzz 의 「복사 ▸」가 든 것과 같은 세 가지다.
  if (available.copyName) {
    push({
      key: "copy-name",
      testKey: "copy-name",
      label: channelCopyNameLabel(state.copiedName),
    });
  }
  if (available.copyLink) {
    push({
      key: "copy-link",
      testKey: "copy-link",
      label: copyLinkActionLabel(state.copiedLink),
    });
  }
  if (available.copyId) {
    push({
      key: "copy-id",
      testKey: "copy-id",
      label: channelCopyIdLabel(state.copiedId ?? false),
    });
  }
  // 섹션 이동: 무리 하나(제목 + 라디오 행들).
  if (available.moveToSection) {
    push({
      key: "move-to-section",
      testKey: "move-to-section",
      label: SECTION_MOVE_GROUP_LABEL,
      sections: state.sections ?? [],
      currentSectionId: state.currentSectionId ?? null,
    });
  }
  // 상태 무리: 이 채널의 읽음 · 알림 · 기억 · 내 목록에서의 자리(별표).
  if (available.markRead) {
    push({
      key: "mark-read",
      testKey: "mark-read",
      label: CHANNEL_MARK_READ_LABEL,
      busyLabel: CHANNEL_MARK_READ_BUSY_LABEL,
    });
  }
  if (available.markUnread) {
    push({
      key: "mark-unread",
      testKey: "mark-unread",
      label: CHANNEL_MARK_UNREAD_LABEL,
      busyLabel: CHANNEL_MARK_UNREAD_BUSY_LABEL,
    });
  }
  if (available.mute) {
    push({
      key: "mute",
      testKey: "mute-toggle",
      label: channelMuteToggleLabel(state.muted),
      icon: state.muted ? "🔕" : "🔔",
    });
  }
  if (available.memory === true) {
    push({
      key: "memory",
      testKey: "memory-settings",
      label: CHANNEL_MEMORY_SETTINGS_LABEL,
    });
  }
  if (available.github === true) {
    push({ key: "github", testKey: "github-notifications", label: CHANNEL_GITHUB_LABEL });
  }
  if (available.star) {
    push({
      key: "star",
      testKey: "star",
      label: channelStarToggleLabel(state.starred ?? false),
    });
  }
  if (available.closeDm) {
    push({ key: "close-dm", testKey: "close-dm", label: DM_CLOSE_LABEL });
  }
  if (available.leave) {
    push({
      key: "leave",
      testKey: "leave",
      label: CHANNEL_LEAVE_LABEL,
      tone: "danger",
    });
  }
  return withClusterSeparators(items);
}

/**
 * 표면이 소비하는 열쇠 집합. 두 메뉴의 차이는 **이 표 하나**이고, 그래서 차이가
 * 컴포넌트 안에 흩어지지 않는다.
 */
const SURFACE_KEYS: Record<ChannelActionSurface, ReadonlySet<ChannelActionKey>> = {
  // 헤더 ⋮ 는 BZ-2 가 세운 그대로다. 이 티켓은 헤더의 항목을 늘리지 않는다:
  // 채널을 열어 둔 사람에게 「읽음 처리」와 「이름 복사」는 다른 물음이다.
  header: new Set<ChannelActionKey>(["topic", "mute", "memory", "github", "leave"]),
  // 행 우클릭은 「열지 않고 조작한다」가 전부다. BT-4 의 섹션 배치가 여기 사는
  // 이유도 그것이다 - 채널을 어디에 둘지는 그 채널을 **보지 않고** 정하는 일이고,
  // 헤더 ⋮ 는 정의상 이미 그 안에 들어와 있는 사람의 것이다. 복사 셋과 DM 닫기(#3963)도
  // 같은 갈래다. 「읽지 않음으로 표시」는 읽음 처리의 반대 방향이라 같은 이유로 여기에만 선다.
  row: new Set<ChannelActionKey>([
    "copy-name",
    "copy-link",
    "copy-id",
    "move-to-section",
    "mark-read",
    "mark-unread",
    "mute",
    "star",
    "close-dm",
    "leave",
  ]),
};

export function channelActionItemsForSurface(
  surface: ChannelActionSurface,
  available: ChannelActionAvailability,
  state: ChannelActionState
): ChannelActionItem[] {
  const keys = SURFACE_KEYS[surface];
  // 구분선은 거른 **뒤에** 다시 센다 (`withClusterSeparators`).
  return withClusterSeparators(
    channelActionItems(available, state).filter((item) => keys.has(item.key))
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
  //
  // `star` 도 같은 갈래이고, 한 가지가 더 있다: 별표를 붙이면 그 행이 **다른
  // 섹션으로 옮겨 간다**(파생 「별표」가 맨 위에서 가져간다). 이 메뉴를 이고 있는
  // 트리거는 옮겨 가면서 언마운트되므로, 남기려 해도 남지 않는다 - 닫히는 것이
  // 실제로 일어나는 일이고, 화면이 그렇게 말하는 편이 정직하다.
  //
  // `close-dm` (#3963) 도 닫는 쪽이다: 닫는 순간 이 행이 사라지고, 메뉴를 이고 있던 트리거가
  // 함께 언마운트되므로 열린 채로 둘 수 없다(`star` 와 같은 이유). `mark-unread` 는 읽음
  // 처리와 같은 왕복이라 실패 배너를 읽도록 열어 둔다.
  return (
    key !== "leave" &&
    key !== "topic" &&
    key !== "memory" &&
    key !== "github" &&
    key !== "star" &&
    key !== "move-to-section" &&
    key !== "close-dm"
  );
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
