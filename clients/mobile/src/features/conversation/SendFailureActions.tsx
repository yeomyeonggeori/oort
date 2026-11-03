import React from 'react';
import {Image, Pressable, StyleSheet} from 'react-native';
import {SHELL_ICONS} from '../../design/icons';
import {CARD_ICONS} from '../../design/icons/cardIcons';
import {useStyles} from '../../design/theme';
import {TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';

// =============================================================================
// 보내지 못한 메시지 곁의 아이콘 둘 (#5210, owner 2026-11-03): 새로고침(다시 보내기) · 빨간 X(지우기).
// 카카오톡·iMessage류의 업계 관례이고, 웹 `SendFailureActions.tsx` 와 같은 문법이다(아이콘 · 이름 · 위계).
//
// 작은 공용 부품으로 둔 이유: 「대화에도 보내기」 화면(#4888)이 밀어서 보낸 답글의 실패를 같은 두 아이콘으로
// 알린다. 부모 줄(`failedRow`, 가로 줄)에 두 단추를 **바로** 넣는다 — 감싸는 상자가 없다.
//
// 글리프는 이미 있는 아이콘 묶음에서 옮겨 쓴다(새로 그리지 않았다): 새로고침은 `CARD_ICONS.refresh`(16pt 래스터),
// X 는 `SHELL_ICONS.x`(20pt 래스터를 16으로 줄여 그린다 — 늘려 그리면 흐려진다). 둘 다 선 1.8 의 같은 레시피다.
//
// 누르는 면은 44pt(`TOUCH_TARGET`)다. 글리프 가장자리에서 안쪽 여백을 `(44 − 글리프) / 2` 로 두면 상자가 정확히
// 44 가 되고 글리프는 가운데에 선다 — 가운데 정렬 값도 `hitSlop` 숫자도 손으로 적지 않는다(`designSystem.test.ts` 의
// 손으로 적은 터치 수 잔량은 늘지 않는다).
//
// 위계(디자인 시스템 §3.1): 파괴인 X 만 `danger` 이고 다시 보내기는 `textMuted` 다. 지우기는 확인 단계 없이 한 번에
// 지운다 — 지우는 것은 서버에 행이 없는 이 기기의 대기분 하나뿐이고(코어 `discardPending`, 보내는 중인 행은 지우지
// 않는다) 서버에서는 아무것도 사라지지 않는다. 한 번 누르기는 owner 결정(2026-11-03)이다.
// =============================================================================

/** 눈에 보이는 글리프. 웹과 같은 16(`size-4`, 디자인 시스템 §2.8의 기본 크기). */
const GLYPH = 16;

export function SendFailureActions({
  onResend,
  onDiscard,
}: {
  /** 없으면 새로고침 아이콘을 그리지 않는다. */
  onResend?: () => void;
  /** 없으면 X 를 그리지 않는다. */
  onDiscard?: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  if (!onResend && !onDiscard) return null;
  return (
    <>
      {onResend ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={formatMessage('timeline.send.resend')}
          onPress={onResend}
          style={({pressed}) => [styles.action, pressed && styles.pressed]}
          testID="pending-resend">
          <Image source={CARD_ICONS.refresh} style={styles.resendGlyph} />
        </Pressable>
      ) : null}
      {onDiscard ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={formatMessage('timeline.send.discard')}
          onPress={onDiscard}
          style={({pressed}) => [styles.action, pressed && styles.pressed]}
          testID="pending-discard">
          <Image source={SHELL_ICONS.x} style={styles.discardGlyph} />
        </Pressable>
      ) : null}
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    action: {padding: (TOUCH_TARGET - GLYPH) / 2},
    resendGlyph: {width: GLYPH, height: GLYPH, tintColor: color.textMuted},
    discardGlyph: {width: GLYPH, height: GLYPH, tintColor: color.danger},
    pressed: {opacity: 0.6},
  });
