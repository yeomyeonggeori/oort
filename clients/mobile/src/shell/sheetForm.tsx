import React, {forwardRef} from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ImageSourcePropType,
  type TextInputProps,
} from 'react-native';

import {Sentence} from '../design/atoms';
import {SHEET_ICON_SIZE} from '../design/icons';
import {GroupCard, GroupLabel} from '../design/sheetParts';
import {useKeyboardAppearance, usePalette, useStyles} from '../design/theme';
import {ds2Radius, font, line, radius, SHEET, space, type Palette} from '../design/tokens';

// =============================================================================
// 폼 시트의 **임시 부품** (#4458). 폼이 있는 큰 시트(새 채널·내 맥에 보내기·작업 맡기기)가 공용 시트 부품
// (`design/sheetParts.tsx`)에서 못 찾은 것들이다. `design/` 의 부품 파일은 이 이슈가 고치지 않는다 — 그래서 여기 두고,
// 정식 부품이 올라오면 한 줄 import 치환으로 지운다. (라디오 행 `ChoiceRow` 는 여기 있다가 #4457 이 `sheetParts.tsx`
// 에 올려서 그리로 갈아 끼우고 지웠다.)
//
//   SheetNotice  사실 한 문단(머리말 + 설명)을 카드로. 옛 `NoticeBlock` 은 가로 여백 16 을 스스로 들고 테두리 상자라
//                `SheetScroll` 의 거터와 겹쳐 32 가 된다.
//   FieldLabel   섹션 라벨 + 오른쪽의 한 마디(「조금 남았어요」). `GroupLabel` 은 문자열 하나뿐이다.
//   Field        한 줄 입력 알약 — `InputPill` 과 같은 모양인데 **ref 와 invalid 를 받는다**(검증이 실패한 칸으로 초점을
//                옮긴다: `InputPill` 은 ref 를 안 넘긴다). `editable={false}` 면 잠긴 행처럼 흐려진다(#5099).
//   TextArea     여러 줄 입력 상자 — 알약은 여러 줄에서 모서리가 글자를 먹으므로 입력 반경이다(`ds2Radius.row`).
//                잠김의 흐림은 `Field` 와 같다.
//
// 모두 `Palette` 역할과 토큰만 읽는다. 입력의 외곽선은 `textFaint`(3:1, ADR-0189 D6)이고 실패하면 `dangerText` 다.
// =============================================================================

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

/**
 * 잠긴 입력(`editable={false}`)인가. `editable` 은 생략하면 켜진 것이라 **`false` 를 줬을 때만** 잠긴 것이다(`!editable` 로
 * 읽으면 평소 칸이 전부 흐려진다).
 */
const isLocked = (editable: boolean | undefined): boolean => editable === false;

/**
 * 잠긴 입력은 눈에도 보조기술에도 잠긴 컨트롤로 선다 — 같은 화면의 잠긴 행(`ChoiceRow`·`ListRow` 의 `rowDisabled` 와 `disabled`
 * 상태)과 같은 문법이다(#5099, 검증 줄 2회차 화면 M2). 흐림만 없으면 눌러도 자판이 안 오르는 칸이 고칠 수 있는 칸처럼 보인다.
 */
const lockedState = (
  state: TextInputProps['accessibilityState'],
): NonNullable<TextInputProps['accessibilityState']> => ({...state, disabled: true});

/** 한 줄 입력 알약. `InputPill` 과 같은 모양 + ref + invalid + 잠김(`editable={false}`)의 흐림. */
export const Field = forwardRef<TextInput, FieldProps & {icon?: ImageSourcePropType}>(
  function FieldView({icon, invalid = false, style, ...input}, ref) {
    const styles = useStyles(buildStyles);
    const palette = usePalette();
    const keyboardAppearance = useKeyboardAppearance();
    const locked = isLocked(input.editable);
    return (
      <View
        style={[styles.pill, invalid && styles.invalid, locked && styles.locked]}
        testID={input.testID ? `${input.testID}-pill` : undefined}>
        {icon ? <Image source={icon} style={styles.pillIcon} accessibilityElementsHidden /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={palette.textMuted}
          {...input}
          accessibilityState={locked ? lockedState(input.accessibilityState) : input.accessibilityState}
          style={[styles.pillInput, style]}
          keyboardAppearance={keyboardAppearance}
        />
      </View>
    );
  },
);

/** 여러 줄 입력 상자의 최소 높이 — 옛 시트들이 쓰던 값 그대로다(두세 줄이 보인다). */
const AREA_MIN_HEIGHT = 132;

/** 여러 줄 입력 상자. `Field` 와 같은 잠김(`editable={false}`)의 흐림을 입는다. */
export const TextArea = forwardRef<TextInput, FieldProps & {minHeight?: number}>(
  function TextAreaView({invalid = false, minHeight = AREA_MIN_HEIGHT, style, ...input}, ref) {
    const styles = useStyles(buildStyles);
    const palette = usePalette();
    const keyboardAppearance = useKeyboardAppearance();
    const locked = isLocked(input.editable);
    return (
      <TextInput
        ref={ref}
        multiline
        // 방금 쓴 한국어 문장이 어절 가운데서 끊기지 않는다(컴포저와 같은 규칙, `conversationHygiene.test` 의 전수 스윕).
        lineBreakStrategyIOS="hangul-word"
        textAlignVertical="top"
        placeholderTextColor={palette.textMuted}
        {...input}
        accessibilityState={locked ? lockedState(input.accessibilityState) : input.accessibilityState}
        style={[styles.area, {minHeight}, invalid && styles.invalid, locked && styles.locked, style]}
        keyboardAppearance={keyboardAppearance}
      />
    );
  },
);

const buildStyles = (color: Palette) =>
  StyleSheet.create({
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
    // 잠긴 입력의 흐림 — `design/sheetParts.tsx` 의 `rowDisabled`(잠긴 `ChoiceRow`·`ListRow`)와 같은 값이다. 시험이 같은 화면의
    // 잠긴 행과 값이 같음을 잰다(한쪽만 바꾸면 한 화면이 잠김을 두 가지로 그린다).
    locked: {opacity: 0.55},
  });
