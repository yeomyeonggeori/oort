import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
} from 'react-native';

import {BAR_CONTROL_MAX_SCALE} from './atoms';
import {CONV_ICON_SIZE, CONV_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from './icons';
import {usePageSheetClose, usePageSheetDrag} from './PageSheet';
import {circleLook} from './sheetModel';
import {usePalette, useStyles} from './theme';
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
// 페이지 머리: **오른쪽** 원형 X · 가운데 제목(왼쪽은 비어 있다). **닫기 X 는 시트든 페이지든 어디서나 오른쪽
// 위다**(#4691, owner 10-27 「X 닫기 버튼이 우측 위에」 — #4457 이 정했던 「페이지의 X 는 왼쪽」을 바꿨다).
// 닫는 자리를 시트와 페이지가 나누지 않는다.
//
// 페이지 머리의 나가는 문은 두 모양이다(#4457, planner 결정): **X**(오른쪽)는 「이 페이지 전체를 닫는다」(스택의
// 첫 페이지·모달 페이지), **‹ 뒤로**(왼쪽)는 「한 겹만 벗긴다」(그 위에 쌓인 안쪽 장). iOS 의 관례와 같다 — X 는
// 나가는 문, ‹ 는 온 곳으로 한 걸음. 둘은 같은 원(같은 크기·채움·그림자)이고 글리프와 **자리**만 다르다(X 오른쪽,
// ‹ 왼쪽). 한 머리에 둘이 함께 서지 않는다(타입이 막는다).
//
// **한 칸은 한 가지만 든다**(#4691): X 의 칸(오른쪽)은 X 가 갖는다 — 그래서 X 머리에는 `trailing` 이 없다(타입이
// 막는다). ‹ 머리의 오른쪽 칸은 비어 있거나 `trailing`(페이지의 동작 하나)이 선다. X 머리의 왼쪽 칸은 비워 둔다 —
// 거기에 동작이 필요해지면 시트의 ✓ 처럼 왼쪽에 세운다(지금 쓰는 곳이 없어 부품을 만들지 않았다).
//
// 모든 닫기 단추는 **글자 없는 원형 X** 이고, 보조기술 이름(`closeLabel`)은 시트마다 다른
// 「… 닫기」 문장이라 **필수**다(기본값 「닫기」 를 두지 않는다 — 어느 시트를 닫는지 모른다).
// 시트 안에서 `onClose` 를 생략하면 그릇이 쥔 닫기(`usePageSheetClose`)가 불려 스크림·끌기와
// 같이 미끄러져 나간다. 바텀시트 머리는 손잡이 띠만이 아니라 **제목 줄 전체**가 끌기 영역이다(`usePageSheetDrag`, #4612).
//
// 원이 「떠 있는」 근거는 토큰이다(`sheetModel.circleLook`): 라이트 `surface` + 그림자, 다크는
// 그림자가 안 보이므로 한 단 위 `surfaceMuted` + 가장자리 한 줄.
// =============================================================================

/** 떠 있는 원 하나 — X 와 ‹ 가 같은 상자를 쓴다(글리프만 다르다). 보이는 원 40, 눌림 영역 44(`slopTo`). */
function HeaderCircle({
  glyph,
  glyphSize,
  label,
  onPress,
  testID,
}: {
  glyph: ImageSourcePropType;
  glyphSize: number;
  label: string;
  onPress?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={slopTo(SHEET.circle)}
      onPress={onPress}
      style={({pressed}) => [styles.circle, pressed && styles.pressed]}
      testID={testID}>
      <Image
        source={glyph}
        style={[styles.glyph, {width: glyphSize, height: glyphSize}]}
      />
    </Pressable>
  );
}

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
  const sheetClose = usePageSheetClose();
  return (
    <HeaderCircle
      glyph={SHEET_ICONS.close}
      glyphSize={SHEET_ICON_SIZE.close}
      label={label}
      onPress={onPress ?? sheetClose ?? undefined}
      testID={testID}
    />
  );
}

/**
 * 떠 있는 원형 ‹ 뒤로 — 페이지 안의 **안쪽 장**의 머리 왼쪽. 한 겹만 벗긴다(아래의 페이지는 남는다).
 * 글리프는 대화 머리의 「뒤로」와 같은 22pt 선 셰브론이다(새 에셋 없음, 뒤집어 그리지 않아 선명하다).
 */
export function BackCircle({
  label,
  onPress,
  testID,
}: {
  /** 보조기술 이름 — 어디로 돌아가는지 말한다(「설정으로 돌아가기」). 「닫기」가 아니다: 닫는 것이 아니라 돌아간다. */
  label: string;
  onPress: () => void;
  testID?: string;
}): React.JSX.Element {
  return (
    <HeaderCircle
      glyph={CONV_ICONS.left}
      glyphSize={CONV_ICON_SIZE.left}
      label={label}
      onPress={onPress}
      testID={testID}
    />
  );
}

/**
 * 확정 ✓ — 편집 시트의 왼쪽. `disabled`(입력 전·바뀐 것이 없음)이면 회색이고 눌리지 않는다.
 * 색이 아니라 `accessibilityState` 가 비활성을 말한다.
 *
 * `busy`(보내는 중·저장 중)면 ✓ 자리에 **스피너**가 서고 눌리지 않는다 — 옛 글자 단추는 라벨이 「보내는 중」으로 눈에 보이게
 * 바뀌었는데, 글리프에는 그 자리가 없어 왕복(Face ID 뒤 POST) 동안 「눌렸는가」가 안 보였다(#4458 보안 검수 M1).
 * 이름(`label`)에도 진행 낱말을 넣는 것은 호출자의 몫이다.
 */
export function ConfirmCheck({
  label,
  onPress,
  disabled = false,
  busy = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const inert = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: inert, busy}}
      disabled={inert}
      hitSlop={slopTo(SHEET.circle)}
      onPress={onPress}
      style={({pressed}) => [styles.check, pressed && styles.pressed]}
      testID={testID}>
      {busy ? (
        <ActivityIndicator color={palette.text} testID={testID ? `${testID}-busy` : undefined} />
      ) : (
        <Image
          source={SHEET_ICONS.check}
          style={[styles.checkGlyph, disabled && styles.checkGlyphOff]}
        />
      )}
    </Pressable>
  );
}

export interface SheetConfirm {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 왕복 중 — ✓ 자리에 스피너가 서고 눌리지 않는다(`ConfirmCheck`). */
  busy?: boolean;
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
  // 머리는 제목 줄 어디서든 시트를 끌어 내린다(#4612). 단추(X·✓) 위에서 시작한 끌기도 시트가 가져가고 그 눌림은 취소된다.
  const drag = usePageSheetDrag();
  return (
    <View {...drag} style={styles.header} testID={testID}>
      <View style={styles.side}>
        {confirm ? (
          <ConfirmCheck
            label={confirm.label}
            onPress={confirm.onPress}
            disabled={confirm.disabled}
            busy={confirm.busy}
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

/**
 * 페이지 머리의 나가는 문. **둘 중 하나**다 — 페이지를 떠나는 X(`closeLabel`·`onClose`, **오른쪽** 칸) 아니면 한 겹
 * 뒤로 가는 ‹(`back`, **왼쪽** 칸). 둘을 함께 받지 않는다(타입이 막는다): 한 머리에 나가는 문이 둘이면 어느 것이
 * 어디로 가는지 모른다. `trailing`(오른쪽 칸의 동작)은 ‹ 머리에만 있다 — X 머리의 오른쪽 칸은 X 의 것이다.
 */
type PageHeaderExit =
  | {
      closeLabel: string;
      onClose: () => void;
      closeTestID?: string;
      back?: undefined;
      trailing?: undefined;
    }
  | {
      back: {label: string; onPress: () => void; testID?: string};
      /** ‹ 머리의 오른쪽 칸 — 페이지의 동작 하나(글자 「편집」 같은 것). 생략하면 비어 있다. */
      trailing?: React.ReactNode;
      closeLabel?: undefined;
      onClose?: undefined;
      closeTestID?: undefined;
    };

/**
 * 페이지 머리: X 머리는 [ ] 제목 [X], ‹ 머리는 [‹] 제목 [trailing]. 페이지에는 그릇이 없으므로 `onClose`(또는
 * `back.onPress`)가 필수다.
 */
export function PageHeader({
  title,
  closeLabel,
  onClose,
  closeTestID,
  back,
  trailing,
  titleTestID,
  testID,
}: {
  title: string;
  titleTestID?: string;
  testID?: string;
} & PageHeaderExit): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.side}>
        {back ? (
          <BackCircle label={back.label} onPress={back.onPress} testID={back.testID} />
        ) : null}
      </View>
      <HeaderTitle title={title} testID={titleTestID} />
      <View style={[styles.side, styles.sideEnd]}>
        {back ? (
          (trailing ?? null)
        ) : (
          <CloseCircle label={closeLabel} onPress={onClose} testID={closeTestID} />
        )}
      </View>
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
    glyph: {tintColor: color.text},
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
