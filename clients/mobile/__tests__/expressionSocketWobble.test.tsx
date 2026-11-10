import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import {AppState, StyleSheet} from 'react-native';
import {focusManager} from '@tanstack/react-query';
import {REQUEST_TIMEOUT_MS} from '@momo/core/lib/http';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {
  ExpressionProvider,
  PhoneExpressions,
  SOCKET_LOST_REFRESH_MS,
} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {answeredStatus} from '../src/features/expressions/transport';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {makeFiles, ME, uuid, World, WS} from './fixtures/expressionDiskWorld';

// =============================================================================
// #5585 — 폰: 실시간 소켓만 끊겨도 이모티콘이 `:이름:` 글자로 바뀌던 결함(웹 #5575 와 같은 규칙).
//
// 앞 판은 `ExpressionProvider` 가 `setOnline(onlineManager.isOnline() && status !== 'disconnected')` 로 **소켓만 끊겨도** 표현 저장소를
// 오프라인으로 돌렸다. 오프라인과 목록 읽기 오류(`error`)는 보관함(`shelf`)을 비웠고, 본문은 모든 이모티콘을 `:이름:` 글자로 그렸다
// (160pt 칸 → 글자 한 줄 → 160pt: 대화 높이가 바뀌었다). 지금:
//   1. 오프라인 판정은 웹과 같은 「보내기 가능 여부」(`canSend`)다. 소켓만 끊기면 그림은 그대로이고, 디스크 읽기 문만 올린다(ADR-0218 §14).
//   2. 정말 오프라인이거나 목록 읽기가 실패하면 그림 바이트는 내리되(D3 「offline 에서는 문자열/정지 자리표시만」) **같은 크기의 정지
//      자리표시**를 세운다 — 글자가 아니다.
//   3. 지나가는 그림 받기 실패(응답 없음·408·429·5xx)는 같은 크기 칸으로 기다렸다 다시 받는다. 글자는 정말로 깨진 그림(404 등)과 목록에 없는
//      등록에만 선다. 목록 읽기가 거절되면(401·403·404) 앞 판처럼 닫힌다(글자).
//
// 바닥 거리: 폰 대화 목록은 정방향이라 맨 아래에서 떨어지는 길은 줄 높이가 바뀌는 것뿐이다. 여기서는 되풀이의 **모든 걸음**에서 칸의 가로·세로와
// 말풍선 없는 큰 본문이 그대로인지 잰다(줄 높이 불변 = 바닥 거리 0). 네이티브 스크롤 자체는 jest 밖이다.
// =============================================================================

jest.mock('../src/features/expressions/store', () => ({
  ...jest.requireActual('../src/features/expressions/store'),
  createPhoneExpressionStore: jest.fn(),
}));
jest.mock('../src/features/emoji/catalogMemory', () => ({
  warmEmojiCatalog: jest.fn(async () => undefined),
}));
jest.mock('../src/session/useSession', () => ({
  ...jest.requireActual('../src/session/useSession'),
  useSession: () => ({
    workspaceId: '00000000-0000-4000-8000-000000000001',
    member: {id: '00000000-0000-4000-8000-000000000002'},
    signOut: jest.fn(),
  }),
}));
// 보내기 게이트(앱에서는 코어 연결 상태 모델의 `canSend`). 시험이 기기 오프라인·서버에 닿지 못함을 이 값 하나로 세운다.
const mockGates = {canSend: true};
jest.mock('../src/features/connection/useConnectionGates', () => ({
  useConnectionGates: () => ({
    canSend: mockGates.canSend,
    canUpload: mockGates.canSend,
    canDecide: mockGates.canSend,
    composerNote: null,
    approvalNote: null,
  }),
}));

const created = createPhoneExpressionStore as unknown as jest.Mock;
const realCreate = (
  jest.requireActual('../src/features/expressions/store') as {
    createPhoneExpressionStore: typeof createPhoneExpressionStore;
  }
).createPhoneExpressionStore;

const NAME = FIXTURE_EXPRESSIONS[0].name;
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

type Status = 'connecting' | 'connected' | 'disconnected';

/** 진짜 저장소 + 가짜 서버. `failList` 는 목록 읽기를, `imageStatus` 는 그림 받기를 그 상태로 답하게 한다(null 이면 가짜 서버 그대로). */
function realStore() {
  const server = createExpressionFixtureServer();
  const control = {failList: null as number | null, imageStatus: null as number | null};
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const path = String(input.path);
    if (control.failList !== null && input.method === 'GET' && path.startsWith(base) && !path.includes('/image')) {
      return {status: control.failList};
    }
    if (control.imageStatus !== null && path.includes('/image?')) {
      return {status: control.imageStatus};
    }
    return server.request(input);
  });
  const files = {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()};
  const store = realCreate(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, control};
}

function fakeStore() {
  return {
    start: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
    snapshot: jest.fn(() => ({items: [], shelf: [], state: 'ready', revision: 0})),
    refresh: jest.fn(async () => undefined),
    setOnline: jest.fn(),
    socketLost: jest.fn(),
    reconnected: jest.fn(),
    dispose: jest.fn(),
    changed: jest.fn(),
    detailed: jest.fn(),
    resetNotices: jest.fn(),
  };
}

const tree = (status: Status, children: React.ReactNode = null) => (
  <RealtimeContext.Provider value={{rail: null, status, subscriptionsWanted: false}}>
    <ExpressionProvider>{children}</ExpressionProvider>
  </RealtimeContext.Provider>
);

/** 한 틱: 받기(마이크로태스크)와 한 프레임. 4번 돌고 서는 시계는 건드리지 않는다. */
async function flush(times = 4) {
  for (let step = 0; step < times; step += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(16);
    });
  }
}

interface Seen {
  step: string;
  /** 칸 밖에 선 `:이름:` 글자(칸 안의 이름 표지는 세지 않는다). */
  text: number;
  box: {width: number; height: number} | null;
  /** 말풍선 없는 큰 본문(이모티콘 하나뿐인 메시지)이 서 있는가. 글자가 되면 말풍선 줄로 바뀐다. */
  bigBody: boolean;
  /** 그려진 그림 층 수. */
  layers: number;
}

function look(step: string): Seen {
  const text = screen
    .queryAllByText(`:${NAME}:`)
    .filter(node => !String(node.props.testID ?? '').startsWith('expression-label-')).length;
  const node = screen.queryByTestId(`expression-box-${NAME}-large`);
  const style = node ? StyleSheet.flatten(node.props.style) : null;
  return {
    step,
    text,
    box: style ? {width: Number(style.width), height: Number(style.height)} : null,
    bigBody: screen.queryByTestId('expression-body-large') !== null,
    layers: screen.queryAllByTestId(new RegExp(`^expression-image-${NAME}-large`)).length,
  };
}

/** 모든 걸음에서 글자 0 · 칸 160×160 · 큰 본문 그대로. 걸음마다 무엇이 어긋났는지를 표로 남긴다(마지막 상태만 보면 돌아온 뒤라 앞 판도 초록이다). */
function expectSteady(steps: Seen[]) {
  const off = steps.filter(
    seen => seen.text !== 0 || !seen.bigBody || seen.box?.width !== 160 || seen.box?.height !== 160,
  );
  expect(off).toEqual([]);
}

beforeEach(async () => {
  release = await pinReduceMotion(false);
  AppState.currentState = 'active';
  mockGates.canSend = true;
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  created.mockReset();
  release?.();
  release = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('연결 줄: 오프라인 판정은 보내기 가능 여부다 (#5585)', () => {
  it('소켓 끊김·재연결 5번에 저장소를 오프라인으로 돌리지 않고, 끊길 때마다 디스크 읽기 문만 올린다', async () => {
    const store = fakeStore();
    created.mockReturnValue(store);
    const view = render(tree('connecting'));
    await flush(1);
    for (let round = 0; round < 5; round += 1) {
      view.rerender(tree('connected'));
      await flush(1);
      view.rerender(tree('connecting'));
      await flush(1);
      view.rerender(tree('disconnected'));
      await flush(1);
    }
    view.rerender(tree('connected'));
    await flush(1);
    expect(store.setOnline.mock.calls.filter(([value]) => value === false)).toEqual([]);
    expect(store.socketLost).toHaveBeenCalledTimes(5);
    // 다시 이어질 때마다 문을 올리고(`reconnected`) 전체 목록을 읽는다 — 앞 판과 같다.
    expect(store.reconnected).toHaveBeenCalledTimes(6);
  });

  it('보낼 수 없으면(기기 오프라인·서버에 닿지 못함) 오프라인이고, 보낼 수 있게 되면 돌아온다', async () => {
    const store = fakeStore();
    created.mockReturnValue(store);
    const view = render(tree('connected'));
    await flush(1);
    store.setOnline.mockClear();
    mockGates.canSend = false;
    view.rerender(tree('connected'));
    await flush(1);
    expect(store.setOnline).toHaveBeenLastCalledWith(false);
    mockGates.canSend = true;
    view.rerender(tree('connected'));
    await flush(1);
    expect(store.setOnline).toHaveBeenLastCalledWith(true);
    // 보낼 수 없는 동안 소켓이 끊긴 것은 문 올림이 아니라 오프라인이 맡는다.
    mockGates.canSend = false;
    view.rerender(tree('disconnected'));
    await flush(1);
    expect(store.socketLost).not.toHaveBeenCalled();
  });
});

describe('소켓 끊김·재연결 ×5 — 진짜 저장소와 본문 (#5585)', () => {
  it('아는 이모티콘이 글자로 바뀌지 않고, 칸·큰 본문이 그대로이며, 그린 그림도 그대로다', async () => {
    const {store} = realStore();
    created.mockReturnValue(store);
    const view = render(tree('connecting', <MessageBody body={`:${NAME}:`} />));
    await flush();
    const steps: Seen[] = [look('처음')];
    expect(steps[0]).toMatchObject({text: 0, layers: 1});
    for (let round = 1; round <= 5; round += 1) {
      for (const status of ['connected', 'connecting', 'disconnected'] as const) {
        view.rerender(tree(status, <MessageBody body={`:${NAME}:`} />));
        await flush();
        steps.push(look(`${round}회 ${status}`));
      }
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await flush();
      steps.push(look(`${round}회 끊긴 채 10초`));
    }
    view.rerender(tree('connected', <MessageBody body={`:${NAME}:`} />));
    await flush();
    steps.push(look('다시 이어짐'));
    expectSteady(steps);
    // 소켓만 끊긴 동안(보낼 수 있다) 그린 그림은 내리지 않는다 — 웹과 같다.
    expect(steps.filter(seen => seen.layers !== 1)).toEqual([]);
  });
});

describe('정말 오프라인 · 목록 오류 ×5 — 같은 크기 정지 자리표시 (#5585)', () => {
  const mount = (store: PhoneExpressionStore) =>
    render(
      <PhoneExpressions.Provider value={store}>
        <MessageBody body={`:${NAME}:`} />
      </PhoneExpressions.Provider>,
    );

  it('기기 오프라인 ↔ 온라인 5번: 글자 0, 칸 그대로, 오프라인 동안은 그림 바이트를 그리지 않는다(D3)', async () => {
    const {store} = realStore();
    await act(async () => store.refresh(true));
    mount(store);
    await flush();
    const steps: Seen[] = [look('처음')];
    for (let round = 1; round <= 5; round += 1) {
      act(() => store.setOnline(false));
      await flush();
      const offline = look(`${round}회 오프라인`);
      steps.push(offline);
      expect(offline.layers).toBe(0);
      act(() => store.setOnline(true));
      steps.push(look(`${round}회 돌아옴(읽는 중)`));
      await flush();
      steps.push(look(`${round}회 돌아옴`));
    }
    expectSteady(steps);
    expect(store.snapshot().state).toBe('ready');
    expect(look('끝').layers).toBe(1);
  });

  it('목록 읽기 오류(500) 5번: 글자 0, 칸 그대로, 오류 동안 그림 층 없음, 읽기가 돌아오면 그림이 다시 선다', async () => {
    const {store, control} = realStore();
    await act(async () => store.refresh(true));
    mount(store);
    await flush();
    const steps: Seen[] = [look('처음')];
    for (let round = 1; round <= 5; round += 1) {
      control.failList = 500;
      await act(async () => store.refresh(true));
      await flush();
      expect(store.snapshot().state).toBe('error');
      const failed = look(`${round}회 오류`);
      steps.push(failed);
      expect(failed.layers).toBe(0);
      control.failList = null;
      await act(async () => store.refresh(true));
      await flush();
      steps.push(look(`${round}회 다시 읽음`));
    }
    expectSteady(steps);
    expect(look('끝').layers).toBe(1);
  });

  it.each([401, 403, 404])('목록 읽기가 거절되면(%i) 닫힌다: 글자다(로그인 끝·멤버에서 빠짐·워크스페이스 없음은 지나가는 오류가 아니다)', async refusal => {
    const {store, control} = realStore();
    await act(async () => store.refresh(true));
    mount(store);
    await flush();
    control.failList = refusal;
    await act(async () => store.refresh(true));
    await flush();
    expect(store.snapshot()).toMatchObject({state: 'error', shelf: []});
    expect(look('거절').text).toBe(1);
  });
});

describe('그림 받기 실패 (#5585)', () => {
  const mount = (store: PhoneExpressionStore) =>
    render(
      <PhoneExpressions.Provider value={store}>
        <MessageBody body={`:${NAME}:`} />
      </PhoneExpressions.Provider>,
    );

  it('돌아온 뒤 다시 받기가 지나가는 실패(503)면 같은 크기 칸으로 기다렸다 스스로 다시 받는다', async () => {
    const {store, control, request} = realStore();
    await act(async () => store.refresh(true));
    mount(store);
    await flush();
    act(() => store.setOnline(false));
    await flush();
    control.imageStatus = 503;
    act(() => store.setOnline(true));
    await flush();
    const steps: Seen[] = [look('받기 실패')];
    expect(steps[0].layers).toBe(0);
    const before = request.mock.calls.filter(([input]) => String(input.path).includes('/image?')).length;
    control.imageStatus = null;
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    steps.push(look('스스로 다시 받음'));
    expectSteady(steps);
    expect(request.mock.calls.filter(([input]) => String(input.path).includes('/image?')).length).toBeGreaterThan(before);
    expect(look('끝').layers).toBe(1);
  });

  it('지나가는 실패가 이어지면 스스로 다시 받기는 세 번(1.5·3·6초)에서 멈춘다: 같은 그림의 칸 셋이 요청 4번을 나눠 쓰고, 그동안 글자는 0이다(보안 검수 r1 L1)', async () => {
    const {store, control, request} = realStore();
    control.imageStatus = 503;
    await act(async () => store.refresh(true));
    render(
      <PhoneExpressions.Provider value={store}>
        <MessageBody key="a" body={`:${NAME}:`} />
        <MessageBody key="b" body={`:${NAME}:`} />
        <MessageBody key="c" body={`:${NAME}:`} />
      </PhoneExpressions.Provider>,
    );
    await flush();
    const imageRequests = () =>
      request.mock.calls.filter(([input]) => String(input.path).includes('/image?')).length;
    const texts: number[] = [];
    for (let second = 0; second < 120; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      await flush(1);
      texts.push(screen.queryAllByText(`:${NAME}:`).length);
    }
    // 처음 1번 + 다시 3번. 한도가 없으면 30초마다 끝없이 다시 받는다.
    expect(imageRequests()).toBe(4);
    expect(texts.filter(count => count !== 0)).toEqual([]);
    expect(screen.getAllByTestId(`expression-box-${NAME}-large`)).toHaveLength(3);
  });

  it('정말로 깨진 그림(404)은 글자로 내린다 — 지나가는 실패만 칸으로 기다린다', async () => {
    const {store, control} = realStore();
    control.imageStatus = 404;
    await act(async () => store.refresh(true));
    mount(store);
    await flush();
    expect(look('404').text).toBe(1);
  });
});

describe('네이티브 내려받기 오류의 상태 (#5585)', () => {
  it('iOS·Android 가 던진 글에서 HTTP 상태를 읽고, 상태가 없는 오류(응답 없음)는 null 이다', () => {
    // 기기에서는 404 도 던져진다 — 상태를 못 읽으면 숨긴 그림(404)이 지나가는 실패로 읽혀 글자 대신 빈 칸으로 기다린다.
    expect(answeredStatus(new Error('Unable to download a file: response has status 404'))).toBe(404);
    expect(answeredStatus(new Error('Unable to download a file: HTTP 503'))).toBe(503);
    expect(answeredStatus(new Error('The network connection was lost.'))).toBeNull();
    expect(answeredStatus(new Error('Unable to download a file: no response'))).toBeNull();
  });
});

describe('소켓만 끊긴 동안 숨김 — 30초 주기 전체 읽기 (#5585 보안 검수 r1 H1)', () => {
  const layersOf = (name: string) =>
    screen.queryAllByTestId(new RegExp(`^expression-image-${name}-large`)).length;
  const textOf = (name: string) =>
    screen
      .queryAllByText(`:${name}:`)
      .filter(node => !String(node.props.testID ?? '').startsWith('expression-label-')).length;

  it('끊긴 동안 다른 사람이 숨긴 이모티콘은 30초 안에 칸에서 내려가 글자가 되고, 그 뒤 새로 서는 칸에도 숨긴 그림이 서지 않는다', async () => {
    const world = new World();
    world.add(1);
    world.add(2);
    const store = realCreate(WS, ME, world.transport(), makeFiles(), {read: () => null, write: jest.fn()}, undefined, null);
    stores.push(store);
    created.mockReturnValue(store);
    const one = <MessageBody key="a" body=":expr_1:" />;
    const view = render(tree('connected', one));
    await flush();
    expect(layersOf('expr_1')).toBe(1);
    view.rerender(tree('connecting', one));
    await flush();
    view.rerender(tree('disconnected', one)); // 표시 유예 10초가 지났고 보낼 수는 있다
    await flush();
    world.hide(1); // 알림은 소켓으로만 오므로 이 기기에는 오지 않는다
    world.resetCounts();
    // 주기 읽기 전(웹과 같은 30초 창): 아직 읽지 않았고 그림이 남아 있다. 숫자는 글자 그대로 쓴다(상수를 쓰면 숫자를 바꿔도 따라간다, r2 M1).
    await act(async () => {
      jest.advanceTimersByTime(29_000);
    });
    await flush(1);
    expect(world.listCalls).toEqual([]);
    expect(layersOf('expr_1')).toBe(1);
    // 30초: 전체 목록을 읽어 숨긴 것을 걷는다.
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await flush();
    expect(world.listCalls).toEqual(['']);
    expect(layersOf('expr_1')).toBe(0);
    expect(textOf('expr_1')).toBe(1);
    expect(store.snapshot().items.some(item => item.id === uuid(1))).toBe(false);
    // 그 뒤 같은 이모티콘이 든 새 메시지가 선다: 메모리에서도 그리지 않는다(그림 요청 0, 글자).
    view.rerender(tree('disconnected', [one, <MessageBody key="b" body=":expr_1:" />]));
    await flush();
    expect(layersOf('expr_1')).toBe(0);
    expect(textOf('expr_1')).toBe(2);
    expect(world.imageCalls).toEqual([]);
    // 끊긴 채면 30초마다 다시 읽는다.
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await flush();
    expect(world.listCalls).toEqual(['', '']);
  });
});

describe('이어지지 않은 동안의 시계 — 틈의 시작부터 30초 · 앞에 있을 때만 · 떠나면 남지 않음 (#5585 보안 검수 r2 H1·M1)', () => {
  // 박자는 글자 그대로 30초로 잰다(ADR-0218 §17 이 약속한 값). 상수를 가져다 쓰면 숫자를 5분으로 바꿔도 시험이 따라가 초록이다(r2 M1).
  const BEAT = 30_000;
  const layersOf = (name: string) =>
    screen.queryAllByTestId(new RegExp(`^expression-image-${name}-large`)).length;
  const textOf = (name: string) =>
    screen
      .queryAllByText(`:${name}:`)
      .filter(node => !String(node.props.testID ?? '').startsWith('expression-label-')).length;

  afterEach(() => {
    // 남은 `false` 는 뒤 시험의 주기 읽기를 소리 없이 0으로 만든다.
    focusManager.setFocused(undefined);
  });

  /** 진짜 저장소 + 가짜 세계. 목록 GET 이 나간 가짜 시각(ms)을 적는다. */
  function clockStore() {
    const world = new World();
    world.add(1);
    const readAt: number[] = [];
    const inner = world.transport();
    const transport = {
      request: jest.fn(async (input: ExpressionFixtureRequest) => {
        if (input.method === 'GET' && String(input.path).split('?')[0].endsWith('/expressions')) {
          readAt.push(Date.now());
        }
        return inner.request(input);
      }),
    };
    const store = realCreate(WS, ME, transport, makeFiles(), {read: () => null, write: jest.fn()}, undefined, null);
    stores.push(store);
    created.mockReturnValue(store);
    return {world, readAt};
  }

  /** 틈의 시작(`gap`)에서 `ms` 가 지난 때까지 가짜 시계를 돌리고 받기를 마친다. */
  async function until(gap: number, ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(Math.max(0, gap + ms - Date.now()));
    });
    await flush(1);
  }

  it('틈의 시작(소켓이 실제로 끊긴 때 — 표시 유예 10초 포함)부터 30초에 전체 목록을 읽어, 그사이 숨긴 그림이 글자가 된다 (r2 H1 가: 수리 전 40초)', async () => {
    expect(SOCKET_LOST_REFRESH_MS).toBe(BEAT);
    // 한 박자의 목록 읽기는 다음 박자 전에 끝나거나 마감된다(목록 GET 마감 < 30초): 박자의 읽기가 겹치지 않는다.
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(BEAT);
    const {world, readAt} = clockStore();
    const one = <MessageBody key="a" body=":expr_1:" />;
    const view = render(tree('connected', one));
    await flush();
    expect(layersOf('expr_1')).toBe(1);
    const gap = Date.now();
    view.rerender(tree('connecting', one)); // 소켓이 끊겼다 — 표시 상태는 유예 10초 동안 `connecting`
    world.hide(1); // 알림은 소켓으로만 오므로 이 기기에는 오지 않는다
    readAt.length = 0;
    await until(gap, 10_000);
    view.rerender(tree('disconnected', one)); // 유예 끝
    await flush();
    await until(gap, BEAT - 1_000);
    expect(readAt).toEqual([]);
    expect(layersOf('expr_1')).toBe(1);
    await until(gap, BEAT);
    await flush();
    expect(readAt.map(at => at - gap)).toEqual([BEAT]);
    expect(layersOf('expr_1')).toBe(0);
    expect(textOf('expr_1')).toBe(1);
  });

  it('끊긴 채 다시 연결 사건(「지금 다시 연결」·네트워크 종류 바뀜)이 25초마다 이어져도 시계는 처음부터 돌지 않는다: 틈의 시작부터 30초마다 읽는다 (r2 H1 나: 수리 전 120초 동안 0번)', async () => {
    const {world, readAt} = clockStore();
    const one = <MessageBody key="a" body=":expr_1:" />;
    const view = render(tree('connected', one));
    await flush();
    const gap = Date.now();
    view.rerender(tree('connecting', one));
    world.hide(1);
    readAt.length = 0;
    // 유예 끝(10초) 뒤 25초마다 다시 연결 사건이 온다: `connecting`(새 유예 10초) → `disconnected`. 소켓은 끝내 붙지 않는다.
    const turns: Array<[number, Status | 'look']> = [
      [10_000, 'disconnected'],
      [BEAT + 1_000, 'look'],
      [35_000, 'connecting'],
      [45_000, 'disconnected'],
      [70_000, 'connecting'],
      [80_000, 'disconnected'],
      [105_000, 'connecting'],
      [115_000, 'disconnected'],
    ];
    const looked: number[] = [];
    for (const [ms, turn] of turns) {
      await until(gap, ms);
      if (turn === 'look') {
        looked.push(layersOf('expr_1'), textOf('expr_1'));
        continue;
      }
      view.rerender(tree(turn, one));
      await flush();
    }
    await until(gap, 4 * BEAT);
    await flush();
    // 30초 안에 숨긴 그림이 글자가 됐다(층 0 · 글자 1).
    expect(looked).toEqual([0, 1]);
    // 박자는 틈의 시작에 걸린 그대로다 — 다시 연결 사건이 시계를 처음부터 돌리지 않는다.
    expect(readAt.map(at => at - gap)).toEqual([BEAT, 2 * BEAT, 3 * BEAT, 4 * BEAT]);
    expect(layersOf('expr_1')).toBe(0);
    expect(textOf('expr_1')).toBe(1);
  });

  it('앱이 뒤에 있는 동안은 읽지 않고, 앞으로 오면 초점 읽기 한 번 뒤 다시 30초 박자다 (r2 M1: 뒤로 간 앱의 읽기 0)', async () => {
    const {readAt} = clockStore();
    const one = <MessageBody key="a" body=":expr_1:" />;
    const view = render(tree('connected', one));
    await flush();
    view.rerender(tree('connecting', one));
    await flush();
    view.rerender(tree('disconnected', one));
    await flush();
    act(() => focusManager.setFocused(false));
    readAt.length = 0;
    await act(async () => {
      jest.advanceTimersByTime(5 * BEAT);
    });
    await flush();
    expect(readAt).toEqual([]);
    act(() => focusManager.setFocused(true));
    await flush();
    expect(readAt).toHaveLength(1); // 앞으로 올 때의 초점 읽기
    await act(async () => {
      jest.advanceTimersByTime(BEAT);
    });
    await flush();
    expect(readAt).toHaveLength(2); // 그 뒤 박자
  });

  it('시계는 쌓이지 않고 떠나면 남지 않는다: 끊김·재연결 5번 뒤 이어진 동안 0번, 끊긴 90초에 정확히 3번, 보낼 수 없는 동안 0번, Provider 가 내려간 뒤(앱 셸이 내려감·로그아웃) 0번 (r2 M1)', async () => {
    // 진짜 저장소는 오프라인·`dispose` 뒤 읽기를 스스로 버려서 남은 시계를 GET 수로 볼 수 없다. Provider 가 부른 `refresh` 를 그대로 센다.
    const store = fakeStore();
    created.mockReturnValue(store);
    const view = render(tree('connected'));
    await flush(1);
    for (let round = 0; round < 5; round += 1) {
      view.rerender(tree('connecting'));
      await flush(1);
      view.rerender(tree('disconnected'));
      await flush(1);
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      view.rerender(tree('connected'));
      await flush(1);
    }
    const refreshesOver = async (beats: number) => {
      store.refresh.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(beats * BEAT);
      });
      return store.refresh.mock.calls.length;
    };
    expect(await refreshesOver(4)).toBe(0); // 이어진 동안
    view.rerender(tree('connecting'));
    await flush(1);
    view.rerender(tree('disconnected'));
    await flush(1);
    expect(await refreshesOver(3)).toBe(3); // 끊긴 동안 박자마다 한 번 — 시계가 겹쳐 쌓이지 않는다
    mockGates.canSend = false;
    view.rerender(tree('disconnected'));
    await flush(1);
    expect(await refreshesOver(3)).toBe(0); // 보낼 수 없는 동안(오프라인이 맡는다)
    mockGates.canSend = true;
    view.rerender(tree('disconnected'));
    await flush(1);
    view.unmount();
    expect(await refreshesOver(4)).toBe(0); // Provider 가 내려간 뒤
  });
});
