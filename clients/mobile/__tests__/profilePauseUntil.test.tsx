import type {Member} from '@momo/core/lib/api';
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

import {ThemeProvider} from '../src/design/theme';
import {PauseUntilPage} from '../src/features/profile/PauseUntilPage';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2899 — 알림 일시 중지·방해 금지는 **기한을 고르고서야** 켜진다 (ADR-0204 D2).
//
// 이 파일이 지는 것:
//   1. 방해 금지를 고르면 `PUT /presence {status:'dnd', dndUntilMs}` 가 나가고,
//      **notification-rules 는 PUT 도 PATCH 도 나가지 않는다**(서버가 같은 트랜잭션에서
//      묶어 켠다, ADR-0124 증보 2). 대신 규칙을 **다시 읽어** 일시 중지 스위치가 실제 값을 보인다.
//   2. 알림 일시 중지는 기한 장에서 고른 뒤에만 `PATCH {dnd:true, dndUntilMs}` 로 나간다.
//      「직접 끌 때까지」를 고르는 길은 어디에도 없다.
//   3. 기한 없는 행(옛 판)은 「기한 없음 · 기한 정하기」로 보이고, 누르면 기한 장이 열린다.
//   4. 「직접 고르기」: 달력 한 달 + 시각 칩. 처음 값은 이미 미래이고, 지난 시각은 막힌다.
//
// 서버는 fetch 하나만 가짜다. `profileStatus.test.tsx` 와 달리 이 가짜는 **방해 금지 묶음을
// 흉내 낸다**(ADR-0124 증보 2 D8): presence 가 dnd 로 가면 규칙도 같은 기한으로 켜고, 켜기 전
// 값을 한 번만 기억했다가 풀 때 되돌린다. 묶음을 흉내 내지 않으면 「방해 금지를 쓴 뒤 규칙을
// 다시 읽는다」가 참인지 잴 수 없다.
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
type Rules = {dnd: boolean; mentionOverridesMute: boolean; dndUntilMs?: number};

interface Server {
  self: SelfRow;
  rules: Rules;
  /** 방해 금지를 고르기 전의 규칙. 있으면 둘이 묶여 있다(증보 2 D8). */
  memo: {dnd: boolean; dndUntilMs?: number} | null;
  /** 규칙 GET 이 몇 번 왔나 — 「방해 금지를 쓴 뒤 다시 읽는다」를 잰다. */
  rulesGets: number;
  presenceFails: boolean;
  rulesWriteFails: boolean;
  /** 명부 GET 이 끝나지 않는다 — 서버 답이 오기 전의 **낙관 갱신**만 남겨 본다. */
  rosterHangs: boolean;
  writes: {path: string; method: string; body: unknown}[];
}

let server: Server;

function selfRow(over: SelfRow = {}): SelfRow {
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
    presenceStatus: 'auto',
    ...over,
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
      return jsonResponse(200, {workComplete: true});
    }
    if (url.includes('/notification-rules')) {
      if (method === 'PUT' || method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        server.writes.push({path: 'notification-rules', method, body});
        if (server.rulesWriteFails) return jsonResponse(500, {error: {message: 'x'}});
        // 직접 편집은 방해 금지와의 묶음을 끊는다(증보 2 D8, 증보 3).
        server.memo = null;
        const next: Rules = {...server.rules, ...body};
        if (body.dnd === false || body.dndUntilMs === null) delete next.dndUntilMs;
        server.rules = next;
        return jsonResponse(200, server.rules);
      }
      server.rulesGets += 1;
      return jsonResponse(200, {...server.rules});
    }
    if (url.includes('/presence')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      server.writes.push({path: 'presence', method, body});
      if (server.presenceFails) return jsonResponse(500, {error: {message: 'x'}});
      const next: SelfRow = {...server.self, presenceStatus: body.status};
      if (body.status === 'dnd') {
        if (!server.memo) {
          server.memo = {
            dnd: server.rules.dnd,
            dndUntilMs: server.rules.dndUntilMs,
          };
        }
        const until =
          'dndUntilMs' in body ? body.dndUntilMs : (server.self.dndUntilMs as number);
        const rules: Rules = {...server.rules, dnd: true};
        if (typeof until === 'number') {
          rules.dndUntilMs = until;
          next.dndUntilMs = until;
        } else {
          delete rules.dndUntilMs;
          delete next.dndUntilMs;
        }
        server.rules = rules;
      } else {
        delete next.dndUntilMs;
        if (server.memo) {
          const restored: Rules = {...server.rules, dnd: server.memo.dnd};
          if (server.memo.dndUntilMs === undefined) delete restored.dndUntilMs;
          else restored.dndUntilMs = server.memo.dndUntilMs;
          server.rules = restored;
          server.memo = null;
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
      if (server.rosterHangs) return new Promise<Response>(() => {});
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
  // 운영 클라이언트의 신선도(`createQueryClient`: staleTime 30초, 기본 gcTime)를 따른다. `gcTime: 0`
  // 으로 두면 기한 장을 떠날 때 규칙 질의가 버려졌다가 돌아올 때 **저절로** 다시 읽혀서, 방해 금지 뒤의
  // 무효화가 빠져도 시험이 초록이 된다(사보타주로 확인했다). 운영에서는 30초 안에 돌아오면 캐시가
  // 신선해 다시 읽지 않는다 — 그래서 무효화가 필요하다.
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, staleTime: 30_000},
      mutations: {retry: false},
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
    self: selfRow(),
    rules: {dnd: false, mentionOverridesMute: true},
    memo: null,
    rulesGets: 0,
    presenceFails: false,
    rulesWriteFails: false,
    rosterHangs: false,
    writes: [],
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
  // 규칙을 한 번 읽어야 일시 중지 줄이 선다.
  await waitFor(() =>
    expect(
      within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
    ).toMatchObject({disabled: false}),
  );
  return sheet;
}

const presenceWrites = () => server.writes.filter(w => w.path === 'presence');
const rulesWrites = () => server.writes.filter(w => w.path === 'notification-rules');
const at = (day: number, hour: number, minute = 0, month = 10) =>
  new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();

/** 시계를 고정한다. 2026-10-16 은 금요일이다. */
function freezeClock(ms: number) {
  jest.spyOn(Date, 'now').mockReturnValue(ms);
}
const FRI_2107 = at(16, 21, 7);

const OPTION_IDS = ['30m', '1h', '2h', 'tomorrow', 'nextMonday', 'custom'];

describe('방해 금지 — 기한을 고르고서야 켜진다 (ADR-0204 D2)', () => {
  it('방해 금지를 누르면 아무것도 쓰지 않고 기한 장이 열린다', async () => {
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));

    expect(within(sheet).getByTestId('pause-until-page')).toBeTruthy();
    expect(within(sheet).getByTestId('pause-until-title')).toHaveTextContent(
      '방해 금지를 언제까지 켤까요?',
    );
    // 이유는 이 장 머리에 있다 — 다른 사람에게 보이는 표시이고 알림도 함께 멈춘다.
    expect(within(sheet).getByTestId('pause-until-description')).toHaveTextContent(
      /알림도 함께 멈춰요/,
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(server.writes).toEqual([]);
    // 고르지 않고 돌아오면 상태는 그대로 온라인이다.
    fireEvent.press(within(sheet).getByTestId('profile-back'));
    expect(
      within(sheet).getByTestId('presence-option-auto').props.accessibilityState,
    ).toMatchObject({selected: true});
    expect(server.writes).toEqual([]);
  });

  // Acceptance (#2899): 방해 금지를 고를 때 notification-rules PUT/PATCH 가 나가지 않는다.
  it('30분을 고르면 PUT /presence 가 방해 금지와 기한을 싣고, notification-rules 는 쓰지 않는다', async () => {
    const sheet = await openSheet();
    const getsBefore = server.rulesGets;
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    const before = Date.now();
    fireEvent.press(within(sheet).getByTestId('pause-until-option-30m'));

    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    const body = presenceWrites()[0].body as {status: string; dndUntilMs: number};
    expect(Object.keys(body).sort()).toEqual(['dndUntilMs', 'status']);
    expect(body.status).toBe('dnd');
    expect(body.dndUntilMs).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(body.dndUntilMs).toBeLessThanOrEqual(Date.now() + 30 * 60_000);

    // 규칙은 쓰지 않는다 — 서버가 같은 트랜잭션에서 묶어 켠다.
    expect(rulesWrites()).toEqual([]);
    // 대신 다시 읽는다. 그래서 스위치가 서버의 실제 값(켜짐)을 보인다.
    await waitFor(() => expect(server.rulesGets).toBeGreaterThan(getsBefore));
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: true}),
    );
    expect(server.rules).toMatchObject({dnd: true, dndUntilMs: body.dndUntilMs});
    // 장이 닫히고, 상태 알약과 방해 금지 줄이 끝나는 때를 말한다.
    expect(within(sheet).queryByTestId('pause-until-page')).toBeNull();
    await waitFor(() =>
      expect(within(sheet).getByTestId('self-profile-presence')).toHaveTextContent(
        '방해 금지',
      ),
    );
    // 두 줄이 같은 기한을 말한다 — 방해 금지가 일시 중지를 같은 기한으로 묶어 켰다.
    expect(within(sheet).getByTestId('profile-dnd-until-row')).toHaveTextContent(
      /까지 · 기한 바꾸기/,
    );
    expect(within(sheet).getByTestId('profile-pause-until-row')).toHaveTextContent(
      /까지 · 기한 바꾸기/,
    );
  });

  // 서버 답(명부 재조회)이 오기 전에도 줄이 고른 기한을 말한다 — 낙관 갱신이 기한을 싣는다.
  it('명부 재조회가 오기 전에도 방해 금지 줄이 방금 고른 끝나는 때를 말한다', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    server.rosterHangs = true;
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));

    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    await waitFor(() =>
      expect(within(sheet).getByTestId('profile-dnd-until-row')).toHaveTextContent(
        /오후 10:07까지 · 기한 바꾸기/,
      ),
    );
  });

  it('방해 금지에서 나오면 규칙을 다시 읽어 켜기 전 값으로 돌아온 것을 보인다', async () => {
    // 방해 금지가 일시 중지를 묶어 켠 상태: 켜기 전에는 꺼져 있었다.
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0) + 86_400_000});
    server.rules = {
      dnd: true,
      mentionOverridesMute: true,
      dndUntilMs: at(16, 22, 0) + 86_400_000,
    };
    server.memo = {dnd: false};
    const sheet = await openSheet();
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: true}),
    );
    const getsBefore = server.rulesGets;

    fireEvent.press(within(sheet).getByTestId('presence-option-auto'));

    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    expect(JSON.stringify(presenceWrites()[0].body)).toBe('{"status":"auto"}');
    expect(rulesWrites()).toEqual([]);
    await waitFor(() => expect(server.rulesGets).toBeGreaterThan(getsBefore));
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
      ).toMatchObject({checked: false}),
    );
  });

  it('자리 비움으로 바꾸는 쓰기는 규칙을 다시 읽지 않는다 (방해 금지가 아니면 규칙이 안 바뀐다)', async () => {
    const sheet = await openSheet();
    const getsBefore = server.rulesGets;
    fireEvent.press(within(sheet).getByTestId('presence-option-away'));
    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('presence-option-away').props.accessibilityState,
      ).toMatchObject({selected: true}),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(server.rulesGets).toBe(getsBefore);
  });

  it('기한이 있는 방해 금지는 끝나는 때와 「기한 바꾸기」를 줄로 말하고, 누르면 현재 기한이 적힌 장이 열린다', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 23, 30)});
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 23, 30)};
    server.memo = {dnd: false};
    const sheet = await openSheet();

    expect(
      within(sheet).getByTestId('presence-option-dnd').props.accessibilityState,
    ).toMatchObject({selected: true});
    const until = within(sheet).getByTestId('profile-dnd-until-row');
    expect(until).toHaveTextContent(/오후 11:30까지 · 기한 바꾸기/);

    fireEvent.press(until);
    expect(within(sheet).getByTestId('pause-until-title')).toHaveTextContent(
      '방해 금지를 언제까지 켤까요?',
    );
    expect(within(sheet).getByTestId('pause-until-current')).toHaveTextContent(
      '지금은 오후 11:30까지예요.',
    );
    expect(presenceWrites()).toEqual([]);
  });

  it('방해 금지가 아닐 때는 방해 금지의 기한 줄이 없다', async () => {
    const sheet = await openSheet();
    expect(within(sheet).queryByTestId('profile-dnd-until-row')).toBeNull();
  });

  it('기한 없는 방해 금지(옛 판이 만든 행)는 「기한 없음 · 기한 정하기」로 보인다', async () => {
    server.self = selfRow({presenceStatus: 'dnd'});
    server.rules = {dnd: true, mentionOverridesMute: false};
    server.memo = {dnd: false};
    const sheet = await openSheet();

    const until = within(sheet).getByTestId('profile-dnd-until-row');
    expect(until).toHaveTextContent(/기한 없음 · 기한 정하기/);
    fireEvent.press(until);
    expect(within(sheet).getByTestId('pause-until-current')).toHaveTextContent(
      '지금은 기한이 없어요.',
    );
  });

  it('쓰기가 실패하면 기한 장에 남아 그렇게 말하고, 방해 금지가 켜지지 않는다', async () => {
    server.presenceFails = true;
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));

    await waitFor(() =>
      expect(within(sheet).getByTestId('pause-until-failure')).toHaveTextContent(
        '상태를 바꾸지 못했습니다. 다시 시도하세요.',
      ),
    );
    expect(within(sheet).getByTestId('pause-until-page')).toBeTruthy();
    fireEvent.press(within(sheet).getByTestId('profile-back'));
    await waitFor(() =>
      expect(
        within(sheet).getByTestId('presence-option-auto').props.accessibilityState,
      ).toMatchObject({selected: true}),
    );
    expect(rulesWrites()).toEqual([]);
  });
});

describe('기한 장 — 목록과 「직접 끌 때까지」의 부재', () => {
  it('여섯 줄이 이 순서로 서고 각 줄이 끝나는 때를 말한다', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));

    const ids = OPTION_IDS.filter(
      id => within(sheet).queryByTestId(`pause-until-option-${id}`) !== null,
    );
    expect(ids).toEqual(OPTION_IDS);
    const label = (id: string) =>
      within(sheet).getByTestId(`pause-until-option-${id}`).props.accessibilityLabel;
    expect(label('30m')).toBe('30분, 오후 9:37까지');
    expect(label('1h')).toBe('1시간, 오후 10:07까지');
    expect(label('2h')).toBe('2시간, 오후 11:07까지');
    expect(label('tomorrow')).toBe('내일 오전 9시까지, 10월 17일(토)');
    expect(label('nextMonday')).toBe('다음 주 월요일 오전 9시까지, 10월 19일(월)');
    expect(label('custom')).toBe('직접 고르기');
    // 기한 없이 켜는 줄은 없다.
    expect(within(sheet).queryByText(/끌 때까지/)).toBeNull();
    expect(within(sheet).queryByTestId('pause-until-option-none')).toBeNull();
  });

  it('일요일에는 「다음 주 월요일」이 「내일」과 같은 아침이라 줄이 빠진다', async () => {
    freezeClock(at(18, 10, 0));
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    expect(within(sheet).queryByTestId('pause-until-option-nextMonday')).toBeNull();
    expect(within(sheet).getByTestId('pause-until-option-tomorrow')).toBeTruthy();
  });

  it('「내일 오전 9시까지」는 달력의 내일 9시를 PATCH 로 싣는다', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    fireEvent.press(within(sheet).getByTestId('pause-until-option-tomorrow'));

    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: true, dndUntilMs: at(17, 9)});
    expect(rulesWrites()[0]).toMatchObject({method: 'PATCH'});
  });

  it('켜진 일시 중지의 기한을 바꾸는 줄은 현재 기한을 말하고, 새 기한을 같은 PATCH 로 싣는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30)};
    const sheet = await openSheet();
    const until = within(sheet).getByTestId('profile-pause-until-row');
    expect(until).toHaveTextContent(/오후 9:30까지 · 기한 바꾸기/);

    fireEvent.press(until);
    expect(within(sheet).getByTestId('pause-until-title')).toHaveTextContent(
      '알림을 언제까지 멈출까요?',
    );
    expect(within(sheet).getByTestId('pause-until-current')).toHaveTextContent(
      '지금은 오후 9:30까지예요.',
    );
    fireEvent.press(within(sheet).getByTestId('pause-until-option-2h'));

    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: true, dndUntilMs: FRI_2107 + 2 * 3_600_000});
  });

  it('기한 없는 일시 중지(옛 판이 만든 행)는 「기한 없음 · 기한 정하기」 줄로 기한 장에 닿는다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false};
    const sheet = await openSheet();
    const until = within(sheet).getByTestId('profile-pause-until-row');
    expect(until).toHaveTextContent(/기한 없음 · 기한 정하기/);
    fireEvent.press(until);
    expect(within(sheet).getByTestId('pause-until-current')).toHaveTextContent(
      '지금은 기한이 없어요.',
    );
  });

  it('켜진 일시 중지를 스위치로 끄면 기한 장을 거치지 않고 {dnd:false} 하나만 간다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 23, 0) + 86_400_000};
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));

    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: false});
    expect(within(sheet).queryByTestId('pause-until-page')).toBeNull();
    await waitFor(() =>
      expect(within(sheet).queryByTestId('profile-pause-until-row')).toBeNull(),
    );
  });

  it('규칙을 쓰지 못하면 기한 장에 남아 말하고, 스위치는 꺼진 채다', async () => {
    server.rulesWriteFails = true;
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    fireEvent.press(within(sheet).getByTestId('pause-until-option-1h'));
    await waitFor(() =>
      expect(within(sheet).getByTestId('pause-until-failure')).toHaveTextContent(
        '알림 설정을 바꾸지 못했어요. 다시 시도하세요.',
      ),
    );
    fireEvent.press(within(sheet).getByTestId('profile-back'));
    expect(
      within(sheet).getByTestId('profile-pause-row').props.accessibilityState,
    ).toMatchObject({checked: false});
  });
});

describe('직접 고르기 — 달력 한 달과 시각 칩', () => {
  async function openCustom(kind: 'pause' | 'dnd' = 'pause') {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(
      within(sheet).getByTestId(kind === 'pause' ? 'profile-pause-row' : 'presence-option-dnd'),
    );
    fireEvent.press(within(sheet).getByTestId('pause-until-option-custom'));
    expect(within(sheet).getByTestId('pause-until-custom')).toBeTruthy();
    return sheet;
  }

  it('열면 지금 다음의 정각이 놓여 있어 확인이 곧바로 눌린다', async () => {
    const sheet = await openCustom();
    expect(within(sheet).getByTestId('pause-until-summary')).toHaveTextContent('오후 10:00까지');
    expect(
      within(sheet).getByTestId('pause-until-day-2026-10-16').props.accessibilityState,
    ).toMatchObject({selected: true});
    expect(
      within(sheet).getByTestId('pause-until-meridiem-pm').props.accessibilityState,
    ).toMatchObject({selected: true});
    expect(
      within(sheet).getByTestId('pause-until-hour-10').props.accessibilityState,
    ).toMatchObject({selected: true});
    expect(
      within(sheet).getByTestId('pause-until-minute-0').props.accessibilityState,
    ).toMatchObject({selected: true});

    fireEvent.press(within(sheet).getByTestId('pause-until-confirm'));
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: true, dndUntilMs: at(16, 22, 0)});
  });

  it('내일 오전 9시 30분을 고르면 그 시각을 싣는다', async () => {
    const sheet = await openCustom();
    fireEvent.press(within(sheet).getByTestId('pause-until-day-2026-10-17'));
    fireEvent.press(within(sheet).getByTestId('pause-until-meridiem-am'));
    fireEvent.press(within(sheet).getByTestId('pause-until-hour-9'));
    fireEvent.press(within(sheet).getByTestId('pause-until-minute-30'));
    expect(within(sheet).getByTestId('pause-until-summary')).toHaveTextContent('내일 오전 9:30까지');

    fireEvent.press(within(sheet).getByTestId('pause-until-confirm'));
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: true, dndUntilMs: at(17, 9, 30)});
  });

  it('12시는 오전이면 0시, 오후면 낮 12시다', async () => {
    const sheet = await openCustom();
    fireEvent.press(within(sheet).getByTestId('pause-until-day-2026-10-17'));
    fireEvent.press(within(sheet).getByTestId('pause-until-meridiem-am'));
    fireEvent.press(within(sheet).getByTestId('pause-until-hour-12'));
    expect(within(sheet).getByTestId('pause-until-summary')).toHaveTextContent('내일 오전 12:00까지');
    fireEvent.press(within(sheet).getByTestId('pause-until-meridiem-pm'));
    expect(within(sheet).getByTestId('pause-until-summary')).toHaveTextContent('내일 오후 12:00까지');
    fireEvent.press(within(sheet).getByTestId('pause-until-confirm'));
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: true, dndUntilMs: at(17, 12, 0)});
  });

  it('오늘의 지난 시각은 이유를 말하고 확인이 눌리지 않는다', async () => {
    const sheet = await openCustom();
    fireEvent.press(within(sheet).getByTestId('pause-until-meridiem-am'));
    fireEvent.press(within(sheet).getByTestId('pause-until-hour-9'));

    expect(within(sheet).getByTestId('pause-until-error')).toHaveTextContent(
      '지난 시각은 고를 수 없어요. 다른 시각을 고르세요.',
    );
    expect(within(sheet).queryByTestId('pause-until-summary')).toBeNull();
    const confirm = within(sheet).getByTestId('pause-until-confirm');
    expect(confirm.props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(confirm);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(server.writes).toEqual([]);
  });

  it('지난 날은 눌리지 않고, 이번 달에서는 이전 달로 갈 수 없다', async () => {
    const sheet = await openCustom();
    expect(
      within(sheet).getByTestId('pause-until-day-2026-10-15').props.accessibilityState,
    ).toMatchObject({disabled: true});
    expect(
      within(sheet).getByTestId('pause-until-day-2026-10-16').props.accessibilityState,
    ).toMatchObject({disabled: false});
    expect(
      within(sheet).getByTestId('pause-until-prev-month').props.accessibilityState,
    ).toMatchObject({disabled: true});
    expect(within(sheet).getByTestId('pause-until-month-title')).toHaveTextContent('2026년 10월');
  });

  it('다음 달로 넘겨 고른 날은 날짜가 붙은 이름으로 보이고, 방해 금지에서는 PUT /presence 로 간다', async () => {
    const sheet = await openCustom('dnd');
    fireEvent.press(within(sheet).getByTestId('pause-until-next-month'));
    expect(within(sheet).getByTestId('pause-until-month-title')).toHaveTextContent('2026년 11월');
    fireEvent.press(within(sheet).getByTestId('pause-until-day-2026-11-02'));
    expect(within(sheet).getByTestId('pause-until-summary')).toHaveTextContent(
      '11월 2일(월) 오후 10:00까지',
    );
    // 달을 되돌릴 수 있다.
    expect(
      within(sheet).getByTestId('pause-until-prev-month').props.accessibilityState,
    ).toMatchObject({disabled: false});

    fireEvent.press(within(sheet).getByTestId('pause-until-confirm'));
    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    expect(presenceWrites()[0].body).toEqual({status: 'dnd', dndUntilMs: at(2, 22, 0, 11)});
    expect(rulesWrites()).toEqual([]);
  });

  it('달력 칸은 읽어 주는 이름을 갖는다', async () => {
    const sheet = await openCustom();
    expect(
      within(sheet).getByTestId('pause-until-day-2026-10-17').props.accessibilityLabel,
    ).toBe('10월 17일 토요일');
  });
});

describe('기한 장 — 머리 문장의 줄바꿈', () => {
  it('머리 문장은 한글 어절 단위로 줄바꿈한다(큰 글씨에서 어절 한가운데서 끊기지 않는다)', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    const title = within(sheet).getByTestId('pause-until-title');
    expect(title.props.lineBreakStrategyIOS).toBe('hangul-word');
    // 본문 문장과 같은 규칙이다 — 머리만 글자 단위로 끊기면 같은 장에서 둘이 다르게 접힌다.
    expect(
      within(sheet).getByTestId('pause-until-description').props.lineBreakStrategyIOS,
    ).toBe('hangul-word');
  });
});

describe('기한 장 — 읽어 주는 힌트', () => {
  it('짧은 선택 줄은 누르면 곧바로 켜진다고 읽어 주고, 「직접 고르기」 줄에는 힌트가 없다', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('profile-pause-row'));
    for (const id of ['30m', '1h', '2h', 'tomorrow', 'nextMonday']) {
      expect(within(sheet).getByTestId(`pause-until-option-${id}`).props.accessibilityHint).toBe(
        '누르면 이 시각까지 알림을 멈춰요.',
      );
    }
    expect(
      within(sheet).getByTestId('pause-until-option-custom').props.accessibilityHint,
    ).toBeUndefined();
  });

  it('방해 금지 장의 힌트는 방해 금지를 켠다고 말한다', async () => {
    freezeClock(FRI_2107);
    const sheet = await openSheet();
    fireEvent.press(within(sheet).getByTestId('presence-option-dnd'));
    expect(within(sheet).getByTestId('pause-until-option-30m').props.accessibilityHint).toBe(
      '누르면 이 시각까지 방해 금지를 켜요.',
    );
    expect(
      within(sheet).getByTestId('pause-until-option-custom').props.accessibilityHint,
    ).toBeUndefined();
  });
});

describe('직접 고르기 블록 — 열릴 때 한 번만 시트를 내린다', () => {
  // 시트(`ProfileSheet`)는 `onReveal` 로 스크롤한다. 블록의 높이가 바뀔 때마다(지난 시각 오류문이
  // 뜨거나 달을 넘길 때) `onLayout` 이 다시 오는데 그때마다 내리면 고르던 자리에서 시트가 튄다.
  const layout = (y: number, height: number) => ({
    nativeEvent: {layout: {x: 0, y, width: 390, height}},
  });

  function renderPage(onReveal: jest.Mock) {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {retry: false, staleTime: 30_000},
        mutations: {retry: false},
      },
    });
    return render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {/* 방해 금지 장은 규칙을 읽기 전에도 눌린다 — 이 시험은 쓰기가 아니라 레이아웃을 잰다. */}
          <PauseUntilPage
            kind="dnd"
            workspaceId={WS}
            selfId={SELF_ID}
            self={undefined}
            onDone={jest.fn()}
            onReveal={onReveal}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  it('레이아웃이 몇 번 바뀌어도 시트는 한 번만 내려간다', () => {
    const onReveal = jest.fn();
    renderPage(onReveal);
    fireEvent.press(screen.getByTestId('pause-until-option-custom'));
    const block = screen.getByTestId('pause-until-custom-block');

    fireEvent(block, 'layout', layout(120, 600));
    fireEvent(block, 'layout', layout(120, 640)); // 오류문이 떠서 블록이 길어졌다
    fireEvent(block, 'layout', layout(120, 600));

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(120);
  });

  it('닫았다가 다시 열면 다시 한 번 내려간다', () => {
    const onReveal = jest.fn();
    renderPage(onReveal);
    fireEvent.press(screen.getByTestId('pause-until-option-custom'));
    fireEvent(screen.getByTestId('pause-until-custom-block'), 'layout', layout(120, 600));
    expect(onReveal).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('pause-until-option-custom'));
    expect(screen.queryByTestId('pause-until-custom-block')).toBeNull();

    fireEvent.press(screen.getByTestId('pause-until-option-custom'));
    fireEvent(screen.getByTestId('pause-until-custom-block'), 'layout', layout(132, 600));
    expect(onReveal).toHaveBeenCalledTimes(2);
    expect(onReveal).toHaveBeenLastCalledWith(132);
  });
});
