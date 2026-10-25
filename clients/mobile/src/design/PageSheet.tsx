import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  Animated,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {useKeyboardHeight} from '../lib/useKeyboardHeight';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import {
  SHEET_TOP,
  sheetFrame,
  shouldDismissSheet,
  type SheetHeight,
} from './sheetModel';
import {useStyles} from './theme';
import {ds2Radius, type Palette} from './tokens';

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
//   - 끌어내려 닫기: 손잡이 띠(맨 위 23pt)를 잡고 내리면 따라오고, 충분히
//     내리거나 빠르게 튕기면 닫힌다. 모자라면 제자리로 돌아간다.
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
// =============================================================================

export {SHEET_TOP};
/** 시안 `border-radius:30px 30px 0 0` — 폰 반경 사다리의 맨 위(themes-2.0 §5). */
export const SHEET_RADIUS = ds2Radius.sheet;
/** 시안 `.a-grab` 38×5. */
const GRAB = {width: 38, height: 5} as const;
const SLIDE_MS = 260;

/** 시트가 자식에게 쥐여 주는 것. 시트 밖에서는 `null` 이다. */
interface SheetControl {
  /** 미끄러져 내린 뒤 `onClose`. X·스크림·끌기와 같은 길이다. */
  close: () => void;
  /** 미끄러져 내린 뒤 `onClose` 를 부르고, 이어서 `action` 을 **한 번** 부른다. */
  closeThen: (action: () => void) => void;
  /** 소프트 키보드가 가린 높이(내려가 있으면 0). */
  keyboardHeight: number;
}

const SheetControlContext = createContext<SheetControl | null>(null);

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

export function PageSheet({
  onClose,
  accessibilityLabel,
  children,
  testID,
  height = 'large',
  scrimTestID = 'page-sheet-scrim',
  scrimLabel = '시트 닫기',
}: {
  onClose: () => void;
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
}): React.JSX.Element {
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={onClose}
      testID={testID}>
      <SafeAreaProvider>
        <SheetFrame
          onClose={onClose}
          accessibilityLabel={accessibilityLabel}
          height={height}
          scrimTestID={scrimTestID}
          scrimLabel={scrimLabel}>
          {children}
        </SheetFrame>
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetFrame({
  onClose,
  accessibilityLabel,
  height: sheetHeight,
  scrimTestID,
  scrimLabel,
  children,
}: {
  onClose: () => void;
  accessibilityLabel: string;
  height: SheetHeight;
  scrimTestID: string;
  scrimLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {height} = useWindowDimensions();
  const reduceMotion = useReduceMotionRef();
  const keyboardHeight = useKeyboardHeight();
  // 시트가 서기 **전에** 이미 올라와 있던 키보드는 시트의 것이 아니다 — 대화 입력창이 키보드를 든 채 길게 눌러
  // 연 시트다. 닫을 때 그것을 접으면 「답글 달기」를 누른 사람의 키보드를 닫아 주고 마는 화면이 된다
  // (`messageTap.test`). 시트가 선 뒤에 올라온 키보드는 시트 안의 입력이 부른 것이라 시트와 같이 내린다.
  // 키보드가 한 번 내려가면 그 뒤에 올라오는 것은 더 이상 「서기 전부터」가 아니다.
  const keyboardWasUp = useRef(keyboardHeight > 0);
  useEffect(() => {
    if (keyboardHeight === 0) keyboardWasUp.current = false;
  }, [keyboardHeight]);
  // 닫는 길의 정체성을 고정한다: `onClose`(부모가 렌더마다 새 화살표를 줄 수 있다)와 키보드 높이를 ref 로 읽는다.
  // 안 그러면 부모가 리렌더될 때마다 `close` 가 새로 만들어져 끌기 응답자(`pan`)가 새 인스턴스로 갈리고(끄는
  // 도중이면 제스처가 리셋된다) `usePageSheetClose()` 를 의존성으로 든 소비자의 효과가 다시 돈다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const keyboardRef = useRef(keyboardHeight);
  keyboardRef.current = keyboardHeight;
  const travel = useRef(new Animated.Value(height)).current;
  const closing = useRef(false);

  // 단계별 상자. 큰 단은 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서 그 아래 4pt 에서
  // 시작한다 — 58 은 시안 기기(390×844, 상태 막대 54)의 값이라 그 위에 올리면 시계와 겹친다.
  // 내용 맞춤·중간 단은 키보드가 올라와 있으면 시트의 바닥이 키보드 윗면에 앉는다(`sheetFrame` 머리말).
  const frame = sheetFrame(sheetHeight, height, insets.top, keyboardHeight);
  // 시트가 실제로 올라간 높이. 큰 단은 올리지 않으므로 0 이다(몸 스크롤이 안전 영역 여백을 걷을지 정한다).
  const lifted = sheetHeight === 'large' ? 0 : keyboardHeight;

  useEffect(() => {
    if (reduceMotion.current) {
      travel.setValue(0);
      return;
    }
    Animated.timing(travel, {
      toValue: 0,
      duration: SLIDE_MS,
      useNativeDriver: true,
    }).start();
  }, [travel, reduceMotion]);

  // 닫는 길은 하나다 — X·스크림·끌기·escape·행동 누름이 전부 여기를 지난다. `after` 는 행동 누름만
  // 싣는다. 이 함수를 `onPress` 에 직접 걸지 않는다(Pressable 이 첫 인자로 이벤트를 넘긴다):
  // 아래 `close`·`closeThen` 이 인자를 못 박아 감싼다.
  const slideOut = useCallback(
    (after?: () => void) => {
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
        duration: SLIDE_MS,
        useNativeDriver: true,
      }).start(finish);
    },
    [height, reduceMotion, travel],
  );
  const close = useCallback(() => slideOut(), [slideOut]);
  const closeThen = useCallback(
    (action: () => void) => slideOut(action),
    [slideOut],
  );
  const control = useMemo<SheetControl>(
    () => ({close, closeThen, keyboardHeight: lifted}),
    [close, closeThen, lifted],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 닫는 중에는 잡지 않는다: 끌기가 슬라이드를 끊으면 애니메이션이 `finished:false` 로 끝나 `onClose` 와
        // 행동이 그 자리에서 앞당겨 불리고 시트가 스냅으로 사라진다.
        onMoveShouldSetPanResponder: (_e, g) =>
          !closing.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => travel.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_e, g) => {
          if (shouldDismissSheet(g.dy, g.vy)) {
            close();
            return;
          }
          Animated.spring(travel, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        },
      }),
    [close, travel],
  );

  const scrimOpacity = travel.interpolate({
    inputRange: [0, height],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.fill}>
      <Animated.View style={[StyleSheet.absoluteFill, {opacity: scrimOpacity}]}>
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
        style={[styles.sheet, frame, {transform: [{translateY: travel}]}]}
        testID="page-sheet">
        <View {...pan.panHandlers} style={styles.handleZone} testID="page-sheet-handle">
          <View style={styles.grab} />
        </View>
        <SheetControlContext.Provider value={control}>
          <View style={sheetHeight === 'fit' ? styles.bodyFit : styles.body}>
            {children}
          </View>
        </SheetControlContext.Provider>
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
  });
