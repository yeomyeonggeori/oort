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
import {HOME_ICON_SIZE, HOME_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, SHEET, space, type Palette} from '../../design/tokens';

// =============================================================================
// 설정 페이지의 얇은 행 부품 (#4457).
//
// #4318 의 `design/sheetParts.tsx` `ListRow` 는 이 화면이 필요로 하는 세 가지를 갖고 있지 않았다:
//
//   1. **라디오** — `accessibilityRole="radio"` · `accessibilityState.selected` · 오른쪽 ✓.
//      **→ 이 PR 이 `design/sheetParts.tsx` 로 올렸다**(`ChoiceRow`). 테마 장(`ThemeControl`)이 `design/` 에 있어
//      feature 쪽 부품을 쓸 수 없고, 앱의 라디오가 모두 같은 세 신호(강조색·굵게·✓)를 쥐어야 해서다.
//   2. **읽는 중·못 읽음의 오른쪽 자리** — 스위치 대신 스피너(또는 아무것도 없음). 서버 값을 모르는
//      동안 「꺼짐」을 그리면 켜 둔 사람에게 거짓이다(푸시·일시 중지·작업 끝남·기억 스위치가 같은
//      약속을 지킨다). `ListRow accessory="toggle"` 은 언제나 스위치를 그린다.
//   3. **누를 수 있으되 접근성으로만 잠기는 상태** — 옛 `GroupRow` 가 하던 것: 읽는 중에는
//      `accessibilityState.disabled` 만 말하고 줄은 그대로 눌린다(눌림은 훅이 막는다).
//
// 1 은 올렸고(테마 장이 `design/` 에 있어 어쩔 수 없었다), 나머지는 **공용 부품에 같은 자리가 나기 전까지** 이 화면
// 쪽에 얇게 둔다(planner 지시: #4318 이 넣지 않은 것은 PR 「발견」으로 남긴다). 같은 토큰(`SHEET`·`space`·`font`·
// `line`)으로 같은 행 모양을 두므로, 모양이 갈라지면 그것이 바로 이 파일이 해야 할 일의 실패다
// (`settingsRows.test.tsx` 가 ListRow 와 같은 상자·글자를 모든 스킴에서 재서 지킨다). `ListRow`·`GroupCard`·`InputPill`
// 에 같은 자리가 나면 이 파일은 지워진다 — 무엇이 모자란지는 `docs/design-system/phone-sheets.md` §4 의 표에 있다.
//
//   SwitchRow   스위치 행: 이름 · 보조 줄 · 오른쪽 {스위치 | 스피너 | 없음}
//   ActionRow   동작 행: 이름 · 보조 줄 · 오른쪽 {셰브론 | 스피너 | 없음} · 강조·위험 글자 · 펼침 상태
//               (안쪽 장 — 프로필 사진·기한 고르기 — 이 옛 `GroupRow` 에서 옮겨 오며 쓴다. `ListRow` 에 없는 것은
//               오른쪽 끝의 진행 표시·강조 글자·`expanded` 셋이다)
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

/**
 * 동작 행: 누르면 무언가 일어난다(저장·열기·펼침). 옛 `GroupRow`(`chevron`·`trailing`·`tone`·`accessibilityState`)가
 * 하던 일을 새 행 모양으로 옮긴다. 모양은 `ListRow` 와 같다(같은 토큰) — 시험이 지킨다.
 *
 *  - `pending` 이면 오른쪽 끝이 스피너다(셰브론이 스피너로 바뀐다): 누른 행에서 진행이 보인다.
 *  - `tone="accent"` 는 강조색 글자(펼쳐 둔 「직접 고르기」, 「설정 열기」), `"danger"` 는 파괴 행(「사진 지우기」).
 *  - `expanded` 는 **제자리 펼침 행**이 보조기술에 말하는 상태이고, 주면 오른쪽 끝이 ⌄ 가 된다(펼치면 뒤집힘 ⌃) — `ListRow`
 *    `accessory="expand"` + `expanded` 와 같은 표지다. 셰브론 ›(`chevron`)은 「더 들어간다」, ⌄ 는 「여기서 고른다」로 갈린다
 *    (design-review #4457 r1 M4: 펼침이 세 가지 표지로 말해졌다). 주지 않으면 상태에 넣지 않는다(`false` 를 넘기지 않는
 *    관용구 — `Pressable` 이 그것도 접근성 상태에 섞는다).
 * 이름은 옛 `GroupRow` 처럼 제목이다(보조 줄을 섞지 않는다) — 바꾸려면 `accessibilityLabel` 을 준다.
 */
export function ActionRow({
  title,
  detail,
  chevron = false,
  pending = false,
  tone = 'default',
  expanded,
  disabled = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: {
  title: string;
  detail?: string;
  /** 오른쪽 끝의 ›. `pending` 이면 스피너가 대신 선다. `expanded` 가 있으면 ⌄ 가 이긴다. */
  chevron?: boolean;
  pending?: boolean;
  tone?: 'default' | 'accent' | 'danger';
  /** 제자리 펼침 행의 상태. 주면 오른쪽 끝은 ⌄(펼치면 ⌃)이고 보조기술에 펼침 상태가 읽힌다. */
  expanded?: boolean;
  /** 눌리지 않고 흐려진다(읽는 중·쓰는 중). */
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const state = {
    ...(disabled ? {disabled: true} : null),
    ...(expanded !== undefined ? {expanded} : null),
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={Object.keys(state).length > 0 ? state : undefined}
      // `false` 를 넘기지 않는다 — Pressable 은 그것도 접근성 상태에 섞는다(`GroupRow` 와 같은 관용구).
      disabled={disabled ? true : undefined}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
      <View style={styles.rowText}>
        <Text
          lineBreakStrategyIOS="hangul-word"
          style={[
            styles.rowTitle,
            tone === 'accent' && styles.rowTitleAccent,
            tone === 'danger' && styles.rowTitleDanger,
          ]}>
          {title}
        </Text>
        {detail ? <Sentence style={styles.rowDetail}>{detail}</Sentence> : null}
      </View>
      {pending ? (
        <ActivityIndicator
          color={palette.textMuted}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : expanded !== undefined ? (
        <Image
          source={HOME_ICONS.down}
          style={[styles.expand, expanded && styles.expandFlipped]}
          accessibilityElementsHidden
          testID={testID ? `${testID}-expand` : undefined}
        />
      ) : chevron ? (
        <Image source={SHEET_ICONS.chevron} style={styles.chevron} accessibilityElementsHidden />
      ) : null}
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
    rowText: {flex: 1},
    rowTitle: {fontSize: font.body, lineHeight: line.body, color: color.text},
    rowTitleAccent: {color: color.accentText, fontWeight: '600'},
    rowTitleDanger: {color: color.danger, fontWeight: '600'},
    chevron: {
      width: SHEET_ICON_SIZE.chevron,
      height: SHEET_ICON_SIZE.chevron,
      tintColor: color.icon,
    },
    // `ListRow` 의 펼침 글리프와 같다(같은 PNG·크기·색, 펼치면 뒤집힘).
    expand: {
      width: HOME_ICON_SIZE.down,
      height: HOME_ICON_SIZE.down,
      tintColor: color.icon,
    },
    expandFlipped: {transform: [{rotate: '180deg'}]},
    rowDetail: {
      marginTop: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
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
