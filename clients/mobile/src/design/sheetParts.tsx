import React, {useEffect, useRef} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ROW_GLYPH_MAX_SCALE, Sentence, STACK_PILL_SCALE} from './atoms';
import {HOME_ICONS, HOME_ICON_SIZE, SHEET_ICON_SIZE, SHEET_ICONS} from './icons';
import {usePageSheetAction, usePageSheetKeyboard, usePageSheetScrollProps} from './PageSheet';
import {cardPosition, cardRing, dividerIndent, type CardInset} from './sheetModel';
import {useKeyboardAppearance, usePalette, useStyles, useTheme} from './theme';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  SHEET,
  space,
  TOUCH_TARGET,
  type Palette,
} from './tokens';

// =============================================================================
// 시트·페이지 안쪽 부품 (#4318, Buzz 「상태 설정」 시트·설정 페이지 비공개 캡처).
//
// 바탕(시트 `sheet`·페이지 `bg`) 위에 **카드·원이 `surface` 로 선다.** 입력 알약만 채움이 없이 외곽선
// (`textFaint` 3:1, ADR-0189 D6)으로 선다 — 바탕 위에 직접 놓는다(카드 안에 넣지 않는다). 부품은 색을 새로
// 짓지 않고 `Palette` 역할만 읽는다. 구조는 Buzz 의 `AppListCard`·`AppListRow`·`BuzzActionTile`·
// `BuzzSearchField` 를 RN 으로 다시 짠 것이다(코드는 가져오지 않았다).
//
//   GroupLabel     섹션 라벨 — 회색 작은 글씨, 카드 위
//   GroupCard      둥근 묶음 카드, 행 사이는 안쪽으로 들여 쓴 구분선
//   GroupCardItem  가상화 목록(FlatList)의 한 줄을 같은 카드로 보이게 하는 틀
//   ListRow        행: 앞 아이콘·이모지 · 이름 · 보조 줄 · 오른쪽 값 · 셰브론/펼침/복사/토글, 위험
//   ChoiceRow      라디오 행: 앞 표지 · 이름 · 보조 줄 · 오른쪽 ✓ — 고른 줄은 강조색·굵게·✓ 셋 (#4457 이 올렸다)
//   InputPill      입력 알약: 앞 아이콘 + 입력(ADR-0189 D6: 외곽선은 텍스트 입력에만 남는다)
//   ActionTile     큰 행동 타일(아이콘 위, 이름 아래) · ActionTileRow 는 같은 폭으로 나란히
//   SheetScroll    시트 몸의 스크롤 — 머리 아래 숨 쉴 틈·안전 영역·키보드 탭·큰 글씨에서도 끝까지 닿는다
//   ConfirmStep    시트 안의 확인 단계(되돌릴 수 없는 일 앞의 한 번 더): 카드 + 「취소」·위험 단추
//
// **가로 여백은 이 부품들이 주지 않는다.** `GroupCard`·`ListRow`·`InputPill`·`ActionTileRow` 는 폭 전체로 서고,
// 바깥 16(`SAFE_GUTTER`)은 호스트가 진다 — `SheetScroll` 이 주고, 날 `ScrollView`·`FlatList` 는 제 콘텐츠 스타일에서
// 준다(옛 `GroupSection` 은 스스로 졌다). 호스트가 안 주면 카드가 화면 가장자리까지 번진다.
// 낡은 `atoms.tsx` 의 `GroupSection`·`GroupRow`(반경 8·테두리 카드)는 설정 페이지(본 페이지와 안쪽 장 다섯)가 모두 새
// 가족으로 옮긴 뒤로 거기서는 쓰이지 않는다(#4457). 다른 화면은 #4458·#4319 가 옮기는 날 지운다. 여기가 새 가족이다.
// =============================================================================

/** 섹션 라벨. 카드 위의 회색 작은 글씨 — `textMuted`(AA). `textFaint` 는 글자 대비 4.5 를 못 지난다. */
export function GroupLabel({
  children,
  testID,
}: {
  children: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Text accessibilityRole="header" style={styles.label} testID={testID}>
      {children}
    </Text>
  );
}

function Divider({inset}: {inset: CardInset}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      style={[
        styles.divider,
        {marginLeft: dividerIndent(inset), marginRight: SHEET.cardInset},
      ]}
      testID="group-divider"
    />
  );
}

/**
 * 둥근 묶음 카드. 자식 사이에 안쪽으로 들여 쓴 구분선이 선다(자식이 `null` 이면 선도 없다).
 * `inset="icon"` 이면 선이 앞 아이콘 칸을 비켜 글자 열에서 시작하고, 숫자면 그 폭의 앞 요소(아바타)를 비킨다.
 */
export function GroupCard({
  label,
  inset = 'plain',
  children,
  style,
  testID,
}: {
  label?: string;
  inset?: CardInset;
  children: React.ReactNode;
  /** 바깥 상자의 스타일 — 호스트가 가로 여백을 주지 않는 자리에서 카드가 스스로 `SAFE_GUTTER` 를 질 때 쓴다. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const items = React.Children.toArray(children);
  return (
    <View style={[styles.group, style]} testID={testID}>
      {label ? <GroupLabel>{label}</GroupLabel> : null}
      <View style={styles.card} testID={testID ? `${testID}-card` : undefined}>
        {items.map((child, index) => (
          <React.Fragment key={index}>
            {index > 0 ? <Divider inset={inset} /> : null}
            {child}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

/**
 * 가상화 목록의 한 줄. `GroupCard` 는 자식을 한꺼번에 들지만 긴 목록은 줄마다 그려지므로, 첫 줄은
 * 위 모서리·끝 줄은 아래 모서리를 둥글게 하고 줄 사이에 같은 구분선을 둔다.
 */
export function GroupCardItem({
  index,
  count,
  inset = 'plain',
  children,
  testID,
}: {
  index: number;
  count: number;
  inset?: CardInset;
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const position = cardPosition(index, count);
  const top = position === 'only' || position === 'first';
  const bottom = position === 'only' || position === 'last';
  return (
    <View
      style={[
        styles.item,
        top && styles.itemTop,
        bottom && styles.itemBottom,
      ]}
      testID={testID}>
      {top ? null : <Divider inset={inset} />}
      {children}
    </View>
  );
}

/** 행 앞 아이콘 칸의 PNG 아이콘(글자 없는 아이콘 22). */
export function RowIcon({source}: {source: ImageSourcePropType}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <Image source={source} style={styles.rowIcon} accessibilityElementsHidden />;
}

/**
 * 행 앞 칸의 이모지 — **데이터**(고른 상태·반응)에만 쓴다. 기능을 말하는 앞 칸은 선 글리프(`RowIcon`)다.
 * 보조기술에는 이름이 이미 있으므로 읽히지 않는다. 칸이 22pt 로 고정이라 글자 배율을 따라가지 않는다
 * (`ROW_GLYPH_MAX_SCALE`) — 따라가면 AX5 에서 글리프가 칸에 잘린다.
 */
export function RowEmoji({emoji}: {emoji: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Text
      style={styles.rowEmoji}
      maxFontSizeMultiplier={ROW_GLYPH_MAX_SCALE}
      accessibilityElementsHidden
      importantForAccessibility="no">
      {emoji}
    </Text>
  );
}

export type RowAccessory = 'none' | 'chevron' | 'expand' | 'copy' | 'toggle';

/**
 * 행. 오른쪽 한 자리(`accessory`)가 그 행이 무엇인지 말한다 — 셰브론은 「더 들어간다」, 펼침은 「이
 * 자리에서 고른다」, 복사는 「값을 가져간다」, 토글은 「켜고 끈다」. 토글 행은 행 전체가 스위치이고
 * (`accessibilityRole="switch"`) 안쪽의 `Switch` 는 보조기술에서 숨는다 — 한 행에 요소가 하나다.
 */
export function ListRow({
  title,
  detail,
  value,
  leading,
  leadingWidth = SHEET.iconSlot,
  accessory = 'none',
  toggle,
  expanded,
  tone = 'default',
  onPress,
  closesSheet = false,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  trailing,
  testID,
}: {
  title: string;
  /** 이름 아래 보조 줄(회색). */
  detail?: string;
  /** 오른쪽 회색 값. */
  value?: string;
  /** 앞 아이콘·이모지·아바타. `RowIcon`·`RowEmoji` 를 쓴다. */
  leading?: React.ReactNode;
  /** 앞 칸의 폭. 기본은 아이콘 칸(22)이고 아바타는 자기 크기를 준다. 카드의 `inset` 과 같은 값이어야 선이 맞는다. */
  leadingWidth?: number;
  accessory?: RowAccessory;
  /** `accessory="toggle"` 일 때 필수. */
  toggle?: {value: boolean; onValueChange: (next: boolean) => void};
  /**
   * 제자리 펼침 행(`accessory="expand"`)이 보조기술에 말하는 상태이고, 펼치면 ⌄ 가 뒤집힌다(⌃). **주지 않으면 상태에
   * 넣지 않는다**(`false` 도 상태에 섞이는 `Pressable` 관용구 — 펼침이 아닌 행은 이 말을 하지 않는다).
   */
  expanded?: boolean;
  /** 파괴 행(나가기·지우기)은 글자가 위험색이다. */
  tone?: 'default' | 'danger';
  onPress?: () => void;
  /**
   * 누르면 시트를 **먼저 미끄러뜨려 내리고** 그 뒤에 `onPress` 를 한 번 부른다(`usePageSheetAction`).
   * 「행동을 고르면 시트가 사라지는」 목록 행(메시지 행동·길게 누르기)이 쓴다. 시트가 진행·실패를
   * 스스로 보이는 행에는 쓰지 않는다. 시트 밖(페이지)에서는 그냥 `onPress` 다. 토글 행에는 듣지 않는다.
   */
  closesSheet?: boolean;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /**
   * 눌리는 행이 보조기술에 말하는 역할. 기본은 `button`이고, 이 앱 밖(브라우저)으로 나가는 행은 `link` 다(옛 PR 이동 행이
   * 그랬다). 토글 행은 늘 `switch` 이고 이 값은 듣지 않는다. 눌리지 않는 행에는 역할이 없다.
   */
  accessibilityRole?: React.ComponentProps<typeof Pressable>['accessibilityRole'];
  /**
   * 오른쪽 임의 노드 — 값(`value`) 뒤·셰브론 앞에 서는 칩·배지 같은 **표식**(AI 시트의 「내 맥 켜짐」·「개인」). 글자만
   * 이면 `value` 를 쓴다. **보조기술 이름에 들어가지 않는다**(`value` 만 기본 이름에 들어간다): 표식의 글자를 읽혀야 하면
   * `accessibilityLabel` 에 넣는다. 표식은 색만으로 말하지 않는다 — 글자가 상태를 말한다.
   */
  trailing?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const afterClose = usePageSheetAction();
  const isToggle = accessory === 'toggle' && toggle !== undefined;
  // 큰 글씨(`STACK_PILL_SCALE` 부터)에서는 「제목 … 값」이 한 줄에 안 들어간다. 값이 오른쪽에서 50% 상한에 눌려 「지우…」로
  // 잘리거나 제목 상자만 키가 커진다(#4457 AX5 캡처). iOS 접근성 레이아웃처럼 값을 제목 **아래**로 내려 한 줄 전체를 쓴다.
  const {fontScale} = useWindowDimensions();
  const stackValue = Boolean(value) && fontScale >= STACK_PILL_SCALE;
  // 눌리는 행의 기본 이름: 제목만 읽으면 오른쪽 값(「회의 중」)과 보조 줄이 낭독에서 빠진다. 값 행투성이인 설정
  // 페이지가 이 부품을 쓴다. 이름을 직접 주면 그것이 이긴다.
  const spokenName = [title, detail, value].filter(Boolean).join(', ');
  const press = isToggle
    ? () => toggle.onValueChange(!toggle.value)
    : onPress && closesSheet
      ? () => afterClose(onPress)
      : onPress;
  const body = (
    <>
      {leading ? (
        <View
          style={[styles.rowLead, {width: leadingWidth}]}
          testID={testID ? `${testID}-lead` : undefined}>
          {leading}
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text
          lineBreakStrategyIOS="hangul-word"
          style={[styles.rowTitle, tone === 'danger' && styles.rowTitleDanger]}>
          {title}
        </Text>
        {stackValue ? (
          <Text
            lineBreakStrategyIOS="hangul-word"
            style={styles.rowValueStacked}
            testID={testID ? `${testID}-value` : undefined}>
            {value}
          </Text>
        ) : null}
        {detail ? (
          // 문장이다 — 어절 가운데서 끊기지 않는다(옛 `GroupRow.detail` 도 `Sentence` 였다).
          <Sentence style={styles.rowDetail} testID={testID ? `${testID}-detail` : undefined}>
            {detail}
          </Sentence>
        ) : null}
      </View>
      {value && !stackValue ? (
        <Text
          style={styles.rowValue}
          // 두 줄까지 — 한 줄이면 「지금대로 · 10월 27일 16:11까지」 같은 긴 값이 50% 상한에서 말줄임으로 잘린다(r1 M5). 그보다
          // 길면(80자 상태 글) 말줄임이고, 그 글은 호스트가 따로 전문을 보인다. **줄바꿈은 어절 단위다**(`hangul-word`) — 제목과
          // 쌓인 값(아래)이 이미 그러하고, 두 줄을 허용한 값이 그 규칙 없이 「온보/딩」 으로 어절 가운데서 끊겼다(r2 H1).
          lineBreakStrategyIOS="hangul-word"
          numberOfLines={2}
          testID={testID ? `${testID}-value` : undefined}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {accessory === 'chevron' ? (
        <Image source={SHEET_ICONS.chevron} style={styles.chevron} accessibilityElementsHidden />
      ) : null}
      {accessory === 'expand' ? (
        <Image
          source={HOME_ICONS.down}
          style={[styles.expand, expanded === true && styles.expandFlipped]}
          accessibilityElementsHidden
          testID={testID ? `${testID}-expand` : undefined}
        />
      ) : null}
      {accessory === 'copy' ? (
        <Image source={SHEET_ICONS.copy} style={styles.copy} accessibilityElementsHidden />
      ) : null}
      {isToggle ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Switch
            value={toggle.value}
            onValueChange={toggle.onValueChange}
            disabled={disabled}
            // 꺼짐 트랙은 컨트롤 경계라 비텍스트 3:1(`textFaint`) — `border` 는 카드 위에서 1.3~2.1:1 이었다.
            trackColor={{false: palette.textFaint, true: palette.ok}}
            ios_backgroundColor={palette.textFaint}
          />
        </View>
      ) : null}
    </>
  );
  if (!press) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel} style={styles.row} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={isToggle ? 'switch' : accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel ?? spokenName}
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled,
        busy,
        ...(isToggle ? {checked: toggle.value} : null),
        ...(expanded !== undefined ? {expanded} : null),
      }}
      disabled={disabled}
      onPress={press}
      style={({pressed}) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
      {body}
    </Pressable>
  );
}

/**
 * 라디오 행: 서로 배타적인 **설정값**(테마·화면 모드·내 상태…)을 한 줄씩 고른다. 오른쪽 ✓ 는 고른 줄에만 서고 자리는
 * 늘 지킨다(고른 줄이 바뀔 때 글자가 옆으로 움찔하지 않는다).
 *
 * **고른 줄은 세 신호가 함께 바뀐다 — 강조색 글자 · 굵기 · ✓.** ✓ 하나만 바꾸면 그것을 손가락이 덮는 동안 신호가 없다
 * (`ThemeControl` 머리말, #2702). 앱의 라디오가 모두 이 규칙이었고(옛 `GroupRow tone="accent"`) 그래서 한 부품이 쥔다.
 * 보조기술에는 `radio` + `selected` 로 읽힌다(「3개 중」은 부모의 `radiogroup`).
 *
 * `leading` 은 **고르는 값의 모습을 미리 보이는 표지**다(테마 견본·강조색 점·사진 썸네일 — 읽히지 않는다). 아이콘 같은 장식
 * 앞 칸이 아니다: 앞 칸의 폭은 표지 종류가 정하고(견본 44·점 20·썸네일 36), 표지가 있는 카드가 한 표면에 둘 이상이면 같은 폭을
 * 써서 한 열이 된다(테마 견본 44 에 강조색 점을 맞춘다 — `phone-sheets.md` §4 예외). 표지가 값에 따라 있을 때만 서는 줄(고른 사진의
 * 썸네일)은 그 열 규칙에 못 든다. 기본은 제목 첫 줄 높이의 22pt 칸이고(설명 줄이 붙으면
 * 행이 위로 붙어 점·✓ 가 제목 첫 줄 옆에 선다), 칸이 더 크면 `leadingWidth` 와 `leadingAlign="center"` 로 가운데에 세운다 —
 * 이때 카드의 `inset` 은 같은 폭이어야 구분선이 글자 열에서 시작한다. **표지가 없는 값(상태 이름처럼 색이 이미 다른 곳에서
 * 말해지는 것)에는 주지 않는다**(`phone-sheets.md` §4 의 앞 칸 규칙).
 */
export function ChoiceRow({
  title,
  detail,
  selected,
  leading,
  leadingWidth = SHEET.iconSlot,
  leadingAlign = 'first-line',
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
  /** 앞 표지(장식). 낭독에서 빠진다. */
  leading?: React.ReactNode;
  /** 앞 칸의 폭. 카드의 `inset`(숫자)과 같아야 구분선이 맞는다. */
  leadingWidth?: number;
  /** `first-line`: 제목 첫 줄 높이 칸(작은 점) · `center`: 행 가운데(견본·썸네일처럼 줄보다 큰 것). */
  leadingAlign?: 'first-line' | 'center';
  onPress: () => void;
  /** 쓰는 중(다른 선택이 날아가는 동안). 눌리지 않고 흐려진다. */
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  /** 고른 줄의 ✓ 에만 붙는다 — 고르지 않은 줄에는 ✓ 가 그려지지 않는다. */
  checkTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const firstLine = leadingAlign === 'first-line';
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      // `false` 를 넘기지 않는다 — Pressable 은 그것도 접근성 상태에 섞는다(옛 `GroupRow` 와 같은 관용구).
      accessibilityState={disabled ? {selected, disabled: true} : {selected}}
      disabled={disabled ? true : undefined}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        // 설명 줄이 붙은 행은 위로 붙인다 — 점과 ✓ 가 제목 첫 줄 옆에 선다(설명 줄 쪽으로 쏠리지 않게).
        detail && firstLine ? styles.rowTop : null,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
      {leading ? (
        <View
          style={[
            styles.choiceLead,
            {width: leadingWidth},
            firstLine && styles.choiceLeadFirstLine,
          ]}
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
      <View style={styles.choiceCheckSlot}>
        {selected ? (
          // 장식이다 — 행 자신이 접근성 요소(`radio`)라 안의 글리프는 따로 읽히지 않는다. `accessibilityElementsHidden` 은
          // 주지 않는다: 시험이 `getByTestId` 로 「고른 줄에만 ✓ 가 선다」를 잴 수 있어야 한다.
          <Image
            source={SHEET_ICONS.check}
            style={styles.choiceCheck}
            importantForAccessibility="no"
            testID={checkTestID}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * 입력 알약: 앞 아이콘 + 한 줄 입력. 외곽선은 `textFaint`(3:1) — ADR-0189 D6 이 값을 받는 그릇에만
 * 남긴 선이다. Buzz 의 가는 선이 아니라 우리 규칙을 따른다.
 */
export function InputPill({
  icon,
  accessibilityLabel,
  style,
  ...input
}: Omit<TextInputProps, 'keyboardAppearance'> & {
  /** 앞 아이콘(PNG, 글자 없는 아이콘 색으로 칠한다). */
  icon?: ImageSourcePropType;
  /** 입력 칸의 이름 — 플레이스홀더만으로는 이름이 되지 않는다. */
  accessibilityLabel: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const keyboardAppearance = useKeyboardAppearance();
  return (
    <View style={styles.pill} testID={input.testID ? `${input.testID}-pill` : undefined}>
      {icon ? <Image source={icon} style={styles.pillIcon} accessibilityElementsHidden /> : null}
      <TextInput
        accessibilityLabel={accessibilityLabel}
        placeholderTextColor={palette.textMuted}
        {...input}
        // 호출자의 `style` 은 알약 입력 스타일(`flex: 1` 포함)을 **덮지 않고 이어 붙는다**.
        style={[styles.pillInput, style]}
        // 키보드 모양은 앱의 스킴이 정한다(#4526). 펼친 props 뒤에 두고 타입에서도 뺐다 — 호출자가 바꿀 수 없다.
        keyboardAppearance={keyboardAppearance}
      />
    </View>
  );
}

/** 큰 행동 타일 안의 PNG 글리프. */
export function TileIcon({source}: {source: ImageSourcePropType}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <Image source={source} style={styles.tileIcon} accessibilityElementsHidden />;
}

/** 큰 행동 타일(Buzz 「Message」·「Copy」). 위 아이콘, 아래 이름. `ActionTileRow` 안에서 같은 폭이 된다. */
export function ActionTile({
  icon,
  label,
  onPress,
  closesSheet = false,
  disabled = false,
  busy = false,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  /** 누르면 시트를 먼저 내리고 `onPress` 를 한 번 부른다(`ListRow` 의 같은 이름). 프로필 시트의 「메시지」처럼 다른 화면으로 가는 타일. */
  closesSheet?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const afterClose = usePageSheetAction();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled, busy}}
      disabled={disabled || busy}
      onPress={closesSheet ? () => afterClose(onPress) : onPress}
      style={({pressed}) => [
        styles.tile,
        pressed && styles.tilePressed,
        disabled && styles.rowDisabled,
      ]}
      testID={testID}>
      {busy ? <ActivityIndicator color={palette.text} /> : icon}
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ActionTileRow({children}: {children: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <View style={styles.tileRow}>{children}</View>;
}

/**
 * 시트 안의 **확인 단계** — 되돌릴 수 없는 일(지우기·나가기) 앞의 한 번 더 (#4318).
 *
 * 카드(머리말 + 설명 + 실패 한 줄) 아래에 「취소」와 위험 단추가 한 줄로 선다. 두 시트(메시지 행동·대화 행 행동)에
 * 같은 블록이 복사돼 있던 것을 부품으로 모았다 — 확인 단계는 #4458 이 더 만난다. 규칙:
 *   - **실패는 확인 단계 안에서 말한다**(`error`, 시트를 닫지 않는다). 토스트가 아니다. 새로 서면 보조기술이 읽어
 *     준다(iOS 는 `alert` 역할만으로는 나타날 때 낭독하지 않는다).
 *   - 왕복 중에는 위험 단추가 잠기고 낱말(`pendingLabel`)과 `accessibilityState.busy` 가 진행을 말한다.
 *   - 머리말·설명·실패는 모두 문장이라 어절 가운데서 끊기지 않는다(`Sentence`). 단 `hangul-word` 는 **닫는 괄호 뒤의
 *     조사**를 못 붙잡는다(「…」가 → 줄 머리의 「가」) — 문구에 「괄호 + 조사」 조합을 쓰지 않는다(시험이 렌더된 문장을 훑는다).
 */
export function ConfirmStep({
  headline,
  detail,
  error,
  confirmLabel,
  pendingLabel,
  pending = false,
  confirmDisabled = false,
  cancelLabel = '취소',
  onCancel,
  onConfirm,
  testID,
  errorTestID,
  cancelTestID,
  confirmTestID,
}: {
  headline: string;
  detail: string;
  /** 지난 시도의 실패 문장(코어가 옮긴 한국어). 없으면 줄이 없다. */
  error?: string | null;
  /** 위험 단추의 낱말(「지우기」·「채널 나가기」). */
  confirmLabel: string;
  /** 왕복 중의 낱말(「지우는 중…」). */
  pendingLabel: string;
  pending?: boolean;
  /**
   * 위험 단추를 잠근다(끊긴 동안처럼 지금은 눌러도 소용없을 때). `pending` 과 달리 낱말은 그대로이고 단추가 흐려지며
   * `accessibilityState.disabled` 가 선다. 왜 잠겼는지는 `error` 가 말한다(눌러도 반응 없는 단추를 살아 있는 듯
   * 두지 않는다).
   */
  confirmDisabled?: boolean;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** 카드의 testID — 설명은 `<testID>-detail` 이다. */
  testID?: string;
  errorTestID?: string;
  cancelTestID?: string;
  confirmTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 실패 문장이 새로 서면 읽어 준다. iOS 에는 live region 이 없어 `accessibilityRole="alert"` 만으로는 나타날 때
  // 낭독되지 않는다(`DeviceKeyPanel` 이 같은 이유로 같은 호출을 한다). 같은 문장이 남아 있는 동안은 다시 읽지 않는다.
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);
  return (
    <>
      <GroupCard testID={testID}>
        <View style={styles.confirmBody}>
          <Sentence style={styles.confirmHeadline} testID={testID ? `${testID}-headline` : undefined}>
            {headline}
          </Sentence>
          <Sentence
            style={styles.confirmDetail}
            testID={testID ? `${testID}-detail` : undefined}>
            {detail}
          </Sentence>
          {error ? (
            <Sentence accessibilityRole="alert" style={styles.confirmError} testID={errorTestID}>
              {error}
            </Sentence>
          ) : null}
        </View>
      </GroupCard>
      <View style={styles.confirmRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          onPress={onCancel}
          style={({pressed}) => [styles.secondary, pressed && styles.confirmPressed]}
          testID={cancelTestID}>
          <Sentence style={styles.secondaryLabel}>{cancelLabel}</Sentence>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          accessibilityState={{busy: pending, disabled: pending || confirmDisabled}}
          disabled={pending || confirmDisabled}
          onPress={onConfirm}
          style={({pressed}) => [
            styles.destructive,
            pressed && styles.confirmPressed,
            confirmDisabled && !pending && styles.rowDisabled,
          ]}
          testID={confirmTestID}>
          <Sentence style={styles.destructiveLabel}>{pending ? pendingLabel : confirmLabel}</Sentence>
        </Pressable>
      </View>
    </>
  );
}

/**
 * 시트 몸의 스크롤. 안전 영역(홈 인디케이터) 아래까지 여백을 주고, 입력에서 탭이 키보드를 접지 않으며,
 * 큰 글씨에서 내용이 시트 높이를 넘어도 스크롤로 끝까지 닿는다 — 머리의 X 는 스크롤 밖이라 언제나 보인다.
 *
 * - 키보드가 올라와 시트 바닥이 키보드 윗면에 앉으면 홈 인디케이터는 이미 키보드 뒤라서 안전 영역 여백을 걷는다
 *   (또 주면 입력과 키 사이에 죽은 띠가 생긴다 — `useKeyboard` 머리말). 남는 것은 끝 카드 아래 숨 쉴 틈 16 뿐이다:
 *   「안전 영역 또는 16 중 큰 값 + 16」(32)을 그대로 두면 내용이 다 보이는 중간 단 시트가 키보드 위 칸에 안 들어가
 *   9pt 헛스크롤했다(design-review #4318 r4 L1).
 * - **내용이 시트를 넘치면** 처음 선 직후 스크롤 막대를 한 번 보인다(`flashScrollIndicators`). 접힌 행(SE 기본 크기의
 *   메시지 시트의 「지우기」)이 있다는 단서가 접힘선이 카드 모서리에 우연히 걸리는 데만 달려 있지 않게 한다(r4 M1).
 *   시트마다 한 번이고, 넘치지 않으면 부르지 않는다. 문턱(`레이아웃 > 0 && 내용 > 레이아웃 + 1`)은 사진 카드
 *   (`photoCardDesign.scrollNeedsHint`)와 같다.
 * - **막대의 색은 앱의 모양을 따른다.** UIKit 은 막대 색을 **시스템** 모양으로 정해서, 앱에서 다크를 고르고 시스템이
 *   라이트면 어두운 시트에 검은 막대가 서 단서가 안 보인다(대비 1.07 — design-review r6 M1, 사진 카드가 먼저 푼 문제).
 */
export function SheetScroll({
  children,
  testID,
  onLayout,
  onContentSizeChange,
  onScroll,
  onScrollEndDrag,
  onMomentumScrollEnd,
  scrollEnabled = true,
  contentContainerStyle,
  ...scroll
}: ScrollViewProps & {children: React.ReactNode; testID?: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {scheme} = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = usePageSheetKeyboard();
  const bottom =
    (keyboardHeight > 0 ? 0 : Math.max(insets.bottom, space.lg)) + space.lg;
  const ref = useRef<ScrollView>(null);
  const measured = useRef({viewport: 0, content: 0, flashed: false});
  const flashWhenCut = () => {
    const sizes = measured.current;
    if (sizes.flashed || sizes.viewport <= 0 || sizes.content <= sizes.viewport + 1) return;
    sizes.flashed = true;
    ref.current?.flashScrollIndicators?.();
  };
  const handleLayout = (event: LayoutChangeEvent) => {
    measured.current.viewport = event.nativeEvent.layout.height;
    flashWhenCut();
    onLayout?.(event);
  };
  const handleContentSize = (width: number, height: number) => {
    measured.current.content = height;
    flashWhenCut();
    onContentSizeChange?.(width, height);
  };
  // 시트에 자기를 알린다(#4612): 맨 위일 때만 시트가 본문 끌기를 가져가고, 시트가 끌기를 쥐는 동안은 스크롤을 얼린다. 크기(레이아웃·내용
  // 크기)도 함께 알린다 — 내용이 뷰포트를 넘치면 본문은 시작 응답자를 잡지 않는다(스크롤을 죽이지 않으려고, `claimsSheetTouchStart`).
  const sheetScroll = usePageSheetScrollProps({
    onScroll,
    onScrollEndDrag,
    onMomentumScrollEnd,
    onLayout: handleLayout,
    onContentSizeChange: handleContentSize,
    scrollEnabled,
  });
  return (
    <ScrollView
      ref={ref}
      showsVerticalScrollIndicator
      indicatorStyle={scheme === 'light' ? 'black' : 'white'}
      keyboardShouldPersistTaps="handled"
      testID={testID}
      {...sheetScroll}
      {...scroll}
      // 호출자의 몸 스타일은 기본(가로 여백·위 여백·gap)과 키보드를 아는 바닥 여백 **위에 얹는다** — 덮어쓰지 않는다. 카드가 스스로
      // 가로 여백을 지는 몸(지시 기기 패널)은 `paddingHorizontal: 0` 만 얹어 위·바닥 여백과 키보드 처리는 그대로 받는다.
      contentContainerStyle={[styles.scrollContent, {paddingBottom: bottom}, contentContainerStyle]}>
      {children}
    </ScrollView>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    label: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.textMuted,
      paddingHorizontal: space.xs,
    },
    group: {gap: space.sm},
    card: {
      borderRadius: ds2Radius.card,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cardRing(color),
      overflow: 'hidden',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      // 글자색에 12% 를 얹는다 — 스킴의 `border` 는 카드 채움과 몇 단 차이라 카드 위에서 안 보인다.
      backgroundColor: `${color.text}${SHEET.dividerAlpha}`,
    },
    item: {
      backgroundColor: color.surface,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: cardRing(color),
      overflow: 'hidden',
    },
    itemTop: {
      borderTopLeftRadius: ds2Radius.card,
      borderTopRightRadius: ds2Radius.card,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    itemBottom: {
      borderBottomLeftRadius: ds2Radius.card,
      borderBottomRightRadius: ds2Radius.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
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
    // 아이콘 칸 22 + 오른쪽 8 + 행의 gap 8 = 글자까지 16(`SHEET.iconGap`).
    rowLead: {
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: space.sm,
    },
    rowIcon: {
      width: SHEET_ICON_SIZE.copy,
      height: SHEET_ICON_SIZE.copy,
      tintColor: color.textMuted,
    },
    rowEmoji: {fontSize: font.heading, lineHeight: line.heading, textAlign: 'center'},
    rowText: {flex: 1},
    rowTitle: {fontSize: font.body, lineHeight: line.body, color: color.text},
    rowTitleDanger: {color: color.danger, fontWeight: '600'},
    // 라디오 행(`ChoiceRow`): 고른 줄은 강조색 + 굵게(✓ 와 함께 세 신호).
    rowTitleSelected: {color: color.accentText, fontWeight: '600'},
    rowTop: {alignItems: 'flex-start'},
    choiceLead: {
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: space.sm,
    },
    // 앞 칸은 제목 한 줄 높이라(`rowTop` 과 함께) 점이 설명 줄이 붙은 행에서도 제목 첫 줄 옆에 선다.
    choiceLeadFirstLine: {height: line.body},
    choiceCheckSlot: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      alignItems: 'center',
      justifyContent: 'center',
    },
    choiceCheck: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      tintColor: color.accentText,
    },
    rowDetail: {
      marginTop: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    rowValue: {
      flexShrink: 1,
      maxWidth: '50%',
      textAlign: 'right',
      fontSize: font.body,
      color: color.textMuted,
    },
    // 큰 글씨에서 제목 아래로 내려온 값 — 오른쪽 상한도 말줄임도 없이 한 줄 전체를 쓴다.
    rowValueStacked: {
      marginTop: space.xs,
      fontSize: font.body,
      color: color.textMuted,
    },
    chevron: {
      width: SHEET_ICON_SIZE.chevron,
      height: SHEET_ICON_SIZE.chevron,
      tintColor: color.icon,
    },
    expand: {
      width: HOME_ICON_SIZE.down,
      height: HOME_ICON_SIZE.down,
      tintColor: color.icon,
    },
    // 펼친 행의 ⌄ 는 뒤집힌다(⌃) — 눌렀을 때 무슨 일이 일어났는지 눈에도 말한다.
    expandFlipped: {transform: [{rotate: '180deg'}]},
    copy: {
      width: SHEET_ICON_SIZE.copy,
      height: SHEET_ICON_SIZE.copy,
      tintColor: color.icon,
    },
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
    tileRow: {flexDirection: 'row', gap: space.sm},
    tile: {
      flex: 1,
      minHeight: SHEET.tileMinHeight,
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      borderRadius: ds2Radius.card,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cardRing(color),
    },
    tilePressed: {backgroundColor: color.surfacePressed},
    tileIcon: {
      width: SHEET_ICON_SIZE.copy,
      height: SHEET_ICON_SIZE.copy,
      tintColor: color.text,
    },
    tileLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    confirmBody: {
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    confirmHeadline: {fontSize: font.body, color: color.text, fontWeight: '700'},
    confirmDetail: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    confirmError: {fontSize: font.label, color: color.danger, lineHeight: line.label},
    confirmRow: {flexDirection: 'row', gap: space.sm},
    secondary: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      // r6-M2: 라벨이 테두리에 붙지 않게 가로 여백을 준다(큰 글씨에서 두 줄이 될 때).
      paddingHorizontal: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    // r6-M2: `Sentence`(hangul-word)라 AX5 에서 「채널 나 / 가기」가 아니라 「채널 / 나가기」로 어절 단위로 접는다.
    secondaryLabel: {fontSize: font.label, color: color.text, fontWeight: '600', textAlign: 'center'},
    destructive: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.dangerBorder,
      backgroundColor: color.dangerSurface,
    },
    destructiveLabel: {fontSize: font.label, color: color.danger, fontWeight: '700', textAlign: 'center'},
    confirmPressed: {opacity: 0.6},
    scrollContent: {
      paddingHorizontal: SAFE_GUTTER,
      // 머리 줄 아래 숨 쉴 틈 — 원 아래 끝에서 첫 내용까지 6 + 12 = 18(`SHEET.bodyTop`).
      paddingTop: SHEET.bodyTop,
      gap: space.lg,
    },
  });
