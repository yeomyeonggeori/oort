import type { MessageAttachment } from '@momo/core/lib/api';
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
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  View,
  type NativeTouchEvent,
} from 'react-native';

import { BAR_CONTROL_MAX_SCALE } from '../src/design/atoms';
import { CONV_ICONS, SHEET_ICONS, VIEWER_ICONS } from '../src/design/icons';
import { photoStage, TOUCH_TARGET } from '../src/design/tokens';
import {
  EASE_OUT,
  VIEWER_CHROME_HIDE_MS,
  VIEWER_CHROME_SHOW_MS,
  VIEWER_SNAP_SPRING,
} from '../src/design/motion';
import { FixedScheme } from '../src/design/theme';
import {
  resetBlurSupportForTests,
  resetLiquidGlassSupportForTests,
} from '../src/design/glass';
import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { AttachmentViewer } from '../src/features/attachments/AttachmentViewer';
import { resetAttachmentContentForTest } from '../src/features/attachments/content';
import { DISMISS_DISTANCE_PT } from '../src/features/attachments/viewerDismiss';
import {
  VIEWER,
  VIEWER_GLASS_TONE,
  VIEWER_STAGE,
  viewerScrimFade,
  viewerScrimFadeAlpha,
  viewerScrimPlateau,
  viewerStamp,
} from '../src/features/attachments/viewerDesign';
import {
  DOUBLE_TAP_MS,
  ZOOMED_A11Y_VALUE,
} from '../src/features/attachments/viewerZoom';
import { retainReduceMotion } from '../src/lib/useReduceMotion';
import { installTimersOnlyClock } from './fixtures/fakeClock';

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

/** 보낸 시각 — 지역 시간으로 지어 시험이 어느 시간대에서 돌아도 같은 글이 된다. */
const SENT_AT = new Date(2026, 9, 29, 14, 55).getTime();

// ---- 색 관계를 재는 도구(⑧·⑪) ------------------------------------------------------------
type Rgb = [number, number, number];
const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];
/** `rgba(r, g, b, a)` 또는 `#rrggbb` 를 `base` 위에 합성한 색. */
const composite = (color: string, base: Rgb): Rgb => {
  if (color.startsWith('#')) return hex(color);
  const [r, g, b, a] = (color.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number, number];
  return [r, g, b].map((channel, i) => Math.round(channel * a + (base[i] as number) * (1 - a))) as Rgb;
};
const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const BLACK = hex(VIEWER_STAGE.bg);
const WHITE: Rgb = [255, 255, 255];

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

/**
 * 가짜 시계 안에서 `run` 을 하고 두 번 탭 문턱(`DOUBLE_TAP_MS`)이 지나게 한다 (#4769). 첫 탭은 두 번째 탭이 오는지 보려고 그만큼 기다린 **뒤에야**
 * 한 번 탭(조작 숨김·나타남)이 된다. 그래서 탭의 결과를 보는 단정은 문턱이 지난 뒤에 해야 한다 — 안 그러면 「탭해도 조작이 안 숨는다」는 단정이
 * 타이머가 아직 안 울렸다는 이유로 초록이 된다(실패할 수 없는 단정). 시계는 이 안에서만 가짜다: 미리보기를 기다리는 `mount` 는 진짜 시계로 돈다.
 */
function afterTapWindow(run: () => void) {
  installTimersOnlyClock();
  try {
    run();
    act(() => {
      jest.advanceTimersByTime(DOUBLE_TAP_MS);
    });
  } finally {
    jest.useRealTimers();
  }
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
  // 쪽마다 미리보기를 받는다 — 도착을 기다려 둬야 act 밖의 갱신이 시험 밖으로 새지 않는다. 썸네일(여러 장일 때)도 같은 미리보기를 받고,
  // 「동작 줄이기」·보조기술의 첫 답도 이 틱에 도착한다.
  await screen.findAllByTestId('attachment-viewer-image');
  await act(async () => {});
  return { onClose, progress, rowGrants };
}

const root = () => screen.getByTestId('attachment-viewer');
/** 사진(`index` 쪽의 그림) — 사람이 쓸어 닫으려고 손가락을 올리는 자리. */
const photo = (index = 0) => screen.getAllByTestId('attachment-viewer-image')[index] as Instance;
const scrollView = () => screen.getByTestId('attachment-viewer-scroll');

const a11y = AccessibilityInfo as unknown as {
  isReduceMotionEnabled: jest.Mock;
  isScreenReaderEnabled: jest.Mock;
  isReduceTransparencyEnabled: jest.Mock;
};

beforeEach(() => {
  resetAttachmentContentForTest();
  // 이 셋은 RN 의 대역이 하나의 jest.fn 이라 `spyOn` 으로 바꾼 답이 시험 사이로 샌다 — 시험마다 꺼짐으로 되돌린다.
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isScreenReaderEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
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
    // 이 한 줄이 이슈의 P0 다: 뒤로의 윗면이 인셋(상태 막대·다이내믹 아일랜드) 위로 올라가면 안 된다.
    expect(bar.paddingTop).toBe(insets.top);
    // 가로 여백은 평소 여백보다 좁아지지 않고, 노치 쪽 인셋보다도 좁아지지 않는다.
    expect(bar.paddingLeft).toBe(Math.max(VIEWER.edge, insets.left));
    expect(bar.paddingRight).toBe(Math.max(VIEWER.edge, insets.right));
    // #4297: 띠는 사진 **위에 뜬다**(화면 가득인 사진 위 절대 위치, 맨 위 0). 앞 판의 단정 「띠는 흐름 안에 선다」는 막대가
    // 사진 영역을 깎던 배치를 전제했다. 인셋을 넘지 않는다는 보장은 위치가 아니라 위 `paddingTop === insets.top` 이 진다.
    expect(bar.position).toBe('absolute');
    expect(bar.top).toBe(0);
  });

  it.each(Object.entries(DEVICES))('%s: 아래 조작은 홈 인디케이터 위에서 끝나고, 사진은 화면 가득이다', async (_name, insets) => {
    useInsets(insets);
    await mount();
    const actions = flatten(screen.getByTestId('attachment-viewer-actions').props.style);
    // 앞 판의 단정 「사진 영역이 인셋 위에서 끝난다」(`pager.paddingBottom === insets.bottom`)는 사진이 막대 사이에 끼던
    // 배치의 것이다. 이제 사진은 화면 가득이고(아래 단정), 홈 인디케이터를 피하는 것은 그 위에 뜬 조작이다.
    expect(actions.paddingBottom).toBeGreaterThanOrEqual(insets.bottom);
    expect(actions.paddingBottom).toBe(insets.bottom + VIEWER.bottomLift);
    expect(actions.position).toBe('absolute');
    expect(actions.bottom).toBe(0);
    const pager = flatten(screen.getByTestId('attachment-viewer-pager').props.style);
    expect([pager.top, pager.right, pager.bottom, pager.left]).toEqual([0, 0, 0, 0]);
    expect(pager.paddingBottom).toBeUndefined();
  });

  it('인셋이 0 인 기기에서는 0 이다 — 값을 지어내지 않는다', async () => {
    await mount();
    const bar = flatten(screen.getByTestId('attachment-viewer-bar').props.style);
    expect(bar.paddingTop).toBe(0);
  });

  it('뒤로·저장·공유는 두 변 모두 44pt 이상이다 — 둥근 단추라 두 변이 같다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    await mount();
    for (const id of ['attachment-viewer-back', 'attachment-viewer-save', 'attachment-viewer-share']) {
      const style = flatten(screen.getByTestId(id).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.width).toBe(style.height);
    }
  });

  it('조작의 글자는 크롬이라 글자 크기 상한을 갖는다 — 가장 큰 글자 크기에서 이름·캡션이 사진을 덮지 않는다', async () => {
    // 조작은 사진 위에 뜨므로 글자가 무한히 자라면 사진을 가린다. 상한 정책(`atoms.tsx`): 크롬만 상한을 갖는다.
    await mount({ senderName: '박서연', sentAtMs: SENT_AT });
    for (const label of [
      screen.getByTestId('attachment-viewer-sender'),
      screen.getByTestId('attachment-viewer-sent-at'),
      screen.getByTestId('attachment-viewer-position'),
    ]) {
      expect(label.props.maxFontSizeMultiplier).toBe(BAR_CONTROL_MAX_SCALE);
    }
  });

  it('뒤로는 글자가 아니라 ‹ 글리프다 — 이름은 「뒤로」이고 글자는 없다 (#4297: X 가 아니라 페이지의 나가는 문)', async () => {
    // 앞 판의 단정 「닫기는 시트와 같은 X 글리프다」(#4458)는 이 전체 화면이 시트처럼 X 로 닫히던 때의 것이다. 이 화면은 대화
    // 위에 한 겹 쌓이는 페이지라 한 겹 벗기고 돌아가는 문은 ‹ 이다(`phone-sheets.md` §3). 같은 단정이 지키던 것 — 글자가 아니라
    // 글리프이고, 이름·누르는 면이 정해져 있다 — 은 그대로 잰다.
    await mount();
    const back = screen.getByTestId('attachment-viewer-back');
    expect(back.props.accessibilityLabel).toBe('뒤로');
    expect(within(back).UNSAFE_getByType(Image).props.source).toBe(CONV_ICONS.left);
    expect(screen.queryByText('뒤로')).toBeNull();
    // X 는 없다(옛 닫기).
    expect(screen.queryByTestId('attachment-viewer-close')).toBeNull();
    for (const node of screen.UNSAFE_queryAllByType(Image)) {
      expect(node.props.source).not.toBe(SHEET_ICONS.close);
    }
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

describe('VoiceOver: 뒤로에 닿고 「뒤로」로 읽힌다', () => {
  it('뒤로는 버튼이고 이름이 「뒤로」다', async () => {
    await mount();
    const back = screen.getByTestId('attachment-viewer-back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.accessibilityLabel).toBe('뒤로');
  });

  it('읽는 순서에서 뒤로가 첫 번째다 — 사람은 뷰어에 들어서자마자 나갈 길을 만난다', async () => {
    await mount();
    const order = screen.getAllByRole('button').map(button => button.props.testID);
    expect(order[0]).toBe('attachment-viewer-back');
    // 아래 조작은 그 뒤에 선다: 저장·공유(썸네일은 그 사이 — 여러 장일 때).
    expect(order.slice(-2)).toEqual(['attachment-viewer-save', 'attachment-viewer-share']);
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

  it('뒤로 탭은 그대로 닫는다', async () => {
    const { onClose } = await mount();
    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
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

  it('문턱 안의 움직임과 탭은 아무것도 끌지 않는다 — 뒤로 단추의 탭이 산다', async () => {
    const { onClose, progress } = await mount();
    const touch = finger(photo());
    touch.down(200, 300);
    touch.move(200, 307);
    expect(progress.current).toBeNull();
    // #4769: 한 번 탭은 두 번 탭 문턱만큼 늦다 — 문턱이 지난 뒤에 조작이 숨는다.
    afterTapWindow(() => touch.up());
    expect(onClose).not.toHaveBeenCalled();
    // #4297: 사진을 한 번 누르면 조작이 숨는다 — 숨은 단추는 눌리지 않는다. 한 번 더 눌러 돌아오면 뒤로의 탭이 산다.
    // (숨은 덩어리는 접근성 트리에서 빠지므로 렌더러의 기본 질의에는 잡히지 않는다 — 숨은 것을 보려면 명시한다.)
    const hiddenBar = () => screen.getByTestId('attachment-viewer-bar', { includeHiddenElements: true });
    expect(hiddenBar().props.pointerEvents).toBe('none');
    const again = finger(photo());
    again.down(200, 300);
    afterTapWindow(() => again.up());
    expect(hiddenBar().props.pointerEvents).toBe('box-none');
    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
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

  it('사진 밖(조작 덩어리 자체·사진 영역 자체)에 닿은 손가락은 뿌리가 쥔다 — 뒤의 메시지 행이 가져가지 못한다', async () => {
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

  it('뒤로 단추는 쪽·뿌리보다 깊어서 자기 탭을 그대로 쥔다 — 응답을 뷰어가 가로채지 않는다', async () => {
    const { onClose } = await mount({}, { inRow: true });
    const close = screen.getByTestId('attachment-viewer-back');
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

  it('다이내믹 아일랜드 기기에서도 단추 띠가 인셋 아래에서 시작하고, 뒤로 탭이 닫는다', async () => {
    useInsets(DEVICES['다이내믹 아일랜드(16 Pro)']);
    await renderList();
    fireEvent.press(screen.getByTestId('attachment-item'));
    await screen.findByTestId('attachment-viewer-image');
    expect(
      flatten(screen.getByTestId('attachment-viewer-bar').props.style).paddingTop,
    ).toBe(59);
    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
  });
});


// =============================================================================
// 사진 뷰어 (#4297): 검정 무대 위에 떠 있는 유리 조작, 탭으로 숨김, 썸네일 줄.
//
// 위 여섯 묶음이 #4293 의 안전 영역·쓸어 닫기·응답 자리를 지킨다. 아래는 #4297 이 더한 것이다. 조작이 사진 **위에 뜨면서**
// 앞 판의 구조 보장(조작은 사진 밖이라 응답을 가져가지 않는다)이 자동으로는 성립하지 않게 됐다 — 그래서 첫 묶음이 그것을
// 렌더 트리의 `pointerEvents` 로 다시 못 박는다(jest 에는 네이티브 스크롤뷰가 없어 「옆으로 넘기기가 산다」를 직접 못 재므로 이
// 형태가 기계로 잴 수 있는 유일한 모양이다 — 실제로 살아 있는지는 Maestro 105 가 잰다).
// =============================================================================

/** 사진을 한 번 누른다(탭): 닿고, 문턱 안에서 뗀다. */
function tap(target: Instance = photo(), x = 200, y = 300) {
  const touch = finger(target);
  touch.down(x, y);
  touch.up();
}

/** 한 번 탭이 **일어난 뒤까지** 간다: 탭하고 두 번 탭 문턱이 지나게 한다(`afterTapWindow`). */
const tapOnce = (target?: Instance) => afterTapWindow(() => tap(target));

// 숨은 덩어리는 접근성 트리에서 빠진다(`accessibilityElementsHidden`) — 렌더러의 기본 질의는 그런 요소를 건너뛰므로 숨은 상태를
// 읽는 이 도우미들은 숨은 것도 포함해 묻는다.
const bar = () => screen.getByTestId('attachment-viewer-bar', { includeHiddenElements: true });
const actionsBlock = () => screen.getByTestId('attachment-viewer-actions', { includeHiddenElements: true });
const chromeIsShown = () =>
  bar().props.pointerEvents === 'box-none' && actionsBlock().props.pointerEvents === 'box-none';

describe('⑤ 조작 덩어리는 사진 위에 뜬다 — 빈 곳을 통과시키고, 숨으면 닿지도 읽히지도 않는다', () => {
  it('보일 때 두 덩어리는 빈 곳을 통과시킨다(box-none) — 글자는 닿지 않는다(none)', async () => {
    await mount({ senderName: '박서연', sentAtMs: SENT_AT });
    // 단추 옆·썸네일 줄 둘레의 빈 곳에 닿은 손가락이 위로 번져 뿌리에 닿으면 뿌리가 JS 응답자가 되어 그 아래 쪽의 옆으로
    // 넘기기가 죽는다(r2 B-1 의 재발 길). 덩어리가 통과시키면 손가락은 아래 쪽에 닿는다.
    expect(bar().props.pointerEvents).toBe('box-none');
    expect(actionsBlock().props.pointerEvents).toBe('box-none');
    expect(screen.getByTestId('attachment-viewer-stamp').props.pointerEvents).toBe('none');
    // 덩어리 자신은 응답자가 아니다(단추·줄이 자기 일을 쥐고 나머지는 통과한다).
    for (const block of [bar(), actionsBlock()]) {
      expect(block.props.onStartShouldSetResponder).toBeUndefined();
      expect(block.props.onMoveShouldSetResponder).toBeUndefined();
    }
  });

  it('탭하면 두 덩어리가 통째로 닿지 않고 읽히지 않는다 — 보이지 않는 44pt 단추가 남지 않는다', async () => {
    const { onClose } = await mount();
    expect(chromeIsShown()).toBe(true);
    expect(bar().props.accessibilityElementsHidden).toBe(false);
    tapOnce();
    for (const block of [bar(), actionsBlock()]) {
      expect(block.props.pointerEvents).toBe('none');
      expect(block.props.accessibilityElementsHidden).toBe(true);
      expect(block.props.importantForAccessibility).toBe('no-hide-descendants');
    }
    // 숨은 뒤로·저장·공유는 읽히지 않고(접근성 트리에서 빠진다) 눌리지도 않는다(렌더러가 `pointerEvents` 를 존중한다).
    expect(screen.queryByTestId('attachment-viewer-back')).toBeNull();
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull();
    const hiddenBack = screen.getByTestId('attachment-viewer-back', { includeHiddenElements: true });
    fireEvent.press(hiddenBack);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('다시 탭하면 돌아온다 — 두 덩어리가 같이, 읽히는 것도 같이', async () => {
    const { onClose } = await mount();
    tapOnce();
    expect(chromeIsShown()).toBe(false);
    tapOnce();
    expect(chromeIsShown()).toBe(true);
    for (const block of [bar(), actionsBlock()]) {
      expect(block.props.accessibilityElementsHidden).toBe(false);
    }
    // 돌아온 조작은 다시 읽히고 눌린다.
    expect(screen.getByRole('button', { name: '저장' })).toBeTruthy();
    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('탭은 닫지도 끌지도 않는다', async () => {
    const { onClose, progress } = await mount();
    tapOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(progress.current).toBeNull();
  });

  it('끌기·가로 넘김·핀치·빼앗김은 탭이 아니다 — 조작이 숨지 않는다', async () => {
    await mount();
    // 각 손짓은 두 번 탭 문턱이 **지난 뒤에** 본다: 탭으로 세었다면 그때 조작이 숨는다(문턱 전에 보면 타이머가 안 울렸을 뿐이라 헛돈다).
    // 아래로 끌다 모자라게 놓는다.
    const drag = finger(photo());
    drag.down(200, 300);
    dragSlowly(drag, 200, 300, 60);
    afterTapWindow(() => drag.up());
    expect(chromeIsShown()).toBe(true);
    // 옆으로 넘기던 손가락(스크롤뷰가 응답을 가져간다 — 놓음이 아니라 빼앗김).
    const swipe = finger(photo());
    swipe.down(300, 400);
    for (const [x, y] of [
      [270, 405],
      [200, 410],
      [120, 415],
    ] as const) {
      swipe.move(x, y);
    }
    afterTapWindow(() => swipe.terminate());
    expect(chromeIsShown()).toBe(true);
    // 가로로 문턱을 넘은 뒤 그대로 떼도(응답을 안 빼앗겼어도) 탭이 아니다.
    const lateral = finger(photo());
    lateral.down(300, 400);
    lateral.move(260, 402);
    afterTapWindow(() => lateral.up());
    expect(chromeIsShown()).toBe(true);
    // 두 손가락이 한꺼번에 닿았다 떼도 탭이 아니다.
    const pinch = finger(photo());
    pinch.down(200, 300, 2);
    afterTapWindow(() => pinch.up());
    expect(chromeIsShown()).toBe(true);
  });

  it('숨김·나타남은 불투명도 하나다 — 나타남 240 · 사라짐 180(사다리), 곡선 EASE_OUT, 네이티브 구동', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await mount();
    tapOnce();
    const configs = () => timing.mock.calls.map(call => call[1] as unknown as Record<string, unknown>);
    expect(configs()).toContainEqual(
      expect.objectContaining({
        toValue: 0,
        duration: VIEWER_CHROME_HIDE_MS,
        easing: EASE_OUT,
        useNativeDriver: true,
      }),
    );
    tapOnce();
    expect(configs()).toContainEqual(
      expect.objectContaining({
        toValue: 1,
        duration: VIEWER_CHROME_SHOW_MS,
        easing: EASE_OUT,
        useNativeDriver: true,
      }),
    );
    // 사다리의 비대칭: 사라짐은 나타남보다 짧다.
    expect(VIEWER_CHROME_HIDE_MS).toBeLessThan(VIEWER_CHROME_SHOW_MS);
  });

  it('동작 줄이기면 즉시 바뀐다 — 타이밍을 부르지 않는다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const timing = jest.spyOn(Animated, 'timing');
    await mount();
    await act(async () => {}); // 설정의 답이 도착한다
    tapOnce();
    expect(chromeIsShown()).toBe(false);
    tapOnce();
    expect(chromeIsShown()).toBe(true);
    expect(timing).not.toHaveBeenCalled();
  });

  it('VoiceOver 가 켜져 있으면 탭이 숨기지 않는다 — 숨은 조작을 다시 불러올 길이 빈 곳 누르기뿐이라 나가는 길을 잃는다', async () => {
    a11y.isScreenReaderEnabled.mockImplementation(() => Promise.resolve(true));
    await mount();
    await act(async () => {}); // 보조기술의 답이 도착한다
    tapOnce();
    expect(chromeIsShown()).toBe(true);
    expect(bar().props.accessibilityElementsHidden).toBe(false);
  });

  it('상태 막대 글자는 무대에 맞춰 밝다 — 앱 바탕이 라이트여도', async () => {
    await mount();
    expect(screen.UNSAFE_getByType(StatusBar).props.barStyle).toBe('light-content');
  });
});

describe('⑥ 썸네일 줄과 「N장 중 n번」', () => {
  const { width } = Dimensions.get('window');
  const scrollTo = () => ScrollView.prototype.scrollTo as unknown as jest.Mock;
  const thumbs = () => screen.getAllByTestId('attachment-viewer-thumb');
  const selected = () => thumbs().map(node => node.props.accessibilityState?.selected === true);
  const caption = () => screen.getByTestId('attachment-viewer-position').props.children;

  beforeEach(() => {
    scrollTo().mockClear();
  });

  it('두 장 이상이면 줄이 서고, 고른 장만 고른 표시이며, 캡션이 「3장 중 2번」이다', async () => {
    await mount({ startIndex: 1 });
    expect(thumbs()).toHaveLength(3);
    expect(selected()).toEqual([false, true, false]);
    expect(caption()).toBe('3장 중 2번');
    // 보조기술은 「n번째 사진」으로 읽는다.
    expect(screen.getByLabelText('3장 중 2번째 사진')).toBeTruthy();
    // 썸네일마다 사진이 서고, 쪽의 큰 사진과 testID 가 다르다(쪽을 세는 시험·손가락 시험이 어긋나지 않게).
    await waitFor(() => expect(screen.getAllByTestId('attachment-viewer-thumb-image')).toHaveLength(3));
    expect(screen.getAllByTestId('attachment-viewer-image')).toHaveLength(3);
  });

  it('고른 썸네일은 흰 테두리, 안 고른 것은 같은 두께의 투명 테두리다 — 고를 때 자리가 안 움직인다', async () => {
    await mount({ startIndex: 0 });
    const [first, second] = thumbs().map(node => flatten(node.props.style));
    expect(first?.borderColor).toBe(VIEWER_STAGE.ring);
    expect(second?.borderColor).toBe('transparent');
    expect(first?.borderWidth).toBe(VIEWER.thumbRing);
    expect(second?.borderWidth).toBe(VIEWER.thumbRing);
    // 카카오톡 노랑이 아니다.
    expect(String(first?.borderColor).toLowerCase()).not.toBe('#fee500');
  });

  it('썸네일을 누르면 그 장으로 간다 — 사진 스크롤뷰가 그 자리로 가고, 고른 표시와 캡션이 같이 바뀐다', async () => {
    await mount();
    fireEvent.press(thumbs()[2] as Instance);
    expect(scrollTo()).toHaveBeenCalledWith({ x: 2 * width, y: 0, animated: true });
    expect(selected()).toEqual([false, false, true]);
    expect(caption()).toBe('3장 중 3번');
    fireEvent.press(thumbs()[0] as Instance);
    expect(scrollTo()).toHaveBeenCalledWith({ x: 0, y: 0, animated: true });
    expect(selected()).toEqual([true, false, false]);
    expect(caption()).toBe('3장 중 1번');
  });

  it('동작 줄이기면 썸네일로의 이동이 즉시다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    await mount();
    await act(async () => {});
    scrollTo().mockClear();
    fireEvent.press(thumbs()[1] as Instance);
    expect(scrollTo()).toHaveBeenCalledWith({ x: width, y: 0, animated: false });
    expect(caption()).toBe('3장 중 2번');
  });

  it('옆으로 넘겨 장이 바뀌면 캡션과 고른 표시가 따라간다', async () => {
    await mount();
    expect(caption()).toBe('3장 중 1번');
    act(() => {
      fireEvent(scrollView(), 'momentumScrollEnd', {
        nativeEvent: { contentOffset: { x: width, y: 0 } },
      });
    });
    expect(caption()).toBe('3장 중 2번');
    expect(selected()).toEqual([false, true, false]);
  });

  it('한 장이면 줄도 캡션도 없다 — 위의 같은 자리가 두 장 이상에서는 서 있다', async () => {
    await mount({ images: [IMAGES[0] as MessageAttachment] });
    expect(screen.queryByTestId('attachment-viewer-strip')).toBeNull();
    expect(screen.queryAllByTestId('attachment-viewer-thumb')).toHaveLength(0);
    expect(screen.queryByTestId('attachment-viewer-position')).toBeNull();
    // 저장·공유는 한 장이어도 선다.
    expect(screen.getByTestId('attachment-viewer-save')).toBeTruthy();
    expect(screen.getByTestId('attachment-viewer-share')).toBeTruthy();
  });

  it('줄이 화면보다 길면 고른 장이 보이는 자리에서 시작한다', async () => {
    const many: MessageAttachment[] = Array.from({ length: 20 }, (_, n) => ({
      id: `m${n}`,
      name: `m${n}.png`,
      mime: 'image/png',
      sizeBytes: 4096,
    }));
    await mount({ images: many, startIndex: 19 });
    const strip = screen.getByTestId('attachment-viewer-strip');
    const offset = (strip.props.contentOffset as { x: number }).x;
    const viewport = width - 2 * VIEWER.edge;
    const left = 19 * (VIEWER.thumb + VIEWER.thumbStep);
    expect(offset).toBeGreaterThan(0);
    // 고른 썸네일 전체가 보이는 창 안에 있다.
    expect(left).toBeGreaterThanOrEqual(offset);
    expect(left + VIEWER.thumb).toBeLessThanOrEqual(offset + viewport);
  });
});

describe('⑦ 저장·공유 — 같은 공유 시트를 연다', () => {
  const save = () => screen.getByTestId('attachment-viewer-save');
  const share = () => screen.getByTestId('attachment-viewer-share');

  it('저장도 공유도 내려받아 iOS 공유 시트에 사진 파일을 넘긴다', async () => {
    const sheet = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    await mount();
    fireEvent.press(save());
    await waitFor(() => expect(sheet).toHaveBeenCalledTimes(1));
    expect(sheet.mock.calls[0]?.[0]).toMatchObject({ title: 'a.png', url: expect.any(String) });
    // 시트가 닫힌 뒤(성공) 단추가 다시 눌린다.
    await waitFor(() => expect(share().props.accessibilityState?.disabled).toBeFalsy());
    fireEvent.press(share());
    await waitFor(() => expect(sheet).toHaveBeenCalledTimes(2));
    expect(sheet.mock.calls[1]?.[0]).toMatchObject({ title: 'a.png', url: expect.any(String) });
  });

  it('저장은 보조기술에 「공유 시트가 열려요 — 이미지 저장을 고르세요」라고 말한다 — 사진 보관함에 직접 쓰지 않는다', async () => {
    await mount();
    expect(save().props.accessibilityLabel).toBe('저장');
    expect(save().props.accessibilityHint).toContain('공유 시트');
    expect(save().props.accessibilityHint).toContain('이미지 저장');
    expect(share().props.accessibilityLabel).toBe('공유');
    expect(share().props.accessibilityHint).toBeUndefined();
    // 글리프는 둘이 다르다(저장 = 내려받기, 공유 = 네모+위 화살표).
    expect(within(save()).UNSAFE_getByType(Image).props.source).toBe(VIEWER_ICONS.download);
    expect(within(share()).UNSAFE_getByType(Image).props.source).toBe(VIEWER_ICONS.share);
  });

  it('내려받는 동안 두 단추가 잠기고 누른 쪽만 돈다', async () => {
    let finish: () => void = () => {};
    jest.spyOn(Share, 'share').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ action: 'sharedAction' } as never);
        }),
    );
    await mount();
    fireEvent.press(save());
    await waitFor(() => expect(save().props.accessibilityState?.disabled).toBe(true));
    expect(share().props.accessibilityState?.disabled).toBe(true);
    expect(within(save()).UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);
    expect(within(share()).UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    expect(screen.getByTestId('attachment-viewer-status').props.children).toBe('내려받는 중');
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(save().props.accessibilityState?.disabled).toBeFalsy());
    expect(screen.queryByTestId('attachment-viewer-status')).toBeNull();
  });

  it('실패하면 안내가 서고(보조기술에도 알린다) 다시 누를 수 있다', async () => {
    const sheet = jest.spyOn(Share, 'share').mockRejectedValueOnce(new Error('boom'));
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await mount();
    fireEvent.press(share());
    await waitFor(() =>
      expect(screen.getByTestId('attachment-viewer-status').props.children).toBe('내려받기 실패 · 다시 시도'),
    );
    expect(announce).toHaveBeenCalledWith('내려받기 실패. 다시 시도');
    // 다시 누르면 다시 시도한다 — 단추는 잠기지 않았다.
    sheet.mockResolvedValueOnce({ action: 'sharedAction' } as never);
    fireEvent.press(share());
    await waitFor(() => expect(sheet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('attachment-viewer-status')).toBeNull());
  });

  it('격자(모아보기)·삭제·편집 같은 죽은 단추는 없다 — 있는 단추는 뒤로·썸네일·저장·공유뿐이다', async () => {
    await mount();
    const ids = screen.getAllByRole('button').map(node => node.props.testID);
    expect(ids).toEqual([
      'attachment-viewer-back',
      'attachment-viewer-thumb',
      'attachment-viewer-thumb',
      'attachment-viewer-thumb',
      'attachment-viewer-save',
      'attachment-viewer-share',
    ]);
  });
});

describe('⑧ 검정 무대는 테마와 무관하다 (폰 전용 값 — 값이 아니라 관계를 잰다)', () => {
  async function mountIn(scheme: 'light' | 'dark') {
    render(
      <FixedScheme scheme={scheme}>
        <AttachmentViewer
          workspaceId="ws"
          channelId="ch"
          images={IMAGES}
          startIndex={0}
          onClose={jest.fn()}
          senderName="박서연"
          sentAtMs={SENT_AT}
        />
      </FixedScheme>,
    );
    await screen.findAllByTestId('attachment-viewer-image');
  }

  it.each(['light', 'dark'] as const)('%s 테마에서도 바닥은 순흑이고 글자·글리프는 무대 위의 밝은 색이다', async scheme => {
    await mountIn(scheme);
    expect(flatten(screen.getByTestId('attachment-viewer-backdrop').props.style).backgroundColor).toBe('#000000');
    expect(flatten(screen.getByTestId('attachment-viewer-sender').props.style).color).toBe(VIEWER_STAGE.ink);
    expect(flatten(screen.getByTestId('attachment-viewer-sent-at').props.style).color).toBe(VIEWER_STAGE.inkMuted);
    expect(flatten(screen.getByTestId('attachment-viewer-position').props.style).color).toBe(VIEWER_STAGE.inkMuted);
    expect(within(screen.getByTestId('attachment-viewer-back')).UNSAFE_getByType(Image).props.style).toMatchObject({
      tintColor: VIEWER_STAGE.ink,
    });
  });

  // 관계: ① 무대 위 글자·글리프는 무대와 7:1 이상 ② 어두운 유리 면(대체·불투명) 위 글리프도 ③ 밝은 사진(순백) 위에 얹힌
  // 대체 면 위에서도 읽힌다. 색 값이 바뀌어도 이 관계가 살아야 한다.
  it('무대 위 글자·글리프는 무대와 7:1 이상이다', () => {
    expect(contrast(composite(VIEWER_STAGE.ink, BLACK), BLACK)).toBeGreaterThanOrEqual(7);
    expect(contrast(composite(VIEWER_STAGE.inkMuted, BLACK), BLACK)).toBeGreaterThanOrEqual(7);
    expect(contrast(composite(VIEWER_STAGE.danger, BLACK), BLACK)).toBeGreaterThanOrEqual(7);
  });

  it('어두운 유리의 불투명·대체 면 위 글리프도 7:1 이상이다 — 라이트 테마의 밝은 면 위 밝은 글리프가 되지 않는다', () => {
    const ink = composite(VIEWER_STAGE.ink, BLACK);
    expect(contrast(ink, composite(VIEWER_GLASS_TONE.opaque, BLACK))).toBeGreaterThanOrEqual(7);
    // 대체 면은 반투명이라 아래 사진이 비친다 — 최악은 순백 사진이다.
    expect(contrast(ink, composite(VIEWER_GLASS_TONE.fallback, WHITE))).toBeGreaterThanOrEqual(7);
  });
});

describe('⑨ 유리 — 블러 + 어두운 틴트다. 리퀴드는 쓰지 않는다', () => {
  const glass = (id: string) => `attachment-viewer-${id}-glass`;
  const IDS = ['back', 'save', 'share'] as const;

  afterEach(() => {
    resetBlurSupportForTests(null);
    resetLiquidGlassSupportForTests(null);
  });

  it('블러 모듈이 없으면 대체 면이 어둡다(톤 덮어쓰기) — 앱 테마의 밝은 대체 면이 아니다', async () => {
    resetBlurSupportForTests(false);
    await mount();
    for (const id of IDS) {
      const layer = screen.getByTestId(`${glass(id)}-fallback`);
      expect(flatten(layer.props.style).backgroundColor).toBe(VIEWER_GLASS_TONE.fallback);
    }
  });

  it('블러가 서는 기기에서는 어두운 흐림 + 어두운 틴트다 — 라이트 테마에서도', async () => {
    resetBlurSupportForTests(true);
    render(
      <FixedScheme scheme="light">
        <AttachmentViewer
          workspaceId="ws"
          channelId="ch"
          images={IMAGES}
          startIndex={0}
          onClose={jest.fn()}
        />
      </FixedScheme>,
    );
    await screen.findAllByTestId('attachment-viewer-image');
    const blurs = screen.getAllByTestId('blur-view');
    expect(blurs).toHaveLength(IDS.length);
    for (const node of blurs) expect(node.props.tint).toBe('dark');
    for (const id of IDS) {
      expect(flatten(screen.getByTestId(`${glass(id)}-blur`).props.style).backgroundColor).toBe(
        VIEWER_GLASS_TONE.tint,
      );
    }
  });

  it('iOS 26 리퀴드 글래스가 가능한 기기에서도 뷰어의 조작은 블러다 — 조상의 불투명도가 움직이는 곳에서 리퀴드는 평평해진다', async () => {
    resetBlurSupportForTests(true);
    resetLiquidGlassSupportForTests(true);
    await mount();
    for (const id of IDS) {
      expect(screen.queryByTestId(`${glass(id)}-liquid`)).toBeNull();
      expect(screen.getByTestId(`${glass(id)}-blur`)).toBeTruthy();
    }
  });

  it('투명도 줄이기가 켜지면 어두운 불투명 면이다 — 밝은 면 위 흰 글리프가 되지 않는다', async () => {
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    await mount();
    await act(async () => {});
    for (const id of IDS) {
      const layer = screen.getByTestId(`${glass(id)}-opaque`);
      expect(flatten(layer.props.style).backgroundColor).toBe(VIEWER_GLASS_TONE.opaque);
    }
  });

  it('가는 테두리는 유리 위에 그려지고 닿지 않는다 — 누르는 면이 그 안에 선다', async () => {
    await mount();
    const surface = screen.getByTestId(glass('back'));
    const rings = within(surface)
      .UNSAFE_getAllByType(View)
      .filter(
        node =>
          node.props.pointerEvents === 'none' &&
          flatten(node.props.style).borderWidth === StyleSheet.hairlineWidth,
      );
    expect(rings).toHaveLength(1);
    expect(flatten(rings[0]?.props.style).borderColor).toBe(VIEWER_STAGE.glassBorder);
    expect(within(surface).getByTestId('attachment-viewer-back')).toBeTruthy();
  });
});

describe('⑩ 보낸 사람·날짜·시각', () => {
  it('이름과 날짜·시각이 위쪽 띠에 서고, 한 요소로 읽히며, 닿지 않는다 — 갈 곳이 없다', async () => {
    await mount({ senderName: '박서연', sentAtMs: SENT_AT });
    expect(screen.getByTestId('attachment-viewer-sender').props.children).toBe('박서연');
    expect(screen.getByTestId('attachment-viewer-sent-at').props.children).toBe('2026년 10월 29일 14:55');
    expect(viewerStamp(SENT_AT)).toBe('2026년 10월 29일 14:55');
    const stamp = screen.getByTestId('attachment-viewer-stamp');
    expect(stamp.props.accessible).toBe(true);
    expect(stamp.props.accessibilityLabel).toBe('박서연, 2026년 10월 29일 14:55');
    expect(stamp.props.pointerEvents).toBe('none');
    expect(within(stamp).queryAllByRole('button')).toHaveLength(0);
    // 이름은 굵게, 날짜·시각은 그 아래 한 줄.
    expect(flatten(screen.getByTestId('attachment-viewer-sender').props.style).fontWeight).toBe('600');
  });

  it.each([
    ['아무것도 모르면', {}, { sender: false, sentAt: false }],
    ['이름이 공백뿐이고 시각이 유한하지 않으면', { senderName: '  ', sentAtMs: Number.NaN }, { sender: false, sentAt: false }],
    ['이름만 알면', { senderName: '박서연' }, { sender: true, sentAt: false }],
    ['시각만 알면', { sentAtMs: SENT_AT }, { sender: false, sentAt: true }],
  ])('%s 아는 줄만 선다', async (_name, props, expected) => {
    await mount(props);
    expect(screen.queryByTestId('attachment-viewer-sender') !== null).toBe(expected.sender);
    expect(screen.queryByTestId('attachment-viewer-sent-at') !== null).toBe(expected.sentAt);
    expect(screen.queryByTestId('attachment-viewer-stamp') !== null).toBe(expected.sender || expected.sentAt);
  });

  it('대화에서 연 뷰어에 목록이 받은 보낸 사람·시각이 그대로 선다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[{ id: 'p1', name: '현장.png', mime: 'image/png', sizeBytes: 4096 }]}
        senderName="최민수"
        sentAtMs={SENT_AT}
      />,
    );
    await act(async () => {});
    fireEvent.press(screen.getByTestId('attachment-item'));
    await screen.findByTestId('attachment-viewer-image');
    expect(screen.getByTestId('attachment-viewer-sender').props.children).toBe('최민수');
    expect(screen.getByTestId('attachment-viewer-sent-at').props.children).toBe('2026년 10월 29일 14:55');
  });
});

describe('⑪ 조작 뒤의 스크림과 유리 틴트 — 밝은 사진 위에서도 글자가 읽힌다', () => {
  // 순백 사진(스크린샷의 흰 바탕)이 최악이다. 글자 대비는 **실제로 그려지는 색**으로 잰다 — 이름은 `ink`(순백), 날짜·캡션은 `inkMuted`(80% 흰색)이고
  // 후자는 배경이 비쳐 합성된다(앞 판은 둘 다 `WHITE` 로 재서 날짜 줄이 2.5:1 인 것을 놓쳤다, design-review M1). 스크림의 **판**은 조작 덩어리 안을 가득
  // 덮으므로 글자가 어느 크기로 서든(접근성 큰 글씨에서는 이름·날짜 줄이 단추보다 높다) 판 위에 선다 — 대비가 기기·글자 크기의 산수에 안 걸린다.
  const PLATEAU_INNER = photoStage.scrim.plateau[1];
  const plateauOverWhite = () => composite(`rgba(0, 0, 0, ${PLATEAU_INNER})`, WHITE);

  it('스크림은 두 덩어리 안에 있다 — 판은 덩어리를 가득 덮고, 자락은 덩어리 밖에서 풀리며, 모두 닿지 않고 덩어리와 같이 숨는다', async () => {
    await mount();
    const fill = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const [block, which] of [
      [bar(), 'top'],
      [actionsBlock(), 'bottom'],
    ] as const) {
      const plate = within(block).getByTestId(`attachment-viewer-scrim-${which}`);
      const fade = within(block).getByTestId(`attachment-viewer-scrim-${which}-fade`);
      for (const node of [plate, fade]) {
        expect(node.props.pointerEvents).toBe('none');
        expect(node.props.onStartShouldSetResponder).toBeUndefined();
      }
      // 판: 덩어리 안을 가득. 위쪽은 아래 방향(180deg)·아래쪽은 위 방향(0deg)으로 바깥 끝이 가장 어둡다.
      const plateStyle = flatten(plate.props.style);
      expect({ top: plateStyle.top, right: plateStyle.right, bottom: plateStyle.bottom, left: plateStyle.left }).toEqual(fill);
      expect(plateStyle.experimental_backgroundImage).toBe(viewerScrimPlateau(which === 'top' ? 'down' : 'up'));
      // 자락: 덩어리 **밖**(위쪽 덩어리는 아래로, 아래쪽 덩어리는 위로) 풀린다. 자리는 음수 오프셋이다 — 퍼센트는 Yoga 가 부모의 **안쪽 높이(패딩을 뺀)** 로
      // 풀어 안전 영역 패딩을 진 덩어리에서 자락이 덩어리 안으로 들어온다(시뮬레이터 캡처에서 이중으로 어두운 띠가 보였다 — jest 는 이 계산을 못 한다).
      const fadeStyle = flatten(fade.props.style);
      expect(which === 'top' ? fadeStyle.bottom : fadeStyle.top).toBe(-VIEWER.scrimReach);
      expect(which === 'top' ? fadeStyle.top : fadeStyle.bottom).toBeUndefined();
      expect(fadeStyle.height).toBe(VIEWER.scrimReach);
      expect(fadeStyle.experimental_backgroundImage).toBe(viewerScrimFade(which === 'top' ? 'down' : 'up'));
    }
    tapOnce();
    expect(bar().props.pointerEvents).toBe('none'); // 스크림은 덩어리 안이라 같이 숨는다.
  });

  it('판 위에서 순백 사진 위의 이름은 4.5:1, 날짜·캡션은 3.2:1 이상이다 — 그려지는 색(80% 흰색의 합성)으로 잰다', () => {
    const bg = plateauOverWhite();
    expect(contrast(composite(VIEWER_STAGE.ink, bg), bg)).toBeGreaterThanOrEqual(4.5);
    // `inkMuted` 는 반투명이라 배경이 비친다 — 합성한 색으로 잰다.
    expect(contrast(composite(VIEWER_STAGE.inkMuted, bg), bg)).toBeGreaterThanOrEqual(3.2);
  });

  it('판의 안쪽 끝이 가장 밝은 자리다 — 바깥 끝은 같거나 더 어둡다(글자가 서는 가장 밝은 자리를 잰다)', () => {
    const [outer, inner] = photoStage.scrim.plateau;
    expect(outer).toBeGreaterThanOrEqual(inner);
  });

  it('자락은 판의 안쪽 끝 불투명도로 시작해 단조롭게 0 으로 풀리고, 끝에서 가장 완만하다 — 끝 선이 줄무늬로 남지 않는다', () => {
    expect(viewerScrimFadeAlpha(0)).toBe(PLATEAU_INNER);
    expect(viewerScrimFadeAlpha(1)).toBe(0);
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 40; step += 1) {
      const alpha = viewerScrimFadeAlpha(step / 40);
      expect(alpha).toBeLessThanOrEqual(previous);
      previous = alpha;
    }
    // 마디 사이 기울기(불투명도/위치): 마지막 구간이 가장 가파른 구간의 절반 아래다 — 선형으로 끊으면 끝 선이 밝은 사진 위에서 마하 띠로 보인다.
    const stops = photoStage.scrim.fade;
    const slopes = stops
      .slice(1)
      .map(([at, alpha], i) => Math.abs(alpha - stops[i][1]) / (at - stops[i][0]));
    expect(slopes[slopes.length - 1]).toBeLessThan(Math.max(...slopes) / 2);
  });

  it('블러 갈래의 어두운 틴트는 순백 사진 위에서도 흰 글리프가 3:1 이상이다', () => {
    // 순백을 흐려도 순백이라 틴트 아래는 순백이다 — 합성이 정확하다.
    expect(contrast(WHITE, composite(VIEWER_GLASS_TONE.tint, WHITE))).toBeGreaterThanOrEqual(3);
  });

  it('상태 안내는 어두운 알약 위에 선다 — 어떤 사진 위에서도 읽혀야 하는 피드백이다', async () => {
    jest.spyOn(Share, 'share').mockRejectedValueOnce(new Error('boom'));
    await mount();
    fireEvent.press(screen.getByTestId('attachment-viewer-share'));
    const notice = await screen.findByTestId('attachment-viewer-status');
    const style = flatten(notice.props.style);
    expect(style.backgroundColor).toBe(VIEWER_GLASS_TONE.fallback);
    expect(contrast(composite(VIEWER_STAGE.danger, BLACK), composite(VIEWER_GLASS_TONE.fallback, WHITE))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(composite(VIEWER_STAGE.ink, BLACK), composite(VIEWER_GLASS_TONE.fallback, WHITE))).toBeGreaterThanOrEqual(7);
  });
});

// =============================================================================
// 사진 뷰어의 확대 (#4769): 두 손가락 확대와 두 번 탭.
//
// 확대 자체는 iOS 스크롤뷰가 한다. jest 에는 네이티브 스크롤뷰가 없어 「실제로 커지는가」와 「원래 크기에서 가로 넘김·쓸어 닫기가 산다」는 못 잰다 —
// 그것은 Maestro 120 이 잰다(두 번 탭 → 확대 중 넘기기 안 됨 → 다시 두 번 탭 → 넘기기 됨). 여기서 재는 것은 **JS 가 정하는 것**이다: 스크롤뷰의
// 설정, 응답자의 자리, 두 번 탭의 판정과 네이티브에 넘기는 사각형, 확대 상태에 따른 잠금, 장이 바뀔 때의 풀림, 접근성 값, 동작 줄이기.
// 네이티브가 알려 주는 배율은 `onScroll`·`onScrollEndDrag` 의 `zoomScale` 로 흉내 낸다(`scrollViewDidZoom`·`scrollViewDidEndZooming` 이 보내는 모양).
// =============================================================================
describe('⑫ 확대 — 두 손가락 확대와 두 번 탭 (#4769)', () => {
  const { width, height } = Dimensions.get('window');
  const zoomScroll = (index = 0) => screen.getAllByTestId('attachment-viewer-zoom')[index] as Instance;
  /** 네이티브 확대 스크롤뷰가 받은 `zoomToRect` 요청(`scrollResponderZoomTo`) — jest 의 스크롤뷰 대역이다. */
  const zoomTo = () => ScrollView.prototype.scrollResponderZoomTo as unknown as jest.Mock;
  /** 네이티브가 알려 주는 배율을 `index` 쪽의 확대 스크롤뷰에 흉내 낸다. */
  const zoomBy = (scale: number, index = 0, event: 'scroll' | 'scrollEndDrag' = 'scroll') =>
    act(() => {
      fireEvent(zoomScroll(index), event, { nativeEvent: { zoomScale: scale } });
    });
  /** 같은 자리를 연달아 두 번 누른다(문턱 안). 문턱이 지난 뒤까지 간다. */
  const doubleTap = (x = 300, y = 500) =>
    afterTapWindow(() => {
      tap(photo(), x, y);
      tap(photo(), x, y);
    });
  const FULL = { x: 0, y: 0, width, height };

  beforeEach(() => {
    zoomTo().mockClear();
  });

  it('쪽마다 확대 스크롤뷰다 — 1~3배, 원래 크기보다 작아지지 않고, 원래 크기에서는 팬을 시작하지 못한다', async () => {
    await mount();
    const zooms = screen.getAllByTestId('attachment-viewer-zoom');
    expect(zooms).toHaveLength(IMAGES.length);
    for (const zoom of zooms) {
      expect(zoom.props.minimumZoomScale).toBe(1); // 원래 크기보다 작아지지 않는다
      expect(zoom.props.maximumZoomScale).toBe(3);
      expect(zoom.props.bouncesZoom).toBe(true); // 모자라게 줄여도 놓으면 1 로 돌아온다
      expect(zoom.props.centerContent).toBe(true);
      // 세로 스크롤뷰의 기본은 `alwaysBounceVertical` 참이다 — 그러면 원래 크기에서도 스크롤뷰가 아래로 쓸기를 가져가 쓸어 닫기가 죽는다.
      expect(zoom.props.alwaysBounceVertical).toBe(false);
      expect(zoom.props.alwaysBounceHorizontal).toBe(false);
    }
  });

  it('사진이 오기 전에는 키울 것이 없다 — 최대 배율이 최소와 같고, 사진이 서면 3배다', async () => {
    render(
      <AttachmentViewer workspaceId="ws" channelId="ch" images={IMAGES} startIndex={0} onClose={jest.fn()} />,
    );
    expect(zoomScroll().props.maximumZoomScale).toBe(1);
    await screen.findAllByTestId('attachment-viewer-image');
    expect(zoomScroll().props.maximumZoomScale).toBe(3);
  });

  it('사진 위에 닿은 손가락을 쥐는 뷰는 확대 스크롤뷰의 조상이 아니다 — 조상이 응답자이면 iOS 스크롤뷰는 확대·팬을 시작하지 못한다', async () => {
    await mount();
    for (const index of [0, 1, 2]) {
      const pages = screen.getAllByTestId('attachment-viewer-page');
      for (const target of [photo(index), pages[index] as Instance]) {
        const touch = finger(target);
        expect(touch.down(200, 300).granted).toBe(true);
        const grabbed = touch.responder as Instance;
        // iOS 가 스크롤을 막는 조건의 거울상(`_shouldDisableScrollInteraction`): 응답자는 스크롤뷰의 superview 사슬에 있으면 안 된다.
        expect(isAncestor(grabbed, zoomScroll(index))).toBe(false);
        // 쥔 것은 확대 스크롤뷰 **안**의 쪽 View 다(스크롤뷰 안의 `Pressable` 과 같은 모양).
        expect(isAncestor(zoomScroll(index), grabbed)).toBe(true);
        expect(grabbed.props.testID).toBe('attachment-viewer-page');
        touch.up();
      }
    }
  });

  it('한 번 탭(조작 숨김)은 두 번 탭 문턱만큼 늦다 — 두 번째 탭이 오는지 보고서야 숨긴다', async () => {
    await mount();
    installTimersOnlyClock();
    try {
      tap();
      expect(chromeIsShown()).toBe(true); // 아직이다
      act(() => {
        jest.advanceTimersByTime(DOUBLE_TAP_MS - 1);
      });
      expect(chromeIsShown()).toBe(true); // 문턱 직전까지도
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(chromeIsShown()).toBe(false); // 문턱에서
    } finally {
      jest.useRealTimers();
    }
  });

  it('두 번 탭: 탭한 곳이 가운데 오게 2배로 키운다 — 조작은 깜박이지 않는다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const { onClose } = await mount();
    doubleTap(300, 500);
    expect(zoomTo()).toHaveBeenLastCalledWith(
      { x: 300 - width / 4, y: 500 - height / 4, width: width / 2, height: height / 2, animated: true },
      true,
    );
    // 첫 탭의 한 번 탭은 두 번째 탭이 취소했다 — 문턱이 지난 뒤에도 조작이 그대로이고 숨었다 돌아오는 움직임도 없었다.
    expect(chromeIsShown()).toBe(true);
    expect(timing).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('모서리를 두 번 탭해도 사각형은 쪽 안에 있고 탭한 곳을 품는다 — 사진 밖 빈자리를 보여 주지 않는다', async () => {
    await mount();
    for (const [x, y] of [
      [4, 4],
      [width - 4, 4],
      [4, height - 4],
      [width - 4, height - 4],
    ] as const) {
      zoomTo().mockClear();
      doubleTap(x, y);
      const [rect] = zoomTo().mock.lastCall as [{ x: number; y: number; width: number; height: number }];
      expect([rect.width, rect.height]).toEqual([width / 2, height / 2]);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
      expect(x).toBeGreaterThanOrEqual(rect.x);
      expect(x).toBeLessThanOrEqual(rect.x + rect.width);
      expect(y).toBeGreaterThanOrEqual(rect.y);
      expect(y).toBeLessThanOrEqual(rect.y + rect.height);
    }
  });

  it('멀리 떨어진 두 탭은 두 번 탭이 아니다 — 한 번 탭 둘이다(확대하지 않는다)', async () => {
    await mount();
    installTimersOnlyClock();
    try {
      tap(photo(), 60, 300);
      tap(photo(), 360, 300);
      // 첫 탭은 둘째 탭이 온 순간 한 번 탭으로 일어나 조작이 숨었고, 둘째 탭은 문턱 뒤에 일어나 다시 나타난다.
      expect(chromeIsShown()).toBe(false);
      act(() => {
        jest.advanceTimersByTime(DOUBLE_TAP_MS);
      });
      expect(chromeIsShown()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    expect(zoomTo()).not.toHaveBeenCalled();
  });

  it('문턱을 넘겨 다시 누른 두 탭도 두 번 탭이 아니다 — 한 번 탭 둘이다', async () => {
    await mount();
    tapOnce();
    expect(chromeIsShown()).toBe(false);
    tapOnce();
    expect(chromeIsShown()).toBe(true);
    expect(zoomTo()).not.toHaveBeenCalled();
  });

  it('핀치(두 손가락)는 두 번 탭이 아니다 — 연달아 두 번 해도 확대 요청이 없다(확대는 스크롤뷰가 한다)', async () => {
    await mount();
    afterTapWindow(() => {
      for (let n = 0; n < 2; n += 1) {
        const pinch = finger(photo());
        pinch.down(200, 300, 2);
        pinch.up();
      }
    });
    expect(zoomTo()).not.toHaveBeenCalled();
    expect(chromeIsShown()).toBe(true);
  });

  it('확대 중 두 번 탭은 원래 크기로 돌린다 — 쪽 전체 사각형', async () => {
    await mount();
    zoomBy(2);
    doubleTap(300, 500);
    expect(zoomTo()).toHaveBeenLastCalledWith({ ...FULL, animated: true }, true);
  });

  it('확대 중에는 가로 넘기기와 쓸어 닫기가 꺼지고, 원래 크기로 돌아오면 다시 켜진다', async () => {
    const { onClose, progress } = await mount();
    expect(scrollView().props.scrollEnabled).toBe(true);
    zoomBy(2);
    expect(scrollView().props.scrollEnabled).toBe(false); // 가로 넘기기
    const zoomedDrag = finger(photo());
    zoomedDrag.down(200, 300);
    dragSlowly(zoomedDrag, 200, 300, DISMISS_DISTANCE_PT + 80);
    expect(progress.current).toBeNull(); // 쓸어 닫기: 사진을 가져가지 않는다
    zoomedDrag.up();
    expect(onClose).not.toHaveBeenCalled();
    zoomBy(1);
    expect(scrollView().props.scrollEnabled).toBe(true);
    const drag = finger(photo());
    drag.down(200, 300);
    dragSlowly(drag, 200, 300, DISMISS_DISTANCE_PT + 80);
    drag.up();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('핀치가 끝나는 순간의 배율(끝 이벤트)로도 잠금이 풀린다 — 원래 크기로 돌아온 손가락이 막힌 채 남지 않는다', async () => {
    await mount();
    zoomBy(2.4);
    expect(scrollView().props.scrollEnabled).toBe(false);
    zoomBy(1, 0, 'scrollEndDrag');
    expect(scrollView().props.scrollEnabled).toBe(true);
  });

  it('1 에 가까운 배율(부동소수 찌꺼기)은 확대로 세지 않는다 — 넘기기·쓸어 닫기가 꺼지지 않는다', async () => {
    await mount();
    zoomBy(1.000001);
    expect(scrollView().props.scrollEnabled).toBe(true);
  });

  it('다른 쪽의 확대 알림은 현재 쪽의 잠금을 건드리지 않는다', async () => {
    await mount();
    zoomBy(2, 1);
    expect(scrollView().props.scrollEnabled).toBe(true);
  });

  it('다른 장으로 넘기면 앞 장의 확대가 풀린다 — 새 장은 원래 크기에서 시작하고 넘기기가 다시 켜진다', async () => {
    await mount();
    zoomBy(2);
    expect(scrollView().props.scrollEnabled).toBe(false);
    zoomTo().mockClear();
    fireEvent.press(screen.getAllByTestId('attachment-viewer-thumb')[2] as Instance);
    expect(scrollView().props.scrollEnabled).toBe(true);
    // 앞 장을 원래 크기(쪽 전체)로 되돌리라고 네이티브에 청한다.
    expect(zoomTo()).toHaveBeenLastCalledWith({ ...FULL, animated: true }, true);
  });

  it('동작 줄이기면 두 번 탭이 움직임 없이 바로 바뀐다 — 사각형도 둘째 인자도 움직이지 않는다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    await mount();
    await act(async () => {}); // 설정의 답이 도착한다
    doubleTap(300, 500);
    expect(zoomTo()).toHaveBeenLastCalledWith(expect.objectContaining({ animated: false }), false);
    zoomBy(2);
    doubleTap(300, 500);
    expect(zoomTo()).toHaveBeenLastCalledWith({ ...FULL, animated: false }, false);
  });

  it('확대 상태는 접근성 값으로 알린다 — 원래 크기에서는 사진 이름만 읽힌다', async () => {
    await mount();
    expect(photo().props.accessible).toBe(true); // 보조기술이 사진에 닿아야 값을 읽는다
    expect(photo().props.accessibilityRole).toBe('image');
    expect(photo().props.accessibilityValue).toBeUndefined();
    zoomBy(2);
    expect(photo().props.accessibilityValue).toEqual({ text: ZOOMED_A11Y_VALUE });
    zoomBy(1);
    expect(photo().props.accessibilityValue).toBeUndefined();
  });
});
