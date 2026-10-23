// =============================================================================
// 색 역할 이름 목록 (표 §2). `themes.ts`가 같은 이름으로 다시 내보낸다(기존 가져오기는 그대로 선다).
//
// 따로 둔 이유: 값 표(`themes.ts`)는 웹 메인 번들에 실리는데, 이 이름 목록은 파생 엔진(지연 청크)과 생성기·시험만
// 읽는다. 목록이 `themes.ts`에 있으면 지연 청크가 쓴다는 이유로 메인 번들에 gzip 150B가 얹힌다(AP-1b #4188 번들 예산).
// =============================================================================

/** 표 §2의 색 역할(바닥·띠 제외). 모든 테마가 같은 목록을 든다. */
export const COLOR_ROLES = [
  "surface",
  "surface-muted",
  "sheet",
  "ink",
  "ink-muted",
  "icon",
  "line",
  "line-strong",
  "primary",
  "on-primary",
  "signal",
  "on-signal",
  "signal-text",
  "signal-soft",
  "agent",
  "agent-soft",
  "ok",
  "ok-soft",
  "warn",
  "warn-soft",
  "danger",
  "danger-soft",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const BAND_ROLES = ["band", "on-band", "on-band-muted"] as const;
export type BandRole = (typeof BAND_ROLES)[number];

export const CANVAS_STOPS = ["canvas-top", "canvas-mid", "canvas-bottom"] as const;
export type CanvasStop = (typeof CANVAS_STOPS)[number];

export const DERIVED_ROLES = [
  "surface-hover",
  "surface-pressed",
  "muted-soft",
  "danger-fill",
  "on-danger-fill",
] as const;
export type DerivedRole = (typeof DERIVED_ROLES)[number];
