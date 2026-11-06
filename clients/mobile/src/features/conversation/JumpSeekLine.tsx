import React from 'react';
import {ActivityIndicator, Image, Pressable, StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';

// =============================================================================
// 「이전 대화에서 메시지를 찾는 중이에요 · 취소」 — 점프가 불러온 범위 밖으로 갈 때 서는 한 줄 (#5383)
//
// 점프 문은 목적지가 안 불러온 오래된 쪽에 있으면 그 자리까지 목록을 거슬러 읽는다(`useTimeline.seekOlder`). 읽는 동안 사람이
// 볼 것이 있어야 하고(찾는 중), 접을 수 있어야 하고(취소), 실패하면 다시 해 볼 수 있어야 한다(다시 시도 · 닫기).
//
// ## 왜 목록 머리의 고지(`NoticeBlock`)가 아니라 입력창 위인가
//
// 「위쪽에 있어요」 고지는 목록 **맨 위**에 서고, 이 점프를 건 사람은 거의 언제나 **바닥**에 있다(대화를 막 열었거나, 검색 목록에서
// 돌아왔다). 맨 위의 줄은 스크롤 안에 있어 안 보인다 - 「찾는 중」과 「취소」는 보여야만 뜻이 있다. 그래서 입력창 바로 위 도크의
// 한 줄이다(작성 중·중단 영수증이 서는 자리와 같은 곳).
//
// `NoticeBlock` 에 단추를 달지 않은 이유도 있다. 그 부품의 머리말이 「실패가 아니라 사실 진술이고 다시 시도가 없다」고 못박아 두었고,
// 이 줄의 두 번째 모양(읽기 실패)은 정확히 그 반대 - 실패이고 다시 시도가 있다. 한 부품에 두 성격을 섞지 않는다. 읽기 중과 실패
// 둘 다 이 줄이 맡고, 끝내 못 찾았을 때의 사실 진술(「더 위쪽에 있습니다」)은 여전히 `NoticeBlock` 이다.
//
// 누르는 면은 44pt(`TOUCH_TARGET`)를 단추가 진다. 글자는 사전(`mobile.jumpSeek.*`)이다.
// =============================================================================

export function JumpSeekLine({
  failed,
  onCancel,
  onRetry,
  onDismiss,
}: {
  /** 읽다가 실패했다 - 「다시 시도」와 「닫기」가 선다. 거짓이면 읽는 중이다. */
  failed: boolean;
  /** 읽는 중의 「취소」. */
  onCancel: () => void;
  /** 실패 뒤의 「다시 시도」. */
  onRetry: () => void;
  /** 실패 뒤의 「닫기」. */
  onDismiss: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const cancelLabel = formatMessage('mobile.jumpSeek.cancel');
  const retryLabel = formatMessage('mobile.jumpSeek.retry');
  const dismissLabel = formatMessage('mobile.jumpSeek.dismiss');
  const sentence = formatMessage(
    failed ? 'mobile.jumpSeek.failed' : 'mobile.jumpSeek.reading',
  );
  return (
    <View
      accessibilityLiveRegion="polite"
      style={styles.row}
      testID="jump-seek">
      {failed ? null : (
        <ActivityIndicator color={palette.textMuted} size="small" />
      )}
      <Sentence
        style={[styles.text, failed && styles.textFailed]}
        testID="jump-seek-text">
        {sentence}
      </Sentence>
      {failed ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
            onPress={onRetry}
            style={({pressed}) => [styles.action, pressed && styles.pressed]}
            testID="jump-seek-retry">
            <Sentence style={styles.actionLabel}>{retryLabel}</Sentence>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
            onPress={onDismiss}
            style={({pressed}) => [styles.dismiss, pressed && styles.pressed]}
            testID="jump-seek-dismiss">
            <Image source={SHEET_ICONS.close} style={styles.dismissGlyph} />
          </Pressable>
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          onPress={onCancel}
          style={({pressed}) => [styles.action, pressed && styles.pressed]}
          testID="jump-seek-cancel">
          <Sentence style={styles.actionLabel}>{cancelLabel}</Sentence>
        </Pressable>
      )}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      minHeight: TOUCH_TARGET,
      paddingLeft: SAFE_GUTTER,
      paddingRight: space.sm,
    },
    text: {
      flex: 1,
      fontSize: font.label,
      lineHeight: 18,
      color: color.textMuted,
    },
    // 실패는 사실 진술이 아니라 실패다 - 중단 영수증의 오류(`stopOutcomeError`)와 같은 색이다.
    textFailed: {color: color.danger},
    action: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
    },
    actionLabel: {color: color.accentText, fontSize: font.label, fontWeight: '600'},
    dismiss: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dismissGlyph: {
      width: SHEET_ICON_SIZE.close,
      height: SHEET_ICON_SIZE.close,
      tintColor: color.icon,
    },
    pressed: {opacity: 0.6},
  });
