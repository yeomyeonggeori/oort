import React, {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from 'react';
import {
  AccessibilityInfo,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Sentence} from '../../design/atoms';
import {usePageSheetScrollProps} from '../../design/PageSheet';
import {BackCircle} from '../../design/SheetChrome';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useKeyboardHeight} from '../../lib/useKeyboardHeight';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 팀 이모지 「＋」의 안쪽 장 — 가져오기·AI와 만들기가 같이 쓰는 바깥틀 (#4891).
//
// ## 시트인가 페이지인가 (`docs/design-system/phone-sheets.md` §1)
//
// 규칙으로 읽으면 둘 다 **페이지**다: 입력이 세 칸 넘고(가져오기 이름·표시 이름·태그·링크, 만들기 사진·움직임·
// 에이전트·메모), 스크롤해야 하고, 가져오기는 안에서 미리보기로 더 들어간다. 그런데 이 칸은 **고르개 시트 안의 안쪽
// 장**(큰 단)으로 둔다 — 규칙상 페이지인 시트를 머리·부품만 옮겨 둔 #4458 의 선례와 같다:
//
//   1. 고르개는 두 호스트(`MessageActionSheet`·`Composer` 의 이모지 모달)의 시트 안에 서고, 호스트 계약
//      (`TeamEmojiSlot.render`)에는 시트를 먼저 내리고 페이지를 여는 문이 없다. 두 호스트는 이 칸 밖(칸 6·8)이다.
//   2. 새 층은 `nav/state.ts`·`AppShell.tsx` 공용 파일을 건드린다(층 하나가 리듀서·그리기 순서·가장자리 스와이프에
//      모두 걸린다).
//   3. Modal 위에 화면을 쌓지 않는다(§1 규칙 2) — 페이지로 가려면 호스트가 시트를 내리고 문을 열어야 한다.
//
// 그래서 본문은 호스트를 모르는 컴포넌트(`onBack`·`onDone`뿐)로 짰다 — 페이지 전환(#4611 계열)이 오면 이 장의 본문을
// 그대로 페이지 본문으로 옮긴다. 머리는 페이지의 안쪽 장과 같은 문법이다: 왼쪽 원형 ‹ 은 「목록으로」(한 겹만 벗긴다),
// 시트 전체를 닫는 X 는 호스트(`EmojiPicker`)의 머리에 그대로 있다.
// =============================================================================

/** 안내·실패 한 줄. 새로 서거나 바뀌면 낭독한다(iOS 는 `alert` 역할만으로는 나타날 때 읽지 않는다). */
export function LiveLine({
  text,
  tone = 'muted',
  testID,
}: {
  text: string | null | undefined;
  tone?: 'muted' | 'danger';
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  useEffect(() => {
    if (text) AccessibilityInfo.announceForAccessibility?.(text);
  }, [text]);
  if (!text) return null;
  return (
    <Sentence
      accessibilityRole="alert"
      style={[styles.line, tone === 'danger' && styles.lineDanger]}
      testID={testID}>
      {text}
    </Sentence>
  );
}

/** 구역마다 자리를 기억해 두었다가, 막힌 칸·초점이 간 칸이 보이게 스크롤한다. */
export function useSectionScroll(): {
  ref: RefObject<ScrollView | null>;
  track: (key: string) => (event: LayoutChangeEvent) => void;
  reveal: (key: string) => void;
} {
  const ref = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, number>());
  const reduceMotion = useReduceMotion();
  const track = useCallback(
    (key: string) => (event: LayoutChangeEvent) => {
      offsets.current.set(key, event.nativeEvent.layout.y);
    },
    [],
  );
  const reveal = useCallback(
    (key: string) => {
      const y = offsets.current.get(key);
      if (y === undefined) return;
      ref.current?.scrollTo({
        y: Math.max(0, y - space.md),
        animated: !reduceMotion,
      });
    },
    [reduceMotion],
  );
  return {ref, track, reveal};
}

export function ExpressionChapter({
  title,
  onBack,
  scrollRef,
  children,
  testID,
}: {
  title: string;
  onBack: () => void;
  scrollRef?: RefObject<ScrollView | null>;
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const sheetScroll = usePageSheetScrollProps();
  // 시트 몸의 바닥 여백 규칙(`SheetScroll`)과 같다: 키보드가 이미 덮는 동안에는 홈 인디케이터 여백을 걷는다.
  const bottom =
    (keyboardHeight > 0 ? 0 : Math.max(insets.bottom, space.lg)) + space.lg;
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.head}>
        <BackCircle
          label={formatMessage('expressions.add.backLabel')}
          onPress={onBack}
          testID="expression-chapter-back"
        />
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      </View>
      <ScrollView
        ref={scrollRef}
        {...sheetScroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.body, {paddingBottom: bottom}]}
        testID={testID ? `${testID}-scroll` : undefined}>
        {children}
      </ScrollView>
    </View>
  );
}

/** 앨범에서 고른 그림 한 장의 줄: 고르기·다른 걸 고르기 단추와, 고르고 나면 작은 그림·이름·크기. */
export function PhotoPickRow({
  photo,
  disabled,
  pickLabel,
  changeLabel,
  previewLabel,
  onPick,
  testID,
}: {
  photo: {uri: string; name: string; bytes: number | null} | null;
  disabled?: boolean;
  pickLabel: string;
  changeLabel: string;
  previewLabel: string;
  onPick: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const label = photo ? changeLabel : pickLabel;
  return (
    <View style={styles.photoRow}>
      {photo ? (
        <Image
          source={{uri: photo.uri}}
          resizeMode="cover"
          accessibilityLabel={previewLabel}
          style={styles.thumb}
          testID={testID ? `${testID}-preview` : undefined}
        />
      ) : null}
      <View style={styles.photoText}>
        {photo ? (
          <Text style={styles.photoName} numberOfLines={2}>
            {photo.name}
          </Text>
        ) : null}
        {photo && photo.bytes !== null ? (
          <Text style={styles.photoMeta}>{sizeLabel(photo.bytes)}</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{disabled: disabled === true}}
          disabled={disabled}
          onPress={onPick}
          style={({pressed}) => [
            styles.pickButton,
            disabled === true && styles.pickButtonOff,
            pressed && styles.pickButtonPressed,
          ]}
          testID={testID}>
          <Text style={styles.pickLabel}>{label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 「123 KiB」·「4.2 MiB」. 숫자는 사실이고 낱말은 단위뿐이다. */
function sizeLabel(bytes: number): string {
  const kib = bytes / 1024;
  return kib < 1024
    ? `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`
    : `${(kib / 1024).toFixed(1)} MiB`;
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: SAFE_GUTTER,
      paddingBottom: space.xs,
    },
    title: {
      flex: 1,
      fontSize: font.heading,
      lineHeight: line.heading,
      fontWeight: '600',
      color: color.text,
    },
    body: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.sm,
      gap: space.lg,
    },
    line: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    lineDanger: {color: color.dangerText},
    photoRow: {flexDirection: 'row', alignItems: 'center', gap: space.md},
    thumb: {
      width: TOUCH_TARGET + space.md,
      height: TOUCH_TARGET + space.md,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
    photoText: {flex: 1, gap: space.xs},
    photoName: {fontSize: font.label, lineHeight: line.label, color: color.text},
    photoMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    pickButton: {
      minHeight: TOUCH_TARGET,
      alignSelf: 'flex-start',
      justifyContent: 'center',
      paddingHorizontal: space.lg,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surfaceMuted,
    },
    pickButtonOff: {opacity: 0.5},
    pickButtonPressed: {backgroundColor: color.surfacePressed},
    pickLabel: {fontSize: font.body, lineHeight: line.body, color: color.text},
  });
