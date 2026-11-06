import {type MessageSearchHit} from '@momo/core/lib/api';
import {type SearchPhase} from '@momo/core/features/search/searchModel';

import {useSearchWiring} from './useSearchWiring';

// =============================================================================
// 홈 검색 탭의 메시지 검색 (#5365). 디바운스·서버 요청·쪽 넘김·상태 판정은 전부 `useSearchWiring` 에 있다(대화 안 검색 `useConversationSearch` 와 같은 한 벌, #5384) —
// 이 훅은 그 위에서 화면이 쓰는 모양(`MessageSearch`)으로 내주기만 한다. 입력값이 동기인 이유·2자 미만이 기기를 안 떠나는 이유·범위가 캐시 키에 드는 이유는 그 파일 머리말에 있다.
//
// 범위와 종류는 화면이 정하고(`options`), 이 훅은 그 값을 받아 부를 뿐이다: `channelId` 가 있으면 그 대화 하나만, `enabled: false` 는 화면이 「채널」·「사람」 칩에 있을 때다.
// =============================================================================

export interface MessageSearch {
  /** 입력창이 그대로 되읽는 값. 동기. */
  query: string;
  setQuery: (next: string) => void;
  /** 이미 다 친 말로 바꾼다(최근 검색을 고른 것) — 요청이 디바운스를 기다리지 않는다. */
  setQueryNow: (next: string) => void;
  /** 화면이 보고 그리는 단 하나의 상태. */
  phase: SearchPhase;
  /** 이 결과가 어떤 질의에 대한 것인지 — 문구가 인용할 값. */
  settledQuery: string;
  hits: MessageSearchHit[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

export interface MessageSearchOptions {
  /** 이 대화 하나로 좁혀 찾는다. 없으면 내가 든 모든 대화. */
  channelId?: string;
  /** `false` 면 서버를 부르지 않는다(기본은 켜짐). */
  enabled?: boolean;
}

export function useMessageSearch(
  workspaceId: string,
  /** 사이드바(또는 대화 안 검색의 「모든 대화에서」)가 이미 친 말. 사람이 두 번 타이핑하지 않게 들고 온다. */
  initialQuery = '',
  options: MessageSearchOptions = {},
): MessageSearch {
  return useSearchWiring({
    workspaceId,
    initialQuery,
    channelId: options.channelId,
    enabled: options.enabled ?? true,
  });
}
