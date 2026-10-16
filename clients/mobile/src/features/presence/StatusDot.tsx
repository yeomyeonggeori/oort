import type {StatusDotTone} from '@momo/core/features/presence/statusDot';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {radius, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// 상태 점 — 폰 (#3964). 점의 **톤**(어떤 상태가 어떤 색 역할인가)은 웹과 같은 core
// (`@momo/core/features/presence/statusDot`)가 정하고, 이 파일은 그 톤을 폰의 팔레트 토큰에 매긴다 -
// `presence/model.ts` 머리말의 분업이다(웹은 Tailwind 클래스, 폰은 토큰 객체).
//
//   ok → `ok` · warn → `warn` · danger → `danger` · idle → **채운 회색**(`textFaint`) · muted → **속이 빈 고리**
//   (`textFaint` 선 + 면 채움)
//
// 낱말이 곁에 없는 자리라 모양이 말한다: 채운 점 = 신호가 오고 있다(응답함·살아 있음), 속 빈 고리 = 응답을 기대하기
// 어렵다(조용함·꺼짐). 살아 있지만 일이 없는 에이전트(idle)와 꺼진 에이전트(muted)가 한 점이면 점이 「꺼져 있다는
// 거야?」에 답하지 못한다(design-review #3964 H1). 웹과 같은 이유·같은 표다. 선은 `textFaint`(컨트롤 테두리 3:1
// 자리)라 면 위에서 보인다. 둘레의 면색 고리(`surface`)는 점이 아바타에서 떨어져 보이게 하는 것이고, 웹 `border-surface`
// 와 같다.
//
// 보조기술에는 나가지 않는다: 행은 접근성 원소 하나이고 그 라벨이 상태를 말한다(`Row`).
// =============================================================================

/** 점의 바깥 지름(pt). 28pt 아바타 모서리에 앉는다. */
export const STATUS_DOT_SIZE = 10;
/** 둘레 고리의 두께(pt). 채운 점은 면색 고리, 속 빈 점은 선 색 고리다. */
export const STATUS_DOT_RING = 1.5;

export function StatusDot({
  tone,
  testID = 'status-dot',
}: {
  tone: StatusDotTone;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, styles[tone]]}
      testID={testID}
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    dot: {
      width: STATUS_DOT_SIZE,
      height: STATUS_DOT_SIZE,
      borderRadius: radius.pill,
      borderWidth: STATUS_DOT_RING,
      borderColor: color.surface,
    },
    ok: {backgroundColor: color.ok},
    warn: {backgroundColor: color.warn},
    danger: {backgroundColor: color.danger},
    idle: {backgroundColor: color.textFaint},
    muted: {backgroundColor: color.surface, borderColor: color.textFaint},
  });
