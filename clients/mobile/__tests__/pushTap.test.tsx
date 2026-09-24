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
import {AccessibilityInfo, AppState, FlatList} from 'react-native';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  jumpMissedNotice,
  jumpNoticeSpeech,
} from '../src/features/conversation/jumpNotice';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {CHANNEL_LIST_FAILED} from '../src/features/sidebar/rows';
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
/** 루트가 로드된 스레드 안의 지워진 답글 (#2584 리뷰 N-2). */
const DELETED_REPLY = 'aaaaaaaa-0000-4000-8000-000000000010';
/**
 * #random 의 두 스레드 (#2584 R2 N-A) — 한 스레드가 열려 있을 때 알림이 같은 방의
 * 다른 스레드를 연다. #general 은 늘리지 않는다: 첫 페이지가 길어지면 목록의 끝 행이
 * 가상화로 그려지지 않아 착지 단정이 행을 못 본다.
 */
const RANDOM_ROOT_A = 'aaaaaaaa-0000-4000-8000-000000000011';
const RANDOM_REPLY_A = 'aaaaaaaa-0000-4000-8000-000000000012';
const RANDOM_ROOT_B = 'aaaaaaaa-0000-4000-8000-000000000013';
const RANDOM_REPLY_B = 'aaaaaaaa-0000-4000-8000-000000000014';
/**
 * 머리 페이지를 읽은 **뒤에** 커밋된 메시지 (#2584 R2 H-1). 같은 방을 열어 둔 채 앱이
 * 뒤로 가 있는 동안 왔고, 그 사이 소켓은 끊겼다(ADR-0137 D4) — 알림으로만 왔다.
 */
const NEW_ID = 'aaaaaaaa-0000-4000-8000-000000000099';
const NEW_BODY = '방금 올린 답입니다';
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

/**
 * 평범한 글만 여덟 줄인 방 (#2594 이동 규칙 위의 착지). 스레드·승인 행이 섞이지
 * 않아야 착지 뒤의 판정이 그 행들의 높이가 아니라 착지 자체를 잰다.
 */
const LONG = '77777777-3333-4333-8333-777777777777';
const longId = (seq: number) =>
  `77777777-0000-4000-8000-${String(seq).padStart(12, '0')}`;

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: RANDOM, workspaceId: WS, kind: 'public', name: 'random', muted: false},
  {id: LONG, workspaceId: WS, kind: 'public', name: 'long', muted: false},
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
  message(16, DELETED_REPLY, {
    rootId: ROOT,
    authorMemberId: HERMES,
    state: 'deleted',
    body: undefined,
    deletedAtMs: T0 + 30_000,
  }),
];

const LONG_HEAD = Array.from({length: 8}, (_, i) =>
  message(i + 1, longId(i + 1), {
    channelId: LONG,
    authorMemberId: i % 2 === 0 ? MINSU : HERMES,
    body: `${i + 1}번째 긴 방 메시지`,
  }),
);

const RANDOM_HEAD = [
  message(3, RANDOM_MSG, {channelId: RANDOM, body: '점심 뭐 먹어요'}),
  message(4, RANDOM_ROOT_A, {
    channelId: RANDOM,
    body: '회식 장소 투표',
    thread: {reply_count: 1, last_reply_seq: 5, last_reply_at: T0 + 5_000},
  }),
  message(5, RANDOM_REPLY_A, {
    channelId: RANDOM,
    rootId: RANDOM_ROOT_A,
    authorMemberId: HERMES,
    body: '2번에 한 표',
  }),
  message(6, RANDOM_ROOT_B, {
    channelId: RANDOM,
    body: '주말 등산 누구 가요',
    thread: {reply_count: 1, last_reply_seq: 7, last_reply_at: T0 + 7_000},
  }),
  message(7, RANDOM_REPLY_B, {
    channelId: RANDOM,
    rootId: RANDOM_ROOT_B,
    authorMemberId: HERMES,
    body: '저요',
  }),
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
  /**
   * 채널 목록 요청 하나하나에 직접 답한다(0부터 센 호출 번호를 받는다). 실패했다가
   * 살아나는 서버, 답이 늦게 오는 서버를 그리려고 있다 (#2584 리뷰 M-1).
   */
  channelResponder?: (call: number) => Response | Promise<Response>;
  /**
   * `?after=` 읽기(착지 전 따라잡기·레일의 역채움)에 직접 답한다 (#2584 R2 H-1).
   * `undefined` 를 돌려주면 서버 그대로 답한다 — 실패하는 답을 그리려고 있다.
   */
  afterResponder?: (
    channelId: string,
    after: number,
  ) => Response | Promise<Response> | undefined;
  /**
   * 한 방의 **첫 페이지** 읽기(`after`·`before` 없는 `/messages`)에 직접 답한다 —
   * 그 읽기를 붙들어 두려고 있다(#2632 N-3). `undefined` 면 서버 그대로.
   */
  headResponder?: (channelId: string) => Response | Promise<Response> | undefined;
}

type FetchInit = {method?: string; body?: unknown};

/**
 * 머리 페이지 **뒤에** 서버에 커밋된 메시지들, 방마다 (#2584 R2 H-1).
 *
 * 알림은 커밋 뒤에야 나간다(relay 가 outbox 를 읽는다). 그러니 탭 뒤에 나간 REST
 * 읽기는 그 메시지를 반드시 본다 — 레일(소켓)이 끊겨 있어도. 가짜 서버도 그렇게
 * 답한다: `?after=N` 은 seq 가 N 보다 큰 것만, 머리 읽기는 전부.
 */
const serverLater = new Map<string, unknown[]>();

function commitLater(channelId: string, row: unknown): void {
  serverLater.set(channelId, [...(serverLater.get(channelId) ?? []), row]);
}

function channelOf(url: string): string {
  return (url.split('/channels/')[1]?.split('/')[0] ?? '').toLowerCase();
}

/** 서버가 그 방에 들고 있는 행 전부 — 첫 페이지와 그 뒤에 커밋된 것. */
function serverRows(url: string): unknown[] {
  const channelId = channelOf(url);
  const head =
    channelId === RANDOM
      ? RANDOM_HEAD
      : channelId === LONG
        ? LONG_HEAD
        : channelId === FRESH_DM
          ? []
          : GENERAL_HEAD;
  return [...head, ...(serverLater.get(channelId) ?? [])];
}

function installFetch(options: FetchOptions = {}): jest.Mock {
  let channelCalls = 0;
  const mock = jest.fn(async (url: string, init?: FetchInit) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/replies')) {
      const rootId = url.split('/messages/')[1]?.split('/')[0] ?? '';
      return jsonResponse(200, {
        messages: serverRows(url).filter(
          m => (m as {rootId?: string}).rootId === rootId,
        ),
      });
    }
    // 읽음 커서(`PUT …/channels/{id}/read-state`, #2593 explicit_open)는 채널 목록이
    // 아니다. `/channels` 보다 먼저 가른다 — 아니면 목록 호출로 세어져
    // `channelResponder` 의 차례를 먹고, 목록의 답 대신 그 PUT 이 풀린다.
    if (url.includes('/read-state')) {
      if (init?.method === 'PUT') {
        const channelId = url.split('/channels/')[1]?.split('/')[0] ?? '';
        const {last_read_seq: lastReadSeq = 0} = JSON.parse(
          String(init.body ?? '{}'),
        ) as {last_read_seq?: number};
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
      const call = channelCalls;
      channelCalls += 1;
      if (options.channelResponder) return options.channelResponder(call);
      if (options.channelsStatus !== undefined) {
        return jsonResponse(options.channelsStatus, {error: {message: 'boom'}});
      }
      const lists = options.channelLists;
      const list = lists ? lists[Math.min(call, lists.length - 1)] : CHANNELS;
      return jsonResponse(200, {channels: list});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/messages')) {
      const channelId = channelOf(url);
      const all = serverRows(url);
      const after = /[?&]after=(\d+)/.exec(url);
      if (after !== null) {
        const since = Number(after[1]);
        const answered = options.afterResponder?.(channelId, since);
        if (answered !== undefined) return answered;
        return jsonResponse(200, {
          messages: all.filter(m => (m as {seq: number}).seq > since),
        });
      }
      if (!/[?&]before=/.test(url)) {
        const answered = options.headResponder?.(channelId);
        if (answered !== undefined) return answered;
      }
      return jsonResponse(200, {messages: all});
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

/**
 * 셸이 **자리를 잡은** 상태를 기다리는 예산 (#1268 과 같은 규율 — `inboxApproval`·
 * `actionApprovalCard` 의 `SETTLE`).
 *
 * RNTL 기본 1초는 linux/amd64 CI 의 **차가운 워커**에서 이 파일의 첫 셸 렌더를
 * 넘지 못한다: `react-native` 의 게으른 getter(`FlatList`·`ScrollView`…)가 첫 렌더
 * 안에서 처음 풀리며 그 자리에서 변환된다. 로컬에서도 캐시를 비우면(`--no-cache`)
 * 첫 셸 시험이 313ms → 1562ms 로 늘었고, CI 에서는 「conversation-title 을 못
 * 찾았다」로 빨강이었다(`bb2b8085`·`b6b8f382`). 스쳐 가는 상태에는 쓰지 않는다 —
 * 이 파일의 「없다」 단정은 전부 `queryBy…` 즉시 읽기다.
 */
const SETTLE = {timeout: 10_000};
jest.setTimeout(30_000);

async function waitForSidebar(): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('sidebar-list')).toBeTruthy(),
    SETTLE,
  );
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
  await waitFor(
    () =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(title),
    SETTLE,
  );
  if (inThread) {
    await waitFor(
      () => expect(screen.getByTestId('thread-title')).toBeTruthy(),
      SETTLE,
    );
  } else {
    expect(screen.queryByTestId('thread-title')).toBeNull();
  }
  await waitFor(() => expect(landedIds()).toContain(landsOn), SETTLE);
}

/**
 * 그 상자가 **그 한 문장**을 든다. 상자에는 「닫기」도 있으므로 상자 전체의 글이
 * 아니라 문장 한 줄을 찾는다 — 문장이 조각나 있으면 이 찾기가 실패한다.
 */
/**
 * 화면이 소리로 말한 문장들 (#2584 리뷰 M-2). 한 문장 7종은 전부 사람이 누른 곳과
 * 다른 화면에 서므로, 화면을 보지 않는 사람에게도 닿아야 한다.
 */
let announce: jest.SpyInstance;

async function expectSentence(testID: string, sentence: string): Promise<void> {
  await waitFor(
    () =>
      expect(
        within(screen.getByTestId(testID)).getByText(sentence),
      ).toBeTruthy(),
    SETTLE,
  );
}

beforeEach(() => {
  mmkvStore.clear();
  serverLater.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  captureListener();
  notificationsMock.getLastNotificationResponse.mockReset().mockReturnValue(null);
  notificationsMock.clearLastNotificationResponse.mockReset();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  announce.mockClear();
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

  it('스레드 안의 지워진 답글도 같은 문장이다 — 스레드를 열고 거기서 말한다 (#2584 N-2)', () => {
    const plan = planNotificationLanding(GENERAL_HEAD as never, {
      messageId: DELETED_REPLY,
      threadRootId: ROOT,
    });
    expect(plan.thread?.id).toBe(ROOT);
    expect(plan.jumpInChannel).toBe(false);
    expect(plan.notice).toBe(NOTIFICATION_TAP_COPY.messageDeleted);
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
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.channelGone);
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
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.otherWorkspace);
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
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.unreadable);
  });

  it('목록 조회 실패 — ErrorState 한 상자만 말하고, 다시 시도가 성공하면 그때 착지한다 (#2584 M-1)', async () => {
    let listUp = false;
    installFetch({
      channelResponder: () =>
        listUp
          ? jsonResponse(200, {channels: CHANNELS})
          : jsonResponse(500, {error: {message: 'boom'}}),
    });
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload({messageId: PLAIN})),
    );
    renderShell();

    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());
    // 한 사실은 한 상자다. 목록의 오류 상자 하나만 서고, 알림의 두 번째 상자는 없다.
    expect(screen.getAllByTestId('channels-error')).toHaveLength(1);
    expect(screen.getByText(CHANNEL_LIST_FAILED)).toBeTruthy();
    expect(screen.queryByTestId('notification-tap-notice')).toBeNull();
    // 소리로는 그 상자의 문장을 한 번 말한다.
    await waitFor(() => expect(announce).toHaveBeenCalledWith(CHANNEL_LIST_FAILED));
    expect(screen.queryByTestId('conversation-title')).toBeNull();

    // 다시 시도가 또 실패해도 탭은 남고, 같은 말을 되풀이하지 않는다.
    fireEvent.press(screen.getByTestId('channels-error-retry'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(screen.getAllByTestId('channels-error')).toHaveLength(1);
    expect(
      announce.mock.calls.filter(([said]) => said === CHANNEL_LIST_FAILED),
    ).toHaveLength(1);

    // 서버가 살아났다 → 다시 시도 → 그때 착지한다. 탭을 먼저 소진했다면 여기서 멈춘다.
    listUp = true;
    fireEvent.press(screen.getByTestId('channels-error-retry'));
    await expectLanded('general', PLAIN, false);
    expect(screen.queryByTestId('notification-tap-notice')).toBeNull();
  });

  it('목록 조회 실패 뒤 돌아온 목록에 방이 없으면 「없어졌거나 볼 권한이 없다」로 간다 (#2584 M-1)', async () => {
    let listUp = false;
    installFetch({
      channelResponder: () =>
        listUp
          ? jsonResponse(200, {channels: CHANNELS})
          : jsonResponse(500, {error: {message: 'boom'}}),
    });
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload({channelId: GONE, messageId: PLAIN})),
    );
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());

    listUp = true;
    fireEvent.press(screen.getByTestId('channels-error-retry'));

    await expectSentence('notification-tap-notice', NOTIFICATION_TAP_COPY.channelGone);
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.channelGone);
    expect(screen.queryByTestId('conversation-title')).toBeNull();
  });

  it('답을 기다리는 동안 사람이 다른 대화를 열면 그 탭은 접힌다 (#2584 M-1)', async () => {
    let release: ((answer: Response) => void) | null = null;
    installFetch({
      channelResponder: call =>
        call === 0
          ? jsonResponse(200, {channels: CHANNELS})
          : new Promise<Response>(resolve => {
              release = resolve;
            }),
    });
    renderShell();
    await waitForSidebar();

    // 캐시에 없는 새 DM 이라 셸이 목록을 다시 묻는다 — 그 답이 오기 전이다.
    await tapWhileRunning(
      apnsPayload({
        channelId: FRESH_DM,
        messageId: PLAIN,
        category: 'momo.message',
        reason: 'dm',
      }),
    );
    await waitFor(() => expect(release).not.toBeNull());

    // 사람이 스스로 #random 을 열었다.
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${RANDOM}`));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('random'),
    );

    // 이제야 답이 온다 — 그 DM 이 들어 있다. 그래도 끌어가지 않는다.
    await act(async () => {
      release?.(jsonResponse(200, {channels: [...CHANNELS, DM_CHANNEL]}));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    // 그 DM 이 열렸다면 헤더는 상대의 이름(김민수)이다.
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('random');
    expect(landedIds()).toHaveLength(0);
    expect(screen.queryByTestId('notification-tap-notice')).toBeNull();
  });

  it('지워진 메시지 — 묘비에 착지하고 지워졌다고 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(apnsPayload({messageId: DELETED}));

    await expectSentence('notification-landing-notice', NOTIFICATION_TAP_COPY.messageDeleted);
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.messageDeleted);
    await waitFor(() => expect(landedIds()).toContain(DELETED));
  });

  it('스레드 안의 지워진 답글 — 스레드 안에서도 같은 문장으로 말한다 (#2584 N-2)', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();

    await tapWhileRunning(
      apnsPayload({messageId: DELETED_REPLY, threadId: ROOT}),
    );

    await waitFor(() => expect(screen.getByTestId('thread-title')).toBeTruthy());
    // 채널 쪽 자리는 스레드 판이 덮는다. 문장은 **스레드 판 안에** 서야 읽힌다.
    const panel = screen.UNSAFE_getByType(ThreadPanel);
    await waitFor(() =>
      expect(
        within(panel).getByText(NOTIFICATION_TAP_COPY.messageDeleted),
      ).toBeTruthy(),
    );
    expect(screen.getAllByTestId('notification-landing-notice')).toHaveLength(1);
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.messageDeleted);
    await waitFor(() => expect(landedIds()).toContain(DELETED_REPLY));
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
    expect(announce).toHaveBeenCalledWith(NOTIFICATION_TAP_COPY.threadRootNotLoaded);
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
    // 그리고 소리로도 말한다 (#2584 M-2) — 상자의 두 줄을 그대로.
    expect(announce).toHaveBeenCalledWith(jumpNoticeSpeech(expected));
  });

  it('같은 방이 이미 열려 있어도, 첫 페이지에 없는 메시지면 고지를 세우고 말한다', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    await tapWhileRunning(apnsPayload({messageId: PLAIN}));
    await expectLanded('general', PLAIN, false);

    // 같은 방(#general)을 가리키는 두 번째 알림 — 이번에는 첫 페이지 밖의 메시지다.
    await tapWhileRunning(apnsPayload({messageId: UNLOADED}));

    const expected = jumpMissedNotice('unknown', 'notification');
    await expectSentence('jump-missed', expected.headline);
    expect(announce).toHaveBeenCalledWith(jumpNoticeSpeech(expected));
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

// =============================================================================
// #2594(점프 필)의 이동 규칙 위의 알림 착지.
//
// #2594 는 점프가 가는 동안 판정을 쥐고(`beginJumpTravel`), 이동이 멈추면 멈춘 자리에서
// 바닥을 다시 판정하게 했다(design-review 2594 R2 H-A). 그 리뷰가 적었듯 #2584 이후
// 가장 흔한 푸시 탭 — 가장 새 메시지로 착지 — 이 정확히 그 길이다. 그래서 알림 착지가
// 그 규칙 위에서 제대로 끝나는지를 앱 전체로 잰다:
//
//   가장 새 메시지로 착지   →  「최신 메시지로 이동」은 서지 않고, 다음 말을 따라간다.
//   중간 메시지로 착지      →  「최신 메시지로 이동」이 서고, 다음 말은 세기만 한다.
//   스레드 답글로 착지      →  채널은 점프를 받지 않으므로 자기 진입대로 끝에서 연다.
//
// 네이티브 목록이 없으므로 `scrollToIndex` 가 하는 일을 흉내 낸다: 부른 뒤 한 박자 뒤에
// 목록이 착지한 자리를 보고한다(끝난 프로그램 스크롤의 마지막 보고). 보고는 **이동이
// 살아 있는 동안**(250ms 안에) 오고, 판정은 이동이 멈춘 뒤에 난다.
// =============================================================================

interface FakeChannelSub {
  __emit: (event: string, ctx: unknown) => void;
  /** 서버의 `subscribed` 그대로 — 이벤트, 그다음 복구된 발행의 동기 flush. */
  __subscribed: (ctx?: {recovered?: boolean; publications?: unknown[]}) => void;
}

function channelSub(channelId: string): FakeChannelSub | null {
  const clients = (
    jest.requireMock('centrifuge') as {
      __clients: {getSubscription: (name: string) => FakeChannelSub | null}[];
    }
  ).__clients;
  const last = clients[clients.length - 1];
  return last?.getSubscription(centrifugoChannelName(WS, channelId)) ?? null;
}

/** 대화의 목록. 스레드 판이 열려 있으면 그 판의 목록은 두 번째다. */
function channelList() {
  return screen.getAllByTestId('timeline-list')[0];
}

const CONTENT = 4000;
const VIEWPORT = 800;
const AT_END = CONTENT - VIEWPORT;

/** 목록이 오프셋 `y` 에 섰다고 보고한다(콘텐츠 4000 · 창 800). */
function reportAt(y: number, content = CONTENT) {
  fireEvent(channelList(), 'contentSizeChange', 390, content);
  fireEvent.scroll(channelList(), {
    nativeEvent: {
      contentOffset: {y},
      contentSize: {height: content, width: 390},
      layoutMeasurement: {height: VIEWPORT, width: 390},
    },
  });
}

/** 점프의 `scrollToIndex` 가 목록을 `y` 에 앉힌다 — 한 박자 뒤에 그 자리를 보고한다. */
function landingSettlesAt(y: number): jest.SpyInstance {
  return jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {
      setTimeout(() => reportAt(y), 20);
    });
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

function latestPill() {
  return screen.queryByTestId('jump-latest');
}

/** 필 안의 보이는 문장(화살표 글리프 제외) — `unreadJumpPills.test.tsx` 와 같은 읽기. */
function latestPillSentence(): string {
  const pill = screen.getByTestId('jump-latest');
  const texts = within(pill).queryAllByText(/보기|이동/);
  const label = texts[texts.length - 1];
  const flatten = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') {
      return String(node);
    }
    if (Array.isArray(node)) return node.map(flatten).join('');
    const children = (node as {props?: {children?: unknown}})?.props?.children;
    return children === undefined ? '' : flatten(children);
  };
  return flatten(label.props.children);
}

/** 필이 말하는 문장, 필이 없으면 null — 실패할 때 무엇이 섰는지 원문으로 보인다. */
function latestPillSaid(): string | null {
  return latestPill() === null ? null : latestPillSentence();
}

/**
 * 남의 말이 하나 붙는다: 레일로 한 줄이 오고, 목록이 그만큼 자란다. 따라가는 목록은
 * 그 자람에 끝으로 간다 — 그 요청을 돌려준다.
 */
async function someoneElseTalks(seq: number): Promise<jest.SpyInstance> {
  const toEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  await act(async () => {
    channelSub(LONG)?.__emit('publication', {
      data: {
        type: 'message.new',
        v: 1,
        ts: T0 + seq * 1000,
        seq,
        payload: {
          id: longId(seq),
          channel_id: LONG,
          seq,
          type: 'text',
          body: `${seq}번째 긴 방 메시지`,
          author_member_id: MINSU,
          hlc_ts: seq,
          hlc_count: 0,
          created_at_ms: T0 + seq * 1000,
        },
      },
    });
  });
  await waitFor(() => expect(screen.getByText(`${seq}번째 긴 방 메시지`)).toBeTruthy());
  fireEvent(channelList(), 'contentSizeChange', 390, CONTENT + 100);
  return toEnd;
}

/**
 * 다른 방(#general)을 읽고 있다 — 끝에 앉아 따라가는 중이다. 백그라운드 착지는 이
 * 자리에서 떠난다: 알림은 **다른 방**을 가리키고, 목록은 방이 바뀌며 판정을 새로 한다
 * (#2594 R1 H-1 `judgedChannel`).
 */
async function readingGeneralAtItsEnd(): Promise<void> {
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(
    () =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(
        'general',
      ),
    SETTLE,
  );
  await waitFor(
    () => expect(screen.getByText('배포 끝났습니다')).toBeTruthy(),
    SETTLE,
  );
  reportAt(AT_END);
  await sleep(50);
}

const TO_NEWEST: Aim = {channelId: LONG, messageId: longId(8)};
const TO_MIDDLE: Aim = {channelId: LONG, messageId: longId(3)};

describe('#2594 이동 규칙 위의 알림 착지 — 끝 근처면 따라가고, 멀면 「최신으로」가 선다', () => {
  it('종료 — 다른 방의 가장 새 메시지로 착지하면 「최신으로」가 서지 않고 다음 말을 따라간다', async () => {
    installFetch();
    landingSettlesAt(AT_END);
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload(TO_NEWEST)),
    );
    renderShell();

    await expectLanded('long', longId(8), false);
    await sleep(400); // 이동이 멈춘다(250ms) — 멈춘 자리(끝)에서 판정한다
    expect(latestPillSaid()).toBeNull();

    const toEnd = await someoneElseTalks(9);
    expect(toEnd).toHaveBeenCalled();
    expect(latestPillSaid()).toBeNull();
  });

  it('백그라운드 — 다른 방을 읽다 뒤로 갔고, 가장 새 메시지 알림으로 돌아와도 같다', async () => {
    installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await readingGeneralAtItsEnd();
    landingSettlesAt(AT_END);

    act(() => emitAppState('background'));
    await tapWhileRunning(apnsPayload(TO_NEWEST));
    act(() => emitAppState('active'));

    await expectLanded('long', longId(8), false);
    await sleep(400);
    expect(latestPillSaid()).toBeNull();

    const toEnd = await someoneElseTalks(9);
    expect(toEnd).toHaveBeenCalled();
    expect(latestPillSaid()).toBeNull();
  });

  it('종료 — 중간 메시지로 착지하면 「최신 메시지로 이동」이 서고, 다음 말은 세기만 한다', async () => {
    installFetch();
    landingSettlesAt(1200); // 끝에서 2000pt 위
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload(TO_MIDDLE)),
    );
    renderShell();

    await expectLanded('long', longId(3), false);
    await sleep(400);
    await waitFor(() => expect(latestPill()).toBeTruthy());
    expect(latestPillSentence()).toBe('최신 메시지로 이동');

    const toEnd = await someoneElseTalks(9);
    // 읽던 자리를 뺏지 않는다 — 대신 필이 센다.
    expect(toEnd).not.toHaveBeenCalled();
    await waitFor(() => expect(latestPillSentence()).toBe('새 메시지 1개 보기'));
  });

  it('백그라운드 — 다른 방을 읽다 뒤로 갔고, 중간 메시지 알림으로 돌아와도 같다', async () => {
    installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await readingGeneralAtItsEnd();
    landingSettlesAt(1200);

    act(() => emitAppState('background'));
    await tapWhileRunning(apnsPayload(TO_MIDDLE));
    act(() => emitAppState('active'));

    await expectLanded('long', longId(3), false);
    await sleep(400);
    await waitFor(() => expect(latestPill()).toBeTruthy());
    expect(latestPillSentence()).toBe('최신 메시지로 이동');

    const toEnd = await someoneElseTalks(9);
    expect(toEnd).not.toHaveBeenCalled();
    await waitFor(() => expect(latestPillSentence()).toBe('새 메시지 1개 보기'));
  });

  it('스레드 답글로 착지하면 채널은 점프를 받지 않고 자기 진입대로 끝에서 연다', async () => {
    installFetch();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    notificationsMock.getLastNotificationResponse.mockReturnValue(
      tapResponse(apnsPayload(TARGETS['스레드 답글'].aim)),
    );
    renderShell();

    await expectLanded('general', REPLY, true);
    // 채널의 목록이 처음 자기 크기를 알린다 — 점프가 진입을 가져가지 않았으므로 진입
    // 앵커가 끝으로 데려간다. 점프는 스레드 판의 목록에서만 났다.
    toEnd.mockClear();
    fireEvent(channelList(), 'contentSizeChange', 390, CONTENT);
    expect(toEnd).toHaveBeenCalled();
    expect(toIndex).toHaveBeenCalledTimes(1);
    await sleep(100);
    expect(latestPillSaid()).toBeNull();
  });
});

// =============================================================================
// 같은 방 복귀 탭 — 탭 뒤에 읽은 것만으로 「없다」고 말한다 (#2584 design-review R2 H-1).
//
// 같은 방(흔히 DM)을 열어 둔 채 앱이 뒤로 갔다. 15초 뒤 소켓이 끊기고(ADR-0137 D4)
// 상대의 새 메시지는 알림으로만 왔다. 그 알림을 누르면 대화 화면은 다시 마운트되지
// 않고 `channelId` 도 그대로라, 타임라인은 **탭 앞에 읽은** 그 방의 첫 페이지를 들고
// 있다. 그 행들로 판정하면 방금 온 메시지는 없고, 화면은 「찾지 못했습니다 / 위로
// 올려 이전 대화를 더 불러오세요」를 세우고 낭독한다 — 메시지는 더 새것이고 아래에서
// 오는데. 문장을 따라 위로 올린 사람은 레일이 복구하는 순간 대기 점프에 끌려 내려온다.
//
// 셸이 M-1 에서 지키는 규율을 타임라인에도 건다: **탭 뒤에 읽은 것**으로만 판정한다.
// 가짜 서버는 알림 전에 그 메시지를 커밋해 두고(`commitLater`), 레일은 손으로 늦춘다.
// =============================================================================

async function openGeneral(): Promise<void> {
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(
    () =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(
        'general',
      ),
    SETTLE,
  );
  await waitFor(
    () => expect(screen.getByText('배포 끝났습니다')).toBeTruthy(),
    SETTLE,
  );
}

/** 레일이 그 메시지를 들고 온다 — 끊겼던 소켓이 돌아와 복구한 것처럼. */
async function railDelivers(seq: number, id: string, body: string): Promise<void> {
  await act(async () => {
    channelSub(GENERAL)?.__emit('publication', {
      data: {
        type: 'message.new',
        v: 1,
        ts: T0 + seq * 1000,
        seq,
        payload: {
          id,
          channel_id: GENERAL,
          seq,
          type: 'text',
          body,
          author_member_id: MINSU,
          hlc_ts: seq,
          hlc_count: 0,
          created_at_ms: T0 + seq * 1000,
        },
      },
    });
  });
}

/**
 * 채널 목록이 그 메시지의 행으로 옮겨졌다. 끝 행은 가상화로 아직 안 그려졌을 수 있어
 * (`landedIds` 는 그려진 행만 본다) 목록의 데이터에서 그 행의 자리를 찾고, 점프가 그
 * 자리로 `scrollToIndex` 를 불렀는지 본다.
 */
function movedToRow(messageId: string, toIndex: jest.SpyInstance): boolean {
  const list = screen
    .UNSAFE_getAllByType(FlatList)
    .find(node => node.props.testID === 'timeline-list');
  const data = (list?.props.data ?? []) as {
    kind?: string;
    message?: {id?: string};
  }[];
  const index = data.findIndex(
    item =>
      item.kind === 'message' &&
      item.message?.id?.toLowerCase() === messageId.toLowerCase(),
  );
  return (
    index >= 0 &&
    toIndex.mock.calls.some(([arg]) => (arg as {index?: number})?.index === index)
  );
}

/** 알림 주어의 빗나감 낭독들 — 실패하면 무엇을 말했는지 원문으로 보인다. */
function missAnnouncements(): string[] {
  const miss = jumpNoticeSpeech(jumpMissedNotice('unknown', 'notification'));
  return announce.mock.calls.map(([said]) => said).filter(said => said === miss);
}

const NEW_ROW = message(17, NEW_ID, {body: NEW_BODY});

describe('같은 방 복귀 탭 — 탭 뒤에 읽은 것만으로 없다고 말한다 (#2584 R2 H-1)', () => {
  it('같은 방을 열어 둔 채 뒤로 갔다가 그 사이 온 메시지의 알림을 누르면 — 고지 0 · 빗나감 낭독 0 · 그 메시지에 착지', async () => {
    installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW); // 서버에는 있다. 소켓은 끊겼다 — 레일은 아직 모른다.
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);

    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(toIndex).toHaveBeenCalledTimes(1);

    // 레일이 뒤늦게 같은 메시지를 들고 와도(재연결 복구) 두 번 착지하지 않는다.
    await railDelivers(17, NEW_ID, NEW_BODY);
    await sleep(100);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('탭 뒤에 사람이 목록을 잡아 올렸다가 레일이 그 메시지를 들고 와도 — 끌어내리지 않는다 (탐침 O3 순서)', async () => {
    installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);
    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();

    // 사람이 목록을 잡았다. 그 뒤에 온 복구는 목록을 옮기지 않는다.
    const jumpsAtDrag = toIndex.mock.calls.length;
    fireEvent(screen.getAllByTestId('timeline-list')[0], 'scrollBeginDrag');
    await railDelivers(17, NEW_ID, NEW_BODY);
    await sleep(100);
    expect(toIndex.mock.calls.length).toBe(jumpsAtDrag);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('레일이 먼저 복구하고 탭이 뒤에 와도 한 번 착지한다 (탐침 O2 순서)', async () => {
    installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    act(() => emitAppState('active'));
    await railDelivers(17, NEW_ID, NEW_BODY);
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));

    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    await sleep(100);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('탭 뒤 읽기가 실패하면(오프라인) 없다고 말하지 않고 기다렸다가, 레일이 역채움으로 따라잡으면 착지한다', async () => {
    let failNextAfterRead = false;
    installFetch({
      afterResponder: () => {
        if (!failNextAfterRead) return undefined;
        failNextAfterRead = false;
        return jsonResponse(503, {error: {message: 'offline'}});
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    // 첫 구독 — 레일이 이 방에 붙었다(이때의 역채움은 새것이 없다).
    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: false});
    });
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    failNextAfterRead = true; // 탭 뒤의 따라잡기 읽기가 실패한다.
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);

    // 모르는 채로는 말하지 않는다 — 고지도, 낭독도, 점프도 없다.
    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(toIndex).not.toHaveBeenCalled();

    // 소켓이 돌아와 다시 구독했다. 복구되지 않은 구독이라 레일이 REST 로 꼬리를
    // 역채우고(`backfillAfter`), 그 복구 표지가 「따라잡았다」의 신호다.
    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: false});
    });
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('다른 스레드가 열려 있는 방에서 알림이 새 스레드를 열면, 스레드 판의 점프는 한 번이다 (R2 N-A)', async () => {
    installFetch();
    renderShell();
    await waitForSidebar();
    const replyIn = (root: string, reply: string) =>
      apnsPayload({
        channelId: RANDOM,
        messageId: reply,
        threadId: root,
        category: 'momo.message',
        reason: 'dm',
      });
    // 목록 측정이 없는 시험에서 진짜 `scrollToIndex` 는 실패해 회복 라운드를 돌린다.
    // 첫 착지부터 가짜로 받아, 앞 착지의 회복이 뒤 착지의 셈에 섞이지 않게 한다.
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});
    await tapWhileRunning(replyIn(RANDOM_ROOT_A, RANDOM_REPLY_A));
    await expectLanded('random', RANDOM_REPLY_A, true);
    await sleep(400); // 앞 착지의 이동이 멈춘다(250ms)
    const before = toIndex.mock.calls.length;

    // 같은 방의 다른 스레드(B)의 답글 알림. 스레드 판은 다시 마운트되지 않고 루트만
    // 바뀐다 — 앞 스레드의 'ready' 로 한 번 일찍 쏘면, 'ready' 에서 한 번 더 쏜다.
    await tapWhileRunning(replyIn(RANDOM_ROOT_B, RANDOM_REPLY_B));
    await waitFor(() => expect(landedIds()).toContain(RANDOM_REPLY_B), SETTLE);
    await sleep(400);
    expect(toIndex.mock.calls.length - before).toBe(1);
  });
});

// =============================================================================
// 「있다」는 언제든, 「없다」는 탭 뒤 REST 읽기의 답으로만 (#2632 — #2584 R3 후속).
//
// #2584 는 같은 방 복귀 탭을 탭 뒤의 꼬리 읽기(`catchUp`)로 판정하게 했다. R3 리뷰가
// 그 규율이 새는 자리를 남겼다:
//
//   M-1  레일의 재생 표지가 읽기를 앞질러 「없다」를 판정했다(relay 적체 때 재생에
//        그 행이 아직 없다) — 거짓 「찾지 못했습니다」와 회수되지 않는 낭독.
//   M-2  읽기가 「있다」까지 막았다 — 이미 들고 있는 행·스레드 루트도, 읽기가
//        실패하면 가지 않았다.
//   N-1  보이지 않는 기다림 뒤의 늦은 착지가 사람이 잡은 목록을 옮겼다.
//   N-3  같은 방의 첫 페이지가 오는 중의 탭을, 탭 **앞에** 떠난 그 페이지로 판정했다.
//   O-2  레일 역채움이 방을 옮긴 뒤에 온 답을 새 방에 섞을 수 있었다.
//
// 시험마다 서버의 뒤늦은 행(`serverLater`)은 `beforeEach` 가 비운다 — R3 리뷰 N-2 가
// 짚은 탐침의 모듈 상태 누수가 여기서는 없다.
// =============================================================================

interface Held {
  promise: Promise<Response>;
  release: (answer: Response) => void;
}

/** 답을 붙들어 둔 요청 하나 — 테스트가 답할 때까지 온다. */
function held(): Held {
  let release: (answer: Response) => void = () => {};
  const promise = new Promise<Response>(resolve => {
    release = resolve;
  });
  return {promise, release};
}

/** 그 방의 `?after=` 읽기들(따라잡기·역채움)의 `after` 값, 나간 순서대로. */
function afterReadsOf(fetchMock: jest.Mock, channelId: string): number[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter(
      url =>
        url.toLowerCase().includes(channelId) &&
        url.includes('/messages') &&
        /[?&]after=/.test(url),
    )
    .map(url => Number(/[?&]after=(\d+)/.exec(url)?.[1]));
}

/** 채널 목록이 들고 있는 메시지 id 들. */
function rowsHeld(): string[] {
  const list = screen
    .UNSAFE_getAllByType(FlatList)
    .find(node => node.props.testID === 'timeline-list');
  const data = (list?.props.data ?? []) as {
    kind?: string;
    message?: {id?: string};
  }[];
  return data
    .filter(item => item.kind === 'message')
    .map(item => String(item.message?.id).toLowerCase());
}

/** 처음 붙은 뒤의 레일 — 첫 `subscribed` 를 보내 둔다(그때의 역채움은 새것이 없다). */
async function railAttached(): Promise<void> {
  await act(async () => {
    channelSub(GENERAL)?.__subscribed({recovered: false});
  });
  await sleep(50);
}

const NEW_REPLY_ID = 'aaaaaaaa-0000-4000-8000-000000000098';

describe('「있다」는 언제든, 「없다」는 탭 뒤 읽기로만 (#2632)', () => {
  it('꼬리 읽기가 오는 동안 레일이 빈 재생으로 다시 붙어도(relay 적체) 「없다」를 말하지 않는다 — 읽기가 답하면 착지 (M-1, 탐침 edge-b2)', async () => {
    const gates: Held[] = [];
    let holdNext = false;
    installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !holdNext) return undefined;
        holdNext = false;
        const gate = held();
        gates.push(gate);
        return gate.promise;
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    await railAttached();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    holdNext = true;
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(50);
    expect(gates).toHaveLength(1); // 탭 뒤의 꼬리 읽기가 가는 중이다

    // 레일이 다시 붙었다 — 복구됐지만 재생에 seq 17 이 아직 없다(relay 가 밀렸다).
    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: true, publications: []});
    });
    await sleep(150);
    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(toIndex).not.toHaveBeenCalled();

    // 탭 뒤의 REST 읽기가 답한다 — 그 행은 서버에 있다.
    await act(async () => {
      gates[0].release(jsonResponse(200, {messages: [NEW_ROW]}));
    });
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('읽기가 실패한 뒤 레일이 빈 재생으로 다시 붙어도 「없다」를 말하지 않는다 — 탭 뒤에 다시 읽어 착지 (M-1)', async () => {
    let failNext = false;
    const fetchMock = installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !failNext) return undefined;
        failNext = false;
        return jsonResponse(503, {error: {message: 'offline'}});
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    await railAttached();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    failNext = true; // 탭 뒤의 첫 꼬리 읽기가 실패한다
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);
    const readsBeforeReplay = afterReadsOf(fetchMock, GENERAL).length;

    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: true, publications: []});
    });
    await sleep(150);
    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    // 레일이 돌아왔다는 신호로 **탭 뒤에** 다시 읽었고, 그 답이 착지를 정했다.
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(afterReadsOf(fetchMock, GENERAL).length).toBeGreaterThan(
      readsBeforeReplay,
    );
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('들고 있는 메시지는 읽지 않고 곧바로 착지한다 — 꼬리 읽기가 실패하는 망에서도 (M-2, 탐침 edge-b1)', async () => {
    const fetchMock = installFetch({
      afterResponder: channelId =>
        channelId === GENERAL
          ? jsonResponse(503, {error: {message: 'offline'}})
          : undefined,
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    act(() => emitAppState('active'));
    // 소켓은 살아 있었다(유예 안에 돌아왔다) — 레일이 그 행을 먼저 들고 왔다.
    await railDelivers(17, NEW_ID, NEW_BODY);
    expect(rowsHeld()).toContain(NEW_ID);
    const readsBefore = afterReadsOf(fetchMock, GENERAL).length;

    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    // 들고 있으니 읽지 않았다.
    expect(afterReadsOf(fetchMock, GENERAL).length).toBe(readsBefore);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('스레드 루트를 들고 있으면 꼬리 읽기가 실패해도 스레드를 열고 그 답글에 착지한다 (M-2, 탐침 edge-c3)', async () => {
    installFetch({
      afterResponder: channelId =>
        channelId === GENERAL
          ? jsonResponse(503, {error: {message: 'offline'}})
          : undefined,
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();

    act(() => emitAppState('background'));
    commitLater(
      GENERAL,
      message(17, NEW_REPLY_ID, {rootId: ROOT, body: '방금 단 답글'}),
    );
    await tapWhileRunning(
      apnsPayload({
        messageId: NEW_REPLY_ID,
        threadId: ROOT,
        category: 'momo.message',
        reason: 'dm',
      }),
    );
    act(() => emitAppState('active'));

    // 루트는 첫 페이지에 있다 — 스레드는 자기 답글을 스스로 읽는다(`loadReplies`).
    await waitFor(
      () => expect(screen.getByTestId('thread-title')).toBeTruthy(),
      SETTLE,
    );
    await waitFor(() => expect(landedIds()).toContain(NEW_REPLY_ID), SETTLE);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('읽기가 실패해 기다리는 중에 레일이 그 행을 들고 오면(표지 없이) 곧바로 착지한다 — 「있다」는 언제든 (M-2)', async () => {
    let failNext = false;
    installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !failNext) return undefined;
        failNext = false;
        return jsonResponse(503, {error: {message: 'offline'}});
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    failNext = true;
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);
    expect(toIndex).not.toHaveBeenCalled(); // 모른다 — 기다린다

    // 소켓은 멀쩡했다 — 재구독 없이 발행 한 통으로 그 행이 온다.
    await railDelivers(17, NEW_ID, NEW_BODY);
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('같은 스레드가 이미 열려 있으면 루트를 들고 있어도 그 새 답글은 탭 뒤에 읽고 착지한다 (탐침 edge-c2 회귀 가드)', async () => {
    const fetchMock = installFetch();
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await tapWhileRunning(apnsPayload(TARGETS['스레드 답글'].aim));
    await expectLanded('general', REPLY, true);
    await sleep(400);
    const readsBefore = afterReadsOf(fetchMock, GENERAL).length;

    // 같은 스레드(ROOT)가 열린 채 뒤로 갔고, 그 스레드의 새 답글이 서버에만 있다.
    // 열린 스레드 판은 루트가 그대로라 답글을 다시 읽지 않는다 — 루트를 들고 있다는
    // 것만으로는 그 답글이 「있다」가 아니다.
    act(() => emitAppState('background'));
    commitLater(
      GENERAL,
      message(17, NEW_REPLY_ID, {rootId: ROOT, body: '같은 스레드의 새 답글'}),
    );
    await tapWhileRunning(
      apnsPayload({
        messageId: NEW_REPLY_ID,
        threadId: ROOT,
        category: 'momo.message',
        reason: 'dm',
      }),
    );
    act(() => emitAppState('active'));

    await waitFor(() => expect(landedIds()).toContain(NEW_REPLY_ID), SETTLE);
    expect(screen.getByTestId('thread-title')).toBeTruthy();
    // 채널의 꼬리 읽기(탭 뒤)가 그 답글을 가져왔다.
    expect(afterReadsOf(fetchMock, GENERAL).length).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('보이지 않는 기다림 중에 사람이 목록을 잡으면 그 기다림은 접힌다 — 늦게 온 읽기가 목록을 옮기지 않는다 (N-1, 탐침 edge-b3)', async () => {
    const gates: Held[] = [];
    let holdNext = false;
    installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !holdNext) return undefined;
        holdNext = false;
        const gate = held();
        gates.push(gate);
        return gate.promise;
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    holdNext = true;
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);

    // 읽기가 느린 동안 사람이 목록을 잡았다.
    fireEvent(screen.getAllByTestId('timeline-list')[0], 'scrollBeginDrag');
    await act(async () => {
      gates[0].release(jsonResponse(200, {messages: [NEW_ROW]}));
    });
    await sleep(300);
    expect(rowsHeld()).toContain(NEW_ID); // 그 행은 왔다 — 목록에는 있다
    expect(toIndex).not.toHaveBeenCalled(); // 그러나 잡은 목록을 옮기지 않았다
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('읽기가 실패해 레일을 기다리는 중에 목록을 잡으면, 늦게 온 역채움도 목록을 옮기지 않는다 (N-1, 탐침 edge2-b4)', async () => {
    let failNext = false;
    installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !failNext) return undefined;
        failNext = false;
        return jsonResponse(503, {error: {message: 'offline'}});
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    await openGeneral();
    await railAttached();
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW);
    failNext = true;
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(100);

    fireEvent(screen.getAllByTestId('timeline-list')[0], 'scrollBeginDrag');
    // 소켓이 돌아와 다시 붙었다 — 복구 안 됨 → 레일이 REST 로 꼬리를 역채운다.
    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: false});
    });
    await sleep(300);
    expect(rowsHeld()).toContain(NEW_ID);
    expect(toIndex).not.toHaveBeenCalled();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('같은 방의 첫 페이지가 오는 중에 탭이 와도, 탭 앞에 떠난 그 페이지로 「없다」를 말하지 않는다 — 따라잡은 뒤 착지 (N-3, 탐침 edge3-e1)', async () => {
    const heads: Held[] = [];
    let holdHead = false;
    const fetchMock = installFetch({
      headResponder: channelId => {
        if (channelId !== GENERAL || !holdHead) return undefined;
        holdHead = false;
        const gate = held();
        heads.push(gate);
        return gate.promise;
      },
    });
    const emitAppState = captureAppState();
    renderShell();
    await waitForSidebar();
    holdHead = true;
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    await waitFor(
      () =>
        expect(screen.getByTestId('conversation-title')).toHaveTextContent(
          'general',
        ),
      SETTLE,
    );
    expect(heads).toHaveLength(1); // 첫 페이지 읽기가 떠났다 — 아직 답이 없다
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});

    act(() => emitAppState('background'));
    commitLater(GENERAL, NEW_ROW); // 그 읽기가 떠난 뒤에 커밋됐다
    await tapWhileRunning(apnsPayload({messageId: NEW_ID}));
    act(() => emitAppState('active'));
    await sleep(50);

    // 탭 **앞에** 떠난 읽기의 답이 온다 — 그 행은 없다(그때는 커밋 전이었다).
    await act(async () => {
      heads[0].release(jsonResponse(200, {messages: GENERAL_HEAD}));
    });
    await sleep(100);
    expect(missAnnouncements()).toEqual([]);
    expect(screen.queryByTestId('jump-missed')).toBeNull();

    // 첫 페이지 뒤에 탭 뒤의 꼬리 읽기로 따라잡고, 그 답으로 착지한다.
    await waitFor(() => expect(movedToRow(NEW_ID, toIndex)).toBe(true), SETTLE);
    expect(afterReadsOf(fetchMock, GENERAL)).toContain(16);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(missAnnouncements()).toEqual([]);
  });

  it('레일 역채움이 오는 동안 방을 옮기면, 늦게 온 그 답은 새 방의 목록에 섞이지 않는다 (O-2)', async () => {
    const gates: Held[] = [];
    let holdNext = false;
    installFetch({
      afterResponder: channelId => {
        if (channelId !== GENERAL || !holdNext) return undefined;
        holdNext = false;
        const gate = held();
        gates.push(gate);
        return gate.promise;
      },
    });
    renderShell();
    await waitForSidebar();
    await openGeneral();
    await railAttached();

    // 레일이 다시 붙었다(복구 안 됨) → 역채움 읽기가 떠났다 — 답은 붙들어 둔다.
    commitLater(GENERAL, NEW_ROW);
    holdNext = true;
    await act(async () => {
      channelSub(GENERAL)?.__subscribed({recovered: false});
    });
    await sleep(50);
    expect(gates).toHaveLength(1);

    // 그 사이 사람이 다른 방(#random)으로 갔다.
    await tapWhileRunning(apnsPayload({channelId: RANDOM, messageId: RANDOM_MSG}));
    await expectLanded('random', RANDOM_MSG, false);

    // #general 의 역채움 답이 이제 온다. #random 의 목록은 그것을 들지 않는다.
    await act(async () => {
      gates[0].release(jsonResponse(200, {messages: [NEW_ROW]}));
    });
    await sleep(200);
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('random');
    expect(rowsHeld()).not.toContain(NEW_ID);
  });
});
