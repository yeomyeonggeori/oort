import React, {forwardRef} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ImageSourcePropType,
  type TextInputProps,
} from 'react-native';

import {Sentence} from '../design/atoms';
import {SHEET_ICON_SIZE, SHEET_ICONS} from '../design/icons';
import {GroupCard, GroupLabel} from '../design/sheetParts';
import {useKeyboardAppearance, usePalette, useStyles} from '../design/theme';
import {ds2Radius, font, line, radius, SHEET, space, type Palette} from '../design/tokens';

// =============================================================================
// 폼 시트의 **임시 부품** (#4458). 폼이 있는 큰 시트(새 채널·내 맥에 보내기·작업 맡기기)가 공용 시트 부품
// (`design/sheetParts.tsx`)에서 못 찾은 것들이다. `design/` 의 부품 파일은 이 이슈가 고치지 않는다(#4457 이 같은
// 파일을 고치는 중이라 소유가 겹친다) — 그래서 여기 두고, 정식 부품이 올라오면 한 줄 import 치환으로 지운다.
//
//   ChoiceRow    라디오 행(오른쪽 ✓). #4457 이 `sheetParts.tsx` 에 올리는 **`ChoiceRow` 와 같은 props 이름**이다.
//                착륙하면 `import {ChoiceRow} from '../design/sheetParts'` 로 바꾸고 이 함수를 지운다.
//   SheetNotice  사실 한 문단(머리말 + 설명)을 카드로. 옛 `NoticeBlock` 은 가로 여백 16 을 스스로 들고 테두리 상자라
//                `SheetScroll` 의 거터와 겹쳐 32 가 된다.
//   FieldLabel   섹션 라벨 + 오른쪽의 한 마디(「조금 남았어요」). `GroupLabel` 은 문자열 하나뿐이다.
//   Field        한 줄 입력 알약 — `InputPill` 과 같은 모양인데 **ref 와 invalid 를 받는다**(검증이 실패한 칸으로 초점을
//                옮긴다: `InputPill` 은 ref 를 안 넘긴다).
//   TextArea     여러 줄 입력 상자 — 알약은 여러 줄에서 모서리가 글자를 먹으므로 입력 반경이다(`ds2Radius.row`).
//
// 모두 `Palette` 역할과 토큰만 읽는다. 입력의 외곽선은 `textFaint`(3:1, ADR-0189 D6)이고 실패하면 `dangerText` 다.
// =============================================================================

/**
 * 라디오 행: 서로 배타적인 값을 한 줄씩 고른다. 오른쪽 ✓ 는 고른 줄에만 서고 자리는 늘 지킨다(고른 줄이 바뀔 때 글자가
 * 옆으로 움찔하지 않는다). **고른 줄은 세 신호가 함께 바뀐다 — 강조색 글자 · 굵기 · ✓.** 보조기술에는 `radio` +
 * `selected` 로 읽힌다.
 */
export function ChoiceRow({
  title,
  detail,
  selected,
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
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  /** 고른 줄의 ✓ 에만 붙는다 — 고르지 않은 줄에는 ✓ 가 그려지지 않는다. */
  checkTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      // `false` 를 넘기지 않는다 — Pressable 은 그것도 접근성 상태에 섞는다.
      accessibilityState={disabled ? {selected, disabled: true} : {selected}}
      disabled={disabled ? true : undefined}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        detail ? styles.rowTop : null,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
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
          // 장식이다 — 행 자신이 접근성 요소(`radio`)라 안의 글리프는 따로 읽히지 않는다.
          <Image
            source={SHEET_ICONS.check}
            style={styles.check}
            importantForAccessibility="no"
            testID={checkTestID}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** 사실 한 문단(머리말 + 설명) 카드. 재시도·위험색이 없는 말이다(`NoticeBlock` 과 같은 뜻). */
export function SheetNotice({
  headline,
  detail,
  testID,
}: {
  headline: string;
  detail?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <GroupCard testID={testID}>
      <View style={styles.notice}>
        <Sentence style={styles.noticeHeadline}>{headline}</Sentence>
        {detail ? <Sentence style={styles.noticeDetail}>{detail}</Sentence> : null}
      </View>
    </GroupCard>
  );
}

/** 입력 칸 위의 라벨. `note`(「조금 남았어요」)는 같은 줄 오른쪽에 경고색으로 붙는다. */
export function FieldLabel({
  label,
  note,
}: {
  label: string;
  note?: string | null;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.labelRow}>
      <GroupLabel>{label}</GroupLabel>
      {note ? <Text style={styles.labelNote}>{note}</Text> : null}
    </View>
  );
}

type FieldProps = Omit<TextInputProps, 'keyboardAppearance'> & {
  /** 입력 칸의 이름 — 플레이스홀더만으로는 이름이 되지 않는다. */
  accessibilityLabel: string;
  /** 검증이 실패한 칸: 외곽선이 `dangerText` 가 된다. */
  invalid?: boolean;
};

/** 한 줄 입력 알약. `InputPill` 과 같은 모양 + ref + invalid. */
export const Field = forwardRef<TextInput, FieldProps & {icon?: ImageSourcePropType}>(
  function FieldView({icon, invalid = false, style, ...input}, ref) {
    const styles = useStyles(buildStyles);
    const palette = usePalette();
    const keyboardAppearance = useKeyboardAppearance();
    return (
      <View
        style={[styles.pill, invalid && styles.invalid]}
        testID={input.testID ? `${input.testID}-pill` : undefined}>
        {icon ? <Image source={icon} style={styles.pillIcon} accessibilityElementsHidden /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={palette.textMuted}
          {...input}
          style={[styles.pillInput, style]}
          keyboardAppearance={keyboardAppearance}
        />
      </View>
    );
  },
);

/** 여러 줄 입력 상자의 최소 높이 — 옛 시트들이 쓰던 값 그대로다(두세 줄이 보인다). */
const AREA_MIN_HEIGHT = 132;

/** 여러 줄 입력 상자. */
export const TextArea = forwardRef<TextInput, FieldProps & {minHeight?: number}>(
  function TextAreaView({invalid = false, minHeight = AREA_MIN_HEIGHT, style, ...input}, ref) {
    const styles = useStyles(buildStyles);
    const palette = usePalette();
    const keyboardAppearance = useKeyboardAppearance();
    return (
      <TextInput
        ref={ref}
        multiline
        // 방금 쓴 한국어 문장이 어절 가운데서 끊기지 않는다(컴포저와 같은 규칙, `conversationHygiene.test` 의 전수 스윕).
        lineBreakStrategyIOS="hangul-word"
        textAlignVertical="top"
        placeholderTextColor={palette.textMuted}
        {...input}
        style={[styles.area, {minHeight}, invalid && styles.invalid, style]}
        keyboardAppearance={keyboardAppearance}
      />
    );
  },
);

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      minHeight: SHEET.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    // 보조 줄이 붙은 행은 위로 붙인다 — ✓ 가 제목 첫 줄 옆에 선다(보조 줄 쪽으로 쏠리지 않게).
    rowTop: {alignItems: 'flex-start'},
    rowPressed: {backgroundColor: color.surfacePressed},
    rowDisabled: {opacity: 0.55},
    rowText: {flex: 1},
    rowTitle: {fontSize: font.body, lineHeight: line.body, color: color.text},
    rowTitleSelected: {color: color.accentText, fontWeight: '600'},
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
    notice: {
      gap: space.xs,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    noticeHeadline: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
      fontWeight: '600',
    },
    noticeDetail: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    labelRow: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
    labelNote: {fontSize: font.label, color: color.warn},
    pill: {
      minHeight: SHEET.pillMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: space.lg,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    pillIcon: {
      width: SHEET_ICON_SIZE.copy,
      height: SHEET_ICON_SIZE.copy,
      tintColor: color.icon,
    },
    pillInput: {
      flex: 1,
      paddingVertical: space.sm,
      fontSize: font.body,
      color: color.text,
    },
    area: {
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      fontSize: font.body,
      color: color.text,
    },
    invalid: {borderColor: color.dangerText},
  });
