import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {font, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 폰에서 액션이 있다는 것을 말해 주는 한 줄.
//
// **문제.** 이 화면의 액션 진입점은 길게 누르기 하나이고, 제스처는 보이지 않는다.
// 웹은 정확히 이 지점에서 "폰에 가시적 진입점 0개"라는 지적을 받았다(B11 R2 H4)
// — 웹의 액션 열은 hover 가 있는 기기에만 있었고, 반응이 없는 메시지에는 칩 줄도
// 없어서 "여기서 무언가 할 수 있다"고 말하는 것이 화면에 하나도 없었다.
//
// **왜 행마다 버튼을 두지 않는가.** 손가락 타깃은 44px 이다. 한 줄짜리 메시지가
// 그보다 낮은 목록에서 행마다 44px 컨트롤을 얹으면 한 화면에 들어가는 메시지
// 수가 눈에 띄게 줄고, 줄어든 자리를 스무 번 반복되는 ⋯ 가 가져간다. 밀도는 이
// 제품이 가진 것 중 하나다.
//
// **그래서 한 번만 말한다.** 컴포저 위 한 줄. 길게 누르기를 한 번 쓰면 그 줄은
// 스스로 사라지고 다시 오지 않는다 — 배운 사람에게 계속 가르치지 않는 것이
// 「과설명 금지」의 실무적인 뜻이다. 직접 닫아도 같다.
//
// 그리고 이것이 유일한 신호도 아니다: 반응 칩과 「답글 N개」는 항상 보이고 누를
// 수 있으며, 행은 눌리면 배경이 바뀐다. 이 줄은 그 셋이 아직 하나도 없는 채널
// (반응도 답글도 없는 새 채널)을 위한 것이다.
// =============================================================================

const HINT = '메시지를 길게 누르면 답글·반응·고치기';

/** Has the gesture been used before? Read once, synchronously, at mount. */
export function longPressLearned(): boolean {
  try {
    return nonSecretStore().getString(NON_SECRET_KEYS.longPressLearned) === '1';
  } catch {
    // The store is a native module; a harness without it must not take the
    // conversation screen down over a hint.
    return false;
  }
}

export function rememberLongPressLearned(): void {
  try {
    nonSecretStore().set(NON_SECRET_KEYS.longPressLearned, '1');
  } catch {
    /* the hint shows once more next launch, which is the harmless direction */
  }
}

export function LongPressHint({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (!visible) return null;
  return (
    <View style={styles.root} testID="long-press-hint">
      <Text style={styles.text}>{HINT}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="안내 닫기"
        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
        onPress={onDismiss}
        style={({pressed}) => [styles.dismiss, pressed && styles.pressed]}
        testID="long-press-hint-dismiss">
        <Text style={styles.dismissLabel}>닫기</Text>
      </Pressable>
    </View>
  );
}

/** The hint's whole lifecycle, so a screen wires one hook instead of three. */
export function useLongPressHint(): {
  visible: boolean;
  dismiss: () => void;
  markUsed: () => void;
} {
  const [visible, setVisible] = useState(() => !longPressLearned());

  const dismiss = useCallback(() => {
    setVisible(false);
    rememberLongPressLearned();
  }, []);

  const markUsed = useCallback(() => {
    // Called every time the sheet opens; the write is idempotent and the state
    // update is a no-op once it is already false.
    setVisible(false);
    rememberLongPressLearned();
  }, []);

  return {visible, dismiss, markUsed};
}

const buildStyles = (color: Palette) => StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.xs,
    minHeight: TOUCH_TARGET - space.md,
  },
  text: {flex: 1, fontSize: font.meta, color: color.textFaint},
  dismiss: {justifyContent: 'center'},
  dismissLabel: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  pressed: {opacity: 0.6},
});
