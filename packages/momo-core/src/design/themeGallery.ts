// =============================================================================
// 갤러리 목록과 단일 모드 규칙 1 (AP-1b #4188, 청사진 §5.2-a·§5.3-c, Buzz `SettingsPanels.tsx`·`handleSelectTheme`).
//
// 이 파일은 **갤러리(지연 청크)만** 쓴다. 메인 번들이 읽는 `themeResolve.ts`에 두면 쓰이지 않는 메인 번들에도 실린다
// (번들 예산, `gate:theme-bundle`). 규칙 2·3과 카탈로그 색인은 `themeResolve.ts`에 남아 있다.
// =============================================================================

import type { SchemeChoice } from "./appearance";
import { THEME_CATALOG } from "./themeCatalog.generated";
import { modesOf, splitThemeRef, type ModesLookup, type ThemeRef } from "./themeResolve";
import { THEME_IDS, THEME_LABELS, isThemeId, type Mode } from "./themes";

// ---- 갤러리 목록 (Buzz의 탭: 색 모드가 목록을 정한다) --------------------------------------------------------
//
// 갤러리에는 별도 탭이 없다. 색 모드(시스템·라이트·다크)가 곧 탭이고 목록이 따라간다:
//   시스템  라이트·다크 짝이 있는 테마만(한 장이 라이트·다크 대각 분할). 첫 파티 3 + 카탈로그 쌍 16 = 19
//   라이트  그 모드를 가진 테마 전부(쌍의 라이트 쪽 포함)                  첫 파티 3 + 16 + 라이트 단독 1 = 20
//   다크    그 모드를 가진 테마 전부                                       첫 파티 3 + 16 + 다크 단독 24 = 43
// 정렬은 첫 파티 먼저, 그다음 id 순이다(색인이 id 순).

export interface GalleryTile {
  readonly ref: ThemeRef;
  readonly label: string;
  /** `split`: 한 장에 두 모드를 대각 분할로 그린다. 아니면 그 모드 한 장이다. */
  readonly kind: "split" | Mode;
}

export function galleryTiles(scheme: SchemeChoice): GalleryTile[] {
  const tiles: GalleryTile[] = [];
  const kind = scheme === "system" ? "split" : scheme;
  for (const id of THEME_IDS) tiles.push({ ref: id, label: THEME_LABELS[id], kind });
  for (const entry of THEME_CATALOG) {
    const both = entry.light !== undefined && entry.dark !== undefined;
    if (scheme === "system" ? both : both || entry[scheme] !== undefined) {
      tiles.push({ ref: `catalog:${entry.id}`, label: entry.label, kind });
    }
  }
  return tiles;
}

/** 화면에 쓰는 테마 이름. 첫 파티는 한국어 이름, 카탈로그는 항목의 라벨, 사용자 테마는 id다(이름은 AP-5의 저장소가 안다). */
export function themeLabel(ref: ThemeRef): string {
  if (isThemeId(ref)) return THEME_LABELS[ref];
  const parts = splitThemeRef(ref);
  if (parts === null) return THEME_LABELS.dawnsky;
  return parts.namespace === "catalog"
    ? (THEME_CATALOG.find((entry) => entry.id === parts.id)?.label ?? parts.id)
    : parts.id;
}

// ---- 단일 모드 규칙 1 ------------------------------------------------------------------------------------

/**
 * 규칙 1. 단일 모드 테마를 고르면 색 모드를 그 모드로 맞춘다(`adjusted`가 그 모드, 안 맞출 때 `null`).
 * 두 모드를 다 가진 테마는 고른 색 모드를 건드리지 않는다.
 */
export function schemeForThemePick(
  scheme: SchemeChoice,
  picked: ThemeRef,
  lookup?: ModesLookup
): { scheme: SchemeChoice; adjusted: Mode | null } {
  const modes = modesOf(picked, lookup);
  if (modes.length === 1 && scheme !== modes[0]) return { scheme: modes[0], adjusted: modes[0] };
  return { scheme, adjusted: null };
}

const MODE_NAMES: Readonly<Record<Mode, string>> = { light: "라이트", dark: "다크" };

/** 규칙 1이 색 모드를 맞췄을 때의 한 줄. */
export function pickNotice(mode: Mode): string {
  return `이 테마는 ${MODE_NAMES[mode]}만 있어서 색 모드를 ${MODE_NAMES[mode]}로 맞췄어요.`;
}

