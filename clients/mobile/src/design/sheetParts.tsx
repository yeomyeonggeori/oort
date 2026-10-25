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
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ROW_GLYPH_MAX_SCALE, Sentence} from './atoms';
import {HOME_ICONS, HOME_ICON_SIZE, SHEET_ICON_SIZE, SHEET_ICONS} from './icons';
import {usePageSheetAction, usePageSheetKeyboard} from './PageSheet';
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
//   InputPill      입력 알약: 앞 아이콘 + 입력(ADR-0189 D6: 외곽선은 텍스트 입력에만 남는다)
//   ActionTile     큰 행동 타일(아이콘 위, 이름 아래) · ActionTileRow 는 같은 폭으로 나란히
//   SheetScroll    시트 몸의 스크롤 — 머리 아래 숨 쉴 틈·안전 영역·키보드 탭·큰 글씨에서도 끝까지 닿는다
//   ConfirmStep    시트 안의 확인 단계(되돌릴 수 없는 일 앞의 한 번 더): 카드 + 「취소」·위험 단추
//
// **가로 여백은 이 부품들이 주지 않는다.** `GroupCard`·`ListRow`·`InputPill`·`ActionTileRow` 는 폭 전체로 서고,
// 바깥 16(`SAFE_GUTTER`)은 호스트가 진다 — `SheetScroll` 이 주고, 날 `ScrollView`·`FlatList` 는 제 콘텐츠 스타일에서
// 준다(옛 `GroupSection` 은 스스로 졌다). 호스트가 안 주면 카드가 화면 가장자리까지 번진다.
// 낡은 `atoms.tsx` 의 `GroupSection`·`GroupRow`(반경 8·테두리 카드)는 프로필 시트가 아직 쓴다(지시 기기 판은
// 새 `GroupCard` 로 옮겼다). 여기가 새 가족이고, 옮기는 것은 #4457·#4458·#4319 의 일이다.
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
  tone = 'default',
  onPress,
  closesSheet = false,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
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
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const afterClose = usePageSheetAction();
  const isToggle = accessory === 'toggle' && toggle !== undefined;
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
        {detail ? (
          // 문장이다 — 어절 가운데서 끊기지 않는다(옛 `GroupRow.detail` 도 `Sentence` 였다).
          <Sentence style={styles.rowDetail} testID={testID ? `${testID}-detail` : undefined}>
            {detail}
          </Sentence>
        ) : null}
      </View>
      {value ? (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory === 'chevron' ? (
        <Image source={SHEET_ICONS.chevron} style={styles.chevron} accessibilityElementsHidden />
      ) : null}
      {accessory === 'expand' ? (
        <Image source={HOME_ICONS.down} style={styles.expand} accessibilityElementsHidden />
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
      accessibilityRole={isToggle ? 'switch' : 'button'}
      accessibilityLabel={accessibilityLabel ?? spokenName}
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled,
        busy,
        ...(isToggle ? {checked: toggle.value} : null),
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
 * 입력 알약: 앞 아이콘 + 한 줄 입력. 외곽선은 `textFaint`(3:1) — ADR-0189 D6 이 값을 받는 그릇에만
 * 남긴 선이다. Buzz 의 가는 선이 아니라 우리 규칙을 따른다.
 */
export function InputPill({
  icon,
  accessibilityLabel,
  style,
  ...input
}: TextInputProps & {
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
        keyboardAppearance={keyboardAppearance}
        {...input}
        // 호출자의 `style` 은 알약 입력 스타일(`flex: 1` 포함)을 **덮지 않고 이어 붙는다**.
        style={[styles.pillInput, style]}
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
          <Text style={styles.secondaryLabel}>{cancelLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          accessibilityState={{busy: pending, disabled: pending}}
          disabled={pending}
          onPress={onConfirm}
          style={({pressed}) => [styles.destructive, pressed && styles.confirmPressed]}
          testID={confirmTestID}>
          <Text style={styles.destructiveLabel}>{pending ? pendingLabel : confirmLabel}</Text>
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
  return (
    <ScrollView
      ref={ref}
      bounces={false}
      showsVerticalScrollIndicator
      indicatorStyle={scheme === 'light' ? 'black' : 'white'}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.scrollContent, {paddingBottom: bottom}]}
      testID={testID}
      {...scroll}
      onLayout={handleLayout}
      onContentSizeChange={handleContentSize}>
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
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    secondaryLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
    destructive: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.dangerBorder,
      backgroundColor: color.dangerSurface,
    },
    destructiveLabel: {fontSize: font.label, color: color.danger, fontWeight: '700'},
    confirmPressed: {opacity: 0.6},
    scrollContent: {
      paddingHorizontal: SAFE_GUTTER,
      // 머리 줄 아래 숨 쉴 틈 — 원 아래 끝에서 첫 내용까지 6 + 12 = 18(`SHEET.bodyTop`).
      paddingTop: SHEET.bodyTop,
      gap: space.lg,
    },
  });
