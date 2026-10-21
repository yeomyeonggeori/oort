// =============================================================================
// 루트 속성 스탬프 규칙 표 (AP-1a #4186, 청사진 §5.7.2 AC 2).
//
// 외양 레코드 한 벌이 `<html>`에 찍는 속성이 무엇인지를 **한 곳**에 적는다. 이 표를 읽는
// 자리는 둘이다: 런타임 정본 `clients/web/src/design/theme.ts`(`applyAppearance`)와 첫
// 페인트 전에 도는 고전 스크립트 `clients/web/public/theme-boot.js`. 스크립트는 번들을
// 부를 수 없어 이 표를 손으로 옮긴 거울이고, 둘이 어긋나지 않는지는 웹 `theme.test.ts`가
// 부트 스크립트를 실제로 실행해 같은 입력 표로 비교한다.
//
// | 속성 | 값 | 없을 때(`null`) |
// |---|---|---|
// | `data-theme` | 유효 스킴 `light`·`dark` | 시스템을 따른다(`effectiveScheme`) |
// | `data-palette` | 첫 파티 id 또는 `derived` | (항상 있다) |
// | `data-theme-ref` | 저장된 테마 참조 | (항상 있다) |
// | `data-signal` | 프리셋 id, 직접 고른 색이면 `custom` | 테마 기본 신호 |
// | `data-accent` | 프리셋 id 또는 `dawn` (ADR-0174 이행용 옛 속성) | (항상 있다) |
// | `data-density` | `comfortable`·`compact` | (항상 있다) |
// | `data-font-size` | `smaller`·`default`·`larger` | (항상 있다) |
// | `data-thread-layout` | `split`·`focus` | (항상 있다) |
// | `data-prominent-active` | 빈 문자열(존재만 의미) | 꺼짐 |
// | `data-wallpaper` | `solid`·`preset`·`image` | 배경 없음 |
//
// **`data-glass`는 이 표에 없다.** 이름은 `ROOT_ATTRIBUTES.glass`로 예약돼 있지만, 켜는 순간은
// 네이티브 vibrancy 적용이 **성공한 뒤**여야 한다(청사진 §5.4-b: 투명 바닥이 먼저 서면 창 뒤가
// 비친다). 그 판정은 AP-3(#4190)의 몫이라 저장소는 이 속성을 찍지도 지우지도 않는다.
// (planner 결정 2026-10-22: AC 2 문면 「열 속성 전부」를 아홉으로 읽는다.)
//
// 아직 CSS가 읽지 않는 속성(`data-density`·`data-font-size` 등)을 먼저 찍는 것은 **보이는
// 변화 0**이다. 읽는 규칙은 각 소비자 이슈가 `design/appearance/*.css` 조각에 더한다.
// =============================================================================

import {
  DEFAULT_FONT_SIZE_ID,
  DEFAULT_THREAD_LAYOUT_ID,
  ROOT_ATTRIBUTES,
  type AppearanceV2,
  type SignalChoice,
} from "./appearance";
import { isSignalPresetId, type SignalPresetId } from "./signal";
import { effectiveScheme, modesOf, paletteOf, type ModeSet, type ThemeRef } from "./themeResolve";
import type { Mode } from "./themes";

/** ADR-0174 액센트 id를 신호 프리셋으로 옮겨 가는 동안 `themes/<id>.css`가 읽는 옛 속성. */
export const LEGACY_ACCENT_ATTRIBUTE = "data-accent";

/** 옛 액센트 id에서 신호 프리셋이 아닌 기본(새벽). */
export const DEFAULT_ACCENT_NAME = "dawn";

/** 저장소가 찍는 속성 이름 전부. `data-glass`는 일부러 없다(위 설명). */
export const STAMPED_ATTRIBUTES = [
  ROOT_ATTRIBUTES.scheme,
  ROOT_ATTRIBUTES.palette,
  ROOT_ATTRIBUTES.themeRef,
  ROOT_ATTRIBUTES.signal,
  LEGACY_ACCENT_ATTRIBUTE,
  ROOT_ATTRIBUTES.density,
  ROOT_ATTRIBUTES.fontSize,
  ROOT_ATTRIBUTES.threadLayout,
  ROOT_ATTRIBUTES.prominentActive,
  ROOT_ATTRIBUTES.wallpaper,
] as const;

export type StampedAttribute = (typeof STAMPED_ATTRIBUTES)[number];

/** 속성 이름 → 값. `null`은 「속성을 지운다」. 스킴 칸은 모드로 좁혀 둔다(`applyTheme`에 그대로 넘긴다). */
export type RootStamp = Readonly<Record<StampedAttribute, string | null>> & {
  readonly [ROOT_ATTRIBUTES.scheme]: Mode | null;
};

/** `data-signal` 값. 프리셋은 id, 직접 고른 색은 `custom`(색 자체는 인라인 변수가 나른다). */
export function signalStamp(signal: SignalChoice): string | null {
  if (signal === null) return null;
  return "preset" in signal ? signal.preset : "custom";
}

/** 옛 `data-accent` 값. 직접 고른 색은 정적 바인딩이 없어 기본이다. */
export function accentOfSignal(signal: SignalChoice): typeof DEFAULT_ACCENT_NAME | SignalPresetId {
  return signal !== null && "preset" in signal ? signal.preset : DEFAULT_ACCENT_NAME;
}

/** 옛 액센트 id → 신호 선택. 프리셋이 아니면 테마 기본 신호(`null`). */
export function signalOfAccent(accent: unknown): SignalChoice {
  return isSignalPresetId(accent) ? { preset: accent } : null;
}

/**
 * 레코드 한 벌의 스탬프. `modes`는 테마가 가진 모드이고(카탈로그가 알려 준다), 주지 않으면
 * `modesOf(state.theme)`다. 순수 함수라 DOM 없이 규칙 전체를 잴 수 있다.
 */
export function rootStamp(
  state: Pick<
    AppearanceV2<ThemeRef>,
    | "scheme"
    | "theme"
    | "signal"
    | "density"
    | "fontSize"
    | "threadLayout"
    | "prominentActive"
    | "wallpaper"
  >,
  modes: ModeSet = modesOf(state.theme)
): RootStamp {
  return {
    [ROOT_ATTRIBUTES.scheme]: effectiveScheme(state.scheme, modes),
    [ROOT_ATTRIBUTES.palette]: paletteOf(state.theme),
    [ROOT_ATTRIBUTES.themeRef]: state.theme,
    [ROOT_ATTRIBUTES.signal]: signalStamp(state.signal),
    [LEGACY_ACCENT_ATTRIBUTE]: accentOfSignal(state.signal),
    [ROOT_ATTRIBUTES.density]: state.density,
    [ROOT_ATTRIBUTES.fontSize]: state.fontSize ?? DEFAULT_FONT_SIZE_ID,
    [ROOT_ATTRIBUTES.threadLayout]: state.threadLayout ?? DEFAULT_THREAD_LAYOUT_ID,
    [ROOT_ATTRIBUTES.prominentActive]: state.prominentActive ? "" : null,
    [ROOT_ATTRIBUTES.wallpaper]: state.wallpaper ? state.wallpaper.kind : null,
  };
}
