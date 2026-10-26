import {
  CUSTOM_STATUS_CLEAR_LABEL,
  CUSTOM_STATUS_EXPIRY_LABEL,
  CUSTOM_STATUS_PRESETS,
} from '@momo/core/features/presence/customStatus';
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
import {Dimensions, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ROW_GLYPH_MAX_SCALE} from '../src/design/atoms';
import {dividerIndent} from '../src/design/sheetModel';
import {ThemeProvider} from '../src/design/theme';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {darkPalette, lightPalette, SHEET, TOUCH_TARGET} from '../src/design/tokens';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2848 · #4457 — 설정 페이지에서 상태와 알림을 바로 바꾼다.
//
// 성재 요청(2026-09-27): 「모바일에서 알림이나 상태변경같은거만 일단 프로필에서
// 바로 할 수 있게」. 이 파일이 지는 것:
//   1. 온라인·자리 비움·방해 금지를 페이지에서 고르면 `PUT /presence` 가 그 상태
//      **하나만** 싣고 나간다(상태 글 키는 건드리지 않는다). 알약은 바로 바뀌고,
//      실패하면 되돌아가며 그렇게 말한다.
//   2. 알림 일시 중지는 `PATCH /notification-rules {dnd, dndUntilMs}` 이고, **멘션
//      예외를 싣지 않는다**(#3042) — 통째 PUT 은 읽은 뒤 웹이 바꾼 예외를 지운다. 읽기
//      전·읽기 실패 때는 스위치가 잠긴다. 켜는 쓰기는 **기한을 고른 뒤에만** 나간다
//      (ADR-0204 D2, #2899) — 기한을 고르는 장과 방해 금지 묶음은 `profilePauseUntil.test.tsx`.
//   3. 상태 글은 「상태 설정」 바텀시트에서 이모지·글·지우기 시간을 고르고(#4457: 머리의
//      ✓ 는 바뀐 것이 있을 때만 눌린다), 선언 상태는 그대로 둔 채 저장한다. 저장된 만료는
//      「지금대로」로 남길 수 있다.
//
// 서버 뒤는 `settingsPage.test.tsx` 와 같이 fetch 하나만 가짜다 — 다만 여기의
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
  rules: {dnd: boolean; mentionOverridesMute: boolean; dndUntilMs?: number};
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

/** 이 시험들은 움직임이 주제가 아니다 — 층이 누르는 즉시 걷히도록 동작 줄이기를 켠 채 돈다(`layerMotion4457.test.tsx` 가 움직임을 잰다). */
let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  releaseMotion = await pinReduceMotion(true);
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
  releaseMotion?.();
  releaseMotion = null;
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

async function openSheet() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('profile-avatar'));
  const sheet = screen.getByTestId('settings-page');
  await waitFor(() =>
    expect(within(sheet).getByTestId('presence-option-auto')).toBeTruthy(),
  );
  return sheet;
}

const presencePuts = () => server.puts.filter(p => p.path === 'presence');
const rulesPuts = () => server.puts.filter(p => p.path === 'notification-rules');
const kindsPuts = () => server.puts.filter(p => p.path === 'push-kinds');

describe('상태를 페이지에서 바로 바꾼다 (#2848)', () => {
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

  it('이미 고른 상태를 다시 누르면 아무것도 보내지 않는다 (방해 금지는 기한 장이 열린다)', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    // 방해 금지는 눌러서 기한을 바꾸는 길이다 — 열릴 뿐 쓰지는 않는다.
    expect(within(sheet).getByTestId('pause-until-page')).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(presencePuts()).toHaveLength(0);
    expect(rulesPuts()).toHaveLength(0);
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

  // ADR-0124 증보 2 「묶어」: 방해 금지를 고르면 서버가 알림 일시 중지도 함께 켠다. 옛 문장은
  // 「알림은 「알림 일시 중지」가 멈춥니다」여서 정반대를 말했다(ADR-0204 맥락, #2899).
  it('방해 금지 줄은 알림도 함께 멈춘다고 말한다', async () => {
    const sheet = await openSheet();
    const hint = within(sheet).getByTestId('presence-option-dnd').props
      .accessibilityHint as string;
    expect(hint).toContain('알림도 함께 멈춰요');
    expect(hint).not.toContain('멈춥니다');
    expect(within(sheet).getByTestId('presence-option-dnd')).toHaveTextContent(
      /알림도 함께 멈춰요/,
    );
  });
});

describe('알림 일시 중지 (#2848)', () => {
  it('스위치 줄이 스위치로 읽히고, 켜려 하면 쓰지 않고 기한 장이 열린다', async () => {
    const sheet = await openSheet();
    const row = within(sheet).getByTestId('profile-pause-row');
    await waitFor(() =>
      expect(row.props.accessibilityState).toMatchObject({disabled: false}),
    );
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toMatchObject({checked: false});

    fireEvent.press(row);

    // 기한을 고르기 전에는 아무것도 쓰지 않고 스위치는 꺼진 채다(ADR-0204 D2).
    expect(within(sheet).getByTestId('pause-until-page')).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rulesPuts()).toHaveLength(0);
  });

  it('기한을 고르면 일시 중지 하나와 그 기한만 PATCH 로 싣는다', async () => {
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({disabled: false}),
    );
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    const before = Date.now();
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    // 멘션 예외는 싣지 않는다 — 서버가 도착한 때의 값을 지킨다(#3042).
    expect(rulesPuts()[0]).toMatchObject({method: 'PATCH'});
    const body = rulesPuts()[0].body as {dnd: boolean; dndUntilMs: number};
    expect(Object.keys(body).sort()).toEqual(['dnd', 'dndUntilMs']);
    expect(body.dnd).toBe(true);
    expect(body.dndUntilMs).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(body.dndUntilMs).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(server.rules).toMatchObject({dnd: true, mentionOverridesMute: true});
    // 장이 닫히고 프로필로 돌아와 스위치가 켜진 채 기한을 말한다.
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: true}),
    );
    expect(within(sheet).queryByTestId('pause-until-page')).toBeNull();
    expect(within(sheet).getByTestId('profile-pause-row')).toHaveTextContent(
      /이 워크스페이스의 알림을 받지 않아요/,
    );
    expect(within(sheet).getByTestId('profile-pause-until-row')).toHaveTextContent(
      /까지 · 기한 바꾸기/,
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
    fireEvent.press(within(sheet).getByTestId('pause-until-option-30m'));
    // 실패하면 기한 장에 남아 그렇게 말한다(프로필로 돌아가 켜진 척하지 않는다).
    await waitFor(() =>
      expect(within(sheet).getByTestId('pause-until-failure')).toHaveTextContent(
        '알림 설정을 바꾸지 못했어요. 다시 시도하세요.',
      ),
    );
    expect(within(sheet).getByTestId('pause-until-page')).toBeTruthy();
    fireEvent.press(within(sheet).getByTestId('settings-back'));
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
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    // 싣는 것은 일시 중지와 그 기한뿐이다 — 멘션 예외 키는 없다.
    expect(Object.keys(rulesPuts()[0].body as object).sort()).toEqual([
      'dnd',
      'dndUntilMs',
    ]);
    expect(server.rules).toMatchObject({dnd: true, mentionOverridesMute: true});
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
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));

    await waitFor(() => expect(rulesPuts()).toHaveLength(1));
    expect(server.rules).toMatchObject({dnd: true, mentionOverridesMute: true});
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
    // 서버에 기한 없는 행이 있다 — 옛 판이 만든 것이다. 「직접 끌 때까지」라는 약속은 이제 없고,
    // 대신 별도 줄이 「기한 없음 · 기한 정하기」로 말한다(ADR-0204 D2).
    expect(row).toHaveTextContent(/이 워크스페이스의 알림을 받지 않아요/);
    expect(row).not.toHaveTextContent(/직접 끌 때까지/);
    expect(within(sheet).getByTestId('profile-pause-until-row')).toHaveTextContent(
      /기한 없음 · 기한 정하기/,
    );
  });
});

describe('상태 설정 바텀시트 (#2848, ADR-0176, #4457)', () => {
  /** ✓ 는 머리의 확정 단추다. 비활성이면 `accessibilityState.disabled` 가 말한다(색이 아니다). */
  const confirm = (sheet: ReturnType<typeof within>) => sheet.getByTestId('status-save');
  const confirmDisabled = (sheet: ReturnType<typeof within>) =>
    confirm(sheet).props.accessibilityState?.disabled === true;
  /** 시트는 닫히는 길 어디서든 미끄러져 나간 뒤 사라진다(#2714). */
  const sheetGone = () =>
    waitFor(() => expect(screen.queryByTestId('status-sheet')).toBeNull(), {
      timeout: 8000,
    });

  it('행을 누르면 시트가 열리고, 입력 전에는 ✓ 가 회색이라 눌러도 아무것도 쓰지 않는다', async () => {
    const sheet = await openSheet();
    expect(screen.queryByTestId('status-sheet')).toBeNull();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    expect(within(sheet).getByTestId('status-sheet')).toBeTruthy();
    // 설정 페이지는 시트 뒤에 그대로 남는다.
    expect(within(sheet).getByTestId('presence-option-auto')).toBeTruthy();
    expect(confirmDisabled(within(sheet))).toBe(true);
    fireEvent.press(confirm(within(sheet)));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(presencePuts()).toHaveLength(0);
  });

  it('내용 맞춤 높이로 선다 — 큰 단(위 58 에서 바닥까지)이 아니라서 뒤의 설정 페이지가 위쪽에 남는다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    const frame = StyleSheet.flatten(within(sheet).getByTestId('page-sheet').props.style);
    // `fit` 의 상자: 최대 높이만 있고(내용이 정한다) 위 끝·고정 높이가 없다. 큰 단은 `top` 만 있다.
    expect(frame.maxHeight).toBe(Math.floor(Dimensions.get('window').height * SHEET.fitMaxRatio));
    expect(frame.top).toBeUndefined();
    expect(frame.height).toBeUndefined();
  });

  it('프리셋·1시간을 골라 저장하면 선언 상태를 그대로 싣고, 시트가 닫히며 알약에 보인다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    expect(confirmDisabled(within(sheet))).toBe(true);

    fireEvent.press(within(sheet).getByTestId('status-preset-meeting'));
    // 글을 채우자 ✓ 가 눌린다.
    expect(confirmDisabled(within(sheet))).toBe(false);
    // 기간은 한 줄로 접혀 있다 — 누르면 그 자리에서 고른다(시트 위 시트 없음).
    expect(within(sheet).queryByTestId('status-expiry-1h')).toBeNull();
    fireEvent.press(within(sheet).getByTestId('status-expiry-row'));
    fireEvent.press(within(sheet).getByTestId('status-expiry-1h'));
    expect(within(sheet).getByTestId('status-expiry-row')).toHaveTextContent(/1시간/);
    const before = Date.now();
    fireEvent.press(confirm(within(sheet)));

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
    await sheetGone();
  }, 20000);

  it('저장된 만료는 「지금대로」가 기본이고, 글만 고쳐 저장하면 만료 키를 보내지 않는다', async () => {
    server.self = {
      ...baseSelf(),
      statusEmoji: '🏠',
      statusText: '재택',
      statusExpiresAtMs: Date.now() + 3 * 60 * 60_000,
    };
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    // 바뀐 것이 없으면 ✓ 는 회색이다.
    expect(confirmDisabled(within(sheet))).toBe(true);
    expect(within(sheet).getByTestId('status-expiry-row')).toHaveTextContent(/지금대로/);
    fireEvent.press(within(sheet).getByTestId('status-expiry-row'));
    expect(
      within(sheet).getByTestId('status-expiry-keep').props.accessibilityState,
    ).toMatchObject({selected: true});

    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '재택 근무');
    expect(confirmDisabled(within(sheet))).toBe(false);
    fireEvent.press(confirm(within(sheet)));

    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    expect(JSON.stringify(presencePuts()[0].body)).toBe(
      '{"status":"dnd","statusEmoji":"🏠","statusText":"재택 근무"}',
    );
    await sheetGone();
  }, 20000);

  it('고쳤다가 처음 값으로 되돌리면 다시 바뀐 것이 없다 — ✓ 가 다시 회색이다', async () => {
    server.self = {...baseSelf(), statusEmoji: '🏠', statusText: '재택'};
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    expect(confirmDisabled(within(sheet))).toBe(true);
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '재택 근무');
    expect(confirmDisabled(within(sheet))).toBe(false);
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '재택');
    expect(confirmDisabled(within(sheet))).toBe(true);
    // 공백만 덧붙인 것은 같은 글이다 — 서버로 갈 때 잘리는 값으로 잰다.
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '재택  ');
    expect(confirmDisabled(within(sheet))).toBe(true);
  });

  it('비운 입력은 지울 상태가 있을 때만 저장이다 — 없으면 기간만 바꿔도 ✓ 는 회색이다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.press(within(sheet).getByTestId('status-expiry-row'));
    fireEvent.press(within(sheet).getByTestId('status-expiry-30m'));
    expect(confirmDisabled(within(sheet))).toBe(true);
    // 보이는 상태가 없으니 「상태 지우기」 줄도 없다.
    expect(within(sheet).queryByTestId('status-clear')).toBeNull();
  });

  it('다 지운 채 ✓ 를 누르면 상태 지우기와 같은 쓰기다', async () => {
    server.self = {...baseSelf(), statusEmoji: '🌴', statusText: '휴가'};
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.changeText(within(sheet).getByTestId('status-emoji-input'), '');
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '');
    expect(confirmDisabled(within(sheet))).toBe(false);
    fireEvent.press(confirm(within(sheet)));
    await waitFor(() => expect(presencePuts()).toHaveLength(1));
    expect(presencePuts()[0].body).toEqual({
      status: 'dnd',
      statusEmoji: null,
      statusText: null,
      statusExpiresAtMs: null,
    });
    await sheetGone();
  }, 20000);

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
    await sheetGone();
  }, 20000);

  it('저장이 실패하면 시트에 남아 그렇게 말하고 ✓ 는 다시 눌린다', async () => {
    server.presenceFails = true;
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '집중');
    fireEvent.press(confirm(within(sheet)));
    await waitFor(() =>
      expect(within(sheet).getByTestId('status-failure')).toHaveTextContent(
        '상태를 저장하지 못했습니다. 다시 시도하세요.',
      ),
    );
    expect(within(sheet).getByTestId('status-sheet')).toBeTruthy();
    await waitFor(() => expect(confirmDisabled(within(sheet))).toBe(false));
  });

  it('원형 X 는 저장하지 않고 시트만 닫는다 — 설정 페이지는 남는다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-status-row'));
    fireEvent.changeText(within(sheet).getByTestId('status-text-input'), '집중');
    fireEvent.press(within(sheet).getByTestId('status-sheet-close'));
    await sheetGone();
    expect(within(sheet).getByTestId('presence-option-auto')).toBeTruthy();
    expect(presencePuts()).toHaveLength(0);
  }, 20000);
});

// =============================================================================
// design-review #4457 r1 — 상태 설정 시트가 고친 것 (H1 · H2 · M1 · M4 · M5).
//   H1  두 카드 모두 앞 칸이 없다 — 빠른 상태의 이모지는 이름 앞 글자라 「기간」 카드와 제목 시작이 같다
//   H2  둘째 줄의 이름은 코어의 만료 낱말이다 — 「지우기」는 파괴 행(「상태 지우기」) 하나만의 이름이다
//   M1  이모지 칸의 눌림 영역이 44×44 이상이고 안내 「＋」 는 컨트롤 색이다
//   M4  펼침 행이 펼침 상태를 말하고 ⌄ 가 뒤집힌다
//   M5  접힌 행의 긴 값(「지금대로 · 10월 27일 …까지」)이 두 줄까지 읽힌다
// =============================================================================
describe('상태 설정 시트 — design-review r1 반영 (#4457)', () => {
  async function openStatusSheet() {
    const page = await openSheet();
    fireEvent.press(within(page).getByTestId('profile-status-row'));
    return within(within(page).getByTestId('status-sheet'));
  }

  it('H2: 기간 행의 이름은 코어의 만료 낱말이고, 파괴 동사 「지우기」는 「상태 지우기」 한 곳에만 있다', async () => {
    server.self = {...baseSelf(), statusEmoji: '🌴', statusText: '휴가'};
    const sheet = await openStatusSheet();
    const row = sheet.getByTestId('status-expiry-row');
    expect(row).toHaveTextContent(new RegExp(CUSTOM_STATUS_EXPIRY_LABEL));
    expect(row.props.accessibilityLabel).toBe(`${CUSTOM_STATUS_EXPIRY_LABEL}, 지우지 않음`);
    // 시트 안에서 「지우기」가 들어간 글자는 파괴 행의 이름 하나뿐이다(대조: 그 행은 실제로 있다). 인스턴스가 아니라 글자로 비교한다 —
    // 실패했을 때 React 트리 전체를 찍다가 메모리가 터진다.
    const withVerb = sheet.getAllByText(/지우기/).map(node => node.props.children);
    expect(withVerb).toEqual([CUSTOM_STATUS_CLEAR_LABEL]);
    expect(within(sheet.getByTestId('status-clear')).getByText(CUSTOM_STATUS_CLEAR_LABEL)).toBeTruthy();
    // 접근성 이름도 같다 — 파괴 행 말고는 「지우기」로 시작하지 않는다.
    expect(row.props.accessibilityLabel).not.toMatch(/지우기/);
  });

  it('H1: 두 카드 모두 앞 칸이 없다 — 이모지는 이름 앞에 글자로 붙고, 구분선은 한 열에서 시작한다', async () => {
    const sheet = await openStatusSheet();
    fireEvent.press(sheet.getByTestId('status-expiry-row')); // 기간 카드에도 구분선이 서게 연다
    // testID 로 비교한다 — 인스턴스를 비교하면 실패했을 때 React 트리 전체를 찍다가 메모리가 터진다(사보타주 Q49).
    expect(
      sheet.queryAllByTestId(/-lead$/, {includeHiddenElements: true}).map(node => node.props.testID),
    ).toEqual([]);
    for (const preset of CUSTOM_STATUS_PRESETS) {
      const row = sheet.getByTestId(`status-preset-${preset.id}`);
      expect(row).toHaveTextContent(`${preset.emoji}  ${preset.label}`);
      // 낭독에는 이모지 없이 이름만 읽힌다.
      expect(row.props.accessibilityLabel).toBe(preset.label);
    }
    const indents = sheet
      .getAllByTestId('group-divider')
      .map(divider => StyleSheet.flatten(divider.props.style).marginLeft);
    expect(indents.length).toBeGreaterThan(CUSTOM_STATUS_PRESETS.length - 1); // 두 카드의 선이 다 있다
    expect(new Set(indents)).toEqual(new Set([dividerIndent('plain')]));
  });

  it('M1: 이모지 칸은 44×44 이상의 눌림 영역이고, 안내 「＋」 는 글 칸 안내문과 다른 컨트롤 색이다', async () => {
    const sheet = await openStatusSheet();
    const emoji = sheet.getByTestId('status-emoji-input');
    const style = StyleSheet.flatten(emoji.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(style.alignSelf).toBe('stretch'); // 알약 높이 전체를 쓴다
    // 22pt 칸의 글리프라 큰 글씨에서도 배율을 따라가지 않는다.
    expect(emoji.props.maxFontSizeMultiplier).toBe(ROW_GLYPH_MAX_SCALE);
    const text = sheet.getByTestId('status-text-input');
    expect([lightPalette.icon, darkPalette.icon]).toContain(emoji.props.placeholderTextColor);
    expect(emoji.props.placeholderTextColor).not.toBe(text.props.placeholderTextColor);
  });

  it('M4: 기간 행은 펼침 상태를 말하고, 펼치면 ⌄ 가 뒤집히며 고르면 다시 접힌다', async () => {
    const sheet = await openStatusSheet();
    const row = () => sheet.getByTestId('status-expiry-row');
    const flip = () =>
      StyleSheet.flatten(sheet.getByTestId('status-expiry-row-expand', {includeHiddenElements: true}).props.style)
        .transform;
    expect(row().props.accessibilityState).toMatchObject({expanded: false});
    expect(flip()).toBeUndefined();
    fireEvent.press(row());
    expect(row().props.accessibilityState).toMatchObject({expanded: true});
    expect(flip()).toEqual([{rotate: '180deg'}]);
    fireEvent.press(sheet.getByTestId('status-expiry-30m'));
    expect(row().props.accessibilityState).toMatchObject({expanded: false});
    expect(flip()).toBeUndefined();
  });

  it('M5: 접힌 행의 값은 두 줄까지 읽힌다 — 저장된 만료가 「지금대로 · …까지」로 길어져도', async () => {
    server.self = {
      ...baseSelf(),
      statusEmoji: '🏠',
      statusText: '재택',
      statusExpiresAtMs: Date.now() + 30 * 60 * 60_000, // 내일이 아닌 다른 날
    };
    // 시험 환경의 창은 글자 배율 2 라 값이 제목 아래로 쌓인다(큰 글씨 배치) — 기본 글씨(오른쪽에 선 값)의 배치를 잰다.
    const real = Dimensions.get('window');
    jest.spyOn(Dimensions, 'get').mockImplementation(() => ({...real, fontScale: 1}) as never);
    const sheet = await openStatusSheet();
    const value = sheet.getByTestId('status-expiry-row-value');
    expect(value).toHaveTextContent(/지금대로 · .+까지/);
    expect(value.props.numberOfLines).toBe(2);
    // 두 줄을 허용한 값은 어절 단위로 줄을 바꾼다 — 그렇지 않으면 「온보/딩」 으로 어절 가운데서 끊긴다(r2 H1).
    expect(value.props.lineBreakStrategyIOS).toBe('hangul-word');
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

// =============================================================================
// #4457 — 각 행은 **해당** 시트나 안쪽 장을 연다
//
// 설정 페이지의 행은 세 가지 목적지로 갈린다(`phone-sheets.md` §1): 짧은 편집은 **바텀시트**,
// 여러 묶음·더 들어가는 행은 **안쪽 장**(설정 위에 한 겹 더 쌓이고 머리의 ‹ 뒤로가 설정으로
// 돌려보낸다). 이 표가 행마다 어디로 가는지를 못 박는다 — 행을 엉뚱한 곳에 잇거나 시트였던 것이
// 페이지가 되어 버려도(또는 그 반대) 여기가 빨개진다.
// =============================================================================
describe('각 행은 해당 시트나 안쪽 장을 연다 (#4457)', () => {
  type Dest =
    | {kind: 'sheet'; testID: string; close: string}
    | {kind: 'sub'; title: string; body: string};
  const TABLE: readonly {row: string; hidden?: boolean; dest: Dest}[] = [
    {
      row: 'profile-status-row',
      dest: {kind: 'sheet', testID: 'status-sheet', close: 'status-sheet-close'},
    },
    {
      row: 'presence-option-dnd',
      dest: {kind: 'sub', title: '방해 금지', body: 'pause-until-page'},
    },
    {
      row: 'profile-dnd-until-row',
      dest: {kind: 'sub', title: '방해 금지', body: 'pause-until-page'},
    },
    {
      row: 'profile-pause-row',
      dest: {kind: 'sub', title: '알림 일시 중지', body: 'pause-until-page'},
    },
    {
      row: 'profile-theme-row',
      dest: {kind: 'sub', title: '테마', body: 'theme-control'},
    },
    {
      row: 'profile-device-key-row',
      dest: {kind: 'sub', title: '지시 기기', body: 'settings-sub-scroll'},
    },
    {
      row: 'self-profile-avatar-change',
      dest: {kind: 'sub', title: '프로필 사진', body: 'avatar-page'},
    },
    {
      // 큰 얼굴은 보조기술에서 숨는다(낭독은 「사진 바꾸기」 행이 맡는다) — 눈으로 누르는 길.
      row: 'self-profile-avatar',
      hidden: true,
      dest: {kind: 'sub', title: '프로필 사진', body: 'avatar-page'},
    },
  ];

  it.each(TABLE.map(entry => [entry.row, entry] as const))(
    '%s → 목적지가 맞고, 닫으면 설정 페이지로 돌아온다',
    async (_row, entry) => {
      const page = await openSheet();
      // 일시 중지 행은 규칙을 읽은 뒤에야 눌린다.
      await waitFor(() =>
        expect(
          within(page).getByTestId('profile-pause-row').props.accessibilityState,
        ).toMatchObject({disabled: false}),
      );
      fireEvent.press(
        within(page).getByTestId(entry.row, {includeHiddenElements: entry.hidden}),
      );
      if (entry.dest.kind === 'sheet') {
        expect(within(page).getByTestId(entry.dest.testID)).toBeTruthy();
        // 시트는 안쪽 장이 아니다 — 한 겹 쌓이지 않는다.
        expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
        fireEvent.press(within(page).getByTestId(entry.dest.close));
        await waitFor(
          () => expect(screen.queryByTestId('status-sheet')).toBeNull(),
          {timeout: 8000},
        );
      } else {
        expect(within(page).getByTestId('settings-sub-pane')).toBeTruthy();
        expect(within(page).getByTestId('settings-sub-title')).toHaveTextContent(
          entry.dest.title,
        );
        expect(within(page).getByTestId(entry.dest.body)).toBeTruthy();
        // 시트가 아니다 — 상태 시트가 함께 뜨지 않는다.
        expect(screen.queryByTestId('status-sheet')).toBeNull();
        fireEvent.press(within(page).getByTestId('settings-back'));
        expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
      }
      expect(within(page).getByTestId('presence-option-auto')).toBeTruthy();
    },
    20000,
  );
});

// =============================================================================
// #4457 — 기능 손실 0 (전수 표)
//
// 옛 프로필 시트와 그 하위 쪽이 하던 일이 설정 페이지에 **모두** 있다. 표의 한 줄 = 사람이 하던 일
// 하나(`scratchpad/4457/inventory.md`). 조건부 줄(방해 금지 기한 · 일시 중지 기한 · 다시 불러오기 ·
// 보이는 상태 글)은 그 조건을 세운 서버로 따로 세운다 — 한 서버로는 절반을 못 본다.
//
// 행 하나를 지우면(또는 testID 가 바뀌면) 여기가 빨개진다. 숨은 원소(스위치·큰 얼굴)는
// `includeHiddenElements` 로 찾는다.
// =============================================================================
describe('기능 손실 0 — 옛 프로필 시트가 하던 일이 설정 페이지에 모두 있다 (#4457)', () => {
  const present = (page: ReturnType<typeof within>, ids: readonly string[]) => {
    for (const id of ids) {
      expect({id, found: page.queryByTestId(id, {includeHiddenElements: true}) !== null}).toEqual({
        id,
        found: true,
      });
    }
  };
  const absent = (page: ReturnType<typeof within>, ids: readonly string[]) => {
    for (const id of ids) {
      expect({id, found: page.queryByTestId(id, {includeHiddenElements: true}) !== null}).toEqual({
        id,
        found: false,
      });
    }
  };

  /** 머리·얼굴·카드의 늘 서는 줄. */
  const ALWAYS = [
    'settings-header',
    'settings-close',
    'settings-title',
    'self-profile-avatar',
    'self-profile-avatar-change',
    'self-profile-name',
    'self-profile-handle',
    'self-profile-presence',
    'profile-status-row',
    'presence-option-auto',
    'presence-option-away',
    'presence-option-dnd',
    'profile-push-row',
    'profile-pause-row',
    'profile-work-complete-row',
    'profile-always-row',
    'memory-section',
    'memory-pause-row',
    'memory-admin-row',
    'profile-theme-row',
    'profile-server-row',
    'profile-device-key-row',
    'sign-out',
    'profile-version',
  ] as const;

  it('늘 서는 줄이 전부 있다 — 방해 금지를 고른 사람', async () => {
    const page = await openSheet();
    await waitFor(() =>
      expect(
        within(page).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({disabled: false}),
    );
    // 값을 읽은 뒤에만 서는 스위치.
    await waitFor(() =>
      expect(
        within(page).getByTestId('profile-push-switch', {includeHiddenElements: true}),
      ).toBeTruthy(),
    );
    present(within(page), [
      ...ALWAYS,
      'profile-push-switch',
      'profile-pause-switch',
      'profile-work-complete-switch',
      // 선언 상태가 방해 금지라 선택 ✓ 와 기한 줄이 선다.
      'presence-dnd-check',
      'profile-dnd-until-row',
    ]);
    // 선택되지 않은 줄에는 ✓ 가 없다.
    absent(within(page), ['presence-auto-check', 'presence-away-check']);
    // 켜지지 않은 것들의 줄은 없다.
    absent(within(page), [
      'profile-pause-until-row',
      'profile-pause-retry',
      'profile-work-complete-retry',
      'self-profile-custom-status',
      'sign-out-confirm-block',
      'presence-failure',
    ]);
  });

  it('조건부 줄 — 일시 중지가 켜져 있고 보이는 상태 글이 있는 사람(온라인)', async () => {
    server.self = {
      ...baseSelf(),
      presenceStatus: 'auto',
      statusEmoji: '🏠',
      statusText: '재택',
    };
    server.rules = {dnd: true, mentionOverridesMute: true, dndUntilMs: Date.now() + 2 * 60 * 60_000};
    const page = await openSheet();
    await waitFor(() =>
      expect(within(page).getByTestId('profile-pause-until-row')).toBeTruthy(),
    );
    present(within(page), [
      ...ALWAYS,
      'profile-pause-until-row',
      'self-profile-custom-status',
      'presence-auto-check',
    ]);
    // 방해 금지가 아니니 방해 금지 기한 줄은 없다.
    absent(within(page), ['profile-dnd-until-row', 'presence-dnd-check']);
    expect(within(page).getByTestId('profile-status-row')).toHaveTextContent(/🏠 재택/);
  });

  it('조건부 줄 — 읽기에 실패하면 「다시 불러오기」가 둘 서고 스위치는 없다', async () => {
    server.rulesRead = 'fail';
    server.kindsRead = 'fail';
    const page = await openSheet();
    await waitFor(() =>
      expect(within(page).getByTestId('profile-pause-retry')).toBeTruthy(),
    );
    // 종류 질의는 한 번 다시 시도한 뒤(react-query 기본 지연 1초) 실패로 선다.
    await waitFor(
      () => expect(within(page).getByTestId('profile-work-complete-retry')).toBeTruthy(),
      {timeout: 4000},
    );
    present(within(page), ALWAYS);
    // 모르는 것은 말하지 않는다 — 읽지 못한 값 위에 「꺼짐」 스위치를 그리지 않는다.
    absent(within(page), ['profile-pause-switch', 'profile-work-complete-switch']);
  });

  it('r3 M1: 읽기 실패의 「다시 불러오기」는 강조색 글자다 — 눌리지 않는 정보 행과 같은 모양이 아니다', async () => {
    server.rulesRead = 'fail';
    server.kindsRead = 'fail';
    const page = await openSheet();
    await waitFor(
      () => expect(within(page).getByTestId('profile-work-complete-retry')).toBeTruthy(),
      {timeout: 4000},
    );
    const titleStyle = (testID: string) =>
      StyleSheet.flatten(within(within(page).getByTestId(testID)).getByText('다시 불러오기').props.style);
    for (const id of ['profile-pause-retry', 'profile-work-complete-retry']) {
      // 옛 판의 `GroupRow tone="accent"` 를 지킨다: 강조색 + 굵게.
      expect(titleStyle(id)).toMatchObject({color: lightPalette.accentText, fontWeight: '600'});
      expect(titleStyle(id).color).not.toBe(lightPalette.text); // 대조군: 기본색이 아니다
    }
    // 눌리지 않는 정보 행은 기본색이다 — 두 모양이 갈린다.
    const info = StyleSheet.flatten(
      within(within(page).getByTestId('profile-always-row')).getByText('항상 오는 알림').props.style,
    );
    expect(info.color).toBe(lightPalette.text);
  });

  it('로그아웃 확인 블록은 같은 카드 안에서 행을 대신한다', async () => {
    const page = await openSheet();
    fireEvent.press(within(page).getByTestId('sign-out'));
    present(within(page), [
      'sign-out-confirm-block',
      'sign-out-cancel',
      'sign-out-confirm',
    ]);
    absent(within(page), ['sign-out']);
    fireEvent.press(within(page).getByTestId('sign-out-cancel'));
    present(within(page), ['sign-out']);
    absent(within(page), ['sign-out-confirm-block']);
  });
});
