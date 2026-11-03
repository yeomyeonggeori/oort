import type {DragPoint} from './viewerDismiss';

// =============================================================================
// 사진 뷰어의 확대 — 규칙만 (#4769). 배선은 `AttachmentViewer.tsx` 다.
//
// 사진 앱처럼 **두 손가락으로 벌려** 확대하고, **두 번 탭**으로 확대·원래 크기를 오간다. 확대 자체는 iOS 의 스크롤뷰가
// 한다(`ScrollView` 의 `maximumZoomScale` — 새 의존 없음). 이 파일은 그 위에서 JS 가 정하는 것들의 값과 계산이다.
//
//   · 배율 범위 1~3: 원래 크기보다 작아지지 않는다(손을 놓으면 1 로 돌아온다 — `bouncesZoom`). 아주 긴 그림만 화면을 채우는 배율까지(#5224, 아래 「그림 비율에 맞춘 배율」).
//   · 두 번 탭: 탭한 곳이 가운데 오게 2배(아주 긴 그림은 높이·폭 맞춤), 이미 확대돼 있으면 원래 크기(전체 사각형).
//   · 두 번 탭의 시간·거리: 한 번 탭(조작 숨김)과 헷갈리지 않게 **첫 탭은 이 시간만큼 기다린다.**
// =============================================================================

/** 가장 작은 배율 — 원래 크기. 이보다 작아지지 않는다. */
export const ZOOM_MIN = 1;
/** 가장 큰 배율. */
export const ZOOM_MAX = 3;
/** 두 번 탭이 키우는 배율. */
export const ZOOM_DOUBLE_TAP = 2;

/**
 * 첫 탭을 **뗀 뒤** 이 시간(ms) 안에 두 번째 탭을 **떼면** 두 번 탭이다(뗌에서 뗌까지). 안 오면 그제야 한 번 탭(조작 숨김·나타남)이
 * 일어난다 — 그래서 한 번 탭은 이만큼 늦다(사진 앱과 같다).
 *
 * 사람 기준의 300ms다(#4775). 자동화 드라이버의 호출 지연을 제품 문턱에 더하지 않는다.
 */
export const DOUBLE_TAP_MS = 300;

/** 두 탭이 이 거리(pt) 안이어야 같은 자리를 두 번 누른 것이다. 멀면 서로 다른 한 번 탭 둘이다. */
export const DOUBLE_TAP_SLOP_PT = 40;

/** 이 배율을 **넘어야** 확대로 센다 — 1.0000001 같은 부동소수 찌꺼기가 넘기기·쓸어 닫기를 끄지 않게 한다. */
const ZOOMED_ABOVE = ZOOM_MIN + 0.01;

export interface ZoomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZoomSize {
  width: number;
  height: number;
}

/** 지금 확대돼 있는가. 네이티브가 알려 주는 배율(`zoomScale`)을 받는다 — 모르면(없음) 원래 크기다. */
export function isZoomed(scale: number | undefined): boolean {
  return scale !== undefined && scale > ZOOMED_ABOVE;
}

/** 두 탭이 같은 자리인가(시간은 호출부의 타이머가 잰다). */
export function isDoubleTap(first: DragPoint, second: DragPoint): boolean {
  return (
    Math.hypot(second.x - first.x, second.y - first.y) <= DOUBLE_TAP_SLOP_PT
  );
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * `point`(쪽 좌표)가 가운데 오도록 `scale` 배로 키운 뒤 화면에 보이는 사각형 — `zoomToRect` 에 그대로 넘긴다. 사각형이 쪽 밖으로
 * 나가면 안쪽으로 밀어 넣는다: 모서리를 눌러도 사진 밖 검은 빈자리를 보여 주지 않고, 눌린 곳은 화면 안에 남는다.
 */
export function zoomRectAt(
  point: DragPoint,
  size: ZoomSize,
  scale: number = ZOOM_DOUBLE_TAP,
): ZoomRect {
  const width = size.width / scale;
  const height = size.height / scale;
  return {
    x: clamp(point.x - width / 2, 0, size.width - width),
    y: clamp(point.y - height / 2, 0, size.height - height),
    width,
    height,
  };
}

/** 원래 크기로 돌아가는 사각형 — 쪽 전체다. */
export function fullRect(size: ZoomSize): ZoomRect {
  return {x: 0, y: 0, width: size.width, height: size.height};
}

// ---- 그림 비율에 맞춘 배율 (#5224) -------------------------------------------------------------------------------
//
// 관례(사진 앱·핀치의 끝): 두 번 탭은 **화면을 채우는 곳**까지 간다(iOS 사진 앱 — 세로 화면의 가로 사진은 높이를 채운다). 핀치의 끝은
// 원본 픽셀이다(애플 PhotoScroller 샘플의 최대 배율은 화면 배율의 역수, 안드로이드 SubsamplingScaleImageView 도 1:1). 가로로 엄청 긴
// 그림(예: 2072×110)은 폭에 맞추면 높이가 약 21pt 의 얇은 선이라 3배여도 62pt 다 — 읽으려면 화면 높이를 채우는 배율(약 41배)까지 키울 수
// 있어야 하고, 두 번 탭이 거기로 가야 한다(가로로 끌어 읽는다). 세로로 엄청 긴 그림은 같은 규칙이 폭에 걸린다.
//
// **보통 사진은 바뀌지 않는다**: 최대 3배·두 번 탭 2배 그대로다. 「아주 긴 그림」은 채움 배율이 `LONG_FILL_SCALE` 을 넘는 그림뿐이다.

/** 아무리 긴 그림이어도 이 배율을 넘기지 않는다(UIKit 이 다루기에 무리 없는 값 — 폭 20만 pt 짜리 내용을 만들지 않는다). */
export const ZOOM_CEILING = 48;

/**
 * 채움 배율이 이 값을 **넘는** 그림이 「아주 긴 그림」이다. 세로 화면(402×874)에서 가로세로비 약 2.3:1 이상이다 — 4:3·3:2·16:9·2:1 사진은
 * 모두 밑이라 지금 동작이 그대로 남고, 21:9 이상의 파노라마·긴 캡처부터 올라간다.
 */
export const LONG_FILL_SCALE = 5;

/**
 * 맞춤 사진이 `viewport` 를 **가득 채우는** 배율 — 짧게 맞춘 쪽이 창에 닿은 만큼이 아니라 두 축 모두 창을 덮는 배율이다.
 * 가로로 긴 그림은 높이를, 세로로 긴 그림은 폭을 채우는 배율이고, 사진 앱의 두 번 탭이 가는 곳이다. 맞춤 사각형은 뷰어가 창에 맞춰(`fitStageRect`,
 * 작은 그림도 키워서) 놓은 것이라 그림의 크기와 상관없이 **모양**만 이 값을 정한다. 쓸 수 없는 입력은 1(원래 크기)이다.
 */
export function fillScale(fitted: ZoomSize, viewport: ZoomSize): number {
  const usable = (size: ZoomSize) => size.width > 0 && size.height > 0;
  if (!usable(fitted) || !usable(viewport)) return ZOOM_MIN;
  return Math.max(viewport.width / fitted.width, viewport.height / fitted.height, ZOOM_MIN);
}

/** 아주 긴 그림인가 — 채움 배율이 `LONG_FILL_SCALE` 을 넘는다. */
export function isVeryLong(fitted: ZoomSize, viewport: ZoomSize): boolean {
  return fillScale(fitted, viewport) > LONG_FILL_SCALE;
}

/**
 * 두 손가락 확대의 최대 배율(`maximumZoomScale`). 보통 사진은 `ZOOM_MAX`, 아주 긴 그림은 화면을 채우는 배율까지(`ZOOM_CEILING` 이 상한).
 */
export function maxZoomScale(fitted: ZoomSize, viewport: ZoomSize): number {
  return isVeryLong(fitted, viewport)
    ? Math.min(fillScale(fitted, viewport), ZOOM_CEILING)
    : ZOOM_MAX;
}

/**
 * 두 번 탭이 키우는 배율. 보통 사진은 `ZOOM_DOUBLE_TAP`(2배), 아주 긴 그림은 최대 배율 = 화면을 채우는 배율(높이 맞춤·폭 맞춤)이다. 다시 두 번 탭하면
 * 원래 크기로 돌아온다(`fullRect`).
 */
export function doubleTapScale(fitted: ZoomSize, viewport: ZoomSize): number {
  return isVeryLong(fitted, viewport)
    ? maxZoomScale(fitted, viewport)
    : ZOOM_DOUBLE_TAP;
}

/** 확대 상태를 보조기술에 알리는 값. 원래 크기에서는 말하지 않는다(사진 이름만 읽힌다). */
export const ZOOMED_A11Y_VALUE = '확대됨';
