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
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {
  newerIndex,
  olderIndex,
  searchPosition,
  type SearchPosition,
} from './conversationSearchModel';
import {forgetRecent, readRecent, rememberRecent} from './conversationSearchRecent';

// =============================================================================
// 대화 안 검색의 배선 (#5364). 홈의 메시지 검색(`features/search/useMessageSearch.ts`)과 같은 틀이되, **이 대화 하나로 좁혀** 찾는다.
//
// 서버는 `channel=` 을 이미 받는다(#1931) — 코어 `searchMessages` 의 `channelId` 옵션을 그대로 넘긴다. 홈 훅은 건드리지 않는다: 그 훅은
// 홈 검색 화면의 것이고(워크스페이스 전체), 이 훅은 그것과 **캐시 열쇠가 겹치지 않는다**(코어 `searchQueryKey` 의 4번째 칸이 대화 id 다 —
// 커서는 자기가 걷던 범위에서만 뜻이 있어서, 범위가 열쇠에 있어야 한 범위의 커서가 다른 범위의 요청에 실리지 않는다).
//
// ## 입력값은 동기, 요청만 늦다
//
// `useMessageSearch` 머리말 그대로다: 렌더되는 `value` 는 키 입력마다 그 자리에서 바뀌어야 한글 조합이 안 끊기고, 늦는 것은 **네트워크를 부를
// 결심**(`debounced`)뿐이다. 빈 문자열만 기다리지 않는다.
//
// ## 이 훅이 맡는 것 — 그리고 맡지 않는 것
//
//   - 검색 줄의 열림·닫힘, 결과 목록 ↔ 대화 두 보기(`view`), 고른 결과의 번호(`selected`), 위·아래로 다음 결과, 최근 검색.
//   - **이동 자체는 하지 않는다.** 결과를 고르면 `onJump(hit)` 을 부르고, 그 문은 대화 화면이 이미 갖고 있는 점프(`requestJump('search', …)`)다.
//     이미 불러온 범위 밖의 오래된 결과는 그 문이 하는 만큼만 간다(못 찾았다는 고지) — 거슬러 읽는 길은 별도 작업이다.
//
// ## 위 화살표가 불러온 끝에 닿았을 때
//
// 뒤에 쪽이 더 있으면(`hasMore`) 다음 쪽을 불러오고, 새 결과가 **들어오는 순간** 그 결과로 간다(`pendingOlder`). 불러오다 실패하면 기다림을
// 접는다 — 눌렀는데 영영 안 움직이는 단추가 되지 않게.
// =============================================================================

/** 홈 검색과 같은 값. 한 글자 더 치는 사이에 요청이 나가지 않을 만큼만. */
const DEBOUNCE_MS = 250;

/** 대화 안 검색이 서 있는 두 보기 — 결과 목록(검색 줄 아래를 덮는다)과 대화(고른 결과로 이동한 상태, 아래 막대). */
export type ConversationSearchView = 'list' | 'conversation';

export interface ConversationSearch {
  active: boolean;
  open: () => void;
  close: () => void;
  view: ConversationSearchView;
  /** 검색이 열려 있고 결과 목록 보기다 — 목록 면(`ConversationSearchPanel`)이 대화를 덮는다. */
  listOpen: boolean;
  /** 입력창이 그대로 되읽는 값. 동기. */
  query: string;
  setQuery: (next: string) => void;
  /** 키보드의 「검색」 — 서버가 받아 줄 말이면 최근 검색에 남긴다. */
  submit: () => void;
  /** 화면이 보고 그리는 단 하나의 상태. */
  phase: SearchPhase;
  /** 이 결과가 어떤 질의에 대한 것인지 — 강조와 막대가 인용할 값. */
  settledQuery: string;
  hits: MessageSearchHit[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  recent: string[];
  pickRecent: (term: string) => void;
  clearRecent: () => void;
  /** 고른 결과의 번호(0 = 가장 최근). 목록 보기이거나 아직 안 골랐으면 `null`. */
  selected: number | null;
  position: SearchPosition | null;
  choose: (index: number) => void;
  /** ↑ — 더 오래된 결과. 불러온 끝이면 다음 쪽을 불러와 이어서 간다. */
  older: () => void;
  /** ↓ — 더 최근 결과. */
  newer: () => void;
  canOlder: boolean;
  canNewer: boolean;
  /** 「목록」 — 결과 목록 보기로 돌아간다. */
  backToList: () => void;
  /** 입력칸에 다시 포커스가 들어왔다 — 다시 치려는 것이므로 결과 목록 보기로 간다. */
  editing: () => void;
}

export function useConversationSearch({
  workspaceId,
  channelId,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  /** 결과 하나로 간다. 대화 화면의 점프 문(`requestJump('search', …)`)이다. */
  onJump: (hit: MessageSearchHit) => void;
}): ConversationSearch {
  const [active, setActive] = useState(false);
  const [view, setView] = useState<ConversationSearchView>('list');
  // 동기. 헤더 참조.
  const [query, setQueryState] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const pendingOlder = useRef(false);

  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;

  // 대화가 바뀌면 앞 대화의 검색은 이 화면의 사실이 아니다 — 이 화면은 방을 옮길 때 다시 마운트되지 않고 `channelId` 만 갈아 끼운다.
  useEffect(() => {
    setActive(false);
    setView('list');
    setQueryState('');
    setDebounced('');
    setSelected(null);
    pendingOlder.current = false;
  }, [workspaceId, channelId]);

  useEffect(() => {
    const trimmed = normalizeQuery(query);
    // 지우는 것은 기다리지 않는다.
    if (trimmed === '') {
      setDebounced('');
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const enabled = active && isSearchable(debounced);
  const normalized = normalizeQuery(debounced);

  const result = useInfiniteQuery<MessageSearchPage>({
    queryKey: searchQueryKey(workspaceId, normalized, channelId),
    queryFn: ({pageParam}) =>
      searchMessages(workspaceId, normalized, {
        cursor: pageParam as string | undefined,
        channelId,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor,
    enabled,
    // 검색은 사람이 친 것에 대한 답이다. 화면에 돌아왔다고 다시 부르면 방금 읽던 결과가 이유 없이 새로 그려진다.
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });

  const hits = useMemo(
    () => (result.data?.pages ?? []).flatMap(page => page.hits),
    [result.data],
  );
  const hitsRef = useRef(hits);
  hitsRef.current = hits;

  const phase = searchPhase({
    raw: debounced,
    // 다음 쪽을 가져오는 중은 「찾는 중」이 아니다 — 이미 결과가 화면에 있다.
    isFetching: result.isFetching && !result.isFetchingNextPage,
    hasError: result.isError,
    hitCount: hits.length,
    settled: result.isSuccess,
  });

  const hasMore = result.hasNextPage === true;
  const loadingMore = result.isFetchingNextPage;
  const {fetchNextPage, refetch} = result;
  const loadMore = useCallback(() => {
    if (hasMore && !loadingMore) void fetchNextPage();
  }, [hasMore, loadingMore, fetchNextPage]);

  // 결과를 **고른** 말은 그 결과를 낳은 말(`normalized`, 디바운스를 지난 것)이다 — 고르기 직전에 한 글자를 더 쳤어도 그 한 글자는 아직 아무 결과도 낳지 않았다.
  // 키보드의 「검색」은 **친** 말(`query`) 그대로다.
  const rememberTerm = useCallback(
    (term: string) => {
      if (isSearchable(term)) setRecent(rememberRecent(workspaceId, channelId, term));
    },
    [workspaceId, channelId],
  );

  const open = useCallback(() => {
    setRecent(readRecent(workspaceId, channelId));
    setQueryState('');
    setDebounced('');
    setSelected(null);
    setView('list');
    setActive(true);
  }, [workspaceId, channelId]);

  const close = useCallback(() => {
    pendingOlder.current = false;
    setActive(false);
    setView('list');
    setQueryState('');
    setDebounced('');
    setSelected(null);
  }, []);

  const setQuery = useCallback((next: string) => {
    pendingOlder.current = false;
    setQueryState(next);
    // 말이 바뀌면 지금까지의 결과 번호는 다른 목록의 번호다.
    setSelected(null);
    setView('list');
  }, []);

  const submit = useCallback(() => rememberTerm(query), [rememberTerm, query]);

  const pickRecent = useCallback((term: string) => {
    pendingOlder.current = false;
    setQueryState(term);
    // 이미 다 친 말이다 — 디바운스는 「치는 중」을 위한 것이다.
    setDebounced(term);
    setSelected(null);
    setView('list');
  }, []);

  const clearRecent = useCallback(() => {
    forgetRecent(workspaceId, channelId);
    setRecent([]);
  }, [workspaceId, channelId]);

  const choose = useCallback(
    (index: number) => {
      const hit = hitsRef.current[index];
      if (hit === undefined) return;
      pendingOlder.current = false;
      setSelected(index);
      setView('conversation');
      rememberTerm(normalized);
      onJumpRef.current(hit);
    },
    [rememberTerm, normalized],
  );

  const older = useCallback(() => {
    if (selected === null) return;
    const next = olderIndex(selected, hitsRef.current.length);
    if (next !== null) {
      choose(next);
      return;
    }
    if (hasMore && !loadingMore) {
      pendingOlder.current = true;
      void fetchNextPage();
    }
  }, [selected, choose, hasMore, loadingMore, fetchNextPage]);

  // 불러온 끝에서 누른 ↑ 가 기다리던 새 결과가 도착했다.
  useEffect(() => {
    if (!pendingOlder.current || selected === null) return;
    if (hits.length > selected + 1) {
      pendingOlder.current = false;
      choose(selected + 1);
    } else if (!loadingMore) {
      // 불러오기가 끝났는데 새 결과가 없다(실패) — 기다림을 접는다.
      pendingOlder.current = false;
    }
  }, [hits.length, loadingMore, selected, choose]);

  const newer = useCallback(() => {
    if (selected === null) return;
    const next = newerIndex(selected);
    if (next !== null) choose(next);
  }, [selected, choose]);

  const backToList = useCallback(() => {
    pendingOlder.current = false;
    setView('list');
  }, []);

  const editing = useCallback(() => setView('list'), []);

  return {
    active,
    open,
    close,
    view,
    listOpen: active && view === 'list',
    query,
    setQuery,
    submit,
    phase,
    settledQuery: normalized,
    hits,
    hasMore,
    loadingMore,
    loadMore,
    retry: () => void refetch(),
    recent,
    pickRecent,
    clearRecent,
    selected: view === 'conversation' ? selected : null,
    position: view === 'conversation' ? searchPosition(selected, hits.length, hasMore) : null,
    choose,
    older,
    newer,
    canOlder:
      selected !== null && (olderIndex(selected, hits.length) !== null || hasMore),
    canNewer: selected !== null && newerIndex(selected) !== null,
    backToList,
    editing,
  };
}
