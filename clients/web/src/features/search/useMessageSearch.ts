import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  SEARCH_LIMIT_DEFAULT,
  searchMessages,
  type MessageSearchHit,
  type MessageSearchPage,
} from "@/lib/api";
import { useSession } from "@/app/session";
import { isSearchable, normalizeQuery, searchPhase, type SearchPhase } from "./searchModel";

// =============================================================================
// 검색 질의 하나의 수명 (goal B12 H5).
//
// 디바운스가 이 훅에 있는 이유: 타자 한 번에 한 요청이면 "안녕하세요"는 요청
// 다섯 건이고 그중 넷은 도착하기 전에 쓸모가 없어진다. 서버 쪽 비용도 실재한다
// (search.rs가 한 글자 질의를 막는 이유와 같은 이유다: trigram 스캔은 싸지 않다).
//
// 그리고 **2자 미만은 아예 보내지 않는다**. 서버가 400으로 답할 것을 알면서 보내
// 놓고 그 400을 오류 문구로 그리면, 아직 타자를 치는 중인 사람에게 빨간 줄을
// 보여주게 된다. 입력 중인 상태는 오류가 아니다.
// =============================================================================

/** 타자가 멈춘 것으로 치는 시간. */
const DEBOUNCE_MS = 250;

function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    // 지워서 빈 문자열이 된 경우는 기다리지 않는다: 결과를 치우는 일은 즉시
    // 일어나야 사람이 "지웠는데 아직 남아 있다"고 느끼지 않는다.
    if (value === "") {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface MessageSearch {
  /** 입력 상자에 그대로 묶이는 값. */
  raw: string;
  setRaw: (next: string) => void;
  /** 실제로 서버에 보낸 질의. 강조와 문구가 이 값을 쓴다. */
  query: string;
  phase: SearchPhase;
  hits: MessageSearchHit[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  error: unknown;
}

export function useMessageSearch(initialQuery = ""): MessageSearch {
  const { workspaceId } = useSession();
  // 초기값은 첫 렌더에서만 읽는다. 이후 주소가 바뀌어도 사람이 치고 있는 값을
  // 덮지 않는다.
  const [raw, setRaw] = useState(initialQuery);
  // 넘겨받은 질의는 기다릴 이유가 없다: 사람은 이미 팔레트에서 다 쳤고,
  // 디바운스는 타자 중인 손을 위한 것이다.
  const debounced = useDebounced(raw, raw === initialQuery ? 0 : DEBOUNCE_MS);
  const query = normalizeQuery(debounced);
  const enabled = isSearchable(debounced);

  const result = useInfiniteQuery<MessageSearchPage>({
    queryKey: ["message-search", workspaceId.toLowerCase(), query],
    queryFn: ({ pageParam, signal }) =>
      searchMessages(workspaceId, query, {
        limit: SEARCH_LIMIT_DEFAULT,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        signal,
      }),
    enabled,
    initialPageParam: undefined as string | undefined,
    // 마지막 페이지는 서버가 키를 아예 빼고 보낸다. `undefined`가 곧 "끝"이라
    // tanstack의 계약과 서버의 계약이 같은 말을 한다.
    getNextPageParam: (last) => last.nextCursor,
    // 검색 결과는 사람이 방금 만든 질문에 대한 답이다. 창을 다시 보거나 마운트가
    // 다시 일어났다고 해서 조용히 갈아 끼울 이유가 없다.
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });

  const hits = useMemo(
    () => (result.data?.pages ?? []).flatMap((page) => page.hits),
    [result.data]
  );

  const phase = searchPhase({
    raw: debounced,
    isFetching: result.isFetching && !result.isFetchingNextPage,
    hasError: result.isError,
    hitCount: hits.length,
    settled: result.isSuccess,
  });

  return {
    raw,
    setRaw,
    query,
    phase,
    hits,
    hasMore: result.hasNextPage,
    isLoadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
    retry: () => void result.refetch(),
    error: result.error,
  };
}
