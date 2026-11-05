import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {SearchPhase} from '@momo/core/features/search/searchModel';
import type {Message, MessageSearchHit, RosterMember} from '@momo/core/lib/api';
import React, {useCallback, useMemo, useState} from 'react';
import {Keyboard, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen} from '../src/design/atoms';
import {useStyles} from '../src/design/theme';
import {type Palette} from '../src/design/tokens';
import {Composer} from '../src/features/conversation/Composer';
import {CONV} from '../src/features/conversation/convDesign';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {
  COMPOSER_HIDDEN,
  ConversationSearchBar,
} from '../src/features/conversation/ConversationSearchBar';
import {
  newerIndex,
  olderIndex,
  searchPosition,
} from '../src/features/conversation/conversationSearchModel';
import {ConversationSearchPanel} from '../src/features/conversation/ConversationSearchPanel';
import {ConversationSearchRow} from '../src/features/conversation/ConversationSearchRow';
import {Timeline} from '../src/features/conversation/Timeline';
import type {ConversationSearch} from '../src/features/conversation/useConversationSearch';

// =============================================================================
// 대화 안 검색의 **살아 있는** 캡처 표면 (#5364) — 서버 없이, 손으로 누른다.
//
//   -momoMeasure CONVSEARCH-LIVE   (Maestro 가 `testID` 로 누른다: conversation-search · conversation-search-input ·
//                                   conversation-search-result · conversation-search-older/-newer/-list · conversation-search-close)
//
// 정적 장면(`conversationSearch.tsx`)과 달리 **진짜 `ConversationLayout`(네이티브 키보드 틀)·`Timeline`(진짜 점프·착지)·`Composer`·머리**를 `ConversationScreen` 과 같은
// 순서로 세우고, 검색 상태만 이 파일의 작은 상태 기계가 쥔다(진짜 훅은 서버 요청이 필요하다 — 훅의 전이는 `__tests__/conversationSearch.test.tsx` 가 진짜 훅으로 잰다).
// 화면 부품(검색 줄·결과 면·이동 막대)과 순수 셈(`olderIndex` · `newerIndex` · `searchPosition`)은 배송되는 것 그대로다.
//
// 보려는 것(jest 가 못 보는 것): 자판이 올라올 때 결과 면의 바닥이 자판 위에서 끝나는가 · 결과를 누르면 자판이 접히고 진짜 목록이 그 메시지로 가서 착지 틴트가 서는가 ·
// 컴포저가 숨은 동안 막대가 도크에 서고 검색을 끝내면 컴포저가 돌아오는가. 검색어는 ASCII(`deploy`)다 — Maestro 의 `inputText` 가 한글을 못 친다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000005365';
const SELF_ID = '00000000-0000-7000-8000-000000005311';
const HARU_ID = '00000000-0000-7000-8000-000000005312';
const DAON_ID = '00000000-0000-7000-8000-000000005313';
const INTERN_ID = '00000000-0000-7000-8000-000000005314';
const AUTHORS = [SELF_ID, HARU_ID, DAON_ID, INTERN_ID];
const NOW = Date.now();
const MINUTE = 60_000;

function person(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    role: 'member',
    channelCount: 2,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  person({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'}),
  person({id: HARU_ID, displayName: '하루', handle: 'haru'}),
  person({id: DAON_ID, displayName: '다온', handle: 'daon'}),
  person({id: INTERN_ID, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
]);

const MESSAGE_COUNT = 60;
// 최근 순으로 첫 번째가 58 — 끝에서 가까운 것부터 멀리 있는 것까지(착지가 목록을 얼마나 움직이는지 본다).
const HIT_SEQS = [58, 52, 47, 33, 12];
const FILLER = ['점심 뭐 먹을까요', '리뷰 올렸어요', '테스트 돌려 볼게요', '회의록 정리 끝', '이슈 하나 열었어요'];

const messageId = (seq: number) => `00000000-0000-7000-8000-00000000e${String(seq).padStart(3, '0')}`;
const bodyOf = (seq: number) =>
  HIT_SEQS.includes(seq) ? `${seq}번 deploy 일정 확인 부탁해요.` : `${FILLER[seq % FILLER.length]} (${seq})`;

const MESSAGES: Message[] = Array.from({length: MESSAGE_COUNT}, (_, index) => {
  const seq = index + 1;
  return {
    id: messageId(seq),
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AUTHORS[seq % AUTHORS.length],
    type: 'text',
    body: bodyOf(seq),
    state: 'sent',
    createdAtMs: NOW - (MESSAGE_COUNT - seq) * MINUTE,
  } as Message;
});

const HITS: MessageSearchHit[] = HIT_SEQS.map(seq => ({
  channelId: 'ch',
  messageId: messageId(seq),
  seq,
  authorMemberId: AUTHORS[seq % AUTHORS.length],
  createdAtMs: NOW - (MESSAGE_COUNT - seq) * MINUTE,
  snippet: bodyOf(seq),
  matchOffset: bodyOf(seq).indexOf('deploy'),
}));

const noop = () => {};
const NO_TOP = {paddingTop: 0} as const;

/** 진짜 훅과 같은 얼굴(`ConversationSearch`)을 주는 로컬 상태 기계 — 서버 없이 `deploy` 만 찾는다. */
function useLiveSearch(onJump: (hit: MessageSearchHit) => void): ConversationSearch {
  const [active, setActive] = useState(false);
  const [view, setView] = useState<'list' | 'conversation'>('list');
  const [query, setQueryState] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [recent, setRecent] = useState<string[]>(['deploy 일정', '롤백 계획']);

  const trimmed = query.trim();
  const phase: SearchPhase =
    trimmed === ''
      ? 'idle'
      : Array.from(trimmed).length < 2
        ? 'tooShort'
        : 'deploy'.includes(trimmed.toLowerCase())
          ? 'results'
          : 'empty';
  const hits = phase === 'results' ? HITS : [];

  const choose = useCallback(
    (index: number) => {
      const hit = HITS[index];
      if (hit === undefined) return;
      setSelected(index);
      setView('conversation');
      onJump(hit);
    },
    [onJump],
  );

  return {
    active,
    open: () => {
      setQueryState('');
      setSelected(null);
      setView('list');
      setActive(true);
    },
    close: () => {
      setActive(false);
      setQueryState('');
      setSelected(null);
      setView('list');
    },
    view,
    listOpen: active && view === 'list',
    query,
    setQuery: next => {
      setQueryState(next);
      setSelected(null);
      setView('list');
    },
    submit: noop,
    phase,
    settledQuery: trimmed,
    hits,
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    retry: noop,
    recent,
    pickRecent: term => {
      setQueryState(term);
      setView('list');
    },
    clearRecent: () => setRecent([]),
    selected: view === 'conversation' ? selected : null,
    position: view === 'conversation' ? searchPosition(selected, HITS.length, false) : null,
    choose,
    older: () => {
      const next = selected === null ? null : olderIndex(selected, HITS.length);
      if (next !== null) choose(next);
    },
    newer: () => {
      const next = selected === null ? null : newerIndex(selected);
      if (next !== null) choose(next);
    },
    canOlder: selected !== null && olderIndex(selected, HITS.length) !== null,
    canNewer: selected !== null && newerIndex(selected) !== null,
    backToList: () => setView('list'),
    editing: () => setView('list'),
  };
}

export function ConversationSearchLiveSurface(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState<number>(CONV.headHeight);
  const [jump, setJump] = useState<{messageId: string; seq: number; token: number} | null>(null);
  const headerInset = insets.top + headerHeight;

  const onJump = useCallback((hit: MessageSearchHit) => {
    // 진짜 화면과 같다: 결과를 눌렀으면 자판은 걷고, 점프는 토큰을 올려 건다.
    Keyboard.dismiss();
    setJump(current => ({messageId: hit.messageId, seq: hit.seq, token: (current?.token ?? 0) + 1}));
  }, []);
  const search = useLiveSearch(onJump);
  const bar = useMemo(
    () =>
      search.active && search.position !== null ? (
        <ConversationSearchBar
          position={search.position}
          query={search.settledQuery}
          canOlder={search.canOlder}
          canNewer={search.canNewer}
          loadingMore={false}
          onList={search.backToList}
          onOlder={search.older}
          onNewer={search.newer}
        />
      ) : null,
    [search],
  );

  return (
    <Screen style={NO_TOP}>
      <View collapsable={false} style={styles.column} testID="conversation-column">
        <View
          pointerEvents="box-none"
          style={styles.headerOverlay}
          onLayout={event => setHeaderHeight(event.nativeEvent.layout.height - insets.top)}>
          <ConversationHeader
            title="배포"
            memberCount="6명"
            kind="public"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            onOpenSearch={search.open}
            searchRow={
              search.active ? (
                <ConversationSearchRow
                  query={search.query}
                  onChangeQuery={search.setQuery}
                  onSubmit={search.submit}
                  onFocus={search.editing}
                  onClose={search.close}
                  isDm={false}
                />
              ) : undefined
            }
            railStatus="connected"
          />
        </View>
        <View
          style={styles.layoutFill}
          accessibilityElementsHidden={search.listOpen}
          importantForAccessibility={search.listOpen ? 'no-hide-descendants' : 'auto'}>
        <ConversationLayout
          list={
            <Timeline
              messages={MESSAGES}
              directory={DIRECTORY}
              status="ready"
              channelKind="public"
              myMemberId={SELF_ID}
              nowMs={NOW}
              channelId="ch"
              tailGap={CONV.conversationTail}
              contentTopInset={headerInset}
              topPillInset={headerInset}
              jumpTarget={jump ?? undefined}
            />
          }
          composer={
            <>
              {bar}
              <View style={search.active ? COMPOSER_HIDDEN : undefined} testID="conversation-composer-stack">
                <Composer
                  recipient="place"
                  channelLabel="배포"
                  directory={DIRECTORY}
                  draftKey="measure:conv-search-live"
                  attachmentTarget={{workspaceId: WS, channelId: 'ch'}}
                  onSend={noop}
                />
              </View>
            </>
          }
        />
        </View>
        {search.listOpen ? (
          <ConversationSearchPanel
            search={search}
            directory={DIRECTORY}
            selfMemberId={SELF_ID}
            isDm={false}
            topInset={headerInset}
            nowMs={NOW}
          />
        ) : null}
      </View>
    </Screen>
  );
}

const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    column: {flex: 1},
    layoutFill: {flex: 1},
    headerOverlay: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1},
  });
