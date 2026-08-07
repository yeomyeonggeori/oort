import type {Message, MessageSearchHit} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {SearchPhase} from '@momo/core/features/search/searchModel';
import React from 'react';
import {LogBox, StyleSheet, Text, View} from 'react-native';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {SessionProvider} from '../src/session/useSession';
import {quoteDraftFor, type QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
import {typingSegments} from '@momo/core/features/chat/typing';
import {Composer} from '../src/features/conversation/Composer';
import {saveDraft} from '../src/features/conversation/drafts';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {PinListPanel} from '../src/features/conversation/PinListPanel';
import {TypingBar} from '../src/features/conversation/TypingBar';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {
  DayDivider,
  MessageRow,
  PendingRow,
  RecoveryDivider,
  rowPressedBackground,
  UnreadDivider,
} from '../src/features/conversation/MessageRow';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {SpawnHostChoice} from '../src/features/inbox/SpawnHostChoice';
import {AdeControlPanel} from '../src/features/ade/AdeControlPanel';
import {AdeSummaryLine} from '../src/features/ade/AdeSummaryLine';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {markAgentWorking, resetAgentWorking} from '../src/features/agents/workingSignal';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {Timeline} from '../src/features/conversation/Timeline';
import {Screen, ScreenHeader} from '../src/design/atoms';
import {ThemeControl} from '../src/design/ThemeControl';
import {parseExecutionPlan} from '@momo/core/lib/executionPlan';
import {measureMode} from './root';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {NoticeBlock} from '../src/design/atoms';
import {ResultRow, SearchBody} from '../src/screens/SearchScreen';
import type {MessageSearch} from '../src/features/search/useMessageSearch';
import type {Palette} from '../src/design/tokens';
import {FixedScheme, useStyles, type ColorScheme} from '../src/design/theme';

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
// ## U4-5M 이 더한 것 (#1097)
//
//   PENDING-GUTTER   낙관적 메아리의 좌우 여백 (감사 M-12) — 확정 행과 **나란히**
//   DELETED-FOLD     연달아 지워진 메시지의 접기 (감사 M-1) — 접히지 않는 경우 포함
//   LANDED           인용 점프 착지 틴트 (#1076) — 물든 행과 이웃을 한 장에
//
// 셋 다 **비교 대상을 같은 화면에 둔다.** 위생 결함은 혼자 찍으면 안 보이기
// 때문이다: 「여백이 0 이다」는 여백을 가진 행 옆에서만 보이고, 「접혔다」는 접히지
// 않은 묘비 옆에서만, 「물들었다」는 안 물든 이웃 옆에서만 보인다.
//
// ## U4-6M 이 더한 것 (#1103)
//
//   AVATAR            폰 아바타 신설 (감사 H-11) — 사람 · **연속 행** · 에이전트 ·
//                     명부에 없는 작성자를 한 묶음처럼
//   APPROVAL-NOTES    승인 카드 세 문장의 격 (리뷰 M-3) — 영수증 · 차단 · 안내.
//                     **오프라인 상태는 U4-4 리뷰가 미캡처로 남긴 자리다**
//                     (「증거가 상수 하나뿐이라 시각 판정은 확인 필요」).
//   COMPOSER-OFFLINE  보낼 수 있을 때 ↔ 지금은 못 보낼 때 (감사 H-10)
//
// ## ADE 1단계가 더한 것 (이슈 1114)
//
//   SPAWN-LOCKED      잠긴 픽커 ↔ 살아 있는 픽커 (리뷰 B1) — 무장하면 픽커가
//                     잠기는데, 그것이 **보이는지**는 살아 있는 판 옆에서만
//                     사진으로 확인된다. 시뮬레이터가 탭을 못 받아 카드를
//                     통과시킬 수 없으므로 컨트롤을 직접 두 번 세운다.
//   SPAWN-PICKER      승인 카드의 호스트 선택기 (ADR-0125 D6-A) — 자격 둘 ·
//                     오프라인 하나 · T3 예약 하나를 한 장에, 그리고 그 옆에
//                     **고를 것이 하나도 없는** 카드. 같은 규율의 네 번째 적용이다:
//                     「자격 없는 줄이 사유와 함께 선다」는 자격 있는 줄 옆에서만,
//                     「승인이 꺼졌다」는 켜진 승인 옆에서만 사진에서 확인된다.
//
// ## U2 가 더한 것 — 표면이 아니라 **축** 하나
//
//   THEME             스킴 세 칸과, 그 선택을 받는 진짜 타임라인 행. 컨트롤만
//                     찍으면 이 배치가 한 일의 절반만 남는다 — 논점은 「고른
//                     스킴이 화면 끝까지 가는가」이고, 위는 종이인데 아래 행만
//                     밤하늘인 사진이 곧 그 실패다.
//
// 그리고 이 배치부터 **모든 표면이 두 번 찍힐 수 있다.** 이름 앞에 `light-` 를
// 붙이면 같은 장이 라이트로 나온다(`measure/root.ts` 가 그 접두사를 스킴으로
// 읽는다). 인자를 하나 더 늘리지 않은 이유는 표면 목록이 계속 자라기 때문이고,
// 스킴을 **못 박는** 이유는 시뮬레이터의 시스템 설정을 따라가면 같은 명령이 기기
// 상태에 따라 다른 색을 찍기 때문이다 — 그 사진은 증거가 아니라 일화가 된다.
//
//     xcrun simctl launch booted app.momo.ios --args -momoMeasure LIGHT-THEME
//
// 같은 규율의 세 번째 적용이다. 「왼쪽 칸이 같다」는 연속 행이 함께 있어야,
// 「영수증이 격상됐다」는 안내 문장이 함께 있어야, 「버튼이 꺼졌다」는 켜진 버튼이
// 함께 있어야 사진에서 확인된다.
//
// 시트류는 `Modal` 이라 화면을 덮으므로 한 번에 하나씩 띄운다.
//
// ## 캡처는 코드와 **같은 커밋**에서 갱신한다 (design-review E-1)
//
// U4-4 는 이 규율 없이 랜딩했고, 그래서 `captures/u44-row.png` 가 두 커밋 낡은
// 채 남았다 — 그 사이에 행 지오메트리가 바뀌었는데 사진은 옛 코드의 **겹쳐 인쇄된
// 글자**를 담고 있었다. 결과는 리뷰어가 저장소만 읽어서는 그것이 고쳐진 것인지
// 남아 있는 것인지 판별할 수 없었고, 실제로 판별하지 못해 지적 하나를
// 「확인 필요」로 쪼개야 했다. **낡은 캡처는 증거가 아니라 잘못된 증언이다.**
//
// 그래서 규칙은 둘 중 하나다: 이 파일이나 그 표면이 그리는 컴포넌트를 고치는
// 커밋은 해당 캡처를 함께 갱신하거나, 그 캡처를 지운다. 명령은 이렇다 —
// 앱을 이 체크아웃에서 빌드·설치한 뒤(`npm run build:sim`),
//
//   xcrun simctl launch booted app.momo.ios --args \
//     -momoMeasure ROW-LEAD -RCT_jsLocation "127.0.0.1:$METRO_PORT"
//   xcrun simctl io booted screenshot --type=png measure/captures/u44-row-lead.png
//
// 기기는 **iPhone 17 Pro**(1206×2622, 3x)이고 읽을 때 **pt = px/3** 이다.
// Metro 가 다른 워크트리를 서빙하고 있으면 사진은 이 체크아웃의 것이 아니다 —
// `scripts/measure.sh` 가 그 함정과 확인 방법(`/status` 의 project-root 헤더)을
// 이미 적어 두었고, 캡처도 같은 확인을 지나야 한다.
// =============================================================================

// =============================================================================
// LogBox 는 이 모듈에서만 꺼진다 (이슈 1137).
//
// `index.js` 는 표면 모드일 때만 이 파일을 `require` 하므로, 이 줄은 사진을 찍는
// 실행에서만 돈다 — 개발자가 앱을 띄우는 보통의 실행에는 닿지 않는다.
//
// 끄는 이유는 **사진 위의 배너가 질문을 만들기 때문**이고(`measure/states.tsx` 가
// VirtualizedList 경고에 대해 같은 말을 한다), 지금 뜨는 그 경고는 이 배치의 것이
// 아니다. 실측으로 문장을 확인했다(`metro --client-logs`):
//
//   WARN  The global process.env.EXPO_OS is not defined. This should be inlined
//         by babel-preset-expo during transformation.
//
// babel 변환 설정에 대한 말이고 이 저장소의 화면 코드와 무관하다. 같은 트리를
// jest 로 렌더하면 `console.warn`·`console.error` 가 0건이다.
// =============================================================================
LogBox.ignoreAllLogs(true);

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

/**
 * 고정 목록의 씨앗 (이슈 #1112). 셋인 이유: 작성자가 갈리고(이름 줄), 본문 길이가
 * 갈리고(한 줄·잘린 줄), 빈 본문이 하나 있어야 「내용 없는 메시지」가 사진에 선다.
 *
 * **고정 시각도 셋이 다르다** (#1146 N1): 오늘 · 어제 · 해를 넘긴 것. 도장이
 * 정렬 근거(`pinnedAtMs`)를 그리는지, 그리고 **해가 다를 때만 연도가 붙는지**는
 * 셋이 한 장에 있어야 사진에서 확인된다 — 「2022년 …」 한 줄만 찍으면 그것이
 * 규칙인지 사고인지 알 수 없다.
 */
const PINS = {
  '00000000-0000-7000-8000-0000000000a1': {
    messageId: '00000000-0000-7000-8000-0000000000a1',
    channelId: 'ch',
    seq: 42,
    authorMemberId: SELF,
    type: 'text',
    state: 'sent',
    body: '금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀어요.',
    createdAtMs: NOW,
    pinnedBy: SELF,
    pinnedAtMs: NOW + 300_000,
  },
  '00000000-0000-7000-8000-0000000000a2': {
    messageId: '00000000-0000-7000-8000-0000000000a2',
    channelId: 'ch',
    seq: 44,
    authorMemberId: OTHER,
    type: 'text',
    state: 'sent',
    body: '온콜 교대는 매주 화요일 10시.',
    createdAtMs: NOW + 60_000,
    pinnedBy: SELF,
    pinnedAtMs: NOW - 86_400_000,
  },
  '00000000-0000-7000-8000-0000000000a3': {
    messageId: '00000000-0000-7000-8000-0000000000a3',
    channelId: 'ch',
    seq: 46,
    authorMemberId: OTHER,
    type: 'artifact',
    state: 'sent',
    body: null,
    createdAtMs: NOW + 120_000,
    pinnedBy: OTHER,
    pinnedAtMs: NOW - 400 * 86_400_000,
  },
};

const CHIPS = [
  {emoji: '👍', count: 3, mine: true},
  {emoji: '🎉', count: 1, mine: false},
];

const AVAILABILITY = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
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


// =============================================================================
// ADE 관제 픽스처 (이슈 1137).
//
// **목업이 아니다.** 앱이 실제로 읽는 두 자리에 앱이 실제로 쓰는 모양으로 넣는다:
// 세션 원장·호스트 등록기·명부·채널은 `react-query` 캐시의 **그 키**에(`agentKeys`
// ·`workspaceKeys` 와 글자 단위로 같다), 열린 턴은 `AgentWorkingRail` 이 쓰는 그
// 스토어 함수(`markAgentWorking`)로. 그래서 사진에 찍히는 것은 배송되는 컴포넌트가
// 배송되는 경로로 읽은 값이다 — `composer-offline` 이 `saveDraft` 로 초안을 심는
// 것과 같은 방법이다.
//
// 픽스처가 고른 여섯 장은 세 상태와 세 생존성 등급을 한 장에 세우기 위한 것이다:
//
//   대기   `orphaned` 세션 · 랩탑 위 호스트   -> 「이 기기에서만」
//   대기   `orphaned` 세션 · **없는 호스트**  -> 「실행 위치 확인 필요」 (warn)
//   실행   `running`  세션 · 클라우드 호스트  -> 「기기를 꺼도 계속됩니다」
//   유휴   `idle`     세션                    -> 목록에는 있고 계수에는 없다
//   대기   승인을 기다리는 턴                 -> 호스트가 없으므로 배지도 없다
//   실행   흐르고 있는 턴                     -> 같음
//
// 둘째 줄은 이 판이 처음 랜딩할 때 **빠져 있었다** — 위 문장은 세 등급을 약속하는데
// 씨앗은 두 개만 만들었다(`app`·`cloud` 둘 다 등록기에 있으므로 `unknown` 이 나올
// 길이 없었다). 그래서 셋 중 **유일하게 경고인** 등급이 사진에 한 번도 서지 못했고,
// 리뷰어는 저장소만 읽어서 그 문장이 읽히는지 판별할 수 없었다(design-review M-1).
// 「경고가 읽히는가」는 안심시키는 배지 옆에서만 사진으로 확인된다 — 이 파일이 잠긴
// 픽커·꺼진 승인에 대해 이미 적어 둔 그 규율이다.
// =============================================================================

/** 하네스 세션의 워크스페이스. 아래 캐시 키가 전부 이 값을 쓴다. */
const ADE_WS = 'measure-ws';

/**
 * 두 번째 에이전트. 스트레스 명부에는 에이전트가 하나뿐인데, 이 장이 보여야 하는
 * 것 중 하나가 **두 방에서 동시에 도는 두 턴**이다 — 요약 줄이 워크스페이스 전역
 * 이라는 사실은 서로 다른 방의 항목이 한 줄로 세어질 때만 사진에 나타난다.
 */
const ADE_AGENT_2 = '00000000-0000-7000-8000-00000000ade2';

const ADE_ROSTER = [
  ...ROSTER,
  {
    ...(ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]),
    id: ADE_AGENT_2,
    displayName: 'codex',
    handle: 'codex',
  },
];

/** 두 번째 에이전트까지 아는 명부. 화면들이 이름을 여기서 얻는다. */
const ADE_DIRECTORY = makeDirectory(ADE_ROSTER);

const ADE_CHANNELS = [
  {id: 'ch-deploy', workspaceId: ADE_WS, kind: 'public', name: '배포', muted: false},
  {id: 'ch-build', workspaceId: ADE_WS, kind: 'public', name: '빌드', muted: false},
] as const;

const ADE_HOSTS = [
  {
    id: 'host-mac',
    workspaceId: ADE_WS,
    scope: 'member',
    ownerMemberId: SELF,
    type: 'app',
    displayName: '성재 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'host-cloud',
    workspaceId: ADE_WS,
    scope: 'workspace',
    ownerMemberId: SELF,
    type: 'cloud',
    displayName: 'momo Cloud',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
] as const;

function adeSession(over: Record<string, unknown>) {
  return {
    workspaceId: ADE_WS,
    channelId: 'ch-deploy',
    memberId: AGENT,
    hostId: 'host-cloud',
    rootMessageId: 'm-root',
    tool: 'codex',
    label: '작업',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: NOW - 900_000,
    ...over,
  };
}

const ADE_SESSIONS = [
  adeSession({
    id: 's-orphaned',
    channelId: 'ch-build',
    hostId: 'host-mac',
    tool: 'claude',
    label: '야간 회귀 스위트',
    status: 'orphaned',
    startedAtMs: NOW - 5_400_000,
  }),
  /**
   * 등록기에 **없는** 호스트를 가리키는 세션 — 「실행 위치 확인 필요」의 유일한
   * 씨앗이다(`sessionDurability` 는 호스트를 못 찾으면 `unknown` 을 답한다).
   *
   * 지어낸 상황이 아니다. 호스트 등록기는 워크스페이스가 지금 아는 기계의 목록이고
   * 세션 원장은 **있었던 일**의 기록이라, 기계가 등록에서 빠진 뒤에도 그 기계에서
   * 돌던 세션 행은 남는다. 그 카드에 대해 화면이 할 수 있는 정직한 말은 「지속된다」
   * 도 「이 기기에서만」 도 아니고 「모른다」 하나뿐이다.
   *
   * `orphaned` 를 고른 것도 그래서다: 호스트가 사라진 것과 세션이 고아가 된 것은
   * 같은 사건의 두 얼굴이라 이 조합이 가장 흔하다. 그리고 그 덕에 이 카드는 사진
   * 에서 **대기 칩(앰버)과 warn 배지(앰버)가 한 카드 안에 겹치는** 유일한 장이
   * 된다 — 리뷰가 눈으로 확인하라고 한 그 겹침이다.
   *
   * 시작 시각은 `s-orphaned`(5,400초)와 `run-approval`(240초) 사이에 둔다. 정렬이
   * 대기 -> 오래된 것 먼저이므로 이 카드는 **둘째 장**에 서고, 바로 위의 muted 배지
   * 와 나란히 찍힌다 — 경고가 안심시키는 말 옆에 있어야 확인된다는 그 규율이다.
   */
  adeSession({
    id: 's-host-gone',
    hostId: 'host-retired',
    tool: 'claude',
    label: '스테이징 마이그레이션',
    status: 'orphaned',
    startedAtMs: NOW - 3_000_000,
  }),
  adeSession({
    id: 's-running',
    label: '릴레이 재시작 절차 정리',
    startedAtMs: NOW - 1_920_000,
  }),
  adeSession({
    id: 's-idle',
    hostId: 'host-mac',
    label: '로그 훑기',
    status: 'idle',
    startedAtMs: NOW - 7_200_000,
  }),
];

/** 열린 턴 둘. 승인 대기가 하나, 흐르는 것이 하나. */
const ADE_TURNS: AgentWorkingSignal[] = [
  {
    memberId: AGENT,
    channelId: 'ch-deploy',
    state: 'awaiting_approval',
    source: 'status',
    runId: 'run-approval',
    startedAtMs: NOW - 240_000,
    headlines: [],
    lastActivityAtMs: NOW,
  },
  {
    memberId: ADE_AGENT_2,
    channelId: 'ch-build',
    state: 'working',
    source: 'run',
    runId: 'run-live',
    startedAtMs: NOW - 95_000,
    headlines: ['테스트 스위트를 돌리는 중'],
    lastActivityAtMs: NOW,
  },
];

/**
 * 대화가 비어 보이지 않을 만큼의 줄. 이 장의 주인공은 위아래 두 스택이지만, 빈
 * 타임라인은 리뷰어에게 「목록이 안 그려졌다」로 읽힌다.
 */
const ADE_TIMELINE: Message[] = [
  {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000b1',
    seq: 40,
    authorMemberId: OTHER,
    body: '릴레이 재시작 절차 문서 링크 좀 올려 주세요.',
    createdAtMs: NOW - 1_200_000,
    thread: undefined,
  },
  {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000b2',
    seq: 41,
    authorMemberId: AGENT,
    body: '문서를 열었습니다. 재시작 전 확인 항목이 셋입니다.',
    createdAtMs: NOW - 900_000,
    thread: undefined,
  },
  MESSAGE,
];

/** 하네스에는 소켓이 없다. 「연결됨」은 이 값 하나로 만들어진다. */
const CONNECTED_RAIL = {
  rail: null,
  status: 'connected' as const,
  subscriptionsWanted: true,
};

/**
 * 두 표면이 읽는 자리를 채운다.
 *
 * **렌더 중에 부르지 않는다.** `markAgentWorking` 은 구독자를 동기적으로 깨우고,
 * 그 구독자 중 하나가 지금 그려지고 있는 `AdeSummaryLine` 이다 — React 는 그것을
 * "Cannot update a component while rendering a different component" 으로 잡고
 * LogBox 가 사진 위에 배너를 얹는다(실측: 첫 캡처에 그렇게 찍혔다). 모듈 몸통은
 * 어떤 렌더보다 먼저 도므로 그 자리가 옳다.
 *
 * 시계는 `Date.now()` 로 흐르므로 경과 숫자는 픽스처의 `startedAtMs` 가 아니라
 * **찍는 순간**을 기준으로 커진다. `NOW` 를 그대로 쓰면 2023년에서 지금까지의
 * 시간이 인쇄되므로, 시작 시각을 현재에서 거꾸로 잡는다.
 */
function seedAdeControl(): void {
  const nowMs = Date.now();
  const shift = nowMs - NOW;
  resetAgentWorking();
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(['channels', ADE_WS], ADE_CHANNELS);
  harnessClient.setQueryData(['work-hosts', ADE_WS], ADE_HOSTS);
  harnessClient.setQueryData(
    ['work-sessions', ADE_WS],
    ADE_SESSIONS.map(session => ({
      ...session,
      startedAtMs: session.startedAtMs + shift,
    })),
  );
  for (const turn of ADE_TURNS) {
    markAgentWorking({
      ...turn,
      ...(turn.startedAtMs === undefined
        ? {}
        : {startedAtMs: turn.startedAtMs + shift}),
      lastActivityAtMs: nowMs,
    });
  }
}


function Frame({label, children}: {label: string; children: React.ReactNode}) {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Row({pinned = false}: {pinned?: boolean} = {}) {
  return (
    <MessageRow
      message={MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={CHIPS}
      // 이슈 #1146 M3. 기본값이 `false` 인 것은 이 하네스의 다른 표면 전부가
      // 고정과 무관하기 때문이다 — 그 사진들은 이 인자로 한 픽셀도 바뀌지 않는다.
      pinned={pinned}
      nowMs={NOW + 900_000}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onOpenThread: () => {},
        onTogglePin: async () => {},
      }}
    />
  );
}

export function Surface({name}: {name: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 이슈 #1112 — 고정 여부만 다른 두 시트. 낱말이 상태를 따라 뒤집히는 것을 한
  // 프레임 안에서 비교하려고 인자를 받는다.
  const pinSheet = (pinned: boolean) => (
    <MessageActionSheet
      message={MESSAGE}
      chips={CHIPS}
      availability={AVAILABILITY}
      pinned={pinned}
      authorLabel="곽성재"
      onClose={() => {}}
      onToggleReaction={() => {}}
      onReply={() => {}}
      onQuote={() => {}}
      onCopy={() => {}}
      onPin={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );
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
      // 이슈 #1112. 같은 함정을 되풀이하지 않으려고 함께 넘긴다 — `onPin` 이
      // 없으면 시트가 그 줄을 안 그리고, 사진 속 시트가 또 배송본보다 짧아진다.
      onPin={() => {}}
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
              **같은 심볼**(`rowPressedBackground`)로 깔고 진짜 행을 그 위에
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
        <Frame label="길게 누르기 시트 — 반응·답글·인용·복사·고정·고치기·지우기·닫기">
          <Row />
          {sheet(false)}
        </Frame>
      );
    // ---- 이슈 #1112: 고정 -----------------------------------------------
    //
    // 시트는 `Modal` 이라 한 프레임에 둘을 세울 수 없다(전면을 덮는다). 그래서
    // 낱말의 뒤집힘은 **두 장**으로 본다: 위의 `sheet` 가 「고정하기」를 그리고
    // (그 시트는 `pinned` 없이 선다), 이 판이 「고정 해제하기」를 그린다. 두 장의
    // 나머지 줄이 글자 하나까지 같아야 뒤집힌 것이 그 한 줄뿐임이 보인다.
    case 'pin-sheet':
      return (
        <Frame label="고정 — 이미 고정된 행의 시트. 그 한 줄만 `sheet` 판과 다르다 (이슈 #1112)">
          <Row />
          {pinSheet(true)}
        </Frame>
      );
    // 행에 남는 흔적 (#1146 M3). **두 행을 한 장에** 두는 것이 이 하네스의 규율이다:
    // 「표지가 섰다」는 표지가 없는 행 옆에서만 보이고, 「위계를 침범하지 않았다」는
    // 「수정됨」과 같은 줄에 나란히 설 때만 보인다. 강조색이 아니라 흐린 글자라는
    // 판정이 사진에서 확인되는 자리이기도 하다.
    case 'pin-mark':
      return (
        <Frame label="고정 흔적 — 고정된 행 ↔ 아닌 행. 꼬리 한 줄, 흐린 글자 (#1146 M3)">
          <Row pinned />
          <Row />
        </Frame>
      );
    case 'pin-list':
      return (
        <PinListPanel
          pins={PINS}
          status="ready"
          directory={DIRECTORY}
          // 고정된 시각으로 도장이 찍히므로 「지금」이 필요하다. 상수인 이유는
          // 사진이 재현돼야 하기 때문이다 — `Date.now()` 로 두면 어제 찍은 것과
          // 오늘 찍은 것이 다른 글자를 담고, 그 차이가 회귀인지 달력인지 알 수 없다.
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      );
    case 'pin-list-empty':
      // 빈 목록은 채워진 것 **옆에서만** 읽힌다: 「이 화면이 아직 아무 말도 못 한
      // 것」과 「할 말이 없다고 말하는 것」이 사진에서 갈리는 자리다.
      return (
        <PinListPanel
          pins={{}}
          status="ready"
          directory={DIRECTORY}
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      );
    // 셋째 판 (#1146 M2). 「없다」와 「모른다」는 **나란히 놓아야** 갈린다: 위의
    // 빈 판과 이 판이 한 리뷰에서 함께 읽히지 않으면, 1차가 오프라인에서 하던
    // 거짓말이 고쳐졌는지 사진으로 확인할 길이 없다. 가진 항목을 함께 세우는
    // 것도 그래서다 — 실패한 목록이 반쪽이라는 사실과 그 반쪽은 둘 다 참이고,
    // 화면은 둘 다 말해야 한다.
    case 'pin-list-failed':
      return (
        <PinListPanel
          pins={PINS}
          status="failed"
          directory={DIRECTORY}
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
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
    // ---- U2: 스킴을 고르는 세 칸, 그리고 그 옆의 진짜 행 ----------------------
    //
    // 컨트롤만 찍으면 이 배치가 한 일의 **절반**만 사진에 남는다. 논점은 「세 칸이
    // 예쁜가」가 아니라 「고른 스킴이 화면 끝까지 가는가」이고, 그 주장은 컨트롤과
    // 타임라인 행이 **같은 장에** 있을 때만 사진에서 확인된다 — 라이트 판에서 위는
    // 종이인데 아래 행만 밤하늘이면 그것이 곧 이 배치의 실패다.
    //
    // `light-theme` 로 띄우면 같은 장이 라이트로 나온다(`measure/root.ts`).
    case 'theme':
      return (
        <Frame label="테마 — 세 칸과, 그 선택을 받는 행 (U2)">
          <ThemeControl />
          <Row />
        </Frame>
      );
    // ---- U4-4R M-1 (#1092): 행의 첫 줄이 시각 칸을 진다 -----------------------
    //
    // 이 goal 이 고친 구멍은 **연속 행의 첫 흐름 자식이 본문이 아닐 때** 시각
    // 칸이 무예약이라는 것이었다. U4-4 의 픽스처는 그 경우를 한 번도 세우지
    // 않았다 — `approval-card` 는 승인 카드 셋 전부에 `startsGroup` 을 건다.
    // 즉 **연달아 온 승인 카드**(타임라인이 승인 카드를 둘 이상 보여 주는 가장
    // 흔한 경로)는 촬영된 적이 없었고, 겹침은 정확히 거기서 일어난다.
    //
    // 한 장에 네 가지 첫 자식을 세운다: 승인 카드(머리) → 승인 카드(연속) →
    // 인용(연속) → 묘비(연속). 논점이 「자식 종류가 늘어도 같은 여백 밑으로
    // 들어오는가」이므로 한 종류만 찍으면 그 논점이 사진에 안 나온다.
    case 'row-lead': {
      // 시각이 **칸**이라는 주장은 값이 서로 다를 때만 사진에서 확인된다 — 넷이
      // 같은 시각이면 오른쪽 정렬인지 우연인지 구분이 안 된다.
      const leadAt = (min: number) => NOW - (14 - min) * 60_000;
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000c1',
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        thread: undefined,
        createdAtMs: leadAt(0),
        props: {
          approval_id: 'ap-2',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const leadQuote = quoteDraftFor({
        ...MESSAGE,
        id: 'orig-lead',
        seq: 7,
        authorMemberId: OTHER,
        body: '릴레이 로그는 어디서 봅니까',
      } as unknown as Message);
      return (
        <Frame label="행의 첫 줄이 시각 칸을 진다 — 연속 승인 카드·인용·묘비 (리뷰 M-1)">
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          {/* 이 행이 이 표면의 이유다: 첫 흐름 자식이 **카드**이고, 카드는
              불투명한 배경과 오른쪽 위 상태 칩을 함께 든다. 예약이 없으면
              시각이 카드 밑으로 사라지거나 「승인 대기」 칩과 겹친다. */}
          <MessageRow
            message={
              {
                ...approvalMessage,
                id: 'ap-row-2',
                seq: 43,
                createdAtMs: leadAt(2),
              } as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          {leadQuote ? (
            <MessageRow
              message={
                {
                  ...MESSAGE,
                  id: 'q-row',
                  seq: 44,
                  thread: undefined,
                  body: '이 로그는 릴레이 컨테이너 안에 있습니다.',
                  createdAtMs: leadAt(5),
                } as Message
              }
              startsGroup={false}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
              quote={leadQuote.block}
            />
          ) : null}
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'del-row',
                seq: 45,
                state: 'deleted',
                thread: undefined,
                createdAtMs: leadAt(11),
              } as unknown as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    // ---- U4-5M (#1097): 폰 위생 · 착지 틴트 · 기준선 ------------------------
    //
    // 셋 다 **한 장에 한 논점**이다. 위생 결함은 옆에 비교 대상이 없으면 사진에서
    // 안 보인다 — 「좌우 여백이 0 이다」는 여백을 가진 행이 같은 화면에 있어야
    // 보이고, 「접혔다」는 접히기 전이 몇 줄이었는지를 알아야 보인다.
    case 'pending-gutter': {
      // 감사 M-12 / #1093 관찰: 낙관적 메아리만 화면 가장자리에 붙어 있었다.
      // 확정 행 → 메아리 → 실패한 메아리 순으로 세운다. 셋의 본문 왼쪽 끝이
      // 한 줄에 서는지가 이 사진의 전부다.
      const echo = (
        clientMsgId: string,
        status: 'sending' | 'failed',
        body: string,
      ) => ({
        clientMsgId,
        channelId: 'ch',
        authorMemberId: SELF,
        body,
        status,
        createdAtMs: NOW,
      });
      return (
        <Frame label="낙관적 메아리도 같은 여백을 진다 (감사 M-12)">
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'confirmed',
                seq: 60,
                thread: undefined,
                body: '확정된 행 — 이 왼쪽 끝이 기준이다.',
              } as Message
            }
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <PendingRow
            pending={
              echo('c-1', 'sending', '보내는 중인 메아리 — 예전엔 여기가 튀어나왔다.') as never
            }
            startsGroup={false}
            directory={DIRECTORY}
          />
          <PendingRow
            pending={echo('c-2', 'failed', '실패한 메아리.') as never}
            startsGroup={false}
            directory={DIRECTORY}
            onResend={() => {}}
          />
        </Frame>
      );
    }
    case 'deleted-fold': {
      // 감사 M-1: 캡처 `m-09` 에서 「삭제된 메시지」가 줄마다 쌓였다. 접힌 뒤와
      // **접히지 않는 경우**를 같은 화면에 둔다 — 규칙이 「전부 접는다」가 아니라
      // 「잃을 것이 없을 때만 접는다」이므로, 접히지 않은 묘비가 없는 사진은 그
      // 규칙을 안 보여 준다.
      const tomb = (id: string, seq: number, over: Partial<Message> = {}) =>
        ({
          ...MESSAGE,
          id,
          seq,
          state: 'deleted',
          body: '',
          thread: undefined,
          createdAtMs: NOW - (60 - seq) * 60_000,
          ...over,
        }) as unknown as Message;
      return (
        <Frame label="연달아 지워진 메시지는 한 줄로 접힌다 (감사 M-1)">
          <MessageRow
            message={tomb('d-1', 51)}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            deletedRepeat={4}
            nowMs={NOW}
          />
          {/* 답글이 달린 묘비는 접히지 않는다 — 「답글 3개」는 방으로 가는 문이다. */}
          <MessageRow
            message={tomb('d-5', 55, {
              thread: {
                reply_count: 3,
                last_reply_seq: 58,
                last_reply_at: NOW,
              },
            } as Partial<Message>)}
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={{
              myMemberId: SELF,
              onToggleReaction: async () => {},
              onEdit: async () => {},
              onDelete: async () => {},
              onOpenThread: () => {},
            }}
          />
          {/* 반응이 달린 묘비도 접히지 않는다. */}
          <MessageRow
            message={tomb('d-6', 56)}
            startsGroup={false}
            directory={DIRECTORY}
            chips={CHIPS}
            nowMs={NOW}
          />
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'alive',
                seq: 57,
                thread: undefined,
                body: '살아 있는 행은 그대로다.',
                createdAtMs: NOW,
              } as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    case 'landed': {
      // #1076: 「방금 여기로 왔다」. 물든 행 하나와 물들지 않은 이웃들이 함께
      // 있어야 이 값이 **띠가 아니라 물듦**이라는 주장이 사진에서 확인된다
      // (1.13:1 — 계산은 `MessageRow` 의 `rowLanded` 주석과
      // `__tests__/conversationHygiene.test.tsx` 에 있다).
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const rows = [
        ['앞 줄 — 물들지 않는다.', 0, false],
        ['인용이 가리킨 원본. 여기로 왔다.', 3, true],
        ['뒷 줄 — 물들지 않는다.', 6, false],
      ] as const;
      return (
        <Frame label="인용 점프 착지 — 「방금 여기로 왔다」 (#1076)">
          {rows.map(([body, min, landed], i) => (
            <MessageRow
              key={i}
              message={
                {
                  ...MESSAGE,
                  id: `land-${i}`,
                  seq: 70 + i,
                  body,
                  thread: undefined,
                  createdAtMs: at(min),
                } as Message
              }
              startsGroup={i === 0}
              directory={DIRECTORY}
              chips={[]}
              landed={landed}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    // ---- U4-6M (#1103): 아바타 · 문장의 격 · 컴포저 -------------------------
    //
    // 셋 다 **비교 대상을 같은 화면에** 둔다. U4-5M 이 세운 규율 그대로다:
    // 위생과 위계 결함은 혼자 찍으면 안 보인다 — 「모르는 작성자에게 글자가
    // 없다」는 글자가 있는 아바타 옆에서만, 「영수증이 격상됐다」는 안내 문장
    // 옆에서만, 「지금은 못 보낸다」는 보낼 수 있는 컴포저 옆에서만 보인다.
    case 'avatar': {
      // 넷을 한 묶음처럼 세운다: 사람(머리) → 같은 저자의 연속 행 → 에이전트 →
      // 명부에 없는 작성자. 논점이 「왼쪽 칸이 모든 행에서 같은가」이므로 연속
      // 행이 반드시 함께 있어야 하고, 「모를 때 글자를 안 그린다」는 uuid
      // 작성자가 함께 있어야 보인다.
      const ghost = '0199dddd-1111-4111-8111-999999999999';
      const rows: Array<[string, string, boolean]> = [
        [SELF, '금요일 배포는 오전 10시에 시작합니다.', true],
        [SELF, '롤백 절차는 문서에 적어 뒀어요.', false],
        [AGENT, '릴레이 로그를 확인했습니다. pool exhausted 가 두 번 있었습니다.', true],
        [ghost, '이 작성자는 명부에 없습니다.', true],
      ];
      return (
        <Frame label="아바타 — 사람 · 연속 행 · 에이전트 · 모르는 작성자 (감사 H-11)">
          {rows.map(([author, body, head], i) => (
            <MessageRow
              key={i}
              message={
                {
                  ...MESSAGE,
                  id: `av-${i}`,
                  seq: 60 + i,
                  authorMemberId: author,
                  body,
                  thread: undefined,
                } as unknown as Message
              }
              startsGroup={head}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    case 'approval-notes': {
      // M-3 이 실측한 것: 세 문장이 전부 같은 옷이고, 카드에서 가장 값어치 있는
      // 영수증이 가장 조용한 차림이었다. 한 장에 셋을 세워야 격이 갈렸는지가
      // 사진에서 확인된다 — 하나만 찍으면 그것이 어떤 격인지 알 수 없다.
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000b2',
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
        ['ap-1', {approvalId: 'ap-1', reversible: false, expiresAtMs: null}],
      ]);
      return (
        <Frame label="승인 카드 세 문장의 격 — 영수증 / 차단 / 안내 (리뷰 M-3)">
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
            approvalReceipts={
              new Map([['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}]])
            }
          />
          {/* 오프라인은 U4-4 리뷰가 **미캡처**로 남긴 자리다 — 「증거가 상수
              하나뿐이라 시각 판정은 확인 필요로 남긴다」. 이 장이 그것을 닫는다. */}
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
            approvalOffline
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    // ---- 이슈 1114 (ADE 1단계): 승인 카드 호스트 선택기 --------------------
    case 'spawn-picker': {
      // 스폰 승인은 「해도 되나」와 **「어디서 하나」** 를 함께 묻는다. 이 장이
      // 보여야 하는 것은 라디오가 있다는 사실이 아니라 **자격 없는 줄이 사유와
      // 함께 서 있다**는 것이고, 그것은 자격 있는 줄 옆에서만 보인다 — 네 줄을
      // 한 장에 세우는 이유다(이 파일이 여백·접기·틴트에서 세 번 쓴 규율 그대로).
      //
      // 오른쪽 카드는 **고를 것이 하나도 없을 때**다. 승인 버튼이 실제로 꺼지고
      // 그 위에 이유가 서는 것이 이 배치의 fail-closed 문이며, 꺼진 버튼은 켜진
      // 버튼 옆에서만 꺼진 것으로 읽힌다.
      const host = (
        id: string,
        display_name: string,
        tier: string,
        host_type: string,
        selectable: boolean,
        unavailable_reason: string | null,
      ) => ({
        host_id: id,
        display_name,
        host_type,
        tier,
        scope: tier === 'remote' || tier === 'cloud' ? 'workspace' : 'member',
        online: unavailable_reason !== 'offline',
        selectable,
        unavailable_reason,
      });
      const candidates = [
        host('h-1', '성재 맥북', 'local', 'app', true, null),
        host('h-2', '팀 VPS (서울)', 'remote', 'workd', true, null),
        host('h-3', '작업실 아이맥', 'local', 'app', false, 'offline'),
        host('h-4', 'momo Cloud', 'cloud', 'cloud', false, 't3_disabled'),
      ];
      const execution = (rows: typeof candidates, defaultHostId: string | null) => ({
        kind: 'work_session_spawn',
        tool: 'codex',
        label: '릴레이 재시작 절차 정리',
        requested_host_id: null,
        default_host_id: defaultHostId,
        host_candidates: rows,
      });
      const spawnMessage = (id: string, exec: unknown) =>
        ({
          ...MESSAGE,
          id,
          type: 'approval_request',
          body: '작업 세션 시작 승인',
          authorMemberId: AGENT,
          props: {
            approval_id: id,
            title: 'codex 작업 세션 시작 허가',
            approval_status: 'pending',
            execution: exec,
          },
        }) as unknown as Message;
      const gate = (id: string) =>
        new Map([[id, {approvalId: id, reversible: false, expiresAtMs: null}]]);
      return (
        <Frame label="스폰 승인 호스트 선택기 — 후보 넷 / 고를 것이 없을 때 (이슈 1114)">
          <MessageRow
            message={spawnMessage('ap-spawn', execution(candidates, 'h-1'))}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gate('ap-spawn')}
          />
          <MessageRow
            message={spawnMessage(
              'ap-spawn-blocked',
              execution(
                candidates.filter(row => !row.selectable),
                null,
              ),
            )}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gate('ap-spawn-blocked')}
          />
        </Frame>
      );
    }
    case 'spawn-locked': {
      // **잠긴 판 ↔ 살아 있는 판**, 한 장에 (design-review B1).
      //
      // 무장하면 픽커가 잠긴다. 그것이 보이는지는 살아 있는 픽커 **옆에서만**
      // 사진으로 확인된다 — 이 파일이 여백·접기·틴트에서 세 번 쓴 그 규율이다.
      // 시뮬레이터는 탭을 받지 못해 카드를 통과시켜 무장 상태를 만들 수 없으므로,
      // 카드가 쓰는 그 컴포넌트를 직접 두 번 세운다(shipping 소스 그대로).
      const host = (
        id: string,
        display_name: string,
        tier: string,
        host_type: string,
        selectable: boolean,
        unavailable_reason: string | null,
      ) => ({
        host_id: id,
        display_name,
        host_type,
        tier,
        scope: tier === 'remote' || tier === 'cloud' ? 'workspace' : 'member',
        online: unavailable_reason !== 'offline',
        selectable,
        unavailable_reason,
      });
      const rows = [
        host('h-1', '성재 맥북', 'local', 'app', true, null),
        host('h-2', '팀 VPS (서울)', 'remote', 'workd', true, null),
        host('h-3', '작업실 아이맥', 'local', 'app', false, 'offline'),
      ];
      const parsed = parseExecutionPlan({
        execution: {
          kind: 'work_session_spawn',
          tool: 'codex',
          label: '릴레이 재시작 절차 정리',
          requested_host_id: null,
          default_host_id: 'h-2',
          host_candidates: rows,
        },
      });
      if (parsed === null) {
        return (
          <Frame label="스폰 픽커">
            <Text style={styles.lockedLabel}>픽스처가 픽커로 읽히지 않는다</Text>
          </Frame>
        );
      }
      return (
        <Frame label="스폰 픽커 — 고를 수 있을 때 / 무장 뒤 잠겼을 때 (리뷰 B1)">
          <View style={styles.lockedFrame}>
            <Text style={styles.lockedLabel}>고를 수 있다 (무장 전)</Text>
            <SpawnHostChoice
              plan={parsed}
              pickedHostId="h-2"
              onPick={() => {}}
              locked={false}
              testIDPrefix="measure-live"
            />
          </View>
          <View style={styles.lockedFrame}>
            <Text style={styles.lockedLabel}>
              잠겼다 (무장 뒤) — 고른 것은 남고, 누를 수 있다는 신호는 빠진다
            </Text>
            <SpawnHostChoice
              plan={parsed}
              pickedHostId="h-2"
              onPick={() => {}}
              locked
              testIDPrefix="measure-locked"
            />
          </View>
        </Frame>
      );
    }
    case 'composer-offline': {
      // **글을 미리 넣어 둔다 — 배송되는 경로로.** 빈 컴포저 둘을 나란히 두면 두
      // 버튼이 똑같이 꺼져 있고(위는 「보낼 것이 없다」, 아래는 「지금 못 보낸다」),
      // 그 사진은 이 배치가 고친 것을 하나도 보여 주지 않는다. 초안을 심으면
      // 위 버튼이 켜지고 아래만 꺼진 채로 남아 대조가 생긴다.
      //
      // 그리고 심는 방법이 곧 두 번째 증거다: `saveDraft` → `draftKey` 는 앱이
      // 실제로 쓰는 그 경로이고, 아래 상자에 글이 남아 있는 것이 오프라인 문장
      // 「쓰던 글은 그대로 있고」가 참이라는 그림이다.
      const line = '릴레이 재시작 절차를 문서에 적어 뒀습니다.';
      saveDraft('measure:composer-online', line);
      saveDraft('measure:composer-offline', line);
      return (
        <Frame label="컴포저 — 보낼 수 있을 때 / 지금은 못 보낼 때 (감사 H-10)">
          <Composer
            channelLabel="배포"
            directory={DIRECTORY}
            draftKey="measure:composer-online"
            onSend={() => {}}
          />
          <View style={styles.gap} />
          <Composer
            channelLabel="배포"
            directory={DIRECTORY}
            draftKey="measure:composer-offline"
            offline
            onSend={() => {}}
          />
        </Frame>
      );
    }
    // ---- 이슈 1137 (ADE 3단계, 폰): 요약 한 줄 · 관제 목록 ------------------
    case 'ade-summary': {
      // **두 스택을 한 장에.** 이 배치가 고른 자리가 옳은지는 위(헤더 아래)와
      // 아래(컴포저 액세서리 스택)가 같은 사진에 있어야만 확인된다 — 이 파일이
      // 여백·접기·틴트·잠긴 픽커에서 네 번 쓴 그 규율이다. 위의 한 줄은
      // 워크스페이스 전역 집계이고 아래 줄들은 이 채널의 것이며, 둘이 같은 낱말로
      // 다른 모집단을 세는지가 여기서 눈으로 갈린다.
      //
      // 컴포지션은 `ConversationLayout` 그대로다. 그 파일이 자기가 이름을 가진
      // 이유를 적어 두었다 — "Naming the composition means `measure/` renders the
      // tree that ships."
      // 액세서리 스택에는 **이 채널의 턴만** 간다. 그것이 그 스택의 계약이고
      // (`agentTurnsInChannel` 로 좁힌다), 위의 한 줄이 좁히지 않는다는 사실이
      // 바로 이 대조에서 읽힌다: 아래는 한 줄, 위는 두 방의 넷.
      const channelTurns = ADE_TURNS.filter(
        turn => turn.channelId === 'ch-deploy',
      );
      return (
        <Screen>
          <Text style={styles.label}>
            ADE 요약 줄 — 헤더 아래 (워크스페이스 전역) ↕ 컴포저 액세서리 스택 (이 채널)
          </Text>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <AdeSummaryLine onPress={() => {}} />
          <ConversationLayout
            list={
              <Timeline
                messages={ADE_TIMELINE}
                directory={ADE_DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 900_000}
              />
            }
            composer={
              <>
                <AgentActivityBar
                  turns={channelTurns}
                  directory={ADE_DIRECTORY}
                  nowMs={Date.now()}
                  live
                />
                <TypingBar segments={typingSegments(['박다연'])} />
                <Composer
                  channelLabel="배포"
                  directory={ADE_DIRECTORY}
                  draftKey="measure:ade-summary"
                  onSend={() => {}}
                />
              </>
            }
          />
        </Screen>
      );
    }
    case 'ade-summary-empty': {
      // **줄이 없는 판.** 「살아 있는 작업이 없으면 줄 자체가 없다」는 코어의 판정
      // 이고(`adeSummarySegments`), 그것이 참인지는 줄이 **있는** 사진 옆에서만
      // 확인된다 — 빈 띠를 남겼는지, 남겼다면 컴포저가 그만큼 밀렸는지가 두 장을
      // 겹쳐 보면 바로 나온다. 이 파일이 여백·접기·틴트·잠긴 픽커에서 네 번 쓴
      // 그 규율의 다섯 번째 적용이다.
      //
      // 이 표면만 씨앗을 안 받는다(파일 맨 아래 `seedAdeControl` 호출 참조).
      return (
        <Screen>
          <Text style={styles.label}>
            ADE 요약 줄 — 살아 있는 작업이 없을 때 (줄도, 빈 띠도 없다)
          </Text>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <AdeSummaryLine onPress={() => {}} />
          <ConversationLayout
            list={
              <Timeline
                messages={ADE_TIMELINE}
                directory={ADE_DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 900_000}
              />
            }
            composer={
              <Composer
                channelLabel="배포"
                directory={ADE_DIRECTORY}
                draftKey="measure:ade-summary-empty"
                onSend={() => {}}
              />
            }
          />
        </Screen>
      );
    }
    case 'ade-panel': {
      // 관제 목록. 카드 다섯 장이 **세 상태와 세 생존성 등급**을 한 장에 세운다:
      // 대기(호스트 연결 끊김 · 이 기기에서만) · 실행 중(기기를 꺼도 계속됩니다)
      // · 유휴 · 그리고 호스트가 없는 턴 둘(배지 자체가 없다).
      //
      // 「해당 없음」과 「모른다」가 다른 사실이라는 코어의 판정은 턴 카드에
      // 배지가 **없다**는 것으로만 사진에 나타난다 — 세션 카드 옆에서만 보인다.
      //
      // **사진은 첫 폴링 창 안에서 찍는다.** 이 화면의 세션 질의는 20초 간격을
      // 요구하고(`ADE_SESSION_POLL_MS`), 하네스에는 답할 서버가 없어서 그 첫 tick
      // 이 질의를 오류로 만든다 — 그러면 씨앗으로 채운 카드들 위에 「불러오지
      // 못했습니다」 배너가 함께 서고, 그 사진은 두 가지를 동시에 주장하게 된다
      // (실측: 25초에 찍은 첫 판이 정확히 그렇게 나왔다). 실패 배너 자체는 별도
      // 단정이 지킨다(`__tests__/adeControlSurface.test.tsx`).
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <AdeControlPanel onClose={() => {}} onOpenChannel={() => {}} />
        </RealtimeContext.Provider>
      );
    }
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
            sheet · delete · editor · editor-error · row · row-lead ·
            approval-card · approval-notes · avatar · composer-offline ·
            group · dividers · ade-summary · ade-summary-empty · ade-panel ·
            search-idle ·
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

export default function SurfacesHarness({
  name,
  scheme,
}: {
  name: string;
  scheme: ColorScheme;
}): React.JSX.Element {
  // 스킴을 **못 박아** 그린다 (U2). `ThemeProvider` 를 쓰면 이 기기에 저장된
  // 사람의 선택이 사진에 새어 들어오고, 시스템 추종에 맡기면 시뮬레이터 설정이
  // 새어 들어온다. 사진은 인자가 말한 것만 찍는다.
  return (
    <FixedScheme scheme={scheme}>
      <SafeAreaProvider>
        <QueryClientProvider client={harnessClient}>
          <SessionProvider member={HARNESS_MEMBER}>
            <Surface name={name} />
          </SessionProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </FixedScheme>
  );
}

/** 네트워크로 나가지 않는다. 하네스는 사진을 찍지 데이터를 받지 않는다. */
const harnessClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      enabled: false,
      gcTime: 0,
      // 씨앗을 뿌린 질의가 마운트하자마자 네트워크로 나가지 않게 (이슈 1137).
      // `enabled: false` 는 훅이 명시적으로 `true` 를 넘기면 뒤집히므로, 신선도
      // 쪽에서도 한 번 더 막는다 — 하네스는 사진을 찍지 데이터를 받지 않는다.
      staleTime: Infinity,
    },
  },
});

const buildStyles = (color: Palette) => StyleSheet.create({
    lockedFrame: {paddingHorizontal: 16, paddingTop: 8},
    // 하네스 자신의 라벨. 제품이 아니라 **사진의 캡션**이라 토큰을 든다: 라이트
    // 판에서 어두운 회색 글자가 종이 위에 그대로 서야 캡션이 읽힌다.
    lockedLabel: {fontSize: 12, color: color.textMuted, paddingBottom: 4},
    root: {flex: 1, backgroundColor: color.bg, paddingTop: 56},
    label: {
      color: color.textFaint,
      fontSize: 11,
      fontWeight: '600',
      paddingHorizontal: 12,
    },
    noticeStack: {padding: 16, gap: 12},
    pressPair: {paddingHorizontal: 16, paddingVertical: 8},
    // 화면이 누를 때 실제로 까는 값 — **같은 심볼**이다 (M-2).
    pressed: {backgroundColor: rowPressedBackground(color)},
    /** 두 컴포저 사이. 붙여 두면 위아래 테두리가 한 줄로 읽힌다. */
    gap: {height: 24},
  });

// 위 독스트링의 이유로 렌더 밖에서 한 번. **파일 맨 아래**인 것은 `harnessClient`
// 가 `const` 라 그 선언보다 먼저 부르면 TDZ 로 터지기 때문이고(실측: 첫 시도가
// "Cannot read property 'setQueryData' of undefined" 로 찍혔다), 다른 표면들은 이
// 스토어도 이 키들도 읽지 않으므로 값이 앉아 있어도 자기 사진에 나타나지 않는다.
//
// `ade-summary-empty` 만 빼는 이유는 그 장이 보여야 하는 것이 **아무것도 없을 때**
// 이기 때문이다. 스토어도 캐시도 모듈 상태라 표면마다 다른 값을 줄 방법은 「어느
// 표면으로 띄웠는가」를 렌더보다 먼저 읽는 것 하나뿐이고, 그 답은 루트가 이미
// 파싱하는 그 실행 인자에 있다.
const LAUNCHED = measureMode();
if (
  !(
    LAUNCHED !== null &&
    LAUNCHED.kind === 'surface' &&
    LAUNCHED.name === 'ade-summary-empty'
  )
) {
  seedAdeControl();
}
