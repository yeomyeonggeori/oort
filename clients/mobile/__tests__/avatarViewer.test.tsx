import {dismissTemporarySurfaces} from '@momo/core/features/notifications/entryDismiss';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import { Image } from 'react-native';

import { SHEET_ICONS } from '../src/design/icons';
import { TOUCH_TARGET } from '../src/design/tokens';
import { AvatarViewer } from '../src/features/directory/AvatarViewer';
import {
  FAR_SLOW_DRAG,
  releaseReduceMotion,
  setReduceMotion,
} from './fixtures/sheetContract';

// =============================================================================
// 프로필 사진 크게 보기 (#4319). `AttachmentViewer`(#4293)의 형제다 — 같은 얼굴(X · 배경 · 아래로 쓸어 닫기 · VoiceOver escape),
// 공유·위치 글자는 없다. 사진 뷰어의 쓸어 닫기 **규칙**(문턱·방향)은 `viewerDismiss.test.ts` 와 `attachmentViewer.test.tsx` 가 재생한다 —
// 여기서는 이 뷰어가 그 규칙에 옳게 묶여 있는지, 닫는 길 셋(단추·쓸어 내리기·escape)이 모두 `onClose` 에 닿는지를 잰다.
// =============================================================================

const URI = 'file:///cache/oort-member-avatars/0a1b2c.img';
const LABEL = '박서연 프로필 사진';

afterEach(() => {
  cleanup();
  releaseReduceMotion();
  jest.restoreAllMocks();
});

function mount(onClose = jest.fn()) {
  render(<AvatarViewer uri={URI} label={LABEL} onClose={onClose} />);
  return onClose;
}

describe('프로필 사진 뷰어의 모양', () => {
  it('사진 한 장과 닫기 단추뿐이다 — 공유·위치 글자·첨부 뷰어의 testID 는 없다', () => {
    mount();
    const image = screen.getByTestId('avatar-viewer-image');
    expect(image.props.source).toEqual({ uri: URI });
    expect(image.props.resizeMode).toBe('contain');
    expect(image.props.accessibilityLabel).toBe(LABEL);
    expect(screen.queryByTestId('avatar-viewer-share')).toBeNull();
    expect(screen.queryByTestId('avatar-viewer-position')).toBeNull();
    expect(screen.queryByText('공유')).toBeNull();
    // Maestro 105 가 짚는 첨부 뷰어의 이름을 이 뷰어가 가로채지 않는다.
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
    expect(screen.queryByTestId('attachment-viewer-back')).toBeNull();
  });

  it('닫기는 글자가 아니라 시트와 같은 X 글리프이고, 어느 사진을 닫는지 이름이 말하며, 누르는 면은 44pt 이상이다', () => {
    mount();
    const close = screen.getByTestId('avatar-viewer-close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe(`${LABEL} 닫기`);
    expect(within(close).UNSAFE_getByType(Image).props.source).toBe(SHEET_ICONS.close);
    expect(screen.queryByText('닫기')).toBeNull();
    const style = Object.assign(
      {},
      ...([] as unknown[]).concat(close.props.style).filter(Boolean),
    ) as Record<string, number>;
    expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  it('단추 띠는 상태 막대·다이내믹 아일랜드 아래에서 시작한다 — 인셋만큼 내려앉는다', () => {
    const safeArea = require('react-native-safe-area-context');
    jest
      .spyOn(safeArea, 'useSafeAreaInsets')
      .mockReturnValue({ top: 59, bottom: 34, left: 0, right: 0 });
    mount();
    const bar = screen.getByTestId('avatar-viewer-bar');
    const style = Object.assign(
      {},
      ...([] as unknown[]).concat(bar.props.style).filter(Boolean),
    ) as Record<string, number>;
    expect(style.paddingTop).toBe(59);
    const pager = screen.getByTestId('avatar-viewer-pager');
    const pagerStyle = Object.assign(
      {},
      ...([] as unknown[]).concat(pager.props.style).filter(Boolean),
    ) as Record<string, number>;
    expect(pagerStyle.paddingBottom).toBe(34);
  });

  it('동작 줄이기가 꺼져 있으면 시스템 페이드로, 켜져 있으면 바로 선다', async () => {
    await setReduceMotion(false);
    const off = render(<AvatarViewer uri={URI} label={LABEL} onClose={jest.fn()} />);
    expect(screen.getByTestId('avatar-viewer-modal').props.animationType).toBe('fade');
    off.unmount();
    await setReduceMotion(true);
    render(<AvatarViewer uri={URI} label={LABEL} onClose={jest.fn()} />);
    expect(screen.getByTestId('avatar-viewer-modal').props.animationType).toBe('none');
  });
});

describe('프로필 사진 뷰어의 닫는 길 — 단추·쓸어 내리기·escape 가 모두 onClose 다', () => {
  it('X 단추를 누르면 한 번 닫는다', () => {
    const onClose = mount();
    fireEvent.press(screen.getByTestId('avatar-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VoiceOver 두 손가락 문지르기(escape)가 닫는다 — 단추를 못 찾는 사람의 길이다', () => {
    const onClose = mount();
    const root = screen.getByTestId('avatar-viewer');
    expect(root.props.accessibilityViewIsModal).toBe(true);
    act(() => {
      root.props.onAccessibilityEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Modal 의 뒤로 요청(안드로이드 뒤로·시스템 닫기)도 닫는다', () => {
    const onClose = mount();
    act(() => {
      screen.getByTestId('avatar-viewer-modal').props.onRequestClose();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('아래로 쓸어 내리기', () => {
    type Handlers = Record<string, (event: unknown) => unknown>;

    /** `sheetContract` 의 손가락과 같은 모양 + 사진 뷰어가 읽는 `pageY`. */
    function touch(y: number, at: number, previousY: number = y) {
      return {
        nativeEvent: {
          touches: [{}],
          changedTouches: [{}],
          pageX: 0,
          pageY: y,
          timestamp: at,
        },
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

    /** 사진 위(쪽)에 손가락을 대고 `steps`(y, 시각)를 따라 끌었다가 놓는다 — 응답 시스템이 하는 호출을 같은 순서로. */
    function dragPhoto(steps: Array<[number, number]>) {
      const handlers = screen.getByTestId('avatar-viewer-page').props as Handlers;
      act(() => {
        const down = touch(0, 1);
        expect(handlers.onStartShouldSetResponder(down)).toBe(true);
        handlers.onResponderGrant(down);
        let previous = 0;
        for (const [y, at] of steps) {
          handlers.onResponderMove(touch(y, at, previous));
          previous = y;
        }
        const [lastY, lastAt] = steps[steps.length - 1];
        handlers.onResponderRelease(touch(lastY, lastAt + 1, lastY));
      });
    }

    it('문턱을 넘게 끌어 내리면 닫는다', () => {
      const onClose = mount();
      dragPhoto(FAR_SLOW_DRAG);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('문턱에 모자라게 천천히 내렸다 놓으면 닫지 않는다 — 제자리로 돌아온다', () => {
      const onClose = mount();
      dragPhoto([
        [20, 100],
        [60, 600],
      ]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('사진 밖(단추 띠의 빈 곳)에서 시작한 끌기도 뿌리가 쥐어 닫는다', () => {
      const onClose = mount();
      const handlers = screen.getByTestId('avatar-viewer').props as Handlers;
      act(() => {
        const down = touch(0, 1);
        expect(handlers.onStartShouldSetResponder(down)).toBe(true);
        handlers.onResponderGrant(down);
        let previous = 0;
        for (const [y, at] of FAR_SLOW_DRAG) {
          handlers.onResponderMove(touch(y, at, previous));
          previous = y;
        }
        handlers.onResponderRelease(touch(420, 1601, 420));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('알림이 새 입구로 들어오면 (#4667)', () => {
  it('뷰어가 걷힌다 — 단추·쓸어 내리기·escape 와 같은 `onClose` 로 한 번', () => {
    const onClose = mount();
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      dismissTemporarySurfaces();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
