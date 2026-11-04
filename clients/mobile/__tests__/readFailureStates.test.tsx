import NetInfo from '@react-native-community/netinfo';
import type {Member} from '@momo/core/lib/api';
import {CONNECTION_KEYS} from '@momo/core/features/connection/copyKeys';
import {copyForCause} from '@momo/core/features/connection/model';
import {HEALED_MS} from '@momo/core/features/connection/thresholds';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import {onlineManager, QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  ConnectionProvider,
  NO_FEED,
  useConnection,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import AgentsScreen from '../src/screens/AgentsScreen';
import SidebarScreen from '../src/screens/SidebarScreen';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 읽기가 실패해도 받아 둔 내용은 지우지 않는다 - 홈 · 에이전트 목록 (#5285, 검증 5a 수리 ⑤, #5242 웹 규칙의 폰판).
//
// 검증 줄이 라이브 스택에서 api 만 내렸을 때 본 것: 띠(「서버에 닿지 못했어요」) 아래에서 홈은 받아 둔 채널 목록이 비고 합쇼체 오류로 바뀌었고, 에이전트
// 화면은 띠 + 사용량 카드 오류 + 목록 오류가 같은 원인을 세 겹으로 되풀이했다. 이 파일은 그 장면을 **진짜 연결 모델**(코어 리듀서)과 **진짜 띠** 위에서
// 원인 셋(서버에 닿지 못함 · 기기 오프라인 · 실시간만 끊김) × 받아 둔 것 있음/없음으로 잰다.
//
//   · 받아 둔 것 있음: 목록은 그대로. 띠가 같은 원인을 말하면 아무것도 더하지 않고, 띠가 침묵이면(서버가 직접 답한 오류) 목록 위 한 줄(제목 + 다시 시도).
//   · 받아 둔 것 없음: 상자(제목 + 다시 시도). 이유 문장(코어 `copyForCause`)은 **띠가 같은 원인을 말하지 않을 때만** 붙는다 - 말하면 되풀이다.
//
// 원인은 장면을 손으로 적지 않고 입력(fetch 가 던지거나 500 으로 답함 · NetInfo · 소켓 사건)으로 짓는다. 문장은 사전에서 읽는다(사전이 바뀌어도 따라간다).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};
const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};

const say = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage;

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
  rosterMember({id: AGENT_ID, kind: 'agent', displayName: '김인턴', handle: 'kim-intern', callableBy: 'everyone'}),
];
const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-lab', workspaceId: WS, kind: 'public', name: 'agent-lab', muted: false},
];
const METRICS = {
  runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 0,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 1, source: 'self_reported',
};
const USAGE = {
  range: {from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z', bucket: 'day'},
  agents: [{...METRICS, agentMemberId: AGENT_ID}],
  totals: {mine: METRICS, shared: METRICS},
  hiddenPersonalAgents: 3,
};

function jsonResponse(status: number, body: unknown): Response {
  return {status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)} as unknown as Response;
}

/**
 * 서버의 모습. `ok` 는 정상, `network` 는 응답 없이 끝남(서버가 내려갔다 - 요청마다 던진다), `answers500` 은 서버가 닿았고 직접 오류로 답함.
 * 한 요청이라도 응답하면 「서버에 닿지 못함」 연속이 끊기므로, 서버에 닿지 못함 장면은 모든 요청이 던져야 한다.
 */
type Server = 'ok' | 'network' | 'answers500';
let server: Server = 'ok';

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (server === 'network') throw new TypeError('Network request failed');
    if (server === 'answers500') return jsonResponse(500, {error: {message: 'boom'}});
    const path = new URL(url).pathname;
    if (/\/channels$/.test(path)) return jsonResponse(200, {channels: CHANNELS});
    if (/\/roster$/.test(path)) return jsonResponse(200, {members: ROSTER});
    if (/\/read-state$/.test(path)) return jsonResponse(200, {read_states: []});
    if (/\/usage\/agents$/.test(path)) return jsonResponse(200, USAGE);
    if (/\/work-sessions$/.test(path)) return jsonResponse(200, {workSessions: []});
    // 이 시험이 다루지 않는 읽기는 서버가 답한 것(404)으로 둔다 - 던지면 응답 없는 실패로 세어 「서버에 닿지 못함」을 잘못 세운다.
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
let queryClient: QueryClient | null = null;
let releaseMotion: (() => void) | null = null;
const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};

beforeEach(async () => {
  server = 'ok';
  releaseMotion = await pinReduceMotion(false);
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  releaseMotion?.();
  releaseMotion = null;
  onlineManager.setOnline(true);
  fakeClock = false;
  jest.useRealTimers();
});

/**
 * 연결 모델이 지금 무엇을 말하는가를 화면 밖으로 내보이는 탐침. 입력(fetch 가 던짐 · NetInfo · 소켓 사건)이 **정말 그 원인을 만들었는지** 단정하는 데 쓴다: 실시간만 끊김은
 * 홈·에이전트에 띠가 서지 않아서, 「띠가 없다」만 보면 아무 입력도 먹이지 않은 건강한 상태와 구별되지 않는다.
 */
function ModelProbe() {
  const connection = useConnection();
  return <Text testID="model-phase">{connection === null ? 'none' : `${connection.view.phase}:${connection.view.cause ?? '-'}`}</Text>;
}
const expectModel = (label: string) => waitFor(() => expect(screen.getByTestId('model-phase')).toHaveTextContent(label));

/** 화면을 진짜 연결 공급자(코어 모델) 아래에 단독으로 세운다. 소켓은 시험이 `feedRef` 로 움직인다. */
function mount(ui: React.ReactElement) {
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}, mutations: {retry: false}}});
  return render(
    <QueryClientProvider client={queryClient}>
      <RealtimeContext.Provider
        value={{rail: null, status: 'connected', subscriptionsWanted: true, reconnect: jest.fn().mockResolvedValue(undefined)}}>
        <SessionProvider member={SELF}>
          <ConnectionProvider feedRef={feedRef}>
            {ui}
            <ModelProbe />
          </ConnectionProvider>
        </SessionProvider>
      </RealtimeContext.Provider>
    </QueryClientProvider>,
  );
}

const home = () => (
  <SidebarScreen openChannelId={null} onOpenConversation={() => {}} onOpenSearch={() => {}} />
);
const agents = () => <AgentsScreen onOpenAgent={() => {}} onOpenHostedList={() => {}} />;

const emitNet = (online: boolean) =>
  act(() => netInfo.__emit({isConnected: online, isInternetReachable: online}));

/** 가짜 시계를 쓰는 시험인가(실시간만 끊김은 소켓이 10초 넘게 끊겨야 해서 시계를 돌린다). 그때는 기다리는 동안 시계를 함께 돌려야 요청이 끝난다. */
let fakeClock = false;
const useFakeClock = () => {
  fakeClock = true;
  jest.useFakeTimers();
};

/** 서버가 응답 없이 끝나는 동안 화면이 다시 읽도록 시킨다(받아 둔 것이 있으면 실패해도 `data` 가 남는 그 상태). */
const refetchAll = () =>
  act(async () => {
    const pending = queryClient?.invalidateQueries();
    if (fakeClock) await jest.advanceTimersByTimeAsync(5000);
    await pending;
  });

/** 원인 셋. 각 원인이 되는 **입력**을 짓는다(띠의 문장은 코어 모델이 고른다). */
type Cause = 'unreachable' | 'offline' | 'realtime';
const CAUSES: Array<{
  cause: Cause;
  /** 코어 연결 모델이 그 입력으로 내놓아야 하는 모습(`phase:cause`). */
  model: string;
  strip: string | null;
  reason: 'loadReasonServer' | 'loadReasonOffline' | 'loadReasonUnknown';
}> = [
  {cause: 'unreachable', model: 'down:serverUnreachable', strip: '서버에 닿지 못했어요', reason: 'loadReasonServer'},
  {cause: 'offline', model: 'down:deviceOffline', strip: '오프라인이에요', reason: 'loadReasonOffline'},
  {cause: 'realtime', model: 'down:realtimeDown', strip: null, reason: 'loadReasonUnknown'},
];

/**
 * 이 원인이 되는 **입력**을 짓는다. 서버의 모습은 화면을 세우기 전에 정해도 되지만(`prepare`), NetInfo·소켓 사건은 공급자가 서 있어야 받으므로 세운 뒤에 먹인다(`engage`).
 * 실시간만 끊김은 소켓이 붙었다가 10초 넘게 끊겨야 해서 가짜 시계가 필요하다(시험이 `jest.useFakeTimers()` 를 먼저 부른다).
 */
function prepare(cause: Cause) {
  // 서버에 닿지 못함·기기 오프라인: 요청이 응답 없이 끝난다. 실시간만 끊김: 서버에는 닿고 읽기는 서버가 직접 오류로 답한다.
  server = cause === 'realtime' ? 'answers500' : 'network';
}
async function engage(cause: Cause) {
  if (cause === 'offline') await emitNet(false);
  if (cause === 'realtime') {
    await act(async () => {
      feedRef.current({kind: 'raw', status: 'connected'});
      await jest.advanceTimersByTimeAsync(HEALED_MS + 100);
      feedRef.current({kind: 'raw', status: 'connecting'});
      await jest.advanceTimersByTimeAsync(60_000);
    });
  }
}

const settle = () => act(async () => void (await jest.advanceTimersByTimeAsync(100)));

/** 이 읽기가 **실제로 실패했고 받아 둔 `data` 는 남았다**: 실패를 기다리지 않고 「오류 상자가 없다」를 단정하면 아무것도 재지 못한다. */
const expectFailedKeepingData = (key: readonly unknown[]) =>
  waitFor(() => {
    const state = queryClient?.getQueryState(key);
    expect(state?.status).toBe('error');
    expect(state?.data).toBeDefined();
  });

/** 화면 전체에서 이 문장을 담은 글이 몇 곳인가(띠와 상자가 같은 원인을 되풀이하면 둘 이상). */
const countText = (pattern: RegExp) => screen.queryAllByText(pattern).length;
/** 합쇼체 오류 문장·핵심 낱말 이전 문구가 남지 않았다(이 화면은 해요체다). */
const noOldCopy = () => {
  expect(screen.queryByText(/불러오지 못했습니다/)).toBeNull();
  expect(screen.queryByText(/주소와 네트워크를 확인/)).toBeNull();
};

describe('홈 — 받아 둔 채널 목록', () => {
  describe.each(CAUSES)('원인: $cause', ({cause, model, strip, reason}) => {
    it('받아 둔 것이 있으면 목록은 그대로다 - 띠가 말하면 아무것도 더하지 않고, 띠가 침묵이면 목록 위 한 줄만 선다', async () => {
      if (cause === 'realtime') useFakeClock();
      mount(home());
      if (cause === 'realtime') {
        await settle();
        await act(async () => void (await jest.advanceTimersByTimeAsync(2000)));
      }
      await waitFor(() => expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy());

      prepare(cause);
      await engage(cause);
      await refetchAll();
      if (cause === 'realtime') await settle();
      await expectFailedKeepingData(['channels', WS]);
      await expectModel(model);

      // 받아 둔 목록이 남아 있다: 목록 자리가 오류 상자로 바뀌지 않았다.
      expect(screen.queryByTestId('channels-error')).toBeNull();
      expect(screen.getByTestId('sidebar-list')).toBeTruthy();
      expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy();
      noOldCopy();
      if (strip !== null) {
        // 띠가 원인을 말한다(코어 모델의 판정). 목록 위 한 줄은 같은 말을 되풀이하지 않는다.
        await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent(strip, {exact: false}));
        expect(screen.queryByTestId('channels-error-line')).toBeNull();
      } else {
        // 서버가 직접 답한 오류: 띠는 침묵이고, 목록은 그대로 두고 위에 한 줄(제목 + 다시 시도)이 선다.
        expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
        const line = screen.getByTestId('channels-error-line');
        expect(line).toHaveTextContent(say(CONNECTION_KEYS.loadChannelListTitle), {exact: false});
        expect(within(line).getByText(say(CONNECTION_KEYS.retry))).toBeTruthy();
      }
    });

    it('받아 둔 것이 없으면 상자(제목 + 다시 시도)가 서고, 이유 문장은 띠가 침묵일 때만 붙는다', async () => {
      if (cause === 'realtime') useFakeClock();
      prepare(cause);
      mount(home());
      await engage(cause);
      if (cause === 'realtime') await settle();
      const box = await screen.findByTestId('channels-error');
      await expectModel(model);

      // 코어 사전의 해요체 제목. 합쇼체 옛 문장·핵심 이전 안내(「주소와 네트워크를…」)는 남지 않는다.
      expect(within(box).getByText(say(CONNECTION_KEYS.loadChannelListTitle))).toBeTruthy();
      expect(within(box).getByText(say(CONNECTION_KEYS.retry))).toBeTruthy();
      noOldCopy();
      expect(screen.queryByTestId('sidebar-list')).toBeNull();
      // 「채널이 없다」는 거짓말도 아니다(받은 적이 없을 뿐이다).
      expect(screen.queryByTestId('channels-empty')).toBeNull();

      const reasonText = say(copyForCause(cause === 'realtime' ? null : cause === 'offline' ? 'deviceOffline' : 'serverUnreachable').loadReason);
      expect(reasonText).toBe(say(CONNECTION_KEYS[reason]));
      if (strip !== null) {
        // 띠(원인)가 같은 원인을 이미 말한다: 상자는 결과와 행동만 말한다.
        await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent(strip, {exact: false}));
        expect(within(box).queryByText(reasonText)).toBeNull();
        expect(countText(new RegExp(strip))).toBe(1);
      } else {
        // 띠는 침묵이라 상자가 이유를 말한다(서버가 직접 답한 오류 → 알 수 없는 원인의 안전 문장).
        expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
        expect(within(box).getByText(reasonText)).toBeTruthy();
      }
    });
  });

  it('다시 시도는 실제로 다시 읽고, 서버가 돌아오면 상자가 목록으로 바뀐다', async () => {
    server = 'answers500';
    mount(home());
    // 첫 읽기가 끝난 뒤의 상자에서 다시 시도를 누른다(아직 받은 데이터가 없는 읽기는 날아가는 중에 다시 부르면 그 요청에 합류한다 - 서버의 모습을 바꾸기 전에 끝나길 기다린다).
    fireEvent.press(await screen.findByTestId('channels-error-retry'));
    await waitFor(() => expect(queryClient?.isFetching()).toBe(0));
    expect(screen.getByTestId('channels-error')).toBeTruthy();
    server = 'ok';
    fireEvent.press(screen.getByTestId('channels-error-retry'));
    await waitFor(() => expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy());
    expect(screen.queryByTestId('channels-error')).toBeNull();
  });

  it('기기가 꺼져 읽기가 멈춘 채(받은 적 없음)면 「참여한 채널이 없다」가 아니라 오프라인 상자가 선다', async () => {
    // 실제 앱은 NetInfo 가 react-query 의 온라인 관리자에 이어져 있다: 꺼지면 읽기는 실패가 아니라 **멈춘다**(`fetchStatus: 'paused'`, 오류 없음).
    onlineManager.setOnline(false);
    mount(home());
    await emitNet(false);
    const box = await screen.findByTestId('channels-error');
    expect(within(box).getByText(say(CONNECTION_KEYS.loadChannelListTitle))).toBeTruthy();
    expect(screen.queryByTestId('channels-empty')).toBeNull();
    expect(screen.queryByTestId('channels-loading')).toBeNull();
    // 띠가 「오프라인이에요」를 말하고 상자는 되풀이하지 않는다.
    await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false}));
    expect(countText(/오프라인이에요/)).toBe(1);
  });

  it('읽음 표시만 실패해도 띠가 말하는 동안은 같은 원인을 되풀이하지 않는다(합쇼체 읽음 안내가 새로 서지 않는다)', async () => {
    mount(home());
    await waitFor(() => expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy());
    server = 'network';
    // 읽음 투영만 먼저 실패한다(띠는 서로 다른 요청 셋이 필요하다): 목록은 신선하고 오류가 아니므로 이 고지가 지금은 제 몫을 말한다.
    await act(async () => void (await queryClient?.invalidateQueries({queryKey: ['read-state', WS]})));
    await waitFor(() => expect(queryClient?.getQueryState(['read-state', WS])?.status).toBe('error'));
    expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('read-state-error')).toBeTruthy());
    // 채널·명부는 다시 읽지 않은 채 다른 읽기 둘이 더 실패하면 띠가 선다: 읽음 안내는 그 원인을 되풀이하지 않는다.
    await act(async () => {
      await queryClient?.invalidateQueries({predicate: query => query.queryKey[0] !== 'channels' && query.queryKey[0] !== 'roster'});
    });
    await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toBeTruthy());
    expect(queryClient?.getQueryState(['channels', WS])?.status).toBe('success');
    expect(screen.queryByTestId('read-state-error')).toBeNull();
    expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy();
  });
});

describe('에이전트 목록 — 한 겹', () => {
  const CARD = 'agent-usage-status';

  describe.each(CAUSES)('원인: $cause', ({cause, model, strip, reason}) => {
    it('받아 둔 목록·숫자는 그대로다 - 띠가 원인을 말하는 동안 사용량 카드·목록·세션 안내는 같은 말을 되풀이하지 않는다', async () => {
      if (cause === 'realtime') useFakeClock();
      mount(agents());
      if (cause === 'realtime') {
        await settle();
        await act(async () => void (await jest.advanceTimersByTimeAsync(2000)));
      }
      await waitFor(() => expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId(CARD)).toHaveTextContent('숨겨진 개인 에이전트 3개'));

      prepare(cause);
      await engage(cause);
      await refetchAll();
      if (cause === 'realtime') await settle();
      await expectFailedKeepingData(['roster', WS]);
      await expectModel(model);

      // 받아 둔 목록과 숫자(행의 사용량 줄)가 남아 있다.
      expect(screen.queryByTestId('agents-error')).toBeNull();
      expect(screen.getByTestId('agents-list')).toBeTruthy();
      expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toBeTruthy();
      expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toHaveTextContent('이번 달 비용·토큰·작업 수', {exact: false});
      noOldCopy();
      if (strip !== null) {
        await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent(strip, {exact: false}));
        // 한 겹: 원인은 띠만 말한다. 사용량 카드는 오류·다시 불러오기 없이 받아 둔 숫자 한 줄만 남고, 세션 고지·목록 한 줄도 없다.
        expect(screen.getByTestId(CARD)).toHaveTextContent('숨겨진 개인 에이전트 3개');
        expect(screen.queryByText('다시 불러오기')).toBeNull();
        expect(screen.queryByText(/이번 달 사용량을 불러오지 못했어요/)).toBeNull();
        expect(screen.queryByTestId('agent-sessions-error')).toBeNull();
        expect(screen.queryByTestId('agents-error-line')).toBeNull();
        expect(countText(new RegExp(strip))).toBe(1);
      } else {
        // 서버가 직접 답한 오류: 띠는 침묵. 명부 읽기 실패는 목록 위 한 줄(제목 + 다시 시도)로 말하고 목록은 그대로다.
        expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
        const line = screen.getByTestId('agents-error-line');
        expect(line).toHaveTextContent(say(CONNECTION_KEYS.loadAgentRosterTitle), {exact: false});
        expect(within(line).getByText(say(CONNECTION_KEYS.retry))).toBeTruthy();
      }
      expect(reason).toBeTruthy();
    });

    it('받아 둔 것이 없으면 상자(제목 + 다시 시도) 하나만 서고, 사용량 카드는 같은 말을 되풀이하지 않는다', async () => {
      if (cause === 'realtime') useFakeClock();
      prepare(cause);
      mount(agents());
      await engage(cause);
      if (cause === 'realtime') await settle();
      const box = await screen.findByTestId('agents-error');
      await expectModel(model);

      expect(within(box).getByText(say(CONNECTION_KEYS.loadAgentRosterTitle))).toBeTruthy();
      expect(within(box).getByText(say(CONNECTION_KEYS.retry))).toBeTruthy();
      noOldCopy();
      expect(screen.queryByTestId('agents-list')).toBeNull();
      expect(screen.queryByTestId('agents-empty')).toBeNull();

      const reasonText = say(CONNECTION_KEYS[reason]);
      if (strip !== null) {
        await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent(strip, {exact: false}));
        // 띠 + 상자: 원인 문장은 띠에 한 번뿐이다. 사용량 카드는 서지 않고(받아 둔 숫자가 없다), 세션 고지도 없다.
        expect(within(box).queryByText(reasonText)).toBeNull();
        expect(screen.queryByTestId(CARD)).toBeNull();
        expect(screen.queryByTestId('agent-sessions-error')).toBeNull();
        expect(countText(new RegExp(strip))).toBe(1);
      } else {
        expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
        expect(within(box).getByText(reasonText)).toBeTruthy();
      }
    });
  });

  it('기기가 꺼져 명부 읽기가 멈춘 채(받은 적 없음)면 「아직 에이전트가 없다」가 아니라 오프라인 상자가 선다', async () => {
    onlineManager.setOnline(false);
    mount(agents());
    await emitNet(false);
    const box = await screen.findByTestId('agents-error');
    expect(within(box).getByText(say(CONNECTION_KEYS.loadAgentRosterTitle))).toBeTruthy();
    expect(screen.queryByTestId('agents-empty')).toBeNull();
    expect(screen.queryByTestId('agents-loading')).toBeNull();
    expect(screen.queryByTestId(CARD)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent('오프라인이에요', {exact: false}));
    expect(countText(/오프라인이에요/)).toBe(1);
  });

  it('명부는 받았고 세션 읽기만 다른 읽기와 함께 실패해 띠가 서면 세션 고지도 같은 원인을 되풀이하지 않는다', async () => {
    mount(agents());
    await waitFor(() => expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toBeTruthy());
    server = 'network';
    // 명부는 다시 읽지 않는다(그러면 목록 쪽 고지가 세션 고지를 가린다): 세션·사용량·채널 따위만 실패해 띠가 선다.
    await act(async () => {
      await queryClient?.invalidateQueries({predicate: query => query.queryKey[0] !== 'roster'});
    });
    await waitFor(() => expect(queryClient?.getQueryState(['work-sessions', WS])?.status).toBe('error'));
    await waitFor(() => expect(screen.getByTestId('shell-connection-strip')).toHaveTextContent('서버에 닿지 못했어요', {exact: false}));
    expect(queryClient?.getQueryState(['roster', WS])?.status).toBe('success');
    expect(screen.queryByTestId('agent-sessions-error')).toBeNull();
    expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toBeTruthy();
  });

  it('띠가 침묵인 채 세션 읽기만 실패하면(서버가 직접 답한 오류) 세션 고지는 자기 몫을 말한다', async () => {
    mount(agents());
    await waitFor(() => expect(screen.getByTestId(`agent-row-${AGENT_ID}`)).toBeTruthy());
    server = 'answers500';
    await act(async () => {
      await queryClient?.invalidateQueries({queryKey: ['work-sessions', WS]});
    });
    await waitFor(() => expect(screen.getByTestId('agent-sessions-error')).toBeTruthy());
    expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
  });

  it('띠가 침묵인 채 사용량만 실패하면(서버가 직접 답한 오류) 카드는 자기 실패를 말한다 - 억제는 띠가 같은 원인을 말할 때만이다', async () => {
    mount(agents());
    await waitFor(() => expect(screen.getByTestId(CARD)).toHaveTextContent('숨겨진 개인 에이전트 3개'));
    server = 'answers500';
    await refetchAll();
    await waitFor(() => expect(screen.getByTestId(CARD)).toHaveTextContent('이번 달 사용량을 불러오지 못했어요', {exact: false}));
    expect(screen.getByText('다시 불러오기')).toBeTruthy();
    expect(screen.queryByTestId('shell-connection-strip')).toBeNull();
  });
});
