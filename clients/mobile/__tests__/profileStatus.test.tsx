import type {Member} from '@momo/core/lib/api';
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

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2848 — 프로필 시트에서 상태와 알림을 바로 바꾼다.
//
// 성재 요청(2026-09-27): 「모바일에서 알림이나 상태변경같은거만 일단 프로필에서
// 바로 할 수 있게」. 이 파일이 지는 것:
//   1. 온라인·자리 비움·방해 금지를 시트에서 고르면 `PUT /presence` 가 그 상태
//      **하나만** 싣고 나간다(상태 글 키는 건드리지 않는다). 알약은 바로 바뀌고,
//      실패하면 되돌아가며 그렇게 말한다.
//   2. 알림 일시 중지는 `PATCH /notification-rules {dnd}` 이고, **멘션 예외를
//      싣지 않는다**(#3042) — 통째 PUT 은 읽은 뒤 웹이 바꾼 예외를 지운다. 읽기
//      전·읽기 실패 때는 스위치가 잠긴다.
//   3. 상태 글은 시트 안의 한 장에서 이모지·글·지우기 시간을 고르고, 선언 상태는
//      그대로 둔 채 저장한다. 저장된 만료는 「지금대로」로 남길 수 있다.
//
// 서버 뒤는 `profileSheet.test.tsx` 와 같이 fetch 하나만 가짜다 — 다만 여기의
// 가짜는 상태를 **기억한다**: PUT 뒤의 명부 재조회가 쓴 값을 돌려줘야 「서버 값으로
// 다시 읽었다」가 참인지 잴 수 있다.
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

type SelfRow = Record<string, unknown>;

interface Server {
  self: SelfRow;
  rules: {dnd: boolean; mentionOverridesMute: boolean};
  /** 규칙 GET 의 답을 바꾼다: 'ok' | 'fail' | 'hang'. */
  rulesRead: 'ok' | 'fail' | 'hang';
  /**
   * 다른 기기(웹)가 폰의 **마지막 읽기 뒤, 폰의 쓰기가 닿기 전에** 쓰는 값(#3042
   * 경합 재현). 다음 규칙 GET 에 답한 직후에, GET 없이 쓰기가 먼저 오면 그 쓰기
   * 직전에 한 번 반영한다.
   */
  afterRead?: Partial<{dnd: boolean; mentionOverridesMute: boolean}>;
  /** 푸시 종류 스위치(#3342). 서버 기본은 켬이다. */
  kinds: {workComplete: boolean};
  /** 종류 GET 의 답: 'ok' | 'fail' | 'absent'(404 — 아직 이 기능이 없는 서버) | 'hang'. */
  kindsRead: 'ok' | 'fail' | 'absent' | 'hang';
  /** 종류 PATCH 를 실패시킨다. */
  kindsWriteFails: boolean;
  presenceFails: boolean;
  /** 명부 GET 을 실패시킨다 — 되돌림이 재조회 없이도 서는지 재려고. */
  rosterFails: boolean;
  puts: {path: string; method?: string; body: unknown}[];
}

let server: Server;

function baseSelf(): SelfRow {
  return {
    id: SELF_ID,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '곽성재',
    handle: 'seongjae',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    presenceStatus: 'dnd',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/notification-rules/push-kinds')) {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        server.puts.push({path: 'push-kinds', method, body});
        if (server.kindsWriteFails) return jsonResponse(500, {error: {message: 'x'}});
        server.kinds = {...server.kinds, ...body};
        return jsonResponse(200, server.kinds);
      }
      if (server.kindsRead === 'fail') return jsonResponse(500, {error: {message: 'boom'}});
      if (server.kindsRead === 'absent') return jsonResponse(404, {error: {message: 'no route'}});
      if (server.kindsRead === 'hang') return new Promise<Response>(() => {});
      return jsonResponse(200, {...server.kinds});
    }
    if (url.includes('/notification-rules')) {
      // #3012 서버: PUT 은 통째 치환, PATCH 는 적힌 필드만 **도착한 때의** 값 위에 합친다.
      if (method === 'PUT' || method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        if (server.afterRead) {
          server.rules = {...server.rules, ...server.afterRead};
          server.afterRead = undefined;
        }
        server.puts.push({path: 'notification-rules', method, body});
        server.rules = method === 'PATCH' ? {...server.rules, ...body} : body;
        return jsonResponse(200, server.rules);
      }
      if (server.rulesRead === 'fail') {
        return jsonResponse(500, {error: {message: 'boom'}});
      }
      if (server.rulesRead === 'hang') return new Promise<Response>(() => {});
      const answer = jsonResponse(200, {...server.rules});
      if (server.afterRead) {
        server.rules = {...server.rules, ...server.afterRead};
        server.afterRead = undefined;
      }
      return answer;
    }
    if (url.includes('/presence')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      server.puts.push({path: 'presence', body});
      if (server.presenceFails) return jsonResponse(500, {error: {message: 'x'}});
      const next: SelfRow = {...server.self, presenceStatus: body.status};
      for (const [wire, row] of [
        ['statusEmoji', 'statusEmoji'],
        ['statusText', 'statusText'],
        ['statusExpiresAtMs', 'statusExpiresAtMs'],
      ] as const) {
        if (wire in body) {
          if (body[wire] === null) delete next[row];
          else next[row] = body[wire];
        }
      }
      server.self = next;
      return jsonResponse(200, {status: body.status});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/roster')) {
      if (server.rosterFails) return jsonResponse(503, {error: {message: 'down'}});
      return jsonResponse(200, {members: [server.self]});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
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
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>
    </ThemeProvider>,
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
  sessionPort.applyLogin(LOGIN_BODY);
  server = {
    self: baseSelf(),
    rules: {dnd: false, mentionOverridesMute: true},
    rulesRead: 'ok',
    kinds: {workComplete: true},
    kindsRead: 'ok',
    kindsWriteFails: false,
    presenceFails: false,
    rosterFails: false,
    puts: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

async function openSheet() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('profile-avatar'));
  const sheet = screen.getByTestId('profile-sheet');
  await waitFor(() =>
    expect(within(sheet).getByTestId('presence-option-auto')).toBeTruthy(),
  );
  return sheet;
}

const presencePuts = () => server.puts.filter(p => p.path === 'presence');
const rulesPuts = () => server.puts.filter(p => p.path === 'notification-rules');
const kindsPuts = () => server.puts.filter(p => p.path === 'push-kinds');

describe('상태를 시트에서 바로 바꾼다 (#2848)', () => {
  it('세 줄이 코어 순서·낱말로 서고, 지금 선언이 선택돼 있다', async () => {
    const sheet = await openSheet();
    const labels = ['auto', 'away', 'dnd'].map(
      status => within(sheet).getByTestId(`presence-option-${status}`).props
        .accessibilityLabel,
    );
    expect(labels).toEqual(['온라인', '자리 비움', '방해 금지']);
    const dnd = within(sheet).getByTestId('presence-option-dnd');
    expect(dnd.props.accessibilityRole).toBe('radio');
    expect(dnd.props.accessibilityState).toMatchObject({selected: true});
    expect(
      within(sheet).getByTestId('presence-option-away').props.accessibilityState,
    ).toMatchObject({selected: false});
  });

  it('자리 비움을 누르면 PUT 이 상태 하나만 싣고, 알약이 바로 바뀐다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-away'));

    await waitFor(() =>
      expect(within(sheet).getByTestId('self-profile-presence')).toHaveTextContent(
        '자리 비움',
      ),
    );
    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    // 상태 글 키가 없어야 한다 — 있으면 상태 하나 바꾸는 일이 상태 글을 지운다.
    expect(JSON.stringify(presencePuts()[0].body)).toBe('{"status":"away"}');
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('presence-option-away').props.accessibilityState,
      ).toMatchObject({selected: true}),
    );
  });

  it('이미 고른 상태를 다시 누르면 아무것도 보내지 않는다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(presencePuts()).toHaveLength(0);
  });

  it('쓰기가 실패하면 알약을 되돌리고 그렇게 말한다', async () => {
    server.presenceFails = true;
    const sheet = await openSheet();
    // 서버가 통째로 안 닿는 경우: 재조회도 실패하므로 되돌림은 캐시의 이전 값뿐이다.
    server.rosterFails = true;
    fireEvent.press(within(sheet).getByTestId('presence-option-auto'));

    await waitFor(() =>
      expect(within(sheet).getByTestId('presence-failure')).toHaveTextContent(
        '상태를 바꾸지 못했습니다. 다시 시도하세요.',
      ),
    );
    expect(within(sheet).getByTestId('self-profile-presence')).toHaveTextContent(
      '방해 금지',
    );
  });

  it('방해 금지 줄은 푸시를 멈추는 것이 아니라고 말한다', async () => {
    const sheet = await openSheet();
    expect(
      within(sheet).getByTestId('presence-option-dnd').props.accessibilityHint,
    ).toContain('알림 일시 중지');
  });
});

describe('알림 일시 중지 (#2848)', () => {
  it('스위치 줄이 스위치로 읽히고, 켜면 일시 중지 하나만 PATCH 로 싣는다', async () => {
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-pause-row');
    await waitFor(() =>
      expect(row.props.accessibilityState).toMatchObject({disabled: false}),
    );
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toMatchObject({checked: false});

    fireEvent.press(row);

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    // 멘션 예외는 싣지 않는다 — 서버가 도착한 때의 값을 지킨다(#3042).
    expect(rulesPuts()[0]).toMatchObject({method: 'PATCH', body: {dnd: true}});
    expect(server.rules).toEqual({dnd: true, mentionOverridesMute: true});
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: true}),
    );
    expect(within(sheet).getByTestId('profile-pause-row')).toHaveTextContent(
      /직접 끌 때까지/,
    );
  });

  it('켜진 일시 중지를 끄면 dnd:false 로 되돌린다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false};
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: true, disabled: false}),
    );
    fireEvent(within(sheet).getByTestId('profile-pause-switch', {includeHiddenElements: true}), 'valueChange', false);
    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    expect(rulesPuts()[0]).toMatchObject({method: 'PATCH', body: {dnd: false}});
  });

  it('규칙을 아직 못 읽었으면 잠겨 있고, 눌러도 아무것도 보내지 않는다', async () => {
    server.rulesRead = 'hang';
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-pause-row');
    expect(row.props.accessibilityState).toMatchObject({disabled: true});
    // 서버 값을 모르는 동안 「꺼짐」 스위치를 그리지 않는다(리뷰 M-1).
    expect(
      within(sheet).queryByTestId('profile-pause-switch', {includeHiddenElements: true}),
    ).toBeNull();
    expect(row).toHaveTextContent(/확인하는 중/);
    fireEvent.press(row);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rulesPuts()).toHaveLength(0);
  });

  it('읽기에 실패하면 그렇게 말하고, 다시 불러오면 풀린다', async () => {
    server.rulesRead = 'fail';
    const sheet = await openSheet();
    await waitFor(() =>
      expect(within(sheet).getByTestId('profile-pause-row')).toHaveTextContent(
        /알림 설정을 불러오지 못했어요/,
      ),
    );
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    expect(rulesPuts()).toHaveLength(0);

    server.rulesRead = 'ok';
    fireEvent.press(within(sheet).getByTestId('profile-pause-retry'));
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({disabled: false}),
    );
  });

  it('쓰기가 실패하면 스위치를 되돌리고 그렇게 말한다', async () => {
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({disabled: false}),
    );
    const real = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/notification-rules') && init?.method === 'PATCH') {
        return jsonResponse(500, {error: {message: 'x'}});
      }
      return (real as unknown as (u: string, i?: RequestInit) => Promise<Response>)(
        url,
        init,
      );
    }) as unknown as typeof fetch;

    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    await waitFor(() => expect(within(sheet).getByTestId('pause-failure')).toBeTruthy());
    expect(
      within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
    ).toMatchObject({checked: false});
  });
});

describe('알림 일시 중지는 다른 기기의 변경을 지우지 않는다 (#2893 → #3042 PATCH)', () => {
  async function readySheet() {
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({disabled: false}),
    );
    return sheet;
  }

  it('시트를 연 뒤 웹에서 켠 멘션 예외를 폰 토글이 덮어쓰지 않는다', async () => {
    server.rules = {dnd: false, mentionOverridesMute: false};
    const sheet = await readySheet();
    // 폰 캐시(staleTime 30초)가 살아 있는 동안 웹 설정이 멘션 예외를 켠다.
    server.rules = {dnd: false, mentionOverridesMute: true};

    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    expect(rulesPuts()[0].body).toEqual({dnd: true});
    expect(server.rules).toEqual({dnd: true, mentionOverridesMute: true});
  });

  // #3042 경합 회귀. 폰이 규칙을 읽은 **뒤**, 쓰기가 닿기 전에 웹이 멘션 예외를
  // 켠다. 읽은 값으로 만든 통째 PUT 은 그 사이의 변경을 지운다(다시 읽어도 틈은
  // 남는다). 바꾼 필드 하나만 싣는 PATCH 만 둘 다 남긴다.
  it('읽은 뒤 쓰기 전에 웹이 바꾼 멘션 예외를 폰 토글이 지우지 않는다', async () => {
    server.rules = {dnd: false, mentionOverridesMute: false};
    const sheet = await readySheet();
    // 다음 규칙 GET 에 답하자마자 웹이 멘션 예외를 켠다.
    server.afterRead = {mentionOverridesMute: true};

    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    expect(server.rules).toEqual({dnd: true, mentionOverridesMute: true});
  });

  it('한 번 읽은 뒤 재조회가 실패해도 켜진 스위치와 「불러오지 못했습니다」가 함께 서지 않는다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false};
    const sheet = await readySheet();
    server.rulesRead = 'fail';

    await act(async () => {
      await queryClient!
        .refetchQueries({queryKey: ['settings', 'notification-rules', WS]})
        .catch(() => undefined);
    });
    // 재조회가 정말 실패했는지 먼저 확인한다(양성 대조).
    expect(
      queryClient!.getQueryState(['settings', 'notification-rules', WS])?.status,
    ).toBe('error');

    // 관찰자가 실패를 그릴 틈을 준다(이 틈 없이 재면 옛 그림을 읽고 통과한다).
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    const row = within(sheet).getByTestId('profile-pause-row');
    expect(row.props.accessibilityState).toMatchObject({checked: true});
    expect(
      within(sheet).getByTestId('profile-pause-switch', {includeHiddenElements: true}),
    ).toBeTruthy();
    expect(row).not.toHaveTextContent(/불러오지 못했습니다/);
    expect(row.props.accessibilityHint).not.toMatch(/불러오지 못했습니다/);
    expect(within(sheet).queryByTestId('profile-pause-retry')).toBeNull();
    expect(row).toHaveTextContent(/직접 끌 때까지/);
  });
});

describe('상태 글 (#2848, ADR-0176)', () => {
  it('프리셋·1시간을 골라 저장하면 선언 상태를 그대로 싣고, 시트로 돌아와 알약에 보인다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    expect(within(sheet).getByTestId('status-page')).toBeTruthy();

    fireEvent.press(within(sheet).getByTestId('status-preset-meeting'));
    fireEvent.press(within(sheet).getByTestId('status-expiry-1h'));
    const before = Date.now();
    fireEvent.press(within(sheet).getByTestId('status-save'));

    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    const body = presencePuts()[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'dnd',
      statusEmoji: '📅',
      statusText: '회의 중',
    });
    const expires = body.statusExpiresAtMs as number;
    expect(expires).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(expires).toBeLessThan(before + 60 * 60_000 + 5_000);

    await waitFor(() =>
      expect(within(sheet).getByTestId('self-profile-custom-status')).toHaveTextContent(
        /📅 회의 중 · .*까지/,
      ),
    );
    expect(within(sheet).queryByTestId('status-page')).toBeNull();
  });

  it('저장된 만료는 「지금대로」가 기본이고, 글만 고쳐 저장하면 만료 키를 보내지 않는다', async () => {
    server.self = {
      ...baseSelf(),
      statusEmoji: '🏠',
      statusText: '재택',
      statusExpiresAtMs: Date.now() + 3 * 60 * 60_000,
    };
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    expect(
      within(sheet).getByTestId('status-expiry-keep').props.accessibilityState,
    ).toMatchObject({selected: true});

    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '재택 근무');
    fireEvent.press(within(sheet).getByTestId('status-save'));

    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    expect(JSON.stringify(presencePuts()[0].body)).toBe(
      '{"status":"dnd","statusEmoji":"🏠","statusText":"재택 근무"}',
    );
  });

  it('상태 지우기는 세 키를 모두 null 로 보낸다', async () => {
    server.self = {...baseSelf(), statusEmoji: '🌴', statusText: '휴가'};
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.press(within(sheet).getByTestId('status-clear'));

    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    expect(presencePuts()[0].body).toEqual({
      status: 'dnd',
      statusEmoji: null,
      statusText: null,
      statusExpiresAtMs: null,
    });
    await waitFor(() =>
      expect(within(sheet).queryByTestId('self-profile-custom-status')).toBeNull(),
    );
  });

  it('저장이 실패하면 그 장에 남아 그렇게 말한다', async () => {
    server.presenceFails = true;
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '집중');
    fireEvent.press(within(sheet).getByTestId('status-save'));
    await waitFor(() =>
      expect(within(sheet).getByTestId('status-failure')).toHaveTextContent(
        '상태를 저장하지 못했습니다. 다시 시도하세요.',
      ),
    );
    expect(within(sheet).getByTestId('status-page')).toBeTruthy();
  });

  it('뒤로(‹ 프로필)는 저장하지 않고 돌아간다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '집중');
    fireEvent.press(within(sheet).getByTestId('profile-back'));
    expect(within(sheet).getByTestId('presence-option-auto')).toBeTruthy();
    expect(presencePuts()).toHaveLength(0);
  });
});

// =============================================================================
// 푸시 종류 — 「작업 끝남」 (#3342, ADR-0120 부록 A)
//
// 서버 계약은 `GET|PATCH …/notification-rules/push-kinds {workComplete}` 하나다. 이 폰은
// 새 길을 내지 않는다. 시험이 지키는 것:
//   1. 스위치를 누르면 **PATCH 가 `{workComplete}` 하나만** 싣는다(PUT 도, 다른 키도 아님).
//   2. 서버 값을 읽기 전에는 스위치를 세우지 않고 눌러도 보내지 않는다 — 기본이 「켬」이라
//      모르는 채 「꺼짐」을 그리면 거짓이다.
//   3. 이 경로를 모르는 서버(404)에서는 죽은 스위치를 세우지 않는다.
//   4. 이 스위치의 쓰기는 일시 중지 규칙(`notification-rules`)을 건드리지 않는다.
// =============================================================================
describe('푸시 종류 — 작업 끝남 (#3342)', () => {
  it('스위치가 켬으로 서고, 끄면 PATCH {workComplete:false} 하나만 간다', async () => {
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-work-complete-row');
    await waitFor(() =>
      expect(row.props.accessibilityState).toMatchObject({disabled: false}),
    );
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toMatchObject({checked: true});
    expect(row).toHaveTextContent(/^작업 끝남/);

    fireEvent.press(row);
    await waitFor(() => expect(kindsPuts()).toHaveLength(1));
    expect(JSON.stringify(kindsPuts()[0].body)).toBe('{"workComplete":false}');
    expect(kindsPuts()[0].method).toBe('PATCH');
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-work-complete-row').props.accessibilityState,
      ).toMatchObject({checked: false}),
    );
    // 일시 중지 규칙은 한 번도 쓰지 않았다.
    expect(rulesPuts()).toHaveLength(0);
  });

  it('스위치 컨트롤을 직접 돌려도 같은 PATCH 다', async () => {
    server.kinds = {workComplete: false};
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-work-complete-switch', {includeHiddenElements: true}),
      ).toBeTruthy(),
    );
    fireEvent(
      within(sheet).getByTestId('profile-work-complete-switch', {includeHiddenElements: true}),
      'valueChange',
      true,
    );
    await waitFor(() => expect(kindsPuts()).toHaveLength(1));
    expect(JSON.stringify(kindsPuts()[0].body)).toBe('{"workComplete":true}');
  });

  it('서버 값을 아직 못 읽었으면 잠겨 있고, 눌러도 아무것도 보내지 않는다', async () => {
    server.kindsRead = 'hang';
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-work-complete-row');
    expect(row.props.accessibilityState).toMatchObject({disabled: true});
    expect(
      within(sheet).queryByTestId('profile-work-complete-switch', {includeHiddenElements: true}),
    ).toBeNull();
    fireEvent.press(row);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(kindsPuts()).toHaveLength(0);
  });

  it('쓰기가 실패하면 스위치를 되돌리고 그렇게 말한다', async () => {
    server.kindsWriteFails = true;
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-work-complete-row');
    await waitFor(() =>
      expect(row.props.accessibilityState).toMatchObject({disabled: false}),
    );
    fireEvent.press(row);
    await waitFor(() =>
      expect(within(sheet).getByTestId('work-complete-failure')).toBeTruthy(),
    );
    expect(
      within(sheet).getByTestId('profile-work-complete-row').props.accessibilityState,
    ).toMatchObject({checked: true});
  });

  it('이 경로를 모르는 서버(404)에서는 줄을 세우지 않는다', async () => {
    server.kindsRead = 'absent';
    const sheet = await openSheet();
    await waitFor(() =>
      expect(within(sheet).getByTestId('profile-pause-row')).toBeTruthy(),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(within(sheet).queryByTestId('profile-work-complete-row')).toBeNull();
    expect(within(sheet).queryByTestId('profile-always-row')).toBeNull();
  });
});
