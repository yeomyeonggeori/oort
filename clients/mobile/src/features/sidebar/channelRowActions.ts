import type {Channel, MembershipRole, ReadState} from '@momo/core/lib/api';
import {
  channelActionAvailability,
  channelActionItemsForSurface,
  type ChannelActionItem,
  type ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {composedUnreadCount} from '@momo/core/features/readState/model';

// =============================================================================
// 사이드바 행을 길게 누르면 열리는 시트가 **무엇을 내놓는가** (#4229, Buzz식).
//
// 이 파일은 항목을 짓지 않는다. 웹 행 우클릭 메뉴와 같은 표 — 코어
// `channels/actionModel.ts` 의 `channelActionAvailability` 와 `row` 표면 — 에 폰이
// 가진 **손**만 넘기고 그 답을 그대로 든다. 낱말·차례·구분선 무리도 코어의 것이다.
// 폰이 자기 목록을 한 벌 더 들면 두 화면이 같은 행을 다르게 부르게 된다(웹 메뉴와 폰
// 시트가 갈라졌던 자리가 메시지 쪽에 이미 있다).
//
// ## 폰에 손이 없는 항목은 내놓지 않는다 (죽은 항목 금지)
//
// 코어의 `row` 표면에는 별표·섹션 이동·DM 닫기도 있다. 폰은 그 손(`onToggleStar` ·
// 커스텀 섹션 · 닫기)이 없으므로 **입력으로 막는다** — 코어 판정이 「그릴 수 없다」고
// 답하게 한다. 항목을 그린 뒤 뒤에서 거르면 구분선이 사라진 항목을 기준으로 서 있게
// 된다(코어 `withClusterSeparators` 머리말).
//
//   - 별표·섹션 이동: 폰 UI 가 별도 판단이다(이슈 Out of scope).
//   - 「대화 닫기」: 서버가 기억하는 닫기(#4227/#4228)가 표면을 싣는 뒤에만 그린다.
//     **폰에 기기 로컬 닫기를 새로 만들지 않는다** — 기기마다 어긋나던 문제를 되풀이한다.
//   - 「주제 보기」·「기억 설정」·「GitHub 알림」: `row` 표면에 없는 항목이다.
//   - 「채널·상대 정보 보기」: 폰에 그 정보를 보여 줄 화면이 아직 없다(목적지 없음 →
//     항목 없음). 화면이 생기면 코어 표에 열쇠를 더하고 여기서 손만 넘긴다.
// =============================================================================

/** 이 시트가 실행할 줄 아는 열쇠. 코어 표에 새 열쇠가 생겨도 여기에 없으면 시험이 빨개진다. */
export const PHONE_CHANNEL_ACTION_KEYS: ReadonlySet<ChannelActionKey> = new Set<ChannelActionKey>([
  'copy-name',
  'copy-link',
  'copy-id',
  'mark-read',
  'mark-unread',
  'mute',
  'leave',
]);

export interface ChannelRowTarget {
  channel: Pick<Channel, 'id' | 'kind' | 'topic'>;
  /** 행에 보이는 이름. 확인 문장·이름 복사가 쓴다. */
  title: string;
  muted: boolean;
  /** 로그인 멤버의 워크스페이스 역할. 모르면 `undefined` — 내놓고 서버가 답하게 둔다(코어 규칙). */
  selfRole: MembershipRole | undefined;
  /** 서버 읽음 투영의 이 채널 항목. 없으면 읽음 처리·안 읽음 표시를 내놓지 않는다. */
  readState: ReadState | null;
}

export interface ChannelRowCopied {
  name: boolean;
  link: boolean;
  id: boolean;
}

export const NOTHING_COPIED: ChannelRowCopied = {name: false, link: false, id: false};

/** 안 읽음이 이미 있으면 「읽음 처리」, 다 읽었으면 「읽지 않음으로 표시」 — 웹 `useChannelActions` 와 같은 입력이다. */
export function channelRowActionItems(
  target: ChannelRowTarget,
  copied: ChannelRowCopied = NOTHING_COPIED,
): ChannelActionItem[] {
  const unreadCount = target.readState ? composedUnreadCount(target.readState) : 0;
  const available = channelActionAvailability({
    channel: target.channel,
    selfRole: target.selfRole,
    unreadCount,
    // 폰에 없는 손은 입력에서 막는다(위 머리말).
    sectionCount: 0,
    canStar: false,
    hasMemorySettings: false,
    hasGithubNotifications: false,
    canCloseDm: false,
    // 투영이 있고, 다 읽었고, 메시지가 하나라도 있을 때만(빈 채널에는 표시할 메시지가 없다).
    canMarkUnread:
      target.readState != null &&
      target.readState.latestSeq > 0 &&
      unreadCount === 0,
  });
  return channelActionItemsForSurface('row', available, {
    muted: target.muted,
    copiedLink: copied.link,
    copiedName: copied.name,
    copiedId: copied.id,
  });
}

/** 로터(VoiceOver 사용자 동작)의 이름. 항목 열쇠에서 한 줄로 만든다. */
export const CHANNEL_ROW_ACTION_PREFIX = 'momoChannel:';

export function channelRowAccessibilityActions(
  items: ChannelActionItem[],
): {name: string; label: string}[] {
  return items.map(item => ({
    name: `${CHANNEL_ROW_ACTION_PREFIX}${item.key}`,
    label: item.label,
  }));
}

export function channelRowActionKeyOf(name: string): ChannelActionKey | null {
  if (!name.startsWith(CHANNEL_ROW_ACTION_PREFIX)) return null;
  const key = name.slice(CHANNEL_ROW_ACTION_PREFIX.length) as ChannelActionKey;
  return PHONE_CHANNEL_ACTION_KEYS.has(key) ? key : null;
}
