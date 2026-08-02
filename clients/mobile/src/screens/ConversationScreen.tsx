import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Screen, ScreenHeader} from '../design/atoms';
import {color, font, SAFE_GUTTER, space} from '../design/tokens';

// =============================================================================
// ███  PLACEHOLDER — THE NEXT BATCH REPLACES THIS FILE IN ITS ENTIRETY.  ███
//
// goal RN-C3 (this batch) owns the shell in front of a conversation: 인증,
// 사이드바, 인박스. The conversation itself — 타임라인 + 컴포저, ≈2,967 lines of
// the v0 UI — is the NEXT batch, and nothing in here is meant to survive it.
//
// **Do not build on this file.** It holds no message state, subscribes to no
// realtime channel, and reads no timeline. It exists so that "탭하면 어디로 가는
//가" is a real answer in this batch instead of a dead row, and so the next batch
// inherits a navigation seam that already works rather than one that has to be
// invented alongside the list.
//
// The seam the next batch should keep is exactly the props below: a `channelId`
// and an already-resolved `title`. The title is resolved by the caller (through
// `@momo/core/features/workspace/directory`, which needs the roster and the
// ambiguity index) rather than here, so the header does not flicker from
// "다이렉트 메시지" to a name when the roster query refetches.
//
// Two constraints that will still be true when the real screen lands, recorded
// here because they were paid for in real-device time (#837):
//
//   * the message list is FORWARD. A reversed list moved a scrolled-back
//     reader's position by 46–91px on a physical iPhone; forward measured 0px.
//     `__tests__/projectShape.test.ts` fails the build if that word appears
//     anywhere under `src/`.
//   * the composer's `value` must be updated SYNCHRONOUSLY. One
//     `setTimeout(…, 0)` between a keystroke and the rendered value severed the
//     iOS IME's composition state and stopped Korean jamo combining entirely.
// =============================================================================

export default function ConversationScreen({
  channelId,
  title,
  onBack,
}: {
  channelId: string;
  title: string;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <Screen>
      <ScreenHeader title={title} onBack={onBack} titleTestID="conversation-title" />
      <View style={styles.body} testID="conversation-placeholder">
        <Text style={styles.headline}>대화 화면은 다음 배치입니다.</Text>
        <Text style={styles.detail}>
          메시지 타임라인과 입력창은 아직 이 앱에 없습니다. 지금 이 대화를 읽고
          쓰려면 데스크톱 앱을 사용하세요.
        </Text>
        {/* Rendered because this screen is reached from two different lists and
            the one thing worth confirming while the timeline does not exist is
            that the tap resolved to the channel it claimed to. */}
        <Text style={styles.id} selectable>
          채널 {channelId}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.xl,
    gap: space.md,
  },
  headline: {fontSize: font.body, color: color.text, fontWeight: '600'},
  detail: {fontSize: font.label, color: color.textMuted, lineHeight: 20},
  id: {fontSize: font.meta, color: color.textFaint},
});
