import React from 'react';
import {
  ActivityIndicator,
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
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from './tokens';
import {usePalette, useStyles} from './theme';

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

export function PrimaryButton({
  label,
  busyLabel,
  onPress,
  disabled,
  busy,
  testID,
}: {
  label: string;
  /**
   * 진행 중에 라벨을 대체하는 낱말. **이 컴포넌트의 지역 관례는 맨몸이다**
   * (「저장 중」): 이 버튼은 낱말 옆에서 `ActivityIndicator` 를 함께 돌리므로,
   * 말줄임표(U+2026)까지 붙이면 같은 사실을 두 자리에서 말한다. 그것이 여기서
   * `busyLabel` 에 말줄임을 넘기지 않는 이유다.
   *
   * **레포 전체의 규칙은 아니다** (#1511 회전 1). 앞 판의 이 주석은 「말줄임표는
   * 스피너가 없는 자리의 진행 신호」라는 일반 판정을 세웠는데, 트리를 재 보면
   * 그렇지 않다 — 스피너 없이 맨몸인 자리가 다수이고 말줄임은 소수 잔량이다
   * (2026-08-19 AST 실측, 렌더 문자열만: 맨몸 웹 100·폰 6·코어 49 / 말줄임
   * 웹 6·폰 7·코어 3 = 16. 맨몸 쪽 수에는 「작업 중」 같은 상태 낱말도 섞여
   * 있어 상한으로 읽어야 하지만, 말줄임 16 은 정확한 잔량이다). 스피너 없이
   * 맨몸인 자리는 공유 프리미티브에도 있다: 웹 `SettingsFields` 의 기본
   * 「저장 중」, `InlineBanner` 의 `actionBusy`(스피너를 그리지 않는다), 그리고
   * 코어 `CANCEL_BUSY_LABEL` 을 스피너 없이 렌더하는 폰 `StopTurnControl`.
   *
   * 그래서 웹 `ConnectPage` 가 「참여 중…」이고 폰이 「참여 중」인 것은 정책의
   * 결과가 아니라 **관측된 갈림**이다. 잔량 16 을 한 관례로 모을지는 이 goal
   * 에서 정하지 않았다(별도 goal 후보 — 카피 변경이라 표면마다 판단이 든다).
   */
  busyLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const inert = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled: inert, busy}}
      disabled={inert}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        inert && styles.buttonDisabled,
        pressed && !inert && styles.buttonPressed,
      ]}
      testID={testID}>
      {busy ? (
        <View style={styles.buttonBusy}>
          <ActivityIndicator color={palette.onAccent} />
          {busyLabel ? <Text style={styles.buttonLabel}>{busyLabel}</Text> : null}
        </View>
      ) : (
        <Text style={styles.buttonLabel}>{label}</Text>
      )}
    </Pressable>
  );
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
      contentContainerStyle={styles.stateBlock}
      refreshControl={refreshControl}
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
          <Text style={styles.noticeHeadline} lineBreakStrategyIOS="hangul-word">
            {headline}
          </Text>
          {detail ? (
            <Text style={styles.noticeDetail} lineBreakStrategyIOS="hangul-word">
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
            <Text style={styles.retryLabel}>닫기</Text>
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
 * 낱말·라벨·숫자 카운트에는 쓰지 않는다 — 어절 우선 줄바꿈은 문장에서만 뜻이 있다.
 * `style`·`numberOfLines`·`testID` 등 `Text` 의 모든 props 를 그대로 받는다.
 */
export function Sentence(
  props: React.ComponentProps<typeof Text>,
): React.JSX.Element {
  return <Text lineBreakStrategyIOS="hangul-word" {...props} />;
}

/** An inline failure attached to a form, rather than a whole-surface state. */
export function OutlineButton({
  label,
  onPress,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({pressed}) => [styles.outline, pressed && styles.pressed]}
      testID={testID}>
      <Text style={styles.retryLabel}>{label}</Text>
    </Pressable>
  );
}

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
    <View style={styles.failure} testID={testID}>
      <Text style={styles.failureText}>{message}</Text>
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
  accessibilityRole?: 'button' | 'radio';
  accessibilityState?: {selected?: boolean};
  trailing?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const body = (
    <>
      <View style={styles.groupRowText}>
        <Text
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
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={({pressed}) => [...rowStyle, pressed && styles.pressed]}
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
  button: {
    ...hitStyle,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    backgroundColor: color.accent,
  },
  buttonDisabled: {backgroundColor: color.border},
  buttonPressed: {backgroundColor: color.accentPressed},
  buttonBusy: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  buttonLabel: {color: color.onAccent, fontSize: font.body, fontWeight: '600'},
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
  outline: {
    ...hitStyle,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
  },
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
});
