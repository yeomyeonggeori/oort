import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActionSheetIOS,
  Animated,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderInstance,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {useDismissOnEntry} from '../lib/useDismissOnEntry';
import {useKeyboardHeight} from '../lib/useKeyboardHeight';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import {FLING_OUT} from './motion';
import {
  SHEET_RUBBER_MAX,
  SHEET_SLIDE_MS,
  SHEET_TOP,
  claimsSheetDrag,
  claimsSheetTouchStart,
  estimatedSheetHeight,
  releaseSlideMs,
  releaseVelocity,
  scrollOverflows,
  sheetFollow,
  sheetFrame,
  shouldDismissSheet,
  type DragSample,
  type DragZone,
  type SheetHeight,
} from './sheetModel';
import {useStyles} from './theme';
import {ds2Radius, SHEET, type Palette} from './tokens';

// =============================================================================
// 페이지 시트 — 셸의 세 번째 부품 (ADR-0189 D1, DS2-2 #2714).
//
// 시안 A `.a-sheet`를 그대로 옮긴다: 화면 위 58에서 시작해 바닥까지, 위 두 모서리
// 반경 30, 바탕 `sheet`, 위로 번지는 그림자 `0 -10px 40px rgba(0,0,0,.18)`, 안쪽
// 여백 10·16, 맨 위 38×5 손잡이(잉크 22%). 뒤는 스크림(`scrim`)이 덮는다.
//
// iOS 네이티브 `pageSheet`를 쓰지 않는 이유: 그 모양은 시스템이 정한다(반경 약 10,
// 위 여백은 기기마다). 시안은 58·30을 **정했고**, 성재가 고른 것이 그 모양이다.
// 대신 네이티브 시트가 거저 주던 것을 여기서 진다:
//
//   - 끌어내려 닫기(#4612): **머리 전체**(손잡이 띠·`SheetHeader`)와, **스크롤이 맨 위인 본문**을
//     아래로 끌면 손가락을 따라오고, 충분히 내리거나 빠르게 튕기면 닫힌다. 모자라면 제자리로
//     돌아간다. 아래 「끌기」 절.
//   - 스크림을 누르면 닫힌다. VoiceOver 「두 손가락 문지르기」(escape)도 닫는다.
//   - 동작 줄이기가 켜져 있으면 미끄러지지 않고 바로 서고 바로 사라진다.
//
// 내용은 이 파일의 일이 아니다. 프로필 시트(#2702)와 FAB 시트가 자식으로 준다.
//
// ## 높이 세 단 (#4318)
//
// `height` 가 시트가 화면을 얼마나 차지하는지 정한다 — `large`(위 58 에서 바닥까지, 기본이고
// 지금까지의 모양), `fit`(내용 높이, 화면의 85% 위로는 안에서 스크롤), `medium`(화면의 9/16 고정).
// 단계별 상자와 끌어 닫기의 문턱은 `sheetModel.ts` 의 순수 함수다. 머리(오른쪽 원형 X·제목·
// 선택적 ✓)는 `SheetChrome.tsx` 의 `SheetHeader` 를 자식 맨 위에 둔다 — 이 파일은 그릇이다.
//
// ## 키보드 (#4318)
//
// **내용 맞춤·중간 단**은 소프트 키보드가 올라오면 시트의 바닥이 키보드 윗면에 앉는다(`sheetFrame` 의 `bottom`) —
// 시트 안의 입력 칸은 시트 바닥보다 아래일 수 없으니 키보드에 가리지 않는다. 시트가 위로 자라 머리의 X 가 시계
// 뒤로 들어가지 않게 높이를 줄인다(큰 단의 위 끝이 상한). **큰 단은 올리지 않는다** — 큰 단의 몸은 스크롤이고 제
// 키보드 처리(`automaticallyAdjustKeyboardInsets`)를 이미 갖는다. 키보드 높이는 `useKeyboardHeight`(숫자만)이고,
// 시트는 이벤트에서 한 번에 선다 — 키보드의 곡선을 따라 미끄러지지 않는다(`MessageEditorSheet` 와 같은 이유로,
// 입력이 있는 모달 하나는 한 번 늦거나 이른 것이 결함이 아니다). 시트 안의 입력이 부른 키보드는 닫을 때 같이
// 내린다(시트가 서기 전에 올라와 있던 대화 입력창의 키보드는 건드리지 않는다).
//
// ## 행동은 닫은 뒤에 (#4318)
//
// 닫는 길은 하나(`slideOut`)이고 X·스크림·끌기·escape·행동 누름이 모두 지난다. 행동 누름은
// `usePageSheetAction()` 으로 「미끄러져 내린 뒤 `onClose`, 이어서 행동」을 한 번 부른다 — 부모가 행동
// 안에서 곧바로 언마운트해 시트가 스냅으로 사라지는 것을 막는다.
//
// ## 끌기 (#4612) — 판정은 `sheetModel.ts`, 여기는 배선
//
// 끌기 응답자는 둘이다. 같은 `travel`·같은 닫는 길을 쓰고 **가져가는 조건만** 다르다.
//
//   머리   손잡이 띠와 `SheetHeader`(`usePageSheetDrag()` 로 핸들러를 받는다). 스크롤이 어디든 아래로 끌면 가져간다.
//   본문   스크롤이 **맨 위**일 때만 가져간다(스크롤 넘겨받기). 본문의 세로 스크롤은 스스로를 시트에 **등록**한다
//          (`usePageSheetScroll()` — `SheetScroll` 이 한다). 등록된 스크롤이 하나도 없으면 가져가지 않는다:
//          시트가 모르는 날 `FlatList` 를 위로 되감던 손가락이 시트를 끌어 내리는 회귀를 막는다(fail-closed).
//
// 응답자를 쥐는 길도 둘이다(`makePan` 머리말). **시작 응답자**와 **이동 가로채기**다. RN `Modal` 은 시작 터치에서 스스로 응답자를 쥐고
// (`Modal.js` `_shouldSetResponder`), 응답자 플러그인은 이동마다 현재 응답자의 **조상**에게만 가로채기를 묻는다. Modal 의 후손인 시트는
// 그래서 「이동에서 가져가기」만으로는 눌리지 않는 자리에서 시작한 터치에 닿지 못한다 — 시뮬레이터가 잡았다(jest 는 응답자 플러그인을
// 건너뛴다). 눌리지 않는 자리의 터치는 시트가 **시작에서** 얌전히 응답자를 쥐고(`claimsSheetTouchStart`) 이동이 조건을 채울 때 비로소
// 쥔다. 단추·행·입력 위에서 시작한 터치는 그쪽이 먼저 쥐고 시트가 조상으로서 이동에서 가로챈다.
//
// 단, 본문의 시작 응답자는 **내용이 뷰포트에 들어갈 때만** 선다. 본문 뿌리는 스크롤 뷰의 조상이고, iOS 는 조상이 JS 응답자인 터치의 네이티브
// 스크롤을 시작도 못 하게 막는다(`onResponderGrant` 의 차단 값은 iOS 에서 버려진다) — 넘치는 스크롤에서 시작 응답자를 잡으면 맨 위에서
// 위로 올리는 스크롤이 죽는다(시뮬레이터 실측, `claimsSheetTouchStart`·`scrollOverflows`). 넘치는 시트의 본문은 후손(행·단추)이 응답자인
// 터치를 이동에서 가로채는 길로만 끌리고, 눌리지 않는 본문 자리는 머리가 대신한다.
//
// 가져간 동안에는 본문 스크롤을 얼린다(`scrollEnabled=false`) — iOS 는 JS 응답자를 가져가도 네이티브 스크롤을 멈추지
// 않아서, 손가락이 되돌아올 때 시트와 내용이 같이 움직인다. 시트 안의 스크롤은 고무줄도 없다(`usePageSheetScrollProps`).
//
// 알려진 한계(런타임 미검증): **같은 손가락으로 스크롤하다 맨 위에 닿아 이어 끄는 것은 안 된다.** RN `ScrollView` 는 스크롤을
// 한 번 본 뒤 응답자 잠금을 쥐고 놓지 않는다(`ScrollView.js` `_handleResponderTerminationRequest`). 맨 위에서 **시작한**
// 끌기만 시트가 가져온다. 손가락을 뗐다 다시 끌면 된다.
//
// 놓을 때 둘(planner 결정, #4612 코멘트): (1) **속도 방향이 이긴다** — 거리 문턱을 넘게 내려 놓고도 놓는 순간 위로 튕겼으면
// 열린 채 둔다(`shouldDismissSheet`). (2) **놓고 닫는 슬라이드는 놓은 속도를 잇는다** — 길이는 남은 거리 ÷ 놓은 속도를
// 상하한 안에서(`releaseSlideMs`), 곡선은 시작 기울기 1 의 `FLING_OUT`. 동작 줄이기면 슬라이드 없이 즉시 닫힌다.
//
// ## 저장 안 한 입력 (#4612)
//
// `dirty` 가 참이면 **사용자가 부른 닫기**(X·스크림·끌기·escape)는 닫지 않고 「버릴까요?」를 묻는다(iOS
// `isModalInPresentation` 시트가 닫으려는 시도에 답하는 방식). 끌었다면 시트는 제자리로 돌아온 뒤 묻는다. 행동 누름
// (`closeThen`)은 묻지 않는다 — 저장·확정이 끝난 뒤의 닫기다.
// =============================================================================

export {SHEET_TOP};
/** 시안 `border-radius:30px 30px 0 0` — 폰 반경 사다리의 맨 위(themes-2.0 §5). */
export const SHEET_RADIUS = ds2Radius.sheet;
/** 시안 `.a-grab` 38×5. */
const GRAB = {width: 38, height: 5} as const;

type DragHandlers = PanResponderInstance['panHandlers'];

/** 시트가 자식에게 쥐여 주는 것. 시트 밖에서는 `null` 이다. */
interface SheetControl {
  /** 미끄러져 내린 뒤 `onClose`. X·스크림·끌기와 같은 길이다. 저장 안 한 입력이 있으면 먼저 묻는다(`dirty`). */
  close: () => void;
  /** 미끄러져 내린 뒤 `onClose` 를 부르고, 이어서 `action` 을 **한 번** 부른다. 묻지 않는다. */
  closeThen: (action: () => void) => void;
  /** 소프트 키보드가 가린 높이(내려가 있으면 0). */
  keyboardHeight: number;
  /** 머리 끌기 핸들러. 머리의 뿌리 `View` 에 펼친다(`SheetHeader`). */
  dragHandlers: DragHandlers;
}

const SheetControlContext = createContext<SheetControl | null>(null);

/**
 * 본문의 세로 스크롤이 시트와 주고받는 것. 값은 `frozen` 이 바뀔 때만 새로 만들어지고(`scrolls` 는 늘 같은 `Map`),
 * 그래서 이 문맥의 소비자(`SheetScroll`)만 다시 그려진다.
 */
interface SheetScrollPort {
  /** 스크롤마다 한 칸 — 맨 위인지 판정할 오프셋(pt). 마운트하면 0, 언마운트하면 지운다. */
  scrolls: Map<symbol, number>;
  /** 스크롤마다 한 칸 — 내용이 뷰포트를 넘치는가(`scrollOverflows`). 크기를 알리기 전에는 `true`(모르면 넘친다고 본다). `scrolls` 와 같은 열쇠. */
  overflows: Map<symbol, boolean>;
  /** 시트가 끌기를 쥐고 있다 — 이 동안 본문 스크롤은 얼어 있어야 한다. */
  frozen: boolean;
}

const SheetScrollContext = createContext<SheetScrollPort | null>(null);

/**
 * 머리의 뿌리 `View` 에 펼칠 끌기 핸들러. 시트 밖(페이지 머리)에서는 `null` 이다.
 * `SheetHeader` 가 쓴다 — 손잡이 띠만이 아니라 제목 줄 어디서든 시트가 내려간다.
 */
export function usePageSheetDrag(): DragHandlers | null {
  return useContext(SheetControlContext)?.dragHandlers ?? null;
}

/**
 * 시트 안의 **세로 스크롤**이 자기를 시트에 알리는 길. 돌려주는 `report` 에 `contentOffset.y` 를 알리면 시트가 「맨
 * 위인가」를 안다. `frozen` 은 시트가 끌기를 쥐고 있다는 뜻이라 스크롤을 얼려야 한다. 시트 밖에서는 `null` 이다.
 *
 * `SheetScroll` 이 이 일을 한다. 날 `ScrollView`·`FlatList` 를 시트 안에 두면 **알리지 않는 한 본문 끌기는 꺼져 있다**
 * (머리 끌기만 선다) — 모르는 스크롤을 시트가 가져가지 않는 쪽이 안전하다.
 */
export function usePageSheetScroll(): {
  report: (offsetY: number) => void;
  /** 스크롤의 **내용 높이**(`onContentSizeChange`). 뷰포트 높이와 함께 알려야 시트가 「넘치는가」를 안다. */
  reportContentHeight: (height: number) => void;
  /** 스크롤 뷰 자신의 **뷰포트 높이**(`onLayout`). */
  reportViewportHeight: (height: number) => void;
  frozen: boolean;
} | null {
  const port = useContext(SheetScrollContext);
  const scrolls = port?.scrolls;
  const overflows = port?.overflows;
  const key = useMemo(() => Symbol('sheet-scroll'), []);
  // 크기는 두 사건(레이아웃·내용 크기)으로 따로 온다 — 둘을 함께 들고 있다가 둘 다 알면 판정한다(`scrollOverflows`: 모르면 넘친다).
  const sizes = useRef({content: Number.NaN, viewport: Number.NaN});
  useEffect(() => {
    if (!scrolls || !overflows) return undefined;
    scrolls.set(key, 0);
    overflows.set(key, scrollOverflows(sizes.current.content, sizes.current.viewport));
    return () => {
      scrolls.delete(key);
      overflows.delete(key);
    };
  }, [scrolls, overflows, key]);
  const report = useCallback(
    (offsetY: number) => {
      scrolls?.set(key, offsetY);
    },
    [scrolls, key],
  );
  // 등록된 뒤에만 쓴다 — 언마운트 뒤에 늦게 온 크기 사건이 지워진 열쇠를 되살려 「넘침」으로 시트를 영영 막지 않게.
  const settleSize = useCallback(() => {
    if (scrolls?.has(key)) overflows?.set(key, scrollOverflows(sizes.current.content, sizes.current.viewport));
  }, [scrolls, overflows, key]);
  const reportContentHeight = useCallback(
    (height: number) => {
      sizes.current.content = height;
      settleSize();
    },
    [settleSize],
  );
  const reportViewportHeight = useCallback(
    (height: number) => {
      sizes.current.viewport = height;
      settleSize();
    },
    [settleSize],
  );
  return port ? {report, reportContentHeight, reportViewportHeight, frozen: port.frozen} : null;
}

type ScrollEventHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/**
 * `usePageSheetScroll()` 의 배선을 **스크롤 뷰에 펼칠 props 로** 돌려준다 — `SheetScroll` 과 시트 안의 날 `FlatList`·`ScrollView` 가
 * 같은 코드를 쓴다(#4612). 스크롤·끌기 끝·관성 끝마다 오프셋을 시트에 알리고, 시트가 끌기를 쥐는 동안은 스크롤을 얼린다.
 * `scrollEventThrottle` 은 16 이다 — 0(기본)이면 iOS 는 스크롤이 시작할 때 한 번만 알려서 시트가 낡은 오프셋을 믿는다.
 *
 * 호출자가 이미 가진 `onScroll`·`onScrollEndDrag`·`onMomentumScrollEnd`·`scrollEnabled` 는 지우지 않고 겹쳐 쓴다(`own`). 시트 밖에서는
 * 알릴 곳이 없으니 호출자의 값 그대로 동작한다.
 *
 * `bounces: false` 도 함께 준다 — 시트 몸의 표준이고(`SheetScroll`), 맨 위에서 아래로 끄는 손가락이 네이티브 스크롤을 위로 당겨 시트와
 * 내용이 같이 움직이는 이중 이동을 구조적으로 막는다(맨 위의 `UIScrollView` 는 고무줄이 없으면 아래로 끄는 손가락에 움직일 곳이 없다).
 * 호출자가 스크롤 뷰에 `bounces` 를 따로 주면 그쪽이 이긴다(이 객체를 먼저 펼친다).
 */
export function usePageSheetScrollProps(
  own: {
    onScroll?: ScrollEventHandler;
    onScrollEndDrag?: ScrollEventHandler;
    onMomentumScrollEnd?: ScrollEventHandler;
    onLayout?: (event: LayoutChangeEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    scrollEnabled?: boolean;
  } = {},
): {
  bounces: boolean;
  scrollEventThrottle: number;
  scrollEnabled: boolean;
  onScroll: ScrollEventHandler;
  onScrollEndDrag: ScrollEventHandler;
  onMomentumScrollEnd: ScrollEventHandler;
  onLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
} {
  const sheet = usePageSheetScroll();
  const {onScroll, onScrollEndDrag, onMomentumScrollEnd, onLayout, onContentSizeChange, scrollEnabled = true} = own;
  return {
    bounces: false,
    scrollEventThrottle: 16,
    scrollEnabled: scrollEnabled && !sheet?.frozen,
    // 크기를 알린다 — 내용이 뷰포트를 넘치면 본문은 시작 응답자를 잡지 않는다(`claimsSheetTouchStart`).
    onLayout: event => {
      sheet?.reportViewportHeight(event.nativeEvent.layout.height);
      onLayout?.(event);
    },
    onContentSizeChange: (width, height) => {
      sheet?.reportContentHeight(height);
      onContentSizeChange?.(width, height);
    },
    onScroll: event => {
      sheet?.report(event.nativeEvent.contentOffset.y);
      onScroll?.(event);
    },
    onScrollEndDrag: event => {
      sheet?.report(event.nativeEvent.contentOffset.y);
      onScrollEndDrag?.(event);
    },
    onMomentumScrollEnd: event => {
      sheet?.report(event.nativeEvent.contentOffset.y);
      onMomentumScrollEnd?.(event);
    },
  };
}

/**
 * 시트 안의 「닫기」가 부를 것. 시트가 쥔 닫기를 부르면 스크림·끌기와 같이
 * 미끄러져 나간다. 시트 밖에서 부르면 `null`이다.
 */
export function usePageSheetClose(): (() => void) | null {
  return useContext(SheetControlContext)?.close ?? null;
}

const runNow = (action: () => void): void => action();

/**
 * 시트 안의 **행동**이 부를 것: 시트를 미끄러뜨려 내린 **뒤에** 행동을 한 번 부른다(#4318).
 *
 * 행동 누름을 부모의 `setOpen(false)` 에 바로 맡기면 시트가 언마운트되며 스냅으로 사라진다 —
 * 옛 `animationType="fade"` Modal 은 언마운트에도 부드럽게 나갔지만 이 그릇은 제 슬라이드가 닫는
 * 길의 전부다. 그래서 행동 누름도 X·스크림·끌기와 같은 닫기 길로 보내고 슬라이드가 끝나면 부른다.
 *
 *   - 순서는 **`onClose` 먼저, 행동 나중**이다. 행동이 시트를 다시 열 수 있고(`setActive(target)`) 그
 *     마지막 말이 `onClose` 에 지워지면 안 된다. `onClose` 를 건너뛰지도 않는다 — 행동 쪽이 시트를
 *     닫지 않는 부모에서는 투명한 모달이 화면 위에 남아 손을 가로챈다.
 *   - 이미 닫는 중이면(두 번 누름·끌기 도중의 누름) 아무것도 하지 않는다. 행동은 한 번이다. 닫는 중에는 손잡이를
 *     잡아도 시트가 끼어들지 않는다(슬라이드가 끊기면 행동이 앞당겨 불리므로).
 *   - 슬라이드 도중 부모가 시트를 걷어 버리면(행이 사라짐·로그아웃) 애니메이션이 끊긴 채 끝나므로 행동은 그
 *     언마운트 **뒤에** 한 번 불린다. 「불리지 않음」은 없다.
 *   - 동작 줄이기가 켜져 있으면 미끄러지지 않으므로 바로 부른다.
 *   - 시트 **밖**에서 부르면 바로 부른다(닫을 시트가 없다).
 *
 * 쓰지 않는 때: 시트가 **진행·영수증·실패를 스스로 보이는** 행동(대화 행 시트의 읽음 처리·알림·복사,
 * 지우기 확인). 그 면은 행동이 끝날 때까지 떠 있어야 한다 — 코어 `channelActionKeepsMenuOpen` 이
 * 같은 이유로 그 항목들을 「열어 둔다」고 정한다.
 */
export function usePageSheetAction(): (action: () => void) => void {
  return useContext(SheetControlContext)?.closeThen ?? runNow;
}

/** 키보드가 가린 높이. 시트 몸(`SheetScroll`)이 홈 인디케이터 여백을 걷을지 정한다. 시트 밖에서는 0. */
export function usePageSheetKeyboard(): number {
  return useContext(SheetControlContext)?.keyboardHeight ?? 0;
}

/**
 * 저장 안 한 입력을 버릴지 묻는다 — iOS 시트가 `isModalInPresentation` 일 때 닫으려는 시도에 답하는 방식(액션 시트)이다.
 * `discard` 는 「버리기」를 골랐을 때만 불린다. 시트가 직접 쥔 묻기를 바꾸려면 `onDiscardPrompt` 를 준다.
 */
function askDiscardDefault(discard: () => void): void {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: '버릴까요?',
      message: '저장하지 않은 내용이 있어요.',
      options: ['버리기', '계속 편집'],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    },
    index => {
      if (index === 0) discard();
    },
  );
}

export function PageSheet({
  onClose,
  onNavigateBack,
  accessibilityLabel,
  children,
  testID,
  height = 'large',
  scrimTestID = 'page-sheet-scrim',
  scrimLabel = '시트 닫기',
  dirty = false,
  onDiscardPrompt,
}: {
  onClose: () => void;
  /** A nested picker replaces this sheet's content (#4322). Dismiss gestures
   * return to its editor without dismissing the Modal or losing its draft.
   * Committed actions (`usePageSheetAction`) still dismiss the whole sheet. */
  onNavigateBack?: () => void;
  /** 시트가 무엇인지. 보조기술이 모달에 들어설 때 읽는다. */
  accessibilityLabel: string;
  children: React.ReactNode;
  testID?: string;
  /** 화면을 얼마나 차지하는가. 기본 `large` 는 이 그릇이 처음부터 그리던 모양이다. */
  height?: SheetHeight;
  /** 스크림(배경)의 testID — 옛 시트들이 제 이름으로 쓰던 것을 이어받는다. */
  scrimTestID?: string;
  /** 스크림의 보조기술 이름. 「… 닫기」 문장은 시트마다 다르다(「대화 액션 닫기」). */
  scrimLabel?: string;
  /**
   * 저장 안 한 입력이 있는가(편집 중 시트). 참이면 X·스크림·끌기·escape 로 닫으려 할 때 닫지 않고 「버릴까요?」를 묻는다.
   * 행동 누름(`usePageSheetAction`)은 묻지 않는다.
   */
  dirty?: boolean;
  /**
   * `dirty` 일 때 닫으려는 시도에 불린다. 「버리기」를 고르면 `discard()` 를 부른다 — 부르지 않으면 시트는 그대로다.
   * 생략하면 iOS 액션 시트(「버릴까요?」)다.
   */
  onDiscardPrompt?: (discard: () => void) => void;
}): React.JSX.Element {
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onNavigateBack ?? onClose}
      onDismiss={onClose}
      testID={testID}>
      <SafeAreaProvider>
        <SheetFrame
          onClose={onClose}
          onNavigateBack={onNavigateBack}
          accessibilityLabel={accessibilityLabel}
          height={height}
          scrimTestID={scrimTestID}
          scrimLabel={scrimLabel}
          dirty={dirty}
          onDiscardPrompt={onDiscardPrompt}>
          {children}
        </SheetFrame>
      </SafeAreaProvider>
    </Modal>
  );
}

/** 터치 이벤트의 시각(ms). 속도 창이 이것으로 잰다. */
const stamp = (event: {nativeEvent: {timestamp?: number}}): number => event.nativeEvent.timestamp ?? Date.now();

/** 속도 표본은 창(100ms)보다 길게 들고 있을 이유가 없다 — 이만큼만 쥔다. */
const MAX_SAMPLES = 24;

function SheetFrame({
  onClose,
  onNavigateBack,
  accessibilityLabel,
  height: sheetHeight,
  scrimTestID,
  scrimLabel,
  dirty,
  onDiscardPrompt,
  children,
}: {
  onClose: () => void;
  onNavigateBack?: () => void;
  accessibilityLabel: string;
  height: SheetHeight;
  scrimTestID: string;
  scrimLabel: string;
  dirty: boolean;
  onDiscardPrompt?: (discard: () => void) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {height} = useWindowDimensions();
  const reduceMotion = useReduceMotionRef();
  const keyboardHeight = useKeyboardHeight();
  // 시트가 서기 **전에** 이미 올라와 있던 키보드는 시트의 것이 아니다 — 대화 입력창의 키보드다. 닫을 때 그것을
  // 접으면 「답글 달기」를 누른 사람의 키보드를 닫아 주고 마는 화면이 된다(`messageTap.test`). 시트가 선 뒤에
  // 올라온 키보드는 시트 안의 입력이 부른 것이라 시트와 같이 내린다. 키보드가 한 번 내려가면 그 뒤에 올라오는 것은 더
  // 이상 「서기 전부터」가 아니다. (iOS 는 Modal 을 띄울 때 보통 키보드를 접으므로 이 구분은 드문 경우의 안전망이다.)
  const keyboardWasUp = useRef(keyboardHeight > 0);
  useEffect(() => {
    if (keyboardHeight === 0) keyboardWasUp.current = false;
  }, [keyboardHeight]);
  // 닫는 길의 정체성을 고정한다: `onClose`(부모가 렌더마다 새 화살표를 줄 수 있다)와 키보드 높이를 ref 로 읽는다.
  // 안 그러면 부모가 리렌더될 때마다 `close` 가 새로 만들어져 끌기 응답자(`pan`)가 새 인스턴스로 갈리고(끄는
  // 도중이면 제스처가 리셋된다) `usePageSheetClose()` 를 의존성으로 든 소비자의 효과가 다시 돈다.
  // 같은 이유로 `dirty`·묻기·시트 높이·스크롤 오프셋도 ref/Map 으로 읽는다 — 응답자의 의존성에 넣지 않는다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const backRef = useRef(onNavigateBack);
  backRef.current = onNavigateBack;
  const keyboardRef = useRef(keyboardHeight);
  keyboardRef.current = keyboardHeight;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const promptRef = useRef(onDiscardPrompt);
  promptRef.current = onDiscardPrompt;
  const travel = useRef(new Animated.Value(height)).current;
  const closing = useRef(false);
  // 본문의 세로 스크롤들이 알려 온 오프셋. 시트의 본문 끌기는 이 값이 전부 맨 위일 때만 선다.
  const scrolls = useMemo(() => new Map<symbol, number>(), []);
  // 같은 열쇠로, 그 스크롤의 내용이 뷰포트를 넘치는가. 넘치는(또는 모르는) 스크롤이 하나라도 있으면 본문은 시작 응답자를 잡지 않는다.
  const overflows = useMemo(() => new Map<symbol, boolean>(), []);
  // 시트가 끌기를 쥐고 있는 동안 본문 스크롤을 얼린다(`SheetScroll` 이 읽는다).
  const [frozen, setFrozen] = useState(false);
  // 시트가 실제로 선 높이 — 레이아웃이 알려 준 값. 아직 모르면 상자에서 어림한 값을 쓴다(아래 `sheetBox`).
  const [measured, setMeasured] = useState(0);
  const measuredRef = useRef(0);

  // 단계별 상자. 큰 단은 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서 그 아래 4pt 에서
  // 시작한다 — 58 은 시안 기기(390×844, 상태 막대 54)의 값이라 그 위에 올리면 시계와 겹친다.
  // 내용 맞춤·중간 단은 키보드가 올라와 있으면 시트의 바닥이 키보드 윗면에 앉는다(`sheetFrame` 머리말).
  const frame = sheetFrame(sheetHeight, height, insets.top, keyboardHeight);
  // 시트가 실제로 올라간 높이. 큰 단은 올리지 않으므로 0 이다(몸 스크롤이 안전 영역 여백을 걷을지 정한다).
  const lifted = sheetHeight === 'large' ? 0 : keyboardHeight;
  // 문턱·스크림이 나누는 높이: 잰 값이 이기고, 레이아웃이 오기 전에는 상자에서 어림한다.
  const sheetBox = measured > 0 ? measured : estimatedSheetHeight(frame, height);
  const boxRef = useRef(sheetBox);
  boxRef.current = sheetBox;

  useEffect(() => {
    if (reduceMotion.current) {
      travel.setValue(0);
      return;
    }
    Animated.timing(travel, {
      toValue: 0,
      duration: SHEET_SLIDE_MS,
      useNativeDriver: true,
    }).start();
  }, [travel, reduceMotion]);

  // 닫는 길은 하나다 — X·스크림·끌기·escape·행동 누름이 전부 여기를 지난다. `after` 는 행동 누름만
  // 싣는다. 이 함수를 `onPress` 에 직접 걸지 않는다(Pressable 이 첫 인자로 이벤트를 넘긴다):
  // 아래 `close`·`closeThen` 이 인자를 못 박아 감싼다. `release` 는 손가락을 **놓아** 닫는 때만 있다 — 놓은 자리와 속도를
  // 이어 간다: 시간은 남은 거리를 그 속도로 가는 만큼(`releaseSlideMs`, 상하한 안), 곡선은 시작 기울기가 1 이라 첫 순간의
  // 속도가 손가락의 속도인 `FLING_OUT`. 정지에서 출발하는 기본 곡선(`inOut`)은 튕긴 손가락의 속도를 잇지 못하고 멈칫하고,
  // 강한 ease-out(`EASE_OUT`)은 손가락보다 4 배 빠르게 튀어 나간다. 없으면(X·스크림·행동 누름) 기본 길이·기본 곡선이다.
  const slideOut = useCallback(
    (after?: () => void, release?: {offset: number; velocity: number}) => {
      if (closing.current) return;
      closing.current = true;
      // 시트 안의 입력이 부른 키보드는 시트와 같이 내려간다. 안 그러면 시트가 다 나간 뒤에야(언마운트 때)
      // 키보드가 혼자 내려간다.
      if (keyboardRef.current > 0 && !keyboardWasUp.current) Keyboard.dismiss();
      const finish = () => {
        // `onClose` 가 먼저다: 행동이 시트를 다시 열 수 있고, 그 말이 마지막이어야 한다.
        onCloseRef.current();
        after?.();
      };
      if (reduceMotion.current) {
        finish();
        return;
      }
      Animated.timing(travel, {
        toValue: height,
        ...(release
          ? {duration: releaseSlideMs(height - release.offset, release.velocity), easing: FLING_OUT}
          : {duration: SHEET_SLIDE_MS}),
        useNativeDriver: true,
      }).start(finish);
    },
    [height, reduceMotion, travel],
  );
  // 저장 안 한 입력이 있으면 닫지 않고 묻는다. 「버리기」는 슬라이드로 닫는 같은 길이다.
  const askDiscard = useCallback(() => {
    (promptRef.current ?? askDiscardDefault)(() => slideOut());
  }, [slideOut]);
  // 사용자가 부른 닫기(X·스크림·escape·끌기)가 지나는 문. 행동 누름(`closeThen`)은 이 문을 지나지 않는다.
  const close = useCallback(() => {
    if (backRef.current && !closing.current) {
      Keyboard.dismiss();
      backRef.current();
      return;
    }
    if (dirtyRef.current && !closing.current) {
      askDiscard();
      return;
    }
    slideOut();
  }, [askDiscard, slideOut]);
  const closeThen = useCallback(
    (action: () => void) => slideOut(action),
    [slideOut],
  );
  // 알림이 새 입구로 들어왔다(#4667) — 사람이 부른 닫기가 아니다. `close()` 가 아니라 `slideOut()` 이 곧바로 닫는다:
  // `close()` 는 저장 안 한 입력이 있으면 「버릴까요?」를 묻고(`dirty`) 중첩 선택기가 있으면 한 겹만 벗기는데(`onNavigateBack`),
  // 알림을 누른 사람에게 그 물음은 자기가 한 적 없는 닫기에 대한 것이고 목적지는 그 뒤에 서 있다. 쓰던 글은 입력이 든 시트가
  // 같은 방송을 받으며 맡긴다(`lib/entryDrafts.ts`). 이미 닫는 중이면 `slideOut` 이 알아서 무시한다. 이 그릇을 쓰는 모든
  // 시트가 한꺼번에 덮이는 이유가 이 한 줄이다 — 시트마다 구독하지 않는다.
  useDismissOnEntry(() => slideOut());

  // 제자리로. 동작 줄이기가 켜져 있으면 미끄러지지 않고 바로 선다.
  const settle = useCallback(() => {
    if (reduceMotion.current) {
      travel.setValue(0);
      return;
    }
    Animated.spring(travel, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 0,
    }).start();
  }, [reduceMotion, travel]);

  // 끌기 응답자 둘: 가져가는 조건(`claimsSheetDrag`·`claimsSheetTouchStart`)만 다르고 따라가기·놓기는 같다. 응답자를 쥐는 길은 둘이다.
  //
  //   시작 응답자   누를 것이 아닌 자리(머리의 제목·손잡이 띠, 스크롤이 맨 위인 본문의 빈 자리)에서 시작한 터치. RN `Modal` 이 시작
  //                 응답자를 쥐고 플러그인이 시트(Modal 의 후손)에는 이동을 묻지 않으므로, 시트가 **시작에서** 잡아야 닿는다
  //                 (`claimsSheetTouchStart` 머리말). 잡은 뒤에는 얌전히 기다리다가 이동이 조건을 채우면 쥔다.
  //   이동 가로채기 단추·행·입력 위에서 시작한 터치(후손이 응답자다). 시트가 조상으로서 이동에서 가로챈다 — 그 눌림이 취소된다.
  const makePan = useCallback(
    (zone: DragZone) => {
      // 응답자마다 제 상태를 든다(머리·본문이 서로의 상태를 건드리지 않게). 응답자는 `useMemo` 로 한 번 만들어 끌기 내내 같은 것이다.
      //   engaged   끌기를 **실제로 쥐었는가**. 시작 응답자는 터치가 시작될 때 얌전히 응답자를 쥐고(armed) 이동이 조건을 채울 때 비로소 쥔다.
      //   dyBase    쥔 순간의 터치 시작부터의 이동 — 그때까지의 이동(첫 문턱)은 흡수한다.
      //   dyOffset  grant 가 `g.dy` 를 0 으로 되돌리기 전에 이미 움직인 거리(이동 가로채기 길). 시작 응답자 길은 0 이다.
      //   lastDy    가장 최근 이동 협상에서 본 `g.dy` — 가로채서 grant 가 오면 `dyOffset` 이 된다.
      //   stolen    이동 가로채기(`onMoveShouldSet…`)가 참을 돌려줬다 — 곧 오는 grant 는 이미 조건을 통과했으니 바로 쥔다.
      //   samples   놓는 속도를 잴 표본. **터치 시작부터** 모은다(쥐기 전의 이동 포함) — 빠른 튕김은 쥐는 첫 이벤트가 전체 이벤트의 상당수라,
      //             쥔 뒤의 표본만으로는 `VELOCITY_MIN_SAMPLES` 에 못 미쳐 속도가 0 으로 읽히고 「짧아도 빠르면 닫힘」이 꺼진다
      //             (시뮬레이터 실측: 100pt/100ms 튕김의 표본 2 → 속도 0, #4612 2단계). 응답자마다 따로 둔다 — 조상 응답자가 같은 이동을
      //             또 적어 표본 수를 부풀리지 않게.
      const state = {
        engaged: false,
        dyBase: 0,
        dyOffset: 0,
        lastDy: 0,
        stolen: false,
        samples: [] as DragSample[],
      };
      /** 터치 시작부터의 누적 이동(pt, 아래가 양수) — 어느 길로 쥐었든 같은 기준이다. */
      const travelled = (g: {dy: number}) => g.dy + state.dyOffset;
      const record = (e: Parameters<typeof stamp>[0], g: {dy: number}) => {
        state.samples.push({y: travelled(g), t: stamp(e)});
        if (state.samples.length > MAX_SAMPLES) state.samples.shift();
      };
      // 지금 이 이동이 끌기를 쥘 만한가(판정은 순수 함수).
      const wants = (g: {dx: number; dy: number; numberActiveTouches: number}) =>
        claimsSheetDrag({
          zone,
          dx: g.dx,
          dy: g.dy,
          touches: g.numberActiveTouches,
          closing: closing.current,
          scrollOffsets: [...scrolls.values()],
        });
      const engage = (g: {dy: number}) => {
        state.engaged = true;
        state.dyBase = travelled(g);
        setFrozen(true);
      };
      return PanResponder.create({
        // 새 터치(첫 손가락)마다 상태를 비운다. 캡처 길은 모든 후보를 지나므로 늘 돈다 — 쥐지는 않는다. 둘째 손가락의 시작은 끌기를 끊지 않는다.
        onStartShouldSetPanResponderCapture: e => {
          if (e.nativeEvent.touches.length === 1) {
            state.engaged = false;
            state.stolen = false;
            state.dyOffset = 0;
            state.lastDy = 0;
            state.samples = [{y: 0, t: stamp(e)}];
          }
          return false;
        },
        // 시작 응답자: 머리는 늘, 본문은 스크롤이 맨 위일 때만. 닫는 중에는 잡지 않는다(슬라이드를 끊으면 행동이 앞당겨 불린다).
        onStartShouldSetPanResponder: () =>
          claimsSheetTouchStart({
            zone,
            closing: closing.current,
            scrollOffsets: [...scrolls.values()],
            scrollsOverflow: [...overflows.values()].some(Boolean),
          }),
        // 이동 가로채기. 캡처 길이 먼저다: 단추·행 위에서 시작한 끌기를 가져와야 그 눌림이 취소된다.
        onMoveShouldSetPanResponderCapture: (e, g) => {
          // 쥐기 전의 이동도 속도 표본이다(캡처 길은 이동마다 한 번 돈다 — 같은 이벤트를 또 적지 않는다).
          state.lastDy = g.dy;
          record(e, g);
          const claim = wants(g);
          if (claim) state.stolen = true;
          return claim;
        },
        // 머리는 버블 길도 같은 판정이다(옛 손잡이 띠가 이 길이었다). 본문은 캡처 길뿐이다.
        onMoveShouldSetPanResponder: (_e, g) => {
          const claim = zone === 'header' && wants(g);
          if (claim) state.stolen = true;
          return claim;
        },
        // 끌기를 쥔 동안 다른 응답자(스크롤)가 가져가지 못하게 한다. 기다리는 동안에도 내주지 않는다 — 조상의 가로채기가 끌기를 둘로 쪼개지 않게.
        onPanResponderTerminationRequest: () => false,
        // 가로채서 쥔 길은 이미 조건을 통과했으니 바로 쥔다(`g.dy` 는 grant 가 0 으로 되돌렸다). 시작 응답자는 기다린다.
        onPanResponderGrant: (_e, g) => {
          if (state.stolen) {
            // 이미 움직인 거리(`lastDy`)는 grant 가 0 으로 되돌렸으니 기준에 더해 둔다. 그 이동은 위에서 표본으로 적혔다.
            state.stolen = false;
            state.dyOffset = state.lastDy;
            engage(g);
          } else {
            state.engaged = false;
            state.dyOffset = 0;
          }
        },
        onPanResponderMove: (e, g) => {
          record(e, g);
          if (!state.engaged) {
            // 기다리는 응답자: 탭·가로 쓸기·위로 쓸기는 시트가 할 일이 없다. 아래로 문턱을 넘고 세로가 앞서면 그때 쥔다.
            if (!wants({...g, dy: travelled(g)})) return;
            engage(g);
          }
          travel.setValue(sheetFollow(travelled(g) - state.dyBase));
        },
        onPanResponderRelease: (e, g) => {
          // 쥐지 않은 채 끝났다(탭·스크롤) — 시트가 할 일이 없다.
          if (!state.engaged) return;
          state.engaged = false;
          setFrozen(false);
          const offset = sheetFollow(travelled(g) - state.dyBase);
          const velocity = releaseVelocity(state.samples, stamp(e));
          if (!shouldDismissSheet(offset, velocity, boxRef.current)) {
            settle();
            return;
          }
          // 저장 안 한 입력이 있으면 제자리로 돌아온 뒤에 묻는다.
          if (backRef.current) {
            settle();
            Keyboard.dismiss();
            backRef.current();
            return;
          }
          if (dirtyRef.current) {
            settle();
            askDiscard();
            return;
          }
          slideOut(undefined, {offset, velocity});
        },
        // 시스템이 끌기를 거둬 갔다(알림·제스처): 어중간한 자리에 남지 않게 제자리로. 쥐지 않았으면 할 일이 없다.
        onPanResponderTerminate: () => {
          state.stolen = false;
          if (!state.engaged) return;
          state.engaged = false;
          setFrozen(false);
          settle();
        },
      });
    },
    [askDiscard, overflows, scrolls, settle, slideOut, travel],
  );
  const headerPan = useMemo(() => makePan('header'), [makePan]);
  const bodyPan = useMemo(() => makePan('body'), [makePan]);

  const control = useMemo<SheetControl>(
    () => ({close, closeThen, keyboardHeight: lifted, dragHandlers: headerPan.panHandlers}),
    [close, closeThen, lifted, headerPan],
  );
  const scrollPort = useMemo<SheetScrollPort>(() => ({scrolls, overflows, frozen}), [scrolls, overflows, frozen]);

  // 스크림은 시트가 내려간 만큼 **비례해** 옅어진다 — 시트가 제 높이만큼 내려 화면을 나가는 순간 0 이다.
  // 위로 늘어난(고무줄) 때는 clamp 로 더 짙어지지 않는다. 같은 두 점이 `scrimOpacity` 다.
  const scrimOpacityValue = travel.interpolate({
    inputRange: [0, Math.max(1, sheetBox)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const onSheetLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    if (next === measuredRef.current) return;
    measuredRef.current = next;
    setMeasured(next);
  }, []);

  return (
    <View style={styles.fill}>
      <Animated.View
        style={[StyleSheet.absoluteFill, {opacity: scrimOpacityValue}]}
        testID={`${scrimTestID}-fade`}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={scrimLabel}
          onPress={close}
          style={[StyleSheet.absoluteFill, styles.scrim]}
          testID={scrimTestID}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={accessibilityLabel}
        onAccessibilityEscape={close}
        onLayout={onSheetLayout}
        style={[styles.sheet, frame, {transform: [{translateY: travel}]}]}
        testID="page-sheet">
        <View {...headerPan.panHandlers} style={styles.handleZone} testID="page-sheet-handle">
          <View style={styles.grab} />
        </View>
        <SheetControlContext.Provider value={control}>
          <SheetScrollContext.Provider value={scrollPort}>
            <View
              {...bodyPan.panHandlers}
              style={sheetHeight === 'fit' ? styles.bodyFit : styles.body}
              testID="page-sheet-body">
              {children}
            </View>
          </SheetScrollContext.Provider>
        </SheetControlContext.Provider>
        {lifted > 0 ? (
          // 키보드 윗변은 모서리가 둥글다 — 시트 바닥(= 키보드 윗면) 바깥 좌우로 스크림이 쐐기 모양으로 비친다.
          // 시트 바탕을 키보드 뒤로 더 깔아 가린다(시트와 같이 미끄러져 나가도록 시트의 자식이다).
          <View pointerEvents="none" style={styles.keyboardCorner} testID="page-sheet-keyboard-corner" />
        ) : (
          // 위로 고무줄이 늘어나면 시트 바닥이 떠서 그 밑으로 스크림이 비친다. 늘어나는 상한만큼 시트 바탕을 밑에 깐다.
          // 평소에는 화면 밖이라 보이지 않는다.
          <View pointerEvents="none" style={styles.rubberSkirt} testID="page-sheet-skirt" />
        )}
      </Animated.View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    fill: {flex: 1},
    scrim: {backgroundColor: color.scrim},
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderTopLeftRadius: SHEET_RADIUS,
      borderTopRightRadius: SHEET_RADIUS,
      backgroundColor: color.sheet,
      // 시안 `.a-sheet{box-shadow:0 -10px 40px rgba(0,0,0,.18)}`.
      boxShadow: '0 -10px 40px rgba(0,0,0,.18)',
    },
    // 손잡이를 잡을 띠. 시안의 손잡이는 5pt 막대이고(여백 10 위·8 아래), 손가락이
    // 잡는 것은 그 막대가 아니라 이 띠다.
    handleZone: {
      paddingTop: 10,
      paddingBottom: 8,
      alignItems: 'center',
    },
    // 시안 `.a-grab{width:38px;height:5px;border-radius:3px;
    // background:color-mix(in srgb,var(--ink) 22%,transparent)}`.
    grab: {
      width: GRAB.width,
      height: GRAB.height,
      // 시안 3 은 높이 5 의 절반을 넘어 브라우저가 2.5 로 자른다 — 둥근 끝의 산수다.
      borderRadius: GRAB.height / 2,
      backgroundColor: `${color.text}38`,
    },
    // 가로 여백은 자식이 진다. 시안 `.a-sheet{padding:10px 16px 0}`의 16 은 자식의
    // `SAFE_GUTTER`(16)가 이미 들고 있고, 여기서 한 번 더 주면 묶음 카드가 32 로
    // 들어간다(design-review M1).
    body: {flex: 1},
    // 내용 맞춤 단은 높이가 정해져 있지 않다 — `flex: 1` 은 바탕 0 이라 내용이 0 으로 접힌다.
    // 줄어들 수만 있으면(스크롤뷰가 최대 높이 안으로 들어온다) 된다.
    bodyFit: {flexShrink: 1},
    // 시트 바닥 아래(키보드 뒤)로 나가 있다 — 키보드가 덮으므로 모서리 쐐기 말고는 보이지 않는다.
    keyboardCorner: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: -SHEET.keyboardCorner,
      height: SHEET.keyboardCorner,
      backgroundColor: color.sheet,
    },
    // 시트 바닥 아래 화면 밖에 깔린 바탕 — 위로 늘어나는 고무줄(`SHEET_RUBBER_MAX`)의 틈을 메운다.
    rubberSkirt: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: -SHEET_RUBBER_MAX,
      height: SHEET_RUBBER_MAX,
      backgroundColor: color.sheet,
    },
  });
