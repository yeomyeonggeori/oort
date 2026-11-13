import type {Member} from '@momo/core/lib/api';
import {resetWorkJobsDetection} from '@momo/core/lib/api';
import {WORK_JOBS_COPY} from '@momo/core/features/workbench/workJobs';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰에서 내 맥 세션을 여는 문 (#5593, ADR-0188 — A 레인 ①).
//
//   ① 세션 화면의 문은 웹과 같은 판정으로 선다: 이 워크스페이스에 지금 온라인인 호스트가 있는가. 예전에는 정적 표
//      (`provided:false`)만 읽어서 운영 빌드에서는 어떤 문도 서지 않았다.
//   ② 작업 목록에서 내 맥 세션 줄을 누르면 시트가 아니라 그 세션 화면이다.
//   ③ 내 맥 세션이 권한 요청에 답을 기다리면 맨 위 「응답 필요」 구간에 서고, 세션 줄에는 맥 점이 선다.
//   ④ 「내 맥에 보내기」가 세션을 찾으면 그 세션 화면으로 바로 간다.
//
// 셸 전체를 세운다(`AppShell`). 가짜는 서버의 답(`fetch`)뿐이고, 판정·항법·목록·세션 화면은 진짜다. ④만 두 시트
// (AI 시트·내 맥에 보내기 시트)를 막대 하나로 바꾼다: 시트가 세션을 찾아 `onOpenSession` 을 부르는 일은
// `askMac.test.tsx` ⑤가 재고, 여기서 재는 것은 그 다음 — 셸이 그 부름을 세션 화면으로 잇는가다.
// =============================================================================

jest.mock('../src/shell/AiSheet', () => {
  const ReactActual = jest.requireActual('react');
  const {Pressable} = jest.requireActual('react-native');
  return {
    AiSheet: ({onAskMac}: {onAskMac: (harness?: string) => void}) =>
      ReactActual.createElement(Pressable, {
        testID: 'stub-ai-ask-mac',
        onPress: () => onAskMac(undefined),
      }),
  };
});

jest.mock('../src/shell/AskMacSheet', () => {
  const ReactActual = jest.requireActual('react');
  const {Pressable} = jest.requireActual('react-native');
  return {
    AskMacSheet: ({onOpenSession}: {onOpenSession: (sessionId: string) => void}) =>
      ReactActual.createElement(Pressable, {
        testID: 'stub-ask-mac-found',
        // 시트가 「내 요청이 만든 세션」을 하나로 정한 순간이다(`findSpawnedSession`).
        onPress: () => onOpenSession('aaaa0001-0000-4000-8000-000000000001'),
      }),
  };
});

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CH = '33333333-3333-4333-8333-333333333333';
const HOST = '77777777-7777-4777-8777-777777777777';
const BASE = 'https://api.example.com';
const NOW = Date.now();

/** 내 맥 세션 — 돌고 있고 묻는 것이 없다. */
const S_MAC = 'aaaa0001-0000-4000-8000-000000000001';
/** 내 맥 세션 — 권한 요청에 답을 기다린다. 서버 순서로는 맨 끝이다(마지막 활동이 가장 오래됐다). */
const S_WAIT = 'aaaa0002-0000-4000-8000-000000000002';
const ROOT_MAC = 'bbbb0001-0000-4000-8000-000000000001';
const ROOT_WAIT = 'bbbb0002-0000-4000-8000-000000000002';
const REQUEST = 'cccc0002-0000-4000-8000-000000000002';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '김도현',
  handle: 'dohyeon',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

const EMPTY_DIFF = {added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null};

/** 보드 한 줄(`GET …/work-sessions/shared?include=runs,jobs`) — 호스트 세션. 호스트 id 는 싣지 않는다(서버가 일부러). */
function boardSession(id: string, label: string, minutesAgo: number) {
  return {
    source: 'session',
    sessionId: id,
    origin: 'host',
    label,
    folderLabel: null,
    status: 'running',
    owner: {memberId: SELF_ID, displayName: '김도현'},
    homeChannel: {id: CH, name: 'general'},
    startedAtMs: NOW - (minutesAgo + 10) * 60_000,
    endedAtMs: null,
    sharedAtMs: null,
    repo: null,
    branch: null,
    harness: 'claude',
    state: 'running',
    stages: [],
    diff: EMPTY_DIFF,
    prUrl: null,
    lastActivityAt: Math.floor((NOW - minutesAgo * 60_000) / 1000),
  };
}

/** 승인을 기다리는 호스팅 에이전트의 run — 예전부터 「지금」 구간 맨 위로 오르던 줄. */
const APPROVAL_RUN = {
  source: 'run',
  runId: 'RUN-APPROVAL',
  requestedBy: {memberId: SELF_ID, displayName: '김도현'},
  stepCount: 1,
  origin: 'agent_run',
  label: '#launch 채널에 공지 올리기',
  folderLabel: null,
  status: 'running',
  owner: {memberId: AGENT_ID, displayName: '그록봇'},
  homeChannel: {id: CH, name: 'general'},
  startedAtMs: NOW - 4 * 60_000,
  endedAtMs: null,
  sharedAtMs: null,
  repo: null,
  branch: null,
  harness: 'hosted',
  state: 'running',
  stages: [],
  diff: EMPTY_DIFF,
  prUrl: null,
  lastActivityAt: Math.floor((NOW - 30_000) / 1000),
  trigger: 'mention',
  phase: 'awaiting_approval',
};

const BOARD = [
  APPROVAL_RUN,
  boardSession(S_MAC, '릴레이 재시작 절차', 2),
  boardSession(S_WAIT, '배포 스크립트 정리', 9),
];

/** 세션 원장(`GET …/work-sessions`) — 호스트 id 와 스레드 루트는 여기에만 있다. */
function ledgerSession(id: string, rootMessageId: string, label: string) {
  return {
    id,
    workspaceId: WS,
    channelId: CH,
    memberId: SELF_ID,
    hostId: HOST,
    rootMessageId,
    tool: 'claude',
    label,
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW - 20 * 60_000,
  };
}

const LEDGER = [
  ledgerSession(S_MAC, ROOT_MAC, '릴레이 재시작 절차'),
  ledgerSession(S_WAIT, ROOT_WAIT, '배포 스크립트 정리'),
];

function host(online: boolean) {
  return {
    id: HOST,
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'app',
    displayName: '도현 맥북',
    capabilities: {},
    createdAtMs: 0,
    online,
  };
}

/** 세션 스레드의 권한 요청 줄 — 권한 요청에 답을 기다리는 세션(S_WAIT)의 스레드에만 있다. */
const PERMISSION_REQUESTED = {
  id: REQUEST,
  channelId: CH,
  rootId: ROOT_WAIT,
  seq: 30,
  hlcTs: NOW - 60_000,
  hlcCount: 0,
  authorMemberId: SELF_ID,
  type: 'system',
  body: 'DO_NOT_RENDER_MESSAGE_BODY',
  state: 'sent',
  createdAtMs: NOW - 60_000,
  props: {
    kind: 'work_session_event',
    schema: 'momo.work_session.acp_event.v1',
    event_type: 'approval.requested',
    event_id: REQUEST,
    event_ts: NOW - 60_000,
    event: {
      work_session_id: S_WAIT,
      event_id: REQUEST,
      options: [
        {option_id: 'allow-once', kind: 'allow_once', name: 'Allow once'},
        {option_id: 'reject-once', kind: 'reject_once', name: 'Reject'},
      ],
    },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 내 대기 승인 — 승인을 기다리는 그 run(`RUN-APPROVAL`)에 걸려 있다(인박스 알약이 세는 같은 원장, 수리 M1). */
const MY_PENDING_APPROVAL = {
  id: 'dddd0001-0000-4000-8000-000000000001',
  workspace_id: WS,
  run_id: 'RUN-APPROVAL',
  channel_id: CH,
  requested_by: AGENT_ID,
  action_type: 'tool_call',
  status: 'pending',
  request_message_id: 'eeee0001-0000-4000-8000-000000000001',
};

/** 이 칸의 가짜 서버. `hosts` 가 맥의 켜짐을, `approvals` 가 내 대기 승인 원장을 정한다. */
function installFetch({hosts, approvals = []}: {hosts: unknown[]; approvals?: unknown[]}): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (/\/inbox(\/|$)/.test(path)) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/work-sessions/shared')) {
      const query = new URL(url).searchParams;
      const who = query.get('who');
      if (query.get('include') === 'runs,jobs' && (who === 'mine' || who === 'team')) {
        return jsonResponse(200, {sessions: BOARD, nextCursor: null, who});
      }
      return jsonResponse(200, {sessions: BOARD, nextCursor: null});
    }
    if (url.includes('/replies')) {
      return jsonResponse(200, {messages: path.includes(ROOT_WAIT) ? [PERMISSION_REQUESTED] : []});
    }
    if (url.includes('/permission-requests/')) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: LEDGER});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: hosts});
    if (url.includes('/signing-context')) {
      return jsonResponse(200, {
        instanceId: 'instance-1',
        serverTimeMs: NOW,
        maxLifetimeMs: 60_000,
        maxClockSkewMs: 5_000,
        humanControlSignatureRequired: true,
        hostRegisterSignatureRequired: false,
      });
    }
    if (url.includes('/device-keys')) return jsonResponse(200, {deviceKeys: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [{id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals});
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

/**
 * `hosts` 를 주면 호스트 목록이 이미 읽힌 셸로 선다 — 앱이 한동안 떠 있어 판정이 서 있는 순간이다. 그래야 줄을 누르는
 * 손이 첫 읽기와 경주하지 않고, 판정이 정적 표인지 호스트 목록인지만 갈린다(고치기 전 셸은 이 목록을 읽지 않는다).
 */
function renderShell(hosts?: unknown[]) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  if (hosts !== undefined) queryClient.setQueryData(['work-hosts', WS], hosts);
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

const SETTLE = {timeout: 10_000};
const HIDDEN_TOO = {includeHiddenElements: true} as const;
jest.setTimeout(30_000);

/** + 메뉴의 「작업」으로 목록을 연다. 맥 세션 줄이 설 때까지 기다린다. */
async function openWorkList(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('shell-plus')).toBeTruthy(), SETTLE);
  fireEvent.press(screen.getByTestId('shell-plus'));
  fireEvent.press(screen.getByTestId('plus-menu-work'));
  await waitFor(
    () => expect(screen.getByTestId(`work-job-row-${S_MAC}`)).toBeTruthy(),
    SETTLE,
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
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('① ② 세션 화면의 문은 「온라인 호스트가 있는가」로 선다 — 목록 줄이 그 문이다', () => {
  it('맥이 켜져 있으면 내 맥 세션 줄을 눌러 시트가 아니라 그 세션 화면이 열리고, 뒤로는 목록이다', async () => {
    installFetch({hosts: [host(true)]});
    renderShell([host(true)]);
    await openWorkList();

    fireEvent.press(screen.getByTestId(`work-job-row-${S_MAC}`));
    await waitFor(() => expect(screen.getByTestId('work-detail-pane')).toBeTruthy(), SETTLE);
    await waitFor(
      () =>
        expect(screen.getByTestId('work-detail-title')).toHaveTextContent('릴레이 재시작 절차'),
      SETTLE,
    );
    expect(screen.queryByTestId('team-detail-sheet')).toBeNull();

    fireEvent.press(screen.getByLabelText('작업 목록으로'));
    await waitFor(() => expect(screen.queryByTestId('work-detail-pane')).toBeNull());
    expect(screen.getByTestId(`work-job-row-${S_MAC}`)).toBeTruthy();
  });

  it('온라인 호스트가 없으면 문이 서지 않는다 — 같은 줄은 읽기 시트를 연다(누른 뒤에야 빈 화면을 만나지 않게)', async () => {
    installFetch({hosts: [host(false)]});
    renderShell([host(false)]);
    await openWorkList();

    fireEvent.press(screen.getByTestId(`work-job-row-${S_MAC}`));
    await waitFor(() => expect(screen.getByTestId('team-detail-sheet')).toBeTruthy(), SETTLE);
    expect(screen.queryByTestId('work-detail-pane')).toBeNull();
  });

  it('호스팅 에이전트의 run 줄은 맥이 켜져 있어도 시트다 — 세션 화면이 있는 것은 내 맥 세션뿐이다', async () => {
    installFetch({hosts: [host(true)]});
    renderShell([host(true)]);
    await openWorkList();

    fireEvent.press(screen.getByTestId('work-job-row-RUN-APPROVAL'));
    await waitFor(() => expect(screen.getByTestId('team-detail-sheet')).toBeTruthy(), SETTLE);
    expect(screen.queryByTestId('work-detail-pane')).toBeNull();
  });
});

describe('③ 권한 요청에 답을 기다리는 내 맥 세션은 맨 위 「응답 필요」다', () => {
  it('서버 순서로는 맨 끝인 줄이 승인 대기 run 보다도 위, 첫 구간의 유일한 줄로 선다', async () => {
    installFetch({hosts: [host(true)]});
    renderShell();
    await openWorkList();

    await waitFor(
      () =>
        expect(screen.getByText(`${WORK_JOBS_COPY.sectionNeedsMe} 1`)).toBeTruthy(),
      SETTLE,
    );
    const rows = screen
      .getAllByTestId(/^work-job-row-/)
      .map(node => String(node.props.testID).replace('work-job-row-', ''));
    expect(rows).toEqual([S_WAIT, 'RUN-APPROVAL', S_MAC]);
    const headers = screen
      .getAllByText(/^(응답 필요|지금|끝난 일) \d+$/)
      .map(node => node.props.children);
    expect(headers).toEqual([`${WORK_JOBS_COPY.sectionNeedsMe} 1`, `${WORK_JOBS_COPY.sectionNow} 2`]);

    // 그 줄은 무엇을 기다리는지 말로 하고(보이는 글과 낭독), 묻지 않는 세션 줄에는 그 말이 없다.
    const waiting = screen.getByTestId(`work-job-row-${S_WAIT}`);
    expect(within(waiting).getByText(WORK_JOBS_COPY.permissionHint)).toBeTruthy();
    expect(waiting.props.accessibilityLabel).toContain(WORK_JOBS_COPY.permissionHint);
    const quiet = screen.getByTestId(`work-job-row-${S_MAC}`);
    expect(within(quiet).queryByText(WORK_JOBS_COPY.permissionHint)).toBeNull();
    // 칩도 같은 사실을 말한다(수리 M2): 「응답 필요」 — 세션 머리와 같은 코어 낱말. 묻지 않는 세션은 그대로 「실행 중」이다.
    expect(screen.getByTestId(`work-job-state-${S_WAIT}`)).toHaveTextContent(/응답 필요/);
    expect(waiting.props.accessibilityLabel).toContain('응답 필요');
    expect(screen.getByTestId(`work-job-state-${S_MAC}`)).toHaveTextContent(/실행 중/);
    expect(screen.getByTestId(`work-job-state-${S_MAC}`)).not.toHaveTextContent(/응답 필요/);
  });

  it('내 대기 승인이 걸린 run 도 같은 구간이다 — 인박스 알약과 같은 원장(수리 M1)', async () => {
    installFetch({hosts: [host(true)], approvals: [MY_PENDING_APPROVAL]});
    renderShell();
    await openWorkList();

    await waitFor(
      () => expect(screen.getByText(`${WORK_JOBS_COPY.sectionNeedsMe} 2`)).toBeTruthy(),
      SETTLE,
    );
    const rows = screen
      .getAllByTestId(/^work-job-row-/)
      .map(node => String(node.props.testID).replace('work-job-row-', ''));
    // 구간 안은 서버 순서(마지막 활동 최신순)다.
    expect(rows).toEqual(['RUN-APPROVAL', S_WAIT, S_MAC]);
    const headers = screen
      .getAllByText(/^(응답 필요|지금|끝난 일) \d+$/)
      .map(node => node.props.children);
    expect(headers).toEqual([`${WORK_JOBS_COPY.sectionNeedsMe} 2`, `${WORK_JOBS_COPY.sectionNow} 1`]);
    // run 줄은 자기 말(승인 필요 · 승인은 그 카드에서 해요)을 그대로 쓴다 — 맥 세션의 「권한 요청」 말을 빌리지 않는다.
    const run = screen.getByTestId('work-job-row-RUN-APPROVAL');
    expect(within(run).getByText(WORK_JOBS_COPY.approvalHint)).toBeTruthy();
    expect(within(run).queryByText(WORK_JOBS_COPY.permissionHint)).toBeNull();
  });

  it('세션 줄에는 맥 점이 서고, 줄 라벨이 그 맥의 이름과 연결됨·연결 안 됨을 말로 한다 — run 줄에는 점이 없다', async () => {
    installFetch({hosts: [host(false)]});
    renderShell();
    await openWorkList();

    await waitFor(
      () =>
        expect(screen.getByTestId(`work-job-row-${S_MAC}`).props.accessibilityLabel).toContain(
          '도현 맥북 연결 안 됨',
        ),
      SETTLE,
    );
    // 연결 안 된 맥은 「연결 안 됨」을 글로도 말한다(수리 M5, owner 2026-11-09 낱말) — 속 빈 고리는 같은 줄 「○ 대기」 칩의 고리와 모양이 같다. 맥 이름은 자기 줄이다(L1).
    expect(within(screen.getByTestId(`work-job-row-${S_MAC}`)).getByText('도현 맥북 · 연결 안 됨')).toBeTruthy();
    // 점은 낭독에서 빠진다(`StatusDot`) — 찾을 때 숨은 요소까지 본다. 꺼짐은 속 빈 고리다(면 = `surface`, 선 = `textFaint`).
    const dot = within(screen.getByTestId(`work-job-row-${S_MAC}`)).getByTestId('status-dot', HIDDEN_TOO);
    expect(dot.props.accessibilityElementsHidden).toBe(true);
    expect(
      within(screen.getByTestId('work-job-row-RUN-APPROVAL')).queryByTestId('status-dot', HIDDEN_TOO),
    ).toBeNull();
  });
});

describe('④ 「내 맥에 보내기」가 세션을 찾으면 그 세션 화면으로 바로 간다', () => {
  it('시트의 부름이 작업 목록 위의 세션 화면을 세운다 — 셸의 마지막 읽기가 「꺼짐」이어도(보내기 성공이 곧 켜진 맥) · 뒤로는 작업 목록', async () => {
    // 셸이 마지막으로 읽은 호스트 목록은 꺼짐이다(60초 박자 사이에 맥이 켜졌다). 보내기는 서버가 그 맥이 켜져 있음을
    // 확인한 뒤에야 성공하므로(꺼져 있으면 409 `work_host_offline`) 이 길은 셸의 판정을 묻지 않는다.
    installFetch({hosts: [host(false)]});
    renderShell([host(false)]);
    await waitFor(() => expect(screen.getByTestId('shell-plus')).toBeTruthy(), SETTLE);
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    fireEvent.press(screen.getByTestId('stub-ai-ask-mac'));
    fireEvent.press(screen.getByTestId('stub-ask-mac-found'));

    await waitFor(() => expect(screen.getByTestId('work-detail-pane')).toBeTruthy(), SETTLE);
    await waitFor(
      () =>
        expect(screen.getByTestId('work-detail-title')).toHaveTextContent('릴레이 재시작 절차'),
      SETTLE,
    );
    fireEvent.press(screen.getByLabelText('작업 목록으로'));
    await waitFor(() => expect(screen.queryByTestId('work-detail-pane')).toBeNull());
    expect(screen.getByTestId('work-list-pane')).toBeTruthy();
  });
});
