import {type MessageSearchHit} from '@momo/core/lib/api';
import {isSearchable, type SearchPhase} from '@momo/core/features/search/searchModel';
import {useCallback, useEffect, useRef, useState} from 'react';

import {
  forgetSearches,
  recentsScope,
  rememberSearch,
  useSearchRecents,
  type RecentSearch,
} from '../search/searchRecents';
import {useSearchWiring} from '../search/useSearchWiring';
import {
  newerIndex,
  olderIndex,
  searchPosition,
  type SearchPosition,
} from './conversationSearchModel';

// =============================================================================
// 대화 안 검색의 배선 (#5364). 홈의 메시지 검색(`features/search/useMessageSearch.ts`)과 **같은 배선 한 벌**(`useSearchWiring`, #5384) 위에서 **이 대화 하나로 좁혀** 찾는다.
//
// 서버는 `channel=` 을 이미 받는다(#1931) — 배선이 코어 `searchMessages` 의 `channelId` 옵션을 그대로 넘기고, 캐시 열쇠가 홈 검색과 겹치지 않는다(코어 `searchQueryKey` 의 4번째 칸이 대화 id 다 —
// 커서는 자기가 걷던 범위에서만 뜻이 있어서, 범위가 열쇠에 있어야 한 범위의 커서가 다른 범위의 요청에 실리지 않는다). 입력값이 동기이고 요청만 늦은 이유(한글 조합)·디바운스·쪽 넘김은 `useSearchWiring` 머리말에 있다.
//
// ## 이 훅이 맡는 것 — 그리고 맡지 않는 것
//
//   - 검색 줄의 열림·닫힘, 결과 목록 ↔ 대화 두 보기(`view`), 고른 결과의 번호(`selected`), 위·아래로 다음 결과, 최근 검색(홈 검색과 **한 목록**, `features/search/searchRecents.ts` — #5384).
//   - **이동 자체는 하지 않는다.** 결과를 고르면 `onJump(hit)` 을 부르고, 그 문은 대화 화면이 이미 갖고 있는 점프(`requestJump('search', …)`)다.
//     이미 불러온 범위 밖의 오래된 결과는 그 문이 하는 만큼만 간다(못 찾았다는 고지) — 거슬러 읽는 길은 별도 작업이다.
//
// ## 위 화살표가 불러온 끝에 닿았을 때
//
// 뒤에 쪽이 더 있으면(`hasMore`) 다음 쪽을 불러오고, 새 결과가 **들어오는 순간** 그 결과로 간다(`pendingOlder`). 불러오다 실패하면 기다림을
// 접는다 — 눌렀는데 영영 안 움직이는 단추가 되지 않게.
// =============================================================================

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
  /** 최근 검색 — 홈 검색과 **한 목록**이다(맨 앞이 가장 최근). 범위가 있는 줄(`channelId`)은 그 대화 안에서 찾은 말이다. */
  recent: readonly RecentSearch[];
  /**
   * 고른 줄의 말로 바로 찾는다(이 대화 안에서 — 줄의 범위가 다른 대화여도 말만 가져온다). 이 면의 검색 배선은 `channelId` 에 묶여 있어 저장된 범위를 따라갈 수 없다: 다른 대화 칩이 붙은 줄이 그
   * 사실을 말하는 것은 카드의 몫이다(낭독 이름 `mobile.convSearch.recentRowIn`, #5418).
   */
  pickRecent: (saved: RecentSearch) => void;
  /** 「모두 지우기」 — 한 목록이라 홈 검색의 최근 검색도 함께 비워진다. */
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
  memberId,
  channelId,
  onJump,
}: {
  workspaceId: string;
  /** 최근 검색 목록의 주인(열쇠 `작업공간:멤버`) — 같은 폰의 다른 계정에게 앞 사람의 말이 비치지 않게 한다. */
  memberId: string;
  channelId: string;
  /** 결과 하나로 간다. 대화 화면의 점프 문(`requestJump('search', …)`)이다. */
  onJump: (hit: MessageSearchHit) => void;
}): ConversationSearch {
  const [active, setActive] = useState(false);
  const [view, setView] = useState<ConversationSearchView>('list');
  const [selected, setSelected] = useState<number | null>(null);
  const pendingOlder = useRef(false);

  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;

  // 요청·디바운스·쪽 넘김은 홈 검색과 같은 배선이다(`useSearchWiring`). 이 훅은 검색 줄이 열려 있을 때만 서버를 부르고, 범위는 이 대화 하나다.
  const wiring = useSearchWiring({workspaceId, channelId, enabled: active});
  const {setQuery: setWiringQuery, setQueryNow, hits, hasMore, loadingMore, loadMore} = wiring;
  const hitsRef = useRef(hits);
  hitsRef.current = hits;

  // 한 목록: 홈 검색과 같은 저장을 읽는다(구독이라 어디서 남기든 바로 보인다).
  const recentScope = recentsScope(workspaceId, memberId);
  const recent = useSearchRecents(recentScope).searches;

  // 대화가 바뀌면 앞 대화의 검색은 이 화면의 사실이 아니다 — 이 화면은 방을 옮길 때 다시 마운트되지 않고 `channelId` 만 갈아 끼운다.
  useEffect(() => {
    setActive(false);
    setView('list');
    setQueryNow('');
    setSelected(null);
    pendingOlder.current = false;
  }, [workspaceId, channelId, setQueryNow]);

  // 결과를 **고른** 말은 그 결과를 낳은 말(`settledQuery`, 디바운스를 지난 것)이다 — 고르기 직전에 한 글자를 더 쳤어도 그 한 글자는 아직 아무 결과도 낳지 않았다.
  // 키보드의 「검색」은 **친** 말(`query`) 그대로다. 이 대화 안에서 찾은 말이라 범위(`channelId`)와 함께 남는다.
  const rememberTerm = useCallback(
    (term: string) => {
      if (isSearchable(term)) rememberSearch(recentScope, term, channelId);
    },
    [recentScope, channelId],
  );

  const open = useCallback(() => {
    setQueryNow('');
    setSelected(null);
    setView('list');
    setActive(true);
  }, [setQueryNow]);

  const close = useCallback(() => {
    pendingOlder.current = false;
    setActive(false);
    setView('list');
    setQueryNow('');
    setSelected(null);
  }, [setQueryNow]);

  const setQuery = useCallback(
    (next: string) => {
      pendingOlder.current = false;
      setWiringQuery(next);
      // 말이 바뀌면 지금까지의 결과 번호는 다른 목록의 번호다.
      setSelected(null);
      setView('list');
    },
    [setWiringQuery],
  );

  const submit = useCallback(() => rememberTerm(wiring.query), [rememberTerm, wiring.query]);

  const pickRecent = useCallback(
    (saved: RecentSearch) => {
      pendingOlder.current = false;
      // 이미 다 친 말이다 — 디바운스는 「치는 중」을 위한 것이다.
      setQueryNow(saved.query);
      setSelected(null);
      setView('list');
    },
    [setQueryNow],
  );

  const clearRecent = useCallback(() => forgetSearches(recentScope), [recentScope]);

  const choose = useCallback(
    (index: number) => {
      const hit = hitsRef.current[index];
      if (hit === undefined) return;
      pendingOlder.current = false;
      setSelected(index);
      setView('conversation');
      rememberTerm(wiring.settledQuery);
      onJumpRef.current(hit);
    },
    [rememberTerm, wiring.settledQuery],
  );

  const older = useCallback(() => {
    if (selected === null) return;
    const next = olderIndex(selected, hitsRef.current.length);
    if (next !== null) {
      choose(next);
      return;
    }
    // 불러온 끝이다 — 다음 쪽을 불러오기 시작했으면 새 결과가 들어오는 순간 그 결과로 간다(아래 효과).
    if (loadMore()) pendingOlder.current = true;
  }, [selected, choose, loadMore]);

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
    query: wiring.query,
    setQuery,
    submit,
    phase: wiring.phase,
    settledQuery: wiring.settledQuery,
    hits,
    hasMore,
    loadingMore,
    loadMore: wiring.loadMore,
    retry: wiring.retry,
    recent,
    pickRecent,
    clearRecent,
    selected: view === 'conversation' ? selected : null,
    position: view === 'conversation' ? searchPosition(selected, hits.length, hasMore) : null,
    choose,
    older,
    newer,
    canOlder: selected !== null && (olderIndex(selected, hits.length) !== null || hasMore),
    canNewer: selected !== null && newerIndex(selected) !== null,
    backToList,
    editing,
  };
}
