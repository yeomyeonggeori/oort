import {contrast} from '@momo/core/design/color';
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
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {retainReduceMotion} from '../src/lib/useReduceMotion';
import {CONV_ICON_SIZE, CONV_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from '../src/design/icons';
import {PageSheet, SHEET_TOP} from '../src/design/PageSheet';
import {STACK_PILL_SCALE} from '../src/design/atoms';
import {PageHeader, SheetHeader} from '../src/design/SheetChrome';
import {THEME_IDS} from '../src/design/ds2Tokens';
import {
  SHEET_DISMISS_VELOCITY,
  cardPosition,
  cardRing,
  circleLook,
  dividerIndent,
  sheetDismissDistance,
  sheetFrame,
  shouldDismissSheet,
} from '../src/design/sheetModel';
import {
  ActionTile,
  ActionTileRow,
  GroupCard,
  GroupCardItem,
  InputPill,
  ListRow,
  RowEmoji,
  SheetScroll,
} from '../src/design/sheetParts';
import {FixedScheme, paletteFor, type ColorScheme} from '../src/design/theme';
import {ds2Radius, paletteFrom, radius, SHEET, space} from '../src/design/tokens';

// =============================================================================
// 공용 시트·페이지 부품 (#4318). 규칙의 판정은 `sheetModel.ts`(순수)에서 재고, 배선은 실제
// 렌더에서 손가락·로터·동작 줄이기로 잰다. 각 단정은 일부러 되돌려 본 사보타주 표가 PR 에 있다.
// =============================================================================

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
const WINDOW_HEIGHT = Dimensions.get('window').height;

let releaseReduceMotion: (() => void) | null = null;

afterEach(() => {
  cleanup();
  releaseReduceMotion?.();
  releaseReduceMotion = null;
  jest.restoreAllMocks();
});

/** 시트 안전 영역을 정한다 — `jest.setup.js` 의 영(0) 대역을 렌더 전에 갈아 끼운다. */
function useInsets(bottom: number) {
  const safeArea = require('react-native-safe-area-context');
  return jest
    .spyOn(safeArea, 'useSafeAreaInsets')
    .mockReturnValue({top: 0, left: 0, right: 0, bottom});
}

/** 시스템의 「동작 줄이기」 답을 정해 두고 마운트한다 — 답은 한 틱 뒤에 도착한다. */
async function mount(ui: React.ReactElement, reduceMotion = false, scheme: ColorScheme = 'light') {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(reduceMotion));
  // 앱의 뿌리가 시작 때 하는 일(`App.tsx`): 저장소를 붙들어 답을 **시트가 서기 전에** 안다.
  // 그러지 않으면 첫 렌더가 기본값(꺼짐)으로 올라와 미끄러져 들어온다.
  releaseReduceMotion ??= retainReduceMotion();
  await act(async () => {});
  const utils = render(<FixedScheme scheme={scheme}>{ui}</FixedScheme>);
  await act(async () => {});
  return utils;
}

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.style);

function Sheet({
  onClose,
  height,
  children,
}: {
  onClose: () => void;
  height?: 'fit' | 'medium' | 'large';
  children?: React.ReactNode;
}) {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="시험 시트" height={height} testID="sheet">
      <SheetHeader title="시험 시트" closeLabel="시험 시트 닫기" closeTestID="close" />
      {children}
    </PageSheet>
  );
}

// ---------------------------------------------------------------------------
// 순수 규칙
// ---------------------------------------------------------------------------

// 문턱의 값·경계·비율·바닥은 `sheetDrag.test.tsx` 가 잰다(#4612). 여기는 옛 시험이 지키던 세 문장만 새 판정으로 잇는다.
describe('끌어 닫기 문턱', () => {
  const HEIGHT = 400;
  const distance = sheetDismissDistance(HEIGHT);

  it('거리만 넘어도 닫고, 속도만 넘어도 닫고, 둘 다 모자라면 닫지 않는다', () => {
    expect(shouldDismissSheet(distance + 1, 0, HEIGHT)).toBe(true);
    expect(shouldDismissSheet(10, SHEET_DISMISS_VELOCITY + 0.1, HEIGHT)).toBe(true);
    expect(shouldDismissSheet(distance - 1, SHEET_DISMISS_VELOCITY - 0.1, HEIGHT)).toBe(false);
    expect(shouldDismissSheet(0, 0, HEIGHT)).toBe(false);
  });

  it('경계값 자체는 닫지 않는다 — 「넘어야」 닫는다', () => {
    expect(shouldDismissSheet(distance, 0, HEIGHT)).toBe(false);
    expect(shouldDismissSheet(0, SHEET_DISMISS_VELOCITY, HEIGHT)).toBe(false);
  });

  it('위로 끄는 것(음수)은 닫지 않는다', () => {
    expect(shouldDismissSheet(-500, -5, HEIGHT)).toBe(false);
  });
});

describe('높이 세 단', () => {
  it('큰 단은 위 58 에서 바닥까지, 깊은 상태 막대에서는 그 아래 4pt', () => {
    expect(sheetFrame('large', 800, 0)).toEqual({top: 58});
    expect(sheetFrame('large', 800, 59)).toEqual({top: 63});
  });
  it('내용 맞춤은 화면의 85% 가 위 끝이고 높이를 고정하지 않는다', () => {
    expect(sheetFrame('fit', 800, 0)).toEqual({maxHeight: 680});
  });
  it('중간 단은 화면의 9/16 고정 높이', () => {
    expect(sheetFrame('medium', 800, 0)).toEqual({height: 450});
  });
});

describe('구분선 들여쓰기와 카드 안 위치', () => {
  it('아이콘 칸이 있으면 글자 열(16 + 22 + 16)에서, 없으면 안쪽 여백(16)에서 시작한다', () => {
    expect(dividerIndent('icon')).toBe(54);
    expect(dividerIndent('plain')).toBe(16);
    expect(dividerIndent(32)).toBe(16 + 32 + 16);
  });
  it('줄 하나는 only, 둘 이상이면 first·middle·last', () => {
    expect(cardPosition(0, 1)).toBe('only');
    expect([0, 1, 2].map(i => cardPosition(i, 3))).toEqual(['first', 'middle', 'last']);
  });
});

// ---------------------------------------------------------------------------
// 떠 있는 원형 X — 토큰 근거 (다크에서도)
// ---------------------------------------------------------------------------

describe('원형 X 가 떠 보이는 근거는 토큰이다', () => {
  it('모든 테마에서 다크의 원이 라이트의 원보다 바탕(시트·바닥)에서 덜 구분되지 않는다', () => {
    const weakest: string[] = [];
    for (const theme of THEME_IDS) {
      const light = paletteFrom(theme, 'light');
      const dark = paletteFrom(theme, 'dark');
      for (const host of ['sheet', 'bg'] as const) {
        const lightStep = contrast(circleLook(light).fill, light[host]);
        const darkStep = contrast(circleLook(dark).fill, dark[host]);
        // 라이트도 원이 바탕보다 밝아야 한다(채움이 바탕과 같으면 그림자만 남는다).
        expect([theme, host, lightStep > 1]).toEqual([theme, host, true]);
        if (darkStep < lightStep) weakest.push(`${theme}/${host}: 다크 ${darkStep.toFixed(3)} < 라이트 ${lightStep.toFixed(3)}`);
      }
    }
    expect(weakest).toEqual([]);
  });

  it('다크는 그림자가 안 보이므로 가장자리 한 줄이 서고, 라이트에는 없다', () => {
    for (const theme of THEME_IDS) {
      expect(circleLook(paletteFrom(theme, 'dark')).ring).toBe(paletteFrom(theme, 'dark').glassLine);
      expect(circleLook(paletteFrom(theme, 'light')).ring).toBe('transparent');
      expect(cardRing(paletteFrom(theme, 'dark'))).toBe(paletteFrom(theme, 'dark').border);
      expect(cardRing(paletteFrom(theme, 'light'))).toBe('transparent');
    }
  });

  it('X 글리프가 원 위에서 읽힌다 — 두 모드·세 테마 전부 4.5 이상', () => {
    for (const theme of THEME_IDS) {
      for (const mode of ['light', 'dark'] as const) {
        const p = paletteFrom(theme, mode);
        expect([theme, mode, contrast(p.text, circleLook(p).fill) >= 4.5]).toEqual([theme, mode, true]);
      }
    }
  });

  it.each(['light', 'dark'] as const)('렌더된 원은 그 규칙을 그대로 입는다 (%s)', async scheme => {
    await mount(<Sheet onClose={() => {}} />, true, scheme);
    const palette = paletteFor(scheme);
    const circle = flat('close');
    expect(circle.backgroundColor).toBe(circleLook(palette).fill);
    expect(circle.boxShadow).toBe(palette.elevationRest);
    expect(circle.borderColor).toBe(circleLook(palette).ring);
    expect(circle.width).toBe(SHEET.circle);
  });
});

// ---------------------------------------------------------------------------
// 닫기: 원형 X · 스크림 · VoiceOver · 동작 줄이기
// ---------------------------------------------------------------------------

describe('원형 X', () => {
  it('보조기술 이름은 넘긴 「… 닫기」 문장이고, 머리에 글자 「닫기」는 없다', async () => {
    await mount(<Sheet onClose={() => {}} />, true);
    expect(screen.getByLabelText('시험 시트 닫기')).toBeTruthy();
    expect(screen.queryByText('닫기')).toBeNull();
  });

  it('동작 줄이기를 켜면 누른 즉시 닫힌다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    fireEvent.press(screen.getByTestId('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('동작 줄이기가 꺼져 있으면 화면 높이만큼 미끄러져 나간 뒤에 닫힌다', async () => {
    const onClose = jest.fn();
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Sheet onClose={onClose} />, false);
    expect(timing).toHaveBeenCalledTimes(1); // 올라올 때
    fireEvent.press(screen.getByTestId('close'));
    expect(timing).toHaveBeenCalledTimes(2); // 내려갈 때
    expect(timing.mock.calls[1][1]).toMatchObject({toValue: WINDOW_HEIGHT});
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {timeout: 8000});
  }, 15000);

  it('동작 줄이기를 켜면 미끄러지지 않는다 — 올라올 때도 내려갈 때도 시간 애니메이션이 없다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Sheet onClose={() => {}} />, true);
    fireEvent.press(screen.getByTestId('close'));
    expect(timing).not.toHaveBeenCalled();
  });

  it('두 번 눌러도 한 번만 닫는다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    fireEvent.press(screen.getByTestId('close'));
    fireEvent.press(screen.getByTestId('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('스크림 · VoiceOver 이스케이프', () => {
  it('배경(스크림)을 누르면 닫힌다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    fireEvent.press(screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('스크림의 이름·testID 는 시트가 넘긴 것을 따른다(옛 시트의 이름을 이어받는다)', async () => {
    await mount(
      <PageSheet
        onClose={() => {}}
        accessibilityLabel="시험 시트"
        scrimLabel="대화 액션 닫기"
        scrimTestID="channel-sheet-backdrop">
        <View />
      </PageSheet>,
      true,
    );
    const scrim = screen.getByTestId('channel-sheet-backdrop', {includeHiddenElements: true});
    expect(scrim.props.accessibilityLabel).toBe('대화 액션 닫기');
  });

  it('두 손가락 문지르기(escape)가 시트를 닫는다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    act(() => {
      screen.getByTestId('page-sheet').props.onAccessibilityEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('시트는 모달 경계다 — 뒤의 화면을 보조기술이 읽지 않는다', async () => {
    await mount(<Sheet onClose={() => {}} />, true);
    const sheet = screen.getByTestId('page-sheet');
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(sheet.props.accessibilityLabel).toBe('시험 시트');
  });
});

// ---------------------------------------------------------------------------
// 끌어내리기 — 실제 응답자 이벤트로
// ---------------------------------------------------------------------------

type Handlers = Record<string, (event: unknown) => unknown>;

function touch(y: number, at: number, previousY: number = y) {
  return {
    nativeEvent: {touches: [{}], changedTouches: [{}], timestamp: at},
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          startPageX: 0,
          startPageY: 0,
          startTimeStamp: 0,
          currentPageX: 0,
          currentPageY: y,
          currentTimeStamp: at,
          previousPageX: 0,
          previousPageY: previousY,
          previousTimeStamp: at - 16,
        },
      ],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: at,
    },
  };
}

/** 손잡이를 잡고 `steps`(y, 시각) 를 따라 끌었다가 놓는다. 첫 이동이 잡는 문턱(6pt)을 넘는다. */
function dragHandle(steps: Array<[number, number]>) {
  const handlers = screen.getByTestId('page-sheet-handle').props as Handlers;
  act(() => {
    handlers.onStartShouldSetResponderCapture(touch(0, 1));
    const [firstY, firstAt] = steps[0];
    const e = touch(firstY, firstAt, 0);
    handlers.onMoveShouldSetResponderCapture(e);
    expect(handlers.onMoveShouldSetResponder(e)).toBe(true);
    handlers.onResponderGrant(e);
    let previous = firstY;
    for (const [y, at] of steps.slice(1)) {
      handlers.onResponderMove(touch(y, at, previous));
      previous = y;
    }
    const [lastY, lastAt] = steps[steps.length - 1];
    handlers.onResponderRelease(touch(lastY, lastAt + 1, lastY));
  });
}

describe('끌어내려 닫기', () => {
  it('손잡이 띠를 천천히 멀리 끌면 거리 문턱(시트 높이의 25%)을 넘어 닫힌다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, false);
    // 큰 단의 높이는 화면 − 58, 문턱은 그 25%. 느리게(500ms 간격) 끌어 속도 문턱은 넘지 않는다.
    dragHandle([[20, 100], [120, 600], [220, 1100], [360, 1600]]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {timeout: 8000});
  }, 15000);

  it('짧게 휙 튕겨도 속도 문턱을 넘어 닫힌다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, false);
    // 92pt 만 끌었지만 마지막 64ms 동안 1.4px/ms 로 내렸다(100ms 창의 표본 다섯).
    dragHandle([[20, 100], [40, 116], [62, 132], [86, 148], [112, 164]]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {timeout: 8000});
  }, 15000);

  it('모자라게 끌다 놓으면 닫히지 않고 제자리로 돌아온다', async () => {
    const onClose = jest.fn();
    const spring = jest.spyOn(Animated, 'spring');
    await mount(<Sheet onClose={onClose} />, false);
    dragHandle([[20, 100], [50, 400], [80, 800]]);
    expect(spring).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('세로보다 가로로 먼저 움직이면 시트가 잡지 않는다', async () => {
    await mount(<Sheet onClose={() => {}} />, false);
    const handlers = screen.getByTestId('page-sheet-handle').props as Handlers;
    const sideways = touch(0, 50, 0);
    sideways.touchHistory.touchBank[0].currentPageX = 40;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1));
      handlers.onMoveShouldSetResponderCapture(sideways);
    });
    expect(handlers.onMoveShouldSetResponder(sideways)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 높이 단계가 실제 상자에 닿는다
// ---------------------------------------------------------------------------

describe('높이 단계의 배선', () => {
  it('큰 단(기본): 위 58, 반경 30, 높이 고정 없음', async () => {
    await mount(<Sheet onClose={() => {}} />, true);
    const sheet = flat('page-sheet');
    expect(sheet.top).toBe(SHEET_TOP);
    expect(sheet.maxHeight).toBeUndefined();
    expect(sheet.borderTopLeftRadius).toBe(ds2Radius.sheet);
  });

  it('내용 맞춤: 위 끝이 없고 화면의 85% 안에서 스크롤한다', async () => {
    await mount(<Sheet onClose={() => {}} height="fit" />, true);
    const sheet = flat('page-sheet');
    expect(sheet.top).toBeUndefined();
    expect(sheet.maxHeight).toBe(Math.floor(WINDOW_HEIGHT * 0.85));
    expect(sheet.bottom).toBe(0);
  });

  it('중간: 화면의 9/16 고정 높이', async () => {
    await mount(<Sheet onClose={() => {}} height="medium" />, true);
    expect(flat('page-sheet').height).toBe(Math.floor(WINDOW_HEIGHT * (9 / 16)));
  });
});

// ---------------------------------------------------------------------------
// 머리: ✓ 와 페이지 머리
// ---------------------------------------------------------------------------

describe('확정 ✓', () => {
  it('입력 전(비활성)에는 회색이고 눌러도 아무 일이 없다', async () => {
    const onPress = jest.fn();
    await mount(
      <PageSheet onClose={() => {}} accessibilityLabel="편집">
        <SheetHeader
          title="편집"
          closeLabel="편집 닫기"
          confirm={{label: '저장', onPress, disabled: true, testID: 'confirm'}}
        />
      </PageSheet>,
      true,
    );
    const check = screen.getByTestId('confirm');
    expect(check.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(check);
    expect(onPress).not.toHaveBeenCalled();
    const glyph = StyleSheet.flatten(screen.getByTestId('confirm').findByType('Image' as never).props.style);
    expect(glyph.tintColor).toBe(paletteFor('light').textFaint);
  });

  it('입력이 생기면(활성) 잉크색이고 누르면 확정한다', async () => {
    const onPress = jest.fn();
    await mount(
      <PageSheet onClose={() => {}} accessibilityLabel="편집">
        <SheetHeader
          title="편집"
          closeLabel="편집 닫기"
          confirm={{label: '저장', onPress, testID: 'confirm'}}
        />
      </PageSheet>,
      true,
    );
    fireEvent.press(screen.getByTestId('confirm'));
    expect(onPress).toHaveBeenCalledTimes(1);
    const glyph = StyleSheet.flatten(screen.getByTestId('confirm').findByType('Image' as never).props.style);
    expect(glyph.tintColor).toBe(paletteFor('light').text);
  });

  it('✓ 가 없는 시트는 왼쪽 칸이 비어도 제목이 가운데에 선다(양쪽 칸 폭이 같다)', async () => {
    await mount(<Sheet onClose={() => {}} />, true);
    const header = screen.getByText('시험 시트');
    expect(StyleSheet.flatten(header.props.style).textAlign).toBe('center');
  });
});

/** 머리의 세 칸([왼쪽, 제목, 오른쪽]). 칸이 셋이 아니면 제목이 가운데에 서지 않는다. */
function slotsOf(headerTestID: string): unknown[] {
  const slots = (screen.getByTestId(headerTestID).children as unknown[]).filter(
    child => typeof child !== 'string',
  );
  expect(slots).toHaveLength(3);
  return slots;
}

/** 칸 안에 그려진 단추와 글자의 수 — 비어 있는 칸은 둘 다 0이다. */
function contentOf(slot: unknown): {buttons: number; texts: number} {
  const inside = within(slot as never);
  return {buttons: inside.queryAllByRole('button').length, texts: inside.queryAllByText(/./).length};
}
const EMPTY_SLOT = {buttons: 0, texts: 0};

/** 머리의 세 칸 중 `testID` 의 단추가 어느 칸에 있는가. */
function slotOf(headerTestID: string, buttonTestID: string): number {
  return slotsOf(headerTestID).findIndex(
    slot => within(slot as never).queryByTestId(buttonTestID) !== null,
  );
}

describe('머리의 좌우 — 닫기 X 는 시트든 페이지든 오른쪽, ‹ 는 왼쪽 (#4691)', () => {
  it('바텀시트: 원형 X 는 오른쪽 칸, ✓ 는 왼쪽 칸이다', async () => {
    await mount(
      <PageSheet onClose={() => {}} accessibilityLabel="편집">
        <SheetHeader
          title="편집"
          closeLabel="편집 닫기"
          closeTestID="close"
          confirm={{label: '저장', onPress: () => {}, testID: 'confirm'}}
          testID="header"
        />
      </PageSheet>,
      true,
    );
    expect(slotOf('header', 'close')).toBe(2);
    expect(slotOf('header', 'confirm')).toBe(0);
  });

  it('페이지(X 머리): 원형 X 는 시트와 같은 오른쪽 칸이고, 왼쪽 칸은 비어 있다', async () => {
    await mount(
      <PageHeader
        title="설정"
        closeLabel="설정 닫기"
        onClose={() => {}}
        closeTestID="close"
        testID="header"
      />,
    );
    expect(slotOf('header', 'close')).toBe(2);
    // 왼쪽 칸에는 아무것도 서지 않는다 — 닫는 문이 둘이 되거나 다른 단추가 X 의 자리를 나누지 않는다.
    expect(contentOf(slotsOf('header')[0])).toEqual(EMPTY_SLOT);
    expect(screen.getAllByLabelText(/닫기/)).toHaveLength(1);
  });

  it('trailing 은 ‹ 머리의 오른쪽 칸에 선다 — X 머리에는 줄 수 없고, 줘도(타입을 어겨도) 그려지지 않는다', async () => {
    await mount(
      <>
        <PageHeader
          title="테마"
          back={{label: '설정으로 돌아가기', onPress: () => {}, testID: 'back'}}
          trailing={<Text testID="action-back">편집</Text>}
          testID="header-back"
        />
        {/* @ts-expect-error — X 의 칸(오른쪽)은 X 의 것이다: `trailing` 은 ‹ 머리에만 있다(타입이 막는다). */}
        <PageHeader
          title="설정"
          closeLabel="설정 닫기"
          onClose={() => {}}
          closeTestID="close"
          trailing={<Text testID="action-close">편집</Text>}
          testID="header-close"
        />
      </>,
    );
    expect(slotOf('header-back', 'action-back')).toBe(2);
    expect(slotOf('header-back', 'back')).toBe(0);
    // X 머리: X 가 오른쪽 칸을 지키고, 어긴 `trailing` 은 어느 칸에도 그려지지 않는다.
    expect(slotOf('header-close', 'close')).toBe(2);
    expect(screen.queryByTestId('action-close')).toBeNull();
  });
});

describe('페이지 머리 — ‹ 뒤로 변형 (#4457)', () => {
  const glyphsOf = (testID: string) =>
    within(screen.getByTestId(testID)).UNSAFE_getAllByType(Image).map(image => ({
      source: image.props.source,
      size: StyleSheet.flatten(image.props.style).width,
    }));

  it('‹ 는 왼쪽 칸에 서고(오른쪽 칸은 비어 있다) 누르면 back.onPress, 이름은 돌아갈 곳이며 X 는 없다', async () => {
    const onPress = jest.fn();
    await mount(
      <PageHeader
        title="테마"
        back={{label: '설정으로 돌아가기', onPress, testID: 'back'}}
        testID="header"
      />,
    );
    expect(slotOf('header', 'back')).toBe(0);
    expect(contentOf(slotsOf('header')[2])).toEqual(EMPTY_SLOT);
    fireEvent.press(screen.getByLabelText('설정으로 돌아가기'));
    expect(onPress).toHaveBeenCalledTimes(1);
    // 글리프는 22pt ‹ 하나 — X 가 아니다.
    expect(glyphsOf('back')).toEqual([{source: CONV_ICONS.left, size: CONV_ICON_SIZE.left}]);
    expect(CONV_ICON_SIZE.left).toBe(SHEET_ICON_SIZE.close); // 같은 22 칸이라 원 안에서 같은 무게로 읽힌다
    expect(screen.queryByLabelText(/닫기/)).toBeNull();
  });

  it('X 변형은 그대로 X 글리프다 — 두 변형이 서로를 바꾸지 않는다', async () => {
    await mount(
      <PageHeader title="설정" closeLabel="설정 닫기" onClose={() => {}} closeTestID="close" testID="header" />,
    );
    expect(glyphsOf('close')).toEqual([{source: SHEET_ICONS.close, size: SHEET_ICON_SIZE.close}]);
  });

  it.each(['light', 'dark'] as const)('‹ 의 원은 X 의 원과 같은 상자(크기·채움·그림자·가장자리)를 입는다 (%s)', async scheme => {
    await mount(
      <>
        <PageHeader title="설정" closeLabel="설정 닫기" onClose={() => {}} closeTestID="close" />
        <PageHeader title="테마" back={{label: '설정으로 돌아가기', onPress: () => {}, testID: 'back'}} />
      </>,
      true,
      scheme,
    );
    const BOX = ['width', 'height', 'borderRadius', 'backgroundColor', 'borderColor', 'borderWidth', 'boxShadow'] as const;
    const pick = (testID: string) => {
      const style = flat(testID);
      return Object.fromEntries(BOX.map(key => [key, style[key]]));
    };
    // 기준이 비어 있지 않다 — 둘 다 undefined 여서 맞는 헛단정을 막는다.
    expect(pick('close')).toMatchObject({width: SHEET.circle, height: SHEET.circle, backgroundColor: circleLook(paletteFor(scheme)).fill});
    expect(pick('back')).toEqual(pick('close'));
  });
});

describe('페이지 머리', () => {
  it('원형 X 를 누르면 onClose, 이름은 넘긴 문장이다', async () => {
    const onClose = jest.fn();
    await mount(<PageHeader title="설정" closeLabel="설정 닫기" onClose={onClose} closeTestID="page-close" />);
    fireEvent.press(screen.getByLabelText('설정 닫기'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('설정')).toBeTruthy();
    expect(screen.queryByText('닫기')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 안쪽 부품
// ---------------------------------------------------------------------------

describe('묶음 카드', () => {
  it('행 사이에만 구분선이 서고(n-1), 없는 자식은 선도 없다', async () => {
    await mount(
      <GroupCard label="묶음">
        <ListRow title="하나" />
        {null}
        <ListRow title="둘" />
        <ListRow title="셋" />
      </GroupCard>,
    );
    expect(screen.getAllByTestId('group-divider')).toHaveLength(2);
    expect(screen.getByText('묶음')).toBeTruthy();
  });

  it('줄이 하나면 구분선이 없다', async () => {
    await mount(
      <GroupCard>
        <ListRow title="혼자" />
      </GroupCard>,
    );
    expect(screen.queryAllByTestId('group-divider')).toHaveLength(0);
  });

  it('구분선의 들여쓰기는 앞 아이콘 칸 유무를 따른다', async () => {
    await mount(
      <GroupCard inset="icon">
        <ListRow title="하나" leading={<RowEmoji emoji="🚌" />} />
        <ListRow title="둘" leading={<RowEmoji emoji="🏠" />} />
      </GroupCard>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('group-divider').props.style).marginLeft).toBe(54);
  });

  it('카드는 둥근 카드 반경이고 시트 바탕이 아니라 surface 위에 선다', async () => {
    await mount(
      <GroupCard testID="card">
        <ListRow title="하나" />
      </GroupCard>,
    );
    const card = flat('card-card');
    expect(card.borderRadius).toBe(ds2Radius.card);
    expect(card.backgroundColor).toBe(paletteFor('light').surface);
  });
});

describe('목록 한 줄(가상화 목록용)', () => {
  it('첫 줄은 위 모서리, 끝 줄은 아래 모서리만 둥글고 첫 줄 밖에는 구분선이 선다', async () => {
    await mount(
      <View>
        {['a', 'b', 'c'].map((key, index) => (
          <GroupCardItem key={key} index={index} count={3} testID={`item-${key}`}>
            <Text>{key}</Text>
          </GroupCardItem>
        ))}
      </View>,
    );
    expect(flat('item-a').borderTopLeftRadius).toBe(ds2Radius.card);
    expect(flat('item-a').borderBottomLeftRadius).toBeUndefined();
    expect(flat('item-b').borderTopLeftRadius).toBeUndefined();
    expect(flat('item-b').borderBottomLeftRadius).toBeUndefined();
    expect(flat('item-c').borderBottomLeftRadius).toBe(ds2Radius.card);
    expect(screen.getAllByTestId('group-divider')).toHaveLength(2);
  });
});

describe('행', () => {
  it('값과 셰브론을 오른쪽에 보이고, 누르면 onPress', async () => {
    const onPress = jest.fn();
    await mount(<ListRow title="표시 이름" value="김달무리" accessory="chevron" onPress={onPress} testID="row" />);
    expect(screen.getByText('김달무리')).toBeTruthy();
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('보조 줄은 이름 아래에 선다', async () => {
    await mount(<ListRow title="복구 코드 보내기" detail="데스크탑이 보여 주는 코드를 읽어요" />);
    expect(screen.getByText('데스크탑이 보여 주는 코드를 읽어요')).toBeTruthy();
  });

  it('위험 행은 글자가 위험색이다', async () => {
    await mount(<ListRow title="나가기" tone="danger" onPress={() => {}} />);
    expect(StyleSheet.flatten(screen.getByText('나가기').props.style).color).toBe(
      paletteFor('light').danger,
    );
  });

  it('토글 행: 행 전체가 스위치이고 누르면 반대 값을 알린다', async () => {
    const onValueChange = jest.fn();
    await mount(
      <ListRow title="알림" accessory="toggle" toggle={{value: true, onValueChange}} testID="toggle-row" />,
    );
    const row = screen.getByTestId('toggle-row');
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState.checked).toBe(true);
    fireEvent.press(row);
    expect(onValueChange).toHaveBeenCalledWith(false);
  });

  it('비활성 행은 눌러도 아무 일이 없다', async () => {
    const onPress = jest.fn();
    await mount(<ListRow title="복사" accessory="copy" disabled onPress={onPress} testID="row" />);
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('row').props.accessibilityState.disabled).toBe(true);
  });

  it('앞 칸 폭을 주면 그 폭을 차지한다(아바타 행)', async () => {
    await mount(
      <ListRow title="이도현" leading={<View />} leadingWidth={32} testID="row" />,
    );
    expect(flat('row-lead').width).toBe(32);
  });
});

describe('행 — 값은 큰 글씨에서 제목 아래로 내려온다 (#4457)', () => {
  /** `useWindowDimensions` 가 읽는 창의 글자 배율만 바꾼다. */
  function setFontScale(fontScale: number) {
    const real = Dimensions.get('window');
    jest.spyOn(Dimensions, 'get').mockImplementation(() => ({...real, fontScale}) as never);
  }

  it('기본 글씨: 값은 오른쪽에 서고 50% 상한이 있으며 두 줄까지 쓴다(긴 값이 한 줄에서 잘리지 않게)', async () => {
    setFontScale(1);
    await mount(<ListRow title="상태 설정" value="없음" accessory="chevron" onPress={() => {}} testID="row" />);
    const value = screen.getByTestId('row-value');
    expect(StyleSheet.flatten(value.props.style)).toMatchObject({maxWidth: '50%', textAlign: 'right'});
    // 한 줄이면 「지금대로 · 10월 27일 16:11까지」 같은 값이 말줄임으로 잘린다(design-review #4457 r1 M5).
    expect(value.props.numberOfLines).toBe(2);
  });

  it('접근성 글씨(STACK_PILL_SCALE 부터): 값이 제목 아래로 내려와 상한도 말줄임도 없다', async () => {
    setFontScale(STACK_PILL_SCALE);
    await mount(<ListRow title="상태 설정" value="지우지 않음" accessory="chevron" onPress={() => {}} testID="row" />);
    const value = screen.getByTestId('row-value');
    const style = StyleSheet.flatten(value.props.style);
    expect(style.maxWidth).toBeUndefined();
    expect(style.textAlign).not.toBe('right');
    expect(value.props.numberOfLines).toBeUndefined(); // 말줄임 없이 값 전체를 읽는다(「지우…」가 아니다)
    expect(style.color).toBe(paletteFor('light').textMuted);
  });

  it('한국어 줄바꿈은 어절 단위다 — 제목과 값(오른쪽에 선 것도 쌓인 것도)이 모두 hangul-word (design-review #4457 r2 H1)', async () => {
    // 두 줄을 허용한 값이 이 규칙 없이 「온보/딩」 처럼 어절 가운데서 끊겼다. 줄 수만 재면 이 결함이 지나간다.
    for (const fontScale of [1, STACK_PILL_SCALE]) {
      setFontScale(fontScale);
      const view = await mount(
        <ListRow title="상태 설정" value="달무리 스튜디오 온보딩 자료" accessory="chevron" onPress={() => {}} testID="row" />,
      );
      expect(screen.getByTestId('row-value').props.lineBreakStrategyIOS).toBe('hangul-word');
      expect(screen.getByText('상태 설정').props.lineBreakStrategyIOS).toBe('hangul-word');
      view.unmount();
    }
  });

  it('경계: 문턱 바로 아래(1.49)는 아직 오른쪽, 문턱(1.5)부터 내려온다', async () => {
    setFontScale(STACK_PILL_SCALE - 0.01);
    const {unmount} = await mount(<ListRow title="a" value="b" testID="row" />);
    expect(screen.getByTestId('row-value').props.numberOfLines).toBe(2); // 오른쪽에 선 값
    unmount();
    setFontScale(STACK_PILL_SCALE);
    await mount(<ListRow title="a" value="b" testID="row" />);
    expect(screen.getByTestId('row-value').props.numberOfLines).toBeUndefined();
  });

  it('읽히는 이름은 어느 배치에서도 제목·값을 이은 한 문장이다', async () => {
    setFontScale(3.1);
    await mount(<ListRow title="상태 설정" value="없음" onPress={() => {}} testID="row" />);
    expect(screen.getByTestId('row').props.accessibilityLabel).toBe('상태 설정, 없음');
  });

  it('값이 없는 행은 글씨 크기와 상관없이 그대로다', async () => {
    setFontScale(3.1);
    await mount(<ListRow title="로그아웃" tone="danger" onPress={() => {}} testID="row" />);
    expect(screen.queryByTestId('row-value')).toBeNull();
  });
});

describe('행 — 제자리 펼침(expanded) (#4457 r1 M4)', () => {
  const glyphOf = () => screen.getByTestId('row-expand', {includeHiddenElements: true});
  const rotate = () => StyleSheet.flatten(glyphOf().props.style).transform;

  it('펼침 행은 보조기술에 펼침 상태를 말하고, 접힌 ⌄ 와 펼친 ⌃ 가 눈에도 갈린다', async () => {
    const collapsed = await mount(
      <ListRow title="만료" value="지우지 않음" accessory="expand" expanded={false} onPress={() => {}} testID="row" />,
    );
    expect(screen.getByTestId('row').props.accessibilityState).toMatchObject({expanded: false});
    expect(rotate()).toBeUndefined(); // ⌄ 그대로
    collapsed.unmount();
    await mount(
      <ListRow title="만료" value="지우지 않음" accessory="expand" expanded onPress={() => {}} testID="row" />,
    );
    expect(screen.getByTestId('row').props.accessibilityState).toMatchObject({expanded: true});
    expect(rotate()).toEqual([{rotate: '180deg'}]); // 뒤집혀 ⌃
  });

  it('expanded 를 안 준 행은 펼침 상태를 말하지 않는다 — 펼침이 아닌 행에 expanded 가 섞이지 않는다', async () => {
    // Pressable 은 상태를 모든 키가 있는 객체로 정규화한다 — 「값이 있는 키」로 잰다.
    const given = () =>
      Object.entries(screen.getByTestId('row').props.accessibilityState ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
    const expand = await mount(<ListRow title="복사" accessory="expand" onPress={() => {}} testID="row" />);
    expect(given()).not.toContain('expanded');
    expect(rotate()).toBeUndefined();
    expand.unmount();
    const chevron = await mount(<ListRow title="테마" accessory="chevron" onPress={() => {}} testID="row" />);
    expect(given()).not.toContain('expanded');
    chevron.unmount();
    // 대조군: 주면(`false` 여도) 들어간다 — 위 「없다」가 상태를 아예 못 읽어서 참인 것이 아니다.
    await mount(<ListRow title="접힘" accessory="expand" expanded={false} onPress={() => {}} testID="row" />);
    expect(given()).toContain('expanded');
  });

  it('펼침 글리프는 expand 액세서리에만 선다 — 셰브론 행에는 ⌄ 가 없다', async () => {
    await mount(<ListRow title="테마" accessory="chevron" expanded onPress={() => {}} testID="row" />);
    expect(screen.queryByTestId('row-expand', {includeHiddenElements: true})).toBeNull();
  });
});

describe('입력 알약', () => {
  it('알약 반경 + 입력 그릇의 3:1 외곽선(textFaint)이고 이름은 필수다', async () => {
    const onChangeText = jest.fn();
    await mount(
      <InputPill
        accessibilityLabel="상태 입력"
        placeholder="상태를 적어요"
        onChangeText={onChangeText}
        testID="pill-input"
      />,
    );
    fireEvent.changeText(screen.getByLabelText('상태 입력'), '회의 중');
    expect(onChangeText).toHaveBeenCalledWith('회의 중');
    const pill = flat('pill-input-pill');
    expect(pill.borderRadius).toBe(radius.pill);
    expect(pill.borderColor).toBe(paletteFor('light').textFaint);
    expect(screen.getByTestId('pill-input').props.placeholderTextColor).toBe(
      paletteFor('light').textMuted,
    );
  });
});

describe('큰 행동 타일', () => {
  it('눌리고, 비활성이면 누를 수 없다', async () => {
    const onPress = jest.fn();
    await mount(
      <ActionTileRow>
        <ActionTile icon={null} label="메시지" onPress={onPress} testID="tile" />
        <ActionTile icon={null} label="복사" onPress={onPress} disabled testID="tile-off" />
      </ActionTileRow>,
    );
    fireEvent.press(screen.getByTestId('tile'));
    fireEvent.press(screen.getByTestId('tile-off'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tile-off').props.accessibilityState.disabled).toBe(true);
  });

  it('두 타일이 같은 폭으로 나란히 선다(flex 1)', async () => {
    await mount(
      <ActionTileRow>
        <ActionTile icon={null} label="하나" onPress={() => {}} testID="a" />
        <ActionTile icon={null} label="둘" onPress={() => {}} testID="b" />
      </ActionTileRow>,
    );
    for (const id of ['a', 'b']) {
      expect(flat(id).flex).toBe(1);
      expect(flat(id).minHeight).toBe(SHEET.tileMinHeight);
    }
  });
});

describe('시트 몸의 스크롤', () => {
  const padding = () =>
    StyleSheet.flatten(screen.getByTestId('scroll').props.contentContainerStyle).paddingBottom;
  const scroll = (
    <SheetScroll testID="scroll">
      <Text>내용</Text>
    </SheetScroll>
  );

  it('홈 인디케이터(안전 영역) 아래까지 여백을 준다', async () => {
    useInsets(34);
    await mount(scroll);
    expect(padding()).toBe(34 + space.lg);
  });

  it('안전 영역이 없는 기기에서도 바닥 여백이 남는다', async () => {
    useInsets(0);
    await mount(scroll);
    expect(padding()).toBe(space.lg + space.lg);
  });

  it('입력에서 탭이 키보드를 접지 않고, 스크롤 안의 내용은 큰 글씨에서도 끝까지 닿는다', async () => {
    await mount(scroll);
    expect(screen.getByTestId('scroll').props.keyboardShouldPersistTaps).toBe('handled');
    expect(screen.getByTestId('scroll').props.showsVerticalScrollIndicator).toBe(true);
  });
});
