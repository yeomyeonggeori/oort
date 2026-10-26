import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import {Sentence} from '../../design/atoms';
import {SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, SHEET, space, type Palette} from '../../design/tokens';

// =============================================================================
// 설정 페이지의 얇은 행 부품 (#4457).
//
// #4318 의 `design/sheetParts.tsx` `ListRow` 는 이 화면이 필요로 하는 세 가지를 갖고 있지 않다:
//
//   1. **라디오** — `accessibilityRole="radio"` · `accessibilityState.selected` · 오른쪽 ✓.
//      선언 상태 3줄(온라인·자리 비움·방해 금지)과 상태 시트의 지우기 기간 선택이 쓴다.
//   2. **읽는 중·못 읽음의 오른쪽 자리** — 스위치 대신 스피너(또는 아무것도 없음). 서버 값을 모르는
//      동안 「꺼짐」을 그리면 켜 둔 사람에게 거짓이다(푸시·일시 중지·작업 끝남·기억 스위치가 같은
//      약속을 지킨다). `ListRow accessory="toggle"` 은 언제나 스위치를 그린다.
//   3. **누를 수 있으되 접근성으로만 잠기는 상태** — 옛 `GroupRow` 가 하던 것: 읽는 중에는
//      `accessibilityState.disabled` 만 말하고 줄은 그대로 눌린다(눌림은 훅이 막는다).
//
// `design/` 의 부품 파일은 이 이슈가 고치지 않는다(#4318 2단계가 거기를 만지고 있다). 그래서 같은
// 토큰(`SHEET`·`space`·`font`·`line`)으로 같은 행 모양을 이 화면 쪽에 얇게 둔다 — 모양이 갈라지면
// 그것이 바로 이 파일이 해야 할 일의 실패다(`settingsPage.test.tsx` 가 치수를 재서 지킨다). #4318 이
// `ListRow` 에 같은 자리를 내면 이 파일은 지워진다.
//
//   ChoiceRow   라디오 행: 앞 점(선택) · 이름 · 보조 줄 · 오른쪽 ✓
//   SwitchRow   스위치 행: 이름 · 보조 줄 · 오른쪽 {스위치 | 스피너 | 없음}
//   SettingsSection  카드 하나와 그 밑의 문장들(실패·안내)을 한 덩어리로
//   SettingsNote     카드 밑의 한 문장(실패는 위험색 + 라이브 영역)
// =============================================================================

/** 스위치 행의 오른쪽 자리. 서버 값을 모르는 동안은 스위치를 그리지 않는다. */
export type SwitchControl =
  | {
      kind: 'switch';
      value: boolean;
      onValueChange: (next: boolean) => void;
      /** 스위치 자신만 잠근다 — 줄의 눌림은 그대로다(눌러도 훅이 아무것도 보내지 않는다). */
      disabled?: boolean;
      testID?: string;
    }
  | {kind: 'loading'; testID?: string}
  | {kind: 'none'};

export function SwitchRow({
  title,
  detail,
  checked,
  a11yDisabled = false,
  control,
  onPress,
  accessibilityHint,
  testID,
}: {
  title: string;
  detail?: string;
  /** 줄이 말하는 켬/끔. `accessibilityState.checked` 로 읽힌다. */
  checked: boolean;
  /** 보조기술에 「잠김」으로만 알린다(읽는 중·쓰는 중). 눌림 자체는 막지 않는다. */
  a11yDisabled?: boolean;
  control: SwitchControl;
  onPress: () => void;
  accessibilityHint?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{checked, disabled: a11yDisabled}}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
      testID={testID}>
      <View style={styles.rowText}>
        <Text lineBreakStrategyIOS="hangul-word" style={styles.rowTitle}>
          {title}
        </Text>
        {detail ? <Sentence style={styles.rowDetail}>{detail}</Sentence> : null}
      </View>
      {control.kind === 'switch' ? (
        <Switch
          value={control.value}
          onValueChange={control.onValueChange}
          disabled={control.disabled}
          // 꺼짐 트랙은 컨트롤 경계라 비텍스트 3:1(`textFaint`) — `ListRow` 의 토글과 같은 값이다(`border` 는
          // 카드 위에서 1.3~2.1:1 이라 꺼진 스위치가 안 보였다). 앱에 꺼짐 색이 둘이 되지 않게 한다.
          trackColor={{false: palette.textFaint, true: palette.ok}}
          ios_backgroundColor={palette.textFaint}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={control.testID}
        />
      ) : control.kind === 'loading' ? (
        <ActivityIndicator
          color={palette.textMuted}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={control.testID}
        />
      ) : null}
    </Pressable>
  );
}

export function ChoiceRow({
  title,
  detail,
  selected,
  leading,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  checkTestID,
}: {
  title: string;
  detail?: string;
  selected: boolean;
  /** 앞 표지(상태 점). 장식이라 읽히지 않는다. 제목 첫 줄의 가운데에 선다. */
  leading?: React.ReactNode;
  onPress: () => void;
  /** 쓰는 중(다른 선택이 날아가는 동안). 눌리지 않고 흐려진다. */
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  /** 선택된 줄의 ✓ 에만 붙는다 — 선택되지 않은 줄에는 ✓ 가 그려지지 않는다. */
  checkTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={disabled ? {selected, disabled: true} : {selected}}
      // `false` 를 넘기지 않는다 — Pressable 은 그것도 접근성 상태에 섞는다(`GroupRow` 와 같은 관용구).
      disabled={disabled ? true : undefined}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        // 설명 줄이 붙은 행은 위로 붙인다 — 점과 ✓ 가 제목 첫 줄 옆에 선다(설명 줄 쪽으로 쏠리지 않게).
        detail ? styles.rowTop : null,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
      {leading ? (
        <View
          style={styles.rowLead}
          importantForAccessibility="no"
          testID={testID ? `${testID}-lead` : undefined}>
          {leading}
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text
          lineBreakStrategyIOS="hangul-word"
          style={[styles.rowTitle, selected && styles.rowTitleSelected]}>
          {title}
        </Text>
        {detail ? <Sentence style={styles.rowDetail}>{detail}</Sentence> : null}
      </View>
      <View style={styles.checkSlot}>
        {selected ? (
          <Image
            source={SHEET_ICONS.check}
            style={styles.check}
            accessibilityElementsHidden
            importantForAccessibility="no"
            testID={checkTestID}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** 묶음 카드 하나와 그 밑의 문장들. 카드 사이 간격(`space.lg`)은 부모가 쥐고, 이 안은 라벨·카드 사이와 같은 `space.sm`이다. */
export function SettingsSection({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.section} testID={testID}>
      {children}
    </View>
  );
}

/** 카드 밑의 한 문장. `tone="danger"` 는 실패 — 라이브 영역이라 나타나는 순간 읽힌다. */
export function SettingsNote({
  children,
  tone = 'muted',
  testID,
}: {
  children: string;
  tone?: 'muted' | 'danger';
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Sentence
      accessibilityLiveRegion={tone === 'danger' ? 'polite' : undefined}
      style={[styles.note, tone === 'danger' && styles.noteDanger]}
      testID={testID}>
      {children}
    </Sentence>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 행 모양은 `sheetParts.tsx` `ListRow` 와 같다(같은 토큰) — 위 머리 주석.
    row: {
      minHeight: SHEET.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    rowPressed: {backgroundColor: color.surfacePressed},
    rowDisabled: {opacity: 0.55},
    rowTop: {alignItems: 'flex-start'},
    // 앞 칸은 아이콘 칸(22) 폭이라 카드의 `inset="icon"` 구분선이 글자 열에 맞는다. 높이는 제목 한
    // 줄이라(`rowTop` 과 함께) 점이 설명 줄이 붙은 행에서도 제목 첫 줄 옆에 선다.
    rowLead: {
      width: SHEET.iconSlot,
      height: line.body,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: space.sm,
    },
    rowText: {flex: 1},
    rowTitle: {fontSize: font.body, lineHeight: line.body, color: color.text},
    rowTitleSelected: {fontWeight: '600'},
    rowDetail: {
      marginTop: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    checkSlot: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      alignItems: 'center',
      justifyContent: 'center',
    },
    check: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      tintColor: color.accentText,
    },
    section: {gap: space.sm},
    note: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      paddingHorizontal: space.xs,
    },
    noteDanger: {color: color.dangerText},
  });
