import NetInfo from '@react-native-community/netinfo';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AgentsScreen from '../src/screens/AgentsScreen';
import {SessionProvider} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {HEALED_MS} from '@momo/core/features/connection/thresholds';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 셸 띠가 홈 · 받은함 · 에이전트 목록 위에 **실제로** 서는가 (#5222, #5201 결정 ②).
//
// 규칙(무엇이 셸 띠를 세우나)은 코어 `shellStrip.test.ts` 와 `connectionProvider.test.tsx` 가 잰다. 이 파일은 배선만 잰다: 세 화면이 각자 띠를 그리는지,
// 한 화면이 같은 원인을 두 줄로 되풀이하지 않는지. 홈 · 받은함은 진짜 `AppShell`(공급자 사슬 포함)로, 에이전트 목록은 같은 공급자 아래 단독으로 세운다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';
const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};
const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};

function jsonResponse(status: number, body: unknown): Response {
  return {status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)} as unknown as Response;
}

/** 대화에 보낸 글(POST …/messages)의 본문과 멱등 키를 순서대로 모은다 - 「모두 다시 보내기」가 같은 키로 한 번씩 보내는지 잰다. */
const sent: Array<{clientMsgId: string; body: string}> = [];
let sendMode: 'network' | 'ok' = 'ok';

function installFetch(down: RegExp | null = null): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (down?.test(url)) throw new TypeError('Network request failed');
    if (init?.method === 'POST' && url.includes('/messages') && !url.includes('/reactions')) {
      const body = JSON.parse(String(init.body)) as {client_msg_id?: string; clientMsgId?: string; body: string};
      sent.push({clientMsgId: body.client_msg_id ?? body.clientMsgId ?? '', body: body.body});
      if (sendMode === 'network') throw new TypeError('Network request failed');
      return jsonResponse(200, {
        id: `server-${sent.length}`,
        channelId: 'ch-general',
        seq: 100 + sent.length,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: SELF_ID,
        type: 'text',
        body: body.body,
        state: 'sent',
        createdAtMs: 1,
      });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (/\/inbox(\/|$)/.test(new URL(url).pathname)) return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}]});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    // 이 시험이 다루지 않는 읽기는 서버가 답한 것(404)으로 둔다 - 던지면 응답 없는 실패로 세어 「서버에 닿지 못함」을 잘못 세운다.
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
let queryClient: QueryClient | null = null;
let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  sent.length = 0;
  sendMode = 'ok';
  releaseMotion = await pinReduceMotion(false);
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  releaseMotion?.();
  releaseMotion = null;
});

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

const active = () => within(screen.getByTestId('tab-pane-active'));
const emitNet = (online: boolean) =>
  act(() => netInfo.__emit({isConnected: online, isInternetReachable: online}));

describe('홈 · 받은함 (진짜 AppShell)', () => {
  it('기기 오프라인이면 홈에 띠가 서고, 받은함에도 같은 띠가 선다 - 받은함의 낡음 줄은 원인을 되풀이하지 않는다. 돌아오면 둘 다 걷힌다', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(active().queryByTestId('shell-connection-strip')).toBeNull();

    await emitNet(false);
    expect(active().getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false});

    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(active().getByTestId('inbox-empty')).toBeTruthy());
    expect(active().getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false});
    // 받은함의 한 줄은 「무엇이 얼마나 낡았나」만 말한다: 원인(오프라인)은 위 띠가 이미 말했다.
    const stale = active().getByTestId('inbox-offline');
    expect(stale).toHaveTextContent(/한 번도 받지 못했어요|마지막 동기화/);
    expect(stale).not.toHaveTextContent('오프라인');

    await emitNet(true);
    expect(active().queryByTestId('shell-connection-strip')).toBeNull();
    expect(active().queryByTestId('inbox-offline')).toBeNull();
  });

  it('받은함을 한 번도 받지 못한 채 오프라인이면 그 사실을 말하고, 원인(오프라인)은 위 띠만 말한다', async () => {
    // 서버가 처음부터 답하지 않는 기기: 목록이 한 번도 불러와진 적이 없어 「마지막 동기화」를 말할 시각이 없다.
    installFetch(/./);
    renderShell();
    await emitNet(false);
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(active().getByTestId('inbox-offline')).toBeTruthy());
    expect(active().getByTestId('inbox-offline')).toHaveTextContent('아직 이 목록을 한 번도 받지 못했어요.');
    expect(active().getByTestId('inbox-offline')).not.toHaveTextContent('오프라인');
    expect(active().getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false});
  });

  it('서버에 닿지 못하면(서로 다른 요청 셋이 응답 없이 실패) 홈에 띠가 서고, 「지금 다시 연결」이 있다', async () => {
    // 서버가 내려갔다: 모든 요청이 응답 없이 끝난다(한 건이라도 응답하면 연속이 끊긴다).
    installFetch(/./);
    renderShell();
    await waitFor(() => expect(active().getByTestId('shell-connection-strip')).toBeTruthy());
    const strip = active().getByTestId('shell-connection-strip');
    expect(strip).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    expect(strip.props.accessibilityRole).toBe('button');
    expect(strip.props.accessibilityLabel).toBe('지금 다시 연결');
  });
});

describe('셸 띠 낭독 (진짜 AppShell, #5262)', () => {
  it('홈 · 받은함 띠가 함께 마운트돼 있어도 오프라인이 되는 순간 VoiceOver 가 한 번 읽는다 - 띠마다가 아니라 셸에 하나다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    announce.mockClear();

    await emitNet(false);
    // 숨은 받은함 탭도 언마운트가 아니라서 띠가 둘 이상 서 있다 - 그래도 낭독은 한 번이다.
    expect(
      screen.getAllByTestId('shell-connection-strip', {includeHiddenElements: true}).length,
    ).toBeGreaterThanOrEqual(2);
    const spoken = announce.mock.calls
      .map(call => String(call[0]))
      .filter(text => text.includes('오프라인이에요'));
    expect(spoken).toEqual(['오프라인이에요. 받아 둔 내용만 보여요. 연결되면 자동으로 이어져요.']);
  });
});

describe('대화 화면 (진짜 AppShell): 보내지 못한 글 여럿', () => {
  it('실패가 둘 이상이면 단추 하나 · 줄마다 이유 한 줄 - 누르면 같은 멱등 키로 한 번씩 보내고 모두 사라진다', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeTruthy());

    // 서버에 닿지 못하는 동안 두 글을 보낸다.
    sendMode = 'network';
    for (const text of ['첫째 글', '둘째 글']) {
      fireEvent.changeText(screen.getByTestId('composer-input'), text);
      fireEvent.press(screen.getByTestId('composer-send'));
      await waitFor(() => expect(sent.map(row => row.body)).toContain(text));
    }
    await waitFor(() => expect(screen.getAllByTestId('pending-failed-reason')).toHaveLength(2));
    // 이유는 줄마다 한 문장: 서버에 닿지 못했다(상태 코드·서버 원문 없음). 단추는 하나.
    for (const reason of screen.getAllByTestId('pending-failed-reason')) {
      expect(reason).toHaveTextContent('서버에 닿지 못해 보내지 못했어요');
    }
    expect(screen.getAllByTestId('resend-all')).toHaveLength(1);
    expect(screen.getByTestId('resend-all').props.accessibilityLabel).toBe('2개 모두 다시 보내기');
    // 글마다 멱등 키가 하나다(첫 실패 사이에 서버 응답 신호가 끼면 저절로 다시 보내므로 같은 키가 더 보일 수 있다 - 처음 나온 순서로 센다).
    const firstKeys = [...new Set(sent.map(row => row.clientMsgId))];
    expect(firstKeys).toHaveLength(2);

    // 서버가 돌아왔다. 한 번 눌러 둘 다 같은 키로 보낸다 - 새 키는 한 번도 나오지 않는다.
    sendMode = 'ok';
    sent.length = 0;
    fireEvent.press(screen.getByTestId('resend-all'));
    await waitFor(() => expect(new Set(sent.map(row => row.clientMsgId)).size).toBe(2));
    expect([...new Set(sent.map(row => row.clientMsgId))].sort()).toEqual([...firstKeys].sort());
    expect(new Set(sent.map(row => row.body))).toEqual(new Set(['첫째 글', '둘째 글']));
    await waitFor(() => expect(screen.queryByTestId('pending-failed-reason')).toBeNull());
    expect(screen.queryByTestId('resend-all')).toBeNull();
  });
});

describe('에이전트 목록 (같은 공급자 아래 단독)', () => {
  const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};
  const mountAgents = (status: 'connected' | 'disconnected') => {
    queryClient = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
    return render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext.Provider value={{rail: null, status, subscriptionsWanted: true, reconnect: jest.fn().mockResolvedValue(undefined)}}>
          <SessionProvider member={SELF}>
            <ConnectionProvider feedRef={feedRef}>
              <AgentsScreen onOpenAgent={() => {}} onOpenHostedList={() => {}} />
            </ConnectionProvider>
          </SessionProvider>
        </RealtimeContext.Provider>
      </QueryClientProvider>,
    );
  };

  it('기기 오프라인이면 목록 위에 띠가 서고 실시간 낡음 줄도 함께 서며, 돌아오면 띠가 걷힌다', async () => {
    installFetch();
    mountAgents('disconnected');
    await act(async () => feedRef.current({kind: 'raw', status: 'connected'}));
    expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
    await emitNet(false);
    expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false});
    // 이 화면의 낡음 줄은 「결과」(진행이 낡았을 수 있다)를, 띠는 「원인」을 말한다 - 서로를 되풀이하지 않는다.
    expect(screen.getByTestId('agents-offline')).toBeTruthy();
    await emitNet(true);
    expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
  });

  it('실시간만 끊기면(기기·서버는 정상) 목록에 띠가 서지 않는다 - 이 화면의 낡음 줄만 있다', async () => {
    jest.useFakeTimers();
    try {
      installFetch();
      mountAgents('disconnected');
      await act(async () => {
        feedRef.current({kind: 'raw', status: 'connected'});
        await jest.advanceTimersByTimeAsync(HEALED_MS + 100);
        feedRef.current({kind: 'raw', status: 'connecting'});
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
      expect(screen.getByTestId('agents-offline')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
