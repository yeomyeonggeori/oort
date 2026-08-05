import type {Message, MessageSearchHit} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {SearchPhase} from '@momo/core/features/search/searchModel';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {SessionProvider} from '../src/session/useSession';
import {quoteDraftFor, type QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
import {typingSegments} from '@momo/core/features/chat/typing';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {TypingBar} from '../src/features/conversation/TypingBar';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  ROW_PRESSED_BACKGROUND,
  UnreadDivider,
} from '../src/features/conversation/MessageRow';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {NoticeBlock} from '../src/design/atoms';
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
// ## U4-2 가 더한 것 (design-review N-8)
//
// 그 리뷰의 **시각 위상이 통째로 SKIPPED** 였고, 직접적 원인이 이것이었다:
// M1~M4 가 더한 네 표면 중 **하나도** 이 하네스에 서지 않았다. 그래서 대비·기하
// 지적이 전부 「코드에서 도출한 값」으로만 남았고, 리뷰어가 스스로 적었다 —
// *"픽셀을 봤다고 주장하는 지적은 이 보고서에 없다."*
//
// 아래 여섯 케이스가 그 공백을 닫는다. 다음 리뷰는 계산이 아니라 사진을 본다:
//
//   QUOTE-READY · QUOTE-DELETED · QUOTE-UNRESOLVED   인용 3상태
//   TYPING-ONE · TYPING-MANY                          작성 중 (1인·집계)
//   MARKDOWN                                          코드·리스트·인라인 코드
//
// 시트류는 `Modal` 이라 화면을 덮으므로 한 번에 하나씩 띄운다.
// =============================================================================

const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);
const SELF = (ROSTER.find(m => m.kind === 'human') ?? ROSTER[0]).id;
// 인용의 **원본 저자**. 자기 말을 자기가 인용하는 화면은 이 기능이 실제로 쓰이는
// 모양이 아니다 (design-review N-7).
/** 승인을 요청하는 쪽은 에이전트다 — 에이전트는 멤버다(ADR-0004). */
const AGENT = (ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]).id;
const OTHER = (
  ROSTER.find(m => m.kind === 'human' && m.id !== SELF) ?? ROSTER[1] ?? ROSTER[0]
).id;
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

/** M-2 가 말하는 충돌은 **코드 상자를 든 행**에서만 보인다. */
const CODE_BODY = [
  '재시작 절차는 아래와 같습니다',
  '',
  '```sh',
  'systemctl restart momo-relay',
  '```',
].join('\n');

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
      // 이 둘이 빠져 있었다. `onQuote`/`onCopy` 가 없으면 시트가 그 줄을 아예
      // 안 그리므로(`availability.quote && onQuote`), 사진 속 시트는 **배송되는
      // 시트보다 두 줄 짧았다** — 큰 접근성 글자에서 넘침을 보려던 M-7 증거가
      // 하필 넘치지 않는 시트를 찍고 있었다. AX5 캡처가 이 결함을 드러냈다.
      onQuote={() => {}}
      onCopy={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );

  // ---- U4-2 (N-8): 이번 배치가 만든 표면들 ----------------------------------
  //
  // 인용 블록은 **행 안에** 세운다. 따로 띄우면 이 배치가 고친 것(H-2 — 인용이
  // 행 위에서 어떤 무게로 앉는가)이 사진에 안 나온다.
  const quoted = (block: QuoteBlockModel) => (
    <MessageRow
      message={MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={CHIPS}
      nowMs={NOW}
      quote={block}
    />
  );

  switch (name) {
    case 'quote-ready': {
      const draft = quoteDraftFor({
        ...MESSAGE,
        id: 'orig-1',
        seq: 4,
        // 원본은 **타인**이 썼다 (N-7). `MESSAGE` 를 그대로 펼치면 저자가
        // `SELF` 라 행 저자와 인용 저자가 같은 이름으로 찍힌다.
        authorMemberId: OTHER,
        body: '릴레이가 pool exhausted 로 멈췄습니다. 재시작이 필요합니다.',
      });
      return (
        <Frame label="인용 · 정상 — 중성 규정선, 배경 없음 (H-2)">
          {draft ? quoted(draft.block) : <View />}
        </Frame>
      );
    }
    case 'quote-deleted':
      return (
        <Frame label="인용 · 삭제된 원본 — 사본을 남기지 않는다">
          {/* 인용 원본의 저자는 **타인**이다 (design-review N-7). 첫 판은
              `SELF` 였고, 그래서 사진에서 행 저자와 인용 저자가 둘 다 같은
              이름으로 나왔다 — 자기 말을 자기가 인용하는 화면은 이 기능이
              실제로 쓰이는 모양이 아니고, 「누가 한 말인가」가 보이지 않아
              인용 머리줄이 무슨 일을 하는지도 안 보인다. */}
          {quoted({
            kind: 'deleted',
            targetId: 'orig-1',
            targetSeq: 4,
            authorMemberId: OTHER,
          })}
        </Frame>
      );
    case 'quote-unresolved':
      return (
        <Frame label="인용 · 아직 못 푼 원본 — 삭제라고 부르지 않는다">
          {quoted({kind: 'unresolved', targetId: 'orig-1', targetSeq: null})}
        </Frame>
      );
    // ---- U4-3 (#1079): 최종 리뷰가 지목한 잔여 위상 --------------------------
    case 'typing-empty':
      return (
        <Frame label="작성 중 · 아무도 안 침 — 자리는 그대로 (H-3)">
          {/* `typing-one` 과 **나란히 놓고 보라**는 것이 이 사진의 용도다.
              H-3 이 주장하는 것은 「줄이 뜨고 질 때 컴포저가 안 움직인다」이고,
              그 주장은 두 장의 높이가 같을 때만 참이다. 한 장으로는 증명이
              안 되므로 두 장이 한 쌍이다. */}
          <TypingBar segments={[]} />
        </Frame>
      );
    case 'jump-missed':
      return (
        <Frame label="인용 점프 실패 — 실패가 아니라 사실 진술이다 (H-5)">
          {/* 두 이유를 **함께** 세운다. 이 고지의 설계 논점이 「어디 있는지
              모르면 모른다고 말한다」인데, 한 장만 찍으면 그 대비가 안 보인다.
              문장은 화면이 쓰는 것과 **같은 상수**에서 온다. */}
          <View style={styles.noticeStack}>
            <NoticeBlock
              headline={jumpMissedNotice('older').headline}
              detail={jumpMissedNotice('older').detail}
              onDismiss={() => {}}
              testID="quote-jump-missed"
            />
            <NoticeBlock
              headline={jumpMissedNotice('unknown').headline}
              detail={jumpMissedNotice('unknown').detail}
              onDismiss={() => {}}
              testID="quote-jump-missed-unknown"
            />
          </View>
        </Frame>
      );
    case 'row-pressed':
      return (
        <Frame label="행 눌림 — 코드 상자의 고도가 사라진다 (M-2, 1.000:1)">
          {/* 시뮬레이터는 손가락을 대고 있을 수 없다. 그래서 눌린 채움을
              **같은 심볼**(`ROW_PRESSED_BACKGROUND`)로 깔고 진짜 행을 그 위에
              세운다 — 색을 베껴 적었다면 이 사진은 증거가 아니다.

              아래 두 행은 코드 상자를 든 같은 본문이고, 위는 평상시·아래는
              눌린 동안이다. M-2 의 주장은 「눌리면 상자의 채움과 행의 채움이
              같은 `surface` 가 되어 상자가 사라진다」이므로, **아래 사진에서
              상자가 안 보이는 것이 곧 확인**이다. */}
          <View style={styles.pressPair}>
            <MessageBody body={CODE_BODY} />
          </View>
          <View style={[styles.pressPair, styles.pressed]}>
            <MessageBody body={CODE_BODY} />
          </View>
        </Frame>
      );
    case 'typing-one':
      return (
        <Frame label="작성 중 · 1인 — 컴포저 위 한 줄">
          <TypingBar segments={typingSegments(['김민수'])} />
        </Frame>
      );
    case 'typing-many':
      return (
        <Frame label="작성 중 · 집계 — 임계를 넘으면 수를 말한다">
          <TypingBar
            segments={typingSegments(['김민수', '이하늘', '박도윤'])}
          />
        </Frame>
      );
    case 'markdown':
      return (
        <Frame label="본문 렌더 — 코드 상자·불릿·순서 목록·인라인 코드 (H-4·M-4)">
          <MessageBody
            body={[
              '**결론**: 재시작이 필요합니다',
              '',
              '- `outbox_drain_worker` 가 멈췄다',
              '- 재시작 뒤 `seq` 는 이어진다',
              '',
              // 순서 목록이 하네스에 없어서 M-4 의 마커 칸이 **한 번도 안
              // 찍혔다**. 9→10 경계를 넘겨 두는 이유는 그 자리에서만 보이는
              // 것이 있기 때문이다: 마커 폭이 한 자리에서 두 자리로 늘 때
              // 본문 시작점이 따라 밀리는지.
              '9. 릴레이를 멈춘다',
              '10. `seq` 가 이어지는지 확인한다',
              '',
              '```sh',
              'systemctl restart momo-relay',
              '```',
              '',
              '자세한 것은 [배포 문서](https://momo.example/deploy) 참고.',
            ].join('\n')}
          />
        </Frame>
      );
    case 'markdown-pending':
      return (
        <Frame label="본문 렌더 · 보내는 중 — 코드까지 함께 흐려진다 (H-4)">
          <MessageBody
            body={['보내는 중입니다', '', '```sh', 'echo hi', '```'].join('\n')}
            muted
          />
        </Frame>
      );
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
    // ---- U4-4 M1 (#1084): 승인 카드가 막다른 길이 아니게 됐다 -----------------
    case 'approval-card': {
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000b1',
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        props: {
          approval_id: 'ap-1',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const gates = new Map([
        [
          'ap-1',
          {approvalId: 'ap-1', reversible: false, expiresAtMs: null},
        ],
      ]);
      return (
        <Frame label="승인 카드 — 결정 가능 / 불가 / 결정 뒤 (감사 H-1)">
          {/* 세 상태를 한 장에 세운다. 이 goal 의 논점이 「언제 컨트롤이 서는가」
              이므로 한 상태만 찍으면 그 논점이 사진에 안 나온다. */}
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalReceipts={
              new Map([['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}]])
            }
          />
        </Frame>
      );
    }
    // ---- U4-4 M2 (#1083): 시간과 경계 ----------------------------------------
    case 'group': {
      // 한 사람이 연달아 쓴 그룹. 이 goal 의 논점 둘이 여기서만 보인다:
      // 연속 행에 시각이 있는가(H-3), 그리고 메시지 사이 경계가 읽히는가(H-7).
      const at = (min: number, sec = 0) =>
        NOW - (14 - min) * 60_000 - sec * 1000;
      const lines = [
        ['릴레이가 pool exhausted 로 멈췄습니다.', 0],
        ['재시작하면 seq 는 이어집니다.', 1],
        ['배포 문서에 롤백 절차도 적어 뒀어요.', 4],
      ] as const;
      return (
        <Frame label="같은 저자 그룹 — 연속 행의 시각과 경계 (감사 H-3·H-7)">
          {lines.map(([body, min], i) => (
            <MessageRow
              key={i}
              message={{
                ...MESSAGE,
                id: `grp-${i}`,
                seq: 40 + i,
                body,
                createdAtMs: at(min as number),
                thread: undefined,
              } as unknown as Message}
              startsGroup={i === 0}
              directory={DIRECTORY}
              chips={i === 0 ? CHIPS : []}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    case 'dividers':
      return (
        <Frame label="구분선 — 오늘/어제/절대 · 좌측 라벨 (감사 H-4·M-2)">
          {/* 넷을 나란히 세우는 이유: 이 goal 의 논점이 「같은 가족으로
              보이는가」이고, 한 장에 모아야 여백 위계(날짜 > 표지)와 라벨
              정렬이 한눈에 보인다. */}
          <DayDivider atMs={NOW} nowMs={NOW} />
          <DayDivider atMs={NOW - 26 * 3_600_000} nowMs={NOW} />
          <DayDivider atMs={NOW - 40 * 24 * 3_600_000} nowMs={NOW} />
          <UnreadDivider count={12} />
          <RecoveryDivider seq={4821} source="backfill" />
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

// =============================================================================
// 이 하네스에는 세션이 없었다 — 그리고 그것이 결합 하나를 드러냈다
//
// U4-4 M1 이 승인 카드에 컨트롤을 세우자 `approval-card` 사진이 **빨간 에러
// 화면**으로 찍혔다: `useSession() was called outside SessionProvider`.
//
// 원인은 하네스의 버그가 아니라 **진짜 결합**이다. `ApprovalDecision` 은
// `workspaceId` 를 세션에서 읽는다(결정을 어느 워크스페이스에 보내는지는 화면이
// 아니라 세션이 안다). 그래서 「행에 게이트를 건네면 그 표면에는 세션이 있어야
// 한다」가 이 배치가 만든 새 계약이고, 하네스는 그 계약을 처음 어긴 호출자였다.
//
// 읽기 전용 표면(하네스·검색 미리보기)이 게이트를 **안** 건네면 세션 없이도
// 그대로 선다 — `actions?` prop 이 이미 쓰는 규율과 같다. 그 사실은 단정으로
// 잠갔다(`approvalCard.test.tsx`).
//
// 여기서는 사진을 찍어야 하므로 세션을 세운다. 가짜 멤버 하나면 되고, 그
// 멤버는 이미 로스터가 만들고 있다 — 목업을 그리는 것이 아니라 **배송되는
// 컴포넌트가 요구하는 문맥을 그대로 주는 것**이다.
// =============================================================================

/** 하네스용 세션. 결정은 전송되지 않는다(사진은 무장 전 상태를 찍는다). */
const HARNESS_MEMBER = {
  id: SELF,
  workspaceId: 'measure-ws',
  displayName: '곽성재',
} as Member;

export default function SurfacesHarness({name}: {name: string}): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={harnessClient}>
        <SessionProvider member={HARNESS_MEMBER}>
          <Surface name={name} />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** 네트워크로 나가지 않는다. 하네스는 사진을 찍지 데이터를 받지 않는다. */
const harnessClient = new QueryClient({
  defaultOptions: {queries: {retry: false, enabled: false, gcTime: 0}},
});

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: color.bg, paddingTop: 56},
  label: {color: '#6b7280', fontSize: 11, fontWeight: '600', paddingHorizontal: 12},
  noticeStack: {padding: 16, gap: 12},
  pressPair: {paddingHorizontal: 16, paddingVertical: 8},
  // 화면이 누를 때 실제로 까는 값 — **같은 심볼**이다 (M-2).
  pressed: {backgroundColor: ROW_PRESSED_BACKGROUND},
});
