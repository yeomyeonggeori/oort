import {DIVIDER_SPACE} from '@momo/core/features/timeline/divider';
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, type Palette} from '../../design/tokens';

// =============================================================================
// 시스템 줄 (#5067, design-review M3) — 방에 알리는 한 줄을 **누가 한 말처럼 그리지 않는다**.
//
// 서버는 사람이 에이전트 실행을 멈추면 `type: system`·`props.kind = agent_run_cancelled` 줄을 남기고(`routes/agent_runs.rs`),
// 작성자는 멈춘 사람이다. 에이전트도 사람도 한 말이 아니라 방에 알리는 줄인데, 일반 행으로 그리면 멈춘 사람의 말풍선이 되어
// 「내가 쓴 글」처럼 붙었다. 이 부품은 **말풍선도 아바타도 이름도 시각도 없는** 가운데의 조용한 글줄이다 — 날짜·안 읽음·복구
// 표지가 서는 같은 자리(`DIVIDER_SPACE.marker` 위아래 여백)에서 `textMuted` 로 말한다.
//
// 문장은 **서버가 준 본문 그대로**다. 낱말을 이 부품이 고쳐 쓰지 않는다 — 서버 문장의 「중지」와 단추·영수증의 「중단」이
// 갈리는 것은 엔진 몫이다(인계에 적는다). 누를 것도 아니다: 답글·반응·메뉴의 대상이 아니다(`replyTarget` 이 이미 시스템 행을 뺀다).
//
// 큰 글씨: 배율을 막지 않고 줄은 어절 단위로 넘어간다(`Sentence`) — 한 문장이 두 줄이 되어도 가운데에 선다.
// =============================================================================

export function SystemLine({text}: {text: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.row} testID="system-line">
      <Sentence style={styles.text} testID="system-line-text">
        {text}
      </Sentence>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      alignItems: 'center',
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: DIVIDER_SPACE.marker.blockStart,
      paddingBottom: DIVIDER_SPACE.marker.blockEnd,
    },
    // `textFaint` 는 배경 대비 3.56:1 로 본문 AA 미달이다 — 조용하되 읽혀야 하므로 `textMuted`.
    text: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      textAlign: 'center',
    },
  });
