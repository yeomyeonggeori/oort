import type {Member, SharedWorkSession} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
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
import {AppState, Linking, StyleSheet, TextInput} from 'react-native';
import type {Centrifuge} from 'centrifuge';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {lightPalette, darkPalette, TOUCH_TARGET} from '../src/design/tokens';
import {createChannelRail} from '../src/realtime/channelRail';
import {
  RealtimeContext,
  type RealtimeContextValue,
} from '../src/realtime/RealtimeProvider';
import TeamBoardScreen from '../src/screens/TeamBoardScreen';
import {SessionProvider} from '../src/session/useSession';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// 「작업」 팀 보드 한 열 판 (#2864). 이 시험은 화면 단위다: 서버가 걸러 준 줄만 그리고,
// 상태 순서로 서고, 「내 것」은 주인이 나인 줄이고, 시트는 읽기 전용이다.

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const CH_A = 'cccccccc-0000-4000-8000-00000000000a';
const CH_B = 'cccccccc-0000-4000-8000-00000000000b';
const BASE = 'https://api.example.com';

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

function row(
  over: Partial<SharedWorkSession> & {sessionId: string},
): SharedWorkSession {
  const now = Date.now();
  return {
    origin: 'local_pty',
    label: '작업',
    folderLabel: 'oort',
    status: 'running',
    owner: {memberId: SELF_ID, displayName: '곽성재'},
    homeChannel: {id: CH_A, name: 'workbench'},
    startedAtMs: now - 3_600_000,
    endedAtMs: null,
    sharedAtMs: now - 3_000_000,
    repo: 'oort',
    branch: 'feat/2774-xterm',
    harness: 'claude',
    state: 'running',
    stages: [],
    diff: {
      added: null,
      deleted: null,
      files: null,
      ahead: null,
      behind: null,
      uncommitted: null,
    },
    prUrl: null,
    lastActivityAt: Math.floor((now - 60_000) / 1000),
    ...over,
  };
}

// 서버 순서(최신순)가 일부러 요구 순서(응답 필요 → 실행 중 → 검토 대기)와 어긋나게 둔다.
const ROWS: SharedWorkSession[] = [
  row({sessionId: 'S-REVIEW', label: '검토 대기 세션', state: 'review', owner: {memberId: OTHER_ID, displayName: '김인턴'}, homeChannel: {id: CH_B, name: 'agent-lab'}}),
  row({sessionId: 'S-RUN-OTHER', label: '남의 실행 세션', state: 'running', owner: {memberId: OTHER_ID, displayName: '김인턴'}}),
  row({sessionId: 'S-RUN-AGENT', label: '내가 시킨 에이전트 세션', origin: 'host', folderLabel: null, repo: null, branch: null, state: 'running', homeChannel: {id: CH_B, name: 'agent-lab'}}),
  row({
    sessionId: 'S-WAIT',
    label: '응답이 필요한 세션',
    state: 'waiting',
    stages: ['세션 시작', '작업 중', '실행 허락 기다림'],
    diff: {added: 128, deleted: 40, files: 9, ahead: 2, behind: 0, uncommitted: 1},
    prUrl: 'https://github.com/yeomyeonggeori/oort/pull/2851',
  }),
  row({sessionId: 'S-DONE', label: '오늘 끝난 세션', state: 'done', status: 'ended', endedAtMs: Date.now() - 600_000}),
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Routes {
  shared?: () => Response | Promise<Response>;
  single?: () => Response | Promise<Response>;
}

/** 원장(`/work-sessions`)에는 보드가 절대 보면 안 되는 줄이 있다. */
const LEDGER_ONLY_LABEL = 'LEDGER_ONLY_UNSHARED_SESSION';

function installFetch(routes: Routes = {}): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/work-sessions\/[^/?]+\/shared/.test(url)) {
      return routes.single
        ? routes.single()
        : jsonResponse(404, {error: {message: 'gone'}});
    }
    if (url.includes('/work-sessions/shared')) {
      return routes.shared
        ? routes.shared()
        : jsonResponse(200, {sessions: ROWS, nextCursor: null});
    }
    if (url.includes('/work-sessions')) {
      return jsonResponse(200, {
        workSessions: [{id: 'LEDGER-1', label: LEDGER_ONLY_LABEL}],
      });
    }
    if (url.includes('/channels')) return jsonResponse(200, {channels: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const sharedReads = (mock: jest.Mock) =>
  mock.mock.calls.filter(([url]) =>
    /\/work-sessions\/shared(\?|$)/.test(String(url)),
  ).length;

let queryClient: QueryClient | null = null;

/** `AppState` 전이를 손으로 낸다(RN jest mock 은 emit 이 없다). 렌더 전에 건다. */
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

interface FakeRail {
  value: RealtimeContextValue;
  signals: Map<string, () => void>;
  unsubscribed: string[];
}

function fakeRail(): FakeRail {
  const signals = new Map<string, () => void>();
  const unsubscribed: string[] = [];
  const rail = {
    subscribeWorkBoard: (
      _ws: string,
      channelId: string,
      handlers: {onSignal: () => void},
    ) => {
      signals.set(channelId, handlers.onSignal);
      return () => {
        unsubscribed.push(channelId);
        signals.delete(channelId);
      };
    },
  } as unknown as RealtimeContextValue['rail'];
  return {
    value: {rail, status: 'connected', subscriptionsWanted: true},
    signals,
    unsubscribed,
  };
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof TeamBoardScreen>> = {},
  realtime?: RealtimeContextValue,
): ReturnType<typeof render> {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider member={SELF}>
        <RealtimeContext.Provider
          value={
            realtime ?? {rail: null, status: 'connecting', subscriptionsWanted: false}
          }>
          <TeamBoardScreen
            active
            onOpenConversation={() => {}}
            onBack={() => {}}
            {...props}
          />
        </RealtimeContext.Provider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

// 자정 직후(00:00~00:10)에는 `Date.now() - 10분` 이 어제가 되어 「오늘 끝난」 줄이 사라진다 — 제품의
// `startOfLocalDay` 는 옳고 시험의 시계가 흔들렸다. 시계는 흐르게 두되 오늘의 로컬 정오로 옮긴다.
const realNow = Date.now.bind(Date);
function noonShiftedNow(): () => number {
  const noon = new Date(realNow());
  noon.setHours(12, 0, 0, 0);
  const shift = noon.getTime() - realNow();
  return () => realNow() + shift;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(noonShiftedNow());
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.useRealTimers();
});

const rowIds = () =>
  screen.getAllByTestId(/^team-board-row-/).map(n => n.props.testID as string);

describe('상태 순서와 구간', () => {
  it('응답 필요 → 실행 중 → 검토 대기 순으로 한 열에 서고, 끝난 것은 맨 끝이다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-list')).toBeTruthy(),
    );
    expect(rowIds()).toEqual([
      'team-board-row-S-WAIT',
      'team-board-row-S-RUN-OTHER',
      'team-board-row-S-RUN-AGENT',
      'team-board-row-S-REVIEW',
      'team-board-row-S-DONE',
    ]);
    // 대기 상태의 말은 코어 정본 「응답 필요」다(성재 결정 2026-10-01).
    expect(screen.getByTestId('team-board-state-S-WAIT')).toHaveTextContent(
      /^!?응답 필요$/,
    );
    expect(screen.queryByText(/확인 기다림/)).toBeNull();
    expect(screen.getByTestId('team-board-state-S-REVIEW')).toHaveTextContent(
      /검토 대기/,
    );
    expect(screen.getByTestId('team-board-summary')).toHaveTextContent(
      /4개가 돌고 있어요.*1개는 응답이 필요해요/,
    );
  });

  it('A 레인 줄은 에이전트 레인 말을 달고 같은 보드에 선다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-row-S-RUN-AGENT')).toBeTruthy(),
    );
    expect(screen.getByTestId('team-board-row-S-RUN-AGENT')).toHaveTextContent(
      /에이전트 · 곽성재가 시킴/,
    );
    expect(screen.getByTestId('team-board-row-S-WAIT')).toHaveTextContent(
      /로컬 · 공유됨/,
    );
  });
});

describe('보이는 것은 서버가 준 줄뿐이다 (가시성이 새지 않는다)', () => {
  it('원장을 읽지 않는다: 원장에만 있는 줄은 화면에 없고, 서버가 준 줄은 하나도 빠지지 않는다', async () => {
    const mock = installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-list')).toBeTruthy(),
    );
    // 이 시험이 실패할 수 있다는 증거(사보타주): 화면에 `useWorkSessions`(원장 읽기)를
    // 끌어오면 아래 둘이 깨진다 — 원장 URL 호출이 생기고 원장 줄의 이름이 합쳐진다.
    const urls = mock.mock.calls.map(([url]) => String(url));
    expect(
      urls.filter(u => /\/work-sessions(\?|$)/.test(u)),
    ).toEqual([]);
    expect(screen.queryByText(LEDGER_ONLY_LABEL)).toBeNull();
    expect(rowIds()).toHaveLength(ROWS.length);
  });

  it('클라이언트가 한 번 더 거르지 않는다: 남의 줄도 보드에서는 보인다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByText('남의 실행 세션')).toBeTruthy(),
    );
    expect(screen.getByText('검토 대기 세션')).toBeTruthy();
  });
});

describe('「내 것」 필터', () => {
  it('주인이 나인 줄만 남기고(A 레인 포함) 개수를 말한다. 「전체」로 돌아오면 모두 보인다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-filter-mine')).toBeTruthy(),
    );
    expect(screen.getByTestId('team-board-filter-all')).toHaveTextContent(
      '전체 5',
    );
    expect(screen.getByTestId('team-board-filter-mine')).toHaveTextContent(
      '내 것 3',
    );
    fireEvent.press(screen.getByTestId('team-board-filter-mine'));
    expect(rowIds()).toEqual([
      'team-board-row-S-WAIT',
      'team-board-row-S-RUN-AGENT',
      'team-board-row-S-DONE',
    ]);
    expect(screen.queryByText('남의 실행 세션')).toBeNull();
    expect(screen.queryByText('검토 대기 세션')).toBeNull();
    fireEvent.press(screen.getByTestId('team-board-filter-all'));
    expect(rowIds()).toHaveLength(5);
  });

  it('내 것이 없으면 빈 상태가 말하고 없는 단추를 약속하지 않는다', async () => {
    installFetch({
      shared: () =>
        jsonResponse(200, {
          sessions: ROWS.filter(r => r.owner.memberId !== SELF_ID),
          nextCursor: null,
        }),
    });
    renderBoard({initialFilter: 'mine'});
    await waitFor(() =>
      expect(screen.getByTestId('team-board-empty')).toBeTruthy(),
    );
    expect(screen.getByText('내가 시킨 세션이 없어요')).toBeTruthy();
    expect(screen.queryByText(/공유 켜기|공유하기/)).toBeNull();
  });

  it('필터 컨트롤은 44pt 이상이고 선택 상태를 말한다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-filter-mine')).toBeTruthy(),
    );
    const style = StyleSheet.flatten(
      screen.getByTestId('team-board-filter-mine').props.style,
    );
    expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect([darkPalette.textFaint, lightPalette.textFaint]).toContain(
      style.borderColor,
    );
    expect(screen.getByTestId('team-board-filter-all')).toHaveProp(
      'accessibilityState',
      {selected: true},
    );
  });
});

describe('읽기 전용 상세 시트', () => {
  it('큐레이션된 말만 보인다: 단계·로그 요약·PR·터미널 안내, 입력 칸과 멈춤·허락이 없다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-row-S-WAIT')).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId('team-board-row-S-WAIT'));
    await waitFor(() =>
      expect(screen.getByTestId('team-detail-sheet')).toBeTruthy(),
    );
    expect(screen.getByTestId('team-detail-title')).toHaveTextContent(
      '응답이 필요한 세션',
    );
    expect(screen.getByTestId('team-detail-sentence')).toHaveTextContent(
      /곽성재의 응답이 필요해요 · \d+분째/,
    );
    expect(screen.getByTestId('team-detail-stages')).toHaveTextContent(
      /세션 시작.*작업 중.*실행 허락 기다림/,
    );
    expect(screen.getByTestId('team-detail-log')).toHaveTextContent(
      '커밋 2개 · +128 −40 · 파일 9',
    );
    expect(screen.getByTestId('team-detail-pr')).toHaveTextContent(
      /PR #2851.*yeomyeonggeori\/oort/,
    );
    expect(screen.getByTestId('team-detail-terminal-note')).toHaveTextContent(
      /터미널 원문은 주인의 기기에만 있어요/,
    );

    // 컨트롤이 새지 않는다. 이 단정이 실패할 수 있다는 증거(사보타주): 시트에
    // `<TextInput>`이나 「중지」 단추를 하나 넣으면 아래가 깨진다.
    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    const sheet = screen.getByTestId('team-detail-scroll');
    const labels = screen
      .UNSAFE_getAllByProps({accessibilityRole: 'button'})
      .map(n => String(n.props.accessibilityLabel ?? ''))
      .filter(l => l !== '');
    expect(labels.filter(l => /멈춤|중지|중단|허락|거부|입력|보내기|터미널/.test(l))).toEqual([]);
    expect(sheet).toBeTruthy();
  });

  it('PR이 없으면 「아직 PR 없음」이고, 에이전트 레인은 diff·저장소를 지어내지 않는다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-row-S-RUN-AGENT')).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId('team-board-row-S-RUN-AGENT'));
    await waitFor(() =>
      expect(screen.getByTestId('team-detail-no-pr')).toHaveTextContent(
        /아직 PR 없음/,
      ),
    );
    expect(screen.queryByTestId('team-detail-log')).toBeNull();
    expect(screen.queryByTestId('team-detail-stages')).toBeNull();
    expect(screen.queryByTestId('team-detail-where')).toBeNull();
  });

  it('바닥의 행동은 집 채널로 가는 이동이다. 이동 행은 내가 시킨 에이전트 세션에만 있다', async () => {
    installFetch();
    const opened: Array<[string, string]> = [];
    const agent: string[] = [];
    renderBoard({
      onOpenConversation: (id, title) => opened.push([id, title]),
      onOpenAgentSession: id => agent.push(id),
    });
    await waitFor(() =>
      expect(screen.getByTestId('team-board-row-S-RUN-OTHER')).toBeTruthy(),
    );
    // 남의 줄: 채널 이동만.
    fireEvent.press(screen.getByTestId('team-board-row-S-RUN-OTHER'));
    await waitFor(() =>
      expect(screen.getByTestId('team-detail-open-channel')).toBeTruthy(),
    );
    expect(screen.queryByTestId('team-detail-open-agent-session')).toBeNull();
    fireEvent.press(screen.getByTestId('team-detail-open-channel'));
    expect(opened).toEqual([[CH_A, '#workbench']]);
    await waitFor(() =>
      expect(screen.queryByTestId('team-detail-sheet')).toBeNull(),
    );
    // 내가 시킨 에이전트 줄: 이동 행이 서고, 시트 자신은 컨트롤을 쥐지 않는다.
    fireEvent.press(screen.getByTestId('team-board-row-S-RUN-AGENT'));
    await waitFor(() =>
      expect(screen.getByTestId('team-detail-open-agent-session')).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId('team-detail-open-agent-session'));
    expect(agent).toEqual(['S-RUN-AGENT']);
  });

  it('열어 둔 줄이 공유 해제로 보이지 않게 되면(단건 404) 시트가 닫히고 안내가 선다', async () => {
    let listed = ROWS;
    installFetch({shared: () => jsonResponse(200, {sessions: listed, nextCursor: null})});
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-row-S-WAIT')).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId('team-board-row-S-WAIT'));
    await waitFor(() =>
      expect(screen.getByTestId('team-detail-sheet')).toBeTruthy(),
    );
    listed = ROWS.filter(r => r.sessionId !== 'S-WAIT');
    await act(async () => {
      await queryClient?.invalidateQueries({queryKey: ['team-board', WS]});
    });
    await waitFor(() =>
      expect(screen.getByTestId('team-board-gone')).toBeTruthy(),
    );
    expect(screen.queryByTestId('team-detail-sheet')).toBeNull();
    expect(screen.queryByTestId('team-board-row-S-WAIT')).toBeNull();
  });
});

describe('네 상태', () => {
  it('불러오는 중', async () => {
    installFetch({shared: () => new Promise<Response>(() => {})});
    renderBoard();
    expect(screen.getByTestId('team-board-loading')).toBeTruthy();
    expect(screen.queryByTestId('team-board-row-S-WAIT')).toBeNull();
  });

  it('비어 있음: 공유가 시작되는 방법을 말하고 없는 단추를 약속하지 않는다', async () => {
    installFetch({
      shared: () => jsonResponse(200, {sessions: [], nextCursor: null}),
    });
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-empty')).toBeTruthy(),
    );
    expect(screen.getByText('공유된 세션이 아직 없어요')).toBeTruthy();
    expect(screen.queryByText(/공유 켜기|공유하기/)).toBeNull();
  });

  it('오류: 서버 원문은 새지 않고, 다시 시도하면 불러온다', async () => {
    let attempts = 0;
    installFetch({
      shared: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, {error: {message: 'DO_NOT_RENDER_SERVER_BODY'}})
          : jsonResponse(200, {sessions: ROWS, nextCursor: null});
      },
    });
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-error')).toBeTruthy(),
    );
    expect(screen.queryByText(/DO_NOT_RENDER_SERVER_BODY/)).toBeNull();
    fireEvent.press(screen.getByTestId('team-board-error-retry'));
    await waitFor(() =>
      expect(screen.getByTestId('team-board-list')).toBeTruthy(),
    );
  });

  it('오프라인: 읽은 목록은 그대로 두고 말한다', async () => {
    installFetch();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-list')).toBeTruthy(),
    );
    const netInfo = jest.requireMock('@react-native-community/netinfo')
      .default as {
      __emit: (s: {
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      }) => void;
    };
    act(() => {
      netInfo.__emit({isConnected: false, isInternetReachable: false});
    });
    await waitFor(() =>
      expect(screen.getByTestId('team-board-offline-cached')).toBeTruthy(),
    );
    expect(screen.getByTestId('team-board-row-S-WAIT')).toBeTruthy();
  });
});

describe('실시간은 신호이고 읽기가 진실이다', () => {
  it('듣는 채널마다 구독하고, 신호를 받으면 GET으로 다시 읽는다(겹친 신호는 한 번)', async () => {
    const mock = installFetch();
    const rail = fakeRail();
    renderBoard({}, rail.value);
    await waitFor(() =>
      expect(screen.getByTestId('team-board-list')).toBeTruthy(),
    );
    await waitFor(() => expect(rail.signals.size).toBe(2));
    expect([...rail.signals.keys()].sort()).toEqual([CH_A, CH_B].sort());
    const before = sharedReads(mock);
    act(() => {
      rail.signals.get(CH_A)?.();
      rail.signals.get(CH_B)?.();
    });
    await waitFor(() => expect(sharedReads(mock)).toBe(before + 1));
  });

  it('층이 가려지면 읽지도 듣지도 않는다', async () => {
    const mock = installFetch();
    const rail = fakeRail();
    renderBoard({active: false}, rail.value);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(sharedReads(mock)).toBe(0);
    expect(rail.signals.size).toBe(0);
  });

  it('신호가 끊임없이 와도 읽기가 굶지 않는다(첫 신호부터 최대 2초)', async () => {
    const mock = installFetch();
    const rail = fakeRail();
    renderBoard({}, rail.value);
    await waitFor(() => expect(rail.signals.size).toBe(2));
    await waitFor(() => expect(sharedReads(mock)).toBeGreaterThan(0));
    const before = sharedReads(mock);
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask']});
    for (let i = 0; i < 25; i += 1) {
      act(() => {
        rail.signals.get(CH_A)?.();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
    }
    expect(sharedReads(mock)).toBeGreaterThan(before);
  });

  it('떠날 때 구독을 모두 푼다', async () => {
    installFetch();
    const rail = fakeRail();
    const view = renderBoard({}, rail.value);
    await waitFor(() => expect(rail.signals.size).toBe(2));
    view.unmount();
    expect(rail.unsubscribed.sort()).toEqual([CH_A, CH_B].sort());
  });
});

describe('레일: subscribeWorkBoard', () => {
  function fakeClient(): Centrifuge {
    const {Centrifuge: Fake} = jest.requireMock('centrifuge') as {
      Centrifuge: new (url: string, options: unknown) => Centrifuge;
    };
    return new Fake('wss://example.test/connection/websocket', {});
  }
  type Emitting = Centrifuge & {
    subs: Map<string, {options: unknown; __emit: (e: string, c: unknown) => void}>;
  };

  it('메시지 레일과 같은 구독을 같은 옵션으로 나눠 쓴다', () => {
    const client = fakeClient() as Emitting;
    const rail = createChannelRail(() => client);
    const offMessages = rail.subscribeChannel(WS, CH_A, {
      onSubscribed: () => {},
      onMessage: () => {},
    });
    const offBoard = rail.subscribeWorkBoard(WS, CH_A, {onSignal: () => {}});
    expect([...client.subs.keys()]).toEqual([centrifugoChannelName(WS, CH_A)]);
    expect(client.subs.get(centrifugoChannelName(WS, CH_A))?.options).toEqual({
      recoverable: true,
      positioned: true,
    });
    offBoard();
    offMessages();
    expect(client.subs.size).toBe(0);
  });

  it('공유 변화·수명주기 프레임만 신호가 되고, 메시지 프레임은 아니다', () => {
    const client = fakeClient() as Emitting;
    const rail = createChannelRail(() => client);
    let signals = 0;
    const off = rail.subscribeWorkBoard(WS, CH_A, {onSignal: () => (signals += 1)});
    const sub = client.subs.get(centrifugoChannelName(WS, CH_A));
    sub?.__emit('publication', {data: {type: 'message.new', payload: {}}});
    expect(signals).toBe(0);
    sub?.__emit('publication', {
      data: {
        type: 'work.session.share_changed',
        v: 1,
        ts: 1,
        payload: {session_id: 'S-1', channel_id: CH_A, kind: 'state_changed'},
      },
    });
    expect(signals).toBe(1);
    off();
  });
});

const lit = (text: string): RegExp =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

describe('에이전트 작업 줄 (#3518)', () => {
  const RUN_WIRE = {
    source: 'run',
    runId: 'R-1',
    requestedBy: {memberId: SELF_ID, displayName: '곽성재'},
    stepCount: 2,
    commits: 2,
    origin: 'agent_run',
    label: '[label](javascript:alert(2))',
    folderLabel: null,
    status: 'running',
    owner: {memberId: OTHER_ID, displayName: '그록봇'},
    homeChannel: {id: CH_B, name: 'agent-lab'},
    startedAtMs: Date.now() - 600_000,
    endedAtMs: null,
    sharedAtMs: null,
    repo: null,
    branch: '<b>evil</b>',
    harness: 'hosted',
    state: 'running',
    stages: ['[x](javascript:alert(1))', '<img src=x onerror=alert(1)>'],
    diff: {added: 30, deleted: 4, files: null, ahead: null, behind: null, uncommitted: null},
    prUrl: 'https://github.com/acme/oort/pull/12',
    lastActivityAt: Math.floor(Date.now() / 1000) - 60,
  };

  it('include=runs로 읽고, runId 줄을 그리고, 열어도 단건 읽기를 하지 않는다', async () => {
    const mock = installFetch({
      shared: () => jsonResponse(200, {sessions: [RUN_WIRE], nextCursor: null}),
    });
    renderBoard();
    await waitFor(() => expect(screen.getByTestId('team-board-row-R-1')).toBeTruthy());
    expect(
      mock.mock.calls.some(([url]) => String(url).includes('include=runs')),
    ).toBe(true);
    fireEvent.press(screen.getByTestId('team-board-row-R-1'));
    await waitFor(() => expect(screen.getByTestId('team-detail-sheet')).toBeTruthy());
    expect(
      mock.mock.calls.some(([url]) => /\/work-sessions\/R-1\/shared/.test(String(url))),
    ).toBe(false);
    expect(screen.getByTestId('team-detail-lane')).toHaveTextContent(
      /에이전트 · 곽성재가 시킴/,
    );
    expect(screen.getByTestId('team-detail-pr')).toHaveTextContent(/PR #12/);
    expect(screen.getByTestId('team-detail-terminal-note')).toHaveTextContent(
      /에이전트가 스스로 알린/,
    );
  });

  async function openRun(wire: object, id: string) {
    installFetch({
      shared: () => jsonResponse(200, {sessions: [wire], nextCursor: null}),
    });
    renderBoard();
    await waitFor(() => expect(screen.getByTestId(`team-board-row-${id}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`team-board-row-${id}`));
    await waitFor(() => expect(screen.getByTestId('team-detail-sheet')).toBeTruthy());
  }

  it('보안: 단계·브랜치·이름 글자를 직접 눌러도 어디도 열리지 않고, 잘못된 PR 주소는 링크가 아니다', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openRun({...RUN_WIRE, prUrl: 'javascript:alert(1)'}, 'R-1');
    for (const text of [
      '[x](javascript:alert(1))',
      '<img src=x onerror=alert(1)>',
      '<b>evil</b>',
      '[label](javascript:alert(2))',
    ]) {
      const nodes = screen.getAllByText(lit(text));
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) fireEvent.press(node);
    }
    expect(screen.queryByTestId('team-detail-pr')).toBeNull();
    expect(screen.getByTestId('team-detail-no-pr')).toBeTruthy();
    expect(open).toHaveBeenCalledTimes(0);
    open.mockRestore();
  });

  it('대조: 올바른 PR 주소는 링크이고 누르면 그 주소 하나만 열린다(스파이가 실제로 듣고 있다)', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openRun(RUN_WIRE, 'R-1');
    fireEvent.press(screen.getByTestId('team-detail-pr'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://github.com/acme/oort/pull/12');
    open.mockRestore();
  });

  it('work.run.updated 프레임은 신호가 된다', () => {
    const {Centrifuge: Fake} = jest.requireMock('centrifuge') as {
      Centrifuge: new (url: string, options: unknown) => Centrifuge;
    };
    const client = new Fake('wss://example.test/connection/websocket', {}) as Centrifuge & {
      subs: Map<string, {__emit: (e: string, c: unknown) => void}>;
    };
    const rail = createChannelRail(() => client);
    let signals = 0;
    const off = rail.subscribeWorkBoard(WS, CH_A, {onSignal: () => (signals += 1)});
    client.subs.get(centrifugoChannelName(WS, CH_A))?.__emit('publication', {
      data: {type: 'work.run.updated', v: 1, ts: 1, payload: {run_id: 'R-1', channel_id: CH_A, to: 'done'}},
    });
    expect(signals).toBe(1);
    off();
  });
});

describe('소스 잠금: 보드는 터미널·컨트롤·원장 읽기를 끌어오지 않는다', () => {
  const files = [
    '../src/screens/TeamBoardScreen.tsx',
    '../src/features/work/teamBoard/useTeamBoard.ts',
    '../src/features/work/teamBoard/TeamBoardParts.tsx',
    '../src/features/work/teamBoard/TeamBoardDetailSheet.tsx',
  ];
  const source = () =>
    files
      .map(f => fs.readFileSync(path.resolve(__dirname, f), 'utf8'))
      .join('\n');

  it('대상 파일을 실제로 읽었다(빈 문자열로 통과하지 않는다)', () => {
    for (const f of files) {
      expect(
        fs.readFileSync(path.resolve(__dirname, f), 'utf8').length,
      ).toBeGreaterThan(500);
    }
  });

  it('터미널·attach·입력·멈춤·서명 컨트롤·원장 읽기가 없다', () => {
    expect(source()).not.toMatch(
      /issueObserverTerminalAttach|TerminalAttachGrant|issueDisplayAttach|DisplayAttachGrant|RTCPeerConnection|WebView|capability_token|attach_endpoint|display_endpoint|pty_id|display_id|SignedWorkControls|StopTurnControl|<TextInput|fetchWorkSessions|useWorkSessions|endWorkSession|AsyncStorage|MMKV|console\.(?:log|info|warn|error)/,
    );
  });

  it('보드의 읽기는 공유 목록·단건 둘뿐이다', () => {
    const hook = fs.readFileSync(
      path.resolve(__dirname, '../src/features/work/teamBoard/useTeamBoard.ts'),
      'utf8',
    );
    const fetchers = [...hook.matchAll(/\b(fetch[A-Za-z]+)\(/g)].map(m => m[1]);
    expect([...new Set(fetchers)].sort()).toEqual([
      'fetchSharedWorkSession',
      'fetchSharedWorkSessions',
    ]);
  });
});

describe('앱 복귀 재조회 (#3589 N9) — 단계에는 realtime이 없다', () => {
  const stageRow = (stages: string[]) =>
    row({sessionId: 'S-RUN-AGENT', origin: 'host', state: 'running', stages});

  it('앱이 앞으로 돌아오면 보드를 다시 읽고 바뀐 단계를 보인다', async () => {
    let stages = ['세션 시작'];
    const mock = installFetch({
      shared: () =>
        jsonResponse(200, {sessions: [stageRow(stages)], nextCursor: null}),
    });
    const emit = captureAppState();
    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId('team-board-stage-S-RUN-AGENT')).toHaveTextContent(
        '세션 시작',
      ),
    );
    const before = sharedReads(mock);
    stages = ['세션 시작', 'PR 만드는 중'];
    act(() => emit('background'));
    expect(sharedReads(mock)).toBe(before);
    act(() => emit('active'));
    await waitFor(() =>
      expect(screen.getByTestId('team-board-stage-S-RUN-AGENT')).toHaveTextContent(
        'PR 만드는 중',
      ),
    );
    expect(sharedReads(mock)).toBe(before + 1);
  });

  it('가려진 층은 앱이 돌아와도 읽지 않는다', async () => {
    const mock = installFetch();
    const emit = captureAppState();
    renderBoard({active: false});
    act(() => emit('active'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(sharedReads(mock)).toBe(0);
  });

  it('「즉시」를 약속하는 문구가 없다', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/screens/TeamBoardScreen.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/["'`>][^"'`<]*즉시/);
  });
});
