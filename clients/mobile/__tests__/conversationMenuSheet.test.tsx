import {
  CHANNEL_COPY_FAILURE,
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MUTE_FAILURE,
  DM_CLOSE_FAILURE,
  DM_CLOSE_LABEL,
  channelCopyIdLabel,
  channelCopyNameLabel,
  channelLeaveConfirmBody,
  channelMuteToggleLabel,
} from '@momo/core/features/channels/model';
import {channelShareUrlFromServerBase} from '@momo/core/features/channels/shareLink';
import {copyLinkActionLabel} from '@momo/core/features/timeline/copyLabels';
import type {ChannelActionItem} from '@momo/core/features/channels/actionModel';
import {pinListHeaderLabel} from '@momo/core/features/timeline/pins';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Dimensions, Image, Keyboard, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {SHEET_ICONS} from '../src/design/icons';
import {COPY_RECEIPT_MS, copyText} from '../src/features/conversation/copy';
import {TOUCH_TARGET} from '../src/design/tokens';
import {ConversationMenuSheet} from '../src/features/conversation/ConversationMenuSheet';
import {
  CONVERSATION_MENU_ACTION_KEYS,
  conversationMenuAccessibleLabel,
  conversationMenuActionItems,
  conversationMenuTitle,
} from '../src/features/conversation/conversationMenu';
import {
  PHONE_CHANNEL_ACTION_KEYS,
  type ChannelRowTarget,
} from '../src/features/sidebar/channelRowActions';
import PushProvider from '../src/push/PushProvider';
import {RealtimeProvider} from '../src/realtime/RealtimeProvider';
import ConversationScreen from '../src/screens/ConversationScreen';
import {SessionProvider} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {openConversationMenu} from './fixtures/conversationMenu';
import {finger, pane} from './fixtures/finger';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {describeCloseContract} from './fixtures/sheetContract';

// =============================================================================
// 대화 머리 ⋮ 가 여는 공용 행동 시트 (#4319, owner 10-27). 옛 ⋮ 는 시스템 액션 시트(제목 + 「취소」 + 「고정한 메시지」)였다.
//
// 이 파일이 재는 것은 네 묶음이다:
//
//   1. 항목의 판정 — 코어 표에서 알림·닫기·나가기만 거른 답(`conversationMenuActionItems`)이 종류·역할·닫기 조건마다 맞는가.
//   2. 시트 하나 — 그려지는 카드·행의 차례와 닫는 길(`closesSheet` 인 문 · 아닌 행동), 진행·실패·확인 단계.
//   3. 셸 안에서 끝까지 — ⋮ → 시트 → 서버(`fetch` 하나만 가짜) → 시트 닫힘·대화 걷힘·낭독. 알림 켜기·끄기, 채널 나가기, DM 닫기.
//   4. 화면 하나 — 채널 목록을 모르는 동안의 ⋮, 채널이 바뀔 때, 요청이 도는 사이 대화가 바뀔 때.
//
// 인물은 모두 가상이다(이도현·박서연, 에이전트 달무리 도우미, 회사 달무리 스튜디오).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HUMAN_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const flatten = (style: unknown) =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

// 복사 실패는 클립보드 모듈이 아니라 **복사 길**(`copyText`)의 답(`false`)으로 흉내 낸다 — 기본은 진짜 구현(상자에 담는다)을 그대로 부른다.
jest.mock('../src/features/conversation/copy', () => {
  const actual = jest.requireActual('../src/features/conversation/copy');
  return {...actual, copyText: jest.fn(actual.copyText)};
});

// 셸을 가짜 시계로 폴링하는 시험의 방 — 실패가 정직한 단정 문장으로 나오게(`fakeClock.ts`). `jest.setTimeout` 은 파일이 시작할 때 한 번 읽힌다.
jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

// ---- 1. 항목의 판정 -------------------------------------------------------------

function target(over: Partial<ChannelRowTarget> = {}): ChannelRowTarget {
  return {
    channel: {id: 'ch-general', kind: 'public', topic: ''},
    title: 'general',
    muted: false,
    selfRole: 'admin',
    readState: null,
    ...over,
  };
}

const dmTarget = (over: Partial<ChannelRowTarget> = {}): ChannelRowTarget =>
  target({
    channel: {id: 'ch-dm-human', kind: 'dm', topic: ''},
    title: '박서연',
    selfRole: 'member',
    ...over,
  });

const keysOf = (items: ChannelActionItem[]) => items.map(item => item.key);

describe('항목은 코어 표의 답에서 거른다 — 새로 짓지 않는다 (#4319)', () => {
  it('채널: 알림 · 채널 나가기. 복사·읽음 같은 사이드바 행의 항목은 이 시트의 것이 아니다', () => {
    expect(keysOf(conversationMenuActionItems(target()))).toEqual(['mute', 'leave']);
  });

  it('채널 나가기는 소유자·관리자에게만 선다(`canLeaveChannel`) — 일반 멤버·손님에게는 서버가 403 으로 답할 막다른 길이다', () => {
    for (const selfRole of ['member', 'guest'] as const) {
      expect([selfRole, keysOf(conversationMenuActionItems(target({selfRole})))]).toEqual([selfRole, ['mute']]);
    }
    for (const selfRole of ['owner', 'admin'] as const) {
      expect([selfRole, keysOf(conversationMenuActionItems(target({selfRole})))]).toEqual([
        selfRole,
        ['mute', 'leave'],
      ]);
    }
    // 역할을 아직 모르면 내놓고 서버가 마지막 말을 한다(코어 규칙).
    expect(keysOf(conversationMenuActionItems(target({selfRole: undefined})))).toEqual(['mute', 'leave']);
  });

  it('DM: 닫기를 내밀 때만 「대화 닫기」가 서고, 나가기는 DM 에 없다 — 역할이 관리자여도', () => {
    expect(keysOf(conversationMenuActionItems(dmTarget({closeOffered: true})))).toEqual(['mute', 'close-dm']);
    expect(keysOf(conversationMenuActionItems(dmTarget({closeOffered: false})))).toEqual(['mute']);
    expect(keysOf(conversationMenuActionItems(dmTarget()))).toEqual(['mute']);
    expect(
      keysOf(conversationMenuActionItems(dmTarget({closeOffered: true, selfRole: 'owner'}))),
    ).toEqual(['mute', 'close-dm']);
  });

  it('채널에는 닫기를 내밀지 않는다 — `closeOffered` 가 참이어도', () => {
    expect(keysOf(conversationMenuActionItems(target({closeOffered: true})))).toEqual(['mute', 'leave']);
  });

  it('낱말·위험색·진행 낱말은 코어 표의 것 그대로다 — 알림은 상태로 뒤집히고, 나가기만 위험색이다', () => {
    const [off] = conversationMenuActionItems(target({muted: false}));
    expect([off.label, off.busyLabel]).toEqual(['알림 끄기', '알림 끄는 중']);
    const [on] = conversationMenuActionItems(target({muted: true}));
    expect([on.label, on.busyLabel]).toEqual(['알림 켜기', '알림 켜는 중']);
    const leave = conversationMenuActionItems(target()).find(item => item.key === 'leave');
    expect([leave?.label, leave?.tone]).toEqual([CHANNEL_LEAVE_LABEL, 'danger']);
    // 「대화 닫기」는 되돌릴 수 있는 닫기라 위험색이 아니다(웹·사이드바 시트와 같은 표).
    const close = conversationMenuActionItems(dmTarget({closeOffered: true})).find(item => item.key === 'close-dm');
    expect([close?.label, close?.tone]).toEqual([DM_CLOSE_LABEL, undefined]);
  });

  it('이 시트가 거르는 열쇠는 폰이 실행할 줄 아는 열쇠의 부분집합이다 — 실행 못 하는 항목을 내밀지 않는다', () => {
    for (const key of CONVERSATION_MENU_ACTION_KEYS) expect([key, PHONE_CHANNEL_ACTION_KEYS.has(key)]).toEqual([key, true]);
    expect([...CONVERSATION_MENU_ACTION_KEYS].sort()).toEqual(['close-dm', 'leave', 'mute']);
  });

  it('머리 제목: DM 은 상대 이름, 채널은 `# 이름`, 종류를 모르는 동안은 이름만 — 모르는 것을 채널이라 부르지 않는다', () => {
    expect(conversationMenuTitle('박서연', 'dm')).toBe('박서연');
    expect(conversationMenuTitle('general', 'public')).toBe('# general');
    expect(conversationMenuTitle('secret', 'private')).toBe('# secret');
    expect(conversationMenuTitle('general', undefined)).toBe('general');
  });

  it('시트가 보조기술에 자기를 부르는 이름은 사이드바 행 시트와 같은 코어 문장이다', () => {
    expect(conversationMenuAccessibleLabel('박서연', 'dm')).toBe('박서연 다이렉트 메시지 메뉴');
    expect(conversationMenuAccessibleLabel('general', 'public')).toBe('general 채널 메뉴');
    expect(conversationMenuAccessibleLabel('general', undefined)).toBe('general 메뉴');
  });
});

// ---- 2. 시트 하나 ---------------------------------------------------------------

type SheetProps = React.ComponentProps<typeof ConversationMenuSheet>;

function sheetProps(over: Partial<SheetProps> = {}): SheetProps {
  return {
    title: '박서연',
    kind: 'dm',
    pinLabel: '고정한 메시지',
    onOpenPins: jest.fn(),
    items: [],
    confirmingLeave: false,
    isPending: () => false,
    error: null,
    leave: {pending: false, error: null},
    onRun: jest.fn(),
    onConfirmLeave: jest.fn(),
    onCancelLeave: jest.fn(),
    onClose: jest.fn(),
    ...over,
  };
}

/** 이 시험이 지금 세워 둔 시트. 한 시험 안에서 다시 세우면 앞의 것을 **내리고** 세운다 — `cleanup()` 뒤에 `render()` 를 부르면 RNTL 이 새 렌더러를 곧바로 내린다. */
let mountedSheet: ReturnType<typeof render> | null = null;

function renderSheet(over: Partial<SheetProps> = {}): SheetProps {
  const props = sheetProps(over);
  mountedSheet?.unmount();
  mountedSheet = render(<ConversationMenuSheet {...props} />);
  return props;
}

afterEach(() => {
  mountedSheet = null;
});

/** 시트가 **그린 순서대로**의 행 이름(`conversation-menu-` 뒤). */
const rowKeys = () =>
  screen
    .queryAllByTestId(/^conversation-menu-(info|pins|delegate|mute-toggle|close-dm|leave)$/)
    .map(node => String(node.props.testID).replace('conversation-menu-', ''));

const MUTE_OFF = conversationMenuActionItems(target({muted: false}))[0];
const LEAVE = conversationMenuActionItems(target()).find(item => item.key === 'leave') as ChannelActionItem;
const CLOSE_DM = conversationMenuActionItems(dmTarget({closeOffered: true})).find(
  item => item.key === 'close-dm',
) as ChannelActionItem;

/** 슬라이드 없이 바로 닫혀 `closesSheet` 행이 동기 단정이 된다. 이 묶음 안에서만 켠다 — 닫는 계약(`describeCloseContract`)은 제 상태를 스스로 정한다. */
function motionOff() {
  let release: (() => void) | null = null;
  beforeEach(async () => {
    release = await pinReduceMotion(true);
  });
  afterEach(() => {
    release?.();
    release = null;
  });
}

describe('시트 — 카드와 행의 차례 (#4319)', () => {
  motionOff();

  it('에이전트 DM: 문 셋(정보 · 고정 · 작업 맡기기)은 한 카드, 알림과 닫기는 각자 카드 — 구분선은 첫 카드 안의 둘뿐이다', () => {
    renderSheet({
      onOpenInfo: jest.fn(),
      onDelegateWork: jest.fn(),
      items: [MUTE_OFF, CLOSE_DM],
    });
    expect(rowKeys()).toEqual(['info', 'pins', 'delegate', 'mute-toggle', 'close-dm']);
    // 카드 하나가 자식 사이에만 구분선을 세운다: 한 카드에 다 담겼다면 넷, 셋으로 갈렸으니 첫 카드의 둘뿐이다.
    expect(screen.getAllByTestId('group-divider')).toHaveLength(2);
    const doors = within(screen.getByTestId('conversation-menu-doors'));
    for (const key of ['info', 'pins', 'delegate']) expect(doors.getByTestId(`conversation-menu-${key}`)).toBeTruthy();
    expect(doors.queryByTestId('conversation-menu-mute-toggle')).toBeNull();
  });

  it('고정한 메시지는 늘 서고, 정보·작업 맡기기·알림·닫기는 줄 때만 선다 — 눌러도 아무 일 없는 행은 없다', () => {
    renderSheet();
    expect(rowKeys()).toEqual(['pins']);
    // 카드 하나, 행 하나 — 구분선이 없다.
    expect(screen.queryAllByTestId('group-divider')).toHaveLength(0);
  });

  it('정보 행: `onOpenInfo` 가 없으면 서지 않고(문이 없다), 있으면 DM 은 「대화 정보」, 채널은 「채널 정보」다', () => {
    renderSheet({kind: 'dm'});
    expect(screen.queryByTestId('conversation-menu-info')).toBeNull();

    renderSheet({kind: 'dm', onOpenInfo: jest.fn()});
    expect(screen.getByTestId('conversation-menu-info')).toHaveTextContent('대화 정보');

    renderSheet({kind: 'public', title: 'general', onOpenInfo: jest.fn()});
    expect(screen.getByTestId('conversation-menu-info')).toHaveTextContent('채널 정보');
  });

  it('내용 맞춤 단이다 — 높이를 고정하지 않고, 화면의 85% 위로는 안에서 스크롤한다(큰 글씨·SE 의 안전망)', () => {
    renderSheet({items: [MUTE_OFF]});
    const frame = flatten(screen.getByTestId('page-sheet').props.style);
    const windowHeight = Dimensions.get('window').height;
    // 큰 단은 `top`, 중간 단은 `height` 를 갖는다 — 내용 맞춤은 둘 다 없고 최대 높이만 갖는다.
    expect([frame.top, frame.height]).toEqual([undefined, undefined]);
    expect(Number(frame.maxHeight)).toBeLessThanOrEqual(Math.floor(windowHeight * 0.85));
    expect(Number(frame.maxHeight)).toBeGreaterThan(windowHeight / 2);
  });

  it('종류를 모르는 동안(채널 목록이 오기 전)에는 `onOpenInfo` 가 있어도 정보 행이 서지 않는다 — 무엇이라 부를지 모른다', () => {
    renderSheet({kind: undefined, onOpenInfo: jest.fn()});
    expect(screen.queryByTestId('conversation-menu-info')).toBeNull();
    expect(rowKeys()).toEqual(['pins']);
  });

  it('고정 행의 낱말은 부른 쪽이 코어 `pinListHeaderLabel` 로 정한 것이다', () => {
    renderSheet({pinLabel: pinListHeaderLabel(3, 'ready')});
    expect(screen.getByTestId('conversation-menu-pins')).toHaveTextContent('고정 3개');
  });

  it('머리 제목과 시트 이름: DM 은 상대 이름 · 채널은 `# 이름`', () => {
    renderSheet({kind: 'dm', title: '박서연'});
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent('박서연');
    expect(screen.getByTestId('page-sheet').props.accessibilityLabel).toBe('박서연 다이렉트 메시지 메뉴');
    renderSheet({kind: 'public', title: 'general'});
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent('# general');
    expect(screen.getByTestId('page-sheet').props.accessibilityLabel).toBe('general 채널 메뉴');
  });

  it('행은 공용 부품이다 — 앞 아이콘이 없고, 눌림 높이가 44 이상이며, 제목은 어절 단위로 줄바꿈하고 잘리지 않는다', () => {
    renderSheet({
      onOpenInfo: jest.fn(),
      onDelegateWork: jest.fn(),
      items: [MUTE_OFF, CLOSE_DM],
    });
    for (const key of ['info', 'pins', 'delegate', 'mute-toggle', 'close-dm']) {
      const id = `conversation-menu-${key}`;
      const row = screen.getByTestId(id);
      // 요소 자체를 비교하지 않는다 — 실패하면 렌더 트리 통째가 출력돼 시험 프로세스가 죽는다. 있는가 없는가만 비교한다.
      expect([key, screen.queryByTestId(`${id}-lead`) === null]).toEqual([key, true]);
      expect([key, Number(flatten(row.props.style).minHeight) >= TOUCH_TARGET]).toEqual([key, true]);
      const title = within(row).getAllByText(/\S/)[0];
      expect([key, title.props.numberOfLines]).toEqual([key, undefined]);
      expect([key, title.props.lineBreakStrategyIOS]).toEqual([key, 'hangul-word']);
    }
  });

  it('문 셋에는 ›(chevron) 가 서고, 알림·닫기에는 서지 않는다 — 가는 곳이 있는 행과 하는 일이 갈린다', () => {
    renderSheet({onOpenInfo: jest.fn(), onDelegateWork: jest.fn(), items: [MUTE_OFF, CLOSE_DM]});
    const chevrons = (key: string) =>
      within(screen.getByTestId(`conversation-menu-${key}`))
        .UNSAFE_queryAllByType(Image)
        .filter(node => node.props.source === SHEET_ICONS.chevron).length;
    for (const key of ['info', 'pins', 'delegate']) expect([key, chevrons(key)]).toEqual([key, 1]);
    for (const key of ['mute-toggle', 'close-dm']) expect([key, chevrons(key)]).toEqual([key, 0]);
  });
});

describe('시트 — 닫는 길: 문은 시트를 먼저 내리고, 행동은 시트가 진행을 보인다 (#4319)', () => {
  motionOff();

  it('고정 · 정보 · 작업 맡기기는 `closesSheet` 다 — 시트가 먼저 닫히고(onClose) 그 뒤에 문이 한 번 열린다', () => {
    const calls: string[] = [];
    const over: Partial<SheetProps> = {
      onOpenInfo: jest.fn(() => calls.push('info')),
      onOpenPins: jest.fn(() => calls.push('pins')),
      onDelegateWork: jest.fn(() => calls.push('delegate')),
      onClose: jest.fn(() => calls.push('close')),
    };
    for (const key of ['info', 'pins', 'delegate']) {
      // 눌린 시트는 닫는 중이라 다시 누르지 못한다 — 행마다 새로 세운다.
      renderSheet(over);
      calls.length = 0;
      fireEvent.press(screen.getByTestId(`conversation-menu-${key}`));
      // 순서가 약속이다: 닫기가 먼저, 문이 나중, 각각 한 번.
      expect([key, calls]).toEqual([key, ['close', key]]);
    }
  });

  it('알림 · 대화 닫기 · 채널 나가기는 `closesSheet` 가 아니다 — 시트를 닫지 않고 바로 실행을 부탁한다', () => {
    const dm = renderSheet({items: [MUTE_OFF, CLOSE_DM]});
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    fireEvent.press(screen.getByTestId('conversation-menu-close-dm'));
    expect(dm.onRun).toHaveBeenNthCalledWith(1, 'mute');
    expect(dm.onRun).toHaveBeenNthCalledWith(2, 'close-dm');
    expect(dm.onClose).not.toHaveBeenCalled();

    const channel = renderSheet({kind: 'public', title: 'general', items: [LEAVE]});
    fireEvent.press(screen.getByTestId('conversation-menu-leave'));
    expect(channel.onRun).toHaveBeenCalledWith('leave');
    expect(channel.onClose).not.toHaveBeenCalled();
  });

  it('왕복 중인 행은 진행 낱말로 바뀌고 busy 를 말한다 — 잠그거나 흐리게 하지 않는다', () => {
    renderSheet({items: [MUTE_OFF, CLOSE_DM], isPending: key => key === 'mute'});
    const mute = screen.getByTestId('conversation-menu-mute-toggle');
    expect(mute).toHaveTextContent('알림 끄는 중');
    expect(mute.props.accessibilityState).toMatchObject({busy: true, disabled: false});
    const close = screen.getByTestId('conversation-menu-close-dm');
    expect(close.props.accessibilityState).toMatchObject({busy: false});
  });

  it('위험색은 코어 표가 정한 행에만 선다 — 채널 나가기는 위험색, 알림·대화 닫기는 아니다', () => {
    renderSheet({kind: 'public', title: 'general', items: [MUTE_OFF, LEAVE]});
    const titleOf = (key: string) =>
      flatten(within(screen.getByTestId(`conversation-menu-${key}`)).getByText(/\S/).props.style);
    const leaveColor = titleOf('leave').color;
    expect(titleOf('mute-toggle').color).not.toBe(leaveColor);
    renderSheet({items: [MUTE_OFF, CLOSE_DM]});
    expect(
      flatten(within(screen.getByTestId('conversation-menu-close-dm')).getByText(/\S/).props.style).color,
    ).not.toBe(leaveColor);
  });

  it('알림·닫기가 거절되면 시트 안에서 이유를 말한다 — 토스트가 아니라 alert 문장', () => {
    renderSheet({items: [MUTE_OFF], error: CHANNEL_MUTE_FAILURE});
    const error = screen.getByTestId('conversation-menu-error');
    expect(error).toHaveTextContent(CHANNEL_MUTE_FAILURE);
    expect(error.props.accessibilityRole).toBe('alert');
  });

  it('실패 문장이 없으면 줄도 없다', () => {
    renderSheet({items: [MUTE_OFF]});
    expect(screen.queryByTestId('conversation-menu-error')).toBeNull();
  });
});

describe('시트 — 채널 나가기의 확인 단계 (#4319)', () => {
  motionOff();

  const channelSheet = (over: Partial<SheetProps> = {}) =>
    renderSheet({kind: 'public', title: 'general', items: [MUTE_OFF, LEAVE], confirmingLeave: true, ...over});

  it('확인 단계는 코어 문장 그대로이고, 항목 카드는 사라진다', () => {
    channelSheet();
    expect(screen.getByTestId('conversation-menu-leave-confirm-headline')).toHaveTextContent(CHANNEL_LEAVE_CONFIRM_TITLE);
    expect(screen.getByTestId('conversation-menu-leave-confirm-detail')).toHaveTextContent(
      channelLeaveConfirmBody('general'),
    );
    expect(screen.getByTestId('conversation-menu-leave-confirm-button')).toHaveTextContent(CHANNEL_LEAVE_LABEL);
    for (const key of ['pins', 'mute-toggle', 'leave']) {
      expect([key, screen.queryByTestId(`conversation-menu-${key}`) === null]).toEqual([key, true]);
    }
  });

  it('「취소」와 「채널 나가기」가 제 일을 한 번씩 부른다', () => {
    const props = channelSheet();
    fireEvent.press(screen.getByTestId('conversation-menu-leave-cancel'));
    expect(props.onCancelLeave).toHaveBeenCalledTimes(1);
    expect(props.onConfirmLeave).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('conversation-menu-leave-confirm-button'));
    expect(props.onConfirmLeave).toHaveBeenCalledTimes(1);
  });

  it('왕복 중이면 위험 단추가 잠기고 「나가는 중…」이 진행을 말한다', () => {
    const props = channelSheet({leave: {pending: true, error: null}});
    const confirm = screen.getByTestId('conversation-menu-leave-confirm-button');
    expect(confirm).toHaveTextContent('나가는 중…');
    expect(confirm.props.accessibilityState).toMatchObject({busy: true, disabled: true});
    fireEvent.press(confirm);
    expect(props.onConfirmLeave).not.toHaveBeenCalled();
  });

  it('실패는 확인 단계 안에서 말한다 — 시트를 닫지 않는다', () => {
    const props = channelSheet({leave: {pending: false, error: '채널에서 나갈 권한이 없습니다.'}});
    expect(screen.getByTestId('conversation-menu-leave-error')).toHaveTextContent(/나갈 권한이 없습니다/);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('conversation-menu-leave-confirm')).toBeTruthy();
  });
});

const closes = jest.fn();

describeCloseContract({
  name: 'ConversationMenuSheet',
  open: () => {
    closes.mockReset();
    renderSheet({onClose: closes, items: [MUTE_OFF, CLOSE_DM]});
  },
  closedCount: () => closes.mock.calls.length,
  closeTestID: 'conversation-menu-close',
  closeLabel: '대화 메뉴 닫기',
  scrimTestID: 'conversation-menu-backdrop',
  scrimLabel: '대화 메뉴 닫기',
});

// ---- 3. 셸 안에서 끝까지 ----------------------------------------------------------
//
// 가짜는 `fetch` 하나뿐이다. 화면·훅·시트·셸은 전부 진짜이고, 그래서 이 단정들은 「호출했는가」가 아니라 **서버가 무엇을 받았고 화면이 어떻게 됐는가**다.

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-quiet', workspaceId: WS, kind: 'public', name: 'quiet', muted: true},
  {id: 'ch-dm-human', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, HUMAN_ID]},
  {id: 'ch-dm-agent', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, AGENT_ID]},
];

const ROW = {
  general: 'sidebar-row-channel:ch-general',
  quiet: 'sidebar-row-channel:ch-quiet',
  human: 'sidebar-row-dm:ch-dm-human',
  agent: 'sidebar-row-dm:ch-dm-agent',
} as const;

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    role: 'member',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const CHANNEL_TOPIC = '다음 배포 일정과 장애 대응을 이야기해요.';
/** 1×1 PNG — `data:` 주소라 서버 주소·받기 없이 `Avatar` 가 이미지로 싣는다. */
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const PINNED_WIRE = {
  messageId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  channelId: 'ch-general',
  seq: 3,
  authorMemberId: HUMAN_ID,
  type: 'text',
  state: 'sent',
  body: '배포 순서는 이 문서가 정본입니다.',
  createdAtMs: BASE_MS,
  pinnedBy: SELF_ID,
  pinnedAtMs: BASE_MS + 1_000,
};

interface Routes {
  /** 서버가 닫기를 싣는 투영(`latest_readable_seq`·`closed_at_seq` 가 모든 행에 있다)인가. 기본은 옛 서버 — 닫기를 내밀지 않는다. */
  serverClosure?: boolean;
  /** 사람 DM 에 안 읽은 메시지가 있다(닫기는 안 읽은 것이 없을 때만 내밀어진다). */
  dmUnread?: boolean;
  /** 사람 DM 에 멘션이 하나 있다(안 읽은 수는 0). 멘션이 있으면 닫기를 내밀지 않는다. */
  dmMention?: boolean;
  /**
   * 사람 DM 을 「여기부터 안 읽음」으로 표시해 뒀다 — 서버는 이 표시를 `unread_count` 에 접지 않는다(wire 의 안 읽음은 0). 화면이 코어의
   * 합성(`composedUnreadCount`, ADR-0178 D3)으로 읽어야만 안 읽음이 1 로 보인다.
   */
  dmMarkedUnread?: boolean;
  /** 사람 DM 의 읽음 투영 행이 없다(메시지가 한 번도 없는 DM) — 닫을 때 적을 행이 없다. */
  noDmRow?: boolean;
  selfRole?: string;
  pins?: unknown[];
  /** 박서연의 프로필 사진(`data:` 주소) — 정보 페이지의 큰 얼굴이 사진 단추가 된다. */
  photo?: boolean;
  /** 에이전트가 호스트에 닿아 있다(`hostOnline`) — 머리 알약과 정보 페이지에 상태 낱말(「연결됨」)이 선다. */
  agentOnline?: boolean;
  /** 일반 채널 `general` 이 멤버 목록·주제를 싣는다 — 머리 알약의 멤버 수와 정보 페이지의 부제·주제. */
  channelInfo?: boolean;
  /** 응답 상태. 기본은 성공. */
  muteStatus?: number;
  closeStatus?: number;
  leaveStatus?: number;
  /** 이 요청들은 `releaseHeld()` 전까지 끝나지 않는다 — 진행 중의 화면을 본다. */
  hold?: Array<'mute' | 'close' | 'leave'>;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let muted = new Set<string>();
let left = new Set<string>();
let closedDms = new Map<string, number>();
let held: Array<() => void> = [];

function releaseHeld(): void {
  const waiting = held;
  held = [];
  for (const resume of waiting) resume();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const callsTo = (suffix: string) => calls.filter(call => call.url.endsWith(suffix) || call.url.includes(suffix));

function readStates(routes: Routes) {
  const human = {channel_id: 'ch-dm-human', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0};
  const rows = [
    {channel_id: 'ch-general', last_read_seq: 15, latest_seq: 15, unread_count: 0, mention_count: 0},
    {channel_id: 'ch-quiet', last_read_seq: 7, latest_seq: 7, unread_count: 0, mention_count: 0},
    ...(routes.noDmRow
      ? []
      : [
          routes.dmUnread
            ? {...human, last_read_seq: 1, unread_count: 1}
            : routes.dmMention
              ? {...human, mention_count: 1}
              : routes.dmMarkedUnread
                ? {...human, marked_unread_before_seq: 2}
                : human,
        ]),
    {channel_id: 'ch-dm-agent', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0},
  ];
  return routes.serverClosure
    ? rows.map(row => ({
        ...row,
        latest_readable_seq: row.latest_seq,
        closed_at_seq: closedDms.get(row.channel_id) ?? null,
      }))
    : rows;
}

function installFetch(routes: Routes = {}) {
  calls = [];
  muted = new Set(CHANNELS.filter(channel => channel.muted).map(channel => channel.id));
  left = new Set();
  closedDms = new Map();
  held = [];
  const gate = (kind: 'mute' | 'close' | 'leave') =>
    routes.hold?.includes(kind)
      ? new Promise<void>(resolve => held.push(resolve))
      : Promise.resolve();
  const channelList = () =>
    CHANNELS.filter(channel => !left.has(channel.id)).map(channel => ({
      ...channel,
      muted: muted.has(channel.id),
      ...(routes.channelInfo && channel.id === 'ch-general'
        ? {memberIds: [SELF_ID, HUMAN_ID, AGENT_ID], topic: CHANNEL_TOPIC}
        : null),
    }));
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (method !== 'GET') calls.push({method, url, body});
    const closure = /\/channels\/([^/]+)\/closure$/.exec(url);
    if (closure && method === 'PUT') {
      await gate('close');
      if ((routes.closeStatus ?? 204) !== 204) {
        return jsonResponse(routes.closeStatus as number, {error: {message: 'nope'}});
      }
      closedDms.set(closure[1], Number(body?.seenSeq));
      return jsonResponse(204, {});
    }
    const pref = /\/channels\/([^/]+)\/notification-pref$/.exec(url);
    if (pref && method === 'PUT') {
      await gate('mute');
      if ((routes.muteStatus ?? 200) !== 200) {
        return jsonResponse(routes.muteStatus as number, {error: {message: 'nope'}});
      }
      if (body?.muted === true) muted.add(pref[1]);
      else muted.delete(pref[1]);
      return jsonResponse(200, {muted: body?.muted});
    }
    if (method === 'PUT' && url.includes('/read-state')) {
      // 읽음 커서는 서버 상태를 바꾸지 않는다 — 이 시험의 안 읽음은 시험이 정한 값 그대로다.
      return jsonResponse(200, {
        channel_id: 'ch-general',
        last_read_seq: body?.last_read_seq,
        latest_seq: 15,
        unread_count: 0,
        mention_count: 0,
      });
    }
    const member = /\/channels\/([^/]+)\/members\/[^/]+$/.exec(url);
    if (member && method === 'DELETE') {
      await gate('leave');
      if ((routes.leaveStatus ?? 200) !== 200) {
        return jsonResponse(routes.leaveStatus as number, {error: {message: 'forbidden'}});
      }
      left.add(member[1]);
      return jsonResponse(200, {
        membership: {
          id: 'm1',
          workspaceId: WS,
          channelId: member[1],
          memberId: SELF_ID,
          role: 'member',
          joinedAtMs: 1,
          leftAtMs: 2,
        },
      });
    }
    if (url.includes('/pins')) return jsonResponse(200, {pins: routes.pins ?? []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/channels')) return jsonResponse(200, {channels: channelList()});
    if (url.includes('/roster')) {
      return jsonResponse(200, {
        members: [
          rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: routes.selfRole ?? 'admin'}),
          rosterMember({
            id: HUMAN_ID,
            displayName: '박서연',
            handle: 'seoyeon',
            ...(routes.photo ? {avatarUrl: PHOTO} : null),
          }),
          rosterMember({
            id: AGENT_ID,
            kind: 'agent',
            displayName: '달무리 도우미',
            handle: 'dalmuri-helper',
            ownerHumanId: SELF_ID,
            ...(routes.agentOnline ? {hostOnline: true} : null),
          }),
        ],
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: readStates(routes)});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/liveness')) return jsonResponse(404, {error: {message: 'not found'}});
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return jsonResponse(200, {workspace: {id: WS, slug: 'dalmuri', name: '달무리 스튜디오', updatedAtMs: 0}});
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

function newClient(): QueryClient {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return queryClient;
}

async function mountShell(routes: Routes = {}) {
  installFetch(routes);
  render(
    <QueryClientProvider client={newClient()}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId(ROW.general)).toBeTruthy());
}

/** 사이드바 행을 눌러 대화를 열고, 머리의 ⋮ 가 서기를 기다린다. */
async function openConversation(rowTestID: string) {
  fireEvent.press(screen.getByTestId(rowTestID));
  await screen.findByTestId('conversation-menu');
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;

/** 이 파일의 셸·화면 시험이 공유하는 환경: 로그인한 세션, 가짜 시계(`installAppClock`), 슬라이드 없는 닫힘. */
function liveWorld() {
  let release: (() => void) | null = null;
  beforeEach(async () => {
    installAppClock();
    release = await pinReduceMotion(true);
    mmkvStore.clear();
    __resetSessionStore();
    __resetServerBaseCache();
    setServerBase(BASE);
    sessionPort.applyLogin({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
      member: SELF,
    });
    hapticCalls.length = 0;
  });
  afterEach(() => {
    releaseHeld();
    cleanup();
    queryClient?.clear();
    queryClient = null;
    release?.();
    release = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}

const menuKeys = rowKeys;
const announce = () => jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

describe('셸 — ⋮ 시트의 항목은 대화마다 다르다 (#4319)', () => {
  liveWorld();

  it('채널(관리자): 고정한 메시지 · 알림 끄기 · 채널 나가기 — 머리는 `# 이름`, 정보 행이 첫 줄이다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent('# general');
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle', 'leave']);
    expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 끄기');
    expect(screen.getByTestId('conversation-menu-leave')).toHaveTextContent(CHANNEL_LEAVE_LABEL);
  });

  it('일반 멤버에게는 채널 나가기가 없다', async () => {
    await mountShell({selfRole: 'member'});
    await openConversation(ROW.general);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('알림이 꺼진 채널은 「알림 켜기」다', async () => {
    await mountShell();
    await openConversation(ROW.quiet);
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 켜기');
  });

  it('사람 DM(서버가 닫기를 싣고 다 읽음): 고정 · 알림 · 대화 닫기 — 머리는 상대 이름이고 나가기는 없다', async () => {
    await mountShell({serverClosure: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent('박서연');
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle', 'close-dm']);
    expect(screen.getByTestId('conversation-menu-close-dm')).toHaveTextContent(DM_CLOSE_LABEL);
  });

  it('에이전트 DM: 작업 맡기기가 고정 다음에 서고, 사람 DM 에는 서지 않는다', async () => {
    await mountShell({serverClosure: true});
    await openConversation(ROW.agent);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'delegate', 'mute-toggle', 'close-dm']);
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).not.toContain('delegate');
  });

  it('안 읽은 메시지가 있는 DM 에는 닫기를 내밀지 않는다 — 지금 서버가 말하는 안 읽음을 본다 (2026-10-17 소유자 결정)', async () => {
    await mountShell({serverClosure: true, dmUnread: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('멘션이 있는 DM 에도 닫기를 내밀지 않는다 — 안 읽은 수가 0 이어도', async () => {
    await mountShell({serverClosure: true, dmMention: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('「여기부터 안 읽음」 표시가 있는 DM 에도 내밀지 않는다 — wire 의 안 읽음이 0 이어도 코어 합성(ADR-0178 D3)으로 읽는다', async () => {
    await mountShell({serverClosure: true, dmMarkedUnread: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('읽음 투영 행이 없는 DM(메시지가 한 번도 없다)에는 내밀지 않는다 — 눌러도 아무 일도 못 하는 행은 없다', async () => {
    await mountShell({serverClosure: true, noDmRow: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('서버가 닫기를 싣지 않는 옛 서버에서는 닫기를 내밀지 않는다 — 폰에 기기 로컬 닫기는 없다', async () => {
    await mountShell({serverClosure: false});
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('채널에는 서버가 닫기를 실어도 닫기가 없다 — 나가기가 없는 일반 멤버라도(나가기가 있으면 한 자리를 먼저 차지해 가린다)', async () => {
    await mountShell({serverClosure: true, selfRole: 'member'});
    await openConversation(ROW.general);
    await openConversationMenu();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle']);
  });

  it('고정 행의 낱말은 고정 읽기가 끝나면 개수를 말한다 — 코어 `pinListHeaderLabel`', async () => {
    await mountShell({pins: [PINNED_WIRE]});
    await openConversation(ROW.general);
    await openConversationMenu();
    // 읽기가 오기 전에는 이름만(「고정한 메시지」) — 모르는 개수를 말하지 않는다. 끝나면 시트가 열린 채로 개수를 말한다.
    await waitFor(() =>
      expect(screen.getByTestId('conversation-menu-pins')).toHaveTextContent(pinListHeaderLabel(1, 'ready')),
    );
    expect(pinListHeaderLabel(1, 'ready')).toBe('고정 1개');
  });
});

describe('셸 — 문은 시트를 먼저 내린다 (#4319)', () => {
  liveWorld();

  it('「고정한 메시지」: 시트가 걷히고 고정 목록이 선다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openConversationMenu();
    expect(screen.queryByTestId('pin-list-pane')).toBeNull();
    fireEvent.press(screen.getByTestId('conversation-menu-pins'));
    await waitFor(() => expect(screen.getByTestId('pin-list-pane')).toBeTruthy());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });

  it('「작업 맡기기」: 시트가 걷히고 그 에이전트로 정해진 작업 시트가 선다', async () => {
    await mountShell();
    await openConversation(ROW.agent);
    await openConversationMenu();
    expect(screen.queryByTestId('delegate-sheet')).toBeNull();
    fireEvent.press(screen.getByTestId('conversation-menu-delegate'));
    await waitFor(() => expect(screen.getByTestId('delegate-sheet')).toBeTruthy());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });

  it('⋮ 를 누르면 가벼운 햅틱 한 번이다 — 행을 길게 눌러 여는 무거운 진동이 아니다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    hapticCalls.length = 0;
    fireEvent.press(screen.getByTestId('conversation-menu'));
    await screen.findByTestId('conversation-menu-sheet');
    expect(hapticCalls).toEqual(['impact:light']);
  });
});

describe('셸 — 알림 끄기·켜기 (#4319)', () => {
  liveWorld();

  it('끄기: notification-pref 에 muted:true 를 보내고, 성공하면 시트가 걷히고 낭독하며, 다시 열면 「알림 켜기」다', async () => {
    const spoken = announce();
    await mountShell();
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(callsTo('/notification-pref')).toHaveLength(1));
    const put = callsTo('/notification-pref')[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toContain('/channels/ch-general/notification-pref');
    expect(put.body).toEqual({muted: true});
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    expect(spoken).toHaveBeenCalledWith('알림을 껐습니다.');
    // 대화는 그대로 열려 있다 — 알림은 대화를 걷지 않는다.
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    // 서버가 진실이다: 채널 목록을 다시 읽어 새 값이 흘러 내려온다.
    await openConversationMenu();
    await waitFor(() =>
      expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 켜기'),
    );
  });

  it('켜기: 꺼진 채널은 muted:false 를 보내고 「알림을 켰습니다.」를 낭독한다', async () => {
    const spoken = announce();
    await mountShell();
    await openConversation(ROW.quiet);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(callsTo('/notification-pref')).toHaveLength(1));
    expect(callsTo('/notification-pref')[0].url).toContain('/channels/ch-quiet/notification-pref');
    expect(callsTo('/notification-pref')[0].body).toEqual({muted: false});
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    expect(spoken).toHaveBeenCalledWith('알림을 켰습니다.');
  });

  it('요청이 도는 동안 시트는 열려 있고 행이 「알림 끄는 중」으로 바뀐다 — 끝나야 닫힌다', async () => {
    await mountShell({hold: ['mute']});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 끄는 중'),
    );
    expect(screen.getByTestId('conversation-menu-mute-toggle').props.accessibilityState).toMatchObject({
      busy: true,
    });
    expect(screen.getByTestId('conversation-menu-sheet')).toBeTruthy();
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
  });

  it('도는 중에 다시 눌러도 요청은 한 번이다', async () => {
    await mountShell({hold: ['mute']});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 끄는 중'),
    );
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    expect(callsTo('/notification-pref')).toHaveLength(1);
  });

  it('거절되면 시트가 열린 채 그 자리에서 이유를 말하고 낭독한다 — 행은 원래 낱말로 돌아온다', async () => {
    const spoken = announce();
    await mountShell({muteStatus: 500});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-menu-error')).toHaveTextContent(CHANNEL_MUTE_FAILURE);
    expect(spoken).toHaveBeenCalledWith(CHANNEL_MUTE_FAILURE);
    expect(screen.getByTestId('conversation-menu-sheet')).toBeTruthy();
    expect(screen.getByTestId('conversation-menu-mute-toggle')).toHaveTextContent('알림 끄기');
    expect(muted.has('ch-general')).toBe(false);
  });

  it('도는 중에 시트를 내렸는데 거절되면 시트가 다시 서서 이유를 말한다 — 실패는 삼켜지지 않는다 (훅의 `failed`)', async () => {
    const spoken = announce();
    await mountShell({muteStatus: 500, hold: ['mute']});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(callsTo('/notification-pref')).toHaveLength(1));
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.getByTestId('conversation-menu-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-menu-error')).toHaveTextContent(CHANNEL_MUTE_FAILURE);
    expect(spoken).toHaveBeenCalledWith(CHANNEL_MUTE_FAILURE);
  });

  it('실패한 뒤 X 로 닫았다 다시 열면 지난 실패 문장이 없다 — X 가 훅의 상태를 비운다', async () => {
    await mountShell({muteStatus: 500});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu-error')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    await openConversationMenu();
    expect(screen.queryByTestId('conversation-menu-error')).toBeNull();
  });
});

describe('셸 — 채널 나가기는 확인 단계를 지난다 (#4319)', () => {
  liveWorld();

  async function toConfirm(routes: Routes = {}) {
    await mountShell(routes);
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-leave'));
  }

  it('누르면 DELETE 가 아니라 확인이 먼저다 — 취소하면 항목으로 돌아온다', async () => {
    await toConfirm();
    expect(screen.getByTestId('conversation-menu-leave-confirm')).toBeTruthy();
    expect(screen.queryByTestId('conversation-menu-mute-toggle')).toBeNull();
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    fireEvent.press(screen.getByTestId('conversation-menu-leave-cancel'));
    expect(screen.queryByTestId('conversation-menu-leave-confirm')).toBeNull();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle', 'leave']);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });

  it('확인하면 내 멤버십을 지우고, 서버가 답한 뒤에 시트가 걷히고 열려 있던 대화도 걷힌다', async () => {
    const spoken = announce();
    await toConfirm();
    fireEvent.press(screen.getByTestId('conversation-menu-leave-confirm-button'));
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE')).toBe(true));
    const del = calls.find(call => call.method === 'DELETE')!;
    expect(del.url).toContain(`/channels/ch-general/members/${SELF_ID}`);
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    expect(spoken).toHaveBeenCalledWith('채널에서 나갔습니다.');
    // 나간 채널은 목록에서 사라진다.
    await waitFor(() => expect(screen.queryByTestId(ROW.general)).toBeNull());
  });

  it('403: 확인 단계가 그대로 서서 이유를 말한다 — 시트도 대화도 사라지지 않는다', async () => {
    await toConfirm({leaveStatus: 403});
    fireEvent.press(screen.getByTestId('conversation-menu-leave-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu-leave-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-menu-leave-error')).toHaveTextContent(/나갈 권한이 없습니다/);
    expect(screen.getByTestId('conversation-menu-leave-confirm')).toBeTruthy();
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
  });

  it('도는 중에는 위험 단추가 잠겨 두 번 눌러도 DELETE 는 한 번이다', async () => {
    await toConfirm({hold: ['leave']});
    fireEvent.press(screen.getByTestId('conversation-menu-leave-confirm-button'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-menu-leave-confirm-button')).toHaveTextContent('나가는 중…'),
    );
    fireEvent.press(screen.getByTestId('conversation-menu-leave-confirm-button'));
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });

  it('확인 단계에서 X 로 닫으면 시트가 걷히고, 다시 열면 항목 목록이다', async () => {
    await toConfirm();
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    await openConversationMenu();
    expect(screen.queryByTestId('conversation-menu-leave-confirm')).toBeNull();
    expect(menuKeys()).toEqual(['info', 'pins', 'mute-toggle', 'leave']);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });

  it('배경(스크림)을 눌러도 닫힌다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-backdrop', {includeHiddenElements: true}));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
  });
});

describe('셸 — DM 의 「대화 닫기」 (#4319, ADR-0177 증보 D7)', () => {
  liveWorld();

  const closeRow = 'conversation-menu-close-dm';

  it('누르면 서버에 PUT …/closure 를 seenSeq(투영의 latestSeq)로 한 번 보내고, 대화가 걷히고, 「대화를 닫았습니다.」를 낭독하고, 행이 목록에서 사라진다', async () => {
    const spoken = announce();
    await mountShell({serverClosure: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId(closeRow));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    const put = callsTo('/closure')[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toContain('/channels/ch-dm-human/closure');
    expect(put.body).toEqual({seenSeq: 2});
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    // 대화가 걷히며 낭독이 삼켜지지 않는다 — 훅이 걷기 전에 알린다.
    expect(spoken).toHaveBeenCalledWith('대화를 닫았습니다.');
    await waitFor(() => expect(screen.queryByTestId(ROW.human)).toBeNull());
  });

  it('확인 단계가 없다 — 되돌릴 수 있는 닫기라 누르면 곧 서버로 간다', async () => {
    await mountShell({serverClosure: true});
    await openConversation(ROW.human);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId(closeRow));
    expect(screen.queryByTestId('conversation-menu-leave-confirm')).toBeNull();
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
  });

  it('서버가 거절하면(500) 시트가 열린 채 그 자리에서 이유를 말하고, 대화는 그대로다', async () => {
    const spoken = announce();
    await mountShell({serverClosure: true, closeStatus: 500});
    await openConversation(ROW.human);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId(closeRow));
    await waitFor(() => expect(screen.getByTestId('conversation-menu-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-menu-error')).toHaveTextContent(DM_CLOSE_FAILURE);
    expect(spoken).toHaveBeenCalledWith(DM_CLOSE_FAILURE);
    expect(screen.getByTestId('conversation-menu-sheet')).toBeTruthy();
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    expect(closedDms.size).toBe(0);
  });

  it('도는 중에 다시 눌러도 닫기는 한 번이고 대화는 한 겹만 걷힌다', async () => {
    await mountShell({serverClosure: true, hold: ['close']});
    await openConversation(ROW.human);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId(closeRow));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    fireEvent.press(screen.getByTestId(closeRow));
    fireEvent.press(screen.getByTestId(closeRow));
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(callsTo('/closure')).toHaveLength(1);
    // 한 겹만 걷혔다: 사이드바가 그대로 서 있다.
    expect(screen.getByTestId('sidebar-list')).toBeTruthy();
  });

  it('도는 중에 시트를 X 로 내려도 요청은 훅이 쥐고 끝까지 간다 — 성공하면 대화가 걷히고 낭독한다', async () => {
    const spoken = announce();
    await mountShell({serverClosure: true, hold: ['close']});
    await openConversation(ROW.human);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId(closeRow));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(spoken).toHaveBeenCalledWith('대화를 닫았습니다.');
    expect(closedDms.get('ch-dm-human')).toBe(2);
  });
});

// ---- 3b. 정보 페이지 — 머리 알약과 ⋮ 시트의 「정보」 행이 같은 문이다 ---------------------------------

const clipboardBox = (jest.requireMock('expo-clipboard') as {__box: {value: string | null}}).__box;

/** 정보 페이지의 행 이름(`conversation-info-` 뒤)을 그려진 순서로. */
const infoKeys = () =>
  screen
    .queryAllByTestId(/^conversation-info-(mute-toggle|copy-name|copy-link|copy-id|close-dm|leave|agent-open|owner)$/)
    .map(node => String(node.props.testID).replace('conversation-info-', ''));

/** 머리 알약을 눌러 정보 페이지를 연다. */
async function openInfoPage(): Promise<void> {
  fireEvent.press(screen.getByTestId('conversation-info-button'));
  await screen.findByTestId('conversation-info-page');
}

describe('셸 — 머리 알약과 ⋮ 시트의 정보 행이 같은 정보 페이지를 연다 (#4319)', () => {
  liveWorld();

  it('알약: 채널이면 「채널 정보」 페이지가 서고 ⋮ 시트는 서지 않는다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    expect(screen.queryByTestId('conversation-info-page')).toBeNull();
    await openInfoPage();
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('채널 정보');
    expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('general');
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });

  it('알약: DM 이면 「대화 정보」 페이지에 상대의 얼굴·이름·핸들이 선다', async () => {
    await mountShell();
    await openConversation(ROW.human);
    await openInfoPage();
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('대화 정보');
    expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('박서연');
    expect(screen.getByTestId('conversation-info-handle')).toHaveTextContent('@seoyeon');
    // 얼굴은 알약·사이드바에도 있다 — 이 페이지의 큰 얼굴만 본다.
    expect(
      within(screen.getByTestId('conversation-info-face')).getByTestId('avatar-human', {includeHiddenElements: true}),
    ).toBeTruthy();
  });

  it('알약을 누르면 자판이 내려간다 — 알약은 모달이 아니라서 iOS 가 접어 주지 않는다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    await mountShell();
    await openConversation(ROW.general);
    dismiss.mockClear();
    fireEvent.press(screen.getByTestId('conversation-info-button'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('⋮ 시트의 「채널 정보」 행: 시트가 먼저 걷히고 그 뒤에 페이지가 선다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-info')).toHaveTextContent('채널 정보');
    fireEvent.press(screen.getByTestId('conversation-menu-info'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-page')).toBeTruthy());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('채널 정보');
  });

  it('⋮ 시트의 「대화 정보」 행(DM): 같은 길로 페이지가 선다', async () => {
    await mountShell();
    await openConversation(ROW.human);
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-info')).toHaveTextContent('대화 정보');
    fireEvent.press(screen.getByTestId('conversation-menu-info'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-page')).toBeTruthy());
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    expect(screen.getByTestId('conversation-info-title')).toHaveTextContent('대화 정보');
  });

  it('‹ 를 누르면 대화로 돌아온다 — 대화는 그대로이고 알약으로 다시 열 수 있다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    await openInfoPage();
  });

  it('VoiceOver escape 와 왼쪽 가장자리 밀기도 한 겹만 걷는다 — 대화는 남는다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    act(() => {
      screen.getByTestId('conversation-info-page').props.onAccessibilityEscape();
    });
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();

    await openInfoPage();
    const touch = finger(pane('conversation-info-pane'));
    touch.down(6, 400);
    touch.move(200, 400);
    touch.move(500, 400);
    touch.up();
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    // 밀기는 정보 페이지 한 겹만 벗겼다 — 대화(바깥 래퍼)까지 닫지 않는다.
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
  });

  it('채널은 짧은 멤버 수가 알약에, 긴 부제와 주제가 페이지에 선다 — 같은 사실을 두 길이로', async () => {
    // 알약의 보조 글은 글자 배율이 1.5 미만일 때 선다 — RN jest 프리셋의 기본 배율은 2 라서 배율 1 을 직접 고른다.
    const base = Dimensions.get('window');
    Dimensions.set({window: {...base, fontScale: 1}, screen: {...base, fontScale: 1}});
    try {
      await mountShell({channelInfo: true});
      await openConversation(ROW.general);
      await waitFor(() => expect(screen.getByTestId('conversation-member-count')).toHaveTextContent('3명'));
      await openInfoPage();
      expect(screen.getByTestId('conversation-info-subtitle')).toHaveTextContent('3명 · 달무리 도우미 참여 중');
      expect(screen.getByTestId('conversation-info-topic')).toHaveTextContent(CHANNEL_TOPIC);
    } finally {
      Dimensions.set({window: base, screen: base});
    }
  });

  it('에이전트 DM: 머리 알약과 정보 페이지가 같은 상태 낱말을 말한다 — 같은 판정을 나눠 쓴다', async () => {
    const base = Dimensions.get('window');
    Dimensions.set({window: {...base, fontScale: 1}, screen: {...base, fontScale: 1}});
    try {
      await mountShell({agentOnline: true});
      await openConversation(ROW.agent);
      await waitFor(() => expect(screen.getByTestId('conversation-title-status')).toHaveTextContent('연결됨'));
      await openInfoPage();
      expect(screen.getByTestId('conversation-info-status')).toHaveTextContent('연결됨');
      // 에이전트: 관리자 줄과 「에이전트 정보」 행.
      expect(screen.getByTestId('conversation-info-owner')).toHaveTextContent('이도현님이 관리');
      expect(screen.getByTestId('conversation-info-agent-open')).toBeTruthy();
    } finally {
      Dimensions.set({window: base, screen: base});
    }
  });

  it('「에이전트 정보」 행: 에이전트 상세 화면이 선다', async () => {
    await mountShell();
    await openConversation(ROW.agent);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-agent-open'));
    await waitFor(() => expect(screen.getByTestId('agent-detail-scroll')).toBeTruthy());
  });
});

describe('셸 — 정보 페이지의 복사: 영수증이 서도 페이지는 남는다 (#4319)', () => {
  liveWorld();

  beforeEach(() => {
    clipboardBox.value = null;
  });

  it('이름 복사: 클립보드에 이름이 담기고, 그 줄이 「복사됨」이 되고, ⋮ 시트는 서지 않는다 — 영수증이 걷혀도 페이지는 남는다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-copy-name'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(true)),
    );
    expect(clipboardBox.value).toBe('general');
    // 같은 훅이 시트를 세우던 길(`setActive`)을 타지 않는다 — 정보 페이지 위에 ⋮ 시트가 뜨면 안 된다.
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    // 다른 줄은 그대로다.
    expect(screen.getByTestId('conversation-info-copy-link')).toHaveTextContent(copyLinkActionLabel(false));
    // 영수증 시간이 지나면 훅이 `close()` 를 부른다 — 시트였다면 여기서 사라진다. 페이지는 남고 낱말만 돌아온다.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(COPY_RECEIPT_MS + 50);
    });
    expect(screen.getByTestId('conversation-info-page')).toBeTruthy();
    expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(false));
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });

  it('링크 복사와 ID 복사는 각자 서버 주소 · 채널 id 를 담는다 — 한 번에 한 줄만 「복사됨」이다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-copy-link'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-copy-link')).toHaveTextContent(copyLinkActionLabel(true)),
    );
    expect(clipboardBox.value).toBe(channelShareUrlFromServerBase(BASE, 'ch-general'));
    fireEvent.press(screen.getByTestId('conversation-info-copy-id'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-copy-id')).toHaveTextContent(channelCopyIdLabel(true)),
    );
    expect(clipboardBox.value).toBe('ch-general');
    // 앞 줄의 영수증은 새 영수증이 밀어낸다.
    expect(screen.getByTestId('conversation-info-copy-link')).toHaveTextContent(copyLinkActionLabel(false));
  });

  it('DM 의 이름 복사는 상대의 이름이다', async () => {
    await mountShell();
    await openConversation(ROW.human);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-copy-name'));
    await waitFor(() => expect(clipboardBox.value).toBe('박서연'));
  });

  it('클립보드가 거절하면 페이지 안에서 이유를 말하고 낭독한다 — ⋮ 시트가 대신 서지 않고 「복사됨」도 없다', async () => {
    const spoken = announce();
    (copyText as jest.Mock).mockResolvedValueOnce(false);
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-copy-name'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-info-error')).toHaveTextContent(CHANNEL_COPY_FAILURE);
    expect(spoken).toHaveBeenCalledWith(CHANNEL_COPY_FAILURE);
    expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(false));
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    expect(clipboardBox.value).toBeNull();
  });

  it('페이지를 닫았다 다시 열면 지난 영수증이 없다', async () => {
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-copy-name'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(true)),
    );
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    await openInfoPage();
    expect(screen.getByTestId('conversation-info-copy-name')).toHaveTextContent(channelCopyNameLabel(false));
  });
});

describe('셸 — 정보 페이지의 알림 끄기·켜기 (#4319)', () => {
  liveWorld();

  it('끄기: notification-pref 에 muted:true 를 보내고, 성공해도 페이지는 남고 행이 「알림 켜기」로 바뀐다', async () => {
    const spoken = announce();
    await mountShell();
    await openConversation(ROW.general);
    await openInfoPage();
    expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(false));
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await waitFor(() => expect(callsTo('/notification-pref')).toHaveLength(1));
    expect(callsTo('/notification-pref')[0].url).toContain('/channels/ch-general/notification-pref');
    expect(callsTo('/notification-pref')[0].body).toEqual({muted: true});
    // 서버가 진실이다: 채널 목록을 다시 읽어 새 값이 흘러 내려오면 같은 행이 다른 낱말을 말한다.
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(true)),
    );
    expect(spoken).toHaveBeenCalledWith('알림을 껐습니다.');
    // 시트였다면 성공에서 걷히는 자리다 — 페이지는 남고, ⋮ 시트는 서지 않는다.
    expect(screen.getByTestId('conversation-info-page')).toBeTruthy();
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });

  it('켜기: 꺼진 채널은 muted:false 를 보낸다', async () => {
    await mountShell();
    await openConversation(ROW.quiet);
    await openInfoPage();
    expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(true));
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await waitFor(() => expect(callsTo('/notification-pref')).toHaveLength(1));
    expect(callsTo('/notification-pref')[0].body).toEqual({muted: false});
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(false)),
    );
  });

  it('요청이 도는 동안 행이 「알림 끄는 중」이 되고 다시 눌러도 요청은 한 번이다', async () => {
    await mountShell({hold: ['mute']});
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent('알림 끄는 중'),
    );
    expect(screen.getByTestId('conversation-info-mute-toggle').props.accessibilityState).toMatchObject({busy: true});
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await act(async () => releaseHeld());
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(true)),
    );
    expect(callsTo('/notification-pref')).toHaveLength(1);
  });

  it('거절되면 페이지 안에서 이유를 말하고 낭독한다 — ⋮ 시트가 대신 서지 않고 행은 원래 낱말이다', async () => {
    const spoken = announce();
    await mountShell({muteStatus: 500});
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-info-error')).toHaveTextContent(CHANNEL_MUTE_FAILURE);
    expect(spoken).toHaveBeenCalledWith(CHANNEL_MUTE_FAILURE);
    // 훅의 `failed` 는 시트를 다시 세우는 길(`setActive`)이다 — 정보 페이지는 둘째 인스턴스를 읽어서 ⋮ 시트가 서지 않는다.
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    expect(screen.getByTestId('conversation-info-mute-toggle')).toHaveTextContent(channelMuteToggleLabel(false));
    expect(muted.has('ch-general')).toBe(false);
  });

  it('페이지를 닫았다 다시 열면 지난 실패 문장이 없다', async () => {
    await mountShell({muteStatus: 500});
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-mute-toggle'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-error')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    await openInfoPage();
    expect(screen.queryByTestId('conversation-info-error')).toBeNull();
  });

  it('⋮ 시트와 정보 페이지는 서로 모르는 상태를 쥔다 — 한쪽의 실패가 다른 쪽에 비치지 않는다', async () => {
    await mountShell({muteStatus: 500});
    await openConversation(ROW.general);
    await openConversationMenu();
    fireEvent.press(screen.getByTestId('conversation-menu-mute-toggle'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu-error')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-menu-close'));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
    await openInfoPage();
    expect(screen.queryByTestId('conversation-info-error')).toBeNull();
  });
});

describe('셸 — 정보 페이지의 채널 나가기 (#4319)', () => {
  liveWorld();

  async function toConfirm(routes: Routes = {}) {
    await mountShell(routes);
    await openConversation(ROW.general);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-leave'));
  }

  it('누르면 DELETE 가 아니라 확인이 먼저다 — 취소하면 항목으로 돌아온다', async () => {
    await toConfirm();
    expect(screen.getByTestId('conversation-info-leave-confirm')).toBeTruthy();
    expect(infoKeys()).toEqual([]);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
    fireEvent.press(screen.getByTestId('conversation-info-leave-cancel'));
    expect(screen.queryByTestId('conversation-info-leave-confirm')).toBeNull();
    expect(infoKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id', 'leave']);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });

  it('확인하면 내 멤버십을 지우고, 서버가 답한 뒤 열려 있던 대화가 페이지째 걷힌다', async () => {
    const spoken = announce();
    await toConfirm();
    fireEvent.press(screen.getByTestId('conversation-info-leave-confirm-button'));
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE')).toBe(true));
    expect(calls.find(call => call.method === 'DELETE')!.url).toContain(
      `/channels/ch-general/members/${SELF_ID}`,
    );
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.queryByTestId('conversation-info-page')).toBeNull();
    expect(spoken).toHaveBeenCalledWith('채널에서 나갔습니다.');
    await waitFor(() => expect(screen.queryByTestId(ROW.general)).toBeNull());
  });

  it('403: 확인 단계가 그대로 서서 이유를 말한다 — 페이지도 대화도 사라지지 않는다', async () => {
    await toConfirm({leaveStatus: 403});
    fireEvent.press(screen.getByTestId('conversation-info-leave-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-leave-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-info-leave-error')).toHaveTextContent(/나갈 권한이 없습니다/);
    expect(screen.getByTestId('conversation-info-leave-confirm')).toBeTruthy();
    expect(screen.getByTestId('conversation-info-page')).toBeTruthy();
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
  });

  it('도는 중에는 위험 단추가 잠겨 두 번 눌러도 DELETE 는 한 번이다', async () => {
    await toConfirm({hold: ['leave']});
    fireEvent.press(screen.getByTestId('conversation-info-leave-confirm-button'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-info-leave-confirm-button')).toHaveTextContent('나가는 중…'),
    );
    fireEvent.press(screen.getByTestId('conversation-info-leave-confirm-button'));
    await act(async () => releaseHeld());
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });

  it('확인 단계에서 ‹ 로 나갔다 다시 열면 항목 목록이다', async () => {
    await toConfirm();
    fireEvent.press(screen.getByTestId('conversation-info-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
    await openInfoPage();
    expect(screen.queryByTestId('conversation-info-leave-confirm')).toBeNull();
    expect(infoKeys()).toContain('leave');
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });

  it('일반 멤버에게는 나가기가 없다 — 알림 · 복사만 선다', async () => {
    await mountShell({selfRole: 'member'});
    await openConversation(ROW.general);
    await openInfoPage();
    expect(infoKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id']);
  });
});

describe('셸 — 정보 페이지의 DM 「대화 닫기」 (#4319)', () => {
  liveWorld();

  it('닫기를 내미는 DM: 누르면 PUT …/closure 를 한 번 보내고 대화가 페이지째 걷히며 낭독한다', async () => {
    const spoken = announce();
    await mountShell({serverClosure: true});
    await openConversation(ROW.human);
    await openInfoPage();
    expect(infoKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id', 'close-dm']);
    expect(screen.getByTestId('conversation-info-close-dm')).toHaveTextContent(DM_CLOSE_LABEL);
    fireEvent.press(screen.getByTestId('conversation-info-close-dm'));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    expect(callsTo('/closure')[0].body).toEqual({seenSeq: 2});
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.queryByTestId('conversation-info-page')).toBeNull();
    expect(spoken).toHaveBeenCalledWith('대화를 닫았습니다.');
    // 한 겹만 걷혔다: 사이드바가 그대로 서 있다.
    expect(screen.getByTestId('sidebar-list')).toBeTruthy();
  });

  it('닫기를 내밀지 않는 DM(안 읽은 메시지가 있다)에는 「대화 닫기」가 없다', async () => {
    await mountShell({serverClosure: true, dmUnread: true});
    await openConversation(ROW.human);
    await openInfoPage();
    expect(infoKeys()).toEqual(['mute-toggle', 'copy-name', 'copy-link', 'copy-id']);
  });

  it('서버가 거절하면(500) 페이지 안에서 이유를 말하고 대화는 그대로다', async () => {
    await mountShell({serverClosure: true, closeStatus: 500});
    await openConversation(ROW.human);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-close-dm'));
    await waitFor(() => expect(screen.getByTestId('conversation-info-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-info-error')).toHaveTextContent(DM_CLOSE_FAILURE);
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    expect(screen.getByTestId('conversation-info-page')).toBeTruthy();
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();
  });
});

describe('셸 — 정보 페이지의 큰 얼굴: 사진이 있을 때만 크게 본다 (#4319)', () => {
  liveWorld();

  // 정보 페이지 층이 `accessibilityViewIsModal` 이라 RNTL 은 같은 부모의 다른 가지(뷰어 Modal)를 접근성에서 숨은 것으로 센다 — 실기기에서는 Modal 이
  // 별도 표시 층이라 VoiceOver 가 뷰어를 읽는다. 시험은 숨은 요소까지 조회한다.
  const VIEWER = {includeHiddenElements: true} as const;

  it('사진이 있으면 눌러서 크게 본다 — 뷰어는 페이지 위에 서고, 닫으면 페이지로 돌아온다', async () => {
    await mountShell({photo: true});
    await openConversation(ROW.human);
    await openInfoPage();
    expect(screen.queryByTestId('avatar-viewer', VIEWER)).toBeNull();
    fireEvent.press(screen.getByTestId('conversation-info-face'));
    await waitFor(() => expect(screen.getByTestId('avatar-viewer', VIEWER)).toBeTruthy());
    const image = screen.getByTestId('avatar-viewer-image', VIEWER);
    expect(image.props.source).toEqual({uri: PHOTO});
    expect(image.props.accessibilityLabel).toBe('박서연 프로필 사진');
    // 뷰어를 닫으면 대화가 아니라 **정보 페이지**로 돌아온다 — 페이지가 닫히지 않았다.
    fireEvent.press(screen.getByTestId('avatar-viewer-close', VIEWER));
    await waitFor(() => expect(screen.queryByTestId('avatar-viewer', VIEWER)).toBeNull());
    expect(screen.getByTestId('conversation-info-page')).toBeTruthy();
  });

  it('사진이 없으면 얼굴은 눌러도 아무 일이 없다', async () => {
    await mountShell();
    await openConversation(ROW.human);
    await openInfoPage();
    fireEvent.press(screen.getByTestId('conversation-info-face'));
    expect(screen.queryByTestId('avatar-viewer', {includeHiddenElements: true})).toBeNull();
    expect(screen.getByTestId('conversation-info-face').props.accessibilityRole).toBeUndefined();
  });
});

// ---- 4. 화면 하나 ------------------------------------------------------------------

describe('화면 — 채널 목록을 모르는 동안과 대화가 바뀔 때 (#4319)', () => {
  liveWorld();

  const WORLD = {
    general: 'ch-general',
    other: 'ch-dm-human',
  } as const;

  function mountScreen(onBack: () => void, which: string = WORLD.general) {
    const client = newClient();
    const tree = (channelId: string) => (
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <PushProvider>
            <RealtimeProvider>
              <ConversationScreen
                channelId={channelId}
                title={channelId === WORLD.general ? 'general' : '박서연'}
                onBack={onBack}
              />
            </RealtimeProvider>
          </PushProvider>
        </SessionProvider>
      </QueryClientProvider>
    );
    const view = render(tree(which));
    return {view, tree};
  }

  it('채널 목록이 이 대화를 모르면 ⋮ 는 그래도 열린다 — 고정 목록만 서고 정보·알림·닫기·나가기는 없다, 머리는 이름만이다', async () => {
    installFetch({serverClosure: true});
    // 서버 채널 목록이 이 대화를 싣지 않는다(목록이 오기 전 · 보관된 채널을 연 경우).
    const real = globalThis.fetch as unknown as jest.Mock;
    const base = real.getMockImplementation() as (url: string, init?: unknown) => Promise<Response>;
    real.mockImplementation(async (url: string, init?: unknown) =>
      /\/channels(\?|$)/.test(url) ? jsonResponse(200, {channels: []}) : base(url, init),
    );
    mountScreen(jest.fn());
    await screen.findByTestId('conversation-menu');
    await openConversationMenu();
    // 정보 행도 없다 — 종류를 모르면 정보 페이지가 무엇의 정보인지 모른다. 머리 알약도 단추가 아니라 이름만 선다(눌러도 열 곳이 없다).
    expect(menuKeys()).toEqual(['pins']);
    expect(screen.queryByTestId('conversation-info-button')).toBeNull();
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('general');
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent(/^general$/);
    // 고정 목록은 채널 없이도 열린다.
    fireEvent.press(screen.getByTestId('conversation-menu-pins'));
    await waitFor(() => expect(screen.getByTestId('pin-list-pane')).toBeTruthy());
  });

  it('채널이 바뀌면 열린 시트를 걷는다 — 앞 방의 시트가 이 방 위에 남지 않는다', async () => {
    installFetch();
    const {view, tree} = mountScreen(jest.fn());
    await screen.findByTestId('conversation-menu');
    await openConversationMenu();
    expect(screen.getByTestId('conversation-menu-title')).toHaveTextContent('# general');
    view.rerender(tree(WORLD.other));
    await waitFor(() => expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull());
  });

  it('채널이 바뀌면 열린 정보 페이지도 걷는다 — 앞 방의 정보가 이 방 위에 남지 않는다', async () => {
    installFetch();
    const {view, tree} = mountScreen(jest.fn());
    await screen.findByTestId('conversation-info-button');
    fireEvent.press(screen.getByTestId('conversation-info-button'));
    await screen.findByTestId('conversation-info-page');
    expect(screen.getByTestId('conversation-info-name')).toHaveTextContent('general');
    view.rerender(tree(WORLD.other));
    await waitFor(() => expect(screen.queryByTestId('conversation-info-page')).toBeNull());
  });

  it('대조: 요청이 도는 사이 그 대화가 그대로면 닫기가 끝난 뒤 뒤로가기를 한 번 부른다', async () => {
    installFetch({serverClosure: true, hold: ['close']});
    const onBack = jest.fn();
    mountScreen(onBack, WORLD.other);
    await screen.findByTestId('conversation-menu');
    await openConversationMenu();
    await waitFor(() => expect(screen.getByTestId('conversation-menu-close-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-menu-close-dm'));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => releaseHeld());
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('요청이 도는 사이 셸이 다른 대화로 바꿔 놨으면 뒤로가기를 부르지 않는다 — 새로 열린 대화를 걷지 않는다 (`channelLeft` 와 같은 규칙)', async () => {
    installFetch({serverClosure: true, hold: ['close']});
    const onBack = jest.fn();
    const {view, tree} = mountScreen(onBack, WORLD.other);
    await screen.findByTestId('conversation-menu');
    await openConversationMenu();
    await waitFor(() => expect(screen.getByTestId('conversation-menu-close-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-menu-close-dm'));
    await waitFor(() => expect(callsTo('/closure')).toHaveLength(1));
    // 같은 화면이 다른 방을 그린다(언마운트 없음) — 알림 탭·ADE 카드의 「대화로」 가 하는 일.
    view.rerender(tree(WORLD.general));
    await act(async () => releaseHeld());
    // 요청이 끝났다는 증거를 기다린 뒤에도 뒤로가기는 불리지 않았다.
    await waitFor(() => expect(closedDms.get('ch-dm-human')).toBe(2));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(onBack).not.toHaveBeenCalled();
  });
});
