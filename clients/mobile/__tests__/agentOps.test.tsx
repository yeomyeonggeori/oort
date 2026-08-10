import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 「에이전트」 — 폰에서 에이전트를 부린다 (goal RN-A1).
//
// Everything below the `fetch` mock is real: the core's decoders, the core's
// agent judgements, the react-query wiring, the pure row model, the views. What
// is faked is one thing — what the server answered — and the shapes it answers
// with are `server-rust`'s own, measured 2026-08-03:
//
//   * a roster row CARRIES pause state (goal SRV-R2), so 상태 costs no request at
//     all — and against a server whose roster predates that field the list says
//     상태를 볼 수 없음 rather than guessing (`ROSTER_WITHOUT_PAUSED`);
//   * a work session carries `hostId` and nothing else about the machine, so the
//     ADR-0137 D5 host tier is a join against `GET …/work-hosts`;
//   * `PUT …/agents/{id}/pause` answers with the whole stored profile.
//
// The roster is the awkward one again: two 김인턴, one human and one agent.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const HERMES = 'dddddddd-1111-4111-8111-dddddddddddd';
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

function rosterMember(over: Record<string, unknown>): Record<string, unknown> {
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

/**
 * 명부가 답하는 모양 (goal SRV-R2). `paused`는 **에이전트 행에만** 실린다 —
 * 사람에게는 그런 상태가 없고, 서버는 `CASE WHEN m.kind = 'agent'`로 그것을
 * 인코딩한다. 사람 행에 이 키를 넣지 않는 것이 이 픽스처의 요점 중 하나다.
 */
const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({
    id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    displayName: '김인턴',
    handle: 'intern-kim',
  }),
  rosterMember({
    id: KIM_AGENT,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
    channelCount: 2,
    channelIds: ['ch-general', 'ch-secret'],
    agentModel: 'gpt-5.6',
    paused: false,
  }),
  rosterMember({
    id: HERMES,
    kind: 'agent',
    displayName: '헤르메스',
    handle: 'hermes',
    paused: false,
  }),
];

/**
 * 같은 명부에서 `paused`만 빠진 것 — `paused` 프로젝션 이전의 서버.
 *
 * 이 배열이 있는 이유는 goal RN-C1이 목록의 프로필 N+1을 걷어냈기 때문이다. 그
 * 전에는 에이전트당 403이 「상태를 볼 수 없음」을 만들었는데, 이제 그 문장이 나오는
 * 자리는 **명부가 그 사실을 싣지 않는 서버**뿐이다. 그 갈래가 사라지지 않았음을
 * 이것으로 잠근다 — 모르는 것을 「활성」으로 채우는 순간이 이 화면이 조용히
 * 거짓말을 시작하는 순간이다.
 */
const ROSTER_WITHOUT_PAUSED = ROSTER.map(member => {
  const copy: Record<string, unknown> = {...member};
  delete copy.paused;
  return copy;
});

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

const PROFILE = {
  agentMemberId: KIM_AGENT,
  workspaceId: WS,
  instructions: '검증 없이 머지하지 않는다.',
  modelPref: 'claude-opus-5',
  enabledTools: [],
  triggers: {mention: true},
  paused: false,
  version: 3,
  updatedBy: SELF_ID,
  updatedAtMs: 1_700_000_000_000,
};

const WORK_SESSIONS = [
  {
    // The agent's own session, on a DESKTOP host: the one that dies if the
    // machine is turned off.
    id: 'SESSION-APP',
    workspaceId: WS,
    channelId: 'ch-general',
    memberId: KIM_AGENT,
    hostId: 'HOST-APP',
    rootMessageId: 'm-1',
    tool: 'codex',
    label: '타임라인 리팩터링',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_700_000_000_000,
  },
  {
    // Same agent, always-on host, still going.
    id: 'SESSION-CLOUD',
    workspaceId: WS,
    channelId: 'ch-general',
    memberId: KIM_AGENT,
    hostId: 'HOST-CLOUD',
    rootMessageId: 'm-2',
    tool: 'claude',
    label: '야간 배치',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_699_000_000_000,
  },
  {
    // Same agent, desktop host, ALREADY OVER. The row that used to warn — in
    // orange — that turning a computer off would stop work that had finished.
    id: 'SESSION-DONE',
    workspaceId: WS,
    channelId: 'ch-general',
    memberId: KIM_AGENT,
    hostId: 'HOST-APP',
    rootMessageId: 'm-4',
    tool: 'codex',
    label: '어제 끝난 작업',
    status: 'ended',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_698_000_000_000,
    endedAtMs: 1_698_000_100_000,
  },
  {
    // Someone else's. Must never appear under this agent.
    id: 'SESSION-HUMAN',
    workspaceId: WS,
    channelId: 'ch-general',
    memberId: SELF_ID,
    hostId: 'HOST-APP',
    rootMessageId: 'm-3',
    tool: 'codex',
    label: '내가 연 세션',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_700_000_000_000,
  },
];

const WORK_HOSTS = [
  {
    id: 'HOST-APP',
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'app',
    displayName: '성재의 맥',
    publicKey: 'k',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'HOST-CLOUD',
    workspaceId: WS,
    scope: 'workspace',
    ownerMemberId: SELF_ID,
    type: 'cloud',
    displayName: 'oort 클라우드',
    publicKey: 'k',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface RouteOverrides {
  /** 이 서버의 명부. 기본은 `paused`를 싣는 현행 서버다. */
  roster?: () => Response | Promise<Response>;
  profile?: (agentId: string) => Response | Promise<Response>;
  pause?: (body: unknown) => Response | Promise<Response>;
  allowedModels?: () => Response | Promise<Response>;
  workSessions?: () => Response | Promise<Response>;
  workHosts?: () => Response | Promise<Response>;
}

/**
 * What the fixture believes it has stored.
 *
 * The fixture REMEMBERS what was written, because the screen re-reads the
 * profile after a successful pause (`onSettled` invalidates). A mock that kept
 * answering `paused: false` would make the switch snap back a moment later, and
 * the test would be asserting the fixture's amnesia rather than the client.
 */
let storedPaused = PROFILE.paused;

function setStoredPaused(value: boolean): void {
  storedPaused = value;
}

function installFetch(overrides: RouteOverrides = {}): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pause')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (overrides.pause) return overrides.pause(body);
      setStoredPaused(body.paused);
      return jsonResponse(200, {profile: {...PROFILE, paused: storedPaused, version: 4}});
    }
    if (url.includes('/allowed-models')) {
      return overrides.allowedModels
        ? overrides.allowedModels()
        : jsonResponse(200, {allowedAgentModels: ['claude-opus-5', 'gpt-5.6']});
    }
    if (url.includes('/profile')) {
      const agentId = url.split('/agents/')[1].split('/')[0];
      if (overrides.profile) return overrides.profile(agentId);
      // Only 김인턴 is one this person may read. 헤르메스 answers 403, which is
      // a PERMISSION and not a fault — the exact case the roster cannot express.
      return agentId === KIM_AGENT
        ? jsonResponse(200, {profile: {...PROFILE, paused: storedPaused}})
        : jsonResponse(403, {error: {message: 'agent owner or workspace admin required'}});
    }
    if (url.includes('/work-sessions')) {
      return overrides.workSessions
        ? overrides.workSessions()
        : jsonResponse(200, {workSessions: WORK_SESSIONS});
    }
    if (url.includes('/work-hosts')) {
      return overrides.workHosts
        ? overrides.workHosts()
        : jsonResponse(200, {workHosts: WORK_HOSTS});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) {
      return overrides.roster
        ? overrides.roster()
        : jsonResponse(200, {members: ROSTER});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/dms')) {
      return jsonResponse(200, {
        channel: {
          id: 'ch-dm-kim',
          workspaceId: WS,
          kind: 'dm',
          muted: false,
          memberIds: [SELF_ID, KIM_AGENT],
        },
        created: true,
      });
    }
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

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

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  storedPaused = PROFILE.paused;
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

async function openAgentsTab() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-agents'));
  await waitFor(() => expect(screen.getByTestId('agents-list')).toBeTruthy());
}

describe('the 에이전트 tab exists at all', () => {
  it('is the third tab, and does not fetch anything until it is opened', async () => {
    // The whole point of the lazy mount: a person who never opens this tab must
    // not pay for the ledger, the host registry and one profile read per agent.
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.getByTestId('tab-agents')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/work-sessions')),
    ).toBe(false);

    fireEvent.press(screen.getByTestId('tab-agents'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/work-sessions')),
      ).toBe(true),
    );
  });

  it('lists the agents from the ROSTER, and no humans', async () => {
    installFetch();
    await openAgentsTab();
    // Both agents, neither human. 김인턴 appears once here even though the
    // workspace holds two of them, because the human one is not an agent.
    expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).toBeTruthy();
    expect(screen.getByTestId(`agent-row-${HERMES}`)).toBeTruthy();
    expect(screen.queryByText('곽성재')).toBeNull();
    expect(screen.getAllByText('김인턴')).toHaveLength(1);
  });
});

describe('a row says what state the agent is in', () => {
  it('names 활성, the channels it is in, and the ledger it read', async () => {
    const fetchMock = installFetch();
    await openAgentsTab();
    // 명부가 상태를 실어 주므로 목록은 프로필을 **한 번도** 읽지 않는다
    // (goal RN-C1). 예전에는 에이전트당 한 번이었고, 일반 멤버에게는 그 한 번이
    // 전부 403이었다.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/profile')),
    ).toHaveLength(0);
    // 상태는 명부와 함께 **이미** 와 있다 — 기다릴 것은 원장(ledger)뿐이다.
    // 예전에는 프로필 왕복이 그 대기를 대신 만들어 줬고, 그것이 사라지면서
    // 이 `waitFor`의 대상도 실제로 늦게 오는 것으로 바뀌었다.
    expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).toHaveTextContent(/활성/);
    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).toHaveTextContent(
        /작업 세션 2개 실행 중/,
      ),
    );
    const row = screen.getByTestId(`agent-row-${KIM_AGENT}`);
    // Two of this agent's three sessions are running; the finished one is not
    // counted. And the word is 작업 세션, never the web's 작업 중 — see below.
    expect(row).toHaveTextContent(/#general/);
    // ch-secret is a membership this client cannot name; it is COUNTED, never
    // dropped and never invented (`channelPlacement.unresolved`).
    expect(row).toHaveTextContent(/그 밖에 1곳/);
  });

  it('does not call the session ledger 「작업 중」 (R1 High-2)', async () => {
    // Web's 작업 중 means an OPEN TURN on the realtime rail, and it explicitly
    // excludes a turn parked on an approval. Measured on server-rust: a
    // work_session stays `running` for the whole duration of an approval hold
    // (no FK between work_session and agent_run; approvals write neither), so
    // borrowing the word would claim an agent is working while it waits on a
    // person — the exact thing the web module forbids.
    installFetch();
    await openAgentsTab();
    const row = screen.getByTestId(`agent-row-${KIM_AGENT}`);
    await waitFor(() => expect(row).toHaveTextContent(/세션 실행 중/));
    expect(row).not.toHaveTextContent(/작업 중/);
  });

  it('says 일시정지 when the ROSTER says so, without asking anything else', async () => {
    // 이 단정은 goal RN-C1에서 **고쳐졌지, 지워지지 않았다.** 예전에는 같은
    // 사실을 `GET …/agents/{id}/profile`에서 읽었다. 컬럼도 값도 그대로이고,
    // 바뀐 것은 그것이 이미 손에 있는 목록에 실려 온다는 것뿐이다.
    const fetchMock = installFetch({
      roster: () =>
        jsonResponse(200, {
          members: ROSTER.map(member =>
            member.id === KIM_AGENT ? {...member, paused: true} : member,
          ),
        }),
    });
    await openAgentsTab();
    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).toHaveTextContent(
        /일시정지/,
      ),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/profile')),
    ).toHaveLength(0);
  });

  it('읽을 수 없는 paused 는 필드만 버리고 행은 남긴다 (2R M4)', async () => {
    // 이 goal의 첫 판은 불리언이 아닌 `paused`를 만나면 **행 전체를 버렸다**.
    // 컬럼 하나를 못 읽는 것과 그 멤버가 없는 것은 같은 진술이 아니고, 후자는
    // 훨씬 큰 거짓말이다 — 목록은 「아직 에이전트가 없습니다」라고 말하게 되고,
    // 바로 거기 있는 에이전트가 화면에서 사라진다.
    //
    // 필드만 버리면 이미 있는 갈래로 착지한다: 명부가 그 사실을 싣지 않은 것과
    // 같은 자리, 즉 「상태를 볼 수 없음」이다. 절대 일어나면 안 되는 것은 문자열
    // `"false"`가 truthy로 살아남는 것뿐이다.
    installFetch({
      roster: () =>
        jsonResponse(200, {
          members: ROSTER.map(member =>
            member.id === KIM_AGENT ? {...member, paused: 'false'} : member,
          ),
        }),
    });
    await openAgentsTab();
    const row = screen.getByTestId(`agent-row-${KIM_AGENT}`);
    expect(row).toBeTruthy();
    expect(row).toHaveTextContent(/상태를 볼 수 없음/);
    // 그리고 「활성」도 「일시정지」도 아니다 — 읽지 못한 것을 어느 쪽으로도 접지
    // 않는다.
    expect(row).not.toHaveTextContent(/활성/);
    expect(row).not.toHaveTextContent(/일시정지/);
  });

  it('says 상태를 볼 수 없음 when the roster does not carry the fact', async () => {
    // 예전에는 이 문장이 **403 때문에** 나왔다(에이전트당 한 번의 거절). 이제
    // 그 문장이 나오는 자리는 명부가 `paused`를 싣지 않는 서버 하나뿐이고,
    // 여기서 지키는 것은 같은 성질이다: 모르는 것을 「활성」으로 채우지 않는다.
    // 그리고 모른다고 말하기 위해 요청을 더 쏘지도 않는다.
    const fetchMock = installFetch({
      roster: () => jsonResponse(200, {members: ROSTER_WITHOUT_PAUSED}),
    });
    await openAgentsTab();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/profile')),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${HERMES}`)).toHaveTextContent(
        /상태를 볼 수 없음/,
      ),
    );
  });

  it('says the ledger is missing rather than claiming nothing is running', async () => {
    installFetch({
      workSessions: () => jsonResponse(500, {error: {message: 'boom'}}),
    });
    await openAgentsTab();
    await waitFor(() =>
      expect(screen.getByTestId('agent-sessions-error')).toBeTruthy(),
    );
    expect(screen.getByTestId('agent-sessions-error')).toHaveTextContent(
      /실행 중인 세션만 지금 알 수 없습니다\./,
    );
    // The list itself is unharmed.
    expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});

describe('재우기 / 깨우기', () => {
  async function openKim() {
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() => expect(screen.getByTestId('agent-pause-toggle')).toBeTruthy());
  }

  it('says what pause actually reaches BEFORE the press', async () => {
    installFetch();
    await openKim();
    const effect = screen.getByTestId('agent-pause-effect');
    // Measured on server-rust: pause blocks the three run-CREATION paths and
    // nothing else. A job the gateway already claimed runs to completion —
    // pausing does not reach it, and the way to stop it is the separate cancel
    // route (goal SRV-C2), which is a different act on a different object.
    expect(effect).toHaveTextContent(/새 실행이 시작되지 않습니다/);
    // goal RN-C1에서 고쳐진 단정. 예전 문장은 "이미 실행 중인 작업은 그대로
    // 끝까지 갑니다"였고 두 가지를 뜻했다 — 재우기가 도는 실행에 손대지 않는다는
    // 것과, 멈출 방법이 아예 없다는 것. cancel 라우트가 이식되며 후자만 거짓이
    // 됐으므로 전자를 잠근다.
    expect(effect).toHaveTextContent(/재우기로 멈추지 않습니다/);
    expect(effect).toHaveTextContent(/중단할 수 있습니다/);
    expect(screen.getByTestId('agent-state')).toHaveTextContent('깨어 있습니다');
  });

  it('moves under the thumb, then keeps what the server confirmed', async () => {
    // The request is held open, so what follows can only pass if the switch
    // moved BEFORE the server answered. A `waitFor` against a mock that has
    // already resolved would prove nothing about optimism.
    let answer: (() => void) | null = null;
    const fetchMock = installFetch({
      pause: body =>
        new Promise<Response>(resolve => {
          answer = () => {
            const next = (body as {paused: boolean}).paused;
            setStoredPaused(next);
            resolve(jsonResponse(200, {profile: {...PROFILE, paused: next, version: 4}}));
          };
        }),
    });
    await openKim();

    fireEvent.press(screen.getByTestId('agent-pause-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('agent-state')).toHaveTextContent('자고 있습니다'),
    );
    expect(answer).not.toBeNull();

    answer!();
    await waitFor(() =>
      expect(screen.getByTestId('agent-pause-receipt')).toBeTruthy(),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/pause'));
    expect(call![1].method).toBe('PUT');
    expect(JSON.parse(call![1].body)).toEqual({paused: true});
    // The receipt names the agent with the right particle and repeats what
    // changed, rather than saying "저장됨".
    expect(screen.getByTestId('agent-pause-receipt')).toHaveTextContent(
      /김인턴을 재웠습니다\./,
    );
    expect(screen.getByTestId('agent-pause-toggle')).toHaveTextContent('깨우기');
  });

  it('puts the switch BACK when the server refuses, and says why in Korean', async () => {
    installFetch({
      pause: () =>
        jsonResponse(403, {
          error: {message: 'agent owner or workspace admin required'},
        }),
    });
    await openKim();

    fireEvent.press(screen.getByTestId('agent-pause-toggle'));
    await waitFor(() => expect(screen.getByTestId('agent-pause-error')).toBeTruthy());
    // Rolled back: the agent is awake again, because it never went to sleep.
    expect(screen.getByTestId('agent-state')).toHaveTextContent('깨어 있습니다');
    expect(screen.getByTestId('agent-pause-error')).toHaveTextContent(
      /재우지 못했습니다\./,
    );
    expect(screen.getByTestId('agent-pause-error')).toHaveTextContent(
      /워크스페이스 관리자나 그 에이전트를 맡은 사람만/,
    );
    // No status code, no server English.
    expect(screen.queryByText(/403/)).toBeNull();
    expect(screen.queryByText(/admin required/)).toBeNull();
  });

  it('「다시 시도」 actually retries, rather than dismissing the banner (R1 High-3)', async () => {
    // The label used to call `reset()`: the sentence vanished and nothing was
    // sent. On the one control in this batch that changes workspace state.
    let attempts = 0;
    const fetchMock = installFetch({
      pause: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(503, {error: {message: 'upstream down'}})
          : jsonResponse(200, {profile: {...PROFILE, paused: true, version: 4}});
      },
    });
    await openKim();

    fireEvent.press(screen.getByTestId('agent-pause-toggle'));
    await waitFor(() => expect(screen.getByTestId('agent-pause-error')).toBeTruthy());
    const before = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/pause'),
    ).length;

    fireEvent.press(screen.getByTestId('agent-pause-error-retry'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/pause')).length,
      ).toBe(before + 1),
    );
    // …and the second attempt is the same act, not its opposite.
    const last = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/pause'))
      .pop();
    expect(JSON.parse(last![1].body)).toEqual({paused: true});
    await waitFor(() => expect(screen.queryByTestId('agent-pause-error')).toBeNull());
  });

  it('offers no switch at all when the state cannot even be read', async () => {
    installFetch();
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${HERMES}`));
    await waitFor(() =>
      expect(screen.getByTestId('agent-state-forbidden')).toBeTruthy(),
    );
    expect(screen.queryByTestId('agent-pause-toggle')).toBeNull();
    // Not drawn as a failure, and with nothing to retry.
    expect(screen.queryByTestId('agent-state-forbidden-retry')).toBeNull();
  });
});

describe('what the agent is doing, and whether you can turn things off', () => {
  async function openKimWork() {
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() => expect(screen.getByTestId('agent-work-list')).toBeTruthy());
  }

  it('shows only this agent’s sessions', async () => {
    installFetch();
    await openKimWork();
    expect(screen.getByTestId('agent-session-SESSION-APP')).toBeTruthy();
    expect(screen.getByTestId('agent-session-SESSION-CLOUD')).toBeTruthy();
    expect(screen.getByTestId('agent-session-SESSION-DONE')).toBeTruthy();
    // The human's session belongs to the human.
    expect(screen.queryByTestId('agent-session-SESSION-HUMAN')).toBeNull();
  });

  it('answers "지금 이거 꺼도 되나" per LIVE row, per ADR-0137 D5', async () => {
    installFetch();
    await openKimWork();
    await waitFor(() =>
      expect(screen.getByTestId('agent-session-tier-SESSION-APP')).toHaveTextContent(
        /컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다/,
      ),
    );
    expect(screen.getByTestId('agent-session-tier-SESSION-CLOUD')).toHaveTextContent(
      /폰을 꺼도 계속됩니다/,
    );
  });

  it('does NOT warn about a session that is already over (R1 High-1)', async () => {
    // This assertion used to say the opposite: the ended cloud session was
    // asserted to promise "폰을 꺼도 계속됩니다" about work that had
    // finished, and an ended desktop session warned in orange that turning a
    // computer off would stop it. The test was locking the defect in.
    installFetch();
    await openKimWork();
    await waitFor(() =>
      expect(screen.getByTestId('agent-session-tier-SESSION-DONE')).toHaveTextContent(
        /끝난 작업입니다\. 지금 무엇을 꺼도 이 작업에는 영향이 없습니다\./,
      ),
    );
    const done = screen.getByTestId('agent-session-tier-SESSION-DONE');
    expect(done).not.toHaveTextContent(/멈춥니다/);
    expect(done).not.toHaveTextContent(/계속됩니다/);
  });

  it('speaks the whole row to VoiceOver, which needs `accessible` (R1 Medium-3)', async () => {
    // A View with a label but no `accessible` is not an accessibility element
    // on iOS, so the assembled sentence was never announced.
    installFetch();
    await openKimWork();
    await waitFor(() =>
      expect(
        screen.getByLabelText(
          /어제 끝난 작업, 종료됨, 데스크톱 앱\. 끝난 작업입니다\./,
        ),
      ).toBeTruthy(),
    );
  });

  it('refuses to answer it when the host registry is not readable', async () => {
    // A session row carries only `hostId`. Without the registry there is no tier
    // to show, and guessing "계속 됩니다" is how someone shuts a laptop on a
    // running job.
    installFetch({workHosts: () => jsonResponse(403, {error: {message: 'nope'}})});
    await openKimWork();
    await waitFor(() =>
      expect(screen.getByTestId('agent-session-tier-SESSION-APP')).toHaveTextContent(
        /무엇을 꺼도 되는지 말할 수 없습니다/,
      ),
    );
  });

  it('sends the terminal to the desktop instead of opening 80 columns here', async () => {
    installFetch();
    await openKimWork();
    expect(screen.getByText('터미널 화면은 데스크톱 앱에서 엽니다.')).toBeTruthy();
  });

  it('calls an empty ledger empty now that the run history is readable', async () => {
    // 이 테스트는 #1223 이전에 정확히 반대를 쟀다: 그때는 읽는 경로가 없어서
    // (POST 전용 경로라 GET 은 405) 빈 목록을 "조용하다"로 부르면 거짓말이었고,
    // 화면은 못 본다는 사실을 먼저 말해야 했다. 이제 경로가 섰으므로 빈 목록은
    // 정말로 비어 있다는 뜻이고, 그 자리에 못 본다는 말이 남아 있으면 그것이
    // 새 거짓말이 된다.
    //
    // 두 문장의 정본은 여전히 코어 하나이고(`noSessionsDetail`), 양쪽 가지는
    // packages/momo-core 의 agentOps.test.ts 가 계속 못으로 박는다 — 표가
    // 되돌아가는 날(또는 더 오래된 서버에 붙는 날) 쓸 문장이라 지우지 않는다.
    installFetch({workSessions: () => jsonResponse(200, {workSessions: []})});
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() => expect(screen.getByTestId('agent-work-empty')).toBeTruthy());
    const empty = screen.getByTestId('agent-work-empty');
    expect(empty).toHaveTextContent(/이 에이전트가 연 작업 세션이 없습니다\./);
    expect(empty).not.toHaveTextContent(/기록을 아직 보여주지 못합니다/);
    // 덧붙일 말이 없으면 덧붙이지 않는다: 코어의 provided=true 문장은 headline 과
    // 같은 문장이라, 그대로 넘기면 한 화면이 같은 말을 두 번 한다.
    expect(screen.queryAllByText('이 에이전트가 연 작업 세션이 없습니다.')).toHaveLength(
      1,
    );
  });
});

describe('the profile, and getting to the conversation', () => {
  it('shows the models the SERVER says are allowed, not a hardcoded list', async () => {
    installFetch();
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() =>
      expect(screen.getByTestId('agent-allowed-models')).toHaveTextContent(
        'claude-opus-5, gpt-5.6',
      ),
    );
    // The effective model is the profile's preference, not the roster default.
    expect(screen.getByTestId('agent-model')).toHaveTextContent('claude-opus-5');
  });

  it('says the list is missing rather than showing an empty one', async () => {
    installFetch({allowedModels: () => jsonResponse(200, {allowedAgentModels: []})});
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() =>
      expect(screen.getByTestId('agent-allowed-models')).toHaveTextContent(
        /고를 수 있는 모델 목록을 주지 않았습니다/,
      ),
    );
  });

  it('opens the DM and comes BACK to the agent, not to the list', async () => {
    installFetch();
    await openAgentsTab();
    fireEvent.press(screen.getByTestId(`agent-row-${KIM_AGENT}`));
    await waitFor(() => expect(screen.getByTestId('agent-open-dm')).toBeTruthy());

    fireEvent.press(screen.getByTestId('agent-open-dm'));
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeTruthy());

    // Two backs are mounted at once — the agent's ("에이전트 목록으로") under the
    // conversation's ("뒤로"). Naming them apart is exactly what `backLabel`
    // exists for: a screen-reader user has to be able to tell which of the two
    // stacked things is about to close.
    fireEvent.press(screen.getByLabelText('뒤로'));
    // One back press lands on the agent's own screen, with its state still there.
    await waitFor(() =>
      expect(screen.getByTestId('agent-detail-title')).toHaveTextContent('김인턴'),
    );
  });
});
