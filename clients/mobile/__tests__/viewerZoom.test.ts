import {fitStageRect} from '@momo/core/lib/stageTransition';
import {
  doubleTapScale,
  fillScale,
  isVeryLong,
  LONG_FILL_SCALE,
  maxZoomScale,
  ZOOM_CEILING,
  ZOOM_DOUBLE_TAP,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomRectAt,
} from '../src/features/attachments/viewerZoom';

// =============================================================================
// 사진 뷰어 확대의 **배율 계산** (#5224). 규칙은 `viewerZoom.ts` 한 곳이고 여기서 숫자로 잰다.
//
// 관례(인계 맨 위 표): 사진 앱은 두 번 탭이 「화면을 채우는 곳」까지 가고, 핀치의 끝은 원본 픽셀이다. 가로로 엄청 긴 그림은 폭에 맞추면
// 얇은 선이 되어 3배로는 읽을 수 없으므로 그 그림만 「화면 높이를 채우는 배율」(세로로 긴 그림은 폭)까지 허용한다. 보통 사진의 3배·2배는 그대로다.
// 맞춤 사각형은 뷰어가 쓰는 것과 같은 `fitStageRect` 로 만든다 — 손으로 쓴 숫자가 아니라 뷰어가 실제로 넘기는 모양으로 잰다.
// =============================================================================

const PHONE = {width: 402, height: 874}; // iPhone 17 Pro 의 창(pt)
const PHONE_LANDSCAPE = {width: 874, height: 402};

function fitted(
  natural: {width: number; height: number},
  viewport: {width: number; height: number} = PHONE,
) {
  const rect = fitStageRect(natural, viewport);
  return {width: rect.width, height: rect.height};
}

describe('보통 사진 — 지금 동작 그대로: 최대 3배, 두 번 탭 2배', () => {
  it.each([
    ['가로 4:3', {width: 1200, height: 900}],
    ['세로 3:4', {width: 900, height: 1200}],
    ['정사각', {width: 800, height: 800}],
    ['가로 3:2', {width: 1500, height: 1000}],
    ['가로 16:9', {width: 1920, height: 1080}],
    ['가로 2:1', {width: 2000, height: 1000}],
    ['세로 화면 캡처', {width: 1170, height: 2532}],
    ['작은 그림(80×60 — 뷰어는 창에 맞춰 키워 보여 준다)', {width: 80, height: 60}],
  ])('%s', (_name, natural) => {
    const rect = fitted(natural);
    expect(isVeryLong(rect, PHONE)).toBe(false);
    expect(maxZoomScale(rect, PHONE)).toBe(ZOOM_MAX);
    expect(doubleTapScale(rect, PHONE)).toBe(ZOOM_DOUBLE_TAP);
  });

  it('사진 크기를 아직 모르면(맞춤 사각형이 창 전체) 보통 사진처럼 센다', () => {
    expect(fillScale(PHONE, PHONE)).toBe(ZOOM_MIN);
    expect(maxZoomScale(PHONE, PHONE)).toBe(ZOOM_MAX);
    expect(doubleTapScale(PHONE, PHONE)).toBe(ZOOM_DOUBLE_TAP);
  });

  it('쓸 수 없는 입력(0·음수·NaN)은 보통 사진으로 센다 — 던지지 않는다', () => {
    for (const bad of [
      {width: 0, height: 0},
      {width: 100, height: 0},
      {width: -5, height: 20},
      {width: Number.NaN, height: 20},
    ]) {
      expect(maxZoomScale(bad, PHONE)).toBe(ZOOM_MAX);
      expect(doubleTapScale(bad, PHONE)).toBe(ZOOM_DOUBLE_TAP);
    }
    expect(maxZoomScale(fitted({width: 1200, height: 900}), {width: 0, height: 0})).toBe(ZOOM_MAX);
  });
});

describe('아주 긴 그림 — 화면을 채우는 배율까지 키우고, 두 번 탭이 거기로 간다', () => {
  it('극단 가로 2072×110: 폭에 맞추면 높이 약 21pt 라 3배로는 62pt — 화면 높이를 채우는 배율(약 41배)까지 허용한다', () => {
    const rect = fitted({width: 2072, height: 110});
    expect(rect.height).toBeCloseTo((402 * 110) / 2072, 6); // 약 21.3pt
    expect(isVeryLong(rect, PHONE)).toBe(true);
    const max = maxZoomScale(rect, PHONE);
    expect(max).toBeGreaterThan(ZOOM_MAX);
    expect(max).toBeLessThanOrEqual(ZOOM_CEILING);
    // 이 배율로 키우면 그림 높이가 창 높이를 꼭 채운다(높이 맞춤).
    expect(rect.height * max).toBeCloseTo(PHONE.height, 6);
    expect(doubleTapScale(rect, PHONE)).toBe(max);
  });

  it('극단 세로 110×2072: 같은 규칙이 세로로 — 폭을 채우는 배율까지(폭 맞춤)', () => {
    const rect = fitted({width: 110, height: 2072});
    expect(rect.height).toBeCloseTo(PHONE.height, 6); // 높이가 창에 닿는다
    expect(isVeryLong(rect, PHONE)).toBe(true);
    const max = maxZoomScale(rect, PHONE);
    expect(max).toBeGreaterThan(ZOOM_MAX);
    expect(rect.width * max).toBeCloseTo(PHONE.width, 6);
    expect(doubleTapScale(rect, PHONE)).toBe(max);
  });

  it('같은 그림도 창 모양에 따라 다르게 센다 — 1:4 그림은 가로 화면에서는 긴 그림, 세로 화면에서는 보통이다', () => {
    const natural = {width: 1000, height: 4000};
    const landscape = fitted(natural, PHONE_LANDSCAPE); // 높이에 맞춰 약 100×402
    expect(isVeryLong(landscape, PHONE_LANDSCAPE)).toBe(true);
    expect(landscape.width * maxZoomScale(landscape, PHONE_LANDSCAPE)).toBeCloseTo(PHONE_LANDSCAPE.width, 6);
    const portrait = fitted(natural, PHONE); // 높이에 맞춰 약 218×874 — 폭을 채우는 데 1.8배면 된다
    expect(isVeryLong(portrait, PHONE)).toBe(false);
    expect(maxZoomScale(portrait, PHONE)).toBe(ZOOM_MAX);
  });

  it('상한: 아무리 긴 그림도 ZOOM_CEILING 을 넘기지 않는다', () => {
    const rect = fitted({width: 100_000, height: 100});
    expect(fillScale(rect, PHONE)).toBeGreaterThan(ZOOM_CEILING);
    expect(maxZoomScale(rect, PHONE)).toBe(ZOOM_CEILING);
    expect(doubleTapScale(rect, PHONE)).toBe(ZOOM_CEILING);
  });

  it('문턱: 채움 배율이 LONG_FILL_SCALE 을 넘는 그림부터다 — 2.2:1 은 보통, 2.4:1(21:9)은 긴 그림', () => {
    expect(isVeryLong(fitted({width: 2200, height: 1000}), PHONE)).toBe(false); // 채움 4.78
    expect(isVeryLong(fitted({width: 2560, height: 1080}), PHONE)).toBe(true); // 채움 5.15
    expect(fillScale(fitted({width: 2560, height: 1080}), PHONE)).toBeGreaterThan(LONG_FILL_SCALE);
  });

  it('어떤 모양이든 두 번 탭 배율은 최대 배율 이하이고, 최대 배율은 3 이상 상한 이하다', () => {
    for (const [width, height] of [
      [1200, 900], [900, 1200], [1920, 1080], [2560, 1080], [3000, 1000], [2072, 110],
      [6000, 300], [110, 2072], [200, 4000], [100_000, 100], [1, 1], [50, 5000],
    ] as const) {
      const rect = fitted({width, height});
      const max = maxZoomScale(rect, PHONE);
      expect(max).toBeGreaterThanOrEqual(ZOOM_MAX);
      expect(max).toBeLessThanOrEqual(ZOOM_CEILING);
      expect(doubleTapScale(rect, PHONE)).toBeLessThanOrEqual(max);
      expect(doubleTapScale(rect, PHONE)).toBeGreaterThanOrEqual(ZOOM_DOUBLE_TAP);
    }
  });

  it('두 번 탭이 넘기는 사각형: 그 배율에서 보이는 만큼이고, 탭한 곳(그림 밖 빈 곳 포함)이 안에 든다', () => {
    const rect = fitted({width: 2072, height: 110});
    const scale = doubleTapScale(rect, PHONE);
    // 그림 위 · 그림 밖 위쪽 빈 곳(음수) · 아래쪽 빈 곳(높이 넘김)
    for (const point of [
      {x: 200, y: rect.height / 2},
      {x: 40, y: -300},
      {x: 360, y: rect.height + 300},
    ]) {
      const zoom = zoomRectAt(point, rect, scale);
      expect(zoom.width).toBeCloseTo(rect.width / scale, 9);
      expect(zoom.height).toBeCloseTo(rect.height / scale, 9);
      // 네이티브는 이 사각형을 창에 맞춰 키운다: 배율 = min(창폭/사각폭, 창높이/사각높이) — 의도한 배율과 같다.
      expect(Math.min(PHONE.width / zoom.width, PHONE.height / zoom.height)).toBeCloseTo(scale, 6);
      // 쪽 안에 머문다.
      expect(zoom.x).toBeGreaterThanOrEqual(0);
      expect(zoom.y).toBeGreaterThanOrEqual(0);
      expect(zoom.x + zoom.width).toBeLessThanOrEqual(rect.width + 1e-9);
      expect(zoom.y + zoom.height).toBeLessThanOrEqual(rect.height + 1e-9);
    }
  });
});
