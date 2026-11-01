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

import {PageSheet} from '../src/design/PageSheet';
import {ThemePickerModal} from '../src/design/ThemePickerPage';
import {__resetEntryDrafts} from '../src/lib/entryDrafts';
import {NOTIFICATION_TAP_COPY} from '../src/push/tapArrival';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
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
});
