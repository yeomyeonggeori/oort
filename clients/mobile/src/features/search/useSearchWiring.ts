import {
  searchMessages,
  type MessageSearchHit,
  type MessageSearchPage,
} from '@momo/core/lib/api';
import {
  isSearchable,
  normalizeQuery,
  searchPhase,
  searchQueryKey,
  type SearchPhase,
} from '@momo/core/features/search/searchModel';
import {useInfiniteQuery} from '@tanstack/react-query';
import {useCallback, useEffect, useMemo, useState} from 'react';

// =============================================================================
// 메시지 검색의 배선 — 홈 검색(`useMessageSearch`)과 대화 안 검색(`useConversationSearch`)이 **같이 쓰는 한 벌** (#5384).
//
// 두 훅이 디바운스·서버 요청·쪽 넘김·상태 판정을 각자 적어 두었다(#5364·#5365 두 칸이 따로 지었다). 이 훅이 그 겹치는 배선을 한 곳에 모은다: 규칙은 전부 코어
// (`@momo/core/features/search/searchModel`, goal B12 H5)에 있고 여기는 그 규칙을 react-query 에 잇는 일만 한다. 두 훅은 이 위에서 자기 몫만 더한다:
// 홈은 범위 칩·종류 칩, 대화 안은 검색 줄의 열림·결과 목록 ↔ 대화 두 보기·고른 결과의 번호.
//
// ## 입력값은 동기, 요청만 늦다 — 그 둘은 다른 것이다
//
// 스파이크 #837 gate 1 의 실측은 **렌더되는 `value`** 에 대한 것이다. 값을 한 틱 늦게 쓰면 iOS 의 조합 세션이 끊겨 `안녕하세요` 가 자모로 흩어진다. 디바운스는 그 규칙을 어기는
// 것처럼 보이지만 어기지 않는다: `query` 는 키 입력마다 그 자리에서 `setQuery` 되어 그대로 `value` 로 돌아가고, 늦는 것은 **네트워크를 부를 결심**(`debounced`)뿐이다. 한글 검색창은
// 이 구분을 틀리기에 가장 쉬운 자리라서, 두 상태를 이름부터 갈라 둔다. 250ms 는 웹이 쓰는 값 그대로이고, 빈 문자열만 예외로 **즉시** 반영한다 — 지우고 나서도 결과가 250ms 더
// 남아 있으면 지운 것이 안 지워진 것처럼 보인다. 이미 다 친 말(최근 검색을 고른 것·다른 화면이 넘긴 것)은 기다릴 이유가 없다: `setQueryNow` 가 둘을 함께 옮긴다.
//
// ## 2자 미만은 기기를 떠나지 않는다
//
// 서버는 다듬은 질의가 2자 미만이면 400 을 준다. 그 400 을 받아 한국어로 옮겨 보여 주는 대신 **아예 보내지 않는다**: 입력 중인 상태는 오류가 아니고, 오류로 그리면 사람은 자기가
// 뭔가 잘못했다고 읽는다. 글자 수는 코어가 서버와 같은 방식으로 센다(코드포인트 — `"..".length` 로 세면 이모지 한 글자가 둘이 된다).
//
// ## 범위는 화면이 정하고, 이 훅은 그 값을 받아 부를 뿐이다
//
// `channelId` 가 있으면 서버가 그 대화 하나만 훑는다(`channel=`, #1931). 커서는 자기가 걷던 결과 집합에서만 뜻이 있어서 캐시 키에 대화 id 를 넣는다(코어 `searchQueryKey` — 범위를
// 바꾸면 페이지와 커서가 함께 버려진다). `enabled: false` 는 호출부가 서버를 부르지 말라는 뜻이다(홈의 「채널」·「사람」 칩, 닫혀 있는 대화 안 검색). 입력값과 디바운스는 그대로 돌아서,
// 다시 켜면 이미 친 말로 바로 찾는다.
//
// ## 마지막 페이지는 `nextCursor` 키가 아예 없다
//
// `null` 이 아니라 키 자체가 빠진다(서버 테스트 `a_last_page_omits_the_cursor_key`). `getNextPageParam` 이 `undefined` 를 돌려주면 react-query 는 다음 페이지가 없다고 판단하므로,
// 코어의 파서가 키를 생략하는 것이 그대로 이 배선의 종료 조건이 된다 — 추가 판정이 없다.
// =============================================================================

/** 웹과 같은 값. 한 글자 더 치는 사이에 요청이 나가지 않을 만큼만. */
const DEBOUNCE_MS = 250;

export interface SearchWiring {
  /** 입력창이 그대로 되읽는 값. 동기. */
  query: string;
  /** 치는 중의 값 — 요청만 250ms 늦다(빈 문자열은 즉시). */
  setQuery: (next: string) => void;
  /** 이미 다 친 말로 바꾼다 — 입력과 요청 결심을 함께 옮긴다(기다리지 않는다). */
  setQueryNow: (next: string) => void;
  /** 화면이 보고 그리는 단 하나의 상태. */
  phase: SearchPhase;
  /** 이 결과가 어떤 질의에 대한 것인지 — 문구·강조·막대가 인용할 값. */
  settledQuery: string;
  hits: MessageSearchHit[];
  hasMore: boolean;
  loadingMore: boolean;
  /** 다음 쪽을 부른다. 부를 쪽이 있고 이미 오는 중이 아닐 때만 시작하고, 시작했으면 `true`. */
  loadMore: () => boolean;
  retry: () => void;
}

export function useSearchWiring({
  workspaceId,
  channelId,
  enabled = true,
  initialQuery = '',
}: {
  workspaceId: string;
  /** 이 대화 하나로 좁혀 찾는다. 없으면 내가 든 모든 대화. */
  channelId?: string | undefined;
  /** `false` 면 서버를 부르지 않는다(기본은 켜짐). */
  enabled?: boolean;
  /** 사이드바·다른 화면이 이미 친 말. 사람이 두 번 타이핑하지 않게 들고 온다. */
  initialQuery?: string;
}): SearchWiring {
  // 동기. 헤더 참조.
  const [query, setQuery] = useState(initialQuery);
  // 넘겨받은 질의는 기다릴 이유가 없다 — 디바운스는 「치는 중」을 위한 것이지 「이미 다 친 것」을 위한 것이 아니다.
  const [debounced, setDebounced] = useState(initialQuery);

  useEffect(() => {
    // 지우는 것은 기다리지 않는다.
    if (normalizeQuery(query) === '') {
      setDebounced('');
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const setQueryNow = useCallback((next: string) => {
    setQuery(next);
    setDebounced(next);
  }, []);

  const normalized = normalizeQuery(debounced);

  const result = useInfiniteQuery<MessageSearchPage>({
    // 워크스페이스 id 는 대소문자가 섞여 오므로 키에서 접는다. 같은 검색이 두 캐시 항목으로 갈라지는 것을 막는다. 범위(대화 id)도 키의 일부다 — 위 머리말.
    queryKey: searchQueryKey(workspaceId, normalized, channelId),
    queryFn: ({pageParam}) =>
      searchMessages(workspaceId, normalized, {
        cursor: pageParam as string | undefined,
        ...(channelId === undefined ? {} : {channelId}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor,
    enabled: enabled && isSearchable(debounced),
    // 검색은 사람이 친 것에 대한 답이다. 화면에 돌아왔다고 다시 부르면 방금 읽던 결과가 이유 없이 새로 그려진다.
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });

  const hits = useMemo(
    () => (result.data?.pages ?? []).flatMap(page => page.hits),
    [result.data],
  );

  const phase = searchPhase({
    raw: debounced,
    // 다음 페이지를 가져오는 중은 「찾는 중」이 아니다 — 이미 결과가 화면에 있다.
    isFetching: result.isFetching && !result.isFetchingNextPage,
    hasError: result.isError,
    hitCount: hits.length,
    settled: result.isSuccess,
  });

  const hasMore = result.hasNextPage === true;
  const loadingMore = result.isFetchingNextPage;
  const {fetchNextPage, refetch} = result;
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return false;
    void fetchNextPage();
    return true;
  }, [hasMore, loadingMore, fetchNextPage]);
  const retry = useCallback(() => void refetch(), [refetch]);

  return {
    query,
    setQuery,
    setQueryNow,
    phase,
    settledQuery: normalized,
    hits,
    hasMore,
    loadingMore,
    loadMore,
    retry,
  };
}
