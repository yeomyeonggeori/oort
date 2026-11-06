import { expressionsForPickerTab, type ExpressionPickerTab } from "./kind";
import { searchExpressions } from "./search";
import type { Expression } from "./types";
import { recentExpressions, type ExpressionUsage } from "./usage";

// =============================================================================
// 한 탭에 보이는 표현의 차례 (#5453, owner 2026-11-07). 웹 고르개와 폰 시트가 같은 함수로 줄을 세운다.
//
//   검색어가 있으면  코어 검색의 관련도 차례 그대로다(이름 정확 > 앞부분 > 태그 > 부분·초성, 같으면 많이 쓴 것).
//   검색어가 없으면  ① 즐겨찾기(고른 차례)  ② 최근에 쓴 것(마지막으로 쓴 시각 내림차순)  ③ 나머지(코어 검색의 기본 차례).
//
// 한 등록은 한 번만 선다(즐겨찾기이면서 최근이어도 ①에만). 탭 밖의 등록은 이름이 맞아도 들이지 않는다(`expressionsForPickerTab`).
// 순수 모듈이다. 즐겨찾기를 **저장하는 곳은 아직 없다**: 호출부가 `favorites`에 id 배열을 넘기고, 넘기지 않으면 ①이 비어 있을 뿐이다.
// 별표를 눌러 저장하는 일은 v1 선택이라(#5452) 여기서 열지 않는다.
// =============================================================================

export interface ExpressionBrowseOptions {
  /** 검색어. 앞뒤 콜론(`:name:`)은 이름 검색으로 읽는다. */
  query?: string;
  usage?: ExpressionUsage;
  /** 즐겨찾기한 등록의 id, 고른 차례. 이 탭에 없는 id는 건너뛴다. */
  favorites?: readonly string[];
}

/** 검색어의 앞뒤 콜론(`:name:`)은 이름 검색으로 읽는다. */
export function expressionBrowseQuery(query: string): string {
  return query.replace(/^:|:$/g, "");
}

export function orderExpressionsForTab(
  items: readonly Expression[],
  tab: ExpressionPickerTab,
  options: ExpressionBrowseOptions = {},
): Expression[] {
  const query = expressionBrowseQuery(options.query ?? "");
  // 검색은 활성 등록만 남기고 관련도 차례를 매긴다. 그 차례 그대로 탭 몫만 남긴다.
  const found = expressionsForPickerTab(searchExpressions(items, query, options.usage), tab);
  if (query.trim() !== "") return found;
  const byId = new Map(found.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const front: Expression[] = [];
  const place = (id: string) => {
    const item = byId.get(id);
    if (item === undefined || placed.has(id)) return;
    placed.add(id);
    front.push(item);
  };
  for (const id of options.favorites ?? []) place(id);
  if (options.usage) for (const entry of recentExpressions(options.usage, new Set(byId.keys()))) place(entry.id);
  return [...front, ...found.filter((item) => !placed.has(item.id))];
}
