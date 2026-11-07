import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import {AppState, Pressable, StyleSheet} from 'react-native';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {
  Expression,
  ExpressionChangedDetail,
  ExpressionList,
  ExpressionMedia,
} from '@momo/core/features/expressions/types';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {ExpressionImage} from '../src/features/expressions/ExpressionImage';
import {
  EXPRESSION_POINTS,
  expressionBoxOf,
  expressionVariantFor,
  isAnimatedMedia,
} from '../src/features/expressions/expressionBox';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// #5451 — 표현 그림은 「칸」이 바뀌지 않고, 눌러도 사라지거나 떨지 않는다.
//
// 앞 판은 받는 중·변형이 바뀌는 사이에 칸을 0x0 + 글자 `:이름:` 으로 접었고(`ready` 가 거짓인 동안), 정지 그림을 눌러도 키가 바뀌어 다시
// 마운트됐다. 여기서는 그 둘을 **값으로** 잰다: 칸의 가로세로(스타일)가 모든 단계에서 같은가, 글자가 한 번이라도 섰는가, 앞 그림 층이 새 층이
// 그려질 때까지 남아 있는가(= 빈 프레임이 없는가), 다시 재생에 요청이 있었는가.
// =============================================================================

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const png = FIXTURE_MEDIA.png;
const gif = FIXTURE_MEDIA.gif;

/** 움직이지 않는 등록: 세 변형이 모두 정지 PNG 다(ADR-0218 D3 — 정지 그림은 PNG 로 다시 인코딩된다). */
const STATIC_MEDIA: ExpressionMedia = {
  small: {...png.image},
  large: {...png.image},
  thumb: {...png.image},
};
const still: Expression = {
  ...FIXTURE_EXPRESSIONS[1],
  media: STATIC_MEDIA,
};
const moving: Expression = FIXTURE_EXPRESSIONS[0];

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

function setup(holdDeltas = false) {
  const list = {...FIXTURE_LIST, items: [moving, still]};
  // 변경 알림 뒤의 부분 읽기(`?since=`)를 붙들어 두는 칸(#5473): 알림은 왔고 다음 목록은 아직 안 온 상태를 만든다.
  const deltas: Array<(answer: {status: number; json?: ExpressionList}) => void> = [];
  const request = jest.fn(
    async (input: {method: string; path: string}) => {
      if (input.method === 'GET' && input.path === base) {
        return {status: 200, json: list};
      }
      if (holdDeltas && input.method === 'GET' && input.path.includes('since=')) {
        return new Promise<{status: number; json?: ExpressionList}>(resolve => {
          deltas.push(resolve);
        });
      }
      if (input.path.includes('/image?')) {
        const wantsGif =
          input.path.includes(moving.id) && !input.path.includes('size=thumb');
        return {
          status: 200,
          bodyBase64: wantsGif ? gif.bodyBase64 : png.bodyBase64,
        };
      }
      return {status: 404};
    },
  );
  const files = {
    write: jest.fn((key: string) => `file:///fixture/${key}`),
    remove: jest.fn(),
  };
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request: request as never},
    files,
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, files, deltas};
}

function mount(store: PhoneExpressionStore, children: React.ReactNode) {
  return render(
    <PhoneExpressions.Provider value={store}>
      {children}
    </PhoneExpressions.Provider>,
  );
}

const boxOf = (name: string, size: string) =>
  StyleSheet.flatten(screen.getByTestId(`expression-box-${name}-${size}`).props.style);
const tokenText = (name: string) => screen.queryByText(`:${name}:`);
const imageCalls = (request: jest.Mock) =>
  request.mock.calls.filter(([input]) => String(input.path).includes('/image?'));
/** 한 틱: 받기(마이크로태스크)와 한 프레임(층 걷기의 rAF)만 흘린다 — 4번 돌고 서는 시계(수백 ms)는 건드리지 않는다. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(16);
  });
}

beforeEach(async () => {
  release = await pinReduceMotion(false);
  AppState.currentState = 'active';
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('칸 계산', () => {
  it('칸은 크기 표의 점 수와 가장 큰 그림의 비율로만 서고 변형과 무관하다', () => {
    const wide = {
      ...STATIC_MEDIA,
      large: {...STATIC_MEDIA.large, width: 512, height: 256},
      thumb: {...STATIC_MEDIA.thumb, width: 128, height: 63}, // 반올림이 어긋난 썸네일
    };
    expect(expressionBoxOf('large', wide, 17)).toEqual({width: 160, height: 80});
    expect(expressionBoxOf('medium', wide, 17)).toEqual({width: 48, height: 24});
    expect(expressionBoxOf('inline', wide, 17)).toEqual({width: 17, height: 8.5});
    expect(EXPRESSION_POINTS.large).toBe(160);
    // 값이 어긋난 그림은 정사각 칸(0 으로 접히지 않는다).
    const broken = {...STATIC_MEDIA, large: {...STATIC_MEDIA.large, width: 0}};
    expect(expressionBoxOf('large', broken, 17)).toEqual({width: 160, height: 160});
  });

  it('변형: 움직이는 그림은 보일 때만 움직이고, 정지 그림은 한 번 보인 뒤 선명한 변형에 머문다', () => {
    const v = expressionVariantFor;
    expect(v({size: 'large', still: false, animated: true, animate: true, seen: true})).toBe('large');
    expect(v({size: 'medium', still: false, animated: true, animate: true, seen: true})).toBe('small');
    expect(v({size: 'large', still: false, animated: true, animate: false, seen: true})).toBe('thumb');
    expect(v({size: 'large', still: false, animated: false, animate: false, seen: false})).toBe('thumb');
    // 정지 그림은 화면 밖으로 나가도(`animate` 거짓) 되돌리지 않는다.
    expect(v({size: 'large', still: false, animated: false, animate: false, seen: true})).toBe('large');
    expect(v({size: 'tile', still: true, animated: true, animate: true, seen: true})).toBe('thumb');
    expect(isAnimatedMedia(moving.media!)).toBe(true);
    expect(isAnimatedMedia(STATIC_MEDIA)).toBe(false);
  });
});

describe('정지 그림', () => {
  it('받기 전·받는 중·받은 뒤에 칸이 같고 글자가 서지 않으며, thumb → large 로 바뀌어도 앞 그림이 남는다', async () => {
    const {store} = setup();
    await act(async () => store.refresh(true));
    mount(store, <ExpressionImage expression={still} size="large" visible />);
    // 첫 프레임: 칸이 이미 160pt 로 서 있고 글자는 없다.
    const first = boxOf(still.name, 'large');
    expect(first).toMatchObject({width: 160, height: 160});
    expect(tokenText(still.name)).toBeNull();
    const seen = [first];
    for (let step = 0; step < 6; step += 1) {
      await flush();
      seen.push(boxOf(still.name, 'large'));
      expect(tokenText(still.name)).toBeNull();
    }
    expect(seen.every(box => box.width === 160 && box.height === 160)).toBe(true);
    // 끝에는 그림 층이 하나뿐이다(앞 층이 걷혔다).
    expect(screen.getAllByTestId(`expression-image-${still.name}-large`)).toHaveLength(1);
    expect(screen.queryByTestId(`expression-image-${still.name}-large-prev`)).toBeNull();
  });

  it('눌러도 아무 일도 없다: 다시 마운트하지 않고 요청도 층도 그림도 그대로다', async () => {
    const {store, request} = setup();
    const parentPress = jest.fn();
    await act(async () => store.refresh(true));
    mount(
      store,
      <Pressable onPress={parentPress}>
        <ExpressionImage expression={still} size="large" visible />
      </Pressable>,
    );
    for (let step = 0; step < 6; step += 1) await flush();
    const before = {
      uri: screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri,
      calls: imageCalls(request).length,
      box: boxOf(still.name, 'large'),
    };
    const label = screen.getByLabelText(`${still.displayName} · ${still.tags[0]}`);
    // 정지 그림은 누름을 받기만 한다: 부모 줄(스레드 열기)로 넘어가지 않고, 이 부품도 아무것도 하지 않는다.
    fireEvent.press(label);
    fireEvent.press(label);
    expect(parentPress).not.toHaveBeenCalled();
    for (let step = 0; step < 3; step += 1) await flush();
    expect(screen.getAllByTestId(`expression-image-${still.name}-large`)).toHaveLength(1);
    expect(screen.queryByTestId(`expression-image-${still.name}-large-prev`)).toBeNull();
    expect(screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri).toBe(before.uri);
    expect(imageCalls(request).length).toBe(before.calls);
    expect(boxOf(still.name, 'large')).toEqual(before.box);
    expect(tokenText(still.name)).toBeNull();
  });
});

describe('움직이는 그림(GIF)', () => {
  it('누르면 앞 층을 둔 채 새 층을 얹어 처음부터 다시 돌고, 다시 재생에 요청이 없고, 칸은 그대로다', async () => {
    const {store, request} = setup();
    await act(async () => store.refresh(true));
    mount(store, <ExpressionImage expression={moving} size="large" visible />);
    for (let step = 0; step < 4; step += 1) await flush();
    const top = () => screen.getByTestId(`expression-image-${moving.name}-large`);
    expect(top().props.source.uri).toMatch(/gif$/);
    act(() => {
      fireEvent(top(), 'load');
    });
    await flush();
    const callsBefore = imageCalls(request).length;
    const boxBefore = boxOf(moving.name, 'large');

    const label = screen.getByLabelText(`${moving.displayName} · ${moving.tags[0]}`);
    expect(label.props.onPress).toBeDefined();
    fireEvent.press(label);
    await act(async () => {
      await Promise.resolve();
    });
    // 새 층이 얹혔지만 앞 층이 아직 남아 있다 = 새 층이 그려지기 전에 빈 칸이 서지 않는다.
    expect(screen.getByTestId(`expression-image-${moving.name}-large-prev`)).toBeTruthy();
    expect(top().props.source.uri).toMatch(/gif$/);
    expect(tokenText(moving.name)).toBeNull();
    expect(boxOf(moving.name, 'large')).toEqual(boxBefore);
    // 새 층이 그려지면(`onLoad`) 앞 층을 걷는다.
    act(() => {
      fireEvent(top(), 'load');
    });
    await flush();
    expect(screen.queryByTestId(`expression-image-${moving.name}-large-prev`)).toBeNull();
    expect(screen.getAllByTestId(`expression-image-${moving.name}-large`)).toHaveLength(1);
    // 받은 파일을 다시 쓸 뿐이다 — 네트워크 요청이 늘지 않는다.
    expect(imageCalls(request).length).toBe(callsBefore);
    expect(boxOf(moving.name, 'large')).toEqual(boxBefore);
  });

  it('4번 돈 뒤 정지 thumb 로 바뀔 때도 앞 층이 남고 칸·글자가 그대로이며, 눌러서 다시 돌릴 수 있다', async () => {
    const {store, request} = setup();
    await act(async () => store.refresh(true));
    mount(store, <ExpressionImage expression={moving} size="large" visible />);
    for (let step = 0; step < 4; step += 1) await flush();
    const top = () => screen.getByTestId(`expression-image-${moving.name}-large`);
    act(() => {
      fireEvent(top(), 'load');
    });
    await flush();
    const boxBefore = boxOf(moving.name, 'large');
    await act(async () => {
      jest.advanceTimersByTime(moving.media!.large.durationMs * 4);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // 정지 thumb(PNG)가 새 층으로 얹혔고 GIF 층이 아직 밑에 있다.
    expect(top().props.source.uri).toMatch(/png$/);
    expect(screen.getByTestId(`expression-image-${moving.name}-large-prev`)).toBeTruthy();
    expect(tokenText(moving.name)).toBeNull();
    expect(boxOf(moving.name, 'large')).toEqual(boxBefore);
    act(() => {
      fireEvent(top(), 'load');
    });
    await flush();
    expect(screen.queryByTestId(`expression-image-${moving.name}-large-prev`)).toBeNull();
    const calls = imageCalls(request).length;
    fireEvent.press(screen.getByLabelText(`${moving.displayName} · ${moving.tags[0]}`));
    await flush();
    expect(top().props.source.uri).toMatch(/gif$/);
    expect(imageCalls(request).length).toBe(calls);
    expect(boxOf(moving.name, 'large')).toEqual(boxBefore);
  });

  it('동작 줄이기에서는 누름도 움직임도 없는 정지 thumb 다', async () => {
    release?.();
    release = await pinReduceMotion(true);
    const {store} = setup();
    await act(async () => store.refresh(true));
    mount(store, <ExpressionImage expression={moving} size="large" visible />);
    for (let step = 0; step < 4; step += 1) await flush();
    expect(screen.getByTestId(`expression-image-${moving.name}-large`).props.source.uri).toMatch(/png$/);
    // 동작 줄이기에서는 움직임이 없으니 누름도 받지 않는다(줄이 받는다) — 앞 판과 같다.
    expect(screen.getByLabelText(`${moving.displayName} · ${moving.tags[0]}`).props.onPress).toBeUndefined();
  });
});

// =============================================================================
// #5473 M-5451-1 — 숨김·삭제 알림(`store.changed()`)이 오면, 다음 목록이 적용될 때까지 이미 그린 그림이 화면에 남지 않는다.
//
// #5451 은 그림 층을 새로 받는 동안에도 칸에 남겨 두어서(빈 프레임 방지) 알림이 걷은 파일을 가리키는 층이 델타가 적용될 때까지 그려졌다(ADR-0218 D3 「숨김·삭제
// 이벤트 때 폐기」의 화면 쪽 후퇴). 지금은 알림 뒤 목록이 올 때까지 칸(`expression-box-*`)만 서고 그림 층(`expression-image-*`)은 0개다. 칸 크기는 그대로다.
// 기존 시험은 `store.refresh()` 를 기다려서 이 창을 잴 수 없었다 — 여기서는 목록 읽기를 붙들어 둔다.
// =============================================================================
describe('알림 뒤 목록이 적용되기 전', () => {
  const layerCount = (name: string) =>
    screen.queryAllByTestId(new RegExp(`^expression-image-${name}-large`)).length;
  const both = () => (
    <>
      <ExpressionImage expression={still} size="large" visible />
      <ExpressionImage expression={moving} size="large" visible />
    </>
  );
  /** 서버가 `moving` 을 숨겼다는 부분 읽기 답. */
  const hidesMoving = (): {status: number; json: ExpressionList} => ({
    status: 200,
    json: {
      ...FIXTURE_LIST,
      version: '4',
      baseVersion: '3',
      reset: false,
      items: [{...moving, version: '4', status: 'hidden', media: null}],
    },
  });

  it('changed() 만 오고 목록이 아직 안 왔을 때 그림 층은 0개이고 칸은 그대로이며, 목록이 오면 남은 표현은 받은 파일 그대로 다시 서고 숨겨진 것은 글자가 된다', async () => {
    const {store, request, files, deltas} = setup(true);
    await act(async () => store.refresh(true));
    mount(store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    // 대조: 알림 전에는 두 표현 모두 그림이 그려져 있다(없으면 아래 「0개」는 아무것도 재지 못한다).
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(1);
    const boxes = {still: boxOf(still.name, 'large'), moving: boxOf(moving.name, 'large')};
    expect(boxes.still).toMatchObject({width: 160, height: 160});
    const callsBefore = imageCalls(request).length;
    const uriBefore = screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri;

    // 알림만 온다 — 목록 읽기는 붙들려 있다.
    act(() => store.changed());
    await flush();
    expect(deltas).toHaveLength(1);
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
    expect(layerCount(moving.name)).toBe(0);
    // 칸은 그대로고(줄이 뛰지 않는다) 글자도 서지 않는다 — 어느 표현이 숨겨졌는지 모르는 동안은 비워 둘 뿐이다.
    expect(boxOf(still.name, 'large')).toEqual(boxes.still);
    expect(boxOf(moving.name, 'large')).toEqual(boxes.moving);
    expect(tokenText(still.name)).toBeNull();
    expect(tokenText(moving.name)).toBeNull();
    // 확인되지 않은 동안에는 그림을 새로 받지도 않는다.
    expect(imageCalls(request).length).toBe(callsBefore);

    // 목록이 온다: 숨겨진 것은 글자가 되고, 남은 표현은 칸 그대로 다시 선다.
    await act(async () => {
      deltas[0](hidesMoving());
    });
    for (let step = 0; step < 6; step += 1) await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(boxOf(still.name, 'large')).toEqual(boxes.still);
    expect(screen.getByText(`:${moving.name}:`)).toBeTruthy();
    expect(layerCount(moving.name)).toBe(0);
    // #5491: 알림은 파일을 걷지 않았고 목록은 숨겨진 표현의 파일만 걷었다 — 남은 표현은 이미 받은 파일 그대로 다시 선다(다시 받기 0).
    const uriAfter = screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri;
    const removed = files.remove.mock.calls.map(([uri]) => uri);
    expect(uriAfter).toBe(uriBefore);
    expect(removed).not.toContain(uriBefore);
    expect(removed).toHaveLength(1); // 숨겨진 `moving` 의 파일 하나
    expect(imageCalls(request).length).toBe(callsBefore);
  });

  it('같은 때 내 등록 응답이 그림을 걷어 읽던 목록 읽기를 버려도, 알림 뒤 목록을 다시 읽어 문이 내려간다', async () => {
    const {store, request, deltas} = setup(true);
    await act(async () => store.refresh(true));
    mount(store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    act(() => store.changed());
    await flush();
    expect(deltas).toHaveLength(1);
    // 내 등록(바꿔 올리기)의 응답: `still` 의 그림 정보가 바뀐다 → 걷기가 읽던 읽기를 버린다.
    request.mockImplementationOnce(
      (async () => ({
        status: 201,
        json: {
          workspaceId: FIXTURE_WORKSPACE_ID,
          version: '4',
          expression: {...still, version: '4', media: moving.media},
        },
      })) as never,
    );
    await act(async () => {
      await store.mutate({method: 'POST', path: base});
    });
    await flush();
    expect(deltas).toHaveLength(2); // 등록 응답은 알림을 확인해 주지 않는다 — 다시 읽는다
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
    // 버려진 첫 읽기의 늦은 답은 문을 내리지 못한다. 다시 읽은 답이 내린다.
    await act(async () => {
      deltas[0](hidesMoving());
    });
    expect(store.snapshot().changePending).toBe(true);
    await act(async () => {
      deltas[1]({
        status: 200,
        json: {...FIXTURE_LIST, version: '4', baseVersion: '4', reset: false, items: []},
      });
    });
    for (let step = 0; step < 6; step += 1) await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
  });

  it('읽은 답이 이미 적용한 목록보다 낡으면 한 번 더 읽고, 그 뒤에 그림을 다시 그린다 (멈춘 채 남지 않는다)', async () => {
    const {store, deltas} = setup(true);
    await act(async () => store.refresh(true));
    mount(store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    act(() => store.changed());
    await flush();
    // 첫 답이 낡았다(이미 적용한 3판보다 앞선 2판).
    await act(async () => {
      deltas[0]({
        status: 200,
        json: {...FIXTURE_LIST, version: '2', baseVersion: '1', reset: false, items: []},
      });
    });
    await flush();
    expect(deltas).toHaveLength(2); // 한 번 더 읽는다
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
    await act(async () => {
      deltas[1]({
        status: 200,
        json: {...FIXTURE_LIST, version: '3', baseVersion: '3', reset: false, items: []},
      });
    });
    for (let step = 0; step < 6; step += 1) await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(1);
  });

  it('낡은 답이 두 번 이어지면 어느 표현이 내려갔는지 끝내 모른다: 두었던 파일을 전부 걷고 문은 닫힌 채 둔다 (#5491)', async () => {
    const {store, files, deltas} = setup(true);
    await act(async () => store.refresh(true));
    mount(store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    const drawn = [still, moving].map(
      item => screen.getByTestId(`expression-image-${item.name}-large`).props.source.uri,
    );
    act(() => store.changed());
    await flush();
    expect(files.remove).not.toHaveBeenCalled(); // 알림은 파일을 걷지 않는다
    const stale = {
      status: 200,
      json: {...FIXTURE_LIST, version: '2', baseVersion: '1', reset: false, items: []},
    };
    await act(async () => {
      deltas[0](stale);
    });
    await flush();
    expect(deltas).toHaveLength(2); // 한 번 더 읽는다
    expect(files.remove).not.toHaveBeenCalled();
    await act(async () => {
      deltas[1](stale);
    });
    await flush();
    // 두었던 파일은 하나도 남지 않는다: 지금 그린 것뿐 아니라 앞서 받아 둔 변형도 쓴 파일 전부다.
    const written = files.write.mock.results.map(result => result.value as string);
    const removed = files.remove.mock.calls.map(([uri]) => uri as string);
    expect([...removed].sort()).toEqual([...written].sort());
    expect(removed).toEqual(expect.arrayContaining(drawn));
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
  });

  it('알림 뒤 목록 읽기가 실패하면 닫힌다: 문이 내려가고 글자가 서며 그림 층은 없다', async () => {
    const {store, deltas} = setup(true);
    await act(async () => store.refresh(true));
    mount(store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    act(() => store.changed());
    await flush();
    await act(async () => {
      deltas[0]({status: 500});
    });
    for (let step = 0; step < 3; step += 1) await flush();
    expect(store.snapshot()).toMatchObject({state: 'error', changePending: false});
    expect(layerCount(still.name)).toBe(0);
    expect(screen.getByText(`:${still.name}:`)).toBeTruthy();
  });
});

// =============================================================================
// #5491 (ADR-0218 증보 9, §15) — 상세 알림(`expression.changed.detail`)이 오면 바뀐 표현만 건드린다.
//
// 등록·고치기 알림에는 그리던 그림을 그대로 둔다(빈 프레임 0, 그림 요청 0). 숨김·삭제 알림에는 그 id 만 즉시 글자로 내리고 나머지는 그대로다. 상세가 없으면
// (옛 서버·유실) 위의 「알림 뒤 목록이 적용되기 전」 그대로 전부 내린다. 같은 version 의 둘째 알림은 건너뛴다(목록 읽기가 아직 진행 중이어도).
// =============================================================================
describe('상세 알림 (ADR-0218 §15)', () => {
  const layerCount = (name: string) =>
    screen.queryAllByTestId(new RegExp(`^expression-image-${name}-large`)).length;
  const both = () => (
    <>
      <ExpressionImage expression={still} size="large" visible />
      <ExpressionImage expression={moving} size="large" visible />
    </>
  );
  const detail = (
    action: ExpressionChangedDetail['action'],
    expressionIds: string[],
    version = '4',
  ): ExpressionChangedDetail => ({
    type: 'expression.changed.detail',
    workspaceId: FIXTURE_WORKSPACE_ID,
    version,
    action,
    expressionIds,
  });
  const hidesMoving = (): {status: number; json: ExpressionList} => ({
    status: 200,
    json: {
      ...FIXTURE_LIST,
      version: '4',
      baseVersion: '3',
      reset: false,
      items: [{...moving, version: '4', status: 'hidden', media: null}],
    },
  });
  /** 새 표현이 하나 등록됐다는 부분 읽기 답. */
  const addsOne = (): {status: number; json: ExpressionList} => ({
    status: 200,
    json: {
      ...FIXTURE_LIST,
      version: '4',
      baseVersion: '3',
      reset: false,
      items: [
        {
          ...FIXTURE_EXPRESSIONS[2],
          id: '00000000-0000-4000-8000-0000000000e1',
          name: 'fresh_one',
          version: '4',
        },
      ],
    },
  });
  async function mounted() {
    const ctx = setup(true);
    await act(async () => ctx.store.refresh(true));
    mount(ctx.store, both());
    for (let step = 0; step < 6; step += 1) await flush();
    expect(layerCount(still.name)).toBe(1); // 대조: 알림 전에는 둘 다 그려져 있다
    expect(layerCount(moving.name)).toBe(1);
    return {
      ...ctx,
      boxes: {still: boxOf(still.name, 'large'), moving: boxOf(moving.name, 'large')},
      calls: imageCalls(ctx.request).length,
      uris: {
        still: screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri,
        moving: screen.getByTestId(`expression-image-${moving.name}-large`).props.source.uri,
      },
    };
  }

  it('등록 상세: 그리던 그림이 그대로이고(층 유지·빈 프레임 0), 파일도 요청도 걷거나 내지 않으며, 목록만 새로 읽는다', async () => {
    const {store, request, files, deltas, boxes, calls, uris} = await mounted();
    // 알림 순간부터 목록이 적용될 때까지 매 단계를 잰다 — 층이 한 번이라도 0개가 되면 빈 프레임이다.
    const frames: number[] = [];
    const watch = () => frames.push(layerCount(still.name) + layerCount(moving.name));
    act(() => store.detailed(detail('created', ['00000000-0000-4000-8000-0000000000e1'])));
    watch();
    await flush();
    watch();
    expect(deltas).toHaveLength(1); // 목록은 새로 읽는다
    expect(store.snapshot().changePending).toBe(false); // 문은 올라가지 않는다
    await act(async () => {
      deltas[0](addsOne());
    });
    for (let step = 0; step < 4; step += 1) {
      await flush();
      watch();
    }
    expect(frames.length).toBeGreaterThan(4);
    expect(frames.every(count => count === 2)).toBe(true);
    expect(store.snapshot().items.some(item => item.name === 'fresh_one')).toBe(true);
    expect(boxOf(still.name, 'large')).toEqual(boxes.still);
    expect(tokenText(still.name)).toBeNull();
    expect(tokenText(moving.name)).toBeNull();
    // 같은 파일 그대로(다시 받기 0), 걷은 파일 0.
    expect(imageCalls(request).length).toBe(calls);
    expect(files.remove).not.toHaveBeenCalled();
    expect(screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri).toBe(uris.still);
    expect(screen.getByTestId(`expression-image-${moving.name}-large`).props.source.uri).toBe(uris.moving);
  });

  it('고치기 상세도 같다: 그림을 그대로 두고 목록만 새로 읽는다', async () => {
    const {store, request, files, deltas, calls} = await mounted();
    act(() => store.detailed(detail('edited', [still.id])));
    await flush();
    expect(deltas).toHaveLength(1);
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(1);
    await act(async () => {
      deltas[0]({
        status: 200,
        json: {
          ...FIXTURE_LIST,
          version: '4',
          baseVersion: '3',
          reset: false,
          items: [{...still, version: '4', displayName: '새 표시 이름'}],
        },
      });
    });
    for (let step = 0; step < 3; step += 1) await flush();
    expect(imageCalls(request).length).toBe(calls);
    expect(files.remove).not.toHaveBeenCalled();
    expect(layerCount(still.name)).toBe(1);
  });

  it('숨김 상세: 그 표현만 그 자리에서 글자가 되고 파일이 걷히며, 나머지는 층도 칸도 파일도 그대로다(요청 0)', async () => {
    const {store, request, files, deltas, boxes, calls, uris} = await mounted();
    act(() => store.detailed(detail('hidden', [moving.id])));
    // 목록이 아직 안 왔어도(읽기는 붙들려 있다) 숨겨진 표현은 이미 내려가 있다.
    expect(layerCount(moving.name)).toBe(0);
    expect(screen.getByText(`:${moving.name}:`)).toBeTruthy();
    expect(files.remove.mock.calls).toEqual([[uris.moving]]); // 그 표현의 파일만
    // 남은 표현은 건드리지 않았다.
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(boxOf(still.name, 'large')).toEqual(boxes.still);
    expect(screen.getByTestId(`expression-image-${still.name}-large`).props.source.uri).toBe(uris.still);
    await flush();
    expect(deltas).toHaveLength(1);
    // 목록이 와도 같다.
    await act(async () => {
      deltas[0](hidesMoving());
    });
    for (let step = 0; step < 4; step += 1) await flush();
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(0);
    expect(screen.getByText(`:${moving.name}:`)).toBeTruthy();
    expect(imageCalls(request).length).toBe(calls);
    expect(files.remove).toHaveBeenCalledTimes(1);
  });

  it('같은 version 의 v1 은 건너뛴다: 상세가 먼저 왔으면 목록 읽기가 아직 진행 중이어도 그림을 전부 내리지 않고, 읽기를 다시 시작하지도 않는다', async () => {
    const {store, deltas} = await mounted();
    act(() => store.detailed(detail('created', ['00000000-0000-4000-8000-0000000000e1'])));
    await flush();
    expect(deltas).toHaveLength(1); // 읽기가 진행 중이다(아직 답이 없다)
    act(() => store.changed('4')); // 같은 version 의 옛 알림이 뒤따른다
    await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(1);
    expect(deltas).toHaveLength(1);
  });

  it('다른 version 의 v1 은 건너뛰지 않는다: 상세 없이 오면 전부 내린다(지금과 같다)', async () => {
    const {store, deltas, files} = await mounted();
    act(() => store.detailed(detail('created', ['00000000-0000-4000-8000-0000000000e1'], '4')));
    await flush();
    act(() => store.changed('5'));
    await flush();
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
    expect(layerCount(moving.name)).toBe(0);
    expect(files.remove).not.toHaveBeenCalled(); // 파일은 두고 그리기만 멈춘다
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it('v1 이 먼저 오면(순서가 뒤집혀도) 전부 내리고, 뒤늦게 온 같은 version 의 등록 상세는 할 일이 없다', async () => {
    const {store, deltas} = await mounted();
    act(() => store.changed('4'));
    await flush();
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
    expect(deltas).toHaveLength(1);
    act(() => store.detailed(detail('created', ['00000000-0000-4000-8000-0000000000e1'])));
    await flush();
    expect(deltas).toHaveLength(1); // 두 번째 읽기도, 두 번째 걷기도 없다
    await act(async () => {
      deltas[0](addsOne());
    });
    for (let step = 0; step < 6; step += 1) await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(layerCount(moving.name)).toBe(1);
  });

  it('v1 이 먼저 오고 숨김 상세가 늦게 와도 건너뛰지 않는다: 목록을 기다리지 않고 그 표현의 파일만 걷고, 앞서 시작한 읽기는 버리고 다시 읽는다 (#5491 H-5491-1)', async () => {
    const {store, files, deltas, uris} = await mounted();
    act(() => store.changed('4'));
    await flush();
    expect(store.snapshot().changePending).toBe(true);
    expect(deltas).toHaveLength(1);
    expect(files.remove).not.toHaveBeenCalled(); // 이름 없는 v1 은 파일을 걷지 못한다
    act(() => store.detailed(detail('hidden', [moving.id]))); // 같은 version 의 늦은 숨김 상세
    await flush();
    // 상세가 그 id 의 파일을 그 자리에서 걷는다 — 목록이 오기 전에, 다른 표현의 파일은 그대로.
    expect(files.remove.mock.calls).toEqual([[uris.moving]]);
    expect(store.snapshot().items.some(item => item.id === moving.id)).toBe(false);
    expect(deltas).toHaveLength(2); // 앞서 시작한 읽기는 버려지고 새로 읽는다
    await act(async () => {
      deltas[0](hidesMoving()); // 버려진 읽기의 늦은 답은 문을 내리지 못한다
    });
    expect(store.snapshot().changePending).toBe(true);
    await act(async () => {
      deltas[1](hidesMoving());
    });
    for (let step = 0; step < 6; step += 1) await flush();
    expect(store.snapshot().changePending).toBe(false);
    expect(layerCount(still.name)).toBe(1);
    expect(screen.getByText(`:${moving.name}:`)).toBeTruthy();
    expect(files.remove).toHaveBeenCalledTimes(1);
  });

  it('새로 구독하면 기억이 비워진다: 앞서 본 version 의 v1 도 다시 전부 내린다', async () => {
    const {store} = await mounted();
    act(() => store.detailed(detail('created', ['00000000-0000-4000-8000-0000000000e1'])));
    await flush();
    act(() => store.resetNotices());
    act(() => store.changed('4'));
    await flush();
    expect(store.snapshot().changePending).toBe(true);
    expect(layerCount(still.name)).toBe(0);
  });
});

describe('쓸 수 없는 표현', () => {
  it('목록에 없거나 숨겨진 표현만 글자로 내린다(받는 중에는 글자가 아니다)', async () => {
    const {store} = setup();
    await act(async () => store.refresh(true));
    const ghost = {...still, id: '00000000-0000-4000-8000-0000000000ff', name: 'ghost_one'};
    mount(store, <ExpressionImage expression={ghost} size="large" visible />);
    await flush();
    expect(screen.getByText(':ghost_one:')).toBeTruthy();
  });
});
