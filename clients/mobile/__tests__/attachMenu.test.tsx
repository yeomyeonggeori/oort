import {dismissTemporarySurfaces} from '@momo/core/features/notifications/entryDismiss';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  StyleSheet,
  type View,
} from 'react-native';

import {
  blurSupported,
  resetBlurSupportForTests,
} from '../src/design/glass';
import {
  EASE_OUT,
  MENU_CLOSE_REST,
  MENU_CLOSE_SPRING,
  MENU_CLOSE_WATCHDOG_MS,
  MENU_FADE_MS,
  MENU_OPEN_SPRING,
} from '../src/design/motion';
import {FixedScheme} from '../src/design/theme';
import {
  darkPalette,
  font,
  lightPalette,
  TOUCH_TARGET,
} from '../src/design/tokens';
import {
  ATTACH_MENU,
  AttachMenu,
  attachMenuFrame,
  fallbackAnchor,
  type Rect,
} from '../src/features/attachments/AttachMenu';
import {installAppClock} from './fixtures/fakeClock';

// 제스트 렌더러에는 네이티브 태그가 없어 `findNodeHandle` 이 언제나 null 이다. 여기서는 **어느 노드**가
// 초점을 받았는지를 물어야 하므로 노드의 접근성 라벨을 손잡이로 돌려준다(`unreadJumpPills.test.tsx` 와 같은 길).
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(
    (node: {props?: {accessibilityLabel?: string}} | null) =>
      node?.props?.accessibilityLabel ?? null,
  ),
}));

const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]})
  .__calls;

// 성재가 고른 Buzz 캡처(IMG_4319)에서 잰 + 원: 중심 (67.5, 819), 지름 35pt, 창 402×874.
const BUZZ_WINDOW = {width: 402, height: 874};
const BUZZ_ANCHOR: Rect = {x: 50, y: 801.5, width: 35, height: 35};
const NO_INSETS = {top: 0, left: 0, right: 0};

const a11y = AccessibilityInfo as unknown as {
  isReduceMotionEnabled: jest.Mock;
  isReduceTransparencyEnabled: jest.Mock;
  setAccessibilityFocus: jest.Mock;
};

/** 측정이 바로 답하는 + 원 대역. 접근성 라벨은 `findNodeHandle` 대역이 손잡이로 읽는다. */
function fakeAnchor(rect: Rect | null = BUZZ_ANCHOR) {
  return {
    current: {
      props: {accessibilityLabel: '파일 첨부'},
      measureInWindow: (
        done: (x: number, y: number, w: number, h: number) => void,
      ) => {
        if (rect === null) done(0, 0, 0, 0);
        else done(rect.x, rect.y, rect.width, rect.height);
      },
    } as unknown as View,
  };
}

interface MenuHandlers {
  onClose: jest.Mock;
  onPickCamera: jest.Mock;
  onPickPhoto: jest.Mock;
  onPickFile: jest.Mock;
  onDismissed: jest.Mock;
}

function handlers(): MenuHandlers {
  return {
    onClose: jest.fn(),
    onPickCamera: jest.fn(),
    onPickPhoto: jest.fn(),
    onPickFile: jest.fn(),
    onDismissed: jest.fn(),
  };
}

function menu(
  visible: boolean,
  h: MenuHandlers,
  anchorRef = fakeAnchor(),
  scheme: 'light' | 'dark' = 'light',
) {
  return (
    <FixedScheme scheme={scheme}>
      <AttachMenu visible={visible} anchorRef={anchorRef} {...h} />
    </FixedScheme>
  );
}

function renderMenu(
  opts: {
    visible?: boolean;
    anchorRef?: ReturnType<typeof fakeAnchor>;
    scheme?: 'light' | 'dark';
  } = {},
) {
  const h = handlers();
  const anchorRef = opts.anchorRef ?? fakeAnchor();
  const scheme = opts.scheme ?? 'light';
  const view = render(menu(opts.visible ?? true, h, anchorRef, scheme));
  return {
    ...h,
    anchorRef,
    rerenderVisible: (visible: boolean) =>
      view.rerender(menu(visible, h, anchorRef, scheme)),
    unmount: view.unmount,
  };
}

/** 연타 방어(`touchGuardMs`)가 지나게 한다 — 사람이 메뉴를 본 뒤의 누름이 되도록. */
const pastGuard = () =>
  act(() => {
    jest.advanceTimersByTime(ATTACH_MENU.touchGuardMs);
  });

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<
    string,
    unknown
  >;

/** 카드 자세. `transform` 은 [translateX, translateY, scale] 순서다(`AttachMenu` 의 계약). */
function pose() {
  const style = flat('attach-menu');
  const transform = style.transform as Array<Record<string, number>>;
  return {
    opacity: style.opacity as number,
    left: style.left as number,
    top: style.top as number,
    height: style.height as number,
    width: style.width as number,
    transform,
    x: transform[0]?.translateX,
    y: transform[1]?.translateY,
    scale: transform[2]?.scale,
  };
}

beforeEach(() => {
  installAppClock();
  hapticCalls.length = 0;
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isReduceTransparencyEnabled.mockImplementation(() =>
    Promise.resolve(false),
  );
  a11y.setAccessibilityFocus.mockClear();
});

afterEach(() => {
  cleanup();
  resetBlurSupportForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('attachMenuFrame — + 원을 기점으로 한 산수 (Buzz IMG_4319·4320 실측)', () => {
  it('Buzz 의 + 원에서 Buzz 의 카드 자리가 나온다: 왼쪽 10 · 아래 830 · 폭 216', () => {
    const frame = attachMenuFrame(BUZZ_ANCHOR, BUZZ_WINDOW, NO_INSETS);
    expect(frame.left).toBe(10);
    expect(frame.left + frame.width).toBe(226);
    // 카드 아래 끝 = + 원 중심(819) + 11.
    expect(frame.top + frame.height).toBe(830);
    expect(frame.width).toBe(216);
    // 3행 × 60 + 위아래 12 = 204 (Buzz 의 5행은 5 × 60 + 24 = 324).
    expect(frame.height).toBe(3 * ATTACH_MENU.rowHeight + 24);
  });

  it('출발 자세: 카드 한가운데가 + 원 한가운데에 서고 크기는 + 원만 하다', () => {
    const frame = attachMenuFrame(BUZZ_ANCHOR, BUZZ_WINDOW, NO_INSETS);
    const cx = frame.left + frame.width / 2 + frame.startX;
    const cy = frame.top + frame.height / 2 + frame.startY;
    expect(cx).toBeCloseTo(67.5, 6);
    expect(cy).toBeCloseTo(819, 6);
    expect(frame.startScale).toBeCloseTo(35 / 216, 6);
  });

  it('+ 원이 어디 있든 같은 규칙이다: 오른쪽 끝에서는 오른쪽 가장자리로, 왼쪽 끝에서는 왼쪽 가장자리로 클램프한다', () => {
    const farRight = attachMenuFrame(
      {x: 360, y: 700, width: 35, height: 35},
      BUZZ_WINDOW,
      NO_INSETS,
    );
    expect(farRight.left + farRight.width).toBe(402 - ATTACH_MENU.edge);
    const farLeft = attachMenuFrame(
      {x: 0, y: 700, width: 35, height: 35},
      BUZZ_WINDOW,
      NO_INSETS,
    );
    expect(farLeft.left).toBe(ATTACH_MENU.edge);
    // 클램프돼도 출발 자세는 + 원 중심에 선다.
    expect(farRight.left + farRight.width / 2 + farRight.startX).toBeCloseTo(
      377.5,
      6,
    );
  });

  it('위로 자랄 자리가 모자라면 안전 영역 아래에서 멈춘다', () => {
    const frame = attachMenuFrame(
      {x: 20, y: 100, width: 35, height: 35},
      BUZZ_WINDOW,
      {top: 59, left: 0, right: 0},
    );
    expect(frame.top).toBe(59 + ATTACH_MENU.edge);
  });

  it('측정 실패 때의 + 원은 화면 안 왼쪽 아래다', () => {
    const rect = fallbackAnchor(BUZZ_WINDOW, {bottom: 34});
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(BUZZ_WINDOW.height - 34);
  });
});

describe('스프링 — 겉보기 250–350ms, 넘침 없음', () => {
  const dampingRatio = (s: {
    stiffness: number;
    damping: number;
    mass: number;
  }) => s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  /** 임계감쇠 스프링이 98% 에 닿는 때(ms): ωt ≈ 5.83, ω = √(k/m). */
  const settle98 = (s: {stiffness: number; mass: number}) =>
    (5.83 / Math.sqrt(s.stiffness / s.mass)) * 1000;

  it('두 스프링의 감쇠비는 1 에 가깝다(넘침 없음)', () => {
    expect(dampingRatio(MENU_OPEN_SPRING)).toBeGreaterThanOrEqual(0.99);
    expect(dampingRatio(MENU_CLOSE_SPRING)).toBeGreaterThanOrEqual(0.99);
  });

  it('열림은 이슈의 겉보기 250–350ms 안이고, 닫힘은 그보다 짧다', () => {
    expect(settle98(MENU_OPEN_SPRING)).toBeGreaterThanOrEqual(250);
    expect(settle98(MENU_OPEN_SPRING)).toBeLessThanOrEqual(350);
    expect(settle98(MENU_CLOSE_SPRING)).toBeLessThan(settle98(MENU_OPEN_SPRING));
    // 접힘의 「끝났다」 신호는 상한(watchdog)보다 훨씬 앞이어야 한다.
    expect(settle98(MENU_CLOSE_SPRING)).toBeLessThan(MENU_CLOSE_WATCHDOG_MS / 2);
  });

  it('열 때 스프링을 요청한다: 대상 1 · 열림 값 · 넘침 막기 · 네이티브 구동', () => {
    const spring = jest.spyOn(Animated, 'spring');
    const timing = jest.spyOn(Animated, 'timing');
    renderMenu();
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0][1]).toMatchObject({
      toValue: 1,
      ...MENU_OPEN_SPRING,
      overshootClamping: true,
      useNativeDriver: true,
    });
    expect(timing).not.toHaveBeenCalled();
  });

  it('닫을 때 반대 방향 스프링을 요청한다: 대상 0 · 닫힘 값 · 끝남 문턱 · 네이티브 구동', () => {
    const view = renderMenu();
    const spring = jest.spyOn(Animated, 'spring');
    view.rerenderVisible(false);
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      ...MENU_CLOSE_SPRING,
      ...MENU_CLOSE_REST,
      overshootClamping: true,
      useNativeDriver: true,
    });
  });
});

describe('기점 — 카드는 + 원에서 자란다', () => {
  it('막 열린 자세(진행 0): 카드 중심이 + 원 중심에 있고 크기는 + 원만 하며 아직 보이지 않는다', () => {
    renderMenu();
    const p = pose();
    const win = Dimensions.get('window');
    const expected = attachMenuFrame(BUZZ_ANCHOR, win, NO_INSETS);
    expect(p.left).toBe(expected.left);
    expect(p.top + p.height).toBe(expected.top + expected.height);
    expect(p.x).toBeCloseTo(expected.startX, 6);
    expect(p.y).toBeCloseTo(expected.startY, 6);
    expect(p.scale).toBeCloseTo(35 / 216, 6);
    expect(p.opacity).toBe(0);
    // 이동·크기는 transform 뿐이다(네이티브 구동) — left/top 은 끝 자리 그대로.
    expect(p.transform).toHaveLength(3);
  });

  it('+ 원을 못 재면 안전한 왼쪽 아래 자리로 열린다', () => {
    renderMenu({anchorRef: fakeAnchor(null)});
    const p = pose();
    expect(p.left).toBe(ATTACH_MENU.edge);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(screen.getByTestId('attachment-pick-camera')).toBeTruthy();
  });

  it('측정이 오지 않아도 열린다: 기다림 상한 뒤 움직임을 시작한다', () => {
    const spring = jest.spyOn(Animated, 'spring');
    const never = {
      current: {
        props: {accessibilityLabel: '파일 첨부'},
        measureInWindow: () => {},
      } as unknown as View,
    };
    renderMenu({anchorRef: never});
    expect(screen.getByTestId('attachment-pick-camera')).toBeTruthy();
    expect(spring).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(ATTACH_MENU.anchorWaitMs);
    });
    expect(spring).toHaveBeenCalledTimes(1);
  });
});

describe('동작 줄이기 — 크기 애니메이션 없이 페이드만', () => {
  async function renderReduced() {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const view = renderMenu({visible: false});
    // `useReduceMotionRef` 의 첫 답은 한 틱 뒤에 온다.
    await act(async () => {});
    return view;
  }

  it('열 때: 스프링은 부르지 않고 페이드 타이밍(MENU_FADE_MS · ease-out)만 요청한다', async () => {
    const view = await renderReduced();
    const spring = jest.spyOn(Animated, 'spring');
    const timing = jest.spyOn(Animated, 'timing');
    view.rerenderVisible(true);
    expect(spring).not.toHaveBeenCalled();
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 1,
      duration: MENU_FADE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
  });

  it('카드에는 이동·크기가 없고 행은 카드째 페이드한다', async () => {
    const view = await renderReduced();
    view.rerenderVisible(true);
    expect(pose().transform).toEqual([]);
    expect(flat('attachment-pick-camera').opacity).toBeUndefined();
  });

  it('닫을 때도 페이드 타이밍이다', async () => {
    const view = await renderReduced();
    view.rerenderVisible(true);
    const spring = jest.spyOn(Animated, 'spring');
    const timing = jest.spyOn(Animated, 'timing');
    view.rerenderVisible(false);
    expect(spring).not.toHaveBeenCalled();
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: MENU_FADE_MS,
      useNativeDriver: true,
    });
  });
});

describe('항목과 닫는 길', () => {
  it('항목은 카메라·사진·파일 셋이다 — 동영상·음성 메모는 지원하지 않아 없다', () => {
    renderMenu();
    expect(
      screen
        .getAllByRole('menuitem')
        .map(row => row.props.accessibilityLabel),
    ).toEqual(['카메라', '사진', '파일']);
    expect(screen.queryByText(/동영상|음성/)).toBeNull();
  });

  it.each([
    ['attachment-pick-camera', 'onPickCamera'],
    ['attachment-pick-photo', 'onPickPhoto'],
    ['attachment-pick-file', 'onPickFile'],
  ] as const)('%s 는 %s 하나만 부르고 닫기는 부모의 몫이다', (testID, callback) => {
    const view = renderMenu();
    pastGuard();
    fireEvent.press(screen.getByTestId(testID));
    for (const name of [
      'onPickCamera',
      'onPickPhoto',
      'onPickFile',
      'onClose',
    ] as const) {
      expect(view[name]).toHaveBeenCalledTimes(name === callback ? 1 : 0);
    }
  });

  it('열린 직후(200ms 안)의 행 누름은 무시한다 — + 를 두 번 누르는 손이 파일 행을 고르지 않게', () => {
    const view = renderMenu();
    // 열리자마자 — + 원 위쪽 반을 덮은 마지막 행에 두 번째 탭이 떨어진 순간.
    fireEvent.press(screen.getByTestId('attachment-pick-file'));
    expect(view.onPickFile).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(ATTACH_MENU.touchGuardMs - 1);
    });
    fireEvent.press(screen.getByTestId('attachment-pick-file'));
    expect(view.onPickFile).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    fireEvent.press(screen.getByTestId('attachment-pick-file'));
    expect(view.onPickFile).toHaveBeenCalledTimes(1);
  });

  it('+ 재탭: 카드에 가려진 + 원 자리에 닫기 표면이 서고, 누르면 닫는다(열린 직후에도)', () => {
    const view = renderMenu();
    const close = screen.getByTestId('attach-menu-anchor-close', {
      includeHiddenElements: true,
    });
    // + 원을 잰 그 자리(창 좌표) 그대로다 — 카드 위, 마지막 행 위에 얹힌다.
    expect(StyleSheet.flatten(close.props.style)).toMatchObject({
      left: BUZZ_ANCHOR.x,
      top: BUZZ_ANCHOR.y,
      width: BUZZ_ANCHOR.width,
      height: BUZZ_ANCHOR.height,
    });
    expect(close).toHaveProp('accessibilityElementsHidden', true);
    fireEvent.press(close);
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.onPickFile).not.toHaveBeenCalled();
  });

  it('+ 원을 못 쟀으면(안전한 자리로 열릴 때) 닫기 표면을 허공에 세우지 않는다', () => {
    renderMenu({anchorRef: fakeAnchor(null)});
    expect(
      screen.queryByTestId('attach-menu-anchor-close', {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  it('닫는 길은 방어 시간에도 열려 있다: 바깥 탭은 열린 직후에도 닫는다', () => {
    const view = renderMenu();
    fireEvent.press(
      screen.getByTestId('attach-menu-backdrop', {includeHiddenElements: true}),
    );
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it('바깥 탭 · VoiceOver 탈출(두 손가락 Z) · Modal 뒤로가기가 모두 닫는다', () => {
    const view = renderMenu();
    // 바깥 막은 보조기술에서 숨겨져 있어 조회도 숨김을 포함한다.
    fireEvent.press(
      screen.getByTestId('attach-menu-backdrop', {includeHiddenElements: true}),
    );
    expect(view.onClose).toHaveBeenCalledTimes(1);
    screen.getByTestId('attach-menu-layer').props.onAccessibilityEscape();
    expect(view.onClose).toHaveBeenCalledTimes(2);
    screen.getByTestId('attach-menu-modal').props.onRequestClose();
    expect(view.onClose).toHaveBeenCalledTimes(3);
  });

  it('알림이 새 입구로 들어오면 열린 메뉴만 닫아 달라고 한다 — 닫혀 있는 메뉴는 부모에게 아무것도 묻지 않는다 (#4667)', () => {
    const open = renderMenu({visible: true});
    act(() => {
      dismissTemporarySurfaces();
    });
    expect(open.onClose).toHaveBeenCalledTimes(1);
    open.unmount();

    const closed = renderMenu({visible: false});
    act(() => {
      dismissTemporarySurfaces();
    });
    expect(closed.onClose).not.toHaveBeenCalled();
  });

  it('열린 동안에는 Modal 이 서 있고, 닫힌 채로 시작하면 아무것도 그리지 않는다', () => {
    const closed = renderMenu({visible: false});
    expect(screen.queryByTestId('attach-menu')).toBeNull();
    closed.unmount();
    renderMenu({visible: true});
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
  });
});

describe('Modal 수명 — 접힘이 끝난 뒤에만 내려가고, 그 뒤에야 picker 가 뜬다', () => {
  function captureSprings() {
    const callbacks: Array<(result: {finished: boolean}) => void> = [];
    jest.spyOn(Animated, 'spring').mockImplementation(((
      _value: unknown,
      config: {toValue: number},
    ) => ({
      start: (callback?: (result: {finished: boolean}) => void) => {
        if (config.toValue === 0 && callback !== undefined) {
          callbacks.push(callback);
        }
      },
      stop: jest.fn(),
      reset: jest.fn(),
    })) as never);
    return callbacks;
  }

  it('닫는 요청 직후에도 Modal 은 서 있고(접히는 중), 접힘이 끝났다는 신호가 오면 내려간다', () => {
    const callbacks = captureSprings();
    const view = renderMenu();
    view.rerenderVisible(false);
    expect(screen.queryByTestId('attach-menu')).not.toBeNull();
    expect(callbacks).toHaveLength(1);
    act(() => callbacks[0]({finished: true}));
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('끝났다는 신호가 안 와도 상한(MENU_CLOSE_WATCHDOG_MS)이 지나면 내려간다 — 화면을 덮은 채 남지 않는다', () => {
    captureSprings();
    const view = renderMenu();
    view.rerenderVisible(false);
    act(() => {
      jest.advanceTimersByTime(MENU_CLOSE_WATCHDOG_MS - 1);
    });
    expect(screen.queryByTestId('attach-menu')).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('접힘이 끊긴 신호(finished: false)로는 내려가지 않는다', () => {
    const callbacks = captureSprings();
    const view = renderMenu();
    view.rerenderVisible(false);
    act(() => callbacks[0]({finished: false}));
    expect(screen.queryByTestId('attach-menu')).not.toBeNull();
  });

  it('onDismissed 는 Modal 의 onDismiss 가 올 때만 한 번 부른다 — 닫는 요청도 접힘의 끝도 아니다', () => {
    const callbacks = captureSprings();
    const view = renderMenu();
    view.rerenderVisible(false);
    expect(view.onDismissed).not.toHaveBeenCalled();
    act(() => callbacks[0]({finished: true}));
    // 접힘이 끝나 Modal 을 내렸어도 「사라졌다」는 신호는 iOS 의 `onDismiss` 다 — 이 대역은 내려간
    // Modal 에서 그 신호를 내지 않으므로(제스트의 Modal 은 숨으면 통째로 사라진다) 여기서 말할 수 있는
    // 것은 「접힘의 끝이 `onDismissed` 를 대신하지 않는다」까지다. 신호가 온 뒤의 한 번은 아래 시험이,
    // 신호가 안 올 때의 폴백은 `composerAttachments.test.tsx` 가 잰다.
    expect(view.onDismissed).not.toHaveBeenCalled();
  });

  it('Modal onDismiss → onDismissed 한 번', () => {
    const view = renderMenu();
    screen.getByTestId('attach-menu-modal').props.onDismiss();
    expect(view.onDismissed).toHaveBeenCalledTimes(1);
  });

  it('접히는 도중에 다시 열면 지난 접힘의 상한 타이머가 열린 메뉴를 내리지 않는다', () => {
    captureSprings();
    const view = renderMenu();
    view.rerenderVisible(false);
    act(() => {
      jest.advanceTimersByTime(MENU_CLOSE_WATCHDOG_MS - 100);
    });
    view.rerenderVisible(true);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId('attach-menu')).not.toBeNull();
  });
});

describe('접근성 — 초점·라벨·해요체', () => {
  it('메뉴는 menu, 행은 menuitem 이고 이름은 보이는 글자, 설명은 해요체다', () => {
    renderMenu();
    expect(screen.getByTestId('attach-menu')).toHaveProp(
      'accessibilityRole',
      'menu',
    );
    const rows = screen.getAllByRole('menuitem');
    expect(rows.map(row => row.props.accessibilityHint)).toEqual([
      '사진을 찍어 바로 첨부해요',
      '사진 보관함에서 한 장을 골라요',
      '파일 앱에서 한 개를 골라요',
    ]);
    for (const row of rows) {
      expect(row.props.accessibilityHint).not.toMatch(/(습니다|니다)\b|니다\.?$/);
      expect(row.props.accessibilityHint).toMatch(/요$/);
    }
  });

  it('바깥 막은 보조기술에서 숨고, 레이어는 뒤를 가린다(모달)', () => {
    renderMenu();
    const backdrop = screen.getByTestId('attach-menu-backdrop', {
      includeHiddenElements: true,
    });
    expect(backdrop).toHaveProp('accessibilityElementsHidden', true);
    expect(backdrop).toHaveProp(
      'importantForAccessibility',
      'no-hide-descendants',
    );
    expect(screen.getByTestId('attach-menu-layer')).toHaveProp(
      'accessibilityViewIsModal',
      true,
    );
  });

  it('열리면 VoiceOver 초점이 첫 항목(카메라)으로 간다', () => {
    renderMenu();
    expect(a11y.setAccessibilityFocus).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(ATTACH_MENU.focusDelayMs);
    });
    expect(a11y.setAccessibilityFocus).toHaveBeenCalledTimes(1);
    expect(a11y.setAccessibilityFocus).toHaveBeenCalledWith('카메라');
  });

  it('고르지 않고 닫히면 초점이 + 원으로 돌아간다', () => {
    const view = renderMenu();
    act(() => {
      jest.advanceTimersByTime(ATTACH_MENU.focusDelayMs);
    });
    a11y.setAccessibilityFocus.mockClear();
    view.rerenderVisible(false);
    screen.getByTestId('attach-menu-modal').props.onDismiss();
    expect(a11y.setAccessibilityFocus).toHaveBeenCalledTimes(1);
    expect(a11y.setAccessibilityFocus).toHaveBeenCalledWith('파일 첨부');
  });

  it('항목을 골라 닫히면 초점을 + 원으로 돌리지 않는다 — 곧 뜰 picker 몫이다', () => {
    const view = renderMenu();
    act(() => {
      jest.advanceTimersByTime(ATTACH_MENU.focusDelayMs);
    });
    a11y.setAccessibilityFocus.mockClear();
    pastGuard();
    fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    view.rerenderVisible(false);
    screen.getByTestId('attach-menu-modal').props.onDismiss();
    expect(a11y.setAccessibilityFocus).not.toHaveBeenCalled();
    expect(view.onDismissed).toHaveBeenCalledTimes(1);
  });

  it('다시 열면 「골랐다」 기억이 지워져 초점이 정상으로 돌아간다', () => {
    const view = renderMenu();
    pastGuard();
    fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    view.rerenderVisible(false);
    view.rerenderVisible(true);
    a11y.setAccessibilityFocus.mockClear();
    view.rerenderVisible(false);
    screen.getByTestId('attach-menu-modal').props.onDismiss();
    expect(a11y.setAccessibilityFocus).toHaveBeenCalledWith('파일 첨부');
  });
});

describe('치수·재질 — Buzz 캡처 기준', () => {
  it('카드 폭 216 · 행 높이 60(터치 44 이상) · 모서리는 이름 있는 연속 곡선 반경 34, 행은 동심', () => {
    // 곡선이 **화면에서** 연속인지는 이 시험이 못 잰다(style prop 만 읽는다) — 시뮬레이터 캡처의 모서리
    // 프로필(`corner.py`)이 재고, 반경 34 는 그 프로필을 Buzz 와 최소제곱으로 맞춘 값이다(머리 주석).
    renderMenu();
    const card = flat('attach-menu');
    expect(card.width).toBe(216);
    expect(card.borderRadius).toBe(ATTACH_MENU.radius);
    expect(card.borderCurve).toBe('continuous');
    // 동심: 행 반경 = 카드 반경 − 카드 안 여백(12).
    expect(flat('attachment-pick-camera').borderRadius).toBe(
      ATTACH_MENU.radius - 12,
    );
    expect(flat('attachment-pick-camera').height).toBe(60);
    expect(flat('attachment-pick-camera').height as number).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    const clip = StyleSheet.flatten(
      screen.getByTestId('attach-menu').children[0] &&
        (screen.getByTestId('attach-menu').children[0] as {props: {style: unknown}})
          .props.style,
    ) as Record<string, unknown>;
    expect(clip.borderCurve).toBe('continuous');
    expect(clip.overflow).toBe('hidden');
  });

  it('글자는 font.title(22) · 400 이고 항목 이름만 읽는다', () => {
    renderMenu();
    const label = StyleSheet.flatten(
      screen.getByText('카메라').props.style,
    ) as Record<string, unknown>;
    expect(label.fontSize).toBe(font.title);
    expect(label.fontWeight).toBe('400');
    expect(label.color).toBe(lightPalette.onPrimary);
  });

  it('라이트: 어두운 잉크 카드(primary)에 밝은 글자 — 다크: 밝은 잉크 카드에 어두운 글자', () => {
    const light = renderMenu({scheme: 'light'});
    expect(
      (flat('attach-menu-material-fallback').backgroundColor as string).slice(
        0,
        7,
      ),
    ).toBe(lightPalette.primary);
    expect(
      (StyleSheet.flatten(screen.getByText('카메라').props.style) as {color: string})
        .color,
    ).toBe(lightPalette.onPrimary);
    light.unmount();
    renderMenu({scheme: 'dark'});
    expect(
      (flat('attach-menu-material-fallback').backgroundColor as string).slice(
        0,
        7,
      ),
    ).toBe(darkPalette.primary);
    expect(
      (StyleSheet.flatten(screen.getByText('카메라').props.style) as {color: string})
        .color,
    ).toBe(darkPalette.onPrimary);
  });

  it('흐림이 있으면 흐림 위에 잉크 86%: 흐림의 틴트는 앱 스킴을 따른다(GlassSurface 와 같다)', () => {
    resetBlurSupportForTests(true);
    expect(blurSupported()).toBe(true);
    const light = renderMenu({scheme: 'light'});
    expect(screen.getByTestId('blur-view')).toHaveProp('tint', 'light');
    const tint = flat('attach-menu-material-blur').backgroundColor as string;
    expect(tint.slice(0, 7)).toBe(lightPalette.primary);
    expect(parseInt(tint.slice(7, 9), 16)).toBe(
      Math.round(ATTACH_MENU.materialAlpha * 255),
    );
    light.unmount();
    renderMenu({scheme: 'dark'});
    expect(screen.getByTestId('blur-view')).toHaveProp('tint', 'dark');
  });

  it('흐림 모듈이 없으면 잉크 94%(GlassSurface 의 폴백과 같은 값)', () => {
    renderMenu();
    const fill = flat('attach-menu-material-fallback').backgroundColor as string;
    expect(parseInt(fill.slice(7, 9), 16)).toBe(Math.round(0.94 * 255));
    expect(screen.queryByTestId('blur-view')).toBeNull();
  });

  it('투명도 줄이기가 켜지면 흐림이 있어도 불투명 잉크다 — 반투명은 읽기 어려운 것이다', async () => {
    resetBlurSupportForTests(true);
    a11y.isReduceTransparencyEnabled.mockImplementation(() =>
      Promise.resolve(true),
    );
    renderMenu();
    await act(async () => {});
    expect(screen.queryByTestId('blur-view')).toBeNull();
    expect(flat('attach-menu-material-opaque').backgroundColor).toBe(
      lightPalette.primary,
    );
  });
});

describe('Info.plist — 카메라 문구는 두 용도를 해요체로 말한다', () => {
  const plist = fs.readFileSync(
    path.join(__dirname, '../ios/MomoMobile/Info.plist'),
    'utf8',
  );
  const camera =
    /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(
      plist,
    )?.[1] ?? '';

  it('사진 찍어 첨부와 QR 기기 연결을 모두 말한다', () => {
    expect(camera).toMatch(/사진을 찍어/);
    expect(camera).toMatch(/첨부/);
    expect(camera).toMatch(/QR/);
  });

  it('합쇼체가 아니다', () => {
    expect(camera).not.toMatch(/(습니다|니다)\.?$/);
    expect(camera).toMatch(/요\.$/);
  });
});
