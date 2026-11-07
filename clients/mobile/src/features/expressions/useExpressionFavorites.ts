import {
  emptyExpressionFavorites,
  isExpressionFavorite,
  restoreExpressionFavorites,
  toggleExpressionFavorite,
  type ExpressionFavorites,
} from '@momo/core/features/expressions/favorites';
import {useCallback, useState} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import {useExpressions} from './ExpressionProvider';

// =============================================================================
// 팀 표현의 즐겨찾기 (#5452, 웹 #5453 의 짝) - 이 기기 · 이 워크스페이스 · 이 사람의 로컬 목록이다. 서버 계약이 없다.
//
// 값의 모양과 바꾸는 법은 코어(`favorites.ts`)가 갖는다. 이 파일은 폰의 저장소(MMKV)에 읽고 쓰는 일만 한다: 한 키에 `워크스페이스:사람` → 목록 지도 하나를 두어, 같은
// 기기에서 계정을 바꿔도 서로의 즐겨찾기를 지우지 않는다. 읽을 때 값을 믿지 않는다(깨진 값·다른 계정의 값은 빈 목록, 코어 `restoreExpressionFavorites`).
// 저장이 실패해도 고르는 흐름은 깨지지 않는다(목록은 이번 실행 동안만 산다).
// =============================================================================

const scopeKey = (workspaceId: string, memberId: string) => `${workspaceId.toLowerCase()}:${memberId.toLowerCase()}`;

function readMap(): Record<string, unknown> {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.expressionFavorites);
    const parsed: unknown = raw === undefined ? null : JSON.parse(raw);
    return parsed instanceof Object && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 이 사람의 즐겨찾기를 저장소에서 읽는다. */
export function readExpressionFavorites(workspaceId: string, memberId: string): ExpressionFavorites {
  return restoreExpressionFavorites(readMap()[scopeKey(workspaceId, memberId)], workspaceId, memberId);
}

/** 이 사람의 즐겨찾기를 저장소에 쓴다(다른 사람의 항목은 그대로). */
export function writeExpressionFavorites(favorites: ExpressionFavorites): void {
  try {
    const map = readMap();
    map[scopeKey(favorites.workspaceId, favorites.memberId)] = favorites;
    nonSecretStore().set(NON_SECRET_KEYS.expressionFavorites, JSON.stringify(map));
  } catch {
    // 즐겨찾기는 덤이다 - 못 남겨도 이번 실행에서는 그대로 쓴다.
  }
}

export function useExpressionFavorites(): {
  favorites: ExpressionFavorites;
  isFavorite: (id: string) => boolean;
  /** 켜고 끈다. 바뀐 뒤에 즐겨찾기인가를 돌려준다. */
  toggle: (id: string) => boolean;
} {
  const {store} = useExpressions();
  const workspaceId = store?.workspaceId ?? '';
  const memberId = store?.memberId ?? '';
  const [favorites, setFavorites] = useState<ExpressionFavorites>(() =>
    store === null ? emptyExpressionFavorites('', '') : readExpressionFavorites(workspaceId, memberId),
  );
  const toggle = useCallback(
    (id: string): boolean => {
      const next = toggleExpressionFavorite(favorites, id);
      setFavorites(next);
      if (store !== null) writeExpressionFavorites(next);
      return isExpressionFavorite(next, id);
    },
    [favorites, store],
  );
  const isFavorite = useCallback((id: string) => isExpressionFavorite(favorites, id), [favorites]);
  return {favorites, isFavorite, toggle};
}
