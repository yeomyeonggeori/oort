import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {MessageSearchHit, RosterMember} from '@momo/core/lib/api';
import React, {useEffect} from 'react';
import {Keyboard, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen} from '../src/design/atoms';
import {useStyles} from '../src/design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../src/design/tokens';
import {CONV} from '../src/features/conversation/convDesign';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationSearchBar} from '../src/features/conversation/ConversationSearchBar';
import {ConversationSearchPanel} from '../src/features/conversation/ConversationSearchPanel';
import {ConversationSearchRow} from '../src/features/conversation/ConversationSearchRow';
import type {ConversationSearch} from '../src/features/conversation/useConversationSearch';
import {ConversationSearchLiveSurface} from './conversationSearchLive';

// =============================================================================
// 대화 안 검색의 캡처 표면 (#5364). 배송되는 머리·검색 줄·결과 면·이동 막대를 그 자리 그대로 세운다 — 서버 없이, 고정 데이터·가상 인물로.
//
//   -momoMeasure CONVSEARCH-<이름>   (라이트: LIGHT-CONVSEARCH-<이름>)
//
//   live           진짜 키보드 틀·목록·컴포저 위에서 **손으로 누르는** 장면(`conversationSearchLive.tsx`, Maestro 가 누른다)
//   entry          머리의 ⋮ 옆 돋보기 원(검색 전) — 에이전트 DM. 양쪽 칸이 원 둘 폭이 되어 알약이 좁아지는 가장 흔한 경우다(상태 낱말은 숨고 점은 남는다)
//   entry-channel  같은 자리, 채널 머리
//   idle      머리가 검색 줄로 바뀜 + 입력 전: 대화는 어둡게 눌려 있고 최근 검색 카드(시안 A2)
//   results   「배포」를 친 뒤 결과 목록(시안 A3) — 보낸 사람·시각·찾은 글자 강조·최근 순
//   landed    결과를 눌러 그 메시지로 이동한 뒤: 컴포저 자리에 「3 / 20+」 이동 막대(시안 A4)
//
// 이 하네스는 훅(`useConversationSearch`)을 세우지 않는다 — 화면 부품에 **고정된 검색 상태**를 건넨다(상태 전이는 `__tests__/conversationSearch.test.tsx`
// 가 진짜 훅·화면으로 잰다). 자판은 입력칸의 `autoFocus` 가 올린다(시뮬레이터의 하드웨어 키보드를 꺼 둔 상태), 이동한 뒤 장면은 접는다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000005364';
const SELF_ID = '00000000-0000-7000-8000-000000005301';
const HARU_ID = '00000000-0000-7000-8000-000000005302';
const DAON_ID = '00000000-0000-7000-8000-000000005303';
const INTERN_ID = '00000000-0000-7000-8000-000000005304';
const NOW = Date.UTC(2026, 10, 5, 8, 20); // 2026-11-05 17:20 KST

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

function hit(seq: number, author: string, snippet: string, offset: number, ago: number): MessageSearchHit {
  return {
    channelId: 'ch',
    messageId: `m-${seq}`,
    seq,
    authorMemberId: author,
    createdAtMs: NOW - ago,
    snippet,
    matchOffset: offset,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HITS: MessageSearchHit[] = [
  hit(105, INTERN_ID, '네, 배포가 끝나면 결과를 이 채널에 남길게요.', 3, 3 * MINUTE),
  hit(104, SELF_ID, '확인했어요. 배포 끝나면 여기에 알려 주세요.', 7, 4 * MINUTE),
  hit(103, HARU_ID, '오늘 저녁 7시에 배포 진행할게요. 그 전에 변경 목록 한 번만 봐 주세요.', 10, 6 * MINUTE),
  hit(98, DAON_ID, '롤백 계획까지 적어 두면 배포 날 마음이 편하죠.', 14, DAY + 40 * MINUTE),
  hit(71, HARU_ID, '배포 체크리스트 링크 올려 둘게요.', 0, 2 * DAY + 5 * HOUR),
];

const LINES: {who: string; text: string}[] = [
  {who: '다온', text: '배포 전에 확인할 목록 정리해서 올릴게요.'},
  {who: '다온', text: '스테이징 확인 끝났어요. 이제 올려도 돼요.'},
  {who: '하루', text: '오늘 저녁 7시에 배포 진행할게요. 그 전에 변경 목록 한 번만 봐 주세요.'},
  {who: '이도현', text: '확인했어요. 배포 끝나면 여기에 알려 주세요.'},
  {who: '김인턴', text: '네, 배포가 끝나면 결과를 이 채널에 남길게요.'},
];

const noop = () => {};

function fakeSearch(over: Partial<ConversationSearch>): ConversationSearch {
  return {
    active: true,
    open: noop,
    close: noop,
    view: 'list',
    listOpen: true,
    query: '',
    setQuery: noop,
    submit: noop,
    phase: 'idle',
    settledQuery: '',
    hits: [],
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    retry: noop,
    recent: [],
    pickRecent: noop,
    clearRecent: noop,
    selected: null,
    position: null,
    choose: noop,
    older: noop,
    newer: noop,
    canOlder: false,
    canNewer: false,
    backToList: noop,
    editing: noop,
    ...over,
  };
}

function Conversation({landedRow}: {landedRow?: number}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.lines, {paddingTop: insets.top + CONV.headHeight + space.md}]}>
      {LINES.map((entry, index) => (
        <View key={entry.text} style={[styles.line, index === landedRow && styles.landed]}>
          <Text style={styles.who}>{entry.who}</Text>
          <Text style={styles.text}>{entry.text}</Text>
        </View>
      ))}
    </View>
  );
}

export function ConversationSearchSurface({which}: {which: string}): React.JSX.Element {
  // `live`: 진짜 키보드 틀·목록·컴포저에 검색 부품을 얹은 손으로 누르는 장면(`conversationSearchLive.tsx`).
  if (which === 'live') return <ConversationSearchLiveSurface />;
  return <ConversationSearchStatic which={which} />;
}

function ConversationSearchStatic({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const headerInset = insets.top + CONV.headHeight;
  const landed = which === 'landed';
  useEffect(() => {
    // 이동한 뒤 장면은 자판이 접혀 있다(실제 흐름이 `Keyboard.dismiss()` 를 부른다).
    if (!landed) return undefined;
    const timer = setTimeout(() => Keyboard.dismiss(), 600);
    return () => clearTimeout(timer);
  }, [landed]);

  const entry = which === 'entry' || which === 'entry-channel';
  const query = which === 'idle' || entry ? '' : '배포';
  const search =
    which === 'idle'
      ? fakeSearch({recent: ['배포 일정', '루나', '롤백 계획']})
      : which === 'results'
        ? fakeSearch({query, phase: 'results', settledQuery: query, hits: HITS, hasMore: true})
        : fakeSearch({
            query,
            phase: 'results',
            settledQuery: query,
            hits: HITS,
            hasMore: true,
            view: 'conversation',
            listOpen: false,
            selected: 2,
            position: {index: 3, total: 20, more: true},
            canOlder: true,
            canNewer: true,
          });

  return (
    <Screen style={styles.screen}>
      <Conversation landedRow={landed ? 2 : undefined} />
      {which === 'idle' || which === 'results' ? (
        <ConversationSearchPanel
          search={search}
          directory={DIRECTORY}
          selfMemberId={SELF_ID}
          isDm={false}
          topInset={headerInset}
          nowMs={NOW}
        />
      ) : null}
      <View style={styles.headerOverlay} pointerEvents="box-none">
        <ConversationHeader
          title={which === 'entry' ? '김인턴' : '배포'}
          memberCount={which === 'entry' ? undefined : '6명'}
          kind={which === 'entry' ? 'dm' : 'public'}
          peerId={which === 'entry' ? INTERN_ID : null}
          peerStatusTone={which === 'entry' ? 'ok' : null}
          peerStatusLabel={which === 'entry' ? '응답함 3분 전' : undefined}
          directory={DIRECTORY}
          onBack={noop}
          onOpenMenu={noop}
          onOpenInfo={noop}
          onOpenSearch={noop}
          searchRow={
            entry ? undefined : (
              <ConversationSearchRow
                query={query}
                onChangeQuery={noop}
                onSubmit={noop}
                onFocus={noop}
                onClose={noop}
                isDm={false}
              />
            )
          }
          railStatus="connected"
        />
      </View>
      {landed && search.position !== null ? (
        <View style={styles.dock}>
          <ConversationSearchBar
            position={search.position}
            query={search.settledQuery}
            canOlder
            canNewer
            loadingMore={false}
            onList={noop}
            onOlder={noop}
            onNewer={noop}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    screen: {paddingTop: 0, backgroundColor: color.bg},
    headerOverlay: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1},
    lines: {flex: 1, paddingHorizontal: SAFE_GUTTER, gap: space.md},
    line: {gap: space.xs, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: space.md},
    landed: {backgroundColor: color.warnSurface},
    who: {fontSize: font.label, lineHeight: line.head, color: color.textMuted, fontWeight: '700'},
    text: {fontSize: font.body, lineHeight: line.body, color: color.text},
    dock: {position: 'absolute', left: 0, right: 0, bottom: space.xl},
  });
