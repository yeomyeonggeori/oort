import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  getPersistedSession,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// The signed-in shell, from the network boundary up.
//
// Everything below the `fetch` mock is real: the core's decoders, the core's
// directory naming, the react-query wiring, the pure row model, the views. What
// is faked is one thing — what the server answered — which is the only thing this
// batch is not allowed to reach (실서버 접속은 오케스트레이터의 몫).
//
// The roster is again the awkward one: two 김인턴, one human and one agent.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
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
  rosterMember({
    id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    displayName: '김인턴',
    handle: 'intern-kim',
  }),
  rosterMember({
    id: 'cccccccc-1111-4111-8111-cccccccccccc',
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
  }),
  rosterMember({
    id: 'dddddddd-1111-4111-8111-dddddddddddd',
    kind: 'agent',
    displayName: '헤르메스',
    handle: 'hermes',
  }),
];

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {
    id: 'ch-archive',
    workspaceId: WS,
    kind: 'public',
    name: 'old-stuff',
    muted: false,
    archivedAtMs: 1_700_000_000_000,
  },
  {
    id: 'ch-dm-human',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    memberIds: [SELF_ID, 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'],
  },
];

const READ_STATES = [
  {
    channel_id: 'ch-general',
    last_read_seq: 10,
    latest_seq: 13,
    unread_count: 3,
    mention_count: 1,
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
  channels?: () => Response | Promise<Response>;
  roster?: () => Response | Promise<Response>;
  readState?: () => Response | Promise<Response>;
  messages?: () => Response | Promise<Response>;
  dms?: () => Response | Promise<Response>;
  approvals?: () => Response | Promise<Response>;
}

function installFetch(overrides: RouteOverrides = {}): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    // Checked BEFORE `/channels`: the reaction snapshot lives at
    // `/channels/{id}/reactions`, so a looser order answers it with the channel
    // list and the conversation builds chips out of a channel array.
    if (url.includes('/reactions')) {
      return jsonResponse(200, {});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return overrides.channels
        ? overrides.channels()
        : jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) {
      return overrides.roster ? overrides.roster() : jsonResponse(200, {members: ROSTER});
    }
    if (url.includes('/read-state')) {
      return overrides.readState
        ? overrides.readState()
        : jsonResponse(200, {read_states: READ_STATES});
    }
    if (url.includes('/messages')) {
      return overrides.messages
        ? overrides.messages()
        : jsonResponse(200, {messages: []});
    }
    // goal W-AP1: 승인 표면이 제공으로 뒤집히면서 인박스가 이 경로를 **실제로**
    // 부른다. 그 전에는 `isSurfaceProvided('approvals')`가 false라 정적 판정이
    // 요청 자체를 만들지 않았고, 그래서 이 목에는 이 줄이 없어도 됐다. 라우트가
    // 없으면 아래 `unrouted request`가 던지고, 그 실패가 결정 대기 탭의 오류
    // 상태가 되어 이 파일의 인박스 테스트가 한꺼번에 붉어진다. 답하는 것은
    // 원장이 비어 있다는 사실이고, 그것이 이 픽스처 서버의 진실이다.
    if (url.includes('/approvals')) {
      return overrides.approvals
        ? overrides.approvals()
        : jsonResponse(200, {approvals: []});
    }
    if (url.includes('/dms')) {
      return overrides.dms
        ? overrides.dms()
        : jsonResponse(200, {
            channel: {
              id: 'ch-dm-hermes',
              workspaceId: WS,
              kind: 'dm',
              muted: false,
              memberIds: [SELF_ID, 'dddddddd-1111-4111-8111-dddddddddddd'],
            },
            created: true,
          });
    }
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// Held so it can be torn down: `useReadStates` polls on a 30s interval, and a
// client left alive after a test keeps that timer (and jest's worker) running.
let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      // `gcTime` for MUTATIONS defaults to five minutes, and that timer is what
      // kept jest's event loop alive for exactly 300s after this file's tests
      // finished. It is correct in the app and pointless here, where the tree is
      // thrown away between tests.
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
  // A live session, as `login()` would have left it: an in-memory access token
  // and the identity beside it.
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  // `cleanup()` unmounts the tree, which detaches the observers; clearing the
  // client then drops the queries themselves along with the poll they scheduled.
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

describe('the 대화 list, end to end', () => {
  it('lists channels and DMs, naming the DM through the roster', async () => {
    installFetch();
    renderShell();

    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.getByTestId('sidebar-row-channel:ch-general')).toHaveTextContent(
      /general/,
    );
    // A DM carries no name; the label is the other participant, resolved by the
    // core — and it carries `@intern-kim` because the workspace holds a second
    // 김인턴 (the agent one, which is why the plain name appears twice).
    expect(screen.getByTestId('sidebar-row-dm:ch-dm-human')).toHaveTextContent(
      /김인턴@intern-kim/,
    );
    expect(screen.getAllByText('김인턴')).toHaveLength(2);
  });

  it('hides an archived channel', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.queryByText('old-stuff')).toBeNull();
  });

  it('renders the server’s unread and mention counts', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // Both counts render, and the accessible name spells them out rather than
    // leaving two bare numbers beside a channel name.
    expect(screen.getByTestId('sidebar-row-channel:ch-general')).toHaveTextContent(
      /general13/,
    );
    expect(screen.getByLabelText('채널 general, 멘션 1개, 안 읽은 메시지 3개')).toBeTruthy();
  });

  it('offers an agent that has no DM yet', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.getByText('헤르메스')).toBeTruthy();
  });

  it('filters synchronously as the person types', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    const search = screen.getByTestId('sidebar-search');
    // Nothing awaited between the keystroke and the assertion: the same property
    // the iOS IME needs (spike #837 gate 1 case D).
    fireEvent.changeText(search, '헤르');
    expect(search.props.value).toBe('헤르');
    expect(screen.queryByText('general')).toBeNull();
    expect(screen.getByText('헤르메스')).toBeTruthy();
  });

  it('says nothing matched, rather than showing an empty workspace', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('sidebar-search'), 'zzzz');
    expect(screen.getByTestId('channels-no-match')).toBeTruthy();
  });
});

describe('the four states of the 대화 list', () => {
  it('shows a loading state before the first answer', async () => {
    installFetch();
    renderShell();
    expect(screen.getByTestId('channels-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  });

  it('shows an empty state when the workspace has no channels', async () => {
    installFetch({
      channels: () => jsonResponse(200, {channels: []}),
      roster: () => jsonResponse(200, {members: [ROSTER[0]]}),
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-empty')).toBeTruthy());
    expect(screen.getByTestId('channels-empty')).toHaveTextContent(
      /아직 참여한 채널이 없습니다\./,
    );
  });

  it('shows an error state with a retry when the server refuses', async () => {
    installFetch({
      channels: () => jsonResponse(500, {error: {message: 'boom'}}),
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());
    expect(screen.getByTestId('channels-error-retry')).toBeTruthy();
    // The server's English never reaches the person.
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('treats a roster failure as a list failure, not a silent degrade', async () => {
    // Without the roster every DM falls back to the handle-less "다이렉트
    // 메시지", the 에이전트 section disappears and the two 김인턴 collapse into
    // one label. Rendering that as a normal list is the exact failure this
    // screen exists to prevent, shown as if nothing were wrong.
    installFetch({roster: () => jsonResponse(500, {error: {message: 'boom'}})});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());
    expect(screen.queryByTestId('sidebar-list')).toBeNull();
  });

  it('says the unread counts are missing rather than implying everything is read', async () => {
    installFetch({readState: () => jsonResponse(500, {error: {message: 'boom'}})});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // The list still works — only the projection behind the badges failed.
    expect(screen.getByTestId('read-state-error')).toHaveTextContent(
      /안 읽음 표시를 불러오지 못했습니다\./,
    );
  });

  it('shows the core’s transport copy when nothing answered', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());
    expect(screen.getByTestId('channels-error')).toHaveTextContent(
      /주소와 네트워크를 확인하고 다시 시도하세요\./,
    );
  });
});

describe('opening a conversation', () => {
  it('opens the conversation surface, and comes back', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('general');
    // The composer is the proof the surface is real: the placeholder this
    // replaced could show a title too, and could not be written into.
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    // An empty channel says what to do about it, in the core's words.
    await waitFor(() => expect(screen.getByTestId('timeline-empty')).toBeTruthy());

    fireEvent.press(screen.getByTestId('header-back'));
    expect(screen.queryByTestId('composer-input')).toBeNull();
  });

  it('asks the SERVER which channel an agent DM is, then opens it', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    fireEvent.press(
      screen.getByTestId('sidebar-row-agent:dddddddd-1111-4111-8111-dddddddddddd'),
    );

    await waitFor(() =>
      expect(screen.getByTestId('composer-input')).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/workspaces/${WS}/dms`,
      expect.objectContaining({method: 'POST'}),
    );
    // The header names the peer, resolved through the core from the channel the
    // server answered with — not from the row that was tapped.
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('헤르메스');
  });

  it('says so in Korean when the DM could not be opened', async () => {
    installFetch({dms: () => jsonResponse(403, {error: {message: 'forbidden'}})});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    fireEvent.press(
      screen.getByTestId('sidebar-row-agent:dddddddd-1111-4111-8111-dddddddddddd'),
    );
    await waitFor(() => expect(screen.getByTestId('open-dm-error')).toBeTruthy());
    expect(screen.getByTestId('open-dm-error')).toHaveTextContent(
      /이 사람과는 대화를 열 수 없습니다\. 워크스페이스 관리자에게 문의하세요\./,
    );
    expect(screen.queryByText(/forbidden/)).toBeNull();
  });

  it('「다시 시도」 sends the request again instead of hiding the sentence', async () => {
    // It used to call `reset()`: the banner disappeared and nothing was sent.
    // Found while fixing the same shape on the agent pause control (goal RN-A1
    // R1 High-3), which named this the precedent.
    let attempts = 0;
    const fetchMock = installFetch({
      dms: () => {
        attempts += 1;
        return jsonResponse(503, {error: {message: 'upstream down'}});
      },
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    fireEvent.press(
      screen.getByTestId('sidebar-row-agent:dddddddd-1111-4111-8111-dddddddddddd'),
    );
    await waitFor(() => expect(screen.getByTestId('open-dm-error')).toBeTruthy());
    expect(attempts).toBe(1);

    fireEvent.press(screen.getByTestId('open-dm-error-retry'));
    await waitFor(() => expect(attempts).toBe(2));
    // …and it asked for the same person, not a fresh guess.
    const dmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/dms'),
    );
    expect(dmCalls).toHaveLength(2);
    expect(JSON.parse(dmCalls[1][1].body)).toEqual(
      JSON.parse(dmCalls[0][1].body),
    );
  });
});

describe('the 인박스 tab', () => {
  it('is reachable and carries the server’s mention count', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.getByLabelText('인박스, 멘션 1개')).toBeTruthy();
  });

  // goal W-AP1: 이 블록은 **플립 전 세계**를 단정하고 있었다.
  //
  // `serverSurfaces.ts`의 `approvals.provided`가 false인 동안 이 서버에는 결정
  // 대기와 에이전트 탭이 없었고, 남은 탭이 하나뿐이라 탭 줄 자체가 서지 않았으며,
  // 화면 위에는 `approvals-absent` 안내가 떠 있었다. 그때 인박스를 열면 곧바로
  // 멘션 목록에 착지했으므로 아래 테스트들이 그 목록을 전제로 쓰였다.
  //
  // goal SRV-T1이 서버에 승인 3라우트를 올렸고 판정이 뒤집혔다. 그러므로 이제
  // 참인 것은 정반대다: 세 탭이 서고, 첫 탭(결정 대기)에 착지하며,
  // `approvals-absent`는 그릴 이유가 없다. 멘션을 보려면 **탭을 눌러야 한다**.
  it('offers the three tabs now that this server carries the approvals ledger', async () => {
    installFetch();
    renderShell();
    fireEvent.press(screen.getByTestId('tab-inbox'));

    // 승인 원장이 있으므로 그 위에 선 두 탭이 함께 산다
    // (`availableInboxFilters`: 에이전트 탭도 이 원장 하나로 열린다).
    expect(screen.getByTestId('inbox-tab-needs-action')).toBeTruthy();
    expect(screen.getByTestId('inbox-tab-mentions')).toBeTruthy();
    expect(screen.getByTestId('inbox-tab-agents')).toBeTruthy();
    // 미제공 안내는 사라진다. 없는 기능을 없다고 말하는 것이 그 안내의 일이었고,
    // 이제 그 문장은 참이 아니다.
    expect(screen.queryByTestId('approvals-absent')).toBeNull();
    // 그리고 착지하는 곳은 첫 탭, 즉 결정 대기다.
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy());
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(
      /지금 결정할 일이 없습니다\. 조용한 게 정상입니다\./,
    );
  });

  it('says a quiet inbox is normal', async () => {
    installFetch();
    renderShell();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    // 멘션은 이제 첫 탭이 아니다: 승인 원장이 살아나면서 결정 대기가 앞에 선다.
    fireEvent.press(screen.getByTestId('inbox-tab-mentions'));
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy());
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(
      /읽지 않은 멘션이 없습니다\. 조용한 게 정상입니다\./,
    );
  });

  it('builds a mention row through the core when the server has one', async () => {
    installFetch({
      messages: () =>
        jsonResponse(200, {
          messages: [
            {
              id: 'm-11',
              channelId: 'ch-general',
              seq: 11,
              hlcTs: 11,
              hlcCount: 0,
              authorMemberId: 'cccccccc-1111-4111-8111-cccccccccccc',
              type: 'text',
              body: '이거 확인 부탁드립니다',
              createdAtMs: Date.now() - 60_000,
              props: {mention_member_ids: [SELF_ID]},
            },
          ],
        }),
    });
    renderShell();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    // 결정 대기가 첫 탭이 된 뒤로, 멘션 행을 보려면 멘션 탭을 눌러야 한다.
    fireEvent.press(screen.getByTestId('inbox-tab-mentions'));

    await waitFor(() => expect(screen.getByTestId('inbox-list')).toBeTruthy());
    // The sentence is the core's: actor, then predicate, then the quoted body.
    expect(screen.getByText('@kim-intern')).toBeTruthy();
    expect(screen.getByText(' 회원님을 불렀습니다')).toBeTruthy();
    expect(screen.getByText('이거 확인 부탁드립니다')).toBeTruthy();
  });

  it('marks a mention read by advancing the server cursor', async () => {
    const fetchMock = installFetch({
      messages: () =>
        jsonResponse(200, {
          messages: [
            {
              id: 'm-11',
              channelId: 'ch-general',
              seq: 11,
              hlcTs: 11,
              hlcCount: 0,
              authorMemberId: 'cccccccc-1111-4111-8111-cccccccccccc',
              type: 'text',
              body: '확인 부탁',
              createdAtMs: Date.now() - 60_000,
              props: {mention_member_ids: [SELF_ID]},
            },
          ],
        }),
    });
    renderShell();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    fireEvent.press(screen.getByTestId('inbox-tab-mentions'));
    await waitFor(() => expect(screen.getByTestId('inbox-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('mark-read-mention:m-11'));

    const cursorUrl = `${BASE}/v1/workspaces/${WS}/channels/ch-general/read-state`;
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === cursorUrl),
      ).toBe(true),
    );
    // The client reports a position; the server owns the count (P7).
    const call = fetchMock.mock.calls.find(([url]) => url === cursorUrl);
    expect(call![1].method).toBe('PUT');
    expect(JSON.parse(call![1].body)).toEqual({last_read_seq: 11});
  });
});

describe('signing out', () => {
  it('confirms first, then erases the session', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    // One deliberate step: this is the only irreversible action in this batch.
    expect(screen.getByTestId('sign-out-confirm')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sign-out-cancel'));
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    fireEvent.press(screen.getByTestId('sign-out-confirm'));

    // The local wipe is synchronous and unconditional — it does not wait for the
    // server to acknowledge the revocation.
    expect(getPersistedSession()).toBeNull();
  });
});
