import {Easing} from 'react-native';

// =============================================================================
// 오르트 로더의 시간표 (#3961, 시안 A 「공전」). 순수 값이다: 컴포넌트가 이 표로
// `Animated` 보간을 만들고, 시험이 같은 표를 직접 읽는다.
//
// 웹은 CSS 키프레임(`tokens.css` 의 `.oort-loader*`)이고 폰은 `Animated` 다. 두 표면의
// 움직임이 같은 것이어야 해서 이 파일의 숫자는 웹 키프레임을 **그대로** 옮긴 것이다
// (`__tests__/oortLoader.test.tsx` 가 웹 tokens.css 를 읽어 퍼센트·곡선을 대조한다).
//
// 한 주기 1.8초, 0~1 로 본다:
//   0 ~ 14%    위성이 홈에서 궤도로 튀어나온다 (당김 거리 0~1 이 이 구간이다)
//   14 ~ 86%   한 바퀴 돈다 (-45° 에서 315°, 느리게 시작해 빨라졌다 느려진다)
//   86 ~ 94%   홈 안쪽까지 들어간다
//   94 ~ 100%  홈으로 돌아와 자리 잡는다. 90 ~ 100% 에 링이 한 번 숨을 쉰다(1.05배)
//
// 왜 한 값(`t`)에서 모든 채널을 보간하나: 회전·이동·링·꼬리 점이 따로 돌면 반복마다
// 어긋난다. 한 시계에서 읽으면 어긋날 수 없고, 네이티브 드라이버의 반복(JS 를 건너뛰는
// 한 번의 `Animated.loop(Animated.timing)`)을 그대로 쓸 수 있다.
//
// 곡선(cubic-bezier)은 `Animated.timing` 의 easing 이 아니라 **표에 구워** 둔다:
// `interpolate` 의 easing 은 네이티브 드라이버에 전달되지 않고, 구간마다 곡선이 다르기
// 때문이다. 한 구간을 촘촘한 선분으로 나눠 둔다(굽는 수는 `SAMPLES`).
//
// 주기를 두 번 이은 [0, 2] 표다: 당김에서 이어 도는 로더(#3962)는 14% 지점에서 시작해
// `[0.14, 1.14]` 를 돌고, 반복의 이음새도 그 자리에서 이어진다. 주기 함수라 어느 위상에서
// 시작해도 이음새가 없다.
// =============================================================================

/** 한 주기(ms). 웹 `--oort-loader-period: 1.8s` 와 같다. */
export const LOADER_PERIOD_MS = 1800;

/** 웹 키프레임 퍼센트와 같은 구간 경계(0~1). */
export const PHASE = {
  /** 위성이 궤도로 다 나오는 때. 당김 거리 0~1 이 이 구간에 대응한다. */
  popEnd: 0.14,
  /** 한 바퀴가 끝나는 때. */
  spinEnd: 0.86,
  /** 홈 안쪽으로 가장 깊이 들어가는 때. */
  dipAt: 0.94,
  /** 링이 숨 쉬기를 시작하는 때·가장 큰 때. */
  ringStart: 0.9,
  ringPeak: 0.95,
} as const;

/** 위성이 홈에 앉는 각도. 링의 홈이 오른쪽 위(-45°)다. */
export const HOME_ANGLE = -45;

/** 한 주기에 정수 두 번(0~2). 위상 `a` 에서 시작하는 반복은 `[a, a + 1]` 을 돈다. */
export const TIMELINE_SPAN = 2;

/**
 * 마크의 두 광학 보정판. 단위는 정사각 무대(링 중심이 무대 중심)의 격자 칸이다.
 * 웹 `OortMark` 의 small(24 격자 + 둘레, 무대 30)과 display(64 격자 + 둘레, 무대 68)이고,
 * 수치는 `clients/web/src/design/brand/OortMark.tsx` 의 위성 원(중심·반지름)에서 나온다.
 */
export const OPTICAL = {
  small: {units: 30, satelliteRadius: 3, home: 9.9, out: 12.2},
  display: {units: 68, satelliteRadius: 6, home: 22.63, out: 28},
} as const;

export type LoaderOptical = keyof typeof OPTICAL;

/** 꽂힐 때 홈 안쪽으로 더 들어가는 거리(격자 칸). 두 판이 같다. */
export const DIP_UNITS = 0.9;

/** 32pt 이하는 small, 그보다 크면 display (마크 정본의 규칙). */
export function opticalFor(size: number): LoaderOptical {
  return size <= 32 ? 'small' : 'display';
}

/** 꼬리 점 둘은 40pt 부터 선다. 그보다 작은 자리에서는 번잡하다. */
export const TRAIL_MIN_SIZE = 40;

/** 머리 뒤 15°·30°, 머리의 0.72·0.5배, 투명도 0.5·0.26 (웹 큰 자리 꼬리와 같은 모양). */
export const TRAILS = [
  {offset: 15, scale: 0.72, opacity: 0.5},
  {offset: 30, scale: 0.5, opacity: 0.26},
] as const;

// ---- 곡선: 웹 tokens.css 의 cubic-bezier 와 같은 값 ---------------------------

export const CURVES = {
  pop: [0.2, 0.8, 0.2, 1],
  spin: [0.45, 0.05, 0.25, 1],
  settleIn: [0.5, 0, 0.2, 1],
  /** CSS `ease-out`. */
  settleOut: [0, 0, 0.58, 1],
  /** CSS `ease`. 링 숨. */
  ring: [0.25, 0.1, 0.25, 1],
  /** CSS `ease-in-out`. 동작 줄이기의 투명도 숨. */
  breathe: [0.42, 0, 0.58, 1],
} as const;

const bezier = (c: readonly [number, number, number, number]) =>
  Easing.bezier(c[0], c[1], c[2], c[3]);

/** 한 구간을 몇 개의 선분으로 굽나. 시안 곡선과의 차가 눈에 안 띄는 최소선이다. */
const SAMPLES = {pop: 10, spin: 36, settle: 8, ring: 6, breathe: 8} as const;

export type Knot = readonly [input: number, output: number];

/** `[t0, t1]` 에서 `v0 → v1` 을 곡선 `ease` 로, 양 끝 포함 `steps + 1` 개 점. */
function eased(
  ease: (x: number) => number,
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  steps: number,
): Knot[] {
  const out: Knot[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = i / steps;
    // 끝점은 계산하지 않고 그대로 쓴다: 이웃 구간과 같은 시각이어야 이어 붙일 때 중복이 걷힌다.
    const at = i === 0 ? t0 : i === steps ? t1 : t0 + (t1 - t0) * x;
    out.push([at, v0 + (v1 - v0) * ease(x)]);
  }
  return out;
}

const hold = (t0: number, t1: number, v: number): Knot[] => [
  [t0, v],
  [t1, v],
];

/** 이웃한 구간이 공유하는 끝점의 중복을 걷고 이어 붙인다(입력은 늘어나기만 한다). */
function join(...parts: Knot[][]): Knot[] {
  const out: Knot[] = [];
  for (const part of parts) {
    for (const knot of part) {
      const last = out[out.length - 1];
      if (last && last[0] === knot[0]) {
        // 같은 시각의 두 값은 첫 값을 남긴다(구간 경계에서 두 구간의 값이 같다).
        continue;
      }
      out.push(knot);
    }
  }
  return out;
}

/**
 * 한 주기 표를 두 번 이어 [0, 2] 로 만든다. 값은 주기 함수라 그대로 반복한다.
 * 각도만은 한 바퀴를 돌고 나면 값이 360 올라가 있으므로 두 번째 주기를 그만큼 올려
 * 이음새에서 거꾸로 감기지 않게 한다(`shift`).
 */
function twice(oneCycle: Knot[], shift = 0): Knot[] {
  const second: Knot[] = oneCycle.map(([t, v]) => [t + 1, v + shift]);
  return join(oneCycle, second);
}

// ---- 채널 표 (한 주기, 0~1) -----------------------------------------------------

/** 위성 중심의 거리(무대 한 변에 대한 비)에 대한 표를 만든다. */
function radialCycle(optical: LoaderOptical): Knot[] {
  const {units, home, out} = OPTICAL[optical];
  const h = home / units;
  const o = out / units;
  const d = (home - DIP_UNITS) / units;
  return join(
    eased(bezier(CURVES.pop), 0, PHASE.popEnd, h, o, SAMPLES.pop),
    hold(PHASE.popEnd, PHASE.spinEnd, o),
    eased(bezier(CURVES.settleIn), PHASE.spinEnd, PHASE.dipAt, o, d, SAMPLES.settle),
    eased(bezier(CURVES.settleOut), PHASE.dipAt, 1, d, h, SAMPLES.settle),
  );
}

/** 위성이 선 각도(도). 시계 방향이 양수. */
function angleCycle(): Knot[] {
  return join(
    hold(0, PHASE.popEnd, HOME_ANGLE),
    eased(
      bezier(CURVES.spin),
      PHASE.popEnd,
      PHASE.spinEnd,
      HOME_ANGLE,
      HOME_ANGLE + 360,
      SAMPLES.spin,
    ),
    hold(PHASE.spinEnd, 1, HOME_ANGLE + 360),
  );
}

/** 링이 꽂히는 순간 한 번 숨을 쉰다(1 → 1.05 → 1). */
function ringCycle(): Knot[] {
  const ease = bezier(CURVES.ring);
  return join(
    hold(0, PHASE.ringStart, 1),
    eased(ease, PHASE.ringStart, PHASE.ringPeak, 1, 1.05, SAMPLES.ring),
    eased(ease, PHASE.ringPeak, 1, 1.05, 1, SAMPLES.ring),
  );
}

/** 꼬리 점의 투명도: 도는 동안만 보이고(24~76%), 나오고 꽂히는 동안은 숨는다. */
function trailCycle(visible: number): Knot[] {
  return [
    [0, 0],
    [0.12, 0],
    [0.24, visible],
    [0.76, visible],
    [0.88, 0],
    [1, 0],
  ];
}

/** 동작 줄이기: 한 주기에 투명도 1 → 0.5 → 1. */
function breatheCycle(): Knot[] {
  const ease = bezier(CURVES.breathe);
  return join(
    eased(ease, 0, 0.5, 1, 0.5, SAMPLES.breathe),
    eased(ease, 0.5, 1, 0.5, 1, SAMPLES.breathe),
  );
}

export interface LoaderTables {
  /** 위성 중심 거리 / 무대 한 변. */
  radial: Knot[];
  /** 위성 각도(도). */
  angle: Knot[];
  ring: Knot[];
  /** 꼬리 점 투명도. 최대값 하나당 한 표. */
  trail: (visible: number) => Knot[];
  breathe: Knot[];
}

/** 한 시계 `t ∈ [0, 2]` 에서 읽는 표. 모두 같은 주기 함수의 두 번 이은 것이다. */
export function tablesFor(optical: LoaderOptical): LoaderTables {
  return {
    radial: twice(radialCycle(optical)),
    // 두 번째 주기는 -45° + 360° 에서 시작한다(첫 주기가 315° 에서 끝났다).
    angle: twice(angleCycle(), 360),
    ring: twice(ringCycle()),
    trail: (visible: number) => twice(trailCycle(visible)),
    breathe: twice(breatheCycle()),
  };
}

// ---- 당김(스크럽)의 자세 (#3992) ---------------------------------------------------
//
// 당겨서 새로고침(#3962)의 표시는 시간표(위)를 시간이 아니라 **손가락의 거리**로 읽는다. 처음 판은 시간표의
// 처음 14%(홈에서 궤도로 나오는 구간)를 되감았는데, 40pt 로더에서 그 구간의 위성은 약 3pt 만 움직여서
// 당김이 눈에 거의 안 읽혔다(#3989 검수 L1, 성재 2026-10-17 「3개 다 권장으로 ㄱㄱ」).
//
// 그래서 당김의 입력 `p`(0~1, 표준 컨트롤이 새로고침을 세우는 거리가 1)는 **궤도 각도**로 매핑한다:
//
//   각도  p = 0 → 홈(-45°),  p = 1 → 한 바퀴 돌아 다시 -45°(+360°). **p 에 선형이다**: 시안 A 의 도는 구간은
//         느리게 시작해 빨라졌다 느려지는 곡선(`CURVES.spin`)인데, 그 곡선으로 당기면 25%·50%·75% 가 각각
//         약 10°·220°·345° 에 몰려 75% 와 100% 가 같은 자리로 읽힌다. 손가락 아래의 눈금은 **등간격**이어야
//         한다(25·50·75·100% = 90°씩).
//   거리  처음 `SCRUB_POP_END` 에 홈에서 궤도로 **먼저** 나온다(웹과 같은 `CURVES.pop`). 각도는 처음부터 흐르지만
//         이 구간의 회전은 몇 도 안 되고, 위성이 링의 홈(물린 자리)에서 빠져나온 뒤에야 몸을 돌려야
//         링 둘레를 긁지 않는다.
//
// 끝(p = 1)의 자세가 곧 **이어 돌기의 시작 자세**다: 각도 315° ≡ -45°, 거리 궤도. 시간표의 14%(`PHASE.popEnd`)
// 자세와 같아서 임계를 넘어 새로고침이 서도 위성이 튀지 않는다(시험이 두 자세를 같게 못 박는다).
//
// 이 표는 웹 키프레임의 거울이 아니다(웹 로더는 당기지 않는다): `oortLoader.test.tsx` 가 웹 대조로 읽는
// 이름(`PHASE`·`CURVES`·`TRAILS`…)은 건드리지 않고 이 절만 더했다.

/** 위성이 홈에서 궤도로 다 나오는 당김 진행도(앞 8%). 표준 컨트롤 기준 약 12pt 의 당김이다. */
export const SCRUB_POP_END = 0.08;

/** 동작 줄이기에서 당김의 투명도가 출발하는 값. 1 에서 끝나고 그 사이는 당김에 선형이다. */
export const SCRUB_FILL_MIN = 0.2;

/** 한 번 당기는 동안 위성이 도는 각도(도). 한 바퀴. */
export const SCRUB_TURN = 360;

export interface ScrubTables {
  /** 위성 중심 거리 / 무대 한 변. 입력은 당김 진행도 0~1. */
  radial: Knot[];
  /** 위성 각도(도). 입력은 당김 진행도 0~1. */
  angle: Knot[];
  /** 동작 줄이기: 로더의 투명도. 입력은 당김 진행도 0~1. */
  fill: Knot[];
}

export function scrubTablesFor(optical: LoaderOptical): ScrubTables {
  const {units, home, out} = OPTICAL[optical];
  return {
    radial: join(
      eased(bezier(CURVES.pop), 0, SCRUB_POP_END, home / units, out / units, SAMPLES.pop),
      hold(SCRUB_POP_END, 1, out / units),
    ),
    angle: [
      [0, HOME_ANGLE],
      [1, HOME_ANGLE + SCRUB_TURN],
    ],
    fill: [
      [0, SCRUB_FILL_MIN],
      [1, 1],
    ],
  };
}

/** 당김 진행도 `p`(0~1, 밖은 끝으로 접힌다)의 자세. 단위는 `poseAt` 과 같다. */
export function scrubPoseAt(optical: LoaderOptical, p: number) {
  const tables = scrubTablesFor(optical);
  return {
    radial: readKnots(tables.radial, p),
    angle: readKnots(tables.angle, p),
    fillOpacity: readKnots(tables.fill, p),
  };
}

// ---- 표 읽기 (시험과 정적 자세가 쓴다) ------------------------------------------

/** 표를 선분으로 읽는다. `Animated.interpolate` 의 한 입력 범위 읽기와 같다. */
export function readKnots(knots: readonly Knot[], t: number): number {
  const x = Math.min(Math.max(t, knots[0]![0]), knots[knots.length - 1]![0]);
  for (let i = 1; i < knots.length; i += 1) {
    const [t1, v1] = knots[i]!;
    if (x <= t1) {
      const [t0, v0] = knots[i - 1]!;
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
    }
  }
  return knots[knots.length - 1]![1];
}

/** 시각 `t`(0~2)의 자세. 단위: 거리는 무대 한 변의 비, 각도는 도(두 번째 주기는 360 더 간다). */
export function poseAt(optical: LoaderOptical, t: number) {
  const tables = tablesFor(optical);
  return {
    radial: readKnots(tables.radial, t),
    angle: readKnots(tables.angle, t),
    ringScale: readKnots(tables.ring, t),
    breatheOpacity: readKnots(tables.breathe, t),
  };
}
