import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from './tokens';

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

/** Every tappable thing in this app is at least this tall. */
const hitStyle = {minHeight: TOUCH_TARGET, justifyContent: 'center'} as const;

export function Screen({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  // Top only. The bottom inset belongs to whatever sits at the bottom (the tab
  // bar, a scroll view's content inset), and applying it here as well would
  // stack two gaps on a phone with a home indicator.
  return (
    <View style={[styles.screen, {paddingTop: insets.top}, style]}>{children}</View>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
  titleTestID = 'header-title',
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  /**
   * Overridable because more than one header is mounted at a time: the tab
   * screens stay alive under an open conversation, so a single shared id would
   * match three nodes and a test could not name the one it meant.
   */
  titleTestID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="뒤로"
          onPress={onBack}
          hitSlop={8}
          style={({pressed}) => [styles.backButton, pressed && styles.pressed]}
          testID="header-back">
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerText}>
        <Text
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
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  selected?: boolean;
  testID?: string;
}): React.JSX.Element {
  return (
    <Pressable
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
  busyLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}): React.JSX.Element {
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
          <ActivityIndicator color="#ffffff" />
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
  return (
    <View style={styles.stateBlock} testID={testID}>
      <ActivityIndicator color={color.accentText} />
      <Text style={styles.stateDetail}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  headline,
  detail,
  testID,
}: {
  headline: string;
  detail?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.stateBlock} testID={testID}>
      <Text style={styles.stateHeadline}>{headline}</Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
    </View>
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
  testID,
}: {
  headline: string;
  detail?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.notice} testID={testID}>
      <Text style={styles.noticeHeadline}>{headline}</Text>
      {detail ? <Text style={styles.noticeDetail}>{detail}</Text> : null}
    </View>
  );
}

/** An inline failure attached to a form, rather than a whole-surface state. */
export function FailureBanner({
  message,
  onRetry,
  testID,
}: {
  message: string;
  onRetry?: () => void;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.failure} testID={testID}>
      <Text style={styles.failureText}>{message}</Text>
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

export function SectionLabel({label}: {label: string}): React.JSX.Element {
  return (
    <View style={styles.sectionLabel}>
      <Text style={styles.sectionLabelText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: color.bg},
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
  buttonLabel: {color: '#ffffff', fontSize: font.body, fontWeight: '600'},
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
  badgeMentionText: {color: '#1b1405'},
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
  failureText: {color: '#f0b4b8', fontSize: font.label, lineHeight: 20},
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
});
