import {statusBadgeGeometry} from '@momo/core/features/presence/statusBadge';
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
 * 웹은 얼굴을 점 둘레만큼 도려낸다(CSS 마스크). 폰은 도려내기가 기본 기능이 아니라(마스크는 새 의존) **면색 고리**를
 * 그대로 쓴다: 고리 두께 = 틈이고, 색 점의 바깥 끝이 얼굴 상자의 오른쪽 아래에 닿는다(웹의 점과 같은 자리). 폰의 점은
 * 정해진 면(홈 줄·대화 머리 알약·새 메시지 카드 = `surface`) 위에 서므로 면색 고리가 곧 틈으로 보인다. 눌린 줄처럼 면이
 * 잠깐 바뀌는 순간에만 고리가 면과 한 단 달라진다(인계에 적은 선택).
 *
 * 모양은 웹과 같다(글자가 곁에 없는 자리라 색만으로 말하지 않는다): 채운 원 = ok · 초승달 = warn · 가로 줄 = danger ·
 * 속 빈 고리 = muted. 초승달·가로 줄의 빈 곳은 면색이다(웹은 바탕이 비친다 — 폰의 바탕이 그 면이다).
 * 꺼짐(`muted`)은 속 빈 고리다: 면색 틈 안에 틈 굵기의 선(`textFaint`) 고리, 속은 면색. 고리의 선은 이제 아바타가 아니라
 * 면색 틈에 맞닿는다(#4725 M2: 아바타 색 위에서 3:1 미만이던 것). 부모는 얼굴 크기의 상자다.
 */
export function FaceStatusDot({
  face,
  tone,
  testID = 'status-dot',
}: {
  /** 얼굴 한 변(pt). */
  face: number;
  tone: StatusDotTone;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {dot, gap} = statusBadgeGeometry(face);
  const outer = dot + 2 * gap;
  // 바깥 원 = 틈(면색), 안의 원 = 표식. 표식이 시험이 읽는 자리(`testID`)다: 채움 색 · 꺼짐의 면 채움 + 선 색 둘레.
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.faceGap, {right: -gap, bottom: -gap, width: outer, height: outer}]}
      testID={`${testID}-gap`}>
      <View
        style={[
          styles.faceMark,
          styles[tone],
          {width: dot, height: dot, borderWidth: tone === 'muted' ? gap : 0},
        ]}
        testID={testID}>
        {tone === 'warn' ? (
          // 초승달: 왼쪽 위를 면색 원으로 덜어 낸다(웹 마스크와 같은 기하: 중심 25%·25%, 반지름 37.5%).
          <View
            style={[
              styles.faceCut,
              {left: -dot / 8, top: -dot / 8, width: (dot * 3) / 4, height: (dot * 3) / 4},
            ]}
            testID={`${testID}-moon`}
          />
        ) : tone === 'danger' ? (
          // 가로 줄: 틈 굵기의 면색 줄(웹과 같은 폭 = 점 - 틈×2).
          <View
            style={[styles.faceBar, {width: dot - 2 * gap, height: gap}]}
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
      backgroundColor: color.surface,
    },
    faceMark: {
      borderRadius: radius.pill,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    faceCut: {position: 'absolute', borderRadius: radius.pill, backgroundColor: color.surface},
    faceBar: {backgroundColor: color.surface},
  });
