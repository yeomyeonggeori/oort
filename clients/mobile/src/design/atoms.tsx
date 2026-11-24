import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  BUTTON,
  DISABLED_OPACITY,
  font,
  line,
  PRESSED_OPACITY,
  radius,
  SAFE_GUTTER,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from './tokens';
import {circleLook} from './sheetModel';
import {HOME_ICON_SIZE, HOME_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from './icons';
import {usePalette, useStyles} from './theme';
import {PULL_FILL} from './pullRefresh';
import {withLineHeadroom} from './lineHeadroom';
import type {PullScrollProps} from './refresh';

// =============================================================================
// The shell's shared pieces.
//
// The list below is short on purpose — it is the set of things that appear on
// more than one of this batch's four screens, and nothing else. What it exists
// to prevent is three screens each growing their own "nothing here yet" block,
// which is how an app ends up telling a person three different stories about the
// same situation.
//
// ## The four states are a type, not a convention
//
// `AsyncState` is not decoration. Every list surface in this batch renders
// through it, so "loading" and "empty" and "failed" cannot be quietly skipped by
// a screen that only ever got tested with data in it. The distinction it insists
// on hardest is the last one:
//
//   `ErrorState`   something went wrong. There is a retry, because retrying is
//                  the thing that might work.
//   `NoticeBlock`  this server does not carry that feature yet
//                  (`@momo/core/features/capabilities/serverSurfaces`). There is
//                  NO retry, because there is nothing to retry — and it is not
//                  coloured as a failure, because it is not one.
//
// Collapsing those two is the specific lie goal B12 was opened to remove on web
// ("없는 기능을 장애라고 말하는 것은 있는 기능을 없다고 말하는 것과 같은 크기의
// 거짓말"). The RN shell inherits the fix rather than re-earning it.
// =============================================================================

/**
 * 머리 줄(바)에 서는 **컨트롤** 글자의 Dynamic Type 배율 상한 (#2702).
 *
 * 머리 줄은 한 줄이고 폭이 고정이다. AX5 에서 「메시지 검색」과 아바타가 제
 * 크기대로 자라면 제목 「대화」가 「대·」로 잘렸고, 시트의 「닫기」가 「닫·」가
 * 됐다(Release 캡처). iOS 의 바 단추도 같은 이유로 무한히 자라지 않는다. 본문과
 * 목록은 이 상한 밖이다 — 읽는 글자는 끝까지 자란다.
 */
export const BAR_CONTROL_MAX_SCALE = 1.6;

// -----------------------------------------------------------------------------
// Dynamic Type 상한 — 이 파일이 `maxFontSizeMultiplier` 의 유일한 출처다 (#3774).
//
// 정책: 크롬(탭바·헤더·버튼·한 줄 고정폭 라벨)만 상한을 갖는다. 메시지 본문·목록·
// 입력 텍스트(`TextInput`)에는 상한을 붙이지 않는다 — 읽는 글자는 끝까지 자란다.
// 아래 값은 전부 「한 줄·고정 폭에 서는 표식」용이고, 화면에 새 상한이 필요하면 여기에
// 이름과 이유를 적는다(`designSystem.test.ts` 가 다른 파일의 상수 정의를 막는다).
// -----------------------------------------------------------------------------

/** AI 계정 카드 머리·「나에게만」 줄. 입력창 위에 자판과 서므로 바 컨트롤(1.6)보다 낮다(R5-H1). */
export const HEAD_MAX_SCALE = 1.3;
/** 접힌 줄 — 제 줄에 혼자 서므로 바 컨트롤과 같은 값(#2988, R6 M1). */
export const FOLDED_MAX_SCALE = BAR_CONTROL_MAX_SCALE;
/** 이 배수부터 AI 카드의 알약, 홈 「작업 중」 카드의 상태 낱말, 대화 아래 활동 줄의 「이름: 낱말」이 줄을 바꾼다(상한이 아니라 줄바꿈 문턱). */
export const STACK_PILL_SCALE = 1.5;
/**
 * 단추 네 종류의 낱말(`ButtonFace`, #6075). 단추는 크롬이라 바 컨트롤과 같은 끝에서 멈춘다 — 그 너머에서는 알약 하나가 폭을 넘겨
 * 낱말이 세 줄로 접혔다. 단추 곁의 설명 문장은 상한이 없다.
 */
export const BUTTON_MAX_SCALE = BAR_CONTROL_MAX_SCALE;
/** SAS 숫자는 이미 크다(40). 큰 글씨에서 네 칸이 375 폭을 넘지 않게 멈춘다. */
export const SAS_MAX_SCALE = 1.35;
/** 아바타 이니셜 — 32 상자에 13pt 한 글자가 여백을 지키는 끝. */
export const AVATAR_INITIAL_MAX_SCALE = 1.3;
/**
 * 빠른 반응 이모지(`MessageActionSheet`) — 여섯 개가 한 줄에 서는 끝(#4318). 이모지는 읽는 글자가 아니라 표식이다.
 * 이 위로 자라면 SE 폭(카드 안쪽 327)에서 5·6번째가 카드 밖으로 밀려 닿지 않았다(AX5 캡처): 22 × 1.5 = 33pt 글리프
 * 여섯이 눌림 44 상자에 들어가 264 로 선다.
 */
export const REACTION_GLYPH_MAX_SCALE = 1.5;
/**
 * 시트·페이지 행 앞 칸의 이모지(`RowEmoji`, #4318). 칸이 22pt 로 고정이라(앞 PNG 아이콘과 같다) 글자 배율을 따라가지
 * 않는다 — 1 이 17pt 이모지(폭 약 21pt)가 칸에 들어가는 끝이다. 이 위로 자라면 AX5 에서 글리프가 칸 오른쪽에서 잘려
 * 조각만 남았다(design-review r4 M2). 같은 행의 글자는 끝까지 자란다.
 */
export const ROW_GLYPH_MAX_SCALE = 1;

/** Every tappable thing in this app is at least this tall. */
const hitStyle = {minHeight: TOUCH_TARGET, justifyContent: 'center'} as const;

export function Screen({
  children,
  style,
  onCanvas = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * 셸의 그라데이션 바닥 위에 **투명하게** 선다 (ADR-0189 D1, DS2-2 #2714).
   * 탭 화면 셋(홈·인박스·검색)이 켠다. 층(대화·에이전트 등)은 끄고 밑을 덮는다.
   */
  onCanvas?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  // Top only. The bottom inset belongs to whatever sits at the bottom (the tab
  // bar, a scroll view's content inset), and applying it here as well would
  // stack two gaps on a phone with a home indicator.
  return (
    <View
      style={[
        styles.screen,
        onCanvas && styles.screenOnCanvas,
        {paddingTop: insets.top},
        style,
      ]}>
      {children}
    </View>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel = '뒤로',
  right,
  leading,
  titleTestID = 'header-title',
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /**
   * What the back control is called. Defaults to 뒤로, but a surface that covers
   * another one says what it is closing — "스레드 닫기" tells a screen-reader user
   * which of the two stacked things is about to go away, and 뒤로 does not.
   */
  backLabel?: string;
  right?: React.ReactNode;
  /** 뒤로 가기와 제목 사이의 얼굴(에이전트 상세의 아바타). 보조기술에서는 제목이 이미 이름을 말한다. */
  leading?: React.ReactNode;
  /**
   * Overridable because more than one header is mounted at a time: the tab
   * screens stay alive under an open conversation, so a single shared id would
   * match three nodes and a test could not name the one it meant.
   */
  titleTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          hitSlop={8}
          style={({pressed}) => [styles.backButton, pressed && styles.pressed]}
          testID="header-back">
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
      ) : null}
      {leading ?? null}
      <View style={styles.headerText}>
        <Text
          accessibilityRole="header"
          style={styles.headerTitle}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID={titleTestID}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle} numberOfLines={1} ellipsizeMode="tail">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? null}
    </View>
  );
}

/**
 * A row that can be tapped. `minHeight` rather than a fixed height because the
 * second line of a sidebar row wraps on a narrow phone, and a fixed height would
 * clip it; the floor is what matters for the thumb.
 */
export function TapRow({
  children,
  onPress,
  accessibilityLabel,
  selected,
  rowRef,
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  selected?: boolean;
  /** Optional native handle for restoring VoiceOver focus after a pushed screen. */
  rowRef?: React.Ref<React.ElementRef<typeof Pressable>>;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : {selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.pressed,
      ]}
      testID={testID}>
      {children}
    </Pressable>
  );
}

// =============================================================================
// 단추 네 종류 (#6075) — 규격은 `docs/design-system/components.md` 「폰 단추」 절이다.
//
//   주      `PrimaryButton`  잉크 채움(`primary` · `onPrimary`). 주 행동은 잉크다 — 커스텀 강조색(ADR-0174)이 칠하지
//                             않는다(ADR-0189 D3 「주 버튼 검정」, #5100). 신호색(`accent`)은 안 읽음·경계·커서이지 주 행동이 아니다.
//   보조    `OutlineButton`  옅은 채움 — 시트 위 알약 문법(`circleLook`: 라이트 `surface` + 쉼 그림자, 다크 `surfaceMuted` + 가장자리)
//                             · `text`. 이름은 옛 모양(테두리)에서 왔고 호출 모양을 지키려고 둔다.
//   조용한  `QuietButton`    채움 없음(`text`). 막대 끝의 「뒤로」·「취소」·언어 칩.
//   위험    `DangerButton`   빨강 채움(`dangerFill` · `onDangerFill`). 되돌리기 어려운 행동의 확인.
//
// 네 종류가 같은 몸을 쓴다(`ButtonFace`): 알약(`radius.pill`), 높이 기본 44 · 작게 38(누르는 자리는 위아래 슬롭으로 44),
// 낱말은 `font.body` 600(작게는 `font.label`), 상태는 채움을 갈아 끼우지 않고 흐림만 바꾼다 —
//
//   쉼      제 채움 + 제 글자색
//   눌림    `PRESSED_OPACITY`(0.6)
//   잠김    `disabled` 이고 진행 중이 아닐 때 `DISABLED_OPACITY`(0.55). 시트 행의 `rowDisabled` 와 같은 값이다. 앞 판의 주
//           단추는 잠기면 채움을 걷고 옅은 칸 + `textMuted` 글자로 섰다(#5100 · #5170 L1). 시안 장면 4의 확정안이 「잠김 = 같은
//           채움을 흐리게」라서 그 칸을 걷었다. 잠긴 단추는 WCAG 1.4.3 의 예외지만 이 앱은 「못 누르는 단추도 낱말은 읽힌다」를
//           세웠었다 — 흐린 채 바탕 위에 합성한 낱말 대비는 주 · 보조 · 조용한 3.7~3.8, 위험 2.5 로 그 바닥(4.5) 아래다. 이 값과
//           거래는 부품 장부 「폰 단추」 절이 적는다(규격 표의 주인 시험은 `__tests__/buttonFamily.test.tsx`).
//   진행 중 `busy` — 채움을 그대로 두고 표시기와 낱말(`busyLabel`, 없으면 `label`)이 선다. `disabled` 를 같이 줘도 진행이
//           이긴다. 누를 수 없는 것은 잠김과 같다.
//
// `busyLabel` 은 맨몸이다(「저장 중」): 표시기가 함께 돌므로 말줄임표(U+2026)까지 붙이면 같은 사실을 두 자리에서 말한다. 레포
// 전체의 규칙은 아니다(#1511 회전 1 — 스피너 없는 맨몸 자리가 다수이고 말줄임은 소수 잔량이다).
//
// 낱말은 `BUTTON_MAX_SCALE` 에서 멈춘다(단추는 크롬이다 — 이 파일 머리의 상한 정책). 낱말은 `Sentence`(어절 줄바꿈)라 좁은
// 폭에서 두 줄로 접혀도 한 음절이 홀로 남지 않는다.
// =============================================================================

export type ButtonKind = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'regular' | 'small';

/** 네 종류가 같이 받는 props. 지금 있던 `PrimaryButton` · `OutlineButton` 의 이름은 그대로이고, 나머지는 덧붙인 선택지다. */
export interface ButtonProps {
  label: string;
  onPress: () => void;
  /** 진행 중에 낱말 자리에 서는 말(맨몸 — 위 주석). 없으면 `label` 이 표시기 곁에 남는다. */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  /** 기본 44 · 작게 38(누르는 자리는 44). */
  size?: ButtonSize;
  /** 낱말 앞의 글리프(QR 모서리 · 새로 고침). 색은 부르는 쪽이 그 종류의 글자색으로 칠한다. 진행 중이면 표시기가 이 자리에 선다. */
  icon?: React.ReactNode;
  /** `expand`: 낱말 뒤 ⌄ — 「여기서 고른다」(언어 칩, #5101). `ListRow accessory="expand"` 와 같은 글리프다. */
  accessory?: 'expand';
  /**
   * 막대 끝에 붙는 조용한 단추(「뒤로」·「취소」·언어 칩): 옆 여백을 걷고 낱말을 상자의 그쪽 끝에 붙인다. 채움이 없는 종류라
   * 여백은 보이지 않고, 막대의 여백 선과 글자가 맞는다. 상자는 `TOUCH_TARGET` 아래로 좁아지지 않는다.
   */
  flush?: 'start' | 'end';
  /** 눈에 보이는 낱말보다 긴 낭독 문장이 필요할 때(「김인턴과의 대화 열기」). 진행 중이면 `busyLabel` 이 이긴다. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/** 작게의 위아래 슬롭 — 그려지는 38 에 더해 누르는 자리 44 를 만든다. */
const SMALL_SLOP = {top: slopTo(BUTTON.smallHeight), bottom: slopTo(BUTTON.smallHeight)};

function ButtonFace({
  kind,
  label,
  onPress,
  busyLabel,
  busy,
  disabled,
  size = 'regular',
  icon,
  accessory,
  flush,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ButtonProps & {kind: ButtonKind}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const working = busy === true;
  // 누를 수 없는 것: 잠김과 진행 둘 다. 다만 흐림은 잠김만 입는다(진행 중에는 채움 위 표시기가 읽혀야 한다).
  const inert = disabled === true || working;
  const locked = disabled === true && !working;
  const small = size === 'small';
  const ink = buttonInk(palette, kind);
  const shown = working && busyLabel ? busyLabel : label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={working && busyLabel ? busyLabel : accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled: inert, busy: working}}
      disabled={inert}
      onPress={onPress}
      hitSlop={small ? SMALL_SLOP : undefined}
      style={({pressed}) => [
        styles.btn,
        small && styles.btnSmall,
        styles[BUTTON_FILL[kind]],
        flush === 'start' && styles.btnFlushStart,
        flush === 'end' && styles.btnFlushEnd,
        locked && styles.btnLocked,
        pressed && !inert && styles.btnPressed,
      ]}
      testID={testID}>
      {working ? <ActivityIndicator color={ink} /> : icon ?? null}
      <Sentence
        style={[styles.btnLabel, small && styles.btnLabelSmall, {color: ink}]}
        maxFontSizeMultiplier={BUTTON_MAX_SCALE}>
        {shown}
      </Sentence>
      {accessory === 'expand' ? (
        <Image
          source={HOME_ICONS.down}
          style={[styles.btnGlyph, {tintColor: ink}]}
          accessibilityElementsHidden
          testID={testID ? `${testID}-expand` : undefined}
        />
      ) : null}
    </Pressable>
  );
}

/** 종류의 글자색 — 낱말 · 표시기 · 글리프가 같은 값을 쓴다. 부르는 쪽이 `icon` 을 칠할 때도 이 값이다. */
export function buttonInk(palette: Palette, kind: ButtonKind): string {
  switch (kind) {
    case 'primary':
      return palette.onPrimary;
    case 'danger':
      return palette.onDangerFill;
    case 'secondary':
    case 'quiet':
      return palette.text;
  }
}

const BUTTON_FILL = {
  primary: 'btnPrimary',
  secondary: 'btnSecondary',
  quiet: 'btnQuiet',
  danger: 'btnDanger',
} as const;

/** 주 — 잉크 채움. 화면의 주 행동 하나. */
export function PrimaryButton(buttonProps: ButtonProps): React.JSX.Element {
  return <ButtonFace kind="primary" {...buttonProps} />;
}

/** A count the SERVER supplied. Never rendered from a locally derived number. */
export function CountBadge({
  count,
  tone = 'unread',
  label,
}: {
  count: number;
  tone?: 'unread' | 'mention';
  label: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, tone === 'mention' && styles.badgeMention]}>
      <Text
        style={[styles.badgeText, tone === 'mention' && styles.badgeMentionText]}
        accessibilityLabel={label}>
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}

export function LoadingState({
  label,
  testID,
}: {
  label: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View style={styles.stateBlock} testID={testID}>
      <ActivityIndicator color={palette.accentText} />
      <Text style={styles.stateDetail}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  headline,
  detail,
  refreshControl,
  scrollProps,
  testID,
}: {
  headline: string;
  detail?: string;
  /**
   * 당겨서 새로고침 (goal RN-B4b / #1026).
   *
   * 빈 목록은 당김이 **가장 필요한** 자리다. 「지금 결정할 일이 없습니다」를 읽은
   * 사람이 그 말을 의심하는 방법은 당기는 것 하나뿐이고, 당길 목록이 없다는 것은
   * 구현의 사정이지 사람의 사정이 아니다. 그래서 이 블록은 컨트롤을 받으면
   * 스크롤할 수 있는 몸을 얻는다 — 하는 말은 그대로다.
   */
  refreshControl?: React.ReactElement<RefreshControlProps>;
  /** 위성이 당긴 거리를 따라가도록 오프셋을 읽는 스크롤 props (`usePullRefresh().scrollProps`, #3962). */
  scrollProps?: PullScrollProps;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const body = (
    <>
      <Text style={styles.stateHeadline}>{headline}</Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
    </>
  );
  if (refreshControl === undefined) {
    return (
      <View style={styles.stateBlock} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <ScrollView
      // 내용이 화면보다 짧아도 당길 수 있어야 한다. 스크롤할 것이 없는 iOS
      // 스크롤뷰는 제스처를 시작조차 하지 않으므로, 이 한 줄이 없으면 컨트롤은
      // 붙어 있는데 아무 일도 일어나지 않는다 — 고치려는 결함과 같은 모양이다.
      alwaysBounceVertical
      // 내용이 뷰포트를 채워야 아래 빈 자리에서도 당겨진다(`PULL_FILL` 의 이유).
      contentContainerStyle={[styles.stateBlock, PULL_FILL]}
      refreshControl={refreshControl}
      {...scrollProps}
      testID={testID}>
      {body}
    </ScrollView>
  );
}

export function ErrorState({
  headline,
  detail,
  onRetry,
  testID,
}: {
  headline: string;
  detail?: string;
  onRetry?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.stateBlock} testID={testID}>
      <Text style={[styles.stateHeadline, styles.stateHeadlineDanger]}>
        {headline}
      </Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({pressed}) => [styles.retry, pressed && styles.pressed]}
          testID={testID ? `${testID}-retry` : undefined}>
          <Text style={styles.retryLabel}>다시 시도</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A statement of fact that is not a failure: "이 서버는 아직 그걸 하지 않습니다".
 *
 * Deliberately has no retry and no danger colour. See the header note.
 */
export function NoticeBlock({
  headline,
  detail,
  onDismiss,
  testID,
}: {
  headline: string;
  detail?: string;
  /**
   * Only for a notice that is a RECEIPT — something the person just did, which
   * they have read once and do not need under the list forever. A statement of
   * what this server cannot do is not dismissible: it stays true after a tap.
   */
  onDismiss?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.notice} testID={testID}>
      <View style={styles.noticeHead}>
        {/* ## 낱말 가운데서 끊지 않는다 (리뷰 N-b)

            iOS 기본 줄바꿈은 한글을 **글자 단위**로 끊는다. 402pt 화면에서 제목은
            「닫기」와 폭을 나눠 쓰므로 두 줄은 불가피한데, 끊기는 자리가 하필
            마지막 한 음절이면(실측: 「…찾지 못했습니 / 다」) 사람은 둘째 줄의 그
            한 글자를 오타나 잘린 글로 읽는다.

            문장을 깎아 맞추지 않는다 — 그러면 다음 문장에서 같은 일이 다시
            일어나고, 이 상자는 앞으로도 문장을 더 받는다. 플랫폼이 이 경우를 위해
            든 값을 쓴다: `hangul-word` = `NSLineBreakStrategyHangulWordPriority`,
            한국어 워드프로세서의 규칙(어절 우선)이다. 화면이 좁아져도 규칙이 함께
            간다.

            `NoticeBlock` **전체**가 받는다. 이 컴포넌트가 드는 것은 언제나 완성된
            한국어 문장이고(인용·고정·검색·세션 앵커의 네 고지 + 서버 능력 고지),
            그중 하나만 예외로 두면 같은 상자가 문장마다 다르게 끊긴다. */}
        <View style={styles.noticeText}>
          <Text style={withLineHeadroom(styles.noticeHeadline)} lineBreakStrategyIOS="hangul-word">
            {headline}
          </Text>
          {detail ? (
            <Text style={withLineHeadroom(styles.noticeDetail)} lineBreakStrategyIOS="hangul-word">
              {detail}
            </Text>
          ) : null}
        </View>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="닫기"
            onPress={onDismiss}
            style={({pressed}) => [styles.noticeDismiss, pressed && styles.pressed]}
            testID={testID ? `${testID}-dismiss` : undefined}>
            {/* 글자 「닫기」가 아니라 시트·페이지와 같은 X 글리프다(#4458). 시트가 아니므로 원은 없다. */}
            <Image source={SHEET_ICONS.close} style={styles.noticeDismissGlyph} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * 여러 줄로 접히는 **완성된 한국어 본문 문장**. iOS 기본 줄바꿈은 한글을 글자
 * 단위로 끊어 마지막 한 음절이 둘째 줄에 홀로 남는 결함이 있다(위 `NoticeBlock`
 * 주석의 실측). `NoticeBlock` 이 그 상자에 `hangul-word` 를 든 것과 같은 이유로,
 * 상자 밖에서 그리는 본문 문장도 같은 규칙을 든다 — 규칙이 한 자리에 있지 않으면
 * 같은 앱이 문장마다 다르게 끊긴다(리뷰 M2).
 *
 * 어절 우선 줄바꿈은 공백이 있는 글에서 뜻이 있다(한 낱말에는 효과가 없고 해도 없다). 그래서 문장뿐 아니라 두 낱말 이상의
 * **라벨**(「다음 결정 보기」·「기본 제공」·단추 이름)에도 쓴다 — 결정 무대·테마·에이전트 비용(#4982)은 한글이 든 글자 전부가
 * 이 부품이고, 하네스(`__tests__/fixtures/hangulWord.ts`)가 빠진 글자를 센다. 숫자·이모지·아이콘 글리프에는 쓰지 않는다.
 * `style`·`numberOfLines`·`testID` 등 `Text` 의 모든 props 를 그대로 받는다. `ref` 도 받는다(React 19 에서 함수 부품의 `ref` 는
 * 보통 prop 이라 아래 `rest` 와 함께 `Text` 로 간다) — 낭독 초점을 이 글로 옮기는 자리가 쓴다(승인 카드의 질문, #5593).
 *
 * **줄 높이에 여유를 준다**(`withLineHeadroom`, #5288): 여러 줄로 접힌 글이 첫 줄만 그려지고 잘리는 결함은 `hangul-word` 탓이 아니라(여섯 줄바꿈
 * 전략이 같은 절대 y 에서 똑같이 났다) 글 상자 높이가 float 반올림으로 줄 수의 요구보다 1e-4pt 낮게 내려오는 것이다. 한글이 없는 글에서
 * `hangul-word` 를 빼는 것은 고침이 아니다 — 그 글도 같은 자리에서 잘렸다. 같은 여유가 **`hangul-word` 를 실제로 켠다**: 컨테이너 높이가 줄 수의
 * 요구와 정확히 같으면(정수 줄 높이 글 전부) 줄바꿈 전략이 꺼져 한 글자 고아 줄이 났다(근거·실측은 `lineHeadroom.ts`).
 */
export function Sentence(
  props: React.ComponentProps<typeof Text> & {
    ref?: React.Ref<React.ElementRef<typeof Text>>;
  },
): React.JSX.Element {
  const {style, ...rest} = props;
  return <Text lineBreakStrategyIOS="hangul-word" {...rest} style={withLineHeadroom(style)} />;
}

/** 보조 — 옅은 채움. 주 행동 곁의 다른 길(「취소」·「다시 불러오기」). */
export function OutlineButton(buttonProps: ButtonProps): React.JSX.Element {
  return <ButtonFace kind="secondary" {...buttonProps} />;
}

/** 조용한 — 채움 없음. 막대 끝의 「뒤로」·「취소」는 `flush` 로 여백 선에 붙인다. */
export function QuietButton(buttonProps: ButtonProps): React.JSX.Element {
  return <ButtonFace kind="quiet" {...buttonProps} />;
}

/** 위험 — 빨강 채움. 지우기 · 멈추기 · 거부처럼 되돌리기 어려운 행동을 확인하는 자리. */
export function DangerButton(buttonProps: ButtonProps): React.JSX.Element {
  return <ButtonFace kind="danger" {...buttonProps} />;
}

/** An inline failure attached to a form, rather than a whole-surface state. */
export function FailureBanner({
  message,
  onRetry,
  retryLabel = '다시 시도',
  testID,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={styles.failure}
      testID={testID}>
      <Sentence style={styles.failureText}>{message}</Sentence>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({pressed}) => [styles.retry, pressed && styles.pressed]}
          testID={testID ? `${testID}-retry` : undefined}>
          <Text style={styles.retryLabel}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SectionLabel({label}: {label: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.sectionLabel}>
      <Text accessibilityRole="header" style={styles.sectionLabelText}>
        {label}
      </Text>
    </View>
  );
}

// =============================================================================
// 묶음 카드 — 설정 같은 목록의 한 묶음 (#2702).
//
// 프로필 시트가 처음 쓴다: 테마 · 알림 · 연결 · 계정이 각자 둥근 카드 하나에
// 담기고, 카드 위에 작은 머리글이 선다. iOS 설정 앱과 Buzz 의 프로필이 같은
// 문법이고, 사람이 「이 화면은 나에 관한 설정이다」를 읽는 모양이 이것이다.
//
// 카드의 모서리는 `radius.md` — 웹 `--radius-md` 가 「cards, list groups」라고
// 이름 붙인 자리다. 새 반경을 들이지 않는다(디자인 시스템 2.0, #2703 의 몫).
// 카드와 바탕을 가르는 것은 채움(`surface`)이고 테두리는 hairline `border` —
// 선이지 컨트롤이 아니다. 누를 수 있는 줄은 오른쪽의 ›, 또는 강조색 글자가 말한다.
// =============================================================================

export function GroupSection({
  label,
  children,
  testID,
}: {
  label?: string;
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.group} testID={testID}>
      {label ? (
        <Text accessibilityRole="header" style={styles.groupLabel}>
          {label}
        </Text>
      ) : null}
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
}

/**
 * 묶음 카드 안의 한 줄.
 *
 * `onPress` 가 있으면 누르는 줄, 없으면 읽는 줄이다. `separated` 는 위 줄과의
 * 가는 선 — 카드의 첫 줄에는 주지 않는다. `tone="danger"` 는 파괴 행(로그아웃)이고
 * 글자가 위험색으로 선다.
 */
export function GroupRow({
  title,
  detail,
  value,
  chevron = false,
  tone = 'default',
  separated = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  accessibilityState,
  disabled = false,
  leading,
  trailing,
  testID,
}: {
  title: string;
  detail?: string;
  value?: string;
  chevron?: boolean;
  tone?: 'default' | 'danger' | 'accent';
  separated?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'radio' | 'switch';
  accessibilityState?: {
    selected?: boolean;
    checked?: boolean;
    disabled?: boolean;
    expanded?: boolean;
  };
  /** 누를 수 없는 동안(읽는 중·쓰는 중). 줄은 보이되 흐려지고 눌리지 않는다. */
  disabled?: boolean;
  /** 제목 앞의 작은 표지(상태 점 등). 장식이라 읽히지 않게 넘긴다. */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const body = (
    <>
      {leading ?? null}
      <View style={styles.groupRowText}>
        <Text
          // 큰 글씨에서 「18:00까\n지」처럼 어절 가운데서 끊기지 않게.
          lineBreakStrategyIOS="hangul-word"
          style={[
            styles.groupRowTitle,
            tone === 'danger' && styles.groupRowTitleDanger,
            tone === 'accent' && styles.groupRowTitleAccent,
          ]}>
          {title}
        </Text>
        {detail ? (
          <Sentence style={styles.groupRowDetail}>{detail}</Sentence>
        ) : null}
      </View>
      {value ? (
        <Text style={styles.groupRowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {trailing ?? null}
      {chevron ? (
        <Text style={styles.groupRowChevron} importantForAccessibility="no">
          ›
        </Text>
      ) : null}
    </>
  );
  const rowStyle = [styles.groupRow, separated && styles.groupRowSeparated];
  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={rowStyle}
        testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={
        disabled ? {...accessibilityState, disabled: true} : accessibilityState
      }
      // `false` 를 넘기지 않는다 — Pressable 은 그것도 접근성 상태에 섞어 기존 줄의
      // 상태 모양을 바꾼다.
      disabled={disabled ? true : undefined}
      onPress={onPress}
      style={({pressed}) => [
        ...rowStyle,
        pressed && !disabled && styles.pressed,
        disabled && styles.groupRowDisabled,
      ]}
      testID={testID}>
      {body}
    </Pressable>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  screen: {flex: 1, backgroundColor: color.bg},
  screenOnCanvas: {backgroundColor: 'transparent'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    minHeight: TOUCH_TARGET + space.md,
  },
  headerText: {flex: 1, gap: 2},
  headerTitle: {fontSize: font.heading, fontWeight: '600', color: color.text},
  headerSubtitle: {fontSize: font.meta, color: color.textMuted},
  backButton: {
    ...hitStyle,
    width: TOUCH_TARGET,
    marginLeft: -space.md,
    alignItems: 'center',
  },
  backGlyph: {fontSize: 30, lineHeight: 34, color: color.accentText},
  row: {
    ...hitStyle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.md,
  },
  rowSelected: {backgroundColor: color.surface},
  pressed: {backgroundColor: color.surfacePressed},
  btn: {
    minHeight: BUTTON.height,
    paddingHorizontal: BUTTON.padX,
    paddingVertical: BUTTON.padY,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: BUTTON.gap,
  },
  btnSmall: {minHeight: BUTTON.smallHeight, paddingHorizontal: BUTTON.smallPadX},
  btnPrimary: {backgroundColor: color.primary},
  // 보조의 「옅은 채움」은 폰의 시트 위 알약 문법이다(`circleLook`, phone-sheets §4): 라이트는 `surface` + 쉼 그림자, 다크는 한 단 위
  // `surfaceMuted` + 가장자리 한 줄. 시안이 적은 `surfaceMuted` 만으로는 라이트의 바닥·시트와 같은 색이 되어(흑연·노을 1.000:1, 새벽하늘
  // 시트 위 1.009:1) 보조 단추가 조용한 단추와 갈리지 않았다 — #5170 L1 이 잠긴 주 단추에서 잰 것과 같은 함정이다.
  btnSecondary: {
    backgroundColor: circleLook(color).fill,
    borderColor: circleLook(color).ring,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: color.elevationRest,
  },
  btnQuiet: {},
  btnDanger: {backgroundColor: color.dangerFill},
  // 막대 끝의 조용한 단추: 여백을 걷고 낱말을 그쪽 끝에 붙인다. 상자는 44 아래로 좁아지지 않는다.
  btnFlushStart: {paddingHorizontal: 0, minWidth: TOUCH_TARGET, justifyContent: 'flex-start'},
  btnFlushEnd: {paddingHorizontal: 0, minWidth: TOUCH_TARGET, justifyContent: 'flex-end'},
  btnLocked: {opacity: DISABLED_OPACITY},
  btnPressed: {opacity: PRESSED_OPACITY},
  btnLabel: {fontSize: font.body, lineHeight: line.body, fontWeight: '600', textAlign: 'center', flexShrink: 1},
  btnLabelSmall: {fontSize: font.label, lineHeight: line.label},
  btnGlyph: {width: HOME_ICON_SIZE.down, height: HOME_ICON_SIZE.down},
  badge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: color.border,
    alignItems: 'center',
  },
  badgeMention: {backgroundColor: color.warn},
  badgeText: {fontSize: font.meta, fontWeight: '600', color: color.text},
  badgeMentionText: {color: color.onWarn},
  stateBlock: {
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.xl,
    gap: space.sm,
    alignItems: 'flex-start',
  },
  stateHeadline: {fontSize: font.body, color: color.text, fontWeight: '600'},
  stateHeadlineDanger: {color: color.danger},
  stateDetail: {fontSize: font.label, color: color.textMuted, lineHeight: 20},
  retry: {
    ...hitStyle,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    alignSelf: 'flex-start',
  },
  retryLabel: {color: color.accentText, fontSize: font.label, fontWeight: '600'},
  notice: {
    marginHorizontal: SAFE_GUTTER,
    marginVertical: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.xs,
  },
  noticeHead: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
  noticeText: {flex: 1, gap: space.xs},
  noticeDismiss: {
    ...hitStyle,
    minWidth: TOUCH_TARGET,
    alignItems: 'center',
    marginVertical: -space.md,
    borderRadius: radius.sm,
  },
  noticeDismissGlyph: {
    width: SHEET_ICON_SIZE.close,
    height: SHEET_ICON_SIZE.close,
    tintColor: color.icon,
  },
  noticeHeadline: {fontSize: font.label, color: color.text, fontWeight: '600'},
  noticeDetail: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
  failure: {
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.dangerSurface,
    borderWidth: 1,
    borderColor: color.dangerBorder,
    gap: space.sm,
  },
  failureText: {color: color.dangerText, fontSize: font.label, lineHeight: 20},
  sectionLabel: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionLabelText: {
    fontSize: font.meta,
    color: color.textFaint,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  group: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
  groupLabel: {
    fontSize: font.label,
    color: color.textMuted,
    fontWeight: '600',
    paddingHorizontal: space.xs,
  },
  groupCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  groupRow: {
    ...hitStyle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  groupRowSeparated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  groupRowText: {flex: 1, gap: space.xs},
  groupRowTitle: {fontSize: font.body, color: color.text},
  groupRowTitleDanger: {color: color.danger, fontWeight: '600'},
  groupRowTitleAccent: {color: color.accentText, fontWeight: '600'},
  groupRowDetail: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
  groupRowValue: {fontSize: font.body, color: color.textMuted, flexShrink: 1},
  groupRowChevron: {fontSize: font.heading, color: color.textFaint},
  groupRowDisabled: {opacity: DISABLED_OPACITY},
});
