// =============================================================================
// 폰 온보딩 화면의 뼈대와 버튼 (#2819 M0·M2·M-a·M-b, #2820 M3).
//
// 값은 시안 `claudedocs/onboarding-2.0/mockups.html`의 폰 CSS다(줄마다 원문).
// 고정 높이는 `minHeight`로 옮긴다: 큰 글씨에서 글자가 상자를 밀고 나가야 한다.
//
// 버튼은 셸의 `PrimaryButton`(신호색 채움)을 쓰지 않는다. 온보딩 문법(D11)은
// 주 행동 = 잉크 채움, 보조 = 테두리, 신호색 오렌지는 진행 점과 포커스뿐이다.
// =============================================================================

import React, {useEffect, useRef} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {OnboardingDots as OnboardingDotsModel} from '@momo/core/features/onboarding/guide';

import {usePalette, useStyles} from '../../design/theme';
import {TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {OnboardingCanvas, OnboardingDots} from './KomettoGuide';

/** 시안 폰 CSS 값. 줄마다 원문. */
export const PHONE_OB = {
  /** `.p-body{padding:0 22px 34px}` */
  gutter: 22,
  bottom: 34,
  /** `.p-top{height:44px}` */
  topBar: 44,
  /** `.p-top` 오른쪽 `<span style="width:28px">` */
  topSpacer: 28,
  /** `.p-main{gap:18px}`, M2·M3 `style="gap:22px"`, M0 `gap:12px` */
  mainGap: 18,
  mainGapWide: 22,
  heroGap: 12,
  /** `.p-bottom{gap:10px}` */
  bottomGap: 10,
  /** `.btn.lg{height:54px;border-radius:14px;font-size:16.5px}` */
  buttonLg: 54,
  buttonLgRadius: 14,
  buttonLgFont: 16.5,
  /** `.btn{gap:8px;padding:0 18px;font-weight:600}` */
  buttonGap: 8,
  buttonPadH: 18,
  /** `.btn.ghost{height:36px;font-weight:500}` + `.btn{font-size:15px}` */
  ghostFont: 15,
  /** `.ic{width:18px;height:18px;stroke-width:1.8}` */
  icon: 18,
  iconStroke: 1.8,
  /** `.spin{width:14px;height:14px;border:2px solid}` */
  spin: 14,
  spinStroke: 2,
  /** `.sys` 폰 M2 `font-size:14px` */
  sysFont: 14,
  /** `.link` 줄 `gap:18px;font-size:14px` · `text-underline-offset:3px` */
  linkGap: 18,
  linkFont: 14,
  /** `.field{gap:6px}` · `.field label{font-size:13px;font-weight:600}` */
  fieldGap: 6,
  labelFont: 13,
  /** `.input{height:44px;border-radius:10px;padding:0 14px;font-size:15px}` */
  input: 44,
  inputRadius: 10,
  inputPadH: 14,
  /** `.hint{font-size:12.5px}` */
  hintFont: 12.5,
  /** `.col{gap:16px}` (D1′ 폼) */
  formGap: 16,
} as const;

// ---- 화면 뼈대 ---------------------------------------------------------------

/**
 * 새벽하늘 바닥 위 폰 온보딩 한 장(`.p-body`). 위 막대 · 가운데(질문) · 아래(행동).
 * 가운데가 넘치면(큰 글씨·작은 폰) 전체가 스크롤한다. 가로로는 넘치지 않는다.
 */
export function OnboardingPhoneScreen({
  top,
  children,
  bottom,
  mainStyle,
  decoration,
  testID,
}: {
  top?: React.ReactNode;
  children: React.ReactNode;
  bottom?: React.ReactNode;
  mainStyle?: StyleProp<ViewStyle>;
  /** 바닥 위, 내용 아래에 까는 장식(다크 M0의 별). */
  decoration?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <OnboardingCanvas>
      {decoration}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.body,
          {
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, PHONE_OB.bottom),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={false}
        testID={testID}
      >
        {top}
        <View style={[styles.main, mainStyle]}>{children}</View>
        {bottom ? <View style={styles.bottom}>{bottom}</View> : null}
      </ScrollView>
    </OnboardingCanvas>
  );
}

/** `.p-top`: 왼쪽 행동 · 가운데 진행 점 · 오른쪽 빈칸. */
export function OnboardingTopBar({
  left,
  dots,
}: {
  left?: React.ReactNode;
  dots: OnboardingDotsModel | null;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.topBar}>
      <View style={styles.topSide}>{left}</View>
      <OnboardingDots dots={dots} />
      <View style={[styles.topSide, styles.topSideRight]} />
    </View>
  );
}

// ---- 버튼 --------------------------------------------------------------------

export type OnboardingButtonKind = 'primary' | 'secondary';

/**
 * `.btn.pri.lg`(잉크 채움) / `.btn.sec.lg`(테두리). 진행 중이면 낱말 옆에서
 * 표시기가 돈다(셸 `PrimaryButton`과 같은 `busyLabel` 관례, 말줄임 없음).
 */
export function OnboardingButton({
  label,
  kind = 'primary',
  onPress,
  disabled,
  busy,
  busyLabel,
  icon,
  accessibilityHint,
  testID,
}: {
  label: string;
  kind?: OnboardingButtonKind;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  icon?: React.ReactNode;
  accessibilityHint?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const inert = disabled === true || busy === true;
  const primary = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy && busyLabel ? busyLabel : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled: inert, busy}}
      disabled={inert}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        inert && styles.buttonInert,
        pressed &&
          !inert &&
          (primary
            ? styles.buttonPrimaryPressed
            : styles.buttonSecondaryPressed),
      ]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator color={primary ? palette.onPrimary : palette.text} />
      ) : (
        icon
      )}
      <Text
        style={[
          styles.buttonLabel,
          primary ? styles.onPrimary : styles.onSecondary,
        ]}
        numberOfLines={2}
      >
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Pressable>
  );
}

/** `.btn.ghost`: 막대의 「취소」·「뒤로」. 누를 자리는 44를 지킨다. */
export function OnboardingGhostButton({
  label,
  onPress,
  accessibilityHint,
  testID,
}: {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({pressed}) => [styles.ghost, pressed && styles.pressedText]}
      testID={testID}
    >
      <Text style={styles.ghostLabel}>{label}</Text>
    </Pressable>
  );
}

/** `.link`(M0 아래 작은 링크). 색은 시안 인라인 `color:var(--ink2)`. */
export function OnboardingLink({
  label,
  onPress,
  accessibilityHint,
  testID,
}: {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({pressed}) => [styles.link, pressed && styles.pressedText]}
      testID={testID}
    >
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}

/** M0 아래 링크 줄. 좁으면 두 줄로 접힌다(가로 넘침 0). */
export function OnboardingLinkRow({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <View style={styles.linkRow}>{children}</View>;
}

// ---- 글리프 ------------------------------------------------------------------

/**
 * 시안 QR 버튼 아이콘(모서리 넷 + 가운데 가로줄). 폰에 SVG가 없어서 선으로 긋는다.
 * 장식이라 VoiceOver에서 숨긴다(버튼 라벨이 말한다).
 */
export function QrGlyph({color}: {color: string}): React.JSX.Element {
  const s = PHONE_OB.icon;
  const w = PHONE_OB.iconStroke;
  // 24 격자의 모서리 길이 4, 여백 4를 18로 줄인다.
  const inset = (4 / 24) * s;
  const arm = (4 / 24) * s;
  const corner = (extra: ViewStyle): ViewStyle => ({
    position: 'absolute',
    width: arm,
    height: arm,
    borderColor: color,
    ...extra,
  });
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{width: s, height: s}}
      testID="qr-glyph"
    >
      <View
        style={corner({
          top: inset,
          left: inset,
          borderTopWidth: w,
          borderLeftWidth: w,
          borderTopLeftRadius: w,
        })}
      />
      <View
        style={corner({
          top: inset,
          right: inset,
          borderTopWidth: w,
          borderRightWidth: w,
          borderTopRightRadius: w,
        })}
      />
      <View
        style={corner({
          bottom: inset,
          left: inset,
          borderBottomWidth: w,
          borderLeftWidth: w,
          borderBottomLeftRadius: w,
        })}
      />
      <View
        style={corner({
          bottom: inset,
          right: inset,
          borderBottomWidth: w,
          borderRightWidth: w,
          borderBottomRightRadius: w,
        })}
      />
      <View
        style={[
          glyphStyles.bar,
          {
            left: (8 / 24) * s,
            right: (8 / 24) * s,
            top: s / 2 - w / 2,
            height: w,
            borderRadius: w / 2,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

const glyphStyles = StyleSheet.create({
  bar: {position: 'absolute'},
  spin: {
    width: PHONE_OB.spin,
    height: PHONE_OB.spin,
    borderRadius: PHONE_OB.spin / 2,
    borderWidth: PHONE_OB.spinStroke,
    borderRightColor: 'transparent',
  },
});

/** `.spin`: 대기 표시. 「동작 줄이기」면 돌지 않는다(정지한 고리도 문장과 함께 뜻이 선다). */
export function OnboardingSpinner({color}: {color: string}): React.JSX.Element {
  const reduceMotion = useReduceMotion();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, turn]);
  const rotate = turn.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="onboarding-spinner"
      style={[
        glyphStyles.spin,
        {
          borderColor: color,
          transform: reduceMotion ? undefined : [{rotate}],
        },
      ]}
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    flex: {flex: 1},
    body: {
      flexGrow: 1,
      paddingHorizontal: PHONE_OB.gutter,
    },
    main: {
      flexGrow: 1,
      justifyContent: 'center',
      gap: PHONE_OB.mainGap,
    },
    bottom: {gap: PHONE_OB.bottomGap},
    topBar: {
      minHeight: PHONE_OB.topBar,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topSide: {minWidth: PHONE_OB.topSpacer, alignItems: 'flex-start'},
    topSideRight: {alignItems: 'flex-end'},
    button: {
      minHeight: PHONE_OB.buttonLg,
      borderRadius: PHONE_OB.buttonLgRadius,
      paddingHorizontal: PHONE_OB.buttonPadH,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: PHONE_OB.buttonGap,
    },
    buttonPrimary: {backgroundColor: color.primary},
    buttonPrimaryPressed: {opacity: 0.86},
    buttonSecondary: {
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: 'transparent',
    },
    buttonSecondaryPressed: {backgroundColor: color.surfacePressed},
    // 못 누르는 주 행동: 채움을 걷고 옅은 칸으로 둔다(잉크가 서 있으면 눌러도 되는 줄 안다).
    buttonInert: {backgroundColor: color.surfaceMuted, borderWidth: 0},
    buttonLabel: {
      fontSize: PHONE_OB.buttonLgFont,
      fontWeight: '600',
      textAlign: 'center',
      flexShrink: 1,
    },
    onPrimary: {color: color.onPrimary},
    onSecondary: {color: color.text},
    ghost: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      justifyContent: 'center',
    },
    ghostLabel: {
      color: color.textMuted,
      fontSize: PHONE_OB.ghostFont,
      fontWeight: '500',
    },
    pressedText: {opacity: 0.6},
    linkRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      columnGap: PHONE_OB.linkGap,
    },
    link: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    linkLabel: {
      color: color.textMuted,
      fontSize: PHONE_OB.linkFont,
      fontWeight: '600',
      textDecorationLine: 'underline',
    },
  });
