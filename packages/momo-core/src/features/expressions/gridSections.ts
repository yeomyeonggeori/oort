import type { MessageKey } from "../../i18n";
import { orderExpressionsForTab } from "./browse";
import type { ExpressionFavorites } from "./favorites";
import type { ExpressionPickerTab } from "./kind";
import { groupExpressionSets } from "./sets";
import type { Expression } from "./types";
import { recentExpressions, type ExpressionUsage } from "./usage";

// =============================================================================
// 이모티콘·GIF 탭의 그림 격자 모델 (owner 2026-11-07, #5453). 순수 모듈이다: DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다. 문장은 여기 없다(사전이 가진다).
//
// 구역(section): 최근 -> 즐겨찾기 -> 세트별 -> 기타. 검색어가 있으면 구역 없이 결과 하나다.
//   · 최근    이 탭의 등록 가운데 마지막으로 쓴 시각 내림차순 `EXPRESSION_RECENT_MAX` 개(사용 기록이 없으면 구역이 없다).
//   · 즐겨찾기  고른 차례. 비어 있으면 구역도 세트 띠의 ★도 없다.
//   · 세트    코어 `groupExpressionSets` (이름 앞머리 `<접두>_`, 2개 이상). 이름표는 공통 태그, 없으면 앞머리.
//   · 기타    세트가 되지 못한 낱개. 모든 등록은 세트 또는 기타에 정확히 한 번 서므로 어느 그림도 구역에서 빠지지 않는다.
// 최근·즐겨찾기는 같은 그림을 한 번 더 보이는 **바로가기**이고 세트·기타가 보관함 전체다.
// 격자는 한 줄 `EXPRESSION_GRID_COLS` 칸이다(팝오버 기준 6열).
// =============================================================================

export const EXPRESSION_GRID_COLS = 6;
/** 「최근」 구역의 길이(두 줄). */
export const EXPRESSION_RECENT_MAX = 12;

export type ExpressionSectionKind = "recent" | "favorites" | "set" | "other" | "results";

export interface ExpressionSection {
  /** 구역의 열쇠. 세트 띠의 단추와 스크롤 목적지가 같은 값을 쓴다. */
  id: string;
  kind: ExpressionSectionKind;
  /** 세트의 이름표(데이터). 나머지 구역의 이름은 사전이 가진다. */
  label: string | null;
  items: Expression[];
}

/** 구역의 이름을 가진 사전 열쇠. 세트의 이름표는 등록된 표현의 데이터라 열쇠가 없다. */
export const EXPRESSION_SECTION_NAME_KEY = {
  recent: "expressions.picker.sectionRecent",
  favorites: "expressions.picker.sectionFavorites",
  other: "expressions.picker.sectionOther",
  set: null,
  results: null,
} as const satisfies Record<ExpressionSectionKind, MessageKey | null>;

export const RECENT_SECTION = "recent";
export const FAVORITES_SECTION = "favorites";
export const OTHER_SECTION = "other";
export const RESULTS_SECTION = "results";
const setSectionId = (prefix: string) => `set:${prefix}`;

export function buildExpressionSections(
  cacheItems: readonly Expression[],
  tab: ExpressionPickerTab,
  options: { query: string; usage: ExpressionUsage; favorites: ExpressionFavorites },
): ExpressionSection[] {
  const { query, usage, favorites } = options;
  if (query.trim() !== "") {
    const items = orderExpressionsForTab(cacheItems, tab, { query, usage });
    return items.length === 0 ? [] : [{ id: RESULTS_SECTION, kind: "results", label: null, items }];
  }
  // 보관함 전체의 차례는 최근 사용에 흔들리지 않는다(사용 기록을 넘기지 않는다) - 세트 안의 그림이 쓸 때마다 자리를 바꾸지 않게.
  const all = orderExpressionsForTab(cacheItems, tab);
  const byId = new Map(all.map((item) => [item.id, item]));
  const sections: ExpressionSection[] = [];
  const recent = recentExpressions(usage, new Set(byId.keys()))
    .slice(0, EXPRESSION_RECENT_MAX)
    .flatMap((entry) => byId.get(entry.id) ?? []);
  if (recent.length > 0) sections.push({ id: RECENT_SECTION, kind: "recent", label: null, items: recent });
  const starred = favorites.ids.flatMap((id) => byId.get(id) ?? []);
  if (starred.length > 0) sections.push({ id: FAVORITES_SECTION, kind: "favorites", label: null, items: starred });
  const { sets, loose } = groupExpressionSets(all);
  for (const set of sets) sections.push({ id: setSectionId(set.prefix), kind: "set", label: set.label, items: set.items });
  if (loose.length > 0) sections.push({ id: OTHER_SECTION, kind: "other", label: null, items: loose });
  return sections;
}

/** 검색 칸에서 격자로 들어가는 키(아래 화살표). 들어가는 칸은 지금 탭 순서에 있는 칸(`EXPRESSION_GRID_ENTRY_SELECTOR`)이다. */
export function isGridEntryKey(key: string): boolean {
  return key === "ArrowDown";
}
/** 격자에서 탭 순서에 있는 한 칸(roving tabindex)을 가리키는 선택자. */
export const EXPRESSION_GRID_ENTRY_SELECTOR = '[data-pos][tabindex="0"]';

/**
 * 키보드로 칸 메뉴를 부르는 키(검수 7a H1, #5486): 전용 메뉴 키(윈도·리눅스 자판), 또는 그 키가 없는 자판의 표준 대체인 Shift+F10.
 * macOS WebKit(데스크탑 Tauri 의 엔진)은 두 키 어느 쪽에도 `contextmenu` 를 내지 않고 Chromium 은 메뉴 키에만 낸다. 그래서 화면이 키를 직접 듣는다.
 * Ctrl·Alt·⌘ 이 함께 눌린 F10 은 다른 단축키의 몫이라 가져가지 않는다.
 */
export function isContextMenuSummonKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (event.key === "ContextMenu") return true;
  return event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
/** 키로 부를 때 칸에 합성해 쏘는 이벤트의 이름. 칸의 메뉴 트리거가 오른쪽 클릭과 같은 이 이벤트로 메뉴를 연다. */
export const CONTEXT_MENU_EVENT = "contextmenu";

/** 격자 안의 자리: 몇 번째 구역의 몇 번째 칸. */
export interface GridPosition {
  section: number;
  index: number;
}

/**
 * 방향키로 옮긴 자리. 구역은 위에서 아래로 이어 붙은 하나의 격자처럼 움직인다:
 * 오른쪽 끝에서 오른쪽 = 다음 구역 처음, 아래 줄이 짧으면 그 줄의 끝, 마지막 줄에서 아래 = 다음 구역 첫 줄의 같은 열(없으면 그 줄의 끝).
 * Home/End는 격자 전체의 처음/끝이다. 갈 곳이 없으면 null(그 자리에 둔다).
 */
export function moveGridPosition(sizes: readonly number[], from: GridPosition, key: string, cols = EXPRESSION_GRID_COLS): GridPosition | null {
  const size = sizes[from.section] ?? 0;
  if (size === 0) return null;
  const col = from.index % cols;
  const row = Math.floor(from.index / cols);
  const lastRow = Math.floor((size - 1) / cols);
  const into = (section: number, index: number): GridPosition | null => (section === from.section && index === from.index ? null : { section, index });
  const nonEmpty = (section: number, step: 1 | -1) => {
    for (let at = section + step; at >= 0 && at < sizes.length; at += step) if ((sizes[at] ?? 0) > 0) return at;
    return -1;
  };
  switch (key) {
    case "ArrowRight": {
      if (from.index + 1 < size) return into(from.section, from.index + 1);
      const next = nonEmpty(from.section, 1);
      return next < 0 ? null : into(next, 0);
    }
    case "ArrowLeft": {
      if (from.index > 0) return into(from.section, from.index - 1);
      const prev = nonEmpty(from.section, -1);
      return prev < 0 ? null : into(prev, sizes[prev]! - 1);
    }
    case "ArrowDown": {
      if (row < lastRow) return into(from.section, Math.min(from.index + cols, size - 1));
      const next = nonEmpty(from.section, 1);
      return next < 0 ? null : into(next, Math.min(col, sizes[next]! - 1));
    }
    case "ArrowUp": {
      if (row > 0) return into(from.section, from.index - cols);
      const prev = nonEmpty(from.section, -1);
      if (prev < 0) return null;
      const prevLast = sizes[prev]! - 1;
      return into(prev, Math.min(Math.floor(prevLast / cols) * cols + col, prevLast));
    }
    case "Home": {
      const first = nonEmpty(-1, 1);
      return first < 0 ? null : into(first, 0);
    }
    case "End": {
      const last = nonEmpty(sizes.length, -1);
      return last < 0 ? null : into(last, sizes[last]! - 1);
    }
    default:
      return null;
  }
}
