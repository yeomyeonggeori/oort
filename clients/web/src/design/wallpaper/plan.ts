import type { WallpaperRef } from "@momo/core/design/appearance";
import { MODES, type Mode } from "@momo/core/design/themes";
import {
  WALLPAPER_PRESETS,
  WALLPAPER_SOLIDS,
  isKnownWallpaper,
  resolveWallpaper,
  wallpaperTreatment,
  wallpaperVars,
  type PresetId,
  type SolidId,
  type WallpaperDecision,
  type WallpaperTreatment,
} from "@momo/core/design/wallpaper";
import type { DomTokens } from "./domTokens";
import type { PhotoView } from "./store";

// =============================================================================
// 지금 무엇을 어떻게 깔 것인가: 입력 → 계획 (ADR-0189 증보 3 D4, AP-4 #4191).
//
// 순수 함수다. 입력은 고른 것(참조), 지금 모드, 화면에서 읽은 테마 색, 시스템 접근성 두 가지, 사진 상태이고,
// 출력은 「깔아도 되는가와 이유」·루트에 꽂을 변수·배경 요소에 칠할 값이다. DOM을 만지는 일은 `runtime.ts`가 하고,
// 이 파일은 그 판단이 맞는지를 DOM 없이 잰다.
// =============================================================================

/** 배경 요소(`[data-wallpaper-layer]`)에 CSSOM으로 칠할 두 값. 사진의 `backgroundImage`는 약 2MB 문자열이다. */
export interface LayerPaint {
  backgroundColor: string;
  backgroundImage: string;
  /** 같은 그림이면 같은 키다. 큰 문자열을 비교하지 않고 다시 칠할지를 가린다. */
  key: string;
}

export interface WallpaperPlan {
  ref: WallpaperRef | undefined;
  mode: Mode;
  /** 화면에서 테마의 색을 읽었는가. 못 읽었으면 대비를 보장할 수 없어 깔지 않는다. */
  resolved: boolean;
  /** 지금 모드의 처리 결과. 색을 못 읽었으면 `null`. */
  treatment: WallpaperTreatment | null;
  hasBand: boolean;
  decision: WallpaperDecision;
  /** 루트에 꽂을 변수(두 모드). 깔 때만 쓰인다. */
  vars: Readonly<Record<string, string>>;
  /** 깔 때 배경 요소에 칠할 값. 깔지 않으면 `null`. */
  paint: LayerPaint | null;
}

export interface PlanInput {
  ref: WallpaperRef | undefined;
  mode: Mode;
  dom: DomTokens | null;
  reduceTransparency: boolean;
  increaseContrast: boolean;
  photo: PhotoView;
}

export const EMPTY_PLAN: WallpaperPlan = {
  ref: undefined,
  mode: "light",
  resolved: false,
  treatment: null,
  hasBand: false,
  decision: { live: false, reason: null },
  vars: {},
  paint: null,
};

function paintOf(ref: WallpaperRef, photo: PhotoView): LayerPaint | null {
  if (ref.kind === "solid") {
    const entry = WALLPAPER_SOLIDS[ref.id as SolidId];
    return { backgroundColor: entry.hex, backgroundImage: "none", key: `solid:${ref.id}` };
  }
  if (ref.kind === "preset") {
    const entry = WALLPAPER_PRESETS[ref.id as PresetId];
    return { backgroundColor: entry.fallback, backgroundImage: entry.gradient, key: `preset:${ref.id}` };
  }
  if (photo.status !== "ready") return null;
  // 사진 밑에 깔 색은 CSS가 바닥색으로 준다(비워 둔다): 디코드가 끝나기 전 한 프레임이 바닥과 같다.
  return { backgroundColor: "", backgroundImage: `url("${photo.dataUrl}")`, key: `image:${photo.rev}` };
}

export function planWallpaper(input: PlanInput): WallpaperPlan {
  const treatments: Partial<Record<Mode, WallpaperTreatment>> = {};
  if (input.dom !== null) {
    for (const mode of MODES) treatments[mode] = wallpaperTreatment(input.dom.byMode[mode], mode);
  }
  const treatment = treatments[input.mode] ?? null;
  const known = isKnownWallpaper(input.ref);
  const decision = resolveWallpaper({
    ref: input.ref,
    verdict: treatment?.verdict ?? null,
    reduceTransparency: input.reduceTransparency,
    increaseContrast: input.increaseContrast,
    photoReady: input.photo.status === "ready",
  });
  const live = decision.live && known && input.ref !== undefined;
  return {
    ref: input.ref,
    mode: input.mode,
    resolved: input.dom !== null,
    treatment,
    hasBand: input.dom?.hasBand ?? false,
    decision,
    vars: live ? wallpaperVars(treatments) : {},
    paint: live && input.ref !== undefined ? paintOf(input.ref, input.photo) : null,
  };
}
