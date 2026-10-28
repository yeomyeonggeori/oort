import {parseDevCredential} from '@momo/core/features/auth/devAccess';
import {
  DEV_NOTICES,
  devAccessErrorText,
  devAccessGate,
  devCredentialRow,
} from '@momo/core/features/auth/devAccessModel';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {
  DEV_TOOLS_ADMIN_NOTE,
  DEV_TOOLS_CREATE_ON_COMPUTER,
  DEV_TOOLS_OFFLINE,
  DevToolsPage,
} from '../src/features/profile/DevToolsPage';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #4663 설정 › 「명령줄·AI 도구」: 폰의 목록과 폐기.
//
// 폰은 만들지 않는다(터미널이 없다). 분실·의심 때 **바로 끊는** 길이 이 장의 일이다. 이 파일이 지는 것:
//   1. 한 줄의 값: 이름·도구·범위·마지막 사용·만료. 기기는 로그인 세션에만 있고 카드 행에는 칸째 없다. 남의 행은 안 선다
//   2. 지우기는 한 번 더 묻는다: 확인 전에는 요청이 나가지 않고, 확인하면 DELETE 한 번과 그 줄만 사라짐
//   3. 실패는 종류마다 다른 문장으로, 404 는 목록을 서버 기준으로 다시 읽는다
//   4. 끊긴 동안 단추가 잠기고 이유를 말한다(눌러도 확인이 서지 않는다)
//   5. 로딩·오류(다시 불러오기)·빈 상태, 안내 문장(만들 수 있는 사람 / 못 하는 사람 / 관리자)
//
// 서버 자리는 `fetch` 하나만 가짜다. 답은 OpenAPI(`DevCredential`·`DevAccessPolicyResponse`·`RevokeDevCredentialResponse`)의
// 실제 JSON 모양을 그대로 옮긴 표본이고, 서버 동작을 흉내 내지 않는다(어긋남이 필요한 장면은 시험이 표본을 바꿔 세운다).
// 문구는 코어가 주는 값으로 비교한다(문장 낱말을 이 파일이 다시 적지 않는다). 토큰 원문은 이 화면 어디에도 없다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://api.example.com';
const DAY = 86_400_000;
const NOW = Date.now();

const SELF: Member = {
  id: ME,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

const READ = ['dev:identity', 'dev:channels:read', 'dev:messages:read', 'dev:inbox:read'];
const WRITE = [...READ, 'dev:messages:write'];

type Wire = Record<string, unknown>;

const CLAUDE: Wire = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  memberId: ME,
  kind: 'card',
  name: 'Claude Code 노트북',
  tool: 'claude_code',
  scopes: READ,
  channelRestricted: false,
  createdAtMs: NOW - 10 * DAY,
  lastUsedAtMs: NOW - 3 * DAY,
  expiresAtMs: NOW + 20 * DAY,
};
/** 한 번도 안 쓴 카드. 읽기 + 보내기, 고른 채널만. */
const CODEX: Wire = {
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  memberId: ME,
  kind: 'card',
  name: 'Codex 작업용',
  tool: 'codex',
  scopes: WRITE,
  channelRestricted: true,
  createdAtMs: NOW - 2 * DAY,
  expiresAtMs: NOW + 88 * DAY,
};
/** 도구가 없는 로그인 세션. 기기 이름이 있고, 목록의 만료는 살아 있는 갱신 쪽의 것이라 며칠 단위다. */
const SESSION: Wire = {
  id: 'aaaaaaaa-0000-4000-8000-000000000003',
  memberId: ME,
  kind: 'session',
  name: 'oort 로그인',
  scopes: WRITE,
  channelRestricted: false,
  deviceName: '이도현의 MacBook Pro',
  createdAtMs: NOW - 12 * DAY,
  lastUsedAtMs: NOW - 5 * 60_000,
  expiresAtMs: NOW + 30 * DAY,
  lineageExpiresAtMs: NOW + 78 * DAY,
};
/** 두 프리셋 어느 쪽도 아닌 범위. */
const CUSTOM: Wire = {
  id: 'aaaaaaaa-0000-4000-8000-000000000004',
  memberId: ME,
  kind: 'card',
  name: '직접 정한 연결',
  tool: 'cli',
  scopes: ['dev:identity', 'dev:messages:read'],
  channelRestricted: false,
  createdAtMs: NOW - DAY,
  lastUsedAtMs: NOW - 2 * 60 * 60_000,
  expiresAtMs: NOW + 5 * DAY,
};
/** 남의 행. 이 장의 요청은 `scope=all` 이 아니지만 섞여 와도 서지 않는다. */
const THEIRS: Wire = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  memberId: OTHER,
  kind: 'card',
  name: '박서연의 Codex',
  tool: 'codex',
  scopes: READ,
  channelRestricted: false,
  createdAtMs: NOW - DAY,
  expiresAtMs: NOW + 29 * DAY,
};

type Reply =
  | {status: number; body?: unknown; headers?: Record<string, string>}
  | 'hang'
  | 'down';

interface Server {
  policy: Reply;
  list: Reply;
  revoke: (id: string) => Reply | Promise<Reply>;
  requests: {method: string; path: string}[];
}

let server: Server;
/** 끝나지 않는 답. 코어의 15초 기한 타이머가 시험 뒤에 남지 않도록 시험이 끝날 때 실패로 풀어 준다. */
const held: ((error: Error) => void)[] = [];

const ADMIN_POLICY = {policy: 'admins', canCreate: true, canManageAll: false};

function reply(r: {status: number; body?: unknown; headers?: Record<string, string>}): Response {
  const headers = r.headers ?? {};
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: {get: (name: string) => headers[name] ?? null},
    text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
  } as unknown as Response;
}

async function answer(pending: Reply | Promise<Reply>): Promise<Response> {
  const r = await pending;
  if (r === 'hang') {
    return new Promise<Response>((_resolve, reject) => {
      held.push(reject);
    });
  }
  if (r === 'down') throw new TypeError('Network request failed');
  return reply(r);
}

function installFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    server.requests.push({method, path});
    const root = `/v1/workspaces/${WS}/dev-access`;
    if (method === 'GET' && path === root) return answer(server.policy);
    if (method === 'GET' && path === `${root}/credentials`) return answer(server.list);
    if (method === 'DELETE' && path.startsWith(`${root}/credentials/`)) {
      return answer(server.revoke(decodeURIComponent(path.slice(`${root}/credentials/`.length))));
    }
    throw new Error(`unrouted request: ${method} ${path}`);
  }) as typeof fetch;
}

const revokeRequests = () => server.requests.filter(request => request.method === 'DELETE');

let queryClient: QueryClient | null = null;

function mount() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DevToolsPage workspaceId={WS} selfId={ME} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const netInfo = () =>
  jest.requireMock('@react-native-community/netinfo').default as {
    __emit: (state: {isConnected: boolean | null; isInternetReachable: boolean | null}) => void;
  };
const goOffline = () =>
  act(() => netInfo().__emit({isConnected: false, isInternetReachable: false}));
const goOnline = () => act(() => netInfo().__emit({isConnected: true, isInternetReachable: true}));

/** 표본에서 코어 모델이 만든 한 줄(화면이 보여야 하는 값). */
const rowOf = (wire: Wire) => devCredentialRow(parseDevCredential(wire), {now: Date.now()});
const baseOf = (wire: Wire) => `dev-credential-${String(wire.id)}`;
const revokeButton = (wire: Wire) => screen.getByTestId(`${baseOf(wire)}-revoke`);

/** 지우기를 눌러 확인 단계까지 간다. */
async function askToRevoke(wire: Wire) {
  await screen.findByTestId(baseOf(wire));
  fireEvent.press(revokeButton(wire));
  await screen.findByTestId('dev-revoke-confirm');
}

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  server = {
    policy: {status: 200, body: ADMIN_POLICY},
    list: {status: 200, body: {credentials: [CLAUDE, CODEX, SESSION]}},
    revoke: id => ({status: 200, body: {id, kind: 'card', revokedNow: true}}),
    requests: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  held.splice(0).forEach(release => release(new TypeError('Network request failed')));
  act(() => netInfo().__emit({isConnected: true, isInternetReachable: true}));
});

describe('목록: 한 줄이 말하는 것 (#4663)', () => {
  it('카드 행은 이름·도구·범위·마지막 사용·만료를 말하고, 기기 칸은 줄째 없다', async () => {
    mount();
    const base = baseOf(CLAUDE);
    await screen.findByTestId(base);
    const row = rowOf(CLAUDE);
    expect(screen.getByTestId(`${base}-name`)).toHaveTextContent(row.name);
    expect(screen.getByTestId(`${base}-tool`)).toHaveTextContent(row.toolLabel as string);
    expect(screen.getByTestId(`${base}-scope`)).toHaveTextContent(row.scopeLabel);
    expect(screen.getByTestId(`${base}-last-used`)).toHaveTextContent(row.lastUsedLabel, {
      exact: false,
    });
    expect(screen.getByTestId(`${base}-expiry`)).toHaveTextContent(row.expiryLabel, {exact: false});
    // 기기 이름은 서버가 로그인 세션에만 준다. 카드 행에는 지어낸 값도 빈 칸도 없다.
    expect(screen.queryByTestId(`${base}-device`)).toBeNull();
    // 카드의 「무엇인지」는 도구다. 종류(로그인 세션)는 도구가 없는 줄의 몫이다.
    expect(screen.queryByTestId(`${base}-kind`)).toBeNull();
  });

  it('로그인 세션 행은 기기 이름을 말하고, 도구 자리에는 종류가 선다', async () => {
    mount();
    const base = baseOf(SESSION);
    await screen.findByTestId(base);
    const row = rowOf(SESSION);
    expect(screen.getByTestId(`${base}-device`)).toHaveTextContent(SESSION.deviceName as string, {
      exact: false,
    });
    expect(screen.getByTestId(`${base}-kind`)).toHaveTextContent(row.kindLabel);
    expect(screen.queryByTestId(`${base}-tool`)).toBeNull();
  });

  it('한 번도 안 쓴 연결은 「마지막 사용」 없이 안 썼다고만 말한다', async () => {
    mount();
    await screen.findByTestId(baseOf(CODEX));
    const never = rowOf(CODEX);
    expect(never.neverUsed).toBe(true);
    // 문장이 통째로 그 말이다(앞에 「마지막 사용」이 붙으면 「마지막 사용 아직 안 썼어요」가 된다).
    expect(screen.getByTestId(`${baseOf(CODEX)}-last-used`)).toHaveTextContent(never.lastUsedLabel);
    // 쓴 연결은 라벨이 붙어 있어 같은 값이 통째로 같지 않다.
    const used = rowOf(CLAUDE);
    expect(screen.getByTestId(`${baseOf(CLAUDE)}-last-used`)).not.toHaveTextContent(
      used.lastUsedLabel,
    );
  });

  it('범위: 프리셋 이름 + 고른 채널만, 두 프리셋이 아니면 직접 정한 범위와 그 힘의 목록', async () => {
    server.list = {status: 200, body: {credentials: [CLAUDE, CODEX, CUSTOM]}};
    mount();
    await screen.findByTestId(baseOf(CODEX));
    expect(screen.getByTestId(`${baseOf(CLAUDE)}-scope`)).toHaveTextContent(
      rowOf(CLAUDE).scopeLabel,
    );
    expect(screen.getByTestId(`${baseOf(CODEX)}-scope`)).toHaveTextContent(rowOf(CODEX).scopeLabel);
    // 읽기만과 읽기 + 보내기는 다른 말이다.
    expect(rowOf(CLAUDE).scopeLabel).not.toBe(rowOf(CODEX).scopeLabel);
    expect(screen.getByTestId(`${baseOf(CUSTOM)}-scope`)).toHaveTextContent(rowOf(CUSTOM).scopeLabel);
    expect(screen.getByTestId(`${baseOf(CUSTOM)}-scope-detail`)).toHaveTextContent(
      rowOf(CUSTOM).scopeDetail as string,
    );
    // 프리셋인 줄에는 힘의 목록이 없다.
    expect(screen.queryByTestId(`${baseOf(CLAUDE)}-scope-detail`)).toBeNull();
  });

  it('남의 행은 응답에 섞여 와도 서지 않고 내 줄만 남는다', async () => {
    server.list = {status: 200, body: {credentials: [THEIRS, CLAUDE, CODEX]}};
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    expect(screen.queryByTestId(baseOf(THEIRS))).toBeNull();
    expect(screen.getAllByTestId(/^dev-credential-.+-info$/)).toHaveLength(2);
  });
});

describe('지우기는 한 번 더 묻는다 (#4663)', () => {
  it('확인하기 전에는 DELETE 가 나가지 않고, 확인하면 한 번 나가며 그 줄만 사라진다', async () => {
    mount();
    const base = baseOf(CLAUDE);
    await askToRevoke(CLAUDE);
    // 확인 단계는 목록 자리에 서고 무엇을 지우는지 이름이 말한다.
    expect(screen.getByTestId('dev-revoke-confirm-headline')).toHaveTextContent(
      rowOf(CLAUDE).name,
      {exact: false},
    );
    expect(screen.getByTestId('dev-revoke-confirm-detail')).toHaveTextContent(
      DEV_NOTICES.revokeWarning,
    );
    expect(screen.queryByTestId(base)).toBeNull();
    expect(revokeRequests()).toEqual([]);

    // 취소하면 목록이 그대로 돌아오고 요청은 없다.
    fireEvent.press(screen.getByTestId('dev-revoke-cancel'));
    expect(screen.getByTestId(base)).toBeTruthy();
    expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull();
    expect(revokeRequests()).toEqual([]);

    // 다시 눌러 확인한다.
    fireEvent.press(revokeButton(CLAUDE));
    fireEvent.press(await screen.findByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull());
    expect(revokeRequests()).toEqual([
      {method: 'DELETE', path: `/v1/workspaces/${WS}/dev-access/credentials/${String(CLAUDE.id)}`},
    ]);
    expect(screen.queryByTestId(base)).toBeNull();
    // 다른 줄은 그대로다.
    expect(screen.getByTestId(baseOf(CODEX))).toBeTruthy();
    expect(screen.getByTestId(baseOf(SESSION))).toBeTruthy();
  });

  it('이미 끝나 있던 연결(200, revokedNow:false)도 성공이라 줄이 사라진다', async () => {
    server.revoke = id => ({status: 200, body: {id, kind: 'card', revokedNow: false}});
    mount();
    await askToRevoke(CODEX);
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    // 확인 단계가 닫힌 뒤에야 목록이 다시 서므로, 줄이 없다는 단정은 그 뒤에 한다(확인 중에는 목록 자체가 없다).
    await waitFor(() => expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull());
    expect(screen.queryByTestId(baseOf(CODEX))).toBeNull();
    expect(screen.getByTestId(baseOf(CLAUDE))).toBeTruthy();
    expect(screen.queryByTestId('dev-revoke-error')).toBeNull();
  });

  it('로그인 세션 행도 같은 길로 지워진다', async () => {
    mount();
    await askToRevoke(SESSION);
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull());
    expect(screen.queryByTestId(baseOf(SESSION))).toBeNull();
    expect(revokeRequests().map(request => request.path)).toEqual([
      `/v1/workspaces/${WS}/dev-access/credentials/${String(SESSION.id)}`,
    ]);
  });

  it('404: 이유를 확인 단계 안에서 말하고 목록을 서버 기준으로 다시 읽는다', async () => {
    server.revoke = () => ({status: 404, body: {error: {message: 'not found'}}});
    mount();
    await askToRevoke(CLAUDE);
    // 그 사이 다른 기기에서 이미 지워졌다: 서버의 목록에서 그 줄이 빠진다.
    server.list = {status: 200, body: {credentials: [CODEX, SESSION]}};
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    const error = await screen.findByTestId('dev-revoke-error');
    expect(error).toHaveTextContent(devAccessErrorText({kind: 'not_found'}, 'revoke'));
    // 이유를 읽는 동안 확인 단계는 그대로다.
    expect(screen.getByTestId('dev-revoke-confirm')).toBeTruthy();
    // 취소하면 다시 읽은 목록이 선다: 그 줄이 없고 나머지는 있다.
    fireEvent.press(screen.getByTestId('dev-revoke-cancel'));
    await waitFor(() => expect(screen.queryByTestId(baseOf(CLAUDE))).toBeNull());
    expect(screen.getByTestId(baseOf(CODEX))).toBeTruthy();
    expect(screen.queryByTestId('dev-revoke-failure')).toBeNull();
  });

  const FAILURES: {name: string; reply: Reply; text: string}[] = [
    {
      name: '403: 내 권한으로 지울 수 없음',
      reply: {status: 403, body: {error: {message: 'x', code: 'forbidden'}}},
      text: devAccessErrorText({kind: 'forbidden'}, 'revoke'),
    },
    {
      name: '429: Retry-After 30초',
      reply: {
        status: 429,
        body: {error: {message: 'slow down'}},
        headers: {'Retry-After': '30'},
      },
      text: devAccessErrorText({kind: 'rate_limited', retryAfterSeconds: 30}, 'revoke'),
    },
    {
      name: '503: 멤버십 잠금, Retry-After 120초',
      reply: {
        status: 503,
        body: {error: {message: 'busy'}},
        headers: {'Retry-After': '120'},
      },
      text: devAccessErrorText({kind: 'busy', retryAfterSeconds: 120}, 'revoke'),
    },
    {
      name: '500: 알 수 없는 문제',
      reply: {status: 500, body: {error: {message: 'boom'}}},
      text: devAccessErrorText({kind: 'unknown'}, 'revoke'),
    },
    {
      name: '서버에 닿지 못함',
      reply: 'down',
      text: devAccessErrorText({kind: 'network'}, 'revoke'),
    },
  ];

  it.each(FAILURES.map(failure => [failure.name, failure] as const))(
    '실패 %s: 그 이유의 문장을 확인 단계 안에서 말하고, 줄은 그대로다',
    async (_name, failure) => {
      server.revoke = () => failure.reply;
      mount();
      await askToRevoke(CLAUDE);
      fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
      expect(await screen.findByTestId('dev-revoke-error')).toHaveTextContent(failure.text);
      // 다시 눌러 볼 수 있다(단추는 풀렸다). 줄은 지워지지 않았다.
      expect(screen.getByTestId('dev-revoke-confirm-button').props.accessibilityState).toMatchObject({
        disabled: false,
      });
      fireEvent.press(screen.getByTestId('dev-revoke-cancel'));
      expect(screen.getByTestId(baseOf(CLAUDE))).toBeTruthy();
    },
  );

  it('실패의 문장은 종류마다 서로 달라서 기다리라는 말과 권한 없다는 말이 같지 않다', () => {
    const texts = FAILURES.map(failure => failure.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('지우는 중에는 단추가 잠기고 요청은 한 번뿐이며, 끝나면 줄이 사라진다', async () => {
    let release: () => void = () => {};
    server.revoke = id =>
      new Promise<Reply>(resolve => {
        release = () => resolve({status: 200, body: {id, kind: 'card', revokedNow: true}});
      });
    mount();
    await askToRevoke(CLAUDE);
    const confirm = screen.getByTestId('dev-revoke-confirm-button');
    fireEvent.press(confirm);
    fireEvent.press(confirm);
    await waitFor(() => expect(revokeRequests()).toHaveLength(1));
    expect(screen.getByTestId('dev-revoke-confirm-button').props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    expect(revokeRequests()).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull());
    expect(screen.queryByTestId(baseOf(CLAUDE))).toBeNull();
    expect(revokeRequests()).toHaveLength(1);
  });

  it('끝나기 전에 취소해도 요청의 결과는 남고, 실패하면 목록 밑에 이유가 선다', async () => {
    let release: () => void = () => {};
    server.revoke = () =>
      new Promise<Reply>(resolve => {
        release = () => resolve({status: 500, body: {error: {message: 'boom'}}});
      });
    mount();
    await askToRevoke(CLAUDE);
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(revokeRequests()).toHaveLength(1));
    fireEvent.press(screen.getByTestId('dev-revoke-cancel'));
    expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull();
    await act(async () => release());
    expect(await screen.findByTestId('dev-revoke-failure')).toHaveTextContent(
      devAccessErrorText({kind: 'unknown'}, 'revoke'),
    );
    expect(screen.getByTestId(baseOf(CLAUDE))).toBeTruthy();
  });

  it('다시 열면 지난 시도의 이유가 남지 않는다', async () => {
    server.revoke = () => ({status: 500, body: {error: {message: 'boom'}}});
    mount();
    await askToRevoke(CLAUDE);
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    await screen.findByTestId('dev-revoke-error');
    fireEvent.press(screen.getByTestId('dev-revoke-cancel'));
    // 취소로 지난 이유가 걷힌다(목록 밑에 남지 않는다).
    expect(screen.queryByTestId('dev-revoke-failure')).toBeNull();
    // 다른 줄을 다시 열어도 이유가 없다.
    fireEvent.press(revokeButton(CODEX));
    await screen.findByTestId('dev-revoke-confirm');
    expect(screen.queryByTestId('dev-revoke-error')).toBeNull();
  });
});

describe('연결이 끊긴 동안 (#4663)', () => {
  it('이유를 말하고 지우기를 잠근다: 눌러도 확인이 서지 않고, 돌아오면 풀린다', async () => {
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    expect(screen.queryByTestId('dev-tools-offline')).toBeNull();
    expect(revokeButton(CLAUDE).props.accessibilityState).toMatchObject({disabled: false});

    goOffline();
    expect(screen.getByTestId('dev-tools-offline')).toHaveTextContent(DEV_TOOLS_OFFLINE);
    for (const wire of [CLAUDE, CODEX, SESSION]) {
      expect(revokeButton(wire).props.accessibilityState).toMatchObject({disabled: true});
    }
    fireEvent.press(revokeButton(CLAUDE));
    expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull();
    // 캐시된 목록은 그대로 읽힌다.
    expect(screen.getByTestId(baseOf(CLAUDE))).toBeTruthy();

    goOnline();
    expect(screen.queryByTestId('dev-tools-offline')).toBeNull();
    expect(revokeButton(CLAUDE).props.accessibilityState).toMatchObject({disabled: false});
    fireEvent.press(revokeButton(CLAUDE));
    expect(await screen.findByTestId('dev-revoke-confirm')).toBeTruthy();
    expect(revokeRequests()).toEqual([]);
  });

  it('확인 단계가 열린 채 끊기면 이유를 말하고, 확인해도 요청이 나가지 않는다', async () => {
    mount();
    await askToRevoke(CLAUDE);
    goOffline();
    expect(screen.getByTestId('dev-revoke-error')).toHaveTextContent(DEV_TOOLS_OFFLINE);
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    expect(revokeRequests()).toEqual([]);

    goOnline();
    expect(screen.queryByTestId('dev-revoke-error')).toBeNull();
    fireEvent.press(screen.getByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(revokeRequests()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('dev-revoke-confirm')).toBeNull());
    expect(screen.queryByTestId(baseOf(CLAUDE))).toBeNull();
  });
});

describe('로딩·오류·빈 상태 (#4663)', () => {
  it('읽는 동안은 읽는 중이라고 하고, 빈 줄도 오류도 그리지 않는다', async () => {
    server.list = 'hang';
    mount();
    expect(await screen.findByTestId('dev-tools-loading')).toBeTruthy();
    expect(screen.queryByTestId('dev-tools-empty')).toBeNull();
    expect(screen.queryByTestId('dev-tools-error')).toBeNull();
    // 안내 문장은 정책이 정하고 목록을 기다리지 않는다.
    expect(await screen.findByTestId('dev-tools-intro')).toBeTruthy();
    expect(screen.getByTestId('dev-tools-loading')).toBeTruthy();
  });

  it('연결이 하나도 없으면 없다고 말한다', async () => {
    server.list = {status: 200, body: {credentials: []}};
    mount();
    expect(await screen.findByTestId('dev-tools-empty')).toBeTruthy();
    expect(screen.queryByTestId('dev-tools-loading')).toBeNull();
    expect(screen.queryByTestId('dev-tools-error')).toBeNull();
  });

  it('읽지 못하면 이유와 다시 불러오기가 서고, 누르면 목록이 선다', async () => {
    server.list = {status: 500, body: {error: {message: 'boom'}}};
    mount();
    expect(await screen.findByTestId('dev-tools-error-detail')).toHaveTextContent(
      devAccessErrorText({kind: 'unknown'}, 'list'),
    );
    expect(screen.queryByTestId(baseOf(CLAUDE))).toBeNull();
    server.list = {status: 200, body: {credentials: [CLAUDE]}};
    fireEvent.press(screen.getByTestId('dev-tools-retry'));
    expect(await screen.findByTestId(baseOf(CLAUDE))).toBeTruthy();
    expect(screen.queryByTestId('dev-tools-error')).toBeNull();
    expect(screen.queryByTestId('dev-tools-retry')).toBeNull();
  });

  it('서버에 길이 없으면(404) 아직 지원하지 않는다고 말한다', async () => {
    server.list = {status: 404, body: {error: {message: 'no route'}}};
    mount();
    expect(await screen.findByTestId('dev-tools-error-detail')).toHaveTextContent(
      devAccessErrorText({kind: 'not_found'}, 'list'),
    );
  });
});

describe('안내 문장 (#4663)', () => {
  it('만들 수 있는 사람에게는 컴퓨터에서 만든다고 말한다', async () => {
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    expect(screen.getByTestId('dev-tools-intro')).toHaveTextContent(DEV_TOOLS_CREATE_ON_COMPUTER);
  });

  it.each([
    ['관리자가 켜 줘야 하는 계정', {policy: 'admins', canCreate: false, canManageAll: false}],
    ['스위치가 꺼진 워크스페이스', {policy: 'off', canCreate: false, canManageAll: false}],
    ['켜져 있어도 만들 수 없는 계정', {policy: 'members', canCreate: false, canManageAll: false}],
  ] as const)(
    '만들 수 없으면(%s) 코어의 이유 문장이 서고 컴퓨터에서 만들라는 말은 없다',
    async (_name, policy) => {
      server.policy = {status: 200, body: policy};
      mount();
      await screen.findByTestId(baseOf(CLAUDE));
      await waitFor(() => expect(screen.getByTestId('dev-tools-intro')).toBeTruthy());
      expect(screen.getByTestId('dev-tools-intro')).toHaveTextContent(devAccessGate(policy).text);
      expect(screen.getByTestId('dev-tools-intro')).not.toHaveTextContent(
        DEV_TOOLS_CREATE_ON_COMPUTER,
      );
      // 만들 수 없어도 이미 있는 연결은 지울 수 있다.
      expect(revokeButton(CLAUDE).props.accessibilityState).toMatchObject({disabled: false});
    },
  );

  it('정책을 못 읽으면 만들 수 있다는 약속을 빼고, 지우는 길은 그대로 둔다', async () => {
    server.policy = {status: 500, body: {error: {message: 'boom'}}};
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    // 정책 질의가 실패로 끝난 뒤의 「안내가 없다」여야 뜻이 있다(읽는 중에도 안내는 없다).
    await waitFor(() => expect(queryClient?.isFetching()).toBe(0));
    expect(screen.queryByTestId('dev-tools-intro')).toBeNull();
    fireEvent.press(revokeButton(CLAUDE));
    expect(await screen.findByTestId('dev-revoke-confirm')).toBeTruthy();
  });

  it('로그아웃해도 끊기지 않는다는 말과 비밀번호·도구 이름표의 말이 늘 선다', async () => {
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    expect(screen.getByTestId('dev-tools-logout-note')).toHaveTextContent(
      DEV_NOTICES.logoutKeepsConnections,
    );
    expect(screen.getByTestId('dev-tools-notes')).toHaveTextContent(
      DEV_NOTICES.passwordChangeEndsAll,
      {exact: false},
    );
    expect(screen.getByTestId('dev-tools-notes')).toHaveTextContent(DEV_NOTICES.toolIsOnlyALabel, {
      exact: false,
    });
  });

  it('관리자에게만 팀 전체는 컴퓨터에서 본다고 알린다(이 장은 내 연결만 보인다)', async () => {
    server.policy = {status: 200, body: {...ADMIN_POLICY, canManageAll: true}};
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    expect(await screen.findByTestId('dev-tools-admin-note')).toHaveTextContent(DEV_TOOLS_ADMIN_NOTE);
  });

  it('관리자가 아니면 그 말이 없다', async () => {
    mount();
    await screen.findByTestId(baseOf(CLAUDE));
    await waitFor(() => expect(screen.getByTestId('dev-tools-intro')).toBeTruthy());
    expect(screen.queryByTestId('dev-tools-admin-note')).toBeNull();
  });
});
