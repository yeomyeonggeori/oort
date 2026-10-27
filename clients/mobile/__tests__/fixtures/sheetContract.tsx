import {act, fireEvent, screen, waitFor, within} from '@testing-library/react-native';
import {AccessibilityInfo, Animated, Dimensions, Image} from 'react-native';

import {SHEET_ICONS} from '../../src/design/icons';
import {retainReduceMotion} from '../../src/lib/useReduceMotion';

// =============================================================================
// 시트 하나가 **공용 닫는 길 다섯과 머리 X**를 지키는가 — 시트마다 같은 계약을 같은 코드로 잰다 (#4458).
//
// 시트는 이제 모두 `PageSheet` 의 자식이라 닫는 길(X · 스크림 · 끌어내리기 · VoiceOver escape · 행동 누름)이 같은
// 슬라이드를 지난다. 그 배선이 **시트마다** 이어져 있는지(머리에 X 를 달았는가, 스크림 이름·testID 를 이어받았는가, `onClose`
// 를 넘겼는가)는 시트 파일이 정한다 — 그래서 시트마다 이 계약을 돌린다. 부품 자체의 문턱·산수는 `sheetKit.test.tsx` 가 잰다.
//
// `describeCloseContract` 는 `describe` 하나를 등록한다. 시트를 어떻게 마운트하고 「닫혔다」를 어떻게 아는지는 호출한 시험
// 파일의 몫이다(`open`·`closedCount`) — 시트마다 제 provider·가짜 fetch 가 다르기 때문이다.
// =============================================================================

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
const WINDOW_HEIGHT = Dimensions.get('window').height;

let releaseStore: (() => void) | null = null;

/**
 * 시스템의 「동작 줄이기」 답을 정해 두고 저장소를 붙든다. 시트가 **서기 전에** 답을 알아야 첫 렌더가 슬라이드로 올라오지
 * 않는다(앱 뿌리가 시작 때 하는 일 — `App.tsx`).
 */
export async function setReduceMotion(on: boolean): Promise<void> {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(on));
  releaseStore?.();
  releaseStore = retainReduceMotion();
  await act(async () => {});
}

export function releaseReduceMotion(): void {
  releaseStore?.();
  releaseStore = null;
  // RN 의 기본 대역(꺼짐)으로 돌려 둔다 — 같은 파일의 다른 시험이 이 계약의 답을 물려받지 않는다.
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
}

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

/** 손잡이 띠를 잡고 `steps`(y, 시각)를 따라 끌었다가 놓는다 — 실제 응답자 이벤트로. */
export function dragHandle(steps: Array<[number, number]>): void {
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

/**
 * 라디오 행들의 **그려진** 상태. 컴포넌트의 prop(`selected`)이 아니라 보조기술이 읽는 `accessibilityState.selected` 와
 * 눈에 보이는 ✓ 글리프(`Image`)의 수를 읽는다 — 부품이 prop 을 무시해도 붉어지도록.
 */
export function radioRows(
  container: Pick<ReturnType<typeof within>, 'getAllByRole'>,
): Array<{testID: string; selected: boolean; checks: number}> {
  return container.getAllByRole('radio').map(row => ({
    testID: String(row.props.testID),
    selected: row.props.accessibilityState?.selected === true,
    checks: within(row).UNSAFE_queryAllByType(Image).length,
  }));
}

/** 호스트 요소 안의 `Image` 소스들 — 글리프가 정말 그려졌는지 본다. */
export function imageSources(host: Parameters<typeof within>[0]): unknown[] {
  return within(host)
    .UNSAFE_queryAllByType(Image)
    .map(node => node.props.source);
}

export interface CloseContract {
  /** 묶음 이름(시험 제목에 붙는다). */
  name: string;
  /** 시트를 새로 세운다. 동작 줄이기의 답은 이 호출 전에 정해져 있다. */
  open: () => Promise<void> | void;
  /** 시트가 부모에게 「닫아 달라」고 한 횟수(`onClose` 호출 수, 또는 시트가 사라졌으면 1). */
  closedCount: () => number;
  /** 머리의 원형 X. */
  closeTestID: string;
  /** X 의 보조기술 이름 — 「… 닫기」 문장이다. */
  closeLabel: string;
  /** 스크림(배경). */
  scrimTestID: string;
  scrimLabel: string;
}

/**
 * 같은 계약 여섯 시험을 등록한다.
 *
 *   1. 머리 X: 이름이 「… 닫기」, 글리프가 공용 X(`SHEET_ICONS.close`), 글자 「닫기」가 시트 트리에 없고, 손잡이 띠가 선다.
 *   2. 동작 줄이기가 켜져 있으면 X 가 즉시 한 번 닫는다.
 *   3. 꺼져 있으면 화면 높이만큼 미끄러진 **뒤** 한 번 닫는다 — 누른 순간에는 부르지 않는다.
 *   4. 스크림이 닫고, 이름·testID 가 옛 시트의 것을 이어받았다.
 *   5. VoiceOver 두 손가락 문지르기(escape)가 닫는다.
 *   6. 손잡이 띠를 끌어내리면(거리 문턱) 닫는다.
 */
export function describeCloseContract(spec: CloseContract): void {
  describe(`${spec.name} — 닫는 길과 머리의 원형 X (#4458)`, () => {
    afterEach(() => {
      releaseReduceMotion();
    });

    it('머리 X 의 이름은 「… 닫기」이고 글리프는 공용 X 이며, 글자 「닫기」 단추는 없다', async () => {
      await setReduceMotion(true);
      await spec.open();
      const x = screen.getByTestId(spec.closeTestID);
      expect(x.props.accessibilityRole).toBe('button');
      expect(x.props.accessibilityLabel).toBe(spec.closeLabel);
      expect(spec.closeLabel.endsWith(' 닫기')).toBe(true);
      expect(within(x).UNSAFE_getByType(Image).props.source).toBe(SHEET_ICONS.close);
      expect(screen.queryByText('닫기')).toBeNull();
      expect(screen.getByTestId('page-sheet-handle')).toBeTruthy();
    });

    it('동작 줄이기가 켜져 있으면 X 가 누른 즉시 한 번 닫는다', async () => {
      await setReduceMotion(true);
      await spec.open();
      expect(spec.closedCount()).toBe(0);
      fireEvent.press(screen.getByTestId(spec.closeTestID));
      expect(spec.closedCount()).toBe(1);
    });

    it('동작 줄이기가 꺼져 있으면 화면 높이만큼 미끄러져 나간 뒤에 한 번 닫는다', async () => {
      await setReduceMotion(false);
      const timing = jest.spyOn(Animated, 'timing');
      try {
        await spec.open();
        fireEvent.press(screen.getByTestId(spec.closeTestID));
        expect(
          timing.mock.calls.some(([, config]) => (config as {toValue?: number}).toValue === WINDOW_HEIGHT),
        ).toBe(true);
        expect(spec.closedCount()).toBe(0);
        await waitFor(() => expect(spec.closedCount()).toBe(1), {timeout: 8000});
      } finally {
        timing.mockRestore();
      }
    }, 20000);

    it('배경(스크림)을 누르면 닫히고, 스크림의 이름·testID 는 옛 시트의 것을 이어받았다', async () => {
      await setReduceMotion(true);
      await spec.open();
      const scrim = screen.getByTestId(spec.scrimTestID, {includeHiddenElements: true});
      expect(scrim.props.accessibilityLabel).toBe(spec.scrimLabel);
      fireEvent.press(scrim);
      expect(spec.closedCount()).toBe(1);
    });

    it('VoiceOver 두 손가락 문지르기(escape)가 시트를 닫는다', async () => {
      await setReduceMotion(true);
      await spec.open();
      act(() => {
        screen.getByTestId('page-sheet').props.onAccessibilityEscape();
      });
      expect(spec.closedCount()).toBe(1);
    });

    it('손잡이 띠를 천천히 멀리 끌어내리면 거리 문턱을 넘어 닫힌다', async () => {
      await setReduceMotion(false);
      await spec.open();
      dragHandle([[20, 100], [60, 300], [100, 500], [150, 700]]);
      expect(spec.closedCount()).toBe(0);
      await waitFor(() => expect(spec.closedCount()).toBe(1), {timeout: 8000});
    }, 20000);
  });
}
