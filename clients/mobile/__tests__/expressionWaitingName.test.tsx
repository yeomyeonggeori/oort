import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, render, screen, within} from '@testing-library/react-native';
import {AppState, Dimensions, StyleSheet} from 'react-native';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {expressionAltText} from '@momo/core/features/expressions/message';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {ExpressionImage, type PhoneExpressionSize} from '../src/features/expressions/ExpressionImage';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, font, line, lightPalette, radius, type Palette} from '../src/design/tokens';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// #5627 — 폰: 그림을 못 받은 이모티콘 칸 안에 이름을(웹 #5575 M1·M2 와 같게, #5585 후속).
//
// #5585 뒤로 폰은 오프라인·목록 오류·지나가는 받기 실패 동안 같은 크기의 **빈** 칸을 둔다(대화 높이가 바뀌지 않는다). 다만 오래 끊기면 예전의
// `:이름:` 글자 대신 이름 없는 빈 칸이라 무엇을 보냈는지 알 수 없었다. 지금은 웹과 같다:
//   · 빈 칸이 3초 넘게 이어지면 칸 자신이 옅은 그릇 + 테두리를 입고, 큰 칸(한 줄, 끝 말줄임)·중간 칸과 시트의 큰 칸(두 줄)에는 `:이름:` 을 칸 위에 얹는다.
//     반응 칩·글 사이·고르개 칸은 글자가 안 들어가 정지 자리표시만 선다. 3초 전에는 투명한 빈 칸 그대로다(흔들림마다 깜빡이지 않는다).
//   · 그 동안 읽기 도우미는 「<이름> 이모티콘」을 읽는다. 이름 글자 자체는 읽기 도우미에서 숨긴다(두 번 읽히지 않게).
//   · 칸의 가로·세로는 어느 걸음에서도 그대로이고, 그림이 오면 같은 자리에서 그림으로 바뀐다.
// =============================================================================

const parrot = FIXTURE_EXPRESSIONS[0];
const NAME = parrot.name;
const SPOKEN = `${NAME} 이모티콘`;
const TOKEN = `:${NAME}:`;
const HIDDEN = {includeHiddenElements: true} as const;
const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

const BASE_WINDOW = Dimensions.get('window');
/** RN jest 프리셋의 기본 글자 배율은 2 다 — 시험이 배율을 정한다. */
function setFontScale(fontScale: number) {
  const window = {...BASE_WINDOW, fontScale};
  Dimensions.set({window, screen: window});
}

/** 진짜 저장소 + 가짜 서버. `imageStatus` 는 그림 받기를 그 상태로 답하게 한다(null 이면 가짜 서버 그대로). */
function realStore() {
  const server = createExpressionFixtureServer();
  const control = {imageStatus: null as number | null};
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    if (control.imageStatus !== null && String(input.path).includes('/image?')) {
      return {status: control.imageStatus};
    }
    return server.request(input);
  });
  const files = {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()};
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return {store, request, control};
}
const imageCalls = (request: jest.Mock) =>
  request.mock.calls.filter(([input]) => String(input.path).includes('/image?')).length;

function mount(store: PhoneExpressionStore, children: React.ReactNode, scheme: 'light' | 'dark' = 'light') {
  return render(
    <FixedScheme scheme={scheme}>
      <PhoneExpressions.Provider value={store}>{children}</PhoneExpressions.Provider>
    </FixedScheme>,
  );
}

/** 한 틱: 받기(마이크로태스크)와 한 프레임(16ms). */
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
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

const boxOf = (size: PhoneExpressionSize) => screen.getByTestId(`expression-box-${NAME}-${size}`);
const markOf = (size: PhoneExpressionSize) => screen.queryByTestId(`expression-label-${NAME}-${size}`, HIDDEN);
const dims = (size: PhoneExpressionSize) => {
  const style = StyleSheet.flatten(boxOf(size).props.style);
  return {width: Number(style.width), height: Number(style.height)};
};
const layers = (size: PhoneExpressionSize) =>
  screen.queryAllByTestId(new RegExp(`^expression-image-${NAME}-${size}`)).length;

interface Step {
  step: string;
  box: {width: number; height: number};
  /** 칸 안 이름 글자가 서 있는가. */
  named: boolean;
  layers: number;
  /** 칸을 감싼 글자의 읽기 도우미 이름. */
  spoken: string | undefined;
  /** 칸이 옅은 그릇을 입었는가. */
  filled: boolean;
}
function look(step: string, size: PhoneExpressionSize = 'large'): Step {
  const box = boxOf(size);
  const style = StyleSheet.flatten(box.props.style);
  const outer = screen.getAllByLabelText(/./).find(node => within(node).queryByTestId(box.props.testID) !== null);
  return {
    step,
    box: dims(size),
    named: markOf(size) !== null,
    layers: layers(size),
    spoken: outer?.props.accessibilityLabel,
    filled: style.backgroundColor !== undefined,
  };
}

beforeEach(async () => {
  release = await pinReduceMotion(false);
  AppState.currentState = 'active';
  setFontScale(1);
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('오래 못 받는 칸 안의 이름 (#5627)', () => {
  it('기기 오프라인: 3초 전에는 빈 칸, 3초 뒤 칸 안에 이름과 「<이름> 이모티콘」 낭독, 돌아오면 같은 자리에 그림 — 칸 160×160 은 모든 걸음에서 그대로', async () => {
    const {store} = realStore();
    await act(async () => store.refresh(true));
    mount(store, <MessageBody body={TOKEN} />);
    await flush();
    const steps: Step[] = [look('처음')];
    expect(steps[0]).toMatchObject({named: false, layers: 1, filled: false, spoken: expressionAltText(parrot)});

    act(() => store.setOnline(false));
    await flush();
    steps.push(look('오프라인'));
    await advance(2_836); // 오프라인 뒤 약 2.9초
    const early = look('2.9초');
    steps.push(early);
    // 3초 전: 투명한 빈 칸 그대로(이름도 그릇도 없다), 그림 층도 없다(D3).
    expect(early).toMatchObject({named: false, filled: false, layers: 0});
    expect(early.spoken).not.toBe(SPOKEN);

    await advance(200); // 약 3.1초
    const named = look('3.1초');
    steps.push(named);
    expect(named).toMatchObject({named: true, filled: true, layers: 0, spoken: SPOKEN});
    // 이름 글자는 칸 **안**에 절대 위치로 얹혀 칸 안에서 잘린다(칸의 크기를 바꾸지 않는다). 읽기 도우미에서는 숨는다(바깥 글자의 이름이 진다).
    const box = boxOf('large');
    const mark = within(box).getByTestId(`expression-label-${NAME}-large`, HIDDEN);
    expect(mark.props.children).toBe(TOKEN);
    const frame = mark.parent?.parent ?? null;
    expect(frame).not.toBeNull();
    expect(StyleSheet.flatten(frame!.props.style)).toMatchObject({position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden'});
    // 읽기 도우미 트리(RNTL 기본 질의는 숨은 요소를 뺀다)에는 이름 글자가 없다 — 낭독은 바깥 글자의 「<이름> 이모티콘」 하나다.
    expect(screen.queryByText(TOKEN)).toBeNull();
    // 필요한 셋만 골라 견준다(실패할 때 props 전체 — 자식 트리 — 를 비교 글로 풀면 jest 가 메모리를 다 쓴다).
    const {accessible, accessibilityElementsHidden, importantForAccessibility} = frame!.props;
    expect({accessible, accessibilityElementsHidden, importantForAccessibility}).toEqual({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });

    // 돌아오면 같은 자리에서 그림으로 바뀐다 — 이름·그릇이 걷히고 칸은 그대로.
    act(() => store.setOnline(true));
    steps.push(look('돌아옴(읽는 중)'));
    await flush();
    const back = look('돌아옴');
    steps.push(back);
    expect(back).toMatchObject({named: false, filled: false, layers: 1, spoken: expressionAltText(parrot)});

    // 다시 끊기면 3초를 처음부터 다시 잰다(앞의 3초가 남지 않는다 — 돌아올 때마다 이름이 곧바로 서지 않는다).
    act(() => store.setOnline(false));
    await flush();
    await advance(1_000);
    const again = look('다시 오프라인 1초');
    steps.push(again);
    expect(again).toMatchObject({named: false, filled: false, layers: 0});
    await advance(2_100);
    steps.push(look('다시 오프라인 3.1초'));
    expect(steps[steps.length - 1]).toMatchObject({named: true, spoken: SPOKEN});

    expect(steps.filter(seen => seen.box.width !== 160 || seen.box.height !== 160)).toEqual([]);
  });

  it('그림 받기가 지나가는 실패(503)로 이어지면 3초 뒤 이름이 서고, 다시 받기를 다 쓴 뒤에도 같은 칸에 남는다', async () => {
    const {store, control, request} = realStore();
    await act(async () => store.refresh(true));
    control.imageStatus = 503;
    mount(store, <MessageBody body={TOKEN} />);
    await flush();
    const steps: Step[] = [look('받기 실패')];
    expect(steps[0]).toMatchObject({named: false, layers: 0});
    await advance(2_836);
    steps.push(look('2.9초'));
    expect(steps[1].named).toBe(false);
    await advance(200);
    steps.push(look('3.1초'));
    expect(steps[2]).toMatchObject({named: true, filled: true, spoken: SPOKEN});
    // 1.5 · 3 · 6초 세 번 다시 받고 멈춘다(#5585). 그 뒤에도 이름은 같은 칸에 그대로다.
    for (let second = 0; second < 40; second += 1) {
      await advance(1_000);
      await flush(1);
    }
    steps.push(look('43초'));
    const calls = imageCalls(request);
    expect(calls).toBe(4);
    await advance(30_000);
    await flush(1);
    steps.push(look('73초'));
    expect(imageCalls(request)).toBe(calls);
    expect(steps.slice(2).filter(seen => !seen.named || seen.spoken !== SPOKEN)).toEqual([]);
    expect(steps.filter(seen => seen.box.width !== 160 || seen.box.height !== 160)).toEqual([]);
  });

  it('글자 크기·줄 수는 웹과 같다: 큰 칸 한 줄(끝 말줄임), 중간 칸·시트 칸 두 줄 — 글자 배율이 커서 두 줄이 안 들어가면 한 줄', async () => {
    const {store} = realStore();
    await act(async () => store.refresh(true));
    const sizes: PhoneExpressionSize[] = ['large', 'medium', 'tile'];
    mount(
      store,
      <>
        {sizes.map(size => <ExpressionImage key={size} expression={parrot} size={size} visible />)}
      </>,
    );
    await flush();
    const before = Object.fromEntries(sizes.map(size => [size, dims(size)]));
    act(() => store.setOnline(false));
    await flush();
    await advance(3_100);
    const lines = (size: PhoneExpressionSize) => markOf(size)?.props.numberOfLines;
    expect(sizes.map(size => [size, lines(size)])).toEqual([['large', 1], ['medium', 2], ['tile', 2]]);
    for (const size of sizes) {
      const mark = markOf(size)!;
      expect(mark.props.ellipsizeMode).toBe('tail');
      expect(StyleSheet.flatten(mark.props.style)).toMatchObject({fontSize: font.meta, lineHeight: line.meta, color: lightPalette.textMuted, textAlign: 'center'});
      expect(StyleSheet.flatten(boxOf(size).props.style)).toMatchObject({
        ...before[size],
        backgroundColor: lightPalette.surfaceMuted,
        borderColor: lightPalette.border,
        borderWidth: 1,
        borderRadius: radius.sm,
      });
    }
    // 글자 배율 2: 중간 칸(48pt)에는 16pt × 2 줄 상자가 한 줄만 온전히 들어간다. 칸 크기는 배율과 무관하게 그대로다.
    act(() => setFontScale(2));
    await flush(1);
    expect(sizes.map(size => [size, lines(size)])).toEqual([['large', 1], ['medium', 1], ['tile', 2]]);
    expect(Object.fromEntries(sizes.map(size => [size, dims(size)]))).toEqual(before);
  });

  it('작은 칸(반응 칩·글 사이·고르개)은 글자 없이 정지 자리표시(그릇 + 짙은 테두리)만 서고, 이름은 낭독이 진다 — 어둡게', async () => {
    const {store} = realStore();
    await act(async () => store.refresh(true));
    const sizes: PhoneExpressionSize[] = ['reaction', 'inline', 'grid'];
    mount(
      store,
      <>
        {sizes.map(size => <ExpressionImage key={size} expression={parrot} size={size} visible />)}
      </>,
      'dark',
    );
    await flush();
    const before = Object.fromEntries(sizes.map(size => [size, dims(size)]));
    act(() => store.setOnline(false));
    await flush();
    await advance(3_100);
    for (const size of sizes) {
      const seen = look(size, size);
      expect(seen).toMatchObject({named: false, filled: true, layers: 0, spoken: SPOKEN, box: before[size]});
      expect(StyleSheet.flatten(boxOf(size).props.style)).toMatchObject({
        backgroundColor: darkPalette.surfaceMuted,
        borderColor: darkPalette.textFaint,
        borderWidth: 1,
        borderRadius: radius.sm,
      });
    }
  });

  it('큰 칸의 그릇·글자도 어두운 팔레트의 역할 값이다(손으로 적은 색이 없다)', async () => {
    const {store} = realStore();
    await act(async () => store.refresh(true));
    mount(store, <MessageBody body={TOKEN} />, 'dark');
    await flush();
    act(() => store.setOnline(false));
    await flush();
    await advance(3_100);
    const palette: Palette = darkPalette;
    expect(StyleSheet.flatten(boxOf('large').props.style)).toMatchObject({
      width: 160,
      height: 160,
      backgroundColor: palette.surfaceMuted,
      borderColor: palette.border,
    });
    expect(StyleSheet.flatten(markOf('large')!.props.style)).toMatchObject({color: palette.textMuted});
    expect(darkPalette.surfaceMuted).not.toBe(lightPalette.surfaceMuted);
  });
});
