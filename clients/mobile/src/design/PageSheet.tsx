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
// =============================================================================

export {SHEET_TOP};
/** 시안 `border-radius:30px 30px 0 0` — 폰 반경 사다리의 맨 위(themes-2.0 §5). */
export const SHEET_RADIUS = ds2Radius.sheet;
/** 시안 `.a-grab` 38×5. */
const GRAB = {width: 38, height: 5} as const;
const SLIDE_MS = 260;

const SheetCloseContext = createContext<(() => void) | null>(null);

/**
 * 시트 안의 「닫기」가 부를 것. 시트가 쥔 닫기를 부르면 스크림·끌기와 같이
 * 미끄러져 나간다. 시트 밖에서 부르면 `null`이다.
 */
export function usePageSheetClose(): (() => void) | null {
  return useContext(SheetCloseContext);
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
  const travel = useRef(new Animated.Value(height)).current;
  const closing = useRef(false);

  // 단계별 상자. 큰 단은 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서 그 아래 4pt 에서
  // 시작한다 — 58 은 시안 기기(390×844, 상태 막대 54)의 값이라 그 위에 올리면 시계와 겹친다.
  const frame = sheetFrame(sheetHeight, height, insets.top);

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

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reduceMotion.current) {
      onClose();
      return;
    }
    Animated.timing(travel, {
      toValue: height,
      duration: SLIDE_MS,
      useNativeDriver: true,
    }).start(() => onClose());
  }, [height, onClose, reduceMotion, travel]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
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
        <SheetCloseContext.Provider value={close}>
          <View style={sheetHeight === 'fit' ? styles.bodyFit : styles.body}>
            {children}
          </View>
        </SheetCloseContext.Provider>
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
