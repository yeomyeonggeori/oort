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

/**
 * 응답자 핸들러(`handlers`)를 **응답자 시스템과 같은 순서**로 불러 `steps`(y, 시각)를 따라 끌었다가 놓는다(`ResponderEventPlugin`):
 * 터치가 시작될 때 캡처 → 버블 순으로 응답자를 묻고(시작 응답자 — RN `Modal` 이 시작 응답자를 쥐므로 눌리지 않는 자리의 터치는 시트가
 * 여기서 잡아야 닿는다), 쥐지 못했으면 이동마다 캡처 → 버블로 가로채기를 묻는다. 어느 쪽으로도 쥐지 못하면 거기서 멈추고 `false` 를
 * 돌려준다(그 터치는 시트에 닿지 않는다). 터치는 y=0 에서 시작하고 첫 걸음이 그 위치로 움직인 것이다.
 */
function dragWith(handlers: Handlers, steps: Array<[number, number]>): boolean {
  let granted = false;
  act(() => {
    const down = touch(0, 1);
    handlers.onStartShouldSetResponderCapture?.(down);
    granted = Boolean(handlers.onStartShouldSetResponder?.(down));
    if (granted) handlers.onResponderGrant(down);
    let previous = 0;
    for (const [y, at] of steps) {
      const move = touch(y, at, previous);
      previous = y;
      if (granted) {
        handlers.onResponderMove(move);
        continue;
      }
      granted = Boolean(handlers.onMoveShouldSetResponderCapture(move)) || Boolean(handlers.onMoveShouldSetResponder?.(move));
      if (granted) handlers.onResponderGrant(move);
    }
    if (!granted) return;
    const [lastY, lastAt] = steps[steps.length - 1];
    handlers.onResponderRelease(touch(lastY, lastAt + 1, lastY));
  });
  return granted;
}

/** 손잡이 띠를 잡고 `steps`(y, 시각)를 따라 끌었다가 놓는다 — 실제 응답자 이벤트로. */
export function dragHandle(steps: Array<[number, number]>): void {
  const handlers = screen.getByTestId('page-sheet-handle').props as Handlers;
  expect(dragWith(handlers, steps)).toBe(true);
}

/**
 * 머리의 제목 줄을 잡고 끈다(#4612). 머리 뿌리는 시트마다 testID 가 다르므로 **시트 안**의 제목(`accessibilityRole="header"` 의
 * 첫 요소)에서 위로 올라가 끌기 핸들러를 든 첫 조상을 쓴다 — `SheetHeader` 가 뿌리에 펼친 것이다. 시트 밖(뒤의 화면)에도
 * `header` 역할이 있으므로 범위를 시트로 좁힌다.
 */
export function dragHeader(steps: Array<[number, number]>): boolean {
  interface Instance {
    props: Handlers;
    parent: Instance | null;
  }
  let node = within(screen.getByTestId('page-sheet')).getAllByRole('header')[0] as unknown as Instance | null;
  while (node && typeof node.props.onMoveShouldSetResponderCapture !== 'function') {
    node = node.parent;
  }
  if (!node) return false;
  return dragWith(node.props, steps);
}

/** 본문(`page-sheet-body`)을 잡고 끈다(#4612). 스크롤이 맨 위일 때만 시트가 가져간다 — 가져가지 않으면 `false`. */
export function dragBody(steps: Array<[number, number]>): boolean {
  return dragWith(screen.getByTestId('page-sheet-body').props as Handlers, steps);
}

/**
 * 놓았을 때 **어느 시트라도** 닫히는 느리고 먼 끌기. 거리 문턱은 시트 높이의 25% 이고(`sheetModel`) Jest 는 레이아웃을 재지 않아 높이를
 * 상자에서 어림한다 — 큰 단 1276(문턱 319)·내용 맞춤 상한 1133(283)·중간 750(187). 400pt 는 셋 모두 넘고, 500ms 간격이라 속도는 0 이다.
 */
export const FAR_SLOW_DRAG: Array<[number, number]> = [[20, 100], [170, 600], [270, 1100], [420, 1600]];

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
 * 같은 계약 여덟 시험을 등록한다.
 *
 *   1. 머리 X: 이름이 「… 닫기」, 글리프가 공용 X(`SHEET_ICONS.close`), 글자 「닫기」가 시트 트리에 없고, 손잡이 띠가 선다.
 *   2. 동작 줄이기가 켜져 있으면 X 가 즉시 한 번 닫는다.
 *   3. 꺼져 있으면 화면 높이만큼 미끄러진 **뒤** 한 번 닫는다 — 누른 순간에는 부르지 않는다.
 *   4. 스크림이 닫고, 이름·testID 가 옛 시트의 것을 이어받았다.
 *   5. VoiceOver 두 손가락 문지르기(escape)가 닫는다.
 *   6. 손잡이 띠를 끌어내리면(거리 문턱) 닫는다.
 *   7. 머리(제목 줄)를 끌어내려도 닫는다 (#4612).
 *   8. 본문을 스크롤 맨 위에서 끌어내리면 닫는다 — 본문 스크롤이 시트에 등록돼 있다 (#4612).
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
      dragHandle(FAR_SLOW_DRAG);
      expect(spec.closedCount()).toBe(0);
      await waitFor(() => expect(spec.closedCount()).toBe(1), {timeout: 8000});
    }, 20000);

    // #4612: 끌기 영역은 손잡이 띠만이 아니다. 시트마다 머리와 본문이 시트의 끌기 응답자에 이어져 있는지를 같은 코드로 잰다.
    it('머리(제목 줄)를 끌어내려도 닫힌다 — 손잡이 띠만이 아니다', async () => {
      await setReduceMotion(true);
      await spec.open();
      expect(dragHeader(FAR_SLOW_DRAG)).toBe(true);
      expect(spec.closedCount()).toBe(1);
    });

    it('본문은 스크롤이 맨 위일 때 끌어내리면 닫힌다 — 본문의 세로 스크롤이 시트에 자기를 알리고 있다', async () => {
      await setReduceMotion(true);
      await spec.open();
      // 가져가지 못하면(`false`): 이 시트의 본문 스크롤이 시트에 등록되지 않았다 — `SheetScroll` 이나 `usePageSheetScroll()` 이어야 한다.
      expect(dragBody(FAR_SLOW_DRAG)).toBe(true);
      expect(spec.closedCount()).toBe(1);
    });
  });
}
