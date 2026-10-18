import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
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
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import * as surfaces from '@momo/core/features/capabilities/serverSurfaces';
import {
  PHONE_APP_BLOCKED_SENTENCE,
  PHONE_APP_WEB_ACTION,
  PHONE_APPS_COPY,
} from '@momo/core/features/plugins/phoneApps';
import {INITIAL_NAV, navReducer, type NavState} from '../src/nav/state';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';
import {AppsView} from '../src/screens/AppsScreen';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {__resetSpawnPort} from '../src/features/work/ask/spawnPort';

// =============================================================================
// U-4 #3951 — 폰 「앱」 읽기 화면 · 폰 허용 경로 · `plugin.install` 카드 폰 렌더.
//
// 가짜는 `fetch`(로스터·앱 목록·앱 상세)와 `Linking.openURL`뿐이다. 진입 줄·층 쌓기·화면·막힘
// 문장·「웹에서 열기」는 진짜다.
//
// ## 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다. PR 본문에 원문)
//
//   ① 진입 줄 게이트        `aiSheetSections.apps` 를 `true` 로 고정하면 「표면 없음」 시험이 붉어진다.
//   ② 층 쌓기·뒤로          `navReducer` 의 `back` 에서 앱 상세→목록 분기를 지우면 붉어진다.
//   ③ 막힘 문장·링크        `AppDetailScreen` 의 `blocked` 판정을 거짓으로 고정하면 붉어진다.
//   ④ 링크의 section id     `appsOnWebPath` 가 경로를 돌려주면 「section=plugins」 단정이 붉어진다.
//   ⑤ 설치 컨트롤 부재      상세에 설치 단추를 하나 세우면 「버튼은 뒤로가기 말고 없다」가 붉어진다.
//   ⑥ 서버 미제공           `serverSaysAbsent` 분기를 지우면 404 시험이 붉어진다.
//   ⑦ 카드 렌더             `isWorkspaceWideAction` 이 `plugin.install` 을 설정 액션으로 읽으면 「전체 줄 없음」이 붉어진다.
//   ⑧ 웹 모델과 같은 글자    코어 `riskLabel` 한 글자를 바꾸면 웹 parity 시험이 붉어진다(`phoneAppsParity.test.ts`).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HELPER = 'cccccccc-1111-4111-8111-cccccccccc01';
const BASE = 'https://api.example.com';
const GITHUB = 'com.momo.plugins.github';
const NOTION = 'com.momo.plugins.notion';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ITEM = {
  version: '1.0.0',
  official: true,
  recommended: true,
  recommendedFor: [],
  installed: true,
  enabled: true,
};
const GITHUB_ITEM = {
  ...ITEM,
  pluginId: GITHUB,
  name: 'GitHub',
  description: 'Official GitHub hosted MCP integration',
  egressDomains: ['api.githubcopilot.com'],
};
const NOTION_ITEM = {
  ...ITEM,
  pluginId: NOTION,
  name: 'Notion',
  description: 'Official Notion hosted MCP integration',
  egressDomains: ['mcp.notion.com'],
};

function detailWire(item: typeof GITHUB_ITEM, tools: unknown[], tiers: Record<string, string>) {
  const {recommended: _r, ...rest} = item;
  return {
    plugin: {
      ...rest,
      manifest: {
        plugin: {publisher: {name: '공식', verified: true}, license: {spdx: 'MIT'}},
        mcp: {tools},
        momo: {approvalTier: tiers},
      },
    },
  };
}

const GITHUB_TOOLS = [
  {name: 'github.list_issues', description: '이슈 목록 읽기', scopes: ['issues:read'], risk: 'read'},
  {name: 'github.create_issue', description: '이슈 만들기', scopes: ['issues:write'], risk: 'write'},
];
const GITHUB_TIERS = {
  'github.list_issues': 'read_only',
  'github.create_issue': 'network_write',
};
const NOTION_TOOLS = [
  {name: 'notion.search', description: '페이지 찾기', scopes: ['pages:read'], risk: 'read'},
];

let pluginsStatus = 200;
let toolPolicy: unknown[] = [
  {pluginId: GITHUB, tools: [{name: 'github.list_issues', risk: 'read', approvalTier: 'read_only'}]},
];

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/plugins/')) {
      if (pluginsStatus !== 200) return reply(pluginsStatus, {});
      return url.includes(NOTION)
        ? reply(200, detailWire(NOTION_ITEM, NOTION_TOOLS, {'notion.search': 'read_only'}))
        : reply(200, detailWire(GITHUB_ITEM, GITHUB_TOOLS, GITHUB_TIERS));
    }
    if (url.endsWith('/plugins')) {
      if (pluginsStatus !== 200) return reply(pluginsStatus, {});
      return reply(200, {plugins: [GITHUB_ITEM, NOTION_ITEM], toolPolicy: {plugins: toolPolicy}});
    }
    if (url.includes('/roster')) return reply(200, {members: []});
    if (url.includes('/work-sessions')) return reply(200, {workSessions: []});
    if (url.includes('/work-hosts')) return reply(200, {workHosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return reply(200, {
        channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/read-state')) return reply(200, {read_states: []});
    if (url.includes('/messages')) return reply(200, {messages: []});
    if (url.includes('/approvals')) return reply(200, {approvals: []});
    if (url.includes('/pins')) return reply(200, {pins: []});
    return reply(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

async function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

async function openAppsList() {
  fireEvent.press(screen.getByTestId('shell-plus'));
  fireEvent.press(screen.getByTestId('plus-menu-ai'));
  fireEvent.press(screen.getByTestId('ai-row-apps'));
  await waitFor(() => expect(screen.getByTestId('apps-list-pane')).toBeTruthy());
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let openURL: jest.SpyInstance;

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
  pluginsStatus = 200;
  toolPolicy = [
    {pluginId: GITHUB, tools: [{name: 'github.list_issues', risk: 'read', approvalTier: 'read_only'}]},
  ];
  __resetSpawnPort();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

// ---- 층 쌓기 -----------------------------------------------------------------------------

describe('층 쌓기 (nav)', () => {
  const open = (state: NavState = INITIAL_NAV) => navReducer(state, {type: 'openAppsList'});

  it('목록 → 상세 → 뒤로 → 목록 → 뒤로 → 닫힘, 한 겹씩', () => {
    let state = open();
    expect(state.apps).toEqual({kind: 'list'});
    state = navReducer(state, {type: 'openApp', pluginId: GITHUB, name: 'GitHub'});
    expect(state.apps).toEqual({kind: 'detail', pluginId: GITHUB, name: 'GitHub'});
    state = navReducer(state, {type: 'back'});
    expect(state.apps).toEqual({kind: 'list'});
    state = navReducer(state, {type: 'back'});
    expect(state.apps).toBeNull();
  });

  it('에이전트 쪽 층과 배타적이다', () => {
    const apps = open();
    expect(navReducer(apps, {type: 'openAgentList'}).apps).toBeNull();
    expect(navReducer(apps, {type: 'openWorkList'}).apps).toBeNull();
    expect(navReducer(apps, {type: 'openHostedList'}).apps).toBeNull();
    const agents = navReducer(INITIAL_NAV, {type: 'openAgentList'});
    expect(navReducer(agents, {type: 'openAppsList'})).toMatchObject({
      apps: {kind: 'list'},
      agentList: false,
    });
  });
});

// ---- 진입 줄 ------------------------------------------------------------------------------

describe('AI 시트의 「앱」 줄', () => {
  it('서버가 앱 목록을 싣고 있으면 「외부 연결」 구획에 「앱」 한 줄이 선다', async () => {
    installFetch();
    await renderShell();
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    const section = screen.getByTestId('ai-section-external');
    expect(within(section).getByText('외부 연결')).toBeTruthy();
    expect(within(screen.getByTestId('ai-row-apps')).getByText('앱')).toBeTruthy();
  });

  it('표면이 없는 서버에서는 줄도 구획도 없다 (옛 서버 화면 변화 0)', async () => {
    const real = surfaces.isSurfaceProvided;
    jest
      .spyOn(surfaces, 'isSurfaceProvided')
      .mockImplementation(id => (id === 'plugins' ? false : real(id)));
    installFetch();
    await renderShell();
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    expect(screen.getByTestId('ai-section-agents')).toBeTruthy();
    expect(screen.queryByTestId('ai-row-apps')).toBeNull();
    expect(screen.queryByTestId('ai-section-external')).toBeNull();
  });
});

// ---- 목록 · 상세 · 허용 경로 ----------------------------------------------------------------

describe('앱 읽기 화면 (진짜 셸)', () => {
  it('목록: 줄마다 연결 상태 칩, 위에 「보기와 승인만」 한 줄', async () => {
    installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId(`apps-row-${GITHUB}`)).toBeTruthy());
    expect(screen.getByTestId(`apps-row-chip-${GITHUB}`)).toHaveTextContent('설치됨 · 내가 허용함');
    expect(screen.getByTestId(`apps-row-chip-${NOTION}`)).toHaveTextContent('설치됨 · 내 허용 없음');
    expect(screen.getByTestId('apps-readonly-note')).toHaveTextContent(PHONE_APPS_COPY.readonlyNote);
    // 이 층은 읽기다: 설치·허용 단추가 없다.
    expect(screen.queryByText(/설치하기|허용하기|회수|항상 허용/)).toBeNull();
  });

  it('내가 허용한 앱의 상세: 막힘 문장도 「웹에서 열기」도 없고, 설치 컨트롤도 없다', async () => {
    installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId(`apps-row-${GITHUB}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`apps-row-${GITHUB}`));
    await waitFor(() => expect(screen.getByTestId('app-detail-tools')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('app-detail-chip')).toBeTruthy());
    expect(screen.queryByTestId('app-detail-blocked')).toBeNull();
    expect(screen.queryByText(PHONE_APP_WEB_ACTION)).toBeNull();
    // 내가 허용한 도구에만 「내가 허용함」이 붙는다 — 선언된 도구와 허용된 도구는 다른 사실이다.
    expect(screen.getByTestId('app-detail-tool-allowed-github.list_issues')).toBeTruthy();
    expect(screen.queryByTestId('app-detail-tool-allowed-github.create_issue')).toBeNull();
    // 쓰기 도구가 있으니 승인 카드 한 줄, 「항상 허용」은 없다.
    expect(screen.getByTestId('app-detail-write-note')).toHaveTextContent(PHONE_APPS_COPY.writeNote);
    // 눌리는 것은 뒤로가기 하나뿐이다.
    expect(screen.getAllByRole('button').map(b => b.props.testID)).toEqual(['header-back']);
    expect(screen.queryByText(/설치하기|허용하기|회수/)).toBeNull();
    expect(within(screen.getByTestId('app-detail-egress')).getByText('api.githubcopilot.com')).toBeTruthy();
  });

  it('허용하지 않은 앱의 상세: 막힘 문장 하나 + 「웹에서 열기」 하나, 누르면 section id 로 연다', async () => {
    installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId(`apps-row-${NOTION}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`apps-row-${NOTION}`));
    await waitFor(() => expect(screen.getByTestId('app-detail-blocked')).toBeTruthy());
    expect(screen.getByTestId('app-detail-blocked-sentence')).toHaveTextContent(
      PHONE_APP_BLOCKED_SENTENCE,
    );
    expect(screen.getAllByTestId('app-detail-open-web')).toHaveLength(1);
    expect(screen.getByText(PHONE_APP_WEB_ACTION)).toBeTruthy();
    expect(screen.getAllByRole('button').map(b => b.props.testID)).toEqual([
      'header-back',
      'app-detail-open-web',
    ]);
    fireEvent.press(screen.getByTestId('app-detail-open-web'));
    expect(openURL).toHaveBeenCalledTimes(1);
    const url = String(openURL.mock.calls[0][0]);
    expect(url).toBe(`${BASE}/settings?section=plugins`);
    expect(url).not.toContain('/ai/external/apps');
  });

  it('뒤로: 상세 → 목록 → 셸', async () => {
    installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId(`apps-row-${NOTION}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`apps-row-${NOTION}`));
    await waitFor(() => expect(screen.getByTestId('apps-detail-pane')).toBeTruthy());
    fireEvent.press(within(screen.getByTestId('apps-detail-pane')).getByTestId('header-back'));
    expect(screen.queryByTestId('apps-detail-pane')).toBeNull();
    expect(screen.getByTestId('apps-list-pane')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('apps-list-pane')).getByTestId('header-back'));
    expect(screen.queryByTestId('apps-list-pane')).toBeNull();
  });

  it('서버가 앱 경로를 모른다(404) → 장애가 아니라 「이 서버에는 없다」 고지', async () => {
    pluginsStatus = 404;
    installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId('apps-absent')).toBeTruthy());
    expect(
      within(screen.getByTestId('apps-absent')).getByText(
        surfaces.serverSurface('plugins').absentReason,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('apps-error')).toBeNull();
  });

  it('서버가 아프다(500) → 오류 상태 + 다시 시도', async () => {
    pluginsStatus = 500;
    const mock = installFetch();
    await renderShell();
    await openAppsList();
    await waitFor(() => expect(screen.getByTestId('apps-error')).toBeTruthy());
    const before = mock.mock.calls.filter(c => String(c[0]).endsWith('/plugins')).length;
    pluginsStatus = 200;
    await act(async () => {
      fireEvent.press(within(screen.getByTestId('apps-error')).getByText('다시 시도'));
    });
    await waitFor(() => expect(screen.getByTestId(`apps-row-${GITHUB}`)).toBeTruthy());
    expect(mock.mock.calls.filter(c => String(c[0]).endsWith('/plugins')).length).toBeGreaterThan(before);
  });
});

// ---- 네 상태(순수 표현부) ------------------------------------------------------------------

describe('목록의 네 상태 + 오프라인', () => {
  const base = {
    rows: [],
    offline: false,
    onBack: () => {},
    onRetry: () => {},
    onOpenApp: () => {},
  };

  it('로딩 · 빈 목록 · 오류 · 미제공이 서로 다른 모습이다', () => {
    const view = render(<AppsView {...base} state="loading" />);
    expect(screen.getByTestId('apps-loading')).toBeTruthy();
    view.rerender(<AppsView {...base} state="ready" />);
    expect(screen.getByTestId('apps-empty')).toBeTruthy();
    expect(screen.getByText(PHONE_APPS_COPY.emptyHeadline)).toBeTruthy();
    view.rerender(<AppsView {...base} state="error" />);
    expect(screen.getByTestId('apps-error')).toBeTruthy();
    view.rerender(<AppsView {...base} state="absent" />);
    expect(screen.getByTestId('apps-absent')).toBeTruthy();
  });

  it('오프라인이면 캐시임을 말하고 마지막으로 읽은 때를 붙인다', () => {
    render(<AppsView {...base} state="ready" offline staleAtMs={Date.now() - 60_000} />);
    const note = within(screen.getByTestId('apps-offline'));
    expect(note.getByText(PHONE_APPS_COPY.offline)).toBeTruthy();
    expect(note.getByText(/^마지막으로 읽은 때:/)).toBeTruthy();
  });

  it('오프라인 고지는 로딩 중에는 서지 않는다 (읽은 적 없는 캐시를 말하지 않는다)', () => {
    render(<AppsView {...base} state="loading" offline />);
    expect(screen.queryByTestId('apps-offline')).toBeNull();
  });
});

// ---- plugin.install · 권한 카드의 폰 렌더 (#3893 범위 대조) ----------------------------------

describe('plugin.install 승인 카드 · 결과 카드 (폰 렌더, #3893 대조)', () => {
  const BASE_MS = 1_760_000_000_000;
  const DIRECTORY = makeDirectory([
    {
      id: SELF_ID, workspaceId: WS, kind: 'human', status: 'active', displayName: '곽성재',
      handle: 'seongjae', channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
    },
    {
      id: HELPER, workspaceId: WS, kind: 'agent', status: 'active', displayName: 'oort 도우미',
      handle: 'oort-helper', channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
    },
  ] as RosterMember[]);

  function message(over: Partial<Message>): Message {
    return {
      id: '0199aa11-2222-7000-8000-0000000007b1',
      channelId: 'ch-general',
      seq: 10,
      hlcTs: 10,
      hlcCount: 0,
      authorMemberId: HELPER,
      type: 'text',
      body: null,
      state: 'sent',
      createdAtMs: BASE_MS,
      ...over,
    } as unknown as Message;
  }

  function renderRow(msg: Message) {
    const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    return render(
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <MessageRow
            message={msg}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={BASE_MS}
            approvalsProvided
            actions={{
              myMemberId: SELF_ID,
              workspaceId: WS,
              onToggleReaction: async () => {},
              onEdit: async () => {},
              onDelete: async () => {},
            }}
          />
        </SessionProvider>
      </QueryClientProvider>,
    );
  }

  // 서버 `plugin_install_rows`·`plugin_install_summary`(momo-agent actions.rs 시험)의 글자 그대로.
  const INSTALL_PROPS = {
    approval_id: '0199aa11-2222-7000-8000-0000000007a1',
    action_type: 'workspace_action',
    status: 'pending',
    title: '앱 설치',
    action: {
      id: 'plugin.install',
      rows: [
        {label: '앱', value: 'GitHub 1.0.0'},
        {label: '연결 대상', value: 'api.githubcopilot.com'},
        {label: '상태', value: '설치 안 됨 → 설치됨(켜짐)'},
        {label: '연결', value: '각자 설정의 앱 화면에서 내 권한을 직접 허용해요'},
      ],
      summary:
        '에이전트가 제안했어요. 승인하면 관리자 권한으로 워크스페이스에 GitHub 앱을 설치해요. 토큰은 oort에 저장하지 않아요.',
      rationale: 'GitHub 이슈를 읽어 달라고 했어요',
      required_role: 'admin',
    },
  };

  it('승인 카드: 앱·연결 대상·상태 행이 그대로 서고, 필요한 역할을 말한다', () => {
    renderRow(message({type: 'approval_request', props: INSTALL_PROPS}));
    const card = screen.getByTestId('agent-card');
    expect(within(card).getByText('GitHub 1.0.0')).toBeTruthy();
    expect(within(card).getByText('api.githubcopilot.com')).toBeTruthy();
    expect(within(card).getByText('설치 안 됨 → 설치됨(켜짐)')).toBeTruthy();
    expect(within(card).getByText('각자 설정의 앱 화면에서 내 권한을 직접 허용해요')).toBeTruthy();
    expect(within(card).getByText('앱 설치')).toBeTruthy();
  });

  it('승인 카드는 「워크스페이스 전체」 줄을 달지 않는다 — 설정 액션 넷에만 서는 줄이다', () => {
    renderRow(message({type: 'approval_request', props: INSTALL_PROPS}));
    expect(screen.queryByTestId('approval-workspace-wide')).toBeNull();
  });

  it('결과 카드: 설치했다는 사실 행과 다음 행동 문장, 토큰·비밀 줄은 없다', () => {
    renderRow(
      message({
        type: 'tool_result',
        body: 'GitHub 앱을 설치했어요',
        props: {
          'momo.action_result': {
            v: 1,
            action_id: 'plugin.install',
            status: 'executed',
            approval_id: INSTALL_PROPS.approval_id,
            decided_by: SELF_ID,
            rows: [
              {label: '앱', value: 'GitHub 1.0.0'},
              {label: '연결 대상', value: 'api.githubcopilot.com'},
              {label: '다음', value: '각자 설정의 앱 화면에서 내 권한을 허용하면 에이전트가 써요'},
            ],
            secret_shown_once: false,
          },
        },
      }),
    );
    const card = screen.getByTestId('agent-card');
    expect(within(card).getByText('GitHub 1.0.0')).toBeTruthy();
    expect(within(card).getByText('각자 설정의 앱 화면에서 내 권한을 허용하면 에이전트가 써요')).toBeTruthy();
    expect(screen.queryByTestId('action-result-secret-once')).toBeNull();
  });
});
