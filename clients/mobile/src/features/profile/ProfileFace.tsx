import {AVATAR_SIZE} from '@momo/core/features/workspace/avatar';
import type {StyleProp, ViewStyle} from 'react-native';
import {StyleSheet} from 'react-native';

import {useStyles} from '../../design/theme';
import {radius, type Palette} from '../../design/tokens';

// =============================================================================
// 설정 페이지의 큰 얼굴 (#4457).
//
// 설정 본 페이지의 머리와 프로필 사진 장의 미리보기가 **같은 크기·같은 링**으로 서야 한다 — 한 개념이 상수 둘·스타일 둘이던
// 때(96 · 링은 한쪽만)는 사진 장의 얼굴이 맨몸이라 다크에서 바탕과 1.04:1 로 사라졌다(design-review r1 M3).
// =============================================================================

/**
 * 큰 얼굴의 한 변(pt). Buzz 설정 페이지의 사진 얼굴은 화면 폭의 ≈32%(≈125pt)이고 우리는 112 로 한 단 줄였다 —
 * SE(375pt)에서도 머리 아래 카드가 한 화면에 이어지게 한다.
 */
export const PROFILE_FACE = 112;

/**
 * 에이전트(둥근 사각)의 큰 얼굴 모서리 반경. 작은 얼굴의 비율(`radius.md` 8 ÷ `AVATAR_SIZE` 32 = 1/4)을 그대로 키운다 — 8 을 그대로 두면
 * 112 의 사각이 모서리만 살짝 깎인 정사각으로 읽힌다(다른 사람 프로필 시트, #4319). 가장자리 링(`useFaceRing`)은 이 값에 링 두께만큼 더한다.
 */
export const PROFILE_FACE_SQUARE_RADIUS = Math.round((PROFILE_FACE * radius.md) / AVATAR_SIZE);

/** 가장자리 링의 두께(pt). 링은 얼굴 **바깥**에 서므로 사각 얼굴의 링 반경은 얼굴 반경 + 이 값이다. */
const FACE_RING_WIDTH = 1;
export const PROFILE_FACE_SQUARE_RING_RADIUS = PROFILE_FACE_SQUARE_RADIUS + FACE_RING_WIDTH;

/**
 * 얼굴의 가장자리 한 줄. 사진 없는 이니셜 얼굴은 `surface` 채움이라 바탕과 라이트 1.16 · 다크 1.04:1 이다 — 3:1 을 넘는
 * `textFaint`(웹 `--line-strong`)로 가장자리를 준다(비텍스트 대비). 사진이 있어도 같은 링이라 두 얼굴이 한 얼굴로 읽힌다.
 */
export function useFaceRing(): StyleProp<ViewStyle> {
  return useStyles(buildStyles).ring;
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    ring: {
      borderRadius: radius.pill,
      borderWidth: FACE_RING_WIDTH,
      borderColor: color.textFaint,
    },
  });
