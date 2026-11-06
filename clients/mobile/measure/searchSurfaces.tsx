import type {Channel, MessageSearchHit, RosterMember} from '@momo/core/lib/api';
import {makeDirectory, memberNameParts} from '@momo/core/features/workspace/directory';
import React from 'react';
import {Screen} from '../src/design/atoms';
import {ConversationPickerSheet, type PickerItem} from '../src/features/search/ConversationPickerSheet';
import {matchChannels, matchPeople, type SearchKind} from '../src/features/search/localSearch';
import {ResultRow, type RecentSearchRow, type RecentTile} from '../src/features/search/SearchRows';
import type {MessageSearch} from '../src/features/search/useMessageSearch';
import {SearchView} from '../src/screens/SearchScreen';
import type {SearchPhase} from '@momo/core/features/search/searchModel';

// =============================================================================
// 검색 탭의 캡처 표면 (#5365). 서버 없이 **배송되는 `SearchView` 와 `ConversationPickerSheet`** 에 장면을 건넨다 — 옛 `SearchBody` 하네스와
// 같은 방법이다(서버가 주지 않는 빈 결과·오류·찬 최근 목록을 사진으로 남긴다). 사람·채널은 지어낸 이름이다.
//
//   -momoMeasure SEARCH-HOME | SEARCH-ALL | SEARCH-MESSAGES | SEARCH-PICKER      (라이트: LIGHT-SEARCH-…)
//   (옛 이름 SEARCH-IDLE · SEARCH-SEARCHING · SEARCH-EMPTY · SEARCH-ERROR · SEARCH-RESULTS 는 같은 화면의 해당 상태다)
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000fe001';
const SELF_ID = '00000000-0000-7000-8000-0000000fe0aa';

function person(
  index: number,
  displayName: string,
  handle: string,
  kind: 'human' | 'agent' = 'human',
): RosterMember {
  return {
    id: `00000000-0000-7000-8000-0000000fe0${index.toString(16).padStart(2, '0')}`,
    workspaceId: WS,
    kind,
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const ME: RosterMember = {...person(0xaa, '나', 'me'), id: SELF_ID};
const INTERN = person(1, '김인턴', 'kim-intern', 'agent');
const HARU = person(2, '하루', 'haru');
const DAON = person(3, '다온', 'daon');
const SAEBOM = person(4, '새봄', 'saebom');
const LUNA = person(5, '루나', 'luna');
const LUNA_HELPER = person(6, '루나 도우미', 'luna-helper', 'agent');
const ROSTER = [ME, INTERN, HARU, DAON, SAEBOM, LUNA, LUNA_HELPER];
const DIRECTORY = makeDirectory(ROSTER);

function channel(index: number, name: string, kind: 'public' | 'private'): Channel {
  return {
    id: `00000000-0000-7000-8000-0000000fc0${index.toString(16).padStart(2, '0')}`,
    workspaceId: WS,
    kind,
    name,
    muted: false,
  };
}

function dm(index: number, peer: RosterMember): Channel {
  return {
    id: `00000000-0000-7000-8000-0000000fd0${index.toString(16).padStart(2, '0')}`,
    workspaceId: WS,
    kind: 'dm',
    memberIds: [SELF_ID, peer.id],
    muted: false,
  };
}

const LAUNCH = channel(1, '출시-준비', 'public');
const LUNA_PROJECT = channel(2, '루나-프로젝트', 'public');
const LUNA_DESIGN = channel(3, '루나-디자인', 'private');
const LUNCH = channel(4, '점심', 'public');
const CHANNELS = [LAUNCH, LUNA_PROJECT, LUNA_DESIGN, LUNCH];
const DMS = [dm(1, INTERN), dm(2, HARU), dm(3, DAON)];

const RECENT_TILES: RecentTile[] = [
  {channelId: DMS[0].id, title: '김인턴', kind: 'dm', peerId: INTERN.id},
  {channelId: DMS[1].id, title: '하루', kind: 'dm', peerId: HARU.id},
  {channelId: LAUNCH.id, title: LAUNCH.name ?? '', kind: 'channel', peerId: null},
  {channelId: DMS[2].id, title: '다온', kind: 'dm', peerId: DAON.id},
  {channelId: LUNA_PROJECT.id, title: LUNA_PROJECT.name ?? '', kind: 'channel', peerId: null},
  {channelId: LUNCH.id, title: LUNCH.name ?? '', kind: 'channel', peerId: null},
];
// 최근 검색은 대화 안 검색과 한 목록이다(#5384): 한 대화 안에서 찾은 줄은 범위 칩과 함께 선다.
const RECENT_SEARCHES: RecentSearchRow[] = [
  {query: '배포 일정', channelId: LAUNCH.id, scope: {title: LAUNCH.name ?? '', isPrivate: false}},
  {query: '루나', channelId: null, scope: null},
  {query: '롤백 계획', channelId: LUNA_PROJECT.id, scope: {title: LUNA_PROJECT.name ?? '', isPrivate: false}},
  {query: '점심 메뉴', channelId: null, scope: null},
];

const NOW = 1_730_800_000_000;
const DAY = 86_400_000;
function hit(
  index: number,
  channelId: string,
  author: RosterMember,
  ageDays: number,
  snippet: string,
): MessageSearchHit {
  return {
    channelId,
    messageId: `measure-search-m-${index}`,
    seq: 100 + index,
    authorMemberId: author.id,
    createdAtMs: NOW - ageDays * DAY,
    snippet,
    matchOffset: Array.from(snippet).indexOf('루'),
  };
}
const HITS: MessageSearchHit[] = [
  hit(1, LAUNCH.id, HARU, 0, '루나 쪽 배포는 내일 오전으로 잡았어요. 확인 부탁해요.'),
  hit(2, LUNA_PROJECT.id, DAON, 1, '루나 시안 새 버전 올렸어요. 색만 한 번 더 봐 주세요.'),
  hit(3, DMS[0].id, INTERN, 2, '말씀하신 루나 일정표를 정리해서 보내 드렸어요.'),
  hit(4, LUNCH.id, SAEBOM, 2, '루나 근처에 새로 생긴 식당 같이 가 볼래요?'),
  hit(5, LUNA_PROJECT.id, HARU, 3, '다음 주 루나 데모 준비는 제가 맡을게요.'),
];

const TITLES = new Map<string, string>([
  ...CHANNELS.map(c => [c.id, c.name ?? ''] as const),
  [DMS[0].id, '김인턴'],
  [DMS[1].id, '하루'],
  [DMS[2].id, '다온'],
]);

function messageSearch(
  query: string,
  phase: SearchPhase,
  hits: MessageSearchHit[] = [],
): MessageSearch {
  return {
    query,
    setQuery: () => {},
    setQueryNow: () => {},
    phase,
    settledQuery: query,
    hits,
    hasMore: hits.length > 0,
    loadingMore: false,
    loadMore: () => {},
    retry: () => {},
  };
}

const PICKER_ITEMS: PickerItem[] = [
  ...CHANNELS.map(c => ({
    id: c.id,
    title: c.name ?? '',
    subtitle: c.kind === 'private' ? '비공개 채널' : '공개 채널',
    kind: c.kind === 'private' ? ('private' as const) : ('channel' as const),
    peerId: null,
  })),
  {id: DMS[0].id, title: '김인턴', subtitle: '에이전트', kind: 'dm', peerId: INTERN.id},
  {id: DMS[1].id, title: '하루', subtitle: '다이렉트 메시지', kind: 'dm', peerId: HARU.id},
  {id: DMS[2].id, title: '다온', subtitle: '다이렉트 메시지', kind: 'dm', peerId: DAON.id},
];

export type SearchSurfaceWhich =
  | 'home'
  | 'all'
  | 'messages'
  | 'picker'
  | 'searching'
  | 'empty'
  | 'error';

/** `which` 장면 하나. 어느 것이든 같은 `SearchView` 를 그린다 — 다른 것은 데이터뿐이다. */
export function SearchSurface({which}: {which: SearchSurfaceWhich}): React.JSX.Element {
  const home = which === 'home';
  const query = home ? '' : which === 'empty' ? '없는말' : '루나';
  const kind: SearchKind = which === 'messages' || which === 'picker' ? 'messages' : 'all';
  const phase: SearchPhase =
    which === 'searching'
      ? 'searching'
      : which === 'empty'
        ? 'empty'
        : which === 'error'
          ? 'error'
          : home
            ? 'idle'
            : 'results';
  const hits = phase === 'results' ? HITS : [];
  const search = messageSearch(query, phase, hits);
  const showsLocal = which !== 'empty' && !home;
  return (
    <>
      <Screen>
        <SearchView
          search={search}
          directory={DIRECTORY}
          kind={kind}
          onKind={() => {}}
          onExit={() => {}}
          onSubmit={() => {}}
          inputLabel="measure"
          scope={null}
          onPickScope={() => {}}
          onClearScope={() => {}}
          channels={showsLocal ? matchChannels(CHANNELS, query) : []}
          people={showsLocal ? matchPeople(ROSTER, SELF_ID, query) : []}
          localPending={false}
          recentTiles={RECENT_TILES}
          recentSearches={RECENT_SEARCHES}
          onOpenRecent={() => {}}
          onPickRecentSearch={() => {}}
          onClearRecentSearches={() => {}}
          onOpenChannel={() => {}}
          onOpenPerson={() => {}}
          renderMessage={item => (
            <ResultRow
              key={item.messageId}
              hit={item}
              query={query}
              channelTitle={TITLES.get(item.channelId) ?? ''}
              authorName={memberNameParts(DIRECTORY, item.authorMemberId, '').name}
              onPress={() => {}}
            />
          )}
          dmFailure={null}
          clearance={0}
        />
      </Screen>
      {which === 'picker' ? (
        <ConversationPickerSheet
          items={PICKER_ITEMS}
          directory={DIRECTORY}
          selectedId={null}
          onPick={() => {}}
          onClose={() => {}}
        />
      ) : null}
    </>
  );
}
