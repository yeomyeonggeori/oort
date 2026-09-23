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
import React from 'react';
import {AppState} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {PUSH_ACTION} from '../src/push/contract';
import {
  NOTIFICATION_TAP_COPY,
  planNotificationLanding,
  tapArrival,
} from '../src/push/tapArrival';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 알림 본문을 누르면 그 자리로 간다 (#2569, ADR-0187 D4).
//
// 여태 본문 탭은 앱만 열었다. 이 파일은 탭이 **도착하는 세 길**과 **가리키는
// 세 종류**를 곱해서 잰다 — 수용기준의 「세 상태 × 대상 종류」가 그 표다:
//
//                 채널 메시지     스레드 답글          승인 카드
//   종료(콜드)    착지            스레드 + 그 안 착지   착지 + 결정 버튼
//   백그라운드    〃              〃                   〃
//   포그라운드    〃              〃                   〃
//
// 세 길은 JS 에 들어오는 문이 다르다:
//
//   종료         탭이 앱을 띄웠다. 리스너는 세션 복원 뒤에야 붙으므로 그 이벤트는
//                지나갔고, 네이티브가 들고 있던 마지막 응답만이 그 탭을 본다
//                (`getLastNotificationResponse`). 리스너는 여기서 **한 번도** 불리지
//                않는다.
//   백그라운드   트리가 살아 있다. 앱이 뒤로 갔다가(`AppState` background) 탭으로
//                돌아오며(active) 리스너가 응답을 받는다.
//   포그라운드   앱이 앞에 있고 **다른 대화가 열려 있다.** 알림 센터에서 지난 알림을
//                눌렀다. 착지는 그 대화를 대체해야 한다.
//
// 가짜는 셋이다: 서버의 답(`fetch`), expo 의 네이티브 쪽(리스너·마지막 응답), 그리고
// `AppState` 전이. 탭을 판정하는 코드·셸의 항법·타임라인·스레드는 전부 진짜이고,
// 단정은 「호출했는가」가 아니라 **화면이 어디에 섰는가**다 — 헤더의 제목, 스레드의
// 제목, 그리고 목록이 **물들인** 행(`landed`).
//
// 가짜 알림의 모양은 relay 가 APNs 로 보내는 것 그대로다
// (`server-rust/bins/momo-push-relay/src/dispatch.rs` `ApnsPayload`): 식별자만 있고
// 본문은 없다(ADR-0120 D2-A).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '99999999-2222-4222-8222-999999999999';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const MINSU = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HERMES = 'dddddddd-1111-4111-8111-dddddddddddd';
const BASE = 'https://api.example.com';
const T0 = 1_700_000_000_000;

const GENERAL = '33333333-3333-4333-8333-333333333333';
const RANDOM = '44444444-3333-4333-8333-444444444444';
/** 목록에 없는 방. 나왔거나 사라진 방은 서버의 목록에서 빠진다. */
const GONE = '55555555-3333-4333-8333-555555555555';
/** 첫 조회에는 없고 다시 물으면 있는 DM — 알림이 목록 캐시보다 빨리 온 경우. */
const FRESH_DM = '66666666-3333-4333-8333-666666666666';

const PLAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOT = 'aaaaaaaa-0000-4000-8000-000000000002';
const REPLY = 'aaaaaaaa-0000-4000-8000-000000000003';
const APPROVAL_MSG = 'aaaaaaaa-0000-4000-8000-000000000004';
const DELETED = 'aaaaaaaa-0000-4000-8000-000000000005';
/** 답글이지만 루트(`OLD_ROOT`)는 첫 페이지 밖에 있다. */
const ORPHAN_REPLY = 'aaaaaaaa-0000-4000-8000-000000000006';
const OLD_ROOT = 'aaaaaaaa-0000-4000-8000-000000000007';
/** 첫 페이지 밖의 메시지. 알림은 순서값을 나르지 않으므로 어디 있는지 모른다. */
const UNLOADED = 'aaaaaaaa-0000-4000-8000-000000000008';
const RANDOM_MSG = 'aaaaaaaa-0000-4000-8000-000000000009';
const APPROVAL_ID = 'eeeeeeee-0000-4000-8000-000000000001';

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

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({id: MINSU, displayName: '김민수', handle: 'minsu'}),
  rosterMember({id: HERMES, kind: 'agent', displayName: '헤르메스', handle: 'hermes'}),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: RANDOM, workspaceId: WS, kind: 'public', name: 'random', muted: false},
];

const DM_CHANNEL = {
  id: FRESH_DM,
  workspaceId: WS,
  kind: 'dm',
  muted: false,
  memberIds: [SELF_ID, MINSU],
};

function message(seq: number, id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    channelId: GENERAL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: MINSU,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: T0 + seq * 1000,
    ...over,
  };
}

const GENERAL_HEAD = [
  message(10, PLAIN, {body: '배포 끝났습니다'}),
  message(11, ROOT, {
    body: '배포 체크리스트',
    thread: {reply_count: 1, last_reply_seq: 12, last_reply_at: T0 + 12_000},
  }),
  message(12, REPLY, {rootId: ROOT, authorMemberId: HERMES, body: '체크 완료'}),
  message(13, APPROVAL_MSG, {
    authorMemberId: HERMES,
    type: 'approval_request',
    body: '툴 호출 승인',
    props: {
      approval_id: APPROVAL_ID,
      title: 'github.search_issues 실행 허가',
      approval_status: 'pending',
    },
  }),
  message(14, DELETED, {state: 'deleted', body: undefined, deletedAtMs: T0 + 20_000}),
  message(15, ORPHAN_REPLY, {rootId: OLD_ROOT, body: '오래된 스레드에 단 답글'}),
];

const RANDOM_HEAD = [
  message(3, RANDOM_MSG, {channelId: RANDOM, body: '점심 뭐 먹어요'}),
];

const PENDING_APPROVAL = {
  id: APPROVAL_ID,
  workspace_id: WS,
  run_id: 'run-1',
  channel_id: GENERAL,
  requested_by: HERMES,
  action_type: 'tool_call',
  status: 'pending',
  request_message_id: APPROVAL_MSG,
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

interface FetchOptions {
  /** 채널 목록 요청 n 번째(0부터)에 답할 목록. 없으면 늘 `CHANNELS`. */
  channelLists?: unknown[][];
  channelsStatus?: number;
}

function installFetch(options: FetchOptions = {}): jest.Mock {
  let channelCalls = 0;
  const mock = jest.fn(async (url: string, init?: {method?: string}) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/replies')) {
      return jsonResponse(200, {
        messages: url.includes(ROOT) ? [GENERAL_HEAD[2]] : [],
      });
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      const call = channelCalls;
      channelCalls += 1;
      if (options.channelsStatus !== undefined) {
        return jsonResponse(options.channelsStatus, {error: {message: 'boom'}});
      }
      const lists = options.channelLists;
      const list = lists ? lists[Math.min(call, lists.length - 1)] : CHANNELS;
      return jsonResponse(200, {channels: list});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) {
      return jsonResponse(200, {read_states: []});
    }
    if (url.includes('/messages')) {
      if (url.includes(RANDOM)) return jsonResponse(200, {messages: RANDOM_HEAD});
      if (url.includes(FRESH_DM)) return jsonResponse(200, {messages: []});
      return jsonResponse(200, {messages: GENERAL_HEAD});
    }
    if (url.includes('/approvals')) {
      if (init?.method === 'POST') {
        throw new Error(`a notification tap must never decide: ${url}`);
      }
      return jsonResponse(200, {approvals: [PENDING_APPROVAL]});
    }
    if (url.includes('/work-sessions')) {
      return jsonResponse(200, {workSessions: []});
    }
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// ---- the notification, exactly as the relay shapes it ----------------------

interface Aim {
  workspaceId?: string;
  channelId?: string;
  messageId: string;
  /** `aps.thread-id`. 채널 본류면 채널 id 그대로다(판정 SQL 의 COALESCE). */
  threadId?: string;
  category?: string;
  reason?: string;
  approvalId?: string;
}

function apnsPayload(aim: Aim): Record<string, unknown> {
  const channelId = aim.channelId ?? GENERAL;
  const momo: Record<string, unknown> = {
    schema: 'momo.push.notification.v2',
    server_id: 'srv-1',
    workspace_id: aim.workspaceId ?? WS,
    channel_id: channelId,
    message_id: aim.messageId,
    collapse_id: `m:${aim.messageId}`,
    reason: aim.reason ?? 'mention',
  };
  if (aim.approvalId) momo.approval_id = aim.approvalId;
  return {
    aps: {
      alert: {title: 'oort', body: '새 알림'},
      badge: 3,
      'thread-id': aim.threadId ?? channelId,
      category: aim.category ?? 'momo.mention',
      'mutable-content': 1,
      'content-available': 1,
    },
    momo,
  };
}

let responseSerial = 0;

function tapResponse(
  payload: unknown,
  actionIdentifier: string = Notifications.DEFAULT_ACTION_IDENTIFIER,
) {
  responseSerial += 1;
  return {
    actionIdentifier,
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

const TARGETS = {
  '채널 메시지': {
    aim: {messageId: PLAIN} as Aim,
    landsOn: PLAIN,
    inThread: false,
  },
  '스레드 답글': {
    aim: {messageId: REPLY, threadId: ROOT, category: 'momo.message', reason: 'dm'} as Aim,
    landsOn: REPLY,
    inThread: true,
  },
  '승인 카드': {
    aim: {
      messageId: APPROVAL_MSG,
      category: 'momo.approval',
      reason: 'approval_request',
      approvalId: APPROVAL_ID,
    } as Aim,
    landsOn: APPROVAL_MSG,
    inThread: false,
  },
} as const;

// ---- the native side -------------------------------------------------------

const notificationsMock = Notifications as unknown as {
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponse: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
};

/** 리스너를 붙잡아 둔다. 백그라운드·포그라운드 탭은 이것을 부른다. */
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

/**
 * `AppState` 전이를 손으로 낸다. RN 0.86 의 jest mock 은 `emit` 을 내놓지 않으므로
 * 구독 자체를 가로챈다(`conversationRenders.test.tsx` 의 같은 도구). 렌더 **전에**
 * 걸어야 한다.
 */
function captureAppState(): (status: string) => void {
  const handlers: ((status: string) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    fn: (status: string) => void,
  ) => {
    handlers.push(fn);
    return {
      remove: () => {
        const at = handlers.indexOf(fn);
        if (at >= 0) handlers.splice(at, 1);
      },
    };
  }) as never);
  return status => {
    for (const fn of [...handlers]) fn(status);
  };
}

// ---- rendering and reading the screen --------------------------------------

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

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

type Node = {props?: Record<string, unknown>};

/** 목록이 **물들인** 행들 — 점프가 실제로 그 행을 찾아 내려앉았다는 증거. */
function landedIds(): string[] {
  return screen.UNSAFE_root.findAll(
    (node: Node) =>
      node.props?.landed === true &&
      typeof (node.props?.message as {id?: unknown})?.id === 'string',
  ).map((node: Node) => (node.props?.message as {id: string}).id);
}

/** 화면에 걸린 점프들(채널, 그리고 열려 있으면 스레드). */
function jumpTargets(): {messageId: string; token: number}[] {
  return screen.UNSAFE_root.findAll(
    (node: Node) =>
      node.props?.jumpTarget !== undefined && node.props?.jumpTarget !== null,
  ).map(
    (node: Node) => node.props?.jumpTarget as {messageId: string; token: number},
  );
}

async function waitForSidebar(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

async function tapWhileRunning(payload: unknown): Promise<void> {
  expect(deliver).not.toBeNull();
  await act(async () => {
    deliver?.(tapResponse(payload));
  });
}

/** 착지했다: 헤더가 그 방이고, 그 행이 물들었고, 스레드면 스레드가 열려 있다. */
async function expectLanded(
  title: string,
  landsOn: string,
  inThread: boolean,
): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(title),
  );
  if (inThread) {
    await waitFor(() => expect(screen.getByTestId('thread-title')).toBeTruthy());
  } else {
    expect(screen.queryByTestId('thread-title')).toBeNull();
  }
  await waitFor(() => expect(landedIds()).toContain(landsOn));
}

/**
 * 그 상자가 **그 한 문장**을 든다. 상자에는 「닫기」도 있으므로 상자 전체의 글이
 * 아니라 문장 한 줄을 찾는다 — 문장이 조각나 있으면 이 찾기가 실패한다.
 */
async function expectSentence(testID: string, sentence: string): Promise<void> {
  await waitFor(() =>
    expect(within(screen.getByTestId(testID)).getByText(sentence)).toBeTruthy(),
  );
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  captureListener();
  notificationsMock.getLastNotificationResponse.mockReset().mockReturnValue(null);
  notificationsMock.clearLastNotificationResponse.mockReset();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

// =============================================================================
describe('탭이 가리키는 곳 — 식별자만으로 짓는다 (순수)', () => {
  it('채널 본류의 메시지는 채널·메시지만 든다', () => {
    const arrival = tapArrival(tapResponse(apnsPayload({messageId: PLAIN})), WS);
    expect(arrival).toEqual({
      kind: 'target',
      target: {
        channelId: GENERAL,
        messageId: PLAIN,
        threadRootId: null,
        approvalId: null,
        category: 'momo.mention',
      },
    });
  });

  it('thread-id 가 채널과 다르면 그것이 스레드 루트다', () => {
    const arrival = tapArrival(
      tapResponse(apnsPayload(TARGETS['스레드 답글'].aim)),
      WS,
    );
    expect(arrival?.kind === 'target' && arrival.target.threadRootId).toBe(ROOT);
  });

  it('승인 알림은 승인 id 를 들고, 착지는 그 카드 메시지다', () => {
    const arrival = tapArrival(
      tapResponse(apnsPayload(TARGETS['승인 카드'].aim)),
      WS,
    );
    expect(arrival?.kind === 'target' && arrival.target).toMatchObject({
      messageId: APPROVAL_MSG,
      approvalId: APPROVAL_ID,
      category: 'momo.approval',
    });
  });

  it('다른 워크스페이스의 알림은 목적지가 아니라 「못 간다」다', () => {
    const arrival = tapArrival(
      tapResponse(apnsPayload({messageId: PLAIN, workspaceId: OTHER_WS})),
      WS,
    );
    expect(arrival).toEqual({kind: 'unavailable', reason: 'other-workspace'});
  });

  it('읽을 수 없는 봉투도 「못 간다」다 — 조용히 앱만 열지 않는다', () => {
    const payload = apnsPayload({messageId: PLAIN});
    (payload.momo as Record<string, unknown>).schema = 'momo.push.notification.v3';
    expect(tapArrival(tapResponse(payload), WS)).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('버튼(승인·답장)은 탭이 아니다 — 항법을 만들지 않는다', () => {
    const payload = apnsPayload(TARGETS['승인 카드'].aim);
    expect(tapArrival(tapResponse(payload, PUSH_ACTION.approve), WS)).toBeNull();
    expect(tapArrival(tapResponse(payload, PUSH_ACTION.quickReply), WS)).toBeNull();
  });

  it('루트가 로드돼 있지 않은 답글은 채널에서 착지하고 그 이유를 말한다', () => {
    const plan = planNotificationLanding(GENERAL_HEAD as never, {
      messageId: ORPHAN_REPLY,
      threadRootId: OLD_ROOT,
    });
    expect(plan).toEqual({
      thread: null,
      jumpInChannel: true,
      notice: NOTIFICATION_TAP_COPY.threadRootNotLoaded,
    });
  });

  it('지워진 메시지는 묘비에 착지하고 지워졌다고 말한다', () => {
    const plan = planNotificationLanding(GENERAL_HEAD as never, {
      messageId: DELETED,
      threadRootId: null,
    });
    expect(plan).toEqual({
      thread: null,
      jumpInChannel: true,
      notice: NOTIFICATION_TAP_COPY.messageDeleted,
    });
  });
});

// =============================================================================
describe('세 상태 × 대상 종류 (#2569 수용기준 1·3)', () => {
  const kinds = Object.keys(TARGETS) as (keyof typeof TARGETS)[];

  describe.each(kinds)('%s', kind => {
    const {aim, landsOn, inThread} = TARGETS[kind];

    it('종료 — 탭이 앱을 띄웠다: 마지막 응답만이 그 탭을 본다', async () => {
      installFetch();
      notificationsMock.getLastNotificationResponse.mockReturnValue(
        tapResponse(apnsPayload(aim)),
      );
      renderShell();

      await expectLanded('general', landsOn, inThread);
      // 이 시험은 리스너를 한 번도 부르지 않았다 — 착지는 마지막 응답이 한 것이다.
      expect(notificationsMock.getLastNotificationResponse).toHaveBeenCalled();
      // 들었으면 비운다: 로그아웃·재로그인으로 트리가 다시 붙어도 두 번 오지 않는다.
      expect(notificationsMock.clearLastNotificationResponse).toHaveBeenCalled();
      if (kind === '승인 카드') {
        await waitFor(() =>
          expect(
            screen.getByTestId(`card-approval-${APPROVAL_ID}-approve`),
          ).toBeTruthy(),
        );
      }
    });

    it('백그라운드 — 뒤로 갔던 앱이 탭으로 돌아온다', async () => {
      installFetch();
      const emitAppState = captureAppState();
      renderShell();
      await waitForSidebar();
      // 탭 전에는 아무 데도 가지 않았다.
      expect(screen.queryByTestId('conversation-title')).toBeNull();

      act(() => emitAppState('background'));
      await tapWhileRunning(apnsPayload(aim));
      act(() => emitAppState('active'));

      await expectLanded('general', landsOn, inThread);
      if (kind === '승인 카드') {
        await waitFor(() =>
          expect(
            screen.getByTestId(`card-approval-${APPROVAL_ID}-approve`),
          ).toBeTruthy(),
        );
      }
    });

    it('포그라운드 — 다른 대화가 열려 있는 중에 알림 센터에서 눌렀다', async () => {
      installFetch();
      renderShell();
      await waitForSidebar();
      fireEvent.press(screen.getByTestId(`sidebar-row-channel:${RANDOM}`));
      await waitFor(() =>
        expect(screen.getByTestId('conversation-title')).toHaveTextContent(
          'random',
        ),
      );
      await waitFor(() => expect(screen.getByText('점심 뭐 먹어요')).toBeTruthy());

      await tapWhileRunning(apnsPayload(aim));

      await expectLanded('general', landsOn, inThread);
      // 앞 방의 행이 착지로 물들지 않았다 — 앞 방의 'ready' 에 속지 않았다.
      expect(landedIds()).not.toContain(RANDOM_MSG);
      // 앞 방에서 빗나간 점프의 흔적이 없다.
      expect(screen.queryByTestId('jump-missed')).toBeNull();
    });
  });
});

// =============================================================================
describe('갈 수 없으면 한 문장 — 조용히 무시하지 않는다 (#2569 수용기준 2)', () => {
  it('목록에 없는 방 — 다시 물어도 없으면 사라졌거나 권한이 없다고 말한다', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(apnsPayload({channelId: GONE, messageId: PLAIN}));

    await expectSentence('notification-tap-notice', NOTIFICATION_TAP_COPY.channelGone);
    expect(screen.queryByTestId('conversation-title')).toBeNull();
    // 캐시만 보고 말하지 않았다 — 서버에 한 번 더 물었다.
    const channelReads = fetchMock.mock.calls.filter(
      ([url]) => String(url).includes('/channels') && !String(url).includes('/messages'),
    );
    expect(channelReads.length).toBeGreaterThanOrEqual(2);
  });

  it('캐시에 없던 새 DM 은 다시 물어서 연다', async () => {
    installFetch({channelLists: [CHANNELS, [...CHANNELS, DM_CHANNEL]]});
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(
      apnsPayload({
        channelId: FRESH_DM,
        messageId: PLAIN,
        category: 'momo.message',
        reason: 'dm',
      }),
    );

    // DM 의 제목은 상대의 이름이다 — 명부로 지었다.
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('김민수'),
    );
    expect(screen.queryByTestId('notification-tap-notice')).toBeNull();
  });

  it('다른 워크스페이스의 알림 — 여기서 열 수 없다고 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(
      apnsPayload({workspaceId: OTHER_WS, messageId: PLAIN}),
    );

    await expectSentence('notification-tap-notice', NOTIFICATION_TAP_COPY.otherWorkspace);
    expect(screen.queryByTestId('conversation-title')).toBeNull();
  });

  it('읽을 수 없는 알림 — 앱만 열었다고 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    const payload = apnsPayload({messageId: PLAIN});
    (payload.momo as Record<string, unknown>).reason = 'because';
    await tapWhileRunning(payload);

    await expectSentence('notification-tap-notice', NOTIFICATION_TAP_COPY.unreadable);
  });

  it('목록을 못 불러오면 그 사실을 말한다 — 권한 문제로 바꿔 말하지 않는다', async () => {
    installFetch({channelsStatus: 500});
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload({messageId: PLAIN})),
    );
    renderShell();

    await expectSentence('notification-tap-notice', NOTIFICATION_TAP_COPY.listFailed);
  });

  it('지워진 메시지 — 묘비에 착지하고 지워졌다고 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(apnsPayload({messageId: DELETED}));

    await expectSentence('notification-landing-notice', NOTIFICATION_TAP_COPY.messageDeleted);
    await waitFor(() => expect(landedIds()).toContain(DELETED));
  });

  it('루트가 첫 페이지 밖인 답글 — 채널에서 그 답글에 착지하고 이유를 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(
      apnsPayload({messageId: ORPHAN_REPLY, threadId: OLD_ROOT}),
    );

    await expectLanded('general', ORPHAN_REPLY, false);
    await expectSentence('notification-landing-notice', NOTIFICATION_TAP_COPY.threadRootNotLoaded);
  });

  it('첫 페이지에 없는 메시지 — 알림의 낱말로, 모르는 만큼만 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(apnsPayload({messageId: UNLOADED}));

    const expected = jumpMissedNotice('unknown', 'notification');
    await expectSentence('jump-missed', expected.headline);
    // 남의 주어(「찾던 메시지」·「인용한 원본」)로 말하지 않는다.
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(/찾던|인용한/);
  });

  it('문장은 닫을 수 있는 영수증이다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    await tapWhileRunning(apnsPayload({channelId: GONE, messageId: PLAIN}));
    await waitFor(() =>
      expect(screen.getByTestId('notification-tap-notice')).toBeTruthy(),
    );

    fireEvent.press(screen.getByTestId('notification-tap-notice-dismiss'));
    expect(screen.queryByTestId('notification-tap-notice')).toBeNull();
  });

  it('못 가면 열려 있던 대화를 걷고 대화 목록에서 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${RANDOM}`));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('random'),
    );

    await tapWhileRunning(apnsPayload({channelId: GONE, messageId: PLAIN}));

    await waitFor(() =>
      expect(screen.getByTestId('notification-tap-notice')).toBeTruthy(),
    );
    expect(screen.queryByTestId('conversation-title')).toBeNull();
    const sidebar = screen.getByTestId('sidebar-list');
    expect(within(sidebar).queryByText('random')).toBeTruthy();
  });
});

// =============================================================================
describe('한 번의 탭은 한 번 착지한다', () => {
  it('콜드 런치의 탭이 두 길로 와도 한 번만 착지한다', async () => {
    installFetch();
    const launched = tapResponse(apnsPayload({messageId: PLAIN}));
    notificationsMock.getLastNotificationResponse.mockReturnValue(launched);
    renderShell();
    await expectLanded('general', PLAIN, false);

    // 같은 응답이 리스너로도 온다.
    await act(async () => {
      deliver?.(launched);
    });

    // 두 번째 착지가 있었다면 점프 토큰이 2 로 올랐다.
    const tokens = jumpTargets()
      .filter(target => target.messageId === PLAIN)
      .map(target => target.token);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set([1]));
  });

  it('잠금 화면의 승인 버튼은 마지막 응답에서 되풀이되지 않는다', async () => {
    const fetchMock = installFetch();
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload(TARGETS['승인 카드'].aim), PUSH_ACTION.approve),
    );
    renderShell();
    await waitForSidebar();
    // 착지가 일어날 틈을 준다. 판정은 목록이 도착한 **다음** 렌더에서 돈다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(screen.queryByTestId('conversation-title')).toBeNull();
    const decisions = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/approvals') &&
        (init as {method?: string} | undefined)?.method === 'POST',
    );
    expect(decisions).toHaveLength(0);
  });

  it('같은 메시지를 가리키는 두 번째 탭도 다시 착지한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));
    await expectLanded('general', PLAIN, false);
    const first = jumpTargets().find(target => target.messageId === PLAIN)?.token;

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));
    await waitFor(() =>
      expect(
        jumpTargets().find(target => target.messageId === PLAIN)?.token,
      ).not.toBe(first),
    );
  });

  it('알림으로 연 대화에서 뒤로 가면 대화 목록이다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    fireEvent.press(screen.getByTestId('tab-inbox'));

    await tapWhileRunning(apnsPayload({messageId: PLAIN}));
    await expectLanded('general', PLAIN, false);

    fireEvent.press(screen.getAllByTestId('header-back')[0]);
    await waitFor(() =>
      expect(screen.queryByTestId('conversation-title')).toBeNull(),
    );
    expect(screen.getByTestId('tab-channels').props.accessibilityState).toEqual({
      selected: true,
    });
  });
});
