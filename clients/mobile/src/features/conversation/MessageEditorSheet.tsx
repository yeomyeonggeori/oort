import React, {useCallback, useRef, useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';
import {useKeyboard} from '../../lib/useKeyboard';

// =============================================================================
// 메시지 고치기.
//
// ## `value` 는 동기다 — 이 파일에도 예외가 없다
//
// `Composer` 의 헤더가 적어 둔 실측이 여기에도 그대로 적용된다(스파이크 #837
// gate 1, 성재의 iPhone 17). 값을 한 틱 늦게 쓰면 iOS 의 조합 세션이 끊겨
// `안녕하세요` 가 `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` 로 적힌다. 그래서 `onChangeText`
// 는 `setText` 하나만 하고, 그 사이에 큐도 디바운스도 네트워크도 없다.
//
// 이 화면이 특히 위험한 자리인 이유가 있다: 고치기는 **이미 한국어로 적혀 있는
// 문장**을 여는 일이라, 조합이 깨지면 사용자는 자기가 쓴 글이 망가지는 것을 본다.
// 새로 쓰다 깨지는 것보다 나쁘다.
//
// ## 왜 행 안이 아니라 시트인가
//
// 웹은 행을 그 자리에서 편집기로 바꾼다. 여기서 같은 것을 하면 편집기가
// **가상 목록의 행 안에서** 자라야 하고, 그 행 높이 변화는 `Timeline` 이 0px 로
// 증명해 둔 위치 보존과 같은 축에서 다툰다. 게다가 키보드가 올라오면 그 행이
// 키보드 뒤로 들어가는 것을 막기 위해 리스트를 스크롤해야 하는데, 그것이 바로
// 이 제품이 측정으로 없앤 "읽던 자리가 움직인다" 이다.
//
// 시트는 그 문제를 통째로 없앤다: 편집기는 리스트 밖에 있고, 키보드는
// `ConversationLayout` 과 같은 방식(하단 인셋 = 키보드 높이)으로 피한다.
// 원문이 위에 그대로 보이므로 무엇을 고치는 중인지도 잃지 않는다.
//
// ## 자라는 입력창 (웹 R2 M4)
//
// 웹 1라운드는 `rows={2}` 로 고정해 두었고, 리뷰는 "수정이 두 줄짜리 창구를
// 스크롤하는 일이 됐다"고 적었다. 여기서는 `minHeight`~`maxHeight` 사이에서
// 자라고, 그 위로는 내부 스크롤이 받는다.
// =============================================================================

/** 두 줄 어림. 한 줄짜리 창구로 문단을 고치게 하지 않는다. */
const MIN_HEIGHT = 68;
/** 여덟 줄 어림. 그 위로는 스스로 스크롤한다. */
const MAX_HEIGHT = 176;

export function MessageEditorSheet({
  initialBody,
  pending,
  error,
  onCancel,
  onSave,
}: {
  initialBody: string;
  pending?: boolean;
  /** 이미 한국어 문장으로 옮겨진 실패 사유(`actionCopy`). 와이어 문자열 아님. */
  error?: string | null;
  onCancel: () => void;
  onSave: (body: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 동기. 헤더 참조.
  const [text, setText] = useState(initialBody);
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboard();
  const inputRef = useRef<TextInput | null>(null);

  const onChangeText = useCallback((next: string) => setText(next), []);

  const trimmed = text.trim();
  // 빈 본문은 서버가 400 으로 거절한다. 보내기 전에 막는 편이, 거절을 한국어로
  // 옮겨 보여 주는 것보다 낫다 — 코어 `actionCopy` 의 400 문구가 tombstone 쪽을
  // 말하는 것도 그래서다("빈 본문은 요청 전에 잡힌다").
  const canSave = trimmed !== '' && trimmed !== initialBody.trim() && !pending;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      testID="message-editor">
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel="고치기 취소"
          onPress={onCancel}
          testID="editor-backdrop"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              paddingBottom: keyboard.visible
                ? keyboard.height + space.md
                : Math.max(insets.bottom, space.md),
            },
          ]}>
          <Text style={styles.title}>메시지 고치기</Text>

          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={onChangeText}
            multiline
            // 컴포저와 같은 규칙 (#1422 design-review M2). 이 상자에 담기는 것은
            // 방금 보낸 한국어 문장이라 낱말 가운데서 끊기면 안 되는 이유가
            // 그쪽과 똑같다 — `design/atoms.tsx` 의 `Sentence` 가 든 그 값이고,
            // `conversationHygiene.test.tsx` 의 스윕이 이 클라의 여러 줄 입력창을
            // 전수로 센다.
            lineBreakStrategyIOS="hangul-word"
            autoFocus
            blurOnSubmit={false}
            textAlignVertical="top"
            accessibilityLabel="고칠 메시지 내용"
            placeholder="메시지 내용"
            placeholderTextColor={palette.textFaint}
            testID="editor-input"
          />

          {error ? (
            <View style={styles.failure} testID="editor-error">
              <Text style={styles.failureText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="취소"
              onPress={onCancel}
              style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
              testID="editor-cancel">
              <Text style={styles.secondaryLabel}>취소</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="저장"
              accessibilityState={{disabled: !canSave, busy: pending}}
              disabled={!canSave}
              onPress={() => onSave(trimmed)}
              style={({pressed}) => [
                styles.primary,
                !canSave && styles.primaryDisabled,
                pressed && canSave && styles.pressed,
              ]}
              testID="editor-save">
              <Text
                style={[styles.primaryLabel, !canSave && styles.primaryLabelDisabled]}>
                {pending ? '저장 중…' : '저장'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  root: {flex: 1, justifyContent: 'flex-end'},
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.scrim,
  },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.md,
    gap: space.sm,
  },
  title: {fontSize: font.label, color: color.text, fontWeight: '700'},
  input: {
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bg,
    // 16 미만이면 포커스 때 iOS 가 화면을 확대한다.
    fontSize: font.body,
    color: color.text,
    lineHeight: 21,
  },
  row: {flexDirection: 'row', gap: space.sm},
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
  primary: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: color.accent,
  },
  primaryDisabled: {backgroundColor: color.border},
  primaryLabel: {fontSize: font.label, color: color.onAccent, fontWeight: '700'},
  primaryLabelDisabled: {color: color.textFaint},
  failure: {
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.dangerSurface,
    borderWidth: 1,
    borderColor: color.dangerBorder,
  },
  failureText: {color: color.dangerText, fontSize: font.label, lineHeight: 20},
  pressed: {opacity: 0.6},
});
