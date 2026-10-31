import {Easing} from 'react-native';
import {
  MAKE_PLAYS,
  MOTION_PRESETS,
  type MotionPresetId,
} from '@momo/core/features/expressions/make';

// =============================================================================
// 「AI와 만들기」 칩 미리보기의 움직임 표 (#4891, ADR-0218 §7 G3.3·G3.4).
//
// 웹은 `expressions.css` 의 키프레임이 G3.3 의 움직임을 **비슷하게 흉내 낸다**. 정확한 결과(프레임·눌림·별의 모양과
// 자리)는 서버 조립이 만들고 사람은 그 결과를 승인 카드에서 따로 본다. 폰도 같은 값을 쓴다:
//
//   · 한 번 재생 시간 = 코어 `MOTION_PRESETS` 의 프레임 수 × 지연(`playMs`). 총 `MAKE_PLAYS`(4)회 재생하고 멈춘다.
//   · 키프레임의 위치와 값은 웹 CSS 와 **같은 숫자**다(`MAKE_PREVIEW_KEYFRAMES`). 시험이 CSS 를 읽어 대조한다.
//   · 곡선: 통통은 선형, 흔들흔들·두근두근은 구간마다 ease-in-out(`cubic-bezier(.42,0,.58,1)`), 반짝은 단계 값이다.
//
// 네이티브 구동 애니메이션의 보간은 구간마다 직선이고 곡선 함수를 못 싣는다. 그래서 곡선이 있는 구간은 같은 곡선을
// 촘촘히 찍은 표(`sampledTrack`)로 바꿔 보간에 준다 — 값은 같고 모양만 직선 조각이다.
// =============================================================================

/** 한 번 재생 안의 위치(0..1)와 그 위치의 값. 위치는 오름차순이다. */
export interface PreviewTrack {
  readonly at: readonly number[];
  readonly values: readonly number[];
}

export type PreviewCurve = 'linear' | 'ease-in-out';

/** 웹 `expressions.css` 의 `@keyframes expression-make-*` 와 같은 숫자. 세로 이동은 그림 칸 높이의 비율이다. */
export const MAKE_PREVIEW_KEYFRAMES = {
  bounce: {
    curve: 'linear' as PreviewCurve,
    translateY: {
      at: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1],
      values: [0, -0.0383, -0.0707, -0.0924, -0.1, -0.0924, -0.0707, -0.0383, 0],
    },
    scaleX: {
      at: [0, 0.125, 0.875, 1],
      values: [1.06, 1, 1, 1.06],
    },
    scaleY: {
      at: [0, 0.125, 0.875, 1],
      values: [0.94, 1, 1, 0.94],
    },
  },
  wobble: {
    curve: 'ease-in-out' as PreviewCurve,
    rotateDeg: {
      at: [0, 0.25, 0.5, 0.75, 1],
      values: [0, 8, 0, -8, 0],
    },
  },
  pulse: {
    curve: 'ease-in-out' as PreviewCurve,
    scale: {
      at: [0, 0.25, 0.5, 0.75, 1],
      values: [1, 1.12, 1, 1.12, 1],
    },
  },
} as const;

/** 반짝: 별 k 는 한 번 재생의 k번째 4분의 1 동안만 켜진다(G3.3: 프레임 5k 부터 5k+4 까지). */
export const SPARKLE_STARS = [0, 1, 2, 3] as const;

export interface PreviewTiming {
  /** 한 번 재생 시간(ms) = G3.3 표의 프레임 수 × 지연. */
  readonly durationMs: number;
  /** 총 재생 횟수(G3.4). */
  readonly iterations: number;
}

export function previewTiming(motion: MotionPresetId): PreviewTiming {
  const preset = MOTION_PRESETS.find(entry => entry.id === motion);
  // 표에 없는 움직임은 만들 수 없다 — 시험이 네 가지 모두를 잰다.
  return {durationMs: preset?.playMs ?? 0, iterations: MAKE_PLAYS};
}

const EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);
const SAMPLES_PER_SEGMENT = 8;

/** ease-in-out 이면 구간마다 같은 곡선을 촘촘히 찍는다. 선형이면 그대로다. */
export function sampledTrack(
  track: PreviewTrack,
  curve: PreviewCurve,
): PreviewTrack {
  if (curve === 'linear') return track;
  const at: number[] = [];
  const values: number[] = [];
  for (let index = 0; index < track.at.length - 1; index += 1) {
    const [from, to] = [track.at[index], track.at[index + 1]];
    const [start, end] = [track.values[index], track.values[index + 1]];
    for (let step = 0; step < SAMPLES_PER_SEGMENT; step += 1) {
      const fraction = step / SAMPLES_PER_SEGMENT;
      at.push(from + (to - from) * fraction);
      values.push(start + (end - start) * EASE_IN_OUT(fraction));
    }
  }
  at.push(track.at[track.at.length - 1]);
  values.push(track.values[track.values.length - 1]);
  return {at, values};
}

/** 별 k 의 켜짐(0 또는 1): 자기 4분의 1 동안만 1 이고 가장자리에서 바로 바뀐다(`step-end`). */
export function starTrack(index: number): PreviewTrack {
  const from = index / 4;
  const to = (index + 1) / 4;
  const edge = 0.0001;
  const at: number[] = [];
  const values: number[] = [];
  if (from > 0) {
    at.push(0, from - edge);
    values.push(0, 0);
  }
  at.push(from);
  values.push(1);
  if (to < 1) {
    at.push(to - edge, to, 1);
    values.push(1, 0, 0);
  } else {
    at.push(1);
    values.push(1);
  }
  return {at, values};
}

/** 표의 직선 보간: 위치 `position`(0..1)에서의 값. 표 밖은 가까운 끝값이다. */
export function trackValueAt(track: PreviewTrack, position: number): number {
  const last = track.at.length - 1;
  if (position <= track.at[0]) return track.values[0];
  if (position >= track.at[last]) return track.values[last];
  for (let index = 0; index < last; index += 1) {
    const [from, to] = [track.at[index], track.at[index + 1]];
    if (position >= from && position <= to) {
      const fraction = to === from ? 0 : (position - from) / (to - from);
      return (
        track.values[index] +
        (track.values[index + 1] - track.values[index]) * fraction
      );
    }
  }
  return track.values[last];
}

/**
 * 통통은 그림의 **바닥**을 기준으로 눌린다(CSS `transform-origin: 50% 100%`). 폰의 변환은 가운데 기준이라
 * 세로 배율이 바뀌면 바닥이 같이 움직이므로, 그만큼 되돌려 바닥을 붙잡는다: 바닥 이동 = (1 − 세로 배율) / 2 × 높이.
 */
export function anchoredBounceTranslate(): PreviewTrack {
  const {translateY, scaleY} = MAKE_PREVIEW_KEYFRAMES.bounce;
  return {
    at: translateY.at,
    values: translateY.values.map(
      (value, index) =>
        value + (1 - trackValueAt(scaleY, translateY.at[index])) / 2,
    ),
  };
}
