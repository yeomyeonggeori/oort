import type {Member, WorkSession} from '@momo/core/lib/api';
import {
  centrifugoChannelName,
  type WorkSessionACPFrame,
} from '@momo/core/lib/realtimeEvents';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  RealtimeContext,
  type RealtimeContextValue,
} from '../src/realtime/RealtimeProvider';
import {createChannelRail} from '../src/realtime/channelRail';
import WorkSessionDetailScreen from '../src/screens/WorkSessionDetailScreen';
import {SessionProvider} from '../src/session/useSession';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {haptics} from '../src/lib/haptics';
import {
  __resetWorkStreamTimings,
  computeStreamTiming,
  workStreamTimings,
} from '../src/features/work/workStreamTiming';

jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

let mockSurface: Record<string, unknown> = {};
jest.mock('../src/features/work/SignedWorkControls', () => ({
  ...jest.requireActual('../src/features/work/SignedWorkControls'),
  useSignedWorkSurface: () => mockSurface,
  useSigningRequired: () => false,
}));

jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(() => 1292),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const NOW = 1_786_435_200_000;
const CH = 'ch-general';
const SID = 'SESSION-APP';

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

let sessionStatus: WorkSession['status'] = 'running';

function session(): WorkSession {
  return {
    id: SID,
    workspaceId: WS,
    channelId: CH,
    memberId: SELF_ID,
    hostId: 'HOST-APP',
    rootMessageId: 'root-session-app',
    tool: 'codex',
    label: '릴레이 재시작 절차',
    status: sessionStatus,
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW,
    ...(sessionStatus === 'ended' ? {endedAtMs: NOW + 9_000} : {}),
  };
}

const HOSTS = [
  {
    id: 'HOST-APP',
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'app',
    displayName: '성재 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
];

function eventMessage(
  id: string,
  seq: number,
  type: string,
  event: Record<string, unknown>,
) {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: NOW + seq,
    hlcCount: 0,
    authorMemberId: AGENT_ID,
    type: 'system',
    body: 'DO_NOT_RENDER_MESSAGE_BODY',
    state: 'sent',
    createdAtMs: NOW + seq,
    props: {
      kind: 'work_session_event',
      schema: 'momo.work_session.acp_event.v1',
      event_type: type,
      event_id: id,
      event_ts: NOW + seq,
      event: {work_session_id: SID, event_id: id, ...event},
    },
  };
}

let durable = [
  eventMessage('EVENT-1', 1, 'agent.status', {terminal_event: 'created'}),
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let repliesDelayMs = 0;

function installFetch(): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/work-sessions')) {
      return jsonResponse(200, {workSessions: [session()]});
    }
    if (url.includes('/work-hosts')) {
      return jsonResponse(200, {workHosts: HOSTS});
    }
    if (url.includes('/replies')) {
      if (repliesDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, repliesDelayMs));
      }
      return jsonResponse(200, {messages: durable});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const count = (mock: jest.Mock, needle: string) =>
  mock.mock.calls.filter(([url]) => String(url).includes(needle)).length;

type Handlers = Parameters<
  NonNullable<RealtimeContextValue['rail']>['subscribeWorkSession']
>[2];

interface FakeRail {
  value: (wanted?: boolean) => RealtimeContextValue;
  handlers: Map<string, Handlers>;
  unsubscribed: string[];
}

function fakeRail(): FakeRail {
  const handlers = new Map<string, Handlers>();
  const unsubscribed: string[] = [];
  const rail = {
    subscribeWorkSession: (_ws: string, channelId: string, h: Handlers) => {
      handlers.set(channelId, h);
      return () => {
        unsubscribed.push(channelId);
        handlers.delete(channelId);
      };
    },
  } as unknown as RealtimeContextValue['rail'];
  return {
    value: (wanted = true) => ({
      rail,
      status: 'connected',
      subscriptionsWanted: wanted,
    }),
    handlers,
    unsubscribed,
  };
}

function partial(
  id: string,
  seq: number,
  text: string,
  sid = SID,
): WorkSessionACPFrame {
  return {
    type: 'agent.partial',
    v: 1,
    ts: NOW + seq * 1_000,
    seq,
    payload: {
      event_id: id,
      work_session_id: sid,
      run_id: 'run-1',
      channel_id: CH,
      message_id: id,
      root_message_id: 'root-session-app',
      text_delta: text,
    },
  };
}

let queryClient: QueryClient | null = null;

function tree(active: boolean, realtime: RealtimeContextValue) {
  return (
    <QueryClientProvider client={queryClient as QueryClient}>
      <SessionProvider member={SELF}>
        <RealtimeContext.Provider value={realtime}>
          <WorkSessionDetailScreen
            active={active}
            sessionId={SID}
            onBack={() => {}}
            onOpenConversation={() => {}}
          />
        </RealtimeContext.Provider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function renderDetail(active: boolean, realtime: RealtimeContextValue) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(tree(active, realtime));
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  __resetWorkStreamTimings();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  sessionStatus = 'running';
  repliesDelayMs = 0;
  durable = [
    eventMessage('EVENT-1', 1, 'agent.status', {terminal_event: 'created'}),
  ];
  jest.mocked(haptics.light).mockClear();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

async function ready(rail: FakeRail) {
  await waitFor(() =>
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /세션을 시작함/,
    ),
  );
  await waitFor(() => expect(rail.handlers.has(CH)).toBe(true));
}


function humanReply(id: string, seq: number, text: string, author: string, extra: object = {}) {
  return {
    id,
    channelId: CH,
    rootId: 'root-session-app',
    seq,
    hlcTs: NOW + seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: text,
    state: 'sent',
    createdAtMs: NOW + seq,
    ...extra,
  };
}

const instructed = (id: string, seq: number, text: string) =>
  humanReply(id, seq, text, SELF_ID, {
    props: {'momo.instruction': {work_session_id: SID, mode: 'queue', control_id: 'c1'}},
  });

function openChat() {
  fireEvent.press(screen.getByTestId('work-mode-chat'));
}

const instruct = jest.fn();

beforeEach(() => {
  instruct.mockReset();
  mockSurface = {
    owner: true,
    flag: 'required',
    required: true,
    block: null,
    actions: {instruct},
    permission: null,
    preview: {state: 'loading'},
    fallbackReject: null,
  };
});

describe('작업 상세 「대화」 모드 (N3 #3595)', () => {
  it('상세에서 대화로 바꾸면 지시와 답이 시간순 말풍선으로 선다', async () => {
    durable = [
      ...durable,
      eventMessage('P-1', 2, 'agent.partial', {text_delta: '읽어 볼게요'}),
      instructed('R-1', 3, '테스트부터 돌려 줘') as never,
      eventMessage('P-2', 4, 'agent.partial', {text_delta: '돌렸어요'}),
    ];
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getByTestId('work-chat-mine')).toBeTruthy());
    const order = screen
      .getAllByTestId(/^work-chat-(mine|agent|system)$/)
      .map(node => node.props.testID as string);
    expect(order).toEqual(['work-chat-system', 'work-chat-agent', 'work-chat-mine', 'work-chat-agent']);
    // 상세의 진행 내역 목록은 대화 모드에서 그려지지 않는다.
    expect(screen.queryByTestId('work-detail-event-list')).toBeNull();
    // 같은 화면 안의 보기 전환이다: 별도 화면의 제목이 새로 생기지 않는다.
    expect(screen.getAllByTestId('work-detail-title')).toHaveLength(1);
  });

  it('실시간 조각은 같은 말풍선에 붙고 새 말풍선을 만들지 않는다', async () => {
    durable = [...durable, eventMessage('P-1', 2, 'agent.partial', {text_delta: '안녕'})];
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getAllByTestId('work-chat-agent')).toHaveLength(1));
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-2', 3, '하세요')));
    await waitFor(() =>
      expect(screen.getByTestId('work-chat-agent')).toHaveTextContent('안녕하세요'),
    );
    expect(screen.getAllByTestId('work-chat-agent')).toHaveLength(1);
    expect(screen.getByTestId('work-chat-writing')).toBeTruthy();
    // 답이 도착하는 동안 햅틱은 없다.
    expect(haptics.light).not.toHaveBeenCalled();
  });

  it('보내면 내 말풍선이 바로 서고, 읽기가 따라오면 한 개만 남는다', async () => {
    installFetch();
    instruct.mockResolvedValue({state: 'sent'});
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getByTestId('work-chat-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '이것도 봐 줘');
    // 서버는 같은 트랜잭션으로 스레드에 남긴다 - 다음 읽기에 올라온다.
    durable = [...durable, instructed('R-9', 5, '이것도 봐 줘') as never];
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    expect(instruct).toHaveBeenCalledWith('이것도 봐 줘', 'queue');
    expect(haptics.light).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByTestId('work-chat-mine')).toHaveLength(1));
    expect(screen.getByTestId('work-chat-input').props.value).toBe('');
    // 읽기가 이미 같은 글을 담았으므로 낙관 말풍선이 한 번 더 서지 않는다.
    await act(async () => {});
    expect(screen.getAllByTestId('work-chat-mine')).toHaveLength(1);
  });

  it('전달 안 됨이면 말풍선이 사라지고 글이 입력창으로 돌아온다', async () => {
    installFetch();
    instruct.mockResolvedValue({
      state: 'not_delivered',
      stage: 'server',
      text: '맥이 꺼져 있어요',
      error: new Error('x'),
    });
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getByTestId('work-chat-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('work-chat-input'), '보내지 못한 말');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-chat-send'));
    });
    expect(screen.queryByTestId('work-chat-mine')).toBeNull();
    expect(screen.getByTestId('work-chat-input').props.value).toBe('보내지 못한 말');
    expect(screen.getByTestId('work-chat-failure')).toHaveTextContent(
      '전달 안 됨 · 맥이 꺼져 있어요',
    );
  });

  it('서명 요구가 꺼진 서버에서는 안내가 나오고 허락 카드는 그려지지 않는다', async () => {
    mockSurface = {...mockSurface, flag: 'off', required: false, actions: null};
    durable = [...durable, eventMessage('A-1', 2, 'approval.requested', {action: 'run'})];
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getByTestId('work-chat-notice')).toBeTruthy());
    expect(screen.getByTestId('work-chat-notice')).toHaveTextContent(/서명된 지시를 받지 않아요/);
    expect(screen.queryByTestId('work-chat-permission')).toBeNull();
    expect(screen.getByTestId('work-chat-input').props.editable).toBe(false);
  });

  it('대화 보기에서 상세로 돌아와도 같은 세션이다', async () => {
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    openChat();
    await waitFor(() => expect(screen.getByTestId('work-chat-input')).toBeTruthy());
    fireEvent.press(screen.getByTestId('work-mode-detail'));
    await waitFor(() => expect(screen.getByTestId('work-detail-event-list')).toBeTruthy());
  });
});
