import type { MessageAttachment } from '@momo/core/lib/api';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  View,
  type NativeTouchEvent,
} from 'react-native';

import { BAR_CONTROL_MAX_SCALE } from '../src/design/atoms';
import { SHEET_ICONS } from '../src/design/icons';
import { space, TOUCH_TARGET } from '../src/design/tokens';
import { VIEWER_SNAP_SPRING } from '../src/design/motion';
import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { AttachmentViewer } from '../src/features/attachments/AttachmentViewer';
import { resetAttachmentContentForTest } from '../src/features/attachments/content';
import { DISMISS_DISTANCE_PT } from '../src/features/attachments/viewerDismiss';
import { retainReduceMotion } from '../src/lib/useReduceMotion';

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

type Instance = ReturnType<typeof screen.getByTestId>;

/** 호스트 뷰만 이은 사슬: [자기 자신, 부모, …, 맨 위]. 응답 시스템은 React 트리의 부모 사슬로 협상한다. */
function hostChain(node: Instance): Instance[] {
  const chain: Instance[] = [];
  for (let n: Instance | null = node; n; n = n.parent) {
    if (typeof n.type === 'string') chain.push(n);
  }
  return chain;
}

/** `ancestor` 가 `node` 의 (진짜) 조상인가 — iOS 스크롤뷰가 응답자를 찾는 사슬(superview)과 같다. */
function isAncestor(ancestor: Instance, node: Instance): boolean {
  return ancestor !== node && hostChain(node).includes(ancestor);
}

// -----------------------------------------------------------------------------
// 손가락. React Native 의 responder 시스템(`ResponderEventPlugin`)이 뷰에게 하는 호출을 그대로 한다:
//
//   · 닿을 때: capture(위에서 아래로) → bubble(아래에서 위로)에서 처음 참을 준 뷰가 응답자가 된다.
//   · 응답자가 정해진 뒤의 이동·둘째 손가락: 응답 시스템은 **응답자의 조상들**에게 다시 묻는다(응답자
//     자신은 건너뛴다). 누가 참을 주면 응답자에게 양보를 청하고, 응했을 때 응답이 옮겨 간다.
//     그다음에야 응답자가 `onResponderMove`/`onResponderStart` 를 받는다.
//
// 앞 판의 도우미는 한 뷰의 핸들러를 직접 불렀다. 그래서 「누가 쥐는가」(응답자가 가로 스크롤뷰의
// 조상이면 iOS 는 스크롤을 막는다 — r2 B-1)와 「조상에게 묻는 사이에 일어나는 일」(같은 PanResponder 를
// 조상·자손에 펼치면 이동이 삼켜진다)을 잴 수 없었다. 이 도우미는 그 둘을 잰다. 네이티브 스크롤뷰가
// 없으므로 「스크롤이 실제로 시작하는가」는 여전히 못 잰다 — 그것은 Maestro 105 의 「3 / 3」 단정이다.
//
// `PanResponder` 가 `touchHistory` 로 속도(`vy`, px/ms)를 계산하므로 그것도 진짜 모양으로 준다.
// -----------------------------------------------------------------------------
interface Sample {
  x: number;
  y: number;
  t: number;
}

function finger(target: Instance) {
  const chain = hostChain(target);
  let start: Sample = { x: 0, y: 0, t: 0 };
  let previous: Sample = start;
  let current: Sample = start;
  let clock = 1_000;
  let active = true;
  let count = 1;
  let responder: Instance | null = null;

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
      persist() {},
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

  /** `nodes` 를 차례로 물어 처음 참을 준 뷰를 돌려준다. */
  function ask(nodes: Instance[], handler: string): Instance | null {
    for (const node of nodes) {
      const fn = node.props[handler] as ((e: unknown) => unknown) | undefined;
      if (fn?.(event())) return node;
    }
    return null;
  }

  /** 응답자가 없으면 대상부터, 있으면 응답자의 **조상**부터(자신은 건너뛴다) capture → bubble 로 묻는다. */
  function negotiate(kind: 'Start' | 'Move'): Instance | null {
    const nodes = responder ? hostChain(responder).slice(1) : chain;
    return (
      ask([...nodes].reverse(), `on${kind}ShouldSetResponderCapture`) ??
      ask(nodes, `on${kind}ShouldSetResponder`)
    );
  }

  function grant(node: Instance) {
    responder = node;
    node.props.onResponderGrant?.(event());
    // 응답 시스템은 쥔 직후 같은 닿음을 Start 로도 알린다.
    node.props.onResponderStart?.(event());
  }

  /**
   * 다른 뷰가 응답을 달라고 한다. 응답 시스템은 양보를 묻기 **전에** 청한 쪽에 Grant 를 먼저 알리고(`setResponderAndExtractTransfer`),
   * 응답자가 양보하면 Terminate 와 함께 응답이 옮겨 가고, 아니면 청한 쪽이 Reject 를 받는다.
   */
  function transfer(to: Instance) {
    const from = responder;
    if (from === null) return grant(to);
    to.props.onResponderGrant?.(event());
    if (from.props.onResponderTerminationRequest?.(event())) {
      from.props.onResponderTerminate?.(event());
      responder = to;
    } else {
      to.props.onResponderReject?.(event());
    }
  }

  return {
    /** 지금 응답자(없으면 null). */
    get responder(): Instance | null {
      return responder;
    },
    /**
     * 화면에 손가락이 닿았다. `capture` 는 위에서 아래로 가는 capture 가 쥐었는가(쥐면 안 된다 —
     * 그 아래 단추의 탭이 죽는다), `granted` 는 bubble 에서 누가 쥐었는가.
     */
    down(x: number, y: number, fingers = 1): { capture: boolean; granted: boolean } {
      clock += 16;
      start = { x, y, t: clock };
      previous = start;
      current = start;
      active = true;
      count = fingers; // 2 면 두 손가락이 한 터치 이벤트로 한꺼번에 닿은 것이다(핀치)
      responder = null;
      let capture = false;
      act(() => {
        let winner = ask([...chain].reverse(), 'onStartShouldSetResponderCapture');
        capture = winner !== null;
        winner ??= ask(chain, 'onStartShouldSetResponder');
        if (winner) grant(winner);
      });
      return { capture, granted: responder !== null };
    },
    /** 손가락이 움직였다. 응답자의 조상들에게 먼저 묻고, 그다음 응답자가 이동을 받는다. */
    move(x: number, y: number, dt = 16) {
      clock += dt;
      previous = current;
      current = { x, y, t: clock };
      act(() => {
        const wants = negotiate('Move');
        if (wants && wants !== responder) transfer(wants);
        responder?.props.onResponderMove?.(event());
      });
    },
    /**
     * 둘째 손가락이 닿았다. 응답자의 조상들에게 다시 묻고, 응답자는 Start 로 그것을 안다. 돌려주는 것은 응답을 **청한**
     * 뷰다(없으면 null) — 청하는 것은 뒤의 행뿐이어야 하고 뷰어의 뿌리여서는 안 된다.
     */
    second(): Instance | null {
      count = 2;
      clock += 16;
      let wanted: Instance | null = null;
      act(() => {
        wanted = negotiate('Start');
        if (wanted && wanted !== responder) transfer(wanted);
        responder?.props.onResponderStart?.(event());
      });
      return wanted;
    },
    /** 손가락을 뗐다. */
    up() {
      active = false;
      act(() => {
        responder?.props.onResponderRelease?.(event());
        responder = null;
      });
    },
    /** 응답 시스템이 제스처를 빼앗았다(스크롤뷰·가장자리 뒤로가기·전화·OS 취소). */
    terminate() {
      act(() => {
        responder?.props.onResponderTerminate?.(event());
        responder = null;
      });
    },
    /** 다른 응답자(가로 스크롤뷰·가장자리 뒤로가기)가 응답을 달라고 한다. 양보하면 true. */
    yields(): boolean {
      return Boolean(responder?.props.onResponderTerminationRequest?.(event()));
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
  /**
   * 바깥 「메시지 행」이 눌림을 받은 횟수(`inRow` 로 감쌌을 때만 의미가 있다). 행은 진짜 `Pressable` 이라 응답을 받는 순간
   * (`onResponderGrant`) `onPressIn` 이 불린다 — 그 Grant 는 양보를 묻기 **전에** 오고, Pressability 는 Reject 를 다루지
   * 않으므로 한 번 받으면 눌린 채 길게 누르기 타이머가 선다.
   */
  rowGrants: jest.Mock;
}

/**
 * `inRow` 는 앱의 모양을 흉내 낸다: 뷰어 Modal 은 `MessageRow` 의 React **자손**이라, 뷰어 안에서 아무도 쥐지
 * 않은 터치는 위로 번져 행의 `Pressable` 이 쥔다(탭이 행을 누르고, 길게 누르면 뒤에서 행 시트가 열린다).
 * 그 행을 「닿으면 언제나 쥐는 뷰」로 세운다.
 */
async function mount(
  over: Partial<React.ComponentProps<typeof AttachmentViewer>> = {},
  options: { inRow?: boolean } = {},
): Promise<Mounted> {
  const onClose = jest.fn();
  const rowGrants = jest.fn();
  const progress = { current: null as number | null };
  const viewer = (
    <AttachmentViewer
      workspaceId="ws"
      channelId="ch"
      images={IMAGES}
      startIndex={0}
      onClose={onClose}
      progressRef={progress}
      {...over}
    />
  );
  render(
    options.inRow ? (
      <Pressable testID="message-row" onPressIn={rowGrants}>
        {viewer}
      </Pressable>
    ) : (
      viewer
    ),
  );
  // 쪽마다 미리보기를 받는다 — 도착을 기다려 둬야 act 밖의 갱신이 시험 밖으로 새지 않는다.
  await screen.findAllByTestId('attachment-viewer-image');
  return { onClose, progress, rowGrants };
}

const root = () => screen.getByTestId('attachment-viewer');
/** 사진(`index` 쪽의 그림) — 사람이 쓸어 닫으려고 손가락을 올리는 자리. */
const photo = (index = 0) => screen.getAllByTestId('attachment-viewer-image')[index] as Instance;
const scrollView = () => screen.getByTestId('attachment-viewer-scroll');

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

  it('띠의 글자는 크롬이라 글자 크기 상한을 갖는다 — 가장 큰 글자 크기에서 띠가 사진 영역을 먹지 않는다', async () => {
    // 띠는 흐름 안에 서므로 글자가 무한히 자라면 사진 영역이 줄어든다. 상한 정책(`atoms.tsx`): 크롬만 상한을 갖는다.
    await mount();
    for (const label of [
      screen.getByTestId('attachment-viewer-position'),
      screen.getByText('공유'),
    ]) {
      expect(label.props.maxFontSizeMultiplier).toBe(BAR_CONTROL_MAX_SCALE);
    }
  });

  it('닫기는 글자가 아니라 시트와 같은 X 글리프다 — 이름·누르는 면은 그대로이고 글자 「닫기」는 없다 (#4458)', async () => {
    await mount();
    const close = screen.getByTestId('attachment-viewer-close');
    expect(close.props.accessibilityLabel).toBe('닫기');
    expect(within(close).UNSAFE_getByType(Image).props.source).toBe(SHEET_ICONS.close);
    expect(screen.queryByText('닫기')).toBeNull();
    // 글리프는 크롬이라 글자 배율을 따라가지 않는다(이미지) — 누르는 면은 글리프가 아니라 단추 상자가 정한다.
    const style = flatten(close.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  it('인셋은 Modal **안의** SafeAreaProvider 가 준다 — Modal 은 앱 루트와 다른 네이티브 계층이다', async () => {
    // 대역은 SafeAreaProvider 를 투명하게 지나가므로, 눈에 보이는 상자로 바꿔 자리를 본다:
    // 제공자는 Modal 의 자식이고, 뷰어 뿌리는 그 제공자의 자식이다. 제공자를 걷어내면 빨갛다.
    const safeArea = require('react-native-safe-area-context');
    jest
      .spyOn(safeArea, 'SafeAreaProvider')
      .mockImplementation((props: unknown) => (
        <View testID="viewer-safe-area-provider">
          {(props as { children: React.ReactNode }).children}
        </View>
      ));
    await mount();
    const modal = screen.getByTestId('attachment-viewer-modal');
    const provider = within(modal).getByTestId('viewer-safe-area-provider');
    expect(within(provider).getByTestId('attachment-viewer')).toBeTruthy();
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
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT - 1);
    expect(progress.current).toBe(DISMISS_DISTANCE_PT - 1);
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('100pt 를 넘게 천천히 내렸다 놓으면 닫는다', async () => {
    const { onClose } = await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT + 1);
    touch.up();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('짧아도 빠르게(0.75px/ms = 750pt/s) 튕기면 닫는다', async () => {
    const { onClose, progress } = await mount();
    const flick = finger(photo());
    flick.down(200, 300);
    flick.move(200, 312, 16); // 문턱을 넘어 가져간다
    flick.move(200, 324, 16); // 12pt / 16ms = 0.75px/ms
    flick.up();
    expect(progress.current).toBe(24); // 100pt 에는 한참 모자라다
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('같은 거리를 0.65px/ms(650pt/s)로 튕기면 돌아간다 — 문턱은 700 이다', async () => {
    const { onClose, progress } = await mount();
    const drift = finger(photo());
    drift.down(200, 300);
    drift.move(200, 312, 16);
    drift.move(200, 322.4, 16); // 10.4pt / 16ms = 0.65px/ms
    drift.up();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('끄는 동안 사진은 손가락이 간 만큼 — 매 걸음, 시작점에서 잰다', async () => {
    const { progress } = await mount();
    const touch = finger(photo());
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

  it('닿는 순간 응답은 뷰어가 쥔다 — capture 는 걸지 않는다(걸면 그 아래 단추의 탭이 죽는다)', async () => {
    await mount();
    const touch = finger(photo());
    const { capture, granted } = touch.down(200, 300);
    expect(granted).toBe(true);
    expect(capture).toBe(false);
  });

  it('문턱 안의 움직임과 탭은 아무것도 끌지 않는다 — 닫기 단추의 탭이 산다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    touch.move(200, 307);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('attachment-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('가로로 넘기는 손가락은 가져가지 않고, 응답도 양보한다 — 페이지 넘김의 길이다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
    touch.down(300, 400);
    // 오른쪽으로 크게, 아래로는 조금.
    for (const [x, y] of [
      [270, 405],
      [220, 412],
      [150, 420],
      [60, 430],
    ] as const) {
      touch.move(x, y);
    }
    expect(progress.current).toBeNull();
    expect(touch.yields()).toBe(true); // 가로 ScrollView 가 응답을 달라고 하면 내준다
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('가로로 시작한 손가락은 나중에 아래로 꺾여도 가져가지 않는다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
    touch.down(300, 300);
    touch.move(270, 302); // 가로로 문턱을 넘었다
    for (const dy of [60, 160, 260]) touch.move(268, 300 + dy);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('위로 올리는 손가락은 가져가지 않는다', async () => {
    const { progress } = await mount();
    const touch = finger(photo());
    touch.down(200, 600);
    touch.move(200, 560);
    touch.move(200, 480);
    expect(progress.current).toBeNull();
  });

  it('꺼져 있으면(확대 중) 아무리 내려도 가져가지 않는다', async () => {
    const { onClose, progress } = await mount({ dismissEnabled: false });
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 400);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('끌던 중 둘째 손가락이 닿으면 취소다 — 제자리로 돌아오고, 놓아도 닫히지 않는다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
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
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 150);
    touch.terminate();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBe(0);
  });

  it('끌기를 가져가기 전에는 응답을 양보하고(가장자리 뒤로가기가 가져갈 수 있다), 가져간 뒤에는 거절한다', async () => {
    await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    expect(touch.yields()).toBe(true);
    dragSlowly(touch, 200, 300, 60);
    // 잡았으면 놓지 않는다 — 밑의 스크롤뷰가 도중에 되가져가면 사진이 손가락을 놓친다.
    expect(touch.yields()).toBe(false);
  });
});

describe('③ 응답을 쥐는 자리 — 가로 넘김을 죽이지 않는다 (design-review r2 B-1)', () => {
  // r2 가 시뮬레이터에서 본 것: 「2 / 3」에서 옆으로 쓸어도 넘어가지 않았다. 뿌리 View 가 닿는 순간 JS 응답자가
  // 되었고, 뿌리는 가로 ScrollView 의 조상이다 — iOS(Fabric) 의 ScrollView 는 superview 사슬 중 하나라도 JS
  // 응답자이면 스크롤을 시작하지 못한다(`RCTScrollViewComponentView._shouldDisableScrollInteraction`).
  // jest 에는 네이티브 스크롤뷰가 없어서 「스크롤이 시작하는가」는 못 잰다(Maestro 105 의 「3 / 3」 단정이 잰다).
  // 여기서 잴 수 있는 것은 그 원인이다: **누가 쥐는가**, 그리고 쥔 뒤 협상에서 무슨 일이 일어나는가.

  it('사진 위에 닿은 손가락을 쥐는 뷰는 가로 스크롤뷰의 조상이 아니다 — 모든 쪽, 그림 위든 빈 곳이든', async () => {
    await mount();
    const scroll = scrollView();
    for (const index of [0, 1, 2]) {
      const pages = screen.getAllByTestId('attachment-viewer-page');
      for (const target of [photo(index), pages[index] as Instance]) {
        const touch = finger(target);
        expect(touch.down(200, 300).granted).toBe(true);
        const grabbed = touch.responder as Instance;
        // iOS 가 스크롤을 막는 조건의 거울상: 응답자가 스크롤뷰의 조상이면 안 된다.
        expect(isAncestor(grabbed, scroll)).toBe(false);
        // 쥔 것은 스크롤뷰 **안**의 쪽이다.
        expect(isAncestor(scroll, grabbed)).toBe(true);
        expect(grabbed.props.testID).toBe('attachment-viewer-page');
        touch.up();
      }
    }
  });

  it('쪽 View 는 평탄화되지 않는다 — 레이아웃 속성만 있는 View 는 네이티브 뷰가 사라져 닿는 대상이 못 된다', async () => {
    await mount();
    for (const page of screen.getAllByTestId('attachment-viewer-page')) {
      expect(page.props.collapsable).toBe(false);
    }
  });

  it('사진 밖(단추 띠의 빈 곳·홈 인디케이터 인셋)에 닿은 손가락은 뿌리가 쥔다 — 뒤의 메시지 행이 가져가지 못한다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    const { rowGrants } = await mount({}, { inRow: true });
    for (const id of ['attachment-viewer-bar', 'attachment-viewer-pager']) {
      const touch = finger(screen.getByTestId(id));
      expect(touch.down(200, 40).granted).toBe(true);
      // ReactTestInstance 를 `toBe` 로 비교하면 실패할 때 jest 가 파이버 그래프를 통째로 찍다 메모리가 터진다 — 불리언으로 비교한다.
      expect(touch.responder === root()).toBe(true);
      touch.up();
    }
    expect(rowGrants).not.toHaveBeenCalled();
  });

  it('사진 위에 닿은 손가락도 뒤의 메시지 행이 가져가지 못한다 — 쪽이 먼저 쥔다', async () => {
    const { rowGrants } = await mount({}, { inRow: true });
    const touch = finger(photo());
    touch.down(200, 300);
    expect(touch.responder?.props.testID).toBe('attachment-viewer-page');
    // 끌기도 행의 개입 없이 쪽에서 이어진다.
    dragSlowly(touch, 200, 300, 60);
    touch.up();
    expect(rowGrants).not.toHaveBeenCalled();
  });

  it('쪽이 쥔 채 끄는 동안 뿌리가 이동을 삼키지 않는다 — 같은 PanResponder 를 조상·자손에 펼치면 끌기가 한 걸음도 안 간다', async () => {
    // 응답자가 쪽이면 응답 시스템은 이동마다 쪽의 **조상**(뿌리)에게 `onMoveShouldSetResponder(Capture)` 를
    // 묻는다. 뿌리가 PanResponder 의 그 핸들러를 갖고 있으면 공유 gestureState 를 먼저 갱신해, 같은 이동의
    // `onResponderMove` 가 「이미 처리함」으로 건너뛰어진다. 뿌리에는 그 둘이 없어야 한다.
    const { progress } = await mount();
    const root_ = root();
    expect(root_.props.onMoveShouldSetResponder).toBeUndefined();
    expect(root_.props.onMoveShouldSetResponderCapture).toBeUndefined();
    const touch = finger(photo());
    touch.down(200, 300);
    touch.move(200, 312); // 문턱을 넘어 가져간다
    expect(progress.current).toBe(12);
    for (const dy of [30, 80, 160]) {
      touch.move(200, 300 + dy);
      expect(progress.current).toBe(dy); // 매 걸음이 사진에 닿는다
    }
  });

  it('쪽이 쥔 채 둘째 손가락이 닿아도 뿌리(스크롤뷰의 조상)는 응답을 청하지 않는다 — 청하는 것은 방패뿐이고 쪽은 거절한다', async () => {
    // 뿌리가 청하고 쪽이 양보하면 응답이 뿌리로 옮겨 가 스크롤이 시작하지 못한다(조상이 JS 응답자가 되므로). 뿌리의 Grant 는
    // 공유 규칙 상태도 건드린다(끌던 중이면 취소를 삼킨다). 그래서 뿌리의 시작 가드가 둘째 손가락을 거절해야 한다.
    await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    const first = touch.responder;
    const wanted = touch.second();
    expect(wanted?.props.testID).toBe('attachment-viewer-shield'); // 뿌리가 아니다
    expect(touch.responder === first).toBe(true); // 쪽이 거절했다
    expect(touch.responder?.props.testID).toBe('attachment-viewer-page');
  });

  it('쪽이 쥔 채 둘째 손가락이 닿으면 방패가 청하고 쪽은 거절한다 — 뒤의 메시지 행은 묻지도 못한다 (r3 M-2)', async () => {
    // RN 은 양보를 묻기 전에 청한 뷰에 Grant 를 알린다 → 행(Pressable)은 Grant 로 길게 누르기 타이머를 시작한다.
    // 거절만으로는 못 막고, 행에 닿기 전에 항상 참을 주는 뷰어 소유의 조상(방패)이 묻는 길을 끝내야 한다.
    const { rowGrants } = await mount({}, { inRow: true });
    const touch = finger(photo());
    touch.down(200, 300); // 끌기를 쥐기 전: 한 손가락일 때는 양보한다(가로 넘김·가장자리 뒤로가기)
    expect(touch.yields()).toBe(true);
    const wanted = touch.second();
    expect(wanted?.props.testID).toBe('attachment-viewer-shield'); // 청한 것은 방패뿐이다 — 뿌리도 행도 아니다
    expect(touch.responder?.props.testID).toBe('attachment-viewer-page'); // 응답은 그대로다
    expect(rowGrants).not.toHaveBeenCalled(); // 행은 Grant 도 받지 못했다 — 눌림도 길게 누르기 타이머도 서지 않는다
    expect(touch.yields()).toBe(false); // 손가락이 둘인 동안은 끌기를 쥐기 전에도 양보하지 않는다
  });

  it('뿌리가 쥔 채(단추 띠의 빈 곳을 짚은 채) 둘째 손가락이 닿아도 방패가 청하고 뿌리는 양보하지 않는다 (r3 L-8)', async () => {
    // 뿌리가 응답자이면 뿌리는 「응답자 자신」이라 묻는 길에서 건너뛰어진다 — capture 가 돌지 않아 gestureState 의 손가락 수는
    // 아직 1 이다. 이벤트의 터치 수를 함께 읽어야 뿌리도 거절한다.
    const { rowGrants } = await mount({}, { inRow: true });
    const touch = finger(screen.getByTestId('attachment-viewer-bar'));
    touch.down(200, 70);
    expect(touch.responder === root()).toBe(true);
    const wanted = touch.second();
    expect(wanted?.props.testID).toBe('attachment-viewer-shield');
    expect(touch.responder === root()).toBe(true); // 응답은 뿌리에 그대로다
    expect(rowGrants).not.toHaveBeenCalled();
  });

  it('방패는 첫 손가락에는 나서지 않는다 — 쪽·뿌리가 먼저 쥔다', async () => {
    await mount({}, { inRow: true });
    for (const target of [photo(), screen.getByTestId('attachment-viewer-bar'), screen.getByTestId('attachment-viewer-pager')]) {
      const touch = finger(target);
      touch.down(200, 300);
      expect(touch.responder?.props.testID).not.toBe('attachment-viewer-shield');
      touch.up();
    }
  });

  it('두 손가락이 한꺼번에 닿아도(핀치) 쪽이 쥔다 — 뒤의 메시지 행이 가져가지 못한다 (r3 M-2)', async () => {
    // 첫 가드(`touches <= 1`)는 이 길을 열었다: 쪽도 뿌리도 쥐지 않아 행이 곧바로 응답자가 됐다.
    const { rowGrants } = await mount({}, { inRow: true });
    const touch = finger(photo());
    expect(touch.down(200, 300, 2).granted).toBe(true);
    expect(touch.responder?.props.testID).toBe('attachment-viewer-page');
    expect(rowGrants).not.toHaveBeenCalled();
  });

  it('손가락 둘이 한꺼번에 닿은 제스처는 끌기를 가져가지 않는다 — 핀치는 뷰어를 닫지 않는다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
    touch.down(200, 300, 2);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT + 40);
    expect(progress.current).toBeNull();
    touch.up();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('단추 띠의 빈 곳에서 시작한 끌기도 닫는다 — 뿌리가 쥔 손가락은 뿌리가 끝까지 따라간다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(screen.getByTestId('attachment-viewer-bar'));
    touch.down(200, 70);
    expect(touch.responder === root()).toBe(true);
    dragSlowly(touch, 200, 70, DISMISS_DISTANCE_PT + 40);
    expect(progress.current).toBe(DISMISS_DISTANCE_PT + 40);
    touch.up();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('닫기 단추는 쪽·뿌리보다 깊어서 자기 탭을 그대로 쥔다 — 응답을 뷰어가 가로채지 않는다', async () => {
    const { onClose } = await mount({}, { inRow: true });
    const close = screen.getByTestId('attachment-viewer-close');
    // Pressable 은 자기 핸들러로 쥔다 — 뷰어의 부분 집합이 아니라 단추가 먼저 묻는다.
    const chain = hostChain(close);
    const first = chain.find(node => typeof node.props.onStartShouldSetResponder === 'function');
    expect(first === undefined).toBe(false);
    expect(first === root()).toBe(false);
    fireEvent.press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('④ 끌기를 쥐면 가로 스크롤을 잠근다 (대각선 끌기)', () => {
  // 시뮬레이터 대각선 끌기에서 본 것: 사진이 내려가는 동안 가로 ScrollView 의 네이티브 팬도 같은 손가락의 가로 성분을
  // 따라가, 옆 장이 끌려 들어왔다(`directionalLockEnabled` 는 이를 막지 못했다). 끌기를 쥐는 순간 스크롤을 잠그고,
  // 끝나면 풀어 현재 쪽의 정확한 자리에 다시 맞춘다. 네이티브 스크롤뷰가 없어 「실제로 안 따라가는가」는 못 잰다
  // (대각선 녹화 `drag-diagonal` 로 보았다) — 여기서 재는 것은 잠금의 시작·끝이다.
  const { width } = Dimensions.get('window');
  const scrollTo = () => ScrollView.prototype.scrollTo as unknown as jest.Mock;
  const locked = () => scrollView().props.scrollEnabled === false;

  beforeEach(() => {
    scrollTo().mockClear();
  });

  it('평소에는 스크롤이 켜져 있고, 첫 렌더에서 다시 맞추지 않는다', async () => {
    await mount({ startIndex: 1 });
    expect(locked()).toBe(false);
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  it('끌기를 쥐는 순간 잠그고 현재 쪽에 맞춘다 — 문턱 안의 움직임은 잠그지 않는다', async () => {
    await mount({ startIndex: 1 });
    const touch = finger(photo(1));
    touch.down(200, 300);
    touch.move(200, 307); // 문턱(8pt) 안: 탭이거나 떨림
    expect(locked()).toBe(false);
    touch.move(200, 312); // 쥔다
    expect(locked()).toBe(true);
    expect(scrollTo()).toHaveBeenLastCalledWith({ x: width, y: 0, animated: false });
  });

  it('놓으면(제자리로 돌아옴) 풀고 현재 쪽에 다시 맞춘다', async () => {
    await mount({ startIndex: 1 });
    const touch = finger(photo(1));
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 60);
    expect(locked()).toBe(true);
    touch.up();
    expect(locked()).toBe(false);
    expect(scrollTo()).toHaveBeenCalledTimes(2); // 쥘 때, 끝날 때
    expect(scrollTo()).toHaveBeenLastCalledWith({ x: width, y: 0, animated: false });
  });

  it('응답 시스템이 빼앗아도(전화·OS 취소) 풀린다 — 잠긴 채로 남지 않는다', async () => {
    await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 60);
    expect(locked()).toBe(true);
    touch.terminate();
    expect(locked()).toBe(false);
  });

  it('둘째 손가락이 닿아 끌기가 취소되면 풀린다', async () => {
    await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 60);
    expect(locked()).toBe(true);
    touch.second();
    expect(locked()).toBe(false);
  });

  it('가로로 넘기는 손가락은 잠그지 않는다 — 페이지 넘김이 산다', async () => {
    await mount();
    const touch = finger(photo());
    touch.down(300, 400);
    for (const [x, y] of [
      [270, 405],
      [220, 412],
      [150, 420],
    ] as const) {
      touch.move(x, y);
    }
    expect(locked()).toBe(false);
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  it('꺼져 있으면(확대 중) 아무리 내려도 잠그지 않는다', async () => {
    await mount({ dismissEnabled: false });
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, 200);
    expect(locked()).toBe(false);
  });

  it('닫는 끌기도 끝에서 푼다 — 뷰어가 닫히기 전에 잠금이 새지 않는다', async () => {
    await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    dragSlowly(touch, 200, 300, DISMISS_DISTANCE_PT + 40);
    expect(locked()).toBe(true);
    touch.up();
    expect(locked()).toBe(false);
  });
});

describe('동작 줄이기', () => {
  it('꺼져 있으면 모자라게 놓았을 때 스프링으로 돌아온다 — Buzz 260ms/0.14 를 옮긴 값으로', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mount();
    const touch = finger(photo());
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
    const touch = finger(photo());
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

  // r2 M-1: 뷰어는 열릴 때마다 새로 마운트되고 Modal 은 **첫 렌더의** `animationType` 으로 이미 떠 버린다.
  // 위 시험은 설정의 답이 도착한 **뒤**의 값만 읽어서 바로 이 순간을 비껴갔다. 아래는 마운트 직후 — 뷰어
  // 자신의 설정 답이 오기 전 — 의 값을 읽는다(`render` 는 동기라 그 사이에 답이 끼어들지 못한다).
  describe('열리는 순간의 Modal (r2 M-1)', () => {
    const opening = () => screen.getByTestId('attachment-viewer-modal').props.animationType;

    function open() {
      render(
        <AttachmentViewer
          workspaceId="ws"
          channelId="ch"
          images={IMAGES}
          startIndex={0}
          onClose={jest.fn()}
        />,
      );
      return opening();
    }

    /** 앱이 시작 때 한 번 읽어 간직한다(`App.tsx`) — 그 뒤 새로 열리는 뷰어. */
    async function appKnows(reduce: boolean) {
      a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(reduce));
      const release = retainReduceMotion();
      await act(async () => {}); // 앱의 첫 읽기가 끝난다
      return release;
    }

    it('앱이 동작 줄이기가 켜져 있음을 이미 알면, 새로 열린 뷰어는 첫 렌더부터 페이드 없이 선다', async () => {
      const release = await appKnows(true);
      try {
        expect(open()).toBe('none');
        await screen.findAllByTestId('attachment-viewer-image');
        expect(opening()).toBe('none');
      } finally {
        release();
      }
    });

    it('앱이 꺼져 있음을 이미 알면, 첫 렌더부터 시스템 페이드로 선다', async () => {
      const release = await appKnows(false);
      try {
        expect(open()).toBe('fade');
        await screen.findAllByTestId('attachment-viewer-image');
      } finally {
        release();
      }
    });

    it('앱이 아직 모르면 모두의 첫 모습은 평소대로 페이드다 — 켠 사람은 답이 오면 그때부터 페이드가 없다', async () => {
      a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
      expect(open()).toBe('fade'); // 아직 모른다: 켠 사람의 첫 모습을 위해 모두의 모습을 바꾸지 않는다
      await act(async () => {}); // 설정의 답이 도착한다
      expect(opening()).toBe('none');
      await screen.findAllByTestId('attachment-viewer-image');
    });

    it('꺼진 기기에서 모르는 동안의 첫 모습도 페이드다 — 모르는 동안을 「켜짐」으로 보면 모두의 첫 모습이 바뀐다', async () => {
      a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
      expect(open()).toBe('fade');
      await screen.findAllByTestId('attachment-viewer-image');
      expect(opening()).toBe('fade');
    });

    it('앱이 알고 있는 동안 설정이 바뀌면, 이후에 열리는 뷰어가 새 값으로 선다', async () => {
      // RN 의 대역은 호출 기록이 시험 사이로 쌓인다 — 이 시험의 구독만 남긴다.
      jest.mocked(AccessibilityInfo.addEventListener).mockClear();
      const release = await appKnows(false);
      try {
        const calls = jest.mocked(AccessibilityInfo.addEventListener).mock
          .calls as unknown as Array<[string, (value: boolean) => void]>;
        const subscription = calls.find(([name]) => name === 'reduceMotionChanged');
        expect(subscription).toBeDefined();
        act(() => {
          subscription?.[1](true); // 사람이 설정에서 켠다
        });
        expect(open()).toBe('none');
        await screen.findAllByTestId('attachment-viewer-image');
      } finally {
        release();
      }
    });
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
    const touch = finger(photo());
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
