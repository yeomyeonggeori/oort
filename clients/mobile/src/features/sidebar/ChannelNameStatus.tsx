import React, {useRef, useState} from 'react';
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  type TextLayoutEventData,
  View,
} from 'react-native';
import {useStyles} from '../../design/theme';
import {font, space, type Palette} from '../../design/tokens';

// =============================================================================
// 이름 칸 아래 한 줄 (ADR-0225 D13, #5835) — 이름 바꾸기 단계의 칸 부품. 웹 `ChannelNameField` 의 `NameStatus` 와 같은 약속이다:
// 거절 문장 · 저장될 이름 · 안내 가운데 **하나만** 선다. 서지 않은 문장들이 같은 폭으로 보이지 않게 깔려 가장 큰 높이가 자리의 최소
// 높이가 된다(줄이 서고 걷혀도 아래 요소와 머리 단추가 움직이지 않는다). 실제로 화면이 꺾은 높이·줄 수를 읽고(어림하지 않는다),
// 미리보기는 예약된 줄 수 안에서 접는다.
//
// 새 채널 시트(#5834)의 지역 `NameStatus` 와 같은 구현이다: 그 시트가 이 가지에 아직 들어오지 않아 한 벌 더 두었고, 합치는 것은
// #5834 착륙 뒤의 후속이다(인계 「planner가 정할 것」).
// =============================================================================

export function ChannelNameStatus({
  error,
  preview,
  hint,
  reserve,
  testIDPrefix,
}: {
  error: string | null;
  preview: string | null;
  hint: string;
  /** 이 자리에 설 수 있는 모든 문장(안내 · 거절 · 서버 응답). 높이만 정하고 보이지 않는다. */
  reserve: readonly string[];
  testIDPrefix: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const heights = useRef<Record<number, number>>({});
  const lineCounts = useRef<Record<number, number>>({});
  const [reserved, setReserved] = useState(0);
  const [lines, setLines] = useState<number | undefined>(undefined);
  const onReserveLayout = (index: number) => (event: LayoutChangeEvent) => {
    heights.current[index] = event.nativeEvent.layout.height;
    const tallest = Math.max(0, ...Object.values(heights.current));
    setReserved(prev => (prev === tallest ? prev : tallest));
  };
  const onReserveText = (index: number) => (event: NativeSyntheticEvent<TextLayoutEventData>) => {
    lineCounts.current[index] = event.nativeEvent.lines.length;
    const most = Math.max(1, ...Object.values(lineCounts.current));
    setLines(prev => (prev === most ? prev : most));
  };
  const shown = error ?? preview ?? hint;
  const kind = error !== null ? 'issue' : preview !== null ? 'preview' : 'rule';
  return (
    <View>
      <Text
        accessibilityLiveRegion={kind === 'issue' ? 'polite' : 'none'}
        style={[kind === 'issue' ? styles.issue : styles.rule, reserved > 0 && {minHeight: reserved}]}
        lineBreakStrategyIOS="hangul-word"
        numberOfLines={kind === 'preview' ? lines : undefined}
        testID={`${testIDPrefix}-${kind}`}>
        {shown}
      </Text>
      {reserve.map((candidate, index) => (
        <Text
          key={index}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          onLayout={onReserveLayout(index)}
          onTextLayout={onReserveText(index)}
          style={[styles.rule, styles.reserveCopy]}
          lineBreakStrategyIOS="hangul-word"
          testID={`${testIDPrefix}-reserve-${index}`}>
          {candidate}
        </Text>
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    rule: {paddingHorizontal: space.xs, fontSize: font.label, color: color.textMuted},
    issue: {paddingHorizontal: space.xs, fontSize: font.label, color: color.dangerText},
    // 높이만 재는 숨은 사본 — 같은 폭의 겹친 층이라 레이아웃 높이를 더하지 않는다.
    reserveCopy: {position: 'absolute', top: 0, left: 0, right: 0, opacity: 0},
  });
