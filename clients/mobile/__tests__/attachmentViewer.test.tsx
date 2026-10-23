import type { MessageAttachment } from '@momo/core/lib/api';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  type NativeTouchEvent,
} from 'react-native';

import { space, TOUCH_TARGET } from '../src/design/tokens';
import { VIEWER_SNAP_SPRING } from '../src/design/motion';
import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { AttachmentViewer } from '../src/features/attachments/AttachmentViewer';
import { resetAttachmentContentForTest } from '../src/features/attachments/content';
import { DISMISS_DISTANCE_PT } from '../src/features/attachments/viewerDismiss';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: { id: 'self' },
    signOut: jest.fn(),
  }),
}));

// =============================================================================
// 사진 뷰어 (#4293): 위쪽 단추가 안전 영역 안에 서고, 아래로 쓸어 닫는다.
//
// 이 파일이 지키는 것은 베타 테스터가 겪은 일 하나다 — 단추가 상태 막대 밑에 깔려 눌리지
// 않았고, 사람이 뷰어에 갇혔다. 그래서 두 절반을 따로 잰다.
//
//   ① 안전 영역: 인셋이 있는 기기(다이내믹 아일랜드 · 홈 버튼 SE · 가로)마다 단추 띠가 그
//      인셋만큼 내려앉는다. jest 의 안전 영역 대역은 **0 을 돌려주므로**(`jest.setup.js`)
//      인셋이 0 인 기기에서는 이 시험이 아무것도 못 잡는다 — 그래서 각 시험이 인셋을
//      **직접 심는다.** 심은 값이 없어지면(패딩을 지우면) 빨갛다.
//   ② 쓸어 닫기: 규칙은 `viewerDismiss.test.ts` 가 재생한다. 여기서는 규칙이 `PanResponder` 에
//      옳게 묶여 있는지 — 진짜 응답 시스템이 하는 호출을 그대로 재생해서 — 본다.
// =============================================================================

const IMAGES: MessageAttachment[] = ['a', 'b', 'c'].map(id => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  sizeBytes: 4096,
}));

/** 한 기기의 인셋(pt). 값은 실기기의 것이다. */
const DEVICES = {
  '다이내믹 아일랜드(16 Pro)': { top: 59, bottom: 34, left: 0, right: 0 },
  '홈 버튼(SE)': { top: 20, bottom: 0, left: 0, right: 0 },
  '가로(노치 쪽 59)': { top: 0, bottom: 21, left: 59, right: 59 },
} as const;

type Insets = { top: number; bottom: number; left: number; right: number };

function useInsets(insets: Insets) {
  // `jest.setup.js` 의 대역을 갈아 끼운다. **렌더 전에** 심어야 한다 — 뷰어는 열릴 때 읽는다.
  const safeArea = require('react-native-safe-area-context');
  return jest.spyOn(safeArea, 'useSafeAreaInsets').mockReturnValue(insets);
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

type Handlers = { props: Record<string, (event: unknown) => unknown> };

// -----------------------------------------------------------------------------
// 손가락. React Native 의 responder 시스템이 뷰에게 하는 호출을 그대로 한다
// (`edgeSwipeBack.test.tsx` 의 같은 이름 도우미와 같은 모양 — 거기 것은 고치지 않는다).
// `PanResponder` 가 `touchHistory` 로 속도(`vy`, px/ms)를 계산하므로 그것도 진짜 모양으로 준다.
// -----------------------------------------------------------------------------
interface Sample {
  x: number;
  y: number;
  t: number;
}

function finger(target: Handlers) {
  let start: Sample = { x: 0, y: 0, t: 0 };
  let previous: Sample = start;
  let current: Sample = start;
  let clock = 1_000;
  let active = true;
  let granted = false;
  let count = 1;

  function event() {
    const touch = {
      identifier: 0,
      target: 1,
      pageX: current.x,
      pageY: current.y,
      locationX: current.x,
      locationY: current.y,
      timestamp: current.t,
    } as unknown as NativeTouchEvent;
    return {
      nativeEvent: {
        ...touch,
        touches: active ? Array.from({ length: count }, () => touch) : [],
        changedTouches: [touch],
        timestamp: current.t,
      },
      touchHistory: {
        touchBank: [
          {
            touchActive: active,
            startPageX: start.x,
            startPageY: start.y,
            startTimeStamp: start.t,
            currentPageX: current.x,
            currentPageY: current.y,
            currentTimeStamp: current.t,
            previousPageX: previous.x,
            previousPageY: previous.y,
            previousTimeStamp: previous.t,
          },
        ],
        numberActiveTouches: active ? count : 0,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: current.t,
      },
    };
  }

  return {
    /** 화면에 손가락이 닿았다. 시작에서 가져갔으면(가져가면 안 된다) true. */
    down(x: number, y: number): boolean {
      clock += 16;
      start = { x, y, t: clock };
      previous = start;
      current = start;
      active = true;
      granted = false;
      count = 1;
      let claimed = false;
      act(() => {
        claimed = Boolean(target.props.onStartShouldSetResponderCapture?.(event()));
      });
      return claimed;
    },
    /** 손가락이 움직였다. 이 걸음에서 가져갔으면 true. */
    move(x: number, y: number, dt = 16): boolean {
      clock += dt;
      previous = current;
      current = { x, y, t: clock };
      let claimed = false;
      act(() => {
        if (!granted) {
          claimed = Boolean(target.props.onMoveShouldSetResponderCapture?.(event()));
          if (claimed) {
            granted = true;
            target.props.onResponderGrant?.(event());
          }
        } else {
          target.props.onResponderMove?.(event());
        }
      });
      return claimed;
    },
    /** 둘째 손가락이 닿았다. 응답 시스템은 공통 조상에게 시작을 다시 묻는다. */
    second() {
      count = 2;
      clock += 16;
      act(() => {
        target.props.onStartShouldSetResponderCapture?.(event());
      });
    },
    /** 손가락을 뗐다. */
    up() {
      active = false;
      act(() => {
        target.props.onResponderRelease?.(event());
      });
    },
    /** 응답 시스템이 제스처를 빼앗았다(전화·OS 취소). */
    terminate() {
      act(() => {
        target.props.onResponderTerminate?.(event());
      });
    },
    get granted() {
      return granted;
    },
  };
}

/** 시작 y 에서 `total` 만큼 느리게(0.2px/ms) 내려간다. */
function dragSlowly(touch: ReturnType<typeof finger>, x: number, y0: number, total: number) {
  for (let travelled = 10; travelled < total; travelled += 10) {
    touch.move(x, y0 + travelled, 50);
  }
  touch.move(x, y0 + total, 50);
}

interface Mounted {
  onClose: jest.Mock;
  progress: { current: number | null };
}

async function mount(
  over: Partial<React.ComponentProps<typeof AttachmentViewer>> = {},
): Promise<Mounted> {
  const onClose = jest.fn();
  const progress = { current: null as number | null };
  render(
    <AttachmentViewer
      workspaceId="ws"
      channelId="ch"
      images={IMAGES}
      startIndex={0}
      onClose={onClose}
      progressRef={progress}
      {...over}
    />,
  );
  // 쪽마다 미리보기를 받는다 — 도착을 기다려 둬야 act 밖의 갱신이 시험 밖으로 새지 않는다.
  await screen.findAllByTestId('attachment-viewer-image');
  return { onClose, progress };
}

const root = () => screen.getByTestId('attachment-viewer') as unknown as Handlers;

const a11y = AccessibilityInfo as unknown as {
  isReduceMotionEnabled: jest.Mock;
};

beforeEach(() => {
  resetAttachmentContentForTest();
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('① 단추 띠는 안전 영역 안에 선다', () => {
  it.each(Object.entries(DEVICES))('%s: 띠가 인셋만큼 내려앉는다', async (_name, insets) => {
    useInsets(insets);
    await mount();
    const bar = flatten(screen.getByTestId('attachment-viewer-bar').props.style);
    // 이 한 줄이 이슈의 P0 다: 닫기·공유의 윗면이 인셋(상태 막대·다이내믹 아일랜드) 위로 올라가면 안 된다.
    expect(bar.paddingTop).toBe(insets.top);
    // 가로 여백은 평소 여백보다 좁아지지 않고, 노치 쪽 인셋보다도 좁아지지 않는다.
    expect(bar.paddingLeft).toBe(Math.max(space.md, insets.left));
    expect(bar.paddingRight).toBe(Math.max(space.md, insets.right));
    // 띠는 흐름 안에 선다 — 절대 위치로 위에 얹혀 인셋을 넘어가지 않는다.
    expect(bar.position).toBeUndefined();
  });

  it.each(Object.entries(DEVICES))('%s: 사진 영역은 홈 인디케이터 위에서 끝난다', async (_name, insets) => {
    useInsets(insets);
    await mount();
    const pager = flatten(screen.getByTestId('attachment-viewer-pager').props.style);
    expect(pager.paddingBottom).toBe(insets.bottom);
  });

  it('인셋이 0 인 기기에서는 0 이다 — 값을 지어내지 않는다', async () => {
    await mount();
    const bar = flatten(screen.getByTestId('attachment-viewer-bar').props.style);
    expect(bar.paddingTop).toBe(0);
  });

  it('닫기·공유는 두 변 모두 44pt 이상이다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    await mount();
    for (const id of ['attachment-viewer-close', 'attachment-viewer-share']) {
      const style = flatten(screen.getByTestId(id).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
  });

  it('인셋은 Modal 안의 SafeAreaProvider 가 준다 — Modal 은 앱 루트와 다른 네이티브 계층이다', async () => {
    // 대역은 SafeAreaProvider 를 투명하게 지나가므로 존재만 본다: Modal 의 자식이 곧 뷰어 뿌리다.
    await mount();
    expect(screen.getByTestId('attachment-viewer-modal')).toBeTruthy();
    expect(screen.getByTestId('attachment-viewer')).toBeTruthy();
  });
});

describe('VoiceOver: 닫기에 닿고 「닫기」로 읽힌다', () => {
  it('닫기는 버튼이고 이름이 「닫기」다', async () => {
    await mount();
    const close = screen.getByTestId('attachment-viewer-close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('닫기');
  });

  it('읽는 순서에서 닫기가 첫 번째다 — 사람은 뷰어에 들어서자마자 닫을 길을 만난다', async () => {
    await mount();
    const order = screen.getAllByRole('button').map(button => button.props.testID);
    expect(order[0]).toBe('attachment-viewer-close');
  });

  it('뷰어가 모달 경계다 — VoiceOver 가 뒤의 대화로 새지 않는다', async () => {
    await mount();
    expect(screen.getByTestId('attachment-viewer').props.accessibilityViewIsModal).toBe(true);
  });

  it('두 손가락 문지르기(escape)가 닫는다 — 단추를 못 찾는 사람의 길이다', async () => {
    const { onClose } = await mount();
    act(() => {
      (root().props.onAccessibilityEscape as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('단추 탭은 그대로 닫는다', async () => {
    const { onClose } = await mount();
    fireEvent.press(screen.getByTestId('attachment-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('② 아래로 쓸어 닫기', () => {
  it('100pt 에 모자라게 천천히 내렸다 놓으면 닫히지 않고 제자리로 돌아온다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT - 1);
    expect(progress.current).toBe(DISMISS_DISTANCE_PT - 1);
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('100pt 를 넘게 천천히 내렸다 놓으면 닫는다', async () => {
    const { onClose } = await mount();
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT + 1);
    touch.up();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('짧아도 빠르게(0.75px/ms = 750pt/s) 튕기면 닫는다', async () => {
    const { onClose, progress } = await mount();
    const flick = finger(root());
    flick.down(200, 300);
    flick.move(200, 312, 16); // 문턱을 넘어 가져간다
    flick.move(200, 324, 16); // 12pt / 16ms = 0.75px/ms
    flick.up();
    expect(progress.current).toBe(24); // 100pt 에는 한참 모자라다
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('같은 거리를 0.65px/ms(650pt/s)로 튕기면 돌아간다 — 문턱은 700 이다', async () => {
    const { onClose, progress } = await mount();
    const drift = finger(root());
    drift.down(200, 300);
    drift.move(200, 312, 16);
    drift.move(200, 322.4, 16); // 10.4pt / 16ms = 0.65px/ms
    drift.up();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('끄는 동안 사진은 손가락이 간 만큼 — 매 걸음, 시작점에서 잰다', async () => {
    const { progress } = await mount();
    const touch = finger(root());
    touch.down(200, 300);
    expect(progress.current).toBeNull(); // 아직 아무 데도 안 갔다
    touch.move(200, 312); // 문턱을 넘어 가져간다 — 거기까지 간 만큼에서 시작한다
    expect(progress.current).toBe(12);
    for (const dy of [30, 80, 160]) {
      touch.move(200, 300 + dy);
      expect(progress.current).toBe(dy);
    }
    // 되돌리면 사진도 되돌아온다 — 진행 중에 취소할 수 있다.
    touch.move(200, 300 + 50);
    expect(progress.current).toBe(50);
    // 시작점 위로 올려도 사진은 위로 가지 않는다.
    touch.move(200, 300 - 40);
    expect(progress.current).toBe(0);
  });

  it('문턱 안의 움직임과 탭은 가져가지 않는다 — 닫기 단추의 탭이 산다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(root());
    expect(touch.down(200, 300)).toBe(false); // 시작에서는 절대 가져가지 않는다
    expect(touch.move(200, 307)).toBe(false);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('가로로 넘기는 손가락은 가져가지 않는다 — 페이지 넘김을 훔치지 않는다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(root());
    touch.down(300, 400);
    // 오른쪽으로 크게, 아래로는 조금.
    for (const [x, y] of [
      [270, 405],
      [220, 412],
      [150, 420],
      [60, 430],
    ] as const) {
      expect(touch.move(x, y)).toBe(false);
    }
    expect(touch.granted).toBe(false);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('위로 올리는 손가락은 가져가지 않는다', async () => {
    const { progress } = await mount();
    const touch = finger(root());
    touch.down(200, 600);
    expect(touch.move(200, 560)).toBe(false);
    expect(touch.move(200, 480)).toBe(false);
    expect(progress.current).toBeNull();
  });

  it('꺼져 있으면(확대 중) 아무리 내려도 가져가지 않는다', async () => {
    const { onClose, progress } = await mount({ dismissEnabled: false });
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 400);
    expect(touch.granted).toBe(false);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('끌던 중 둘째 손가락이 닿으면 취소다 — 제자리로 돌아오고, 놓아도 닫히지 않는다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 150); // 이미 닫을 거리를 넘겼다
    expect(progress.current).toBe(150);
    touch.second();
    expect(progress.current).toBe(0);
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('응답 시스템이 제스처를 빼앗으면(전화·OS 취소) 닫지 않고 제자리로 돌아온다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 150);
    touch.terminate();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('잡았으면 놓지 않는다 — 밑의 스크롤뷰가 도중에 되가져가지 못하게', async () => {
    await mount();
    const handlers = root().props;
    expect((handlers.onResponderTerminationRequest as () => boolean)()).toBe(false);
  });
});

describe('동작 줄이기', () => {
  it('꺼져 있으면 모자라게 놓았을 때 스프링으로 돌아온다 — Buzz 260ms/0.14 를 옮긴 값으로', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mount();
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 60);
    touch.up();
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0]?.[1]).toMatchObject({ toValue: 0, ...VIEWER_SNAP_SPRING });
  });

  it('켜져 있으면 스프링 없이 즉시 제자리다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    const { progress } = await mount();
    await act(async () => {}); // 설정의 답이 도착한다
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 60);
    touch.up();
    expect(spring).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('Modal 은 평소 투명으로 서고 시스템 페이드로 나타난다·사라진다', async () => {
    await mount();
    const modal = screen.getByTestId('attachment-viewer-modal');
    // 투명이어야 끄는 동안 배경이 옅어져 뒤의 대화가 비친다.
    expect(modal.props.transparent).toBe(true);
    expect(modal.props.animationType).toBe('fade');
  });

  it('켜져 있으면 Modal 이 페이드 없이 바로 선다·내려간다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    await mount();
    await act(async () => {}); // 설정의 답이 도착한다
    expect(screen.getByTestId('attachment-viewer-modal').props.animationType).toBe('none');
  });
});

describe('대화에서 연 뷰어', () => {
  async function renderList() {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[
          { id: 'p1', name: '현장.png', mime: 'image/png', sizeBytes: 4096 },
        ]}
      />,
    );
    await act(async () => {}); // 타일의 미리보기·크기 읽기가 끝난다
  }

  it('사진을 눌러 열고 아래로 쓸어 내리면 닫혀 대화로 돌아온다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    await renderList();
    fireEvent.press(screen.getByTestId('attachment-item'));
    await screen.findByTestId('attachment-viewer-image');
    expect(screen.getByTestId('attachment-viewer')).toBeTruthy(); // 정말 열려 있었다
    const touch = finger(root());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 140);
    touch.up();
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
    expect(screen.getByTestId('attachment-item')).toBeTruthy();
  });

  it('다이내믹 아일랜드 기기에서도 단추 띠가 인셋 아래에서 시작하고, 닫기 탭이 닫는다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    await renderList();
    fireEvent.press(screen.getByTestId('attachment-item'));
    await screen.findByTestId('attachment-viewer-image');
    expect(
      flatten(screen.getByTestId('attachment-viewer-bar').props.style).paddingTop,
    ).toBe(59);
    fireEvent.press(screen.getByTestId('attachment-viewer-close'));
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
  });
});
