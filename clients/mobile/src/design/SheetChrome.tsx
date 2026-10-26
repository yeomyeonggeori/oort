import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {BAR_CONTROL_MAX_SCALE} from './atoms';
import {SHEET_ICON_SIZE, SHEET_ICONS} from './icons';
import {usePageSheetClose} from './PageSheet';
import {circleLook} from './sheetModel';
import {useStyles} from './theme';
import {
  font,
  SAFE_GUTTER,
  SHEET,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from './tokens';

// =============================================================================
// 시트·페이지의 머리 (#4318, Buzz 「상태 설정」 시트·설정 페이지 비공개 캡처).
//
// 바텀시트 머리: **오른쪽** 떠 있는 원형 X · 가운데 제목 · **왼쪽** 선택적 ✓(확정). ✓ 는 편집
// 시트에만 서고 입력 전에는 회색이다. 손잡이는 위 가운데이고 그릇(`PageSheet`)이 그린다.
// 페이지 머리: **왼쪽** 원형 X · 가운데 제목(오른쪽은 비어 있거나 `trailing`). 시트 안의 X 는
// 오른쪽, 페이지의 X 는 왼쪽 — 손이 가는 쪽이 「시트를 내리는 쪽」과 「페이지를 떠나는 쪽」으로
// 갈린다.
//
// 모든 닫기 단추는 **글자 없는 원형 X** 이고, 보조기술 이름(`closeLabel`)은 시트마다 다른
// 「… 닫기」 문장이라 **필수**다(기본값 「닫기」 를 두지 않는다 — 어느 시트를 닫는지 모른다).
// 시트 안에서 `onClose` 를 생략하면 그릇이 쥔 닫기(`usePageSheetClose`)가 불려 스크림·끌기와
// 같이 미끄러져 나간다.
//
// 원이 「떠 있는」 근거는 토큰이다(`sheetModel.circleLook`): 라이트 `surface` + 그림자, 다크는
// 그림자가 안 보이므로 한 단 위 `surfaceMuted` + 가장자리 한 줄.
// =============================================================================

/**
 * 떠 있는 원형 X. 눈에 보이는 원은 40, 눌림 영역은 44(`slopTo` 가 채운다).
 */
export function CloseCircle({
  label,
  onPress,
  testID,
}: {
  /** 보조기술 이름 — 「메시지 액션 닫기」처럼 무엇을 닫는지 말한다. */
  label: string;
  /** 생략하면 그릇(`PageSheet`)의 슬라이드 닫기. 시트 밖(페이지)에서는 필수다. */
  onPress?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const sheetClose = usePageSheetClose();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={slopTo(SHEET.circle)}
      onPress={onPress ?? sheetClose ?? undefined}
      style={({pressed}) => [styles.circle, pressed && styles.pressed]}
      testID={testID}>
      <Image source={SHEET_ICONS.close} style={styles.glyph} />
    </Pressable>
  );
}

/**
 * 확정 ✓ — 편집 시트의 왼쪽. `disabled`(입력 전·바뀐 것이 없음)이면 회색이고 눌리지 않는다.
 * 색이 아니라 `accessibilityState` 가 비활성을 말한다.
 */
export function ConfirmCheck({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      disabled={disabled}
      hitSlop={slopTo(SHEET.circle)}
      onPress={onPress}
      style={({pressed}) => [styles.check, pressed && styles.pressed]}
      testID={testID}>
      <Image
        source={SHEET_ICONS.check}
        style={[styles.checkGlyph, disabled && styles.checkGlyphOff]}
      />
    </Pressable>
  );
}

export interface SheetConfirm {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}

/** 바텀시트 머리: [✓] 제목 [X]. 양쪽 칸이 같은 폭이라 제목이 정확히 가운데에 선다. */
export function SheetHeader({
  title,
  closeLabel,
  onClose,
  closeTestID,
  confirm,
  titleTestID,
  testID,
}: {
  title: string;
  closeLabel: string;
  onClose?: () => void;
  closeTestID?: string;
  confirm?: SheetConfirm;
  titleTestID?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.side}>
        {confirm ? (
          <ConfirmCheck
            label={confirm.label}
            onPress={confirm.onPress}
            disabled={confirm.disabled}
            testID={confirm.testID}
          />
        ) : null}
      </View>
      <HeaderTitle title={title} testID={titleTestID} />
      <View style={[styles.side, styles.sideEnd]}>
        <CloseCircle label={closeLabel} onPress={onClose} testID={closeTestID} />
      </View>
    </View>
  );
}

/** 페이지 머리: [X] 제목 [trailing]. 페이지에는 그릇이 없으므로 `onClose` 가 필수다. */
export function PageHeader({
  title,
  closeLabel,
  onClose,
  closeTestID,
  trailing,
  titleTestID,
  testID,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  closeTestID?: string;
  trailing?: React.ReactNode;
  titleTestID?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.side}>
        <CloseCircle label={closeLabel} onPress={onClose} testID={closeTestID} />
      </View>
      <HeaderTitle title={title} testID={titleTestID} />
      <View style={[styles.side, styles.sideEnd]}>{trailing ?? null}</View>
    </View>
  );
}

function HeaderTitle({
  title,
  testID,
}: {
  title: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Text
      accessibilityRole="header"
      style={styles.title}
      numberOfLines={1}
      maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
      testID={testID}>
      {title}
    </Text>
  );
}

const buildStyles = (color: Palette) => {
  const look = circleLook(color);
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: SHEET.headerRow,
      paddingHorizontal: SAFE_GUTTER,
      gap: space.sm,
    },
    // 양쪽 칸이 같은 폭(44)이라 제목이 정확히 가운데다 — Buzz 의 `left:64 right:64` 와 같은 결과.
    side: {width: TOUCH_TARGET, justifyContent: 'center'},
    sideEnd: {alignItems: 'flex-end'},
    title: {
      flex: 1,
      textAlign: 'center',
      fontSize: font.heading,
      fontWeight: '600',
      color: color.text,
    },
    circle: {
      width: SHEET.circle,
      height: SHEET.circle,
      borderRadius: SHEET.circle / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: look.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: look.ring,
      boxShadow: color.elevationRest,
    },
    glyph: {
      width: SHEET_ICON_SIZE.close,
      height: SHEET_ICON_SIZE.close,
      tintColor: color.text,
    },
    check: {
      width: SHEET.circle,
      height: SHEET.circle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkGlyph: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      tintColor: color.text,
    },
    // 회색: 글자가 아니라 글리프라 비텍스트 3:1 을 지키는 `textFaint`(= core `line-strong`)다.
    checkGlyphOff: {tintColor: color.textFaint},
    pressed: {opacity: 0.6},
  });
};
