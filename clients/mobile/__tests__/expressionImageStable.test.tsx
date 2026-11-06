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

function setup() {
  const list = {...FIXTURE_LIST, items: [moving, still]};
  const request = jest.fn(
    async (input: {method: string; path: string}) => {
      if (input.method === 'GET' && input.path === base) {
        return {status: 200, json: list};
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
  return {store, request, files};
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
