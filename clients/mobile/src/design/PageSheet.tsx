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
// =============================================================================

/** 시안 `.a-sheet{top:58px}` — 상태 막대 바로 아래. */
export const SHEET_TOP = 58;
/** 시안 `border-radius:30px 30px 0 0` — 폰 반경 사다리의 맨 위(themes-2.0 §5). */
export const SHEET_RADIUS = ds2Radius.sheet;
/** 시안 `.a-grab` 38×5. */
const GRAB = {width: 38, height: 5} as const;
/** 이만큼 끌어내리면 닫는다. 손잡이 높이의 몇 배가 아니라 「절반쯤 내렸다」의 체감값. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 1.1;
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
}: {
  onClose: () => void;
  /** 시트가 무엇인지. 보조기술이 모달에 들어설 때 읽는다. */
  accessibilityLabel: string;
  children: React.ReactNode;
  testID?: string;
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
        <SheetFrame onClose={onClose} accessibilityLabel={accessibilityLabel}>
          {children}
        </SheetFrame>
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetFrame({
  onClose,
  accessibilityLabel,
  children,
}: {
  onClose: () => void;
  accessibilityLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {height} = useWindowDimensions();
  const reduceMotion = useReduceMotionRef();
  const travel = useRef(new Animated.Value(height)).current;
  const closing = useRef(false);

  // 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서는 그 아래 4pt에서 시작한다.
  // 58은 시안 기기(390×844, 상태 막대 54)의 값이라, 그보다 깊은 막대 위에 시트를
  // 올리면 시계와 겹친다.
  const top = Math.max(SHEET_TOP, insets.top + 4);

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
          if (g.dy > DISMISS_DISTANCE || g.vy > DISMISS_VELOCITY) {
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
          accessibilityLabel="시트 닫기"
          onPress={close}
          style={[StyleSheet.absoluteFill, styles.scrim]}
          testID="page-sheet-scrim"
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={accessibilityLabel}
        onAccessibilityEscape={close}
        style={[styles.sheet, {top, transform: [{translateY: travel}]}]}
        testID="page-sheet">
        <View {...pan.panHandlers} style={styles.handleZone} testID="page-sheet-handle">
          <View style={styles.grab} />
        </View>
        <SheetCloseContext.Provider value={close}>
          <View style={styles.body}>{children}</View>
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
    body: {flex: 1, paddingHorizontal: 16},
  });
