import {
  showsInlinePreview,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

export type ImageLightboxViewState =
  | "empty"
  | "loading"
  | "ready"
  | "error"
  | "offline";

/** 라이트박스에 들어갈 수 있는 것은 타임라인에서 실제로 펴는 안전한 이미지뿐이다. */
export function lightboxAttachments(
  attachments: MessageAttachment[]
): MessageAttachment[] {
  return attachments.filter(showsInlinePreview);
}

/**
 * 화면 상태 한 벌. 캐시된 이미지는 연결이 끊겨도 남겨 둔다(P15). 바이트가 없을
 * 때만 offline이 loading/error를 대신해 지금 할 수 있는 일이 없음을 말한다.
 */
export function imageLightboxViewState({
  hasImage,
  previewStatus,
  offline,
}: {
  hasImage: boolean;
  previewStatus: "loading" | "ready" | "failed";
  offline: boolean;
}): ImageLightboxViewState {
  if (!hasImage) return "empty";
  if (previewStatus === "ready") return "ready";
  if (offline) return "offline";
  return previewStatus === "failed" ? "error" : "loading";
}

/** 왼쪽/오른쪽 화살표는 한 메시지의 이미지 안에서 순환한다. */
export function nextImageLightboxIndex(
  current: number,
  count: number,
  key: string
): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return null;
}

/** 비동기 작업 상태를 현재 선택이 아니라 시작한 첨부 ID에 귀속한다. */
export function updateAttachmentIdSet(
  current: ReadonlySet<string>,
  attachmentId: string,
  present: boolean
): Set<string> {
  const next = new Set(current);
  if (present) next.add(attachmentId);
  else next.delete(attachmentId);
  return next;
}

const SENT_SAME_YEAR = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const SENT_OTHER_YEAR = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * 위 왼쪽 칩의 둘째 줄: 보낸 날짜·시각(「10월 29일 오후 2:43」). 올해가 아니면 연도가 앞에 붙는다.
 * 시각을 모르면(아직 서버 시각이 없는 echo 행) `null`이고, 칩은 그 줄을 그리지 않는다. 시각을 지어내지 않는다.
 */
export function lightboxSentAtLabel(
  atMs: number | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return null;
  const sameYear = new Date(atMs).getFullYear() === new Date(nowMs).getFullYear();
  return (sameYear ? SENT_SAME_YEAR : SENT_OTHER_YEAR).format(new Date(atMs));
}

/**
 * 위 왼쪽 칩의 두 줄. 첫 줄은 **보낸 사람**(굵게), 둘째 줄은 날짜·시각이다. 파일 이름은 칩의 툴팁과 보조 글(대화상자
 * 이름)로 내려갔다. 보낸 사람을 모르면 첫 줄이 파일 이름이다: 칩이 빈 채로 서지 않는다.
 */
export function lightboxInfoLines({
  senderName,
  sentAtMs,
  fileName,
  nowMs,
}: {
  senderName?: string | null | undefined;
  sentAtMs?: number | null | undefined;
  fileName: string;
  nowMs?: number;
}): { primary: string; secondary: string | null; fileName: string } {
  const sender = senderName?.trim() ?? "";
  return {
    primary: sender === "" ? fileName : sender,
    secondary: lightboxSentAtLabel(sentAtMs, nowMs),
    fileName,
  };
}

/** 아래 가운데 캡션. 두 장 이상일 때만 선다: 「3장 중 2번」. */
export function lightboxPositionLabel(index: number, count: number): string {
  return `${count}장 중 ${index + 1}번`;
}

// =============================================================================
// 확대 (#4770). 순수 계산만 둔다: 배율·이동·키·글자. DOM 읽기와 이벤트는 `useImageLightboxZoom.ts`가 한다.
//
// 배율은 **맞춤 크기가 1**이다(사진이 무대 안에 `object-contain`으로 서 있는 크기). 범위는 1~4배다. 사진은 가운데를 축으로
// `translate(x, y) scale(zoom)`으로 변환되고, (x, y)는 화면 픽셀이다. 칩에 적는 비율은 사진의 자연 크기 대비 %다
// (실제 크기 = 100%).
// =============================================================================

/** 맞춤. 이보다 작아질 수 없다. */
export const LIGHTBOX_MIN_ZOOM = 1;
/** 맞춤의 4배. */
export const LIGHTBOX_MAX_ZOOM = 4;
/** 두 번 클릭할 때 사진이 무대보다 작아 「실제 크기」가 곧 맞춤이면 서는 배율. */
export const LIGHTBOX_SMALL_PHOTO_ZOOM = 2;
/** ⌘+ · ⌘- 한 번이 곱하는 배율. */
export const LIGHTBOX_KEY_ZOOM_STEP = 1.25;

/** 이 안쪽의 차이는 맞춤으로 읽는다(부동소수 찌꺼기로 「맞춤」이 안 되는 일을 막는다). */
const FIT_EPSILON = 0.01;
/** 휠·핀치 한 사건이 바꾸는 배율의 속도: 픽셀 델타 1당 e^0.01배. */
const WHEEL_ZOOM_RATE = 0.01;
/**
 * 한 사건의 델타 상한(px). ⌘를 누른 마우스 휠 한 칸은 ±100으로 오는데, 자르지 않으면 한 칸에 맞춤에서 4배로 뛴다.
 * 상한에서 한 사건의 배율은 0.80~1.25다. 트랙패드 핀치는 한 사건이 ±1~15라 이 상한에 닿지 않는다.
 */
const WHEEL_MAX_STEP = 22;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;

export interface LightboxView {
  /** 맞춤 대비 배율(1~4). */
  zoom: number;
  /** 사진 중심이 맞춤 자리에서 벗어난 화면 픽셀. */
  x: number;
  y: number;
}

export const LIGHTBOX_FIT_VIEW: LightboxView = { zoom: LIGHTBOX_MIN_ZOOM, x: 0, y: 0 };

/** 한 순간의 치수. 전부 같은 좌표계(뷰어 왼쪽 위가 원점, CSS px)이고, 사진은 변환 **전** 맞춤 상태의 값이다. */
export interface LightboxGeometry {
  photoWidth: number;
  photoHeight: number;
  /** 맞춤 자리에 선 사진 중심. */
  centerX: number;
  centerY: number;
  /** 뷰어(창) 크기. 확대한 사진은 패딩이 아니라 창 전체를 기준으로 움직인다. */
  viewWidth: number;
  viewHeight: number;
}

export function clampLightboxZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return LIGHTBOX_MIN_ZOOM;
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, zoom));
}

/** 맞춤으로 읽을 수 있는 배율인가. */
export function isLightboxFit(zoom: number): boolean {
  return zoom <= LIGHTBOX_MIN_ZOOM + FIT_EPSILON;
}

/**
 * 휠·핀치 한 사건이 곱하는 배율. 트랙패드 핀치는 `ctrlKey`가 붙은 `wheel`로 오고, 펴면(확대) `deltaY`가 음수다.
 * 줄·쪽 단위(`deltaMode` 1·2, 파이어폭스의 마우스 휠)는 픽셀로 바꾼 뒤 같은 상한을 쓴다.
 */
export function lightboxWheelFactor(deltaY: number, deltaMode: number = 0): number {
  const px =
    deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * WHEEL_PAGE_PX : deltaY;
  if (!Number.isFinite(px)) return 1;
  const bounded = Math.min(WHEEL_MAX_STEP, Math.max(-WHEEL_MAX_STEP, px));
  return Math.exp(-bounded * WHEEL_ZOOM_RATE);
}

/** ⌘+ · ⌘- 한 번. 맞춤 가까이에서는 맞춤에 딱 붙는다(⌘-가 1.01배에 멈추지 않는다). */
export function stepLightboxZoom(zoom: number, direction: 1 | -1): number {
  const next = clampLightboxZoom(zoom * LIGHTBOX_KEY_ZOOM_STEP ** direction);
  return isLightboxFit(next) ? LIGHTBOX_MIN_ZOOM : next;
}

/**
 * 두 번 클릭으로 가는 「실제 크기」(자연 크기의 100%) 배율. `fitScale`은 맞춤 상태에서 그려진 너비 / 자연 너비다.
 * 사진이 무대보다 작거나(맞춤이 이미 100% 이상) 크기를 모르면 2배다. 아주 큰 사진은 실제 크기가 4배를 넘을 수 있고, 그때는 4배에서
 * 멈춘다(칩이 100%가 아닌 실제 비율을 말한다).
 */
export function lightboxActualSizeZoom(fitScale: number | null): number {
  if (fitScale === null || !(fitScale > 0) || fitScale >= 1) return LIGHTBOX_SMALL_PHOTO_ZOOM;
  return clampLightboxZoom(1 / fitScale);
}

/** 칩의 글자. 맞춤이면 「맞춤」, 아니면 자연 크기 대비 비율(「150%」). 자연 크기를 모르면 맞춤 대비로 읽는다. */
export function lightboxZoomLabel(zoom: number, fitScale: number | null): string {
  if (isLightboxFit(zoom)) return "맞춤";
  const scale = fitScale !== null && fitScale > 0 ? fitScale : 1;
  return `${Math.round(zoom * scale * 100)}%`;
}

export type LightboxZoomKeyAction = "in" | "out" | "fit";

/**
 * ⌘+ · ⌘- · ⌘0 (Windows·Linux는 Ctrl). 눈에 보이는 글자(`key`)와 물리 키(`code`) 어느 쪽이든 맞으면 받는다: 미국 배열의 ⌘=은
 * `key`가 「=」이고, 독일 배열의 ⌘+는 `code`가 `Equal`이 아니다. ⌥가 붙은 조합은 받지 않는다.
 */
export function lightboxZoomKeyAction(event: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): LightboxZoomKeyAction | null {
  if (!(event.metaKey === true || event.ctrlKey === true) || event.altKey === true) return null;
  const { key, code } = event;
  if (key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") return "out";
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "fit";
  return null;
}

/**
 * 한 축의 이동 한계. `half`는 확대한 사진 길이의 절반, `center`는 맞춤 자리 중심, `extent`는 뷰어 길이다.
 *   창보다 긴 쪽: 사진 가장자리가 창 가장자리 안쪽으로 들어오지 못한다(창을 늘 덮는다).
 *   창보다 짧은 쪽: 움직이지 못하고 맞춤 자리에 있다. 맞춤 자리가 창 밖으로 나가면 들어올 만큼만 밀린다.
 * 두 규칙은 사진 길이가 창 길이와 같아지는 순간 같은 한 점으로 만난다(끊김 없음).
 */
function clampLightboxAxis(offset: number, half: number, center: number, extent: number): number {
  const farLimit = extent - center - half;
  const nearLimit = half - center;
  if (farLimit > nearLimit) return Math.min(Math.max(0, nearLimit), farLimit);
  return Math.min(Math.max(offset, farLimit), nearLimit);
}

/** 확대한 사진이 창 밖으로 사라지지 않게 이동을 자른다. 맞춤이면 늘 (0, 0)이다. */
export function clampLightboxView(view: LightboxView, geometry: LightboxGeometry): LightboxView {
  const zoom = clampLightboxZoom(view.zoom);
  if (isLightboxFit(zoom)) return LIGHTBOX_FIT_VIEW;
  return {
    zoom,
    x: clampLightboxAxis(view.x, (geometry.photoWidth * zoom) / 2, geometry.centerX, geometry.viewWidth),
    y: clampLightboxAxis(view.y, (geometry.photoHeight * zoom) / 2, geometry.centerY, geometry.viewHeight),
  };
}

/**
 * `anchor`(뷰어 좌표, 커서) 아래에 있던 사진의 점이 확대 뒤에도 같은 자리에 있게 배율을 바꾼다. 사진 중심을 축으로 한
 * `translate(t) scale(z)`에서 그 점은 (anchor - center - t) / z이고, 이것을 지키면
 *   t1 = t0 * r + (anchor - center) * (1 - r),  r = z1 / z0
 * 이다. 그 뒤 창 밖으로 나가지 않게 자른다.
 */
export function zoomLightboxViewAt(
  view: LightboxView,
  nextZoom: number,
  anchor: { x: number; y: number },
  geometry: LightboxGeometry
): LightboxView {
  const zoom = clampLightboxZoom(nextZoom);
  if (isLightboxFit(zoom)) return LIGHTBOX_FIT_VIEW;
  const ratio = zoom / view.zoom;
  const dx = anchor.x - geometry.centerX;
  const dy = anchor.y - geometry.centerY;
  return clampLightboxView(
    { zoom, x: view.x * ratio + dx * (1 - ratio), y: view.y * ratio + dy * (1 - ratio) },
    geometry
  );
}
