// =============================================================================
// 팀 표현의 즐겨찾기 (owner 2026-11-07, #5453). 이 기기 · 이 워크스페이스 · 이 사람 기준의 **로컬 목록**이다 - 서버 계약은 없다.
//
// 저장은 `ExpressionStore` 가 `oort.expressions.favorites:<워크스페이스>:<사람>` 한 키에 한다(사용 기록 `usage` 와 같은 자리 규칙). 이 모듈은 값의 모양과 바꾸는 법만
// 가진다: 순수 함수라 DOM·저장소가 없다. 저장된 값은 믿지 않는다 - 다른 계정·다른 워크스페이스의 값과 깨진 값은 비어 있는 목록이 된다(`restoreExpressionUsage` 와 같다).
// 차례는 **고른 차례**(나중에 고른 것이 뒤)다. 지워지거나 숨겨진 등록의 id는 목록에 남아도 화면이 거른다(코어 `orderExpressionsForTab` 이 이 탭에 없는 id를 건너뛴다).
// =============================================================================

export interface ExpressionFavorites {
  v: 1;
  workspaceId: string;
  memberId: string;
  /** 즐겨찾기한 등록의 id, 고른 차례. */
  ids: string[];
}

/** 한 사람이 쥘 수 있는 즐겨찾기 수. 넘치면 가장 먼저 고른 것부터 밀려난다. */
export const MAX_EXPRESSION_FAVORITES = 200;

export function emptyExpressionFavorites(workspaceId: string, memberId: string): ExpressionFavorites {
  return { v: 1, workspaceId, memberId, ids: [] };
}

/** 저장소에서 읽은 값(믿지 않는 입력). 다른 계정의 값과 깨진 값은 빈 목록이다. */
export function restoreExpressionFavorites(value: unknown, workspaceId: string, memberId: string): ExpressionFavorites {
  const empty = emptyExpressionFavorites(workspaceId, memberId);
  if (!value || typeof value !== "object") return empty;
  const data = value as Partial<ExpressionFavorites>;
  if (data.v !== 1 || data.workspaceId !== workspaceId || data.memberId !== memberId || !Array.isArray(data.ids)) return empty;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of data.ids) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ...empty, ids: ids.slice(-MAX_EXPRESSION_FAVORITES) };
}

export function isExpressionFavorite(favorites: ExpressionFavorites, id: string): boolean {
  return favorites.ids.includes(id);
}

/** 있으면 빼고 없으면 끝에 더한다. 빈 id는 건드리지 않는다. */
export function toggleExpressionFavorite(favorites: ExpressionFavorites, id: string): ExpressionFavorites {
  if (id === "") return favorites;
  if (favorites.ids.includes(id)) return { ...favorites, ids: favorites.ids.filter((entry) => entry !== id) };
  return { ...favorites, ids: [...favorites.ids, id].slice(-MAX_EXPRESSION_FAVORITES) };
}
