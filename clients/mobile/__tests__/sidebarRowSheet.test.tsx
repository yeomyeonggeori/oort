import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {AGENT_LIST_ACTION} from '../src/screens/SidebarScreen';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 사이드바 행 길게 누르기 → 시트 (#4229, Buzz식). 행 → 시트 → 서버 요청까지 **실제 화면**으로 잰다:
// 항목의 판정은 `channelRowActions.test.ts`, 여기는 그것이 손가락·로터·와이어에 닿는지.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HUMAN_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HERMES_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
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

function roster(selfRole: string) {
  return [
    rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: selfRole}),
    rosterMember({id: HUMAN_ID, displayName: '박서연', handle: 'seoyeon'}),
    rosterMember({id: HERMES_ID, kind: 'agent', displayName: '헤르메스', handle: 'hermes'}),
  ];
}

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-quiet', workspaceId: WS, kind: 'public', name: 'quiet', muted: true},
  {id: 'ch-dm-human', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, HUMAN_ID]},
];

const READ_STATES = [
  {channel_id: 'ch-general', last_read_seq: 10, latest_seq: 15, unread_count: 5, mention_count: 0},
  // 다 읽은 채널 — 「읽지 않음으로 표시」가 선다.
  {channel_id: 'ch-quiet', last_read_seq: 7, latest_seq: 7, unread_count: 0, mention_count: 0},
  {channel_id: 'ch-dm-human', last_read_seq: 1, latest_seq: 2, unread_count: 1, mention_count: 0},
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface Routes {
  selfRole?: string;
  /** DELETE members 의 응답 상태. 기본 200. */
  leaveStatus?: number;
  /** 읽음 PUT 의 응답 상태. 기본 200. */
  readPutStatus?: number;
}

let calls: Call[] = [];
let channelListFetches = 0;

function installFetch(routes: Routes = {}) {
  calls = [];
  channelListFetches = 0;
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (method !== 'GET') calls.push({method, url, body});
    if (method === 'PUT' && url.endsWith('/notification-pref')) {
      return jsonResponse(200, {muted: body?.muted});
    }
    if (method === 'PUT' && url.includes('/read-state')) {
      if ((routes.readPutStatus ?? 200) !== 200) {
        return jsonResponse(routes.readPutStatus as number, {error: {message: 'nope'}});
      }
      return jsonResponse(200, {
        channel_id: 'ch-general',
        last_read_seq: body?.last_read_seq,
        latest_seq: 15,
        unread_count: 0,
        mention_count: 0,
      });
    }
    if (method === 'DELETE' && url.includes('/members/')) {
      if ((routes.leaveStatus ?? 200) !== 200) {
        return jsonResponse(routes.leaveStatus as number, {error: {message: 'forbidden'}});
      }
      return jsonResponse(200, {
        membership: {
          id: 'm1',
          workspaceId: WS,
          channelId: 'ch-general',
          memberId: SELF_ID,
          role: 'member',
          joinedAtMs: 1,
          leftAtMs: 2,
        },
      });
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      channelListFetches += 1;
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) {
      return jsonResponse(200, {members: roster(routes.selfRole ?? 'admin')});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: READ_STATES});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/liveness')) return jsonResponse(404, {error: {message: 'not found'}});
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return jsonResponse(200, {
        workspace: {id: WS, slug: 'dalmuri', name: '달무리 스튜디오', updatedAtMs: 0},
      });
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

async function mount(routes: Routes = {}) {
  installFetch(routes);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy());
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const clipboard = jest.requireMock('expo-clipboard') as {__box: {value: string | null}};

beforeEach(() => {
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
  clipboard.__box.value = null;
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

/** 폰이 실제로 보내는 제스처: 손가락이 닿고(무장), 플랫폼 타이머가 울린다. */
function longPress(testID: string) {
  const row = screen.getByTestId(testID);
  fireEvent(row, 'touchStart', {nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200}});
  fireEvent(row, 'longPress');
  // 시트가 뜬 뒤 손가락이 떨어진다 — 다음 제스처가 새로 무장하려면 이 끝이 있어야 한다.
  fireEvent(row, 'touchEnd');
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const sheetKeys = () =>
  screen
    .queryAllByTestId(/^channel-sheet-(copy|mark|mute|leave)/)
    .map(node => String(node.props.testID).replace('channel-sheet-', ''));

describe('길게 누르기가 시트를 연다', () => {
  it('채널 행: 복사 셋 · 읽음 처리 · 알림 끄기 · 채널 나가기, 코어 표의 차례 그대로', async () => {
    await mount();
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
    longPress('sidebar-row-channel:ch-general');
    expect(screen.getByTestId('channel-action-sheet')).toBeTruthy();
    expect(screen.getByTestId('channel-sheet-title')).toHaveTextContent('# general');
    expect(sheetKeys()).toEqual([
      'copy-name',
      'copy-link',
      'copy-id',
      'mark-read',
      'mute-toggle',
      'leave',
    ]);
  });

  it('그냥 탭은 시트를 열지 않는다', async () => {
    await mount();
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
  });

  it('DM 행: 나가기가 없다', async () => {
    await mount();
    longPress('sidebar-row-dm:ch-dm-human');
    expect(sheetKeys()).toEqual(['copy-name', 'copy-link', 'copy-id', 'mark-read', 'mute-toggle']);
    expect(screen.getByTestId('channel-sheet-title')).toHaveTextContent('박서연');
  });

  it('다 읽은 채널: 「읽지 않음으로 표시하기」, 켜진 뮤트: 「알림 켜기」', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-quiet');
    expect(sheetKeys()).toContain('mark-unread');
    expect(sheetKeys()).not.toContain('mark-read');
    expect(screen.getByTestId('channel-sheet-mute-toggle')).toHaveTextContent('알림 켜기');
  });

  it('DM 이 아직 없는 에이전트 줄은 시트를 열지 않는다 — 누르면 DM 을 여는 줄이다', async () => {
    await mount();
    longPress(`sidebar-row-agent:${HERMES_ID}`);
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
  });

  it('일반 멤버에게는 나가기가 없다', async () => {
    await mount({selfRole: 'member'});
    longPress('sidebar-row-channel:ch-general');
    expect(sheetKeys()).not.toContain('leave');
  });

  it('닫기 줄과 배경이 시트를 닫는다', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-close'));
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
    longPress('sidebar-row-channel:ch-general');
    // 모달 시트 뒤의 배경은 보조기술 트리에서 가려지므로(`accessibilityViewIsModal`) 숨은 원소까지 찾는다.
    fireEvent.press(screen.getByTestId('channel-sheet-backdrop', {includeHiddenElements: true}));
    expect(screen.queryByTestId('channel-action-sheet')).toBeNull();
  });
});

describe('항목이 서버에 닿는다', () => {
  it('읽음 처리: 최신 seq 를 explicit_open 으로 광고하고 시트가 닫힌다', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-mark-read'));
    await waitFor(() => expect(calls.filter(call => call.url.includes('/read-state'))).toHaveLength(1));
    const put = calls.find(call => call.url.includes('/read-state'))!;
    expect(put.method).toBe('PUT');
    expect(put.url).toContain('/channels/ch-general/read-state');
    expect(put.body).toEqual({last_read_seq: 15, read_intent: 'explicit_open'});
    await waitFor(() => expect(screen.queryByTestId('channel-action-sheet')).toBeNull());
  });

  it('읽지 않음으로 표시: 읽음 커서는 그대로, 마크는 최신 seq, 판별자는 없다', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-quiet');
    fireEvent.press(screen.getByTestId('channel-sheet-mark-unread'));
    await waitFor(() => expect(calls.some(call => call.url.includes('/read-state'))).toBe(true));
    const put = calls.find(call => call.url.includes('/read-state'))!;
    expect(put.body).toEqual({last_read_seq: 7, mark_unread_before_seq: 7});
    expect(put.body).not.toHaveProperty('read_intent');
  });

  it('읽음 실패: 시트가 열린 채 그 자리에서 이유를 말한다', async () => {
    await mount({readPutStatus: 500});
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-mark-read'));
    await waitFor(() => expect(screen.getByTestId('channel-sheet-error')).toBeTruthy());
    expect(screen.getByTestId('channel-action-sheet')).toBeTruthy();
  });

  it('알림 끄기: notification-pref 에 muted:true, 그다음 채널 목록을 다시 읽는다', async () => {
    await mount();
    const before = channelListFetches;
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-mute-toggle'));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/notification-pref'))).toBe(true));
    const put = calls.find(call => call.url.endsWith('/notification-pref'))!;
    expect(put.url).toContain('/channels/ch-general/notification-pref');
    expect(put.body).toEqual({muted: true});
    await waitFor(() => expect(channelListFetches).toBeGreaterThan(before));
  });

  it('알림 켜기: 이미 껐으면 muted:false', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-quiet');
    fireEvent.press(screen.getByTestId('channel-sheet-mute-toggle'));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/notification-pref'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/notification-pref'))!.body).toEqual({muted: false});
  });

  it('복사: ID 는 채널 id, 이름은 행의 이름, 링크는 웹과 같은 모양', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-copy-id'));
    await flush();
    expect(clipboard.__box.value).toBe('ch-general');
    // 영수증: 낱말이 「복사됨」으로 뒤집힌다.
    expect(screen.getByTestId('channel-sheet-copy-id')).toHaveTextContent('ID 복사됨');

    fireEvent.press(screen.getByTestId('channel-sheet-copy-name'));
    await flush();
    expect(clipboard.__box.value).toBe('general');

    fireEvent.press(screen.getByTestId('channel-sheet-copy-link'));
    await flush();
    expect(clipboard.__box.value).toBe(`${BASE}/#/c/ch-general`);
  });
});

describe('채널 나가기는 확인 단계를 지난다', () => {
  it('누르면 DELETE 가 아니라 확인이 먼저다', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-leave'));
    expect(screen.getByTestId('channel-leave-confirm')).toBeTruthy();
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    // 취소하면 항목 목록으로 돌아온다.
    fireEvent.press(screen.getByTestId('channel-leave-cancel'));
    expect(screen.queryByTestId('channel-leave-confirm')).toBeNull();
    expect(sheetKeys()).toContain('leave');
  });

  it('확인하면 내 멤버십을 지우고, 서버가 답한 뒤에 시트가 닫힌다', async () => {
    await mount();
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-leave'));
    fireEvent.press(screen.getByTestId('channel-leave-confirm-button'));
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE')).toBe(true));
    const del = calls.find(call => call.method === 'DELETE')!;
    expect(del.url).toContain(`/channels/ch-general/members/${SELF_ID}`);
    await waitFor(() => expect(screen.queryByTestId('channel-action-sheet')).toBeNull());
  });

  it('403: 확인 단계가 그대로 서서 이유를 말한다 — 시트가 사라지지 않는다', async () => {
    await mount({leaveStatus: 403});
    longPress('sidebar-row-channel:ch-general');
    fireEvent.press(screen.getByTestId('channel-sheet-leave'));
    fireEvent.press(screen.getByTestId('channel-leave-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('channel-leave-error')).toBeTruthy());
    expect(screen.getByTestId('channel-leave-error')).toHaveTextContent(/나갈 권한이 없습니다/);
    expect(screen.getByTestId('channel-leave-confirm')).toBeTruthy();
  });
});

describe('VoiceOver 로터는 시트와 같은 항목이다', () => {
  it('행의 사용자 동작 이름·낱말이 시트의 항목과 같고, 같은 일을 한다', async () => {
    await mount();
    const row = screen.getByTestId('sidebar-row-channel:ch-general');
    const actions = row.props.accessibilityActions as {name: string; label: string}[];
    longPress('sidebar-row-channel:ch-general');
    const sheetLabels = sheetKeys().map(
      key => screen.getByTestId(`channel-sheet-${key}`).props.accessibilityLabel,
    );
    expect(actions.map(action => action.label)).toEqual(sheetLabels);
    fireEvent.press(screen.getByTestId('channel-sheet-close'));

    // 로터로 알림 끄기 — 시트를 열지 않고 같은 PUT 이 나간다.
    fireEvent(row, 'accessibilityAction', {nativeEvent: {actionName: 'momoChannel:mute'}});
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/notification-pref'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/notification-pref'))!.body).toEqual({muted: true});
  });

  it('로터의 나가기도 확인 단계로 간다 — 시트가 열려 확인을 보인다', async () => {
    await mount();
    const row = screen.getByTestId('sidebar-row-channel:ch-general');
    fireEvent(row, 'accessibilityAction', {nativeEvent: {actionName: 'momoChannel:leave'}});
    expect(screen.getByTestId('channel-leave-confirm')).toBeTruthy();
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });

  it('에이전트 줄에는 로터 동작이 없다', async () => {
    await mount();
    const row = screen.getByTestId(`sidebar-row-agent:${HERMES_ID}`);
    expect(row.props.accessibilityActions).toBeUndefined();
  });
});

// 이 파일이 잘못 이름으로 묶이지 않았는지 — 섹션 메뉴(⋯)는 그대로다.
it('섹션 메뉴의 낱말은 그대로다', () => {
  expect(AGENT_LIST_ACTION).toBe('에이전트 목록');
});
