import {dismissTemporarySurfaces} from '@momo/core/features/notifications/entryDismiss';
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
import * as Notifications from 'expo-notifications';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {PageSheet, usePageSheetGone} from '../src/design/PageSheet';
import {ThemePickerModal} from '../src/design/ThemePickerPage';
import {workspaceKeys} from '../src/features/workspace/queries';
import {
  __peekEntryDraft,
  __resetEntryDrafts,
  newChannelDraftKey,
  useHoldDraftOnEntry,
} from '../src/lib/entryDrafts';
import {NOTIFICATION_TAP_COPY} from '../src/push/tapArrival';
import {SessionProvider, useAuthGate, useSession} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {NewChannelSheet} from '../src/shell/NewChannelSheet';
import {
  __resetSessionStore,
  clearSession,
  markAuthExpired,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {
  releaseReduceMotion,
  setReduceMotion as setSheetReduceMotion,
} from './fixtures/sheetContract';

// =============================================================================
// 알림은 새 입구다 — 겹친 임시 표면을 걷고 바로 그 메시지로 (#4667, 테스터 피드백 B5).
//
// 설정(테마) 화면을 보던 중 새 메시지 알림을 눌렀더니 설정이 그대로 떠 있었고, 닫아야 그 메시지가 보였다. 항법 층은 `navReducer` 가
// 걷지만(`navState.test.ts`) 시트·뷰어·메뉴는 그것을 연 컴포넌트의 지역 상태라 리듀서가 모른다. 입구(`useNotificationTapRouting`)가
// 이동하기 직전에 방송 하나를 올리고(`dismissTemporarySurfaces`), 표면은 자기 닫는 길로 닫는다.
//
// 이 파일은 **입구에서 화면까지**를 셸 전체로 잰다 — 표면 종류마다 하나씩(설정 층 · 셸 지역 시트 · 숨은 홈 칸 안의 시트 · 못 가는
// 알림 · 쓰던 글이 든 시트). 각 시트 **파일**이 방송에 닫히는지는 `describeCloseContract`(시트마다)와 호스트별 시험이 잰다.
// 마지막 묶음은 소스를 훑어 「표면이 하나 더 생겨도 입구를 빠뜨리지 않는다」를 계속 센다.
//
// 가짜는 둘이다: 서버의 답(`fetch`)과 expo 의 네이티브 쪽(응답 리스너). 항법·시트·목록은 전부 진짜이고, 단정은 「호출했는가」가 아니라
// **화면에 무엇이 서 있는가**다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const MINSU = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE = 'https://api.example.com';
const T0 = 1_700_000_000_000;
const GENERAL = '33333333-3333-4333-8333-333333333333';
const RANDOM = '44444444-3333-4333-8333-444444444444';
/** 목록에 없는 방 — 나왔거나 사라진 방은 서버의 목록에서 빠진다. */
const GONE = '55555555-3333-4333-8333-555555555555';
const PLAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const RANDOM_MSG = 'aaaaaaaa-0000-4000-8000-000000000009';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
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

// 「새 채널」 행은 소유자·관리자에게만 선다(ADR-0128).
const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae', role: 'owner'}),
  rosterMember({id: MINSU, displayName: '김민수', handle: 'minsu'}),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: RANDOM, workspaceId: WS, kind: 'public', name: 'random', muted: false},
];

function message(seq: number, id: string, channelId: string, body: string) {
  return {
    id,
    channelId,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: MINSU,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: T0 + seq * 1000,
  };
}

const HEADS: Record<string, unknown[]> = {
  [GENERAL]: [message(10, PLAIN, GENERAL, '배포 끝났습니다')],
  [RANDOM]: [message(3, RANDOM_MSG, RANDOM, '점심 뭐 먹어요')],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {get: () => 'application/json'},
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string, init?: {method?: string; body?: unknown}) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/replies')) return jsonResponse(200, {messages: []});
    if (url.includes('/read-state')) {
      if (init?.method === 'PUT') {
        const channelId = url.split('/channels/')[1]?.split('/')[0] ?? '';
        const {last_read_seq: lastReadSeq = 0} = JSON.parse(String(init.body ?? '{}')) as {
          last_read_seq?: number;
        };
        return jsonResponse(200, {
          channel_id: channelId,
          last_read_seq: lastReadSeq,
          latest_seq: lastReadSeq,
          unread_count: 0,
          mention_count: 0,
        });
      }
      return jsonResponse(200, {read_states: []});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/messages')) {
      const channelId = (url.split('/channels/')[1]?.split('/')[0] ?? '').toLowerCase();
      return jsonResponse(200, {messages: HEADS[channelId] ?? []});
    }
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions/shared')) {
      return jsonResponse(200, {sessions: [], nextCursor: null});
    }
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// ---- 알림, 릴레이가 만드는 그대로 -------------------------------------------------

function apnsPayload(aim: {channelId?: string; messageId: string}): Record<string, unknown> {
  const channelId = aim.channelId ?? GENERAL;
  return {
    aps: {
      alert: {title: 'oort', body: '새 알림'},
      badge: 3,
      'thread-id': channelId,
      category: 'momo.mention',
      'mutable-content': 1,
      'content-available': 1,
    },
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: WS,
      channel_id: channelId,
      message_id: aim.messageId,
      collapse_id: `m:${aim.messageId}`,
      reason: 'mention',
    },
  };
}

let responseSerial = 0;

function tapResponse(payload: unknown) {
  responseSerial += 1;
  return {
    actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
    notification: {
      date: T0 + responseSerial,
      request: {
        identifier: `apns-${responseSerial}`,
        content: {title: 'oort', body: '새 알림', data: null},
        trigger: {type: 'push', payload},
      },
    },
  } as unknown as Notifications.NotificationResponse;
}

const notificationsMock = Notifications as unknown as {
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponse: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
};

/** 리스너를 붙잡아 둔다. 앱이 떠 있는 동안의 탭은 이것을 부른다. */
let deliver: ((response: Notifications.NotificationResponse) => void) | null = null;

function captureListener(): void {
  deliver = null;
  notificationsMock.addNotificationResponseReceivedListener.mockImplementation(
    (fn: (response: Notifications.NotificationResponse) => void) => {
      deliver = fn;
      return {remove: jest.fn()};
    },
  );
}

async function tapWhileRunning(payload: unknown): Promise<void> {
  expect(deliver).not.toBeNull();
  await act(async () => {
    deliver?.(tapResponse(payload));
  });
}

// ---- 셸 ---------------------------------------------------------------------

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

/** 첫 셸 렌더는 차가운 워커에서 느리다(`pushTap.test.tsx` 의 같은 예산). 스쳐 가는 상태에는 쓰지 않는다. */
const SETTLE = {timeout: 10_000};
jest.setTimeout(30_000);

async function waitForSidebar(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), SETTLE);
}

async function expectLandedIn(title: string): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('conversation-title')).toHaveTextContent(title),
    SETTLE,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(async () => {
  mmkvStore.clear();
  __resetEntryDrafts();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  captureListener();
  notificationsMock.getLastNotificationResponse.mockReset().mockReturnValue(null);
  notificationsMock.clearLastNotificationResponse.mockReset();
  // 슬라이드 없이 바로 걷혀 「걷혔다」가 시계를 기다리지 않는 단정이 된다.
  await setSheetReduceMotion(true);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  releaseReduceMotion();
  jest.restoreAllMocks();
});

describe('알림 입구 → 화면: 표면 종류마다 다 걷히고 목적지가 선다 (#4667)', () => {
  it('설정 층 — 설정을 보던 중 알림을 누르면 설정은 사라지고 그 대화가 선다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId('profile-avatar'));
    await waitFor(() => expect(screen.getByTestId('settings-pane')).toBeTruthy(), SETTLE);

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));

    await expectLandedIn('general');
    expect(screen.queryByTestId('settings-pane')).toBeNull();
  });

  it('셸이 쥔 시트 — + → AI 시트가 열린 채 알림을 누르면 시트는 걷히고 그 대화가 선다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-sheet')).toBeTruthy(), SETTLE);

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));

    await expectLandedIn('general');
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
  });

  it('숨은 칸 안의 시트 — 홈 목록 행의 액션 시트는 대화가 홈을 덮어도 떠 있지 않다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    // 폰이 실제로 보내는 제스처: 손가락이 닿고(무장), 플랫폼 타이머가 울린다.
    const row = screen.getByTestId(`sidebar-row-channel:${RANDOM}`);
    fireEvent(row, 'touchStart', {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    });
    fireEvent(row, 'longPress');
    fireEvent(row, 'touchEnd');
    await waitFor(() => expect(screen.getByTestId('channel-action-sheet')).toBeTruthy(), SETTLE);

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));

    await expectLandedIn('general');
    // 홈 칸은 대화 밑에 `display: none` 으로 마운트된 채 남는다 — 그 안의 Modal 이 그대로 서 있으면 목적지를 가린다.
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
  });

  it('못 가는 알림도 시트를 걷는다 — 「없어졌거나 볼 권한이 없습니다」는 대화 목록에서 말하고, 시트가 덮고 있으면 말하지 못한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-sheet')).toBeTruthy(), SETTLE);

    await tapWhileRunning(apnsPayload({channelId: GONE, messageId: PLAIN}));

    await waitFor(() => expect(screen.getByTestId('notification-tap-notice')).toBeTruthy(), SETTLE);
    expect(
      within(screen.getByTestId('notification-tap-notice')).getByText(
        NOTIFICATION_TAP_COPY.channelGone,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
  });

  it('쓰던 글이 든 시트 — 새 채널 이름을 쓰던 중 알림을 누르면 시트는 걷히고, 돌아와 다시 연 시트에 그 이름이 있다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(await screen.findByTestId('plus-menu-channel'));
    fireEvent.changeText(await screen.findByTestId('new-channel-name'), 'ops-room');

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));

    await expectLandedIn('general');
    expect(screen.queryByTestId('new-channel-sheet')).toBeNull();

    // 뒤로 돌아와 + → 새 채널: 알림이 걷은 이름이 거기 있다.
    fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.getByTestId('shell-plus')).toBeTruthy(), SETTLE);
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(await screen.findByTestId('plus-menu-channel'));
    expect((await screen.findByTestId('new-channel-name')).props.value).toBe('ops-room');
  });
});

describe('그릇 하나가 한꺼번에 덮는다 (#4667)', () => {
  it('PageSheet — 저장 안 한 입력(dirty)·중첩 선택기(onNavigateBack)가 있어도 묻거나 한 겹만 벗기지 않고 한 번 닫는다', () => {
    const onClose = jest.fn();
    const onNavigateBack = jest.fn();
    const onDiscardPrompt = jest.fn();
    render(
      <PageSheet
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        onDiscardPrompt={onDiscardPrompt}
        dirty
        accessibilityLabel="시험 시트">
        <Text>시트 내용</Text>
      </PageSheet>,
    );

    act(() => {
      dismissTemporarySurfaces();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigateBack).not.toHaveBeenCalled();
    expect(onDiscardPrompt).not.toHaveBeenCalled();
  });

  it('ThemePickerModal(전체 화면 Modal) — 같은 방송에 `onDone` 으로 걷힌다', () => {
    const onDone = jest.fn();
    render(<ThemePickerModal onDone={onDone} />);
    act(() => {
      dismissTemporarySurfaces();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('맡겨 둔 글의 자리는 워크스페이스에 묶인다 (#4667)', () => {
  // 한 기기에서 로그아웃하고 다른 사람이 로그인해도, 앞 사람이 알림에 밀려 놓친 이름이 뒤 사람의 시트에 나타나면 안 된다
  // (`work/delegate/session.ts` 가 `workspaceId` 로 묶는 것과 같은 규칙). 내 맥에 보내기의 같은 시험은 `askMac.test.tsx` ⑩.
  const OTHER_WS = '99999999-2222-4222-8222-999999999999';

  function mountSheet(member: Member) {
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
    });
    return render(
      <QueryClientProvider client={client}>
        <SessionProvider member={member}>
          <NewChannelSheet onOpenConversation={jest.fn()} onClose={jest.fn()} />
        </SessionProvider>
      </QueryClientProvider>,
    );
  }

  it('새 채널 — 다른 워크스페이스로 들어온 사람의 시트에는 앞 사람의 이름이 없고, 같은 워크스페이스로 돌아오면 있다', () => {
    const first = mountSheet(SELF);
    fireEvent.changeText(screen.getByTestId('new-channel-name'), 'ops-room');
    act(() => {
      dismissTemporarySurfaces();
    });
    first.unmount();

    const other = mountSheet({...SELF, workspaceId: OTHER_WS});
    expect(screen.getByTestId('new-channel-name').props.value).toBe('');
    other.unmount();

    // 대조: 위의 빈 칸이 헛돌지 않는다.
    mountSheet(SELF);
    expect(screen.getByTestId('new-channel-name').props.value).toBe('ops-room');
  });
});

// =============================================================================
// #5058 — 알림 입구 후속: 로그아웃이 맡긴 글을 비운다 · 만드는 동안 시트가 걷히면 끌고 가지 않는다 · 걷히면 안 되는 시트.
// =============================================================================

describe('로그아웃은 알림이 맡긴 글을 비운다 (#5058)', () => {
  // 같은 실행에서 같은 워크스페이스로 다른 사람이 이어 들어오면 앞 사람이 알림에 밀려 놓친 이름이 그 사람의 시트에 나타날 수 있었다.
  // 키가 워크스페이스로 묶이는 것(위)은 **다른 워크스페이스**를 막고, 이것은 **같은 워크스페이스의 다른 사람**을 막는다.
  const NEXT_PERSON = '77777777-1111-4111-8111-777777777777';

  /** 앱이 실제로 쓰는 `signOut` 을 그 provider 에서 그대로 꺼내 온다(`signOutPushRevoke.test.tsx` 와 같은 방법). */
  function mountSheet(member: Member) {
    let signOut: (() => void) | null = null;
    function Probe(): React.JSX.Element | null {
      signOut = useSession().signOut;
      return null;
    }
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
    });
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider member={member}>
          <Probe />
          <NewChannelSheet onOpenConversation={jest.fn()} onClose={jest.fn()} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    return {
      unmount: () => view.unmount(),
      signOut: () => {
        if (signOut === null) throw new Error('signOut 을 잡지 못했다');
        signOut();
      },
    };
  }

  it('새 채널 이름을 쓰다 알림에 걷힌 시트의 글은 로그아웃 뒤 같은 워크스페이스로 이어 들어온 사람의 시트에 나타나지 않는다', () => {
    // 로그아웃이 부르는 서버 요청(`POST /v1/auth/logout`)은 알 바 아니다 — 응답만 있으면 된다.
    globalThis.fetch = jest.fn(async () =>
      jsonResponse(200, {status: 'ok'}),
    ) as unknown as typeof fetch;
    const first = mountSheet(SELF);
    fireEvent.changeText(screen.getByTestId('new-channel-name'), 'ops-room');
    act(() => {
      dismissTemporarySurfaces();
    });
    // 맡겨졌다 — 아래의 빈 칸이 「애초에 아무것도 없었다」로 헛돌지 않는다는 증거.
    expect(__peekEntryDraft(newChannelDraftKey(WS))).toEqual({name: 'ops-room', kind: 'public'});

    act(() => first.signOut());
    expect(__peekEntryDraft(newChannelDraftKey(WS))).toBeUndefined();
    first.unmount();

    // 같은 워크스페이스, 다른 사람.
    mountSheet({...SELF, id: NEXT_PERSON, handle: 'next'});
    expect(screen.getByTestId('new-channel-name').props.value).toBe('');
  });

  describe('`signOut` 을 거치지 않고 로그인 화면으로 돌아오는 길도 비운다', () => {
    // 앱 뿌리(`App.tsx`)가 하는 그대로 게이트를 읽는다. 세션 없이 서서 로그인하고, 쓰던 글이 맡겨진 뒤, 세션이 끝난다.
    function mountGate() {
      __resetSessionStore();
      function Gate(): null {
        useAuthGate();
        return null;
      }
      function Holder(): null {
        useHoldDraftOnEntry('holder', () => '쓰던 글');
        return null;
      }
      render(
        <>
          <Gate />
          <Holder />
        </>,
      );
      act(() => sessionPort.applyLogin(LOGIN_BODY));
      act(() => {
        dismissTemporarySurfaces();
      });
      // 맡겨졌고 로그인만으로는 지워지지 않았다 — 아래의 「사라졌다」가 헛돌지 않는다는 증거.
      expect(__peekEntryDraft('holder')).toBe('쓰던 글');
    }

    it('복원이 거절돼 저장된 세션이 지워지면(로그인 화면)', () => {
      mountGate();
      act(() => clearSession());
      expect(__peekEntryDraft('holder')).toBeUndefined();
    });

    it('토큰이 만료되면(저장된 세션은 남은 채 로그인 화면)', () => {
      mountGate();
      act(() => markAuthExpired());
      expect(__peekEntryDraft('holder')).toBeUndefined();
    });
  });
});

describe('만드는 동안 시트가 걷히면 새 채널로 끌고 가지 않는다 (#5058)', () => {
  // 요청은 시트가 아니라 서버가 끝낸다. 알림이 시트를 걷고 목적지에 세운 뒤에 응답이 와도 사람을 새 채널로 끌고 가면 알림의 목적지를 덮는다.
  const CREATED = {id: 'ch-new', workspaceId: WS, kind: 'public', name: 'ops-room', muted: false};

  /** 서버의 응답을 시험이 쥔다 — 「요청이 나가 있는 동안」을 시험이 정한다. */
  function holdCreate() {
    let answer: (() => void) | null = null;
    globalThis.fetch = jest.fn(async (url: string, init?: {method?: string}) => {
      if (url.endsWith('/channels') && init?.method === 'POST') {
        await new Promise<void>(resolve => {
          answer = resolve;
        });
        return jsonResponse(201, {channel: CREATED});
      }
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    return {
      answer: async () => {
        await act(async () => {
          answer?.();
        });
      },
    };
  }

  function mountCreate() {
    // 목록을 읽는 화면이 없으므로 캐시가 치워지지 않게 한다(`gcTime`).
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: Infinity}, mutations: {gcTime: 0}},
    });
    const onOpenConversation = jest.fn();
    const onClose = jest.fn();
    render(
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <NewChannelSheet onOpenConversation={onOpenConversation} onClose={onClose} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    return {client, onOpenConversation, onClose};
  }

  async function startCreating() {
    fireEvent.changeText(screen.getByTestId('new-channel-name'), 'ops-room');
    fireEvent.press(screen.getByTestId('new-channel-create'));
    await waitFor(() =>
      expect(screen.getByTestId('new-channel-create').props.accessibilityState).toMatchObject({
        busy: true,
      }),
    );
  }

  const listed = (client: QueryClient) =>
    client.getQueryData<Array<{id: string}>>(workspaceKeys.channels(WS))?.some(c => c.id === 'ch-new');

  it('대조: 아무 일도 없으면 만들어진 채널이 열린다 — 시트를 닫고 새 채널로 간다', async () => {
    const server = holdCreate();
    const {client, onOpenConversation, onClose} = mountCreate();
    await startCreating();

    await server.answer();

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledTimes(1));
    expect(onOpenConversation).toHaveBeenCalledWith('ch-new', 'ops-room');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(listed(client)).toBe(true);
  });

  it('알림이 착지해 시트가 걷혔다면 응답이 와도 새 채널로 데려가지 않는다 — 채널은 만들어져 목록에 있다', async () => {
    const server = holdCreate();
    const {client, onOpenConversation, onClose} = mountCreate();
    await startCreating();

    act(() => {
      dismissTemporarySurfaces();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await server.answer();

    await waitFor(() => expect(listed(client)).toBe(true));
    expect(onOpenConversation).not.toHaveBeenCalled();
    // 늦은 `onClose()` 도 없다 — 그 사이 사람이 새로 연 시트를 닫아 버린다.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('시트가 미끄러져 내려가는 중(아직 마운트돼 있다)에 응답이 와도 같다', async () => {
    await setSheetReduceMotion(false);
    const server = holdCreate();
    const {client, onOpenConversation, onClose} = mountCreate();
    await startCreating();

    fireEvent.press(screen.getByTestId('new-channel-close'));
    // 슬라이드가 도는 동안은 아직 닫히지 않았다 — 사라지는 중이다.
    expect(onClose).not.toHaveBeenCalled();
    await server.answer();

    await waitFor(() => expect(listed(client)).toBe(true));
    expect(onOpenConversation).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {timeout: 8000});
    expect(onOpenConversation).not.toHaveBeenCalled();
  }, 20_000);
});

describe('`usePageSheetGone` — 시트가 사라지는 중이거나 사라졌는가 (#5058)', () => {
  it('떠 있는 동안은 거짓이고, 닫는 슬라이드가 시작되면 참이며(아직 마운트), 부모가 슬라이드 없이 걷어도 참이다', async () => {
    await setSheetReduceMotion(false);
    const probes: Array<() => boolean> = [];
    function Probe(): null {
      probes.push(usePageSheetGone());
      return null;
    }

    // 사람이 스크림을 눌러 닫는 시트: 슬라이드가 도는 동안 `onClose` 는 아직이지만 사라지는 중이다.
    const onClose = jest.fn();
    const sliding = render(
      <PageSheet onClose={onClose} accessibilityLabel="미끄러지는 시트">
        <Probe />
      </PageSheet>,
    );
    const slidingGone = probes[probes.length - 1];
    expect(slidingGone()).toBe(false);
    // 슬라이드가 막 시작해 스크림이 아직 투명하다 — 숨은 요소도 찾는다(`sheetContract` 의 스크림 시험과 같다).
    fireEvent.press(screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}));
    expect(onClose).not.toHaveBeenCalled();
    expect(slidingGone()).toBe(true);
    sliding.unmount();

    // 부모가 슬라이드 없이 걷은 시트: 닫는 슬라이드는 한 번도 시작하지 않았지만 사라졌다.
    const swept = render(
      <PageSheet onClose={jest.fn()} accessibilityLabel="걷힌 시트">
        <Probe />
      </PageSheet>,
    );
    const sweptGone = probes[probes.length - 1];
    expect(sweptGone()).toBe(false);
    swept.unmount();
    expect(sweptGone()).toBe(true);
  });

  it('시트 밖에서는 늘 거짓이다 — 사라질 시트가 없다', () => {
    let gone: (() => boolean) | null = null;
    function Outside(): null {
      gone = usePageSheetGone();
      return null;
    }
    render(<Outside />);
    expect(gone).not.toBeNull();
    expect((gone as unknown as () => boolean)()).toBe(false);
  });
});

describe('걷히면 안 되는 시트는 `keepOnEntry` 로 남는다 (#5058)', () => {
  it('PageSheet — `keepOnEntry` 시트는 방송에도 닫히지 않고, 옆의 보통 시트는 닫힌다', () => {
    const onKeptClose = jest.fn();
    const onPlainClose = jest.fn();
    render(
      <>
        <PageSheet onClose={onKeptClose} keepOnEntry accessibilityLabel="남는 시트" testID="kept-sheet">
          <Text>남는 시트</Text>
        </PageSheet>
        <PageSheet onClose={onPlainClose} accessibilityLabel="걷히는 시트" testID="plain-sheet">
          <Text>걷히는 시트</Text>
        </PageSheet>
      </>,
    );

    act(() => {
      dismissTemporarySurfaces();
    });

    expect(onPlainClose).toHaveBeenCalledTimes(1);
    expect(onKeptClose).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 소스 훑기 — 표면이 하나 더 생겨도 입구를 빠뜨리지 않는다. 렌더가 맞는지는 위의 시험들과 호스트별 시험이 잰다. 여기가 잡는 것은
// 「구독 없는 Modal 이 들어왔다」·「입구가 방송 없이 이동한다」뿐이다.
// =============================================================================
describe('소스 훑기 — 입구를 빠뜨리지 않는다 (#4667)', () => {
  const SRC = path.join(__dirname, '../src');

  function sources(dir: string = SRC): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  /** 주석을 뗀 소스 — 식별자·호출을 셀 때 쓴다(이 파일들의 주석은 그 이름을 설명하느라 길다). */
  const code = (file: string) =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** 알림 입구가 없는 자리 — 이유가 없는 면제는 없다. */
  const NO_ENTRANCE: Record<string, string> = {
    'features/deviceLink/QrScannerSheet.tsx':
      '로그인 전 연결 화면(ConnectScreen)의 카메라 — 세션이 없어 알림 탭이 들어오는 입구가 없다',
  };

  it('`<Modal` 을 든 모든 소스는 알림 입구 구독을 든다 — 공용 그릇(PageSheet)과 전체 화면·팝오버 뷰어 전부', () => {
    const hosts = sources().filter(file => /<Modal\b/.test(read(file)));
    // 점검이 빈 목록을 훑고 통과하지 않는다: 지금 있는 Modal 호스트는 일곱이다.
    expect(hosts.length).toBeGreaterThanOrEqual(7);
    const offenders = hosts
      .map(rel)
      .filter(name => !(name in NO_ENTRANCE))
      .filter(name => !/\buseDismissOnEntry\(/.test(code(path.join(SRC, name))));
    expect(offenders).toEqual([]);
  });

  it('면제는 이유가 있고 지금 있는 파일이며, 그 파일은 로그인 전 화면에서만 쓰인다 — 셸 안에 들어오면 이 면제가 붉어진다', () => {
    for (const [name, reason] of Object.entries(NO_ENTRANCE)) {
      expect([name, fs.existsSync(path.join(SRC, name))]).toEqual([name, true]);
      expect(reason.length).toBeGreaterThan(8);
    }
    const importers = sources()
      .filter(file => /\bQrScannerSheet\b/.test(code(file)))
      .map(rel)
      .filter(name => !(name in NO_ENTRANCE));
    expect(importers).toEqual(['screens/ConnectScreen.tsx']);
  });

  it('알림 탭의 항법은 한 문을 지난다 — `dispatch(` 는 방송을 올리는 `enter` 안에 하나뿐이고, 방송이 이동보다 앞선다', () => {
    const hook = code(path.join(SRC, 'push/useNotificationTapRouting.ts'));
    expect(hook.match(/\bdispatch\(/g)).toHaveLength(1);
    const door = hook.slice(hook.indexOf('const enter = useCallback('));
    expect(door.indexOf('dismissTemporarySurfaces()')).toBeGreaterThan(-1);
    expect(door.indexOf('dismissTemporarySurfaces()')).toBeLessThan(door.indexOf('dispatch(action)'));
    // 착지 둘(대화·세션)과 못 가는 둘(실패 문장·목록 조회 실패)이 모두 그 문으로 간다.
    expect(hook.match(/\benter\(/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('`keepOnEntry`(걷히지 않는 시트)를 쓰는 곳은 이유가 적힌 목록뿐이다 — 하나 더 늘리려면 이유를 여기 적어야 한다 (#5058)', () => {
    // 참인 시트는 알림의 목적지 위에 남아 사람이 X 로 닫아야 메시지가 보인다(#4667 이 고친 증상 그대로). 그 값을 치를 만한 시트만 선다.
    const KEEPS: Record<string, string> = {
      'features/deviceKey/DeviceKeyLinkSheet.tsx':
        'QR 연결 직후 앱이 한 번 세운 승인 대기 시트 — 걷히면 다시 열 문이 없고 맥 승인을 기다리던 폴링이 함께 멈춘다',
    };
    const users = sources()
      .filter(file => rel(file) !== 'design/PageSheet.tsx')
      .filter(file => /\bkeepOnEntry\b/.test(code(file)))
      .map(rel)
      .sort();
    expect(users).toEqual(Object.keys(KEEPS).sort());
    for (const reason of Object.values(KEEPS)) expect(reason.length).toBeGreaterThan(8);
  });
});
