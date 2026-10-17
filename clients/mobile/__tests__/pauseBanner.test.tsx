import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {AppState} from 'react-native';

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
// #3923 — 알림 일시 중지가 **보인다**: 인박스 맨 위의 한 줄 (ADR-0204 D3).
//
// 이 파일이 지는 것:
//   1. 일시 중지가 진행 중이면 「알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기」, 기한 없는 행은
//      「기한 없음」. 줄은 인박스의 **맨 위**(탭 필터보다 앞)에 선다.
//   2. 「다시 켜기」는 `PATCH notification-rules {dnd:false}` **하나**만 보낸다 — 방해 금지 상태는
//      건드리지 않는다. 그러면 상태가 아직 방해 금지이므로 둘째 줄이 선다.
//   3. 일시 중지는 꺼졌는데 상태가 아직 방해 금지이면 「상태는 아직 방해 금지예요 · 풀기」 이고,
//      「풀기」는 `PUT presence {status:'auto'}` 하나다. 둘 다 켜져 있으면 일시 중지 줄이 먼저다.
//   4. **만료는 서버가 말한다.** 기한이 지나도 줄은 스스로 내려가지 않고 서버에 다시 묻는다. 서버가
//      꺼졌다고 답하면 사라지고, 아직 켜져 있다고 답하면(시계 차이) 남는다. 탭이 보이게 되거나
//      앱이 앞으로 돌아오면 다시 읽는다.
//   5. 규칙을 한 번도 못 읽었으면 줄을 세우지 않는다(모르는 것을 말하지 않는다).
//
// 서버는 fetch 하나만 가짜다. 줄·쓰기 훅·인박스 화면은 진짜이고(#2899 의 `usePauseNotifications`,
// `useSetPresence` 를 그대로 쓴다), 가짜 서버는 PATCH 가 방해 금지와의 묶음을 끊는 것까지 따른다.
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
  /** 규칙 GET 한 번마다 이 줄의 앞에서 하나를 꺼내 **다음** GET 의 답으로 둔다. */
  rulesAfter: Rules[];
  rulesGets: number;
  rosterGets: number;
  rulesReadFails: boolean;
  rulesWriteFails: boolean;
  presenceFails: boolean;
  /** 쓰기(PATCH·PUT) 응답이 이만큼 늦게 온다 — 실제 네트워크에서는 낙관 칠하기가 서버 답보다 먼저 보인다. */
  writeDelayMs: number;
  /** 있으면 규칙 GET 의 **n 번째 답**이 이 약속이 풀릴 때까지 끝나지 않는다. */
  holdRulesGetAt: number | null;
  heldRulesGet: (() => void) | null;
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

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    // 요청이 들어온 순간의 서버를 쥔다: 늦게 답하는 쓰기(`writeDelayMs`)가 시험이 끝난 뒤 깨어나도 **다음 시험의
    // 서버**를 건드리지 않는다(모듈 변수 `server` 는 시험마다 새로 만들어진다).
    const s = server;
    const method = init?.method ?? 'GET';
    if (url.includes('/notification-rules/push-kinds')) {
      return jsonResponse(200, {workComplete: true});
    }
    if (url.includes('/notification-rules')) {
      if (method === 'PUT' || method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        s.writes.push({path: 'notification-rules', method, body});
        if (s.writeDelayMs > 0) await delay(s.writeDelayMs);
        if (s.rulesWriteFails) return jsonResponse(500, {error: {message: 'x'}});
        const next: Rules = {...s.rules, ...body};
        // 끄면 기한도 지워진다(서버).
        if (body.dnd === false || body.dndUntilMs === null) delete next.dndUntilMs;
        s.rules = next;
        return jsonResponse(200, s.rules);
      }
      s.rulesGets += 1;
      if (s.rulesReadFails) return jsonResponse(500, {error: {message: 'x'}});
      const answer = {...s.rules};
      const nth = s.rulesGets;
      const next = s.rulesAfter.shift();
      if (next) s.rules = next;
      if (s.holdRulesGetAt === nth) {
        await new Promise<void>(resolve => {
          s.heldRulesGet = resolve;
        });
      }
      return jsonResponse(200, answer);
    }
    if (url.includes('/presence')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      s.writes.push({path: 'presence', method, body});
      if (s.writeDelayMs > 0) await delay(s.writeDelayMs);
      if (s.presenceFails) return jsonResponse(500, {error: {message: 'x'}});
      const next: SelfRow = {...s.self, presenceStatus: body.status};
      if (body.status !== 'dnd') delete next.dndUntilMs;
      s.self = next;
      return jsonResponse(200, {status: body.status});
    }
    if (url.includes('/roster')) {
      s.rosterGets += 1;
      return jsonResponse(200, {members: [s.self]});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/agent-runs')) return jsonResponse(200, {runs: []});
    // 이 서버는 `/inbox` 를 모른다 — 인박스는 예전 원장으로 서고, 이 시험은 그 위의 줄만 본다.
    if (url.includes('/inbox')) return jsonResponse(404, {error: {code: 'not_found', message: 'x'}});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

// ---- AppState 를 손으로 낸다(`appIconBadge.test.tsx` 의 같은 도구) ---------------------------
const appStateListen = AppState.addEventListener as unknown as jest.Mock;
const presetAppStateListen = appStateListen.getMockImplementation();

function captureAppState(): (status: string) => void {
  const handlers: ((status: string) => void)[] = [];
  appStateListen.mockImplementation(((_event: string, fn: (status: string) => void) => {
    handlers.push(fn);
    return {
      remove: () => {
        const at = handlers.indexOf(fn);
        if (at >= 0) handlers.splice(at, 1);
      },
    };
  }) as never);
  return status => {
    act(() => {
      for (const fn of [...handlers]) fn(status);
    });
  };
}

let queryClient: QueryClient | null = null;

function renderShell() {
  // 운영 클라이언트의 신선도(`createQueryClient`: staleTime 30초)를 따른다 — `gcTime: 0` 이면 다시 읽기가
  // 저절로 일어나 「다시 묻는다」를 잴 수 없다.
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

jest.setTimeout(30_000);
// 짐이 큰 기계에서 기본 1초 대기가 모자랐다(릴리스 뒤 줄이 사라지는 것을 기다리는 시험이 붉었다).
configure({asyncUtilTimeout: 10_000});

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  server = {
    self: selfRow(),
    rules: {dnd: false, mentionOverridesMute: true},
    rulesAfter: [],
    rulesGets: 0,
    rosterGets: 0,
    rulesReadFails: false,
    rulesWriteFails: false,
    presenceFails: false,
    writeDelayMs: 0,
    holdRulesGetAt: null,
    heldRulesGet: null,
    writes: [],
  };
  installFetch();
});

afterEach(() => {
  server.heldRulesGet?.();
  cleanup();
  queryClient?.clear();
  queryClient = null;
  appStateListen.mockImplementation(presetAppStateListen);
  jest.restoreAllMocks();
});

/** 인박스의 탭 필터 줄(`accessibilityLabel`). 줄이 이것보다 앞에 서야 「맨 위」다. */
const TAB_FILTER_LABEL = '인박스 필터';

const at = (day: number, hour: number, minute = 0, month = 10) =>
  new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();

/** 시계를 고정한다. 2026-10-16 은 금요일이다. */
function freezeClock(ms: number) {
  jest.spyOn(Date, 'now').mockReturnValue(ms);
}
const FRI_2107 = at(16, 21, 7);

/** 셸을 세우고 규칙의 **첫 읽기**가 끝날 때까지 기다린다(인박스 탭은 숨은 채 마운트돼 있다). */
async function mountHome() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), {timeout: 10_000});
  await waitFor(() => expect(server.rulesGets).toBeGreaterThanOrEqual(1), {timeout: 10_000});
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
  });
}

async function openInbox() {
  // 첫 읽기가 도는 중에 탭이 보이게 되면 그 읽기가 취소되고 다시 시작된다 — 첫 읽기가 끝난 뒤에 연다.
  await mountHome();
  fireEvent.press(screen.getByTestId('tab-inbox'));
  await waitFor(() => expect(screen.getByLabelText(TAB_FILTER_LABEL)).toBeTruthy(), {
    timeout: 10_000,
  });
}

async function shownBanner() {
  await waitFor(() => expect(screen.getByTestId('pause-banner')).toBeTruthy(), {timeout: 10_000});
  return screen.getByTestId('pause-banner');
}

/** 규칙과 명부를 한 번씩 읽고 가라앉을 때까지 — 「줄이 없다」를 단정하기 전에 쓴다. */
async function settledAfterReads() {
  await waitFor(() => expect(server.rulesGets).toBeGreaterThanOrEqual(1), {timeout: 10_000});
  await waitFor(() => expect(server.rosterGets).toBeGreaterThanOrEqual(1), {timeout: 10_000});
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
  });
}

const presenceWrites = () => server.writes.filter(w => w.path === 'presence');
const rulesWrites = () => server.writes.filter(w => w.path === 'notification-rules');
/** 줄의 제목과 (있으면) 기한을 「 · 」로 이은 글 — 화면에서는 두 줄로 쌓인다. */
/** 기한 줄의 보이지 않는 단어 결합자(U+2060). 그려진 글에서 걷어내고 코어 문장과 견준다. */
const WORD_JOINER = '\u2060';
const lineOf = (hidden = false) => {
  const title = screen.getByTestId('pause-banner-title', {includeHiddenElements: hidden}).props
    .children as string;
  const rawDetail = screen.queryByTestId('pause-banner-detail', {includeHiddenElements: hidden})
    ?.props.children as string | undefined;
  const detail = rawDetail?.split(WORD_JOINER).join('');
  return detail === undefined ? title : `${title} · ${detail}`;
};
const action = () => screen.getByTestId('pause-banner-action');

describe('인박스 맨 위의 멈춤 줄 (ADR-0204 D3)', () => {
  it('일시 중지가 진행 중이면 끝나는 때와 「다시 켜기」를 한 줄로 말한다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30)};
    await openInbox();
    await shownBanner();

    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 9:30까지');
    // 제목과 기한은 두 칸으로 쌓인다(웹 사이드바와 같은 모양). 문장 전체는 단추의 이름이다.
    expect(screen.getByTestId('pause-banner-title')).toHaveTextContent('알림 일시 중지 중');
    // 기한 줄은 숫자 뒤의 「까지」를 한 낱말로 묶는다(가장 큰 글씨에서 조사만 둘째 줄에 홀로 남던 줄바꿈).
    expect(screen.getByTestId('pause-banner-detail').props.children).toBe(`오후 9:30${WORD_JOINER}까지`);
    expect(action()).toHaveTextContent('다시 켜기');
    expect(action().props.accessibilityLabel).toBe('알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기');
    expect(action().props.accessibilityRole).toBe('button');
  });

  it('줄은 인박스의 맨 위에 선다 — 탭 필터보다 앞이다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30)};
    await openInbox();
    await shownBanner();

    // 렌더 트리의 차례로 잰다: 멈춤 줄이 탭 필터 줄보다 앞이다.
    const order: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || typeof node !== 'object') return;
      const item = node as {
        props?: {testID?: string; accessibilityLabel?: string};
        children?: unknown[];
      };
      if (item.props?.testID === 'pause-banner') order.push('banner');
      if (item.props?.accessibilityLabel === TAB_FILTER_LABEL) order.push('tabs');
      (item.children ?? []).forEach(walk);
    };
    const tree = screen.toJSON();
    (Array.isArray(tree) ? tree : [tree]).forEach(walk);
    expect(order).toEqual(['banner', 'tabs']);
  });

  it('기한 없는 행(옛 판이 만든 것)은 「기한 없음」으로 말한다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false};
    await openInbox();
    await shownBanner();
    expect(lineOf()).toBe('알림 일시 중지 중 · 기한 없음');
    // 「까지」가 없는 기한 줄에는 결합자가 붙지 않는다.
    expect(screen.getByTestId('pause-banner-detail').props.children).toBe('기한 없음');
    expect(action().props.accessibilityLabel).toBe('알림 일시 중지 중 · 기한 없음 · 다시 켜기');
  });

  it('날짜가 붙는 먼 기한도 한 줄 문장으로 말하고, 「까지」는 숫자 뒤에서 묶인다', async () => {
    freezeClock(FRI_2107);
    // 2026-10-19 는 월요일이다(「다음 주 월요일 오전 9시까지」 프리셋의 모양).
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(19, 9)};
    await openInbox();
    await shownBanner();
    expect(lineOf()).toBe('알림 일시 중지 중 · 10월 19일(월) 오전 9:00까지');
    expect(screen.getByTestId('pause-banner-detail').props.children).toBe(
      `10월 19일(월) 오전 9:00${WORD_JOINER}까지`,
    );
    expect(action().props.accessibilityLabel).toBe(
      '알림 일시 중지 중 · 10월 19일(월) 오전 9:00까지 · 다시 켜기',
    );
  });

  it('일시 중지도 방해 금지도 아니면 줄이 없다', async () => {
    await openInbox();
    await settledAfterReads();
    expect(screen.queryByTestId('pause-banner')).toBeNull();
  });

  it('규칙을 한 번도 못 읽었으면, 상태가 방해 금지여도 줄을 세우지 않는다', async () => {
    server.rulesReadFails = true;
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    await openInbox();
    await settledAfterReads();
    expect(screen.queryByTestId('pause-banner')).toBeNull();
  });

  it('일시 중지는 꺼졌는데 상태가 아직 방해 금지이면 「상태는 아직 방해 금지예요 · 풀기」', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    await openInbox();
    await shownBanner();
    expect(lineOf()).toBe('상태는 아직 방해 금지예요');
    expect(screen.queryByTestId('pause-banner-detail')).toBeNull();
    expect(action()).toHaveTextContent('풀기');
    expect(action().props.accessibilityLabel).toBe('상태는 아직 방해 금지예요 · 풀기');
  });

  it('둘 다 켜져 있으면 일시 중지 줄이 먼저다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0)});
    await openInbox();
    await shownBanner();
    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 10:00까지');
    expect(action()).toHaveTextContent('다시 켜기');
  });
});

describe('「다시 켜기」와 「풀기」 — 쓰기 모양', () => {
  it('「다시 켜기」는 PATCH {dnd:false} 하나만 보내고 방해 금지 상태는 건드리지 않는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await openInbox();
    await shownBanner();
    fireEvent.press(action());

    await waitFor(() => expect(rulesWrites()).toHaveLength(1), {timeout: 10_000});
    expect(rulesWrites()[0]).toMatchObject({method: 'PATCH', body: {dnd: false}});
    // 기한 null·mentionOverridesMute 를 싣지 않는다: 바꾼 스위치 하나만이다.
    expect(Object.keys(rulesWrites()[0].body as object)).toEqual(['dnd']);
    expect(presenceWrites()).toEqual([]);
    // 방해 금지에 묶여 있지 않았으니 일시 중지만 꺼지면 줄이 없다.
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});
  });

  it('방해 금지에 묶여 있었다면 일시 중지만 끈 뒤 「상태는 아직 방해 금지예요」 줄이 선다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0)});
    await openInbox();
    await shownBanner();
    expect(action()).toHaveTextContent('다시 켜기');
    fireEvent.press(action());

    await waitFor(() => expect(rulesWrites()).toHaveLength(1), {timeout: 10_000});
    expect(rulesWrites()[0].body).toEqual({dnd: false});
    await waitFor(() => expect(action()).toHaveTextContent('풀기'), {timeout: 10_000});
    expect(lineOf()).toBe('상태는 아직 방해 금지예요');
    expect(presenceWrites()).toEqual([]);
  });

  it('「풀기」는 PUT presence {status:auto} 하나만 보내고, 규칙은 쓰지 않는다', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    await openInbox();
    await shownBanner();
    fireEvent.press(action());

    await waitFor(() => expect(presenceWrites()).toHaveLength(1), {timeout: 10_000});
    expect(presenceWrites()[0]).toMatchObject({method: 'PUT', body: {status: 'auto'}});
    expect(Object.keys(presenceWrites()[0].body as object)).toEqual(['status']);
    expect(rulesWrites()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});
    // 방해 금지를 풀면 서버가 규칙도 바꿀 수 있어 규칙을 다시 읽는다(읽기뿐이다).
    expect(server.rulesGets).toBeGreaterThanOrEqual(2);
  });

  it('쓰기가 실패하면 줄이 그대로 서서 이유를 말한다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.rulesWriteFails = true;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());

    await waitFor(() => expect(screen.getByTestId('pause-banner-failure')).toBeTruthy(), {
      timeout: 10_000,
    });
    expect(screen.getByTestId('pause-banner-failure')).toHaveTextContent(
      '알림 설정을 바꾸지 못했어요. 다시 시도하세요.',
    );
    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 10:00까지');

    // 다시 눌러 성공하면 이유가 걷힌다.
    server.rulesWriteFails = false;
    fireEvent.press(action());
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});
  });

  it('「풀기」가 실패해도 줄이 서서 이유를 말한다', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    server.presenceFails = true;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    await waitFor(() => expect(screen.getByTestId('pause-banner-failure')).toBeTruthy(), {
      timeout: 10_000,
    });
    expect(screen.getByTestId('pause-banner-failure')).toHaveTextContent(
      '상태를 바꾸지 못했습니다. 다시 시도하세요.',
    );
    expect(action()).toHaveTextContent('풀기');
  });

  it('서버가 늦게 실패해도 이유가 뜬다 — 낙관 칠하기가 줄을 먼저 바꾼 뒤 되돌려져도 (design-review H1)', async () => {
    freezeClock(FRI_2107);
    // 실제 네트워크: 누르면 낙관 칠하기로 줄이 먼저 사라지고, 한참 뒤 서버가 실패해 되돌려진다. 이전 구현은
    // 「누른 줄」 표식을 줄 모양이 바뀐 그 순간에 지워서 이유 문장이 한 번도 뜨지 않았다.
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.rulesWriteFails = true;
    server.writeDelayMs = 150;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());

    // 낙관 구간: 줄은 이미 사라졌고(방해 금지에 묶여 있지 않다) 서버는 아직 답하지 않았다.
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull());
    // 서버가 실패하면 줄이 되돌아오고, 이유가 함께 선다.
    await waitFor(() => expect(screen.getByTestId('pause-banner-failure')).toBeTruthy());
    expect(screen.getByTestId('pause-banner-failure')).toHaveTextContent(
      '알림 설정을 바꾸지 못했어요. 다시 시도하세요.',
    );
    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 10:00까지');
  });

  it('「풀기」가 늦게 실패해도 이유가 뜬다', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    server.presenceFails = true;
    server.writeDelayMs = 150;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('pause-banner-failure')).toBeTruthy());
    expect(screen.getByTestId('pause-banner-failure')).toHaveTextContent(
      '상태를 바꾸지 못했습니다. 다시 시도하세요.',
    );
    expect(action()).toHaveTextContent('풀기');
  });

  it('쓰기가 나는 동안 같은 자리에 올라온 반대 행동은 받지 않는다 — 더블탭이 상태 해제를 보내지 않는다 (design-review M1)', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0)});
    server.writeDelayMs = 120;
    await openInbox();
    await shownBanner();
    expect(action()).toHaveTextContent('다시 켜기');
    fireEvent.press(action());
    // 낙관 칠하기로 같은 자리의 단추가 곧바로 「풀기」가 된다.
    await waitFor(() => expect(action()).toHaveTextContent('풀기'));
    // 더블탭의 둘째 누름: 상태 해제를 보내면 안 된다.
    fireEvent.press(action());
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(presenceWrites()).toEqual([]);

    // 서버가 확정하고 시간이 지난 뒤에는 「풀기」가 정상으로 일한다.
    freezeClock(FRI_2107 + 3_000);
    await waitFor(() => expect(action()).toHaveTextContent('풀기'));
    fireEvent.press(action());
    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    expect(presenceWrites()[0].body).toEqual({status: 'auto'});
  });

  it('서버가 곧바로 확정해도 방금 누른 줄과 다른 종류의 단추는 잠깐 받지 않고, 지나면 받는다 (보호 시간만)', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0)});
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    // 쓰기가 끝났다(단추가 다시 눌릴 수 있다). 같은 자리에는 「풀기」가 서 있다.
    await waitFor(() => expect(action()).toBeEnabled());
    expect(action()).toHaveTextContent('풀기');
    // 쓰기 잠금은 풀렸어도 방금 누른 직후의 반대 종류 단추다: 상태 해제를 보내지 않는다.
    fireEvent.press(action());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    expect(presenceWrites()).toEqual([]);

    // 시간이 지나면 「풀기」는 정상으로 일한다.
    freezeClock(FRI_2107 + 3_000);
    fireEvent.press(action());
    await waitFor(() => expect(presenceWrites()).toHaveLength(1));
    expect(presenceWrites()[0].body).toEqual({status: 'auto'});
  });

  it('보호 시간이 지나도 쓰기가 끝나기 전에는 반대 행동을 받지 않는다 — 느린 망', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 22, 0)});
    server.writeDelayMs = 400;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    await waitFor(() => expect(action()).toHaveTextContent('풀기'));
    // 망이 느려 쓰기가 아직 끝나지 않았는데 보호 시간은 이미 지났다.
    freezeClock(FRI_2107 + 3_000);
    fireEvent.press(action());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    expect(presenceWrites()).toEqual([]);
    expect(rulesWrites()).toHaveLength(1);
  });

  it('쓰기가 나는 동안은 같은 줄의 단추도 눌리지 않는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.writeDelayMs = 150;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    fireEvent.press(action());
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(rulesWrites()).toHaveLength(1);
  });

  it('실패 문장은 그 줄에만 붙는다 — 줄이 사라졌다 다시 서면 옛 실패가 남지 않는다', async () => {
    freezeClock(FRI_2107);
    const emit = captureAppState();
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    server.rulesWriteFails = true;
    await openInbox();
    await shownBanner();
    fireEvent.press(action());
    await waitFor(() => expect(screen.getByTestId('pause-banner-failure')).toBeTruthy(), {
      timeout: 10_000,
    });

    // 서버가 멈춤을 끝냈다(다른 기기) → 앱이 돌아오며 다시 읽는다 → 줄이 사라진다.
    server.rules = {dnd: false, mentionOverridesMute: false};
    emit('active');
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});

    // 다시 멈췄다 → 줄이 다시 서도 옛 실패는 없다.
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 23, 0)};
    emit('active');
    await shownBanner();
    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 11:00까지');
    expect(screen.queryByTestId('pause-banner-failure')).toBeNull();
  });
});

describe('만료는 서버가 말한다 — 스스로 내려가지 않고 다시 묻는다', () => {
  // 이 묶음은 인박스 탭을 열지 않는다. 탭이 보이게 되는 것도 다시 읽는 계기라서(아래 묶음), 열면
  // 「기한이 지나서 다시 물었다」와 「탭이 열려서 다시 물었다」를 가를 수 없다. 숨은 탭 안의 줄도
  // 같은 훅이 돌고 있으므로 `includeHiddenElements` 로 그 줄을 본다.
  const hiddenBanner = () => screen.getByTestId('pause-banner', {includeHiddenElements: true});

  it('기한이 지난 줄은 서버에 다시 묻고, 답이 오기 전에는 서 있다가 서버가 꺼졌다고 답하면 사라진다', async () => {
    freezeClock(FRI_2107);
    // 첫 답: 기한이 이미 지난 채 켜져 있다(푸시 판정 전의 낡은 캐시와 같다). 두 번째 답은 꺼짐이지만
    // 약속이 풀릴 때까지 오지 않는다 — 그 사이 줄은 **스스로 내려가지 않아야** 한다.
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 0)};
    server.rulesAfter = [{dnd: false, mentionOverridesMute: false}];
    server.holdRulesGetAt = 2;
    await mountHome();
    expect(lineOf(true)).toBe('알림 일시 중지 중 · 오후 9:00까지');

    // 탭도 앱 전환도 없이 기한이 지났다는 이유만으로 두 번째 읽기가 나간다.
    await waitFor(() => expect(server.heldRulesGet).not.toBeNull(), {timeout: 10_000});
    expect(server.rulesGets).toBe(2);
    // 서버 답이 오기 전: 줄은 그대로다.
    expect(hiddenBanner()).toBeTruthy();
    expect(lineOf(true)).toBe('알림 일시 중지 중 · 오후 9:00까지');

    await act(async () => {
      server.heldRulesGet?.();
    });
    await waitFor(
      () =>
        expect(screen.queryByTestId('pause-banner', {includeHiddenElements: true})).toBeNull(),
      {timeout: 10_000},
    );
  });

  it('서버가 아직 켜져 있다고 답하면(시계 차이) 줄이 남는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 0)};
    await mountHome();
    // 기한이 지났다는 이유로 한 번 더 묻는다.
    await waitFor(() => expect(server.rulesGets).toBeGreaterThanOrEqual(2), {timeout: 10_000});
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    // 서버가 두 번 다 켜져 있다고 답했다. 기한이 지났다는 이유로 줄을 내리지 않는다.
    expect(hiddenBanner()).toBeTruthy();
    expect(lineOf(true)).toBe('알림 일시 중지 중 · 오후 9:00까지');
  });

  it('방해 금지 줄도 방해 금지의 기한이 지나면 다시 묻는다', async () => {
    freezeClock(FRI_2107);
    // 일시 중지는 꺼졌고 상태만 방해 금지인데 그 기한이 이미 지났다(명부 캐시가 낡았다).
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(16, 21, 0)});
    await mountHome();
    expect(lineOf(true)).toBe('상태는 아직 방해 금지예요');
    await waitFor(() => expect(server.rosterGets).toBeGreaterThanOrEqual(2), {timeout: 10_000});
    await waitFor(() => expect(server.rulesGets).toBeGreaterThanOrEqual(2), {timeout: 10_000});
  });

  it('기한이 아직 오지 않았으면 다시 묻지 않는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await mountHome();
    expect(hiddenBanner()).toBeTruthy();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
    });
    // 첫 읽기 하나뿐이다 — 탭도 앱 전환도 만료도 없다.
    expect(server.rulesGets).toBe(1);
  });

  it('기한 없는 행은 만료가 없으니 다시 묻지 않는다', async () => {
    server.rules = {dnd: true, mentionOverridesMute: false};
    await mountHome();
    expect(hiddenBanner()).toBeTruthy();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
    });
    expect(server.rulesGets).toBe(1);
  });
});

describe('다시 읽는 때 — 탭이 보이게 될 때, 앱이 앞으로 돌아올 때', () => {
  it('앱이 앞으로 돌아오면 규칙과 명부를 다시 읽는다', async () => {
    freezeClock(FRI_2107);
    const emit = captureAppState();
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await openInbox();
    await shownBanner();
    await settledAfterReads();
    const rulesBefore = server.rulesGets;
    const rosterBefore = server.rosterGets;

    // 그 사이 다른 기기가 멈춤을 풀었다.
    server.rules = {dnd: false, mentionOverridesMute: false};
    emit('active');
    await waitFor(() => expect(server.rulesGets).toBeGreaterThan(rulesBefore), {timeout: 10_000});
    await waitFor(() => expect(server.rosterGets).toBeGreaterThan(rosterBefore), {timeout: 10_000});
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});
  });

  it('앱이 뒤로 가는 전환에는 읽지 않는다', async () => {
    freezeClock(FRI_2107);
    const emit = captureAppState();
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await openInbox();
    await shownBanner();
    await settledAfterReads();
    const before = server.rulesGets;
    emit('background');
    emit('inactive');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(server.rulesGets).toBe(before);
  });

  it('다른 탭에 있다가 인박스가 보이게 되면 다시 읽는다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await openInbox();
    await shownBanner();
    await settledAfterReads();
    fireEvent.press(screen.getByTestId('tab-home'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const before = server.rulesGets;
    // 홈에 있는 동안 서버가 멈춤을 풀었다.
    server.rules = {dnd: false, mentionOverridesMute: false};
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(server.rulesGets).toBeGreaterThan(before), {timeout: 10_000});
    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull(), {timeout: 10_000});
  });
});

const netInfo = (
  jest.requireMock('@react-native-community/netinfo') as {
    default: {
      __emit: (state: {isConnected: boolean | null; isInternetReachable: boolean | null}) => void;
    };
  }
).default;

describe('끊겨 있으면 단추 자리에 이유를 말한다 (#2899 H2 와 같은 이유)', () => {
  // 끊긴 채 누른 뮤테이션은 낙관값만 칠하고 멈췄다가 재연결 뒤에 나간다 — 줄은 사라졌는데 서버는 아직
  // 모른다. 승인 컨트롤이 오프라인에서 하는 것처럼 단추를 남겨 두지도, 말없이 치우지도 않는다.
  afterEach(() => {
    act(() => netInfo.__emit({isConnected: true, isInternetReachable: true}));
  });

  it('끊기면 단추를 거두고 이유를 말하며 줄은 그대로 서 있다. 다시 이어지면 단추가 돌아온다', async () => {
    freezeClock(FRI_2107);
    server.rules = {dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 22, 0)};
    await openInbox();
    await shownBanner();
    expect(action()).toBeTruthy();

    act(() => netInfo.__emit({isConnected: false, isInternetReachable: false}));
    await waitFor(() =>
      expect(screen.getByTestId('pause-banner-offline')).toHaveTextContent(
        '연결이 끊겨 지금은 바꿀 수 없어요.',
      ),
    );
    expect(screen.queryByTestId('pause-banner-action')).toBeNull();
    expect(lineOf()).toBe('알림 일시 중지 중 · 오후 10:00까지');
    expect(server.writes).toEqual([]);

    act(() => netInfo.__emit({isConnected: true, isInternetReachable: true}));
    await waitFor(() => expect(screen.getByTestId('pause-banner-action')).toBeTruthy());
    expect(screen.queryByTestId('pause-banner-offline')).toBeNull();
    fireEvent.press(action());
    await waitFor(() => expect(rulesWrites()).toHaveLength(1));
    expect(rulesWrites()[0].body).toEqual({dnd: false});
  });

  it('방해 금지 줄도 같다 — 끊긴 동안은 「풀기」를 세우지 않는다', async () => {
    freezeClock(FRI_2107);
    server.self = selfRow({presenceStatus: 'dnd', dndUntilMs: at(17, 9)});
    await openInbox();
    await shownBanner();
    act(() => netInfo.__emit({isConnected: false, isInternetReachable: false}));
    await waitFor(() => expect(screen.getByTestId('pause-banner-offline')).toBeTruthy());
    expect(screen.queryByTestId('pause-banner-action')).toBeNull();
    expect(lineOf()).toBe('상태는 아직 방해 금지예요');
    expect(server.writes).toEqual([]);
  });
});
