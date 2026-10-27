import {
  type ChannelActionItem,
  type ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {channelMenuAccessibleLabel} from '@momo/core/features/channels/model';
import type {Channel} from '@momo/core/lib/api';
import {channelRowActionItems, type ChannelRowTarget} from '../sidebar/channelRowActions';

// =============================================================================
// 대화 머리 ⋮ 시트가 **무엇을 내놓는가** (#4319, owner 10-27 「DM 에서는 대화 정보 · 고정한 메시지 · 알림 끄기 · …」).
//
// 항목이 두 갈래다. 이 파일이 둘을 갈라 말한다:
//
//   1. **이 앱(폰)이 가진 문** — 대화 정보 · 고정한 메시지 · 작업 맡기기. 코어 표(`channelActionItems`)에 없다: 코어 `header` 표면은
//      웹 채널 헤더의 열쇠(`topic·mute·memory·github·leave`)라 정보 화면·고정 목록·작업 시트로 가는 문이 없고, 그 문들은 폰 화면의 것이다.
//      그래서 시트가 직접 그린다(`ConversationMenuSheet`).
//   2. **서버에 닿는 행동** — 알림 끄기·켜기 · 대화 닫기 · 채널 나가기. 낱말·**내밀지 말지**(`canLeaveChannel`·`dmCloseOffered`)·위험색·
//      진행 낱말까지 코어 `row` 표가 이미 답하고, 사이드바 행 시트(#4229)가 쓰는 같은 표다. 여기서는 그 답에서 이 시트가 쓰는 셋만
//      **거를 뿐** 새로 짓지 않는다 — 같은 행동에 두 번째 이름·두 번째 판정을 만들지 않는다. 실행도 같은 훅(`useChannelRowActions`)이다.
//
// ## DM 의 「대화 닫기」 — 「대화 나가기」가 아니다
//
// owner 의 10-27 문장은 DM 에 「대화 나가기」가 서야 한다고 적었다. 코어·ADR-0177 D13·사이드바 시트는 같은 행동을 「대화 닫기」라고 부른다:
// 서버가 기억하는 **되돌릴 수 있는 닫기**(멤버십도 상대 쪽도 건드리지 않고, 새 메시지가 오면 다시 나타난다)이고 그래서 확인 단계가 없다.
// 코어 시험이 `DM_CLOSE_LABEL` 에 「나가기」가 들지 않음을 잠가 두었다 — 채널의 「나가기」(관리자가 다시 추가해야 한다)와 섞이지 않게.
// 한 행동에 이름을 둘 만들지 않으려고 코어 낱말을 그대로 쓴다. 낱말을 바꾸려면 코어 `DM_CLOSE_LABEL` 한 줄이고, 웹·사이드바까지 같이 바뀐다.
// =============================================================================

/** 이 시트가 코어 표에서 가져오는 열쇠. 폰이 실행할 줄 아는 열쇠(`PHONE_CHANNEL_ACTION_KEYS`)의 부분집합이다. */
export const CONVERSATION_MENU_ACTION_KEYS: ReadonlySet<ChannelActionKey> = new Set<ChannelActionKey>([
  'mute',
  'close-dm',
  'leave',
]);

/** 코어 `row` 표의 답에서 이 시트의 셋만(알림 · DM 닫기 · 채널 나가기) — 차례·낱말·위험색·진행 낱말은 표의 것 그대로다. */
export function conversationMenuActionItems(target: ChannelRowTarget): ChannelActionItem[] {
  return channelRowActionItems(target).filter(item => CONVERSATION_MENU_ACTION_KEYS.has(item.key));
}

/** 「정보」 행의 낱말. 코어에 없는 폰의 문이다(위 머리말 1). DM 은 대화, 채널은 채널. */
export const CONVERSATION_INFO_LABEL = {dm: '대화 정보', channel: '채널 정보'} as const;

/** 「작업 맡기기」 — 일대일 에이전트 DM 의 문. AI 시트의 행과 같은 낱말이다. */
export const CONVERSATION_DELEGATE_LABEL = '작업 맡기기';

/** 시트 머리의 제목: DM 은 상대 이름, 채널은 `# 이름`. 종류를 모르는 동안(채널 목록이 오기 전)은 이름만 — 모르는 것을 채널이라 부르지 않는다. */
export function conversationMenuTitle(name: string, kind: Channel['kind'] | undefined): string {
  return kind === 'public' || kind === 'private' ? `# ${name}` : name;
}

/** 시트가 보조기술에 자기를 부르는 이름. 사이드바 행 시트와 같은 코어 문장이고, 종류를 모르면 이름 + 「메뉴」다. */
export function conversationMenuAccessibleLabel(name: string, kind: Channel['kind'] | undefined): string {
  return kind === undefined ? `${name} 메뉴` : channelMenuAccessibleLabel(name, kind === 'dm');
}
