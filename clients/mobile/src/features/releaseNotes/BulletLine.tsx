import React, {forwardRef} from 'react';
import {StyleSheet, View} from 'react-native';

import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {font, line, radius, space, type Palette} from '../../design/tokens';

// =============================================================================
// 업데이트 소식의 불릿 한 줄 (#5298, owner 11-04: 「테스크들을 불릿으로 구분해서」).
//
// 올라오는 시트의 항목 제목과 버전 상세의 「그 밖에 바뀐 점」 줄이 같은 부품을 쓴다(웹은 `ul`·`li` 마커).
//
// 점은 **글자(`•`)가 아니라 도형**이다. 글자는 서체가 폭과 위치를 정하고 줄의 가운데가 아니라 베이스라인에 서는데, 도형은 둘 다
// 우리 값이다(대화 목록의 불릿 `MessageBody` 가 같은 이유로 같은 모양이다). 점은 첫 줄의 가운데에 서고(칸 높이 = 본문 줄 높이),
// 글이 여러 줄로 접혀도 둘째 줄부터는 점 밑이 아니라 글 칸 안에서 이어진다(마커가 자기 칸을 갖는다). 점 칸에는 숫자를 새로
// 적지 않는다: 폭은 간격 스케일이고 모서리는 반경 스케일(`radius.pill`)의 이름이다.
//
// 줄 하나가 낭독 한 덩어리다(`accessible`): 점은 소리로 읽히지 않고, 줄 전체가 초점 한 번에 읽힌다. 「더보기」가 펼친 첫 줄이
// 이 줄의 `ref` 로 초점을 받는다. 글은 한국어 어절 우선 줄바꿈(`Sentence`)이다.
// =============================================================================

export const BulletLine = forwardRef<
  View,
  {
    children: string;
    testID?: string;
  }
>(function BulletLineView({children, testID}, ref): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View ref={ref} accessible style={styles.row} testID={testID}>
      <View importantForAccessibility="no" style={styles.cell}>
        <View style={styles.dot} testID="release-notes-bullet" />
      </View>
      <Sentence style={styles.text}>{children}</Sentence>
    </View>
  );
});

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'flex-start', gap: space.xs},
    cell: {
      width: space.md,
      height: line.body,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dot: {
      width: space.xs,
      height: space.xs,
      borderRadius: radius.pill,
      backgroundColor: color.textMuted,
    },
    // `flex: 1` 이 아니라 `flexShrink: 1` 이다: 글이 칸 폭 안에서 접히되 자기 몫을 0 에서 시작하지 않는다.
    text: {flexShrink: 1, fontSize: font.body, lineHeight: line.body, color: color.text},
  });
