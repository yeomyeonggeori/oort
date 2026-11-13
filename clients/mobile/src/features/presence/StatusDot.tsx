import {
  statusBadgeGeometry,
  statusBadgeShape,
  type StatusBadgeSubject,
} from '@momo/core/features/presence/statusBadge';
import type {StatusDotTone} from '@momo/core/features/presence/statusDot';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {radius, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';

// =============================================================================
// 상태 점 — 폰 (#3964). 점의 **톤**(어떤 상태가 어떤 색 역할인가)은 웹과 같은 core
// (`@momo/core/features/presence/statusDot`)가 정하고, 이 파일은 그 톤을 폰의 팔레트 토큰에 매긴다 -
// `presence/model.ts` 머리말의 분업이다(웹은 Tailwind 클래스, 폰은 토큰 객체).
//
//   ok → `ok` · warn → `warn` · danger → `danger` · muted → **속이 빈 고리**(`textFaint` 선 + 면 채움)
//
// Buzz식(소유자 결정 2026-10-17 「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」): 낱말이 곁에 없는 자리라 모양이 말한다 -
// 채운 초록 = 살아 있음(응답함·살아 있음·대기), 속 빈 회색 고리 = 꺼짐(조용함·꺼짐). 살아 있음과 꺼짐이 한 점이면 점이
// 「꺼져 있다는 거야?」에 답하지 못한다(design-review #3964 H1). 웹과 같은 이유·같은 표다. 선은 `textFaint`(컨트롤
// 테두리 3:1 자리)라 면 위에서 보인다. 둘레의 면색 고리(`surface`)는 점이 아바타에서 떨어져 보이게 하는 것이고, 웹
// `border-surface` 와 같다.
//
// 보조기술에는 나가지 않는다: 행은 접근성 원소 하나이고 그 라벨이 상태를 말한다(`Row`).
// =============================================================================

/** 글자 곁 점(칩·맥 줄)의 바깥 지름(pt). 얼굴 모서리 점은 `FaceStatusDot` 이 얼굴 크기에서 정한다. */
export const STATUS_DOT_SIZE = 10;
/** 글자 곁 점의 둘레 고리 두께(pt). 채운 점은 면색 고리, 속 빈 점은 선 색 고리다. */
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

/**
 * 얼굴 모서리에 앉는 점 (#5786, owner 2026-11-13 QA 15). 크기는 웹과 같은 코어 한 함수(`statusBadgeGeometry`: 얼굴 한 변 →
 * 점 지름 ≈ 38%·틈)가 정한다 — 28pt 얼굴에 점 10 · 틈 2, 32pt 얼굴에 점 12 · 틈 2. 예전에는 얼굴 크기와 무관하게 바깥
 * 10pt(색 점 7pt, 25~36%)였다.
 *
 * 웹은 얼굴을 점 둘레만큼 도려낸다(CSS 마스크). 폰은 도려내기가 기본 기능이 아니라(마스크는 새 의존) **고리**를 쓴다:
 * 고리 두께 = 틈이고, 색 점의 바깥 끝이 얼굴 상자의 오른쪽 아래에 닿는다(웹의 점과 같은 자리). 고리의 색은 **얼굴이 서는
 * 바탕**(`ground`)이다 — 그래야 고리가 테가 아니라 틈으로 보인다. 대화 머리 알약·새 메시지 카드는 면(`surface`, 기본값)
 * 위이고, 홈 줄은 면이 아니라 바닥(`bg`) 위라서 홈 줄이 바닥 색을 넘긴다(눌린 줄은 눌림 면). design-review r1 M3: 밝게 홈
 * 목록에서 면색 고리(255,254,252)가 바닥(239,237,234) 위에 흰 테로 보였다. 바닥은 세로 그라데이션이라 가운데 정지점(`bg`)과
 * 위·아래 끝은 1.04:1 안쪽으로 다르다. 사용자 배경화면(사진) 위에서는 고리 색이 사진과 맞을 수 없다(인계에 적은 한계).
 *
 * 모양은 웹과 같은 코어 판정(`statusBadgeShape`, 뜻으로 고른다)이다: 사람은 채운 원 = 온라인 · 초승달 = 자리 비움 · 가로 줄 =
 * 방해 금지 · 속 빈 고리 = 오프라인, 에이전트는 채운 원 = 살아 있음·경고(채운 주황) · 속 빈 고리 = 꺼짐. 초승달·가로 줄·고리
 * 속의 빈 곳도 바탕색이다(웹은 바탕이 비친다). 꺼짐 고리의 선은 `textFaint` 다(#4725 M2: 아바타 색 위에서 3:1 미만이던
 * 것이 이제 틈에 맞닿는다). 부모는 얼굴 크기의 상자다.
 */
export function FaceStatusDot({
  face,
  tone,
  subject = 'human',
  ground,
  testID = 'status-dot',
}: {
  /** 얼굴 한 변(pt). */
  face: number;
  tone: StatusDotTone;
  /** 누구의 상태인가 — 같은 톤이라도 모양(뜻)이 다르다(에이전트 경고 = 채운 원, r1 H2). */
  subject?: StatusBadgeSubject;
  /** 얼굴이 서는 바탕 색. 고리(틈)와 모양의 빈 곳이 이 색이다. 기본은 면(`surface`). */
  ground?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const fill = ground ?? palette.surface;
  const {dot, gap} = statusBadgeGeometry(face);
  const shape = statusBadgeShape(tone, subject);
  const outer = dot + 2 * gap;
  // 바깥 원 = 틈(바탕색), 안의 원 = 표식. 표식이 시험이 읽는 자리(`testID`)다: 채움 색 · 꺼짐의 바탕 채움 + 선 색 둘레.
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.faceGap, {right: -gap, bottom: -gap, width: outer, height: outer, backgroundColor: fill}]}
      testID={`${testID}-gap`}>
      <View
        style={[
          styles.faceMark,
          styles[tone],
          shape === 'ring' && {backgroundColor: fill},
          {width: dot, height: dot, borderWidth: shape === 'ring' ? gap : 0},
        ]}
        testID={testID}>
        {shape === 'moon' ? (
          // 초승달: 왼쪽 위를 바탕색 원으로 덜어 낸다(웹 마스크와 같은 기하: 중심 25%·25%, 반지름 37.5%).
          <View
            style={[
              styles.faceCut,
              {left: -dot / 8, top: -dot / 8, width: (dot * 3) / 4, height: (dot * 3) / 4, backgroundColor: fill},
            ]}
            testID={`${testID}-moon`}
          />
        ) : shape === 'bar' ? (
          // 가로 줄: 틈 굵기의 바탕색 줄(웹과 같은 폭 = 점 - 틈×2).
          <View
            style={[styles.faceBar, {width: dot - 2 * gap, height: gap, backgroundColor: fill}]}
            testID={`${testID}-bar`}
          />
        ) : null}
      </View>
    </View>
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
    muted: {backgroundColor: color.surface, borderColor: color.textFaint},
    faceGap: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    faceMark: {
      borderRadius: radius.pill,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    faceCut: {position: 'absolute', borderRadius: radius.pill},
    faceBar: {},
  });
