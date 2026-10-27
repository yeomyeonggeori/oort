import React, {useCallback, useRef, useState} from 'react';
import {StyleSheet, Text, TextInput} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {SheetScroll} from '../../design/sheetParts';
import {font, ds2Radius, space, type Palette} from '../../design/tokens';
import {useKeyboardAppearance, usePalette, useStyles} from '../../design/theme';

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
//
// ## 공용 시트로 (#4458)
//
// 그릇은 `PageSheet`(중간 단 — 입력이 있는 짧은 시트의 표준 모양)이고, 키보드는 그릇이 피한다(시트의 바닥이 키보드
// 윗면에 앉는다). 머리는 `SheetHeader`: **왼쪽 ✓ = 저장**(바뀐 것이 없거나 비면 회색·눌리지 않음, 저장하는 동안도
// 잠긴다), **오른쪽 원형 X = 고치기 취소**. 옛 「취소」「저장」 글자 단추 행은 없다 — 스크림·끌어내리기·VoiceOver escape 와
// X 는 모두 같은 슬라이드로 `onCancel` 을 부른다. 입력은 여러 줄이라 한 줄 알약(`InputPill`)이 아니라 입력 상자다
// (같은 외곽선 `textFaint` 3:1 · 입력 반경). 값은 여전히 동기다: `onChangeText` 는 `setText` 하나뿐이다.
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
  const keyboardAppearance = useKeyboardAppearance();
  // 동기. 헤더 참조.
  const [text, setText] = useState(initialBody);
  const inputRef = useRef<TextInput | null>(null);

  const onChangeText = useCallback((next: string) => setText(next), []);

  const trimmed = text.trim();
  // 빈 본문은 서버가 400 으로 거절한다. 보내기 전에 막는 편이, 거절을 한국어로
  // 옮겨 보여 주는 것보다 낫다 — 코어 `actionCopy` 의 400 문구가 tombstone 쪽을
  // 말하는 것도 그래서다("빈 본문은 요청 전에 잡힌다").
  const changed = trimmed !== initialBody.trim();
  const canSave = trimmed !== '' && changed && !pending;
  // 저장 안 한 입력(#4612): 원문과 다르게 고쳐 둔 채다(전부 지운 것도 고친 것이다). 끌기·X·스크림·escape 가 그냥 닫으면 쓴 글이
  // 사라지므로 시트가 「버릴까요?」를 먼저 묻는다(iOS `isModalInPresentation` 시트와 같다). 저장하는 동안(`pending`)은 이미 보내는
  // 중이라 묻지 않는다 — 「저장하지 않은 내용」이 아니다.
  const dirty = changed && !pending;

  return (
    <PageSheet
      height="medium"
      dirty={dirty}
      onClose={onCancel}
      accessibilityLabel="메시지 고치기"
      scrimLabel="고치기 취소"
      scrimTestID="editor-backdrop"
      testID="message-editor">
      <SheetHeader
        title="메시지 고치기"
        closeLabel="메시지 고치기 닫기"
        closeTestID="editor-cancel"
        confirm={{
          label: pending ? '저장 중' : '저장',
          onPress: () => onSave(trimmed),
          disabled: !canSave,
          busy: pending,
          testID: 'editor-save',
        }}
      />
      <SheetScroll>
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
          submitBehavior="newline"
          textAlignVertical="top"
          accessibilityLabel="고칠 메시지 내용"
          placeholder="메시지 내용"
          placeholderTextColor={palette.textFaint}
          keyboardAppearance={keyboardAppearance}
          testID="editor-input"
        />

        {pending ? (
          // ✓ 자리의 스피너가 진행을 말하고(`busy`), 이 한 줄은 키보드 위에서 글을 보는 눈에 같은 말을 한 번 더 한다. `accessibilityLiveRegion` 은
          // Android 에서만 읽힌다 — iOS VoiceOver 는 ✓ 의 `busy` 상태와 이름(「저장 중」)이 말한다(실제 낭독은 runtime-unverified, design-review r1b M5).
          <Text accessibilityLiveRegion="polite" style={styles.pending} testID="editor-pending">
            저장 중
          </Text>
        ) : null}

        {error ? (
          <Sentence accessibilityRole="alert" style={styles.failure} testID="editor-error">
            {error}
          </Sentence>
        ) : null}
      </SheetScroll>
    </PageSheet>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  // 입력 그릇만 선을 든다(ADR-0189 D6): `textFaint` 3:1. 채움은 없다 — 시트 바탕 위에 직접 선다(`InputPill` 과 같다).
  input: {
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: ds2Radius.row,
    borderWidth: 1,
    borderColor: color.textFaint,
    // 16 미만이면 포커스 때 iOS 가 화면을 확대한다.
    fontSize: font.body,
    color: color.text,
    lineHeight: 21,
  },
  pending: {fontSize: font.label, color: color.textMuted},
  failure: {color: color.dangerText, fontSize: font.label, lineHeight: 20},
});
