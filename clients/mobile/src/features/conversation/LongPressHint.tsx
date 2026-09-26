import React, {useCallback, useEffect, useState} from 'react';
import {AccessibilityInfo, Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {ds2Radius, font, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
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

/**
 * 코치마크가 스스로 물러나기까지의 시간, ms. 문장 하나(열두 어절 남짓)를 두 번
 * 읽을 만큼이다.
 */
export const LONG_PRESS_HINT_MS = 6000;

// =============================================================================
// **상주하던 줄에서 첫 1회 코치마크로** (DS2-4 #2716, owner 피드백 표).
//
// 옛 판은 이 문장을 컴포저 위 한 줄로 **세워 두었다** — 길게 누르기를 한 번 쓰거나
// 「닫기」를 누를 때까지. owner 캡처에서 그 줄은 매일 여는 대화의 컴포저 위에 붙어
// 있었고(「메시지를 길게 누르면 답글·반응·고치기」 + 「닫기」), Buzz 에는 그런 줄이
// 없다. 그래서:
//
//   * **한 번만 뜬다.** 뜨는 순간 배운 것으로 적는다 — 다음 방문에는 없다.
//   * **스스로 물러난다**(`LONG_PRESS_HINT_MS`). 누르면 바로 닫힌다.
//   * **목록을 밀지 않는다.** 컴포저 위에 떠 있는 알약이라(절대 배치) 나타나고
//     사라질 때 대화가 움직이지 않는다.
//
// 가르치는 내용과 판정(`useLongPressHint`)은 그대로다 — 바뀐 것은 머무는 시간과
// 자리뿐이다. 그 밖의 신호(반응 칩, 「답글 N개」, 눌린 행의 배경)도 그대로다.
// =============================================================================

export function LongPressHint({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 화면을 보지 않는 사람에게는 **말하고, 스스로 닫지 않는다**(DS2-4 검수 M-5,
    // WCAG 2.2.1). 초점이 닿기 전에 사라지는 안내는 안내가 아니다 — 누르거나 길게
    // 누르기를 한 번 쓰면 닫힌다.
    AccessibilityInfo.isScreenReaderEnabled().then(
      reader => {
        if (!alive) return;
        if (reader) {
          AccessibilityInfo.announceForAccessibility(HINT);
        } else {
          timer = setTimeout(onDismiss, LONG_PRESS_HINT_MS);
        }
      },
      () => {
        if (alive) timer = setTimeout(onDismiss, LONG_PRESS_HINT_MS);
      },
    );
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [visible, onDismiss]);
  if (!visible) return null;
  return (
    <View style={styles.anchor} pointerEvents="box-none" testID="long-press-hint">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${HINT}. 안내 닫기`}
        onPress={onDismiss}
        style={({pressed}) => [styles.coach, pressed && styles.pressed]}
        testID="long-press-hint-dismiss">
        <Text style={styles.text}>{HINT}</Text>
        <Image
          source={CONV_ICONS.cross}
          style={[styles.close, {tintColor: palette.onPrimary}]}
        />
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

  // 뜨는 순간 배운 것으로 적는다 — 코치마크는 **첫 1회**다(위 절). 이 방문 동안은
  // 타이머나 손이 닫을 때까지 서 있고, 다음 방문에는 없다.
  useEffect(() => {
    if (visible) rememberLongPressLearned();
  }, [visible]);

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
  /** 도크 위에 뜨는 자리. 도크의 세로를 한 픽셀도 밀지 않는다. */
  anchor: {
    position: 'absolute',
    left: SAFE_GUTTER,
    right: SAFE_GUTTER,
    bottom: '100%',
    alignItems: 'center',
    paddingBottom: space.sm,
    zIndex: 2,
  },
  /** 잉크 알약 — 시안 `.a-pill.pri` 의 색. 떠 있는 것이 무엇인지 한눈에 다르다. */
  coach: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.lg,
    borderRadius: ds2Radius.pill,
    backgroundColor: color.primary,
    boxShadow: color.elevationFloat,
  },
  text: {flexShrink: 1, fontSize: font.label, color: color.onPrimary, fontWeight: '600'},
  close: {width: CONV_ICON_SIZE.cross, height: CONV_ICON_SIZE.cross},
  pressed: {opacity: 0.8},
});
