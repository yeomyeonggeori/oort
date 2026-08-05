import type {Message, MessageSearchHit} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {SearchPhase} from '@momo/core/features/search/searchModel';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {ResultRow, SearchBody} from '../src/screens/SearchScreen';
import type {MessageSearch} from '../src/features/search/useMessageSearch';
import {color} from '../src/design/tokens';

// =============================================================================
// goal RN-C5 의 표면들을 사진 찍을 수 있게 세워 두는 하네스. **앱 코드가 아니다.**
//
// 이 배치가 더한 화면 대부분은 살아 있는 서버에서 저절로 나타나지 않는다. 시트는
// 길게 눌러야 나오고, 삭제 확인은 그 시트 안에서 한 번 더 눌러야 나오고, 검색의
// 네 상태 중 셋은 결과가 있을 때는 영영 보이지 않는다. 그리고 시뮬레이터는
// 스크립트로 누를 수 없다(스파이크 #837: RN 요소가 접근성 트리에 없고 좌표 클릭도
// 닿지 않는다). 그대로 두면 리뷰가 가장 봐야 할 화면들이 리뷰되지 않는다.
//
// 그래서 여기서는 **실제 컴포넌트**에 각 상태를 직접 건네준다. 목업을 그리지
// 않는다 — `measure/states.tsx` 가 `Timeline` 에 대해 이미 쓰는 방법이고, 찍힌
// 것이 곧 배송되는 것이어야 사진이 증거가 된다.
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure SHEET
//   … DELETE · EDITOR · SEARCH-IDLE · SEARCH-EMPTY · SEARCH-ERROR · SEARCH-RESULTS
//
// 시트류는 `Modal` 이라 화면을 덮으므로 한 번에 하나씩 띄운다.
// =============================================================================

const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);
const SELF = (ROSTER.find(m => m.kind === 'human') ?? ROSTER[0]).id;
const NOW = 1_700_000_000_000;

const MESSAGE: Message = {
  id: '00000000-0000-7000-8000-0000000000a1',
  channelId: 'ch',
  seq: 42,
  hlcTs: 42,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: '금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀어요.',
  state: 'sent',
  createdAtMs: NOW,
  thread: {reply_count: 3, last_reply_seq: 51, last_reply_at: NOW + 600_000},
};

const CHIPS = [
  {emoji: '👍', count: 3, mine: true},
  {emoji: '🎉', count: 1, mine: false},
];

const AVAILABILITY = {
  reply: true,
  quote: true,
  react: true,
  edit: true,
  delete: true,
};

const HITS: MessageSearchHit[] = [
  {
    channelId: 'ch-1',
    messageId: 'm-1',
    seq: 41,
    authorMemberId: SELF,
    createdAtMs: NOW,
    snippet:
      '어제 이야기한 대로 금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀고, 확인 부탁드립니다.',
    matchOffset: 16,
  },
  {
    channelId: 'ch-2',
    messageId: 'm-2',
    seq: 12,
    authorMemberId: SELF,
    createdAtMs: NOW - 86_400_000,
    snippet: '배포 전에 스테이징에서 한 번 더 돌려 보죠.',
    matchOffset: 0,
  },
];

function search(phase: SearchPhase, hits: MessageSearchHit[] = []): MessageSearch {
  return {
    query: '배포',
    setQuery: () => {},
    phase,
    settledQuery: '배포',
    hits,
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
    retry: () => {},
  };
}

function Frame({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Row() {
  return (
    <MessageRow
      message={MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={CHIPS}
      nowMs={NOW + 900_000}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onOpenThread: () => {},
      }}
    />
  );
}

export function Surface({name}: {name: string}): React.JSX.Element {
  const sheet = (confirm: boolean) => (
    <MessageActionSheet
      message={MESSAGE}
      chips={CHIPS}
      availability={AVAILABILITY}
      authorLabel="곽성재"
      startInDeleteConfirm={confirm}
      onClose={() => {}}
      onToggleReaction={() => {}}
      onReply={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );

  switch (name) {
    case 'sheet':
      return (
        <Frame label="길게 누르기 시트 — 반응·답글·고치기·지우기·닫기">
          <Row />
          {sheet(false)}
        </Frame>
      );
    case 'delete':
      return (
        <Frame label="삭제 확인 — 무엇이 남는지 누르기 전에 말한다">
          <Row />
          {sheet(true)}
        </Frame>
      );
    case 'editor':
      return (
        <Frame label="고치기 — 입력은 동기, 버튼은 44px">
          <Row />
          <MessageEditorSheet
            initialBody={MESSAGE.body ?? ''}
            error={null}
            onCancel={() => {}}
            onSave={() => {}}
          />
        </Frame>
      );
    case 'editor-error':
      return (
        <Frame label="고치기 실패 — 사유가 편집기 안에 남는다">
          <Row />
          <MessageEditorSheet
            initialBody={MESSAGE.body ?? ''}
            error="내가 보낸 메시지만 고칠 수 있습니다."
            onCancel={() => {}}
            onSave={() => {}}
          />
        </Frame>
      );
    case 'row':
      return (
        <Frame label="행 — 반응 칩과 스레드 앵커는 항상 보이는 진입점">
          <Row />
        </Frame>
      );
    case 'search-idle':
      return (
        <Frame label="검색 · 입력 전">
          <SearchBody search={search('idle')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-searching':
      return (
        <Frame label="검색 · 찾는 중">
          <SearchBody search={search('searching')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-empty':
      return (
        <Frame label="검색 · 결과 없음 — 범위를 함께 말한다">
          <SearchBody search={search('empty')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-error':
      return (
        <Frame label="검색 · 오류 — 다시 시도가 있다">
          <SearchBody search={search('error')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-results':
      return (
        <Frame label="검색 · 결과">
          <SearchResults />
        </Frame>
      );
    default:
      return (
        <Frame label={`알 수 없는 표면: ${name}`}>
          <Text style={styles.label}>
            sheet · delete · editor · editor-error · row · search-idle ·
            search-searching · search-empty · search-error · search-results
          </Text>
        </Frame>
      );
  }
}

/** The results phase draws the shipping row, handed fixture hits. */
function SearchResults(): React.JSX.Element {
  return (
    <SearchBody
      search={search('results', HITS)}
      renderItem={({item}) => (
        <ResultRow
          hit={item}
          query="배포"
          channelTitle={item.channelId === 'ch-1' ? '#배포' : '#일반'}
          authorName="곽성재"
          onPress={() => {}}
        />
      )}
    />
  );
}

export default function SurfacesHarness({name}: {name: string}): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <Surface name={name} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: color.bg, paddingTop: 56},
  label: {color: '#6b7280', fontSize: 11, fontWeight: '600', paddingHorizontal: 12},
});
