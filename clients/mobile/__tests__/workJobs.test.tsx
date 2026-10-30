import type {Member} from '@momo/core/lib/api';
import {resetWorkJobsDetection} from '@momo/core/lib/api';
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
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {TextInput} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {markAgentWorking, resetAgentWorking} from '../src/features/agents/workingSignal';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import SidebarScreen from '../src/screens/SidebarScreen';
import WorkJobsScreen from '../src/screens/WorkJobsScreen';
import {SessionProvider} from '../src/session/useSession';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// 폰 「작업」 한 화면 (ADR-0202 D1·D2·D6, U1 #3842). 화면 단위 시험이다: 기본 필터는 「내 것」,
// 서버에 `who`로 묻고, 옛 서버면 팀 보드 한 벌로 물러서며, 줄은 결과(에이전트 보고 꼬리표)를
// 말하고, 승인 필요 줄에는 결정 단추가 없다. 홈 「작업 중」 카드 머리의 「모두 보기」가 이 층을 연다.

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CH_A = 'cccccccc-0000-4000-8000-00000000000a';
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

const NOW = Date.now();
const EMPTY_DIFF = {added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null};

function wireRun(over: Record<string, unknown>) {
  return {
    source: 'run',
    runId: 'RUN-1',
    requestedBy: {memberId: SELF_ID, displayName: '곽성재'},
    stepCount: 2,
    origin: 'agent_run',
    label: '온보딩 문구 다듬기',
    folderLabel: null,
    status: 'done',
    owner: {memberId: AGENT_ID, displayName: '그록봇'},
    homeChannel: {id: CH_A, name: 'agent-lab'},
    startedAtMs: NOW - 25 * 60_000,
    endedAtMs: NOW - 60_000,
    sharedAtMs: null,
    repo: null,
    branch: null,
    harness: 'hosted',
    state: 'done',
    stages: ['코드 읽기', 'PR 열기'],
    diff: EMPTY_DIFF,
    prUrl: 'https://github.com/yeomyeonggeori/oort/pull/3842',
    lastActivityAt: Math.floor((NOW - 60_000) / 1000),
    trigger: 'work',
    phase: 'succeeded',
    agentReported: {
      resultKind: 'pr_opened',
      tests: {passed: 12, failed: 0, notRun: 2},
      nextAction: 'merge_ok',
      commitSha: 'ABCDEF1234567',
    },
    ...over,
  };
}

const MINE_RUN = wireRun({});
const APPROVAL_RUN = wireRun({
  runId: 'RUN-APPROVAL',
  label: '#launch 채널에 공지 올리기',
  state: 'running',
  status: 'running',
  endedAtMs: null,
  prUrl: null,
  phase: 'awaiting_approval',
  trigger: 'mention',
  agentReported: undefined,
});
const OTHER_SESSION = {
  source: 'session',
  sessionId: 'S-OTHER',
  origin: 'local_pty',
  label: '결제 웹훅 재시도 고치기',
  folderLabel: 'oort',
  status: 'running',
  owner: {memberId: OTHER_ID, displayName: '김민지'},
  homeChannel: {id: CH_A, name: 'agent-lab'},
  startedAtMs: NOW - 5 * 60_000,
  endedAtMs: null,
  sharedAtMs: NOW - 5 * 60_000,
  repo: 'oort',
  branch: 'fix/webhook',
  harness: 'claude',
  state: 'running',
  stages: [],
  diff: EMPTY_DIFF,
  prUrl: null,
  lastActivityAt: Math.floor((NOW - 30_000) / 1000),
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** `jobs`: 새 서버(who를 되울린다). `legacy`: 배포된 서버(include가 정확히 runs일 때만 run 줄). */
function installFetch(mode: 'jobs' | 'legacy' = 'jobs'): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/work-sessions/shared')) {
      const query = new URL(url).searchParams;
      const include = query.get('include');
      const who = query.get('who');
      if (mode === 'jobs' && include === 'runs,jobs' && (who === 'mine' || who === 'team')) {
        const sessions = who === 'mine' ? [APPROVAL_RUN, MINE_RUN] : [APPROVAL_RUN, MINE_RUN, OTHER_SESSION];
        return jsonResponse(200, {sessions, nextCursor: null, who});
      }
      return jsonResponse(200, {
        sessions: include === 'runs' ? [MINE_RUN, OTHER_SESSION] : [OTHER_SESSION],
        nextCursor: null,
      });
    }
    if (/\/work-sessions\/[^/?]+\/shared/.test(url)) {
      return jsonResponse(404, {error: {message: 'gone'}});
    }
    if (url.includes('/channels')) {
      return jsonResponse(200, {
        channels: [{id: CH_A, workspaceId: WS, kind: 'public', name: 'agent-lab', muted: false}],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

function renderJobs(props: Partial<React.ComponentProps<typeof WorkJobsScreen>> = {}) {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider member={SELF}>
        <RealtimeContext.Provider value={{rail: null, status: 'connecting', subscriptionsWanted: false}}>
          <WorkJobsScreen active onOpenConversation={() => {}} onBack={() => {}} {...props} />
        </RealtimeContext.Provider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

beforeEach(() => {
  mmkvStore.clear();
  resetWorkJobsDetection();
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
});

const rowIds = () =>
  screen.getAllByTestId(/^work-job-row-/).map(n => n.props.testID as string);
const sharedUrls = (mock: jest.Mock) =>
  mock.mock.calls.map(([u]) => String(u)).filter(u => u.includes('/work-sessions/shared'));

describe('필터 (ADR-0202 D2)', () => {
  it('기본은 「내 것」이고 who=mine으로 묻는다. 「팀 전체」를 고르면 who=team이고 기기에 기억한다', async () => {
    const mock = installFetch();
    renderJobs();
    await waitFor(() => expect(rowIds()).toEqual(['work-job-row-RUN-APPROVAL', 'work-job-row-RUN-1']));
    expect(screen.getByTestId('work-jobs-filter-mine').props.accessibilityState).toEqual({selected: true});
    expect(sharedUrls(mock).every(u => u.includes('who=mine'))).toBe(true);
    fireEvent.press(screen.getByTestId('work-jobs-filter-team'));
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(sharedUrls(mock).some(u => u.includes('who=team'))).toBe(true);
    expect(mmkvStore.get(NON_SECRET_KEYS.workFilter)).toBe('team');
  });

  it('기기에 「팀 전체」를 기억했으면 그것으로 연다', async () => {
    mmkvStore.set(NON_SECRET_KEYS.workFilter, 'team');
    installFetch();
    renderJobs();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
  });

  it('옛 서버: run 줄을 잃지 않고(include=runs로 다시 읽는다) 안내가 서고, 「내 것」은 화면이 고른다', async () => {
    const mock = installFetch('legacy');
    renderJobs();
    await waitFor(() => expect(rowIds()).toEqual(['work-job-row-RUN-1']));
    expect(screen.getByTestId('work-jobs-legacy')).toBeTruthy();
    expect(sharedUrls(mock).some(u => /include=runs(&|$)/.test(u))).toBe(true);
    fireEvent.press(screen.getByTestId('work-jobs-filter-team'));
    await waitFor(() => expect(rowIds()).toHaveLength(2));
  });
});

describe('결과 중심 줄 (ADR-0202 D1)', () => {
  it('맡긴 사람 → 에이전트, 상태, 에이전트 보고 꼬리표와 결과, 걸린 시간·채널, 「지금 진행 n」', async () => {
    installFetch();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('work-job-row-RUN-1')).toBeTruthy());
    expect(screen.getByTestId('work-job-who-RUN-1')).toHaveTextContent('곽성재 → 그록봇');
    expect(screen.getByTestId('work-job-state-RUN-1')).toHaveTextContent(/끝남 · PR/);
    expect(screen.getByTestId('work-job-reported-tag-RUN-1')).toHaveTextContent(/에이전트 보고/);
    expect(screen.getByTestId('work-job-result-RUN-1')).toHaveTextContent(
      'PR을 열었어요 · 테스트 통과 12 · 안 돌림 2 · 머지해도 된대요',
    );
    expect(screen.getByTestId('work-job-row-RUN-1')).toHaveTextContent(/24분 동안 작업 · #agent-lab/);
    expect(screen.getByText('지금 진행 1')).toBeTruthy();
  });

  it('승인 필요 줄은 맨 위에 서고 「승인 필요」이며, 결정 단추 없이 카드 자리로 가는 길만 있다', async () => {
    installFetch();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('work-job-row-RUN-APPROVAL')).toBeTruthy());
    expect(rowIds()[0]).toBe('work-job-row-RUN-APPROVAL');
    expect(screen.getByTestId('work-job-state-RUN-APPROVAL')).toHaveTextContent(/승인 필요/);
    expect(screen.getByTestId('work-job-approval-RUN-APPROVAL')).toHaveTextContent('승인은 그 카드에서 해요');
    fireEvent.press(screen.getByTestId('work-job-row-RUN-APPROVAL'));
    await waitFor(() => expect(screen.getByTestId('team-detail-approval-link')).toBeTruthy());
    const labels = screen
      .UNSAFE_getAllByProps({accessibilityRole: 'button'})
      .map(n => String(n.props.accessibilityLabel ?? ''));
    expect(labels.filter(l => /^(승인|거부|허락)(하기)?$/.test(l))).toEqual([]);
    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  });

  it('시트의 「에이전트 보고」 절이 닫힌 칸만 키-값으로 말한다', async () => {
    installFetch();
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('work-job-row-RUN-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('work-job-row-RUN-1'));
    const block = await waitFor(() => screen.getByTestId('work-job-reported'));
    expect(block).toHaveTextContent(/PR을 열었어요/);
    expect(block).toHaveTextContent(/테스트 통과 12/);
    expect(block).toHaveTextContent(/abcdef123456/);
    // 칸은 묶음 카드의 줄이다(#4458): 네 칸이 꼬리표 아래 카드 하나에 서고 줄 사이는 카드의 구분선이다.
    const cells = within(block).getAllByLabelText(/^(한 일|테스트|다음 할 일|커밋|작업 환경 안), /);
    expect(cells.length).toBeGreaterThanOrEqual(3);
    expect(within(block).getAllByTestId('group-divider')).toHaveLength(cells.length - 1);
  });

  it('비면 필터에 맞는 한 줄', async () => {
    globalThis.fetch = jest.fn(async (input: string) =>
      String(input).includes('/work-sessions/shared')
        ? jsonResponse(200, {sessions: [], nextCursor: null, who: 'mine'})
        : jsonResponse(200, {channels: []}),
    ) as unknown as typeof fetch;
    renderJobs();
    await waitFor(() => expect(screen.getByTestId('work-jobs-empty')).toHaveTextContent(/내가 맡긴 작업이 아직 없어요/));
  });
});

describe('홈 「모두 보기」 (ADR-0202 D6)', () => {
  function renderHome(onOpenWorkList?: () => void) {
    queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider member={SELF}>
          <SidebarScreen
            openChannelId={null}
            onOpenConversation={() => {}}
            onOpenSearch={() => {}}
            onOpenWorkList={onOpenWorkList}
          />
        </SessionProvider>
      </QueryClientProvider>,
    );
  }

  afterEach(() => resetAgentWorking());

  it('도는 턴이 없으면 「에이전트 작업」 머리도 「모두 보기」도 서지 않는다 (성재 2026-10-16: 상시 떠 있는 줄이 아니다)', async () => {
    installFetch();
    renderHome(() => {});
    await waitFor(() => expect(screen.getByText('agent-lab')).toBeTruthy());
    expect(screen.queryByTestId('home-work-see-all')).toBeNull();
    expect(screen.queryByTestId('home-working-card')).toBeNull();
    expect(screen.queryByTestId('home-work-head')).toBeNull();
  });

  it('셸이 「작업」 층을 넘기고 도는 턴이 있으면 「에이전트 작업」 머리에 「모두 보기」가 서고 누르면 그 층을 연다', async () => {
    installFetch();
    const open = jest.fn();
    renderHome(open);
    await waitFor(() => expect(screen.getByText('agent-lab')).toBeTruthy());
    act(() =>
      markAgentWorking({
        memberId: AGENT_ID,
        channelId: CH_A,
        state: 'working',
        source: 'run',
        startedAtMs: Date.now() - 30_000,
        headlines: ['PR 초안 작성 중'],
        lastActivityAtMs: Date.now(),
      }),
    );
    const button = await waitFor(() => screen.getByTestId('home-work-see-all'));
    expect(screen.getByTestId('home-work-head')).toHaveTextContent('에이전트 작업');
    expect(button.props.accessibilityLabel).toBe('에이전트 작업 모두 보기');
    fireEvent.press(button);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('셸 밖(하네스)에서 넘기지 않으면 문이 서지 않는다', async () => {
    installFetch();
    renderHome(undefined);
    await waitFor(() => expect(screen.getByText('agent-lab')).toBeTruthy());
    act(() =>
      markAgentWorking({
        memberId: AGENT_ID,
        channelId: CH_A,
        state: 'working',
        source: 'run',
        startedAtMs: Date.now() - 30_000,
        headlines: [],
        lastActivityAtMs: Date.now(),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('home-working-card')).toBeTruthy());
    expect(screen.queryByTestId('home-work-see-all')).toBeNull();
  });
});

describe('셸 배선 (소스)', () => {
  it('+ 메뉴 「작업」과 홈 「모두 보기」가 같은 층(WorkJobsScreen)을 연다', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../src/shell/AppShell.tsx'), 'utf8');
    expect(shell.length).toBeGreaterThan(1000);
    expect(shell).toMatch(/<WorkJobsScreen\b/);
    expect(shell).not.toMatch(/<TeamBoardScreen\b/);
    // 호스트 유무로 접지 않는다(ADR-0202 D3: 호스팅 에이전트의 일은 호스트 없이 생긴다).
    expect(shell).toMatch(/onOpenWorkList=\{onOpenWorkList\}/);
    expect(shell).not.toMatch(/onOpenWorkList=\{workConsole/);
    expect(shell).not.toMatch(/has\('workList'\) && workConsole/);
  });
});
