import type {Member} from '@momo/core/lib/api';
import {canCreateChannelNow} from '@momo/core/features/channels/model';
import {memberFor} from '@momo/core/features/workspace/directory';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {LiquidGlassAllowed} from '../design/glass';
import {EASE_OUT, TAB_FADE_MS} from '../design/motion';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import type {Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {AgentWorkingRail} from '../features/agents/AgentWorkingRail';
import {usePhoneNeedsMe} from '../features/inbox/useNeedsMe';
import {useDirectory} from '../features/workspace/queries';
import {EdgeSwipeBack} from '../nav/EdgeSwipeBack';
import {
  INITIAL_NAV,
  navReducer,
  workConsoleAvailable,
  type OpenAgent,
  type OpenHostedConnection,
  type Tab,
} from '../nav/state';
import {DeviceKeyLinkGate} from '../features/deviceKey/DeviceKeyLinkSheet';
import {NotificationPrimerGate} from '../features/onboarding/NotificationPrimer';
import PushProvider from '../push/PushProvider';
import {useNotificationTapRouting} from '../push/useNotificationTapRouting';
import {RealtimeProvider} from '../realtime/RealtimeProvider';
import AgentDetailScreen from '../screens/AgentDetailScreen';
import AgentsScreen from '../screens/AgentsScreen';
import ConversationScreen from '../screens/ConversationScreen';
import HostedConnectionDetailScreen from '../screens/HostedConnectionDetailScreen';
import HostedConnectionsScreen from '../screens/HostedConnectionsScreen';
import InboxScreen from '../screens/InboxScreen';
import SearchScreen from '../screens/SearchScreen';
import SidebarScreen from '../screens/SidebarScreen';
import TeamBoardScreen from '../screens/TeamBoardScreen';
import WorkSessionDetailScreen from '../screens/WorkSessionDetailScreen';
import {SessionProvider, useSession} from '../session/useSession';
import {AiSheet} from './AiSheet';
import {AskMacSheet} from './AskMacSheet';
import {haptics} from '../lib/haptics';
import type {HarnessKey} from '../features/work/ask/model';
import {DelegateWorkSheet, type DelegatePrefill} from './DelegateWorkSheet';
import {NewChannelSheet} from './NewChannelSheet';
import {NewMessageSheet} from './NewMessageSheet';
import {PlusMenu, type PlusMenuItem} from './PlusMenu';
import {
  Canvas,
  ScrollFade,
  ShellBottomBar,
  TabBarClearanceProvider,
} from './ShellChrome';

// =============================================================================
// The signed-in tree: three tabs on a gradient canvas, a centred pill tab bar
// with a small + beside it, and the surfaces that cover them (ADR-0189 D1,
// DS2-2 #2714; the + and its menu are DS2-2b #2750).
//
// `SessionProvider` is mounted here rather than in `App.tsx` so that everything
// below can take a signed-in member for granted. The gate above has already
// decided; re-checking for null on five screens would be five chances to decide
// differently.
//
// Tab screens stay MOUNTED while a conversation is open, and the conversation is
// drawn over them with `position: absolute` rather than by swapping the tree.
// That is a deliberate choice about scroll position: a sidebar that unmounts
// loses where the person had scrolled to, and coming back from a conversation to
// the top of a 40-channel list is the kind of small wrongness that makes an app
// feel borrowed. It costs one extra mounted subtree.
//
// ## …but a tab is not mounted until it is first opened (goal RN-A1)
//
// "Stays mounted" is about not LOSING a position, and a tab nobody has opened
// has no position to lose. The search tab and the two layers that used to be
// tabs (에이전트 · 작업 — now opened from the + menu) cost real requests on
// mount, and firing those on launch would spend a phone's radio on a screen the
// person may never open. So the set of places that have been visited is
// tracked and each is rendered from its first visit onward: mounting is
// deferred, never undone.
//
// The 인박스 badge is 「나에게 필요한 일」 (#3342): core `needsMe` over the
// approvals this person can decide plus the read-state projection's unread
// mentions (`useNeedsMe`). The 홈 dot is the same projection's 「anything unread」.
// Both sources are caches the screens already hold, so neither costs a request
// the sidebar and inbox would not have made, and neither can disagree with them.
// =============================================================================

export default function AppShell({member}: {member: Member}): React.JSX.Element {
  // `RealtimeProvider` sits INSIDE the session and ABOVE the screens: it needs a
  // session to know which websocket address login returned, and it must outlive
  // any one conversation — a socket rebuilt per screen would throw away the
  // recovery offset that lets a resubscribe replay the gap instead of cold
  // starting (ADR-0137 D4).
  return (
    // `PushProvider` is inside the session and outside the realtime socket. It
    // needs the signed-in workspace, and it must not be torn down when the
    // socket reconnects — losing the notification-response listener mid-session
    // would drop an approval tapped from the lock screen with nothing to show
    // for it (goal RN-N1).
    <SessionProvider member={member}>
      <PushProvider>
        <RealtimeProvider>
          <Shell />
          {/* M3 알림 미리 안내(#2820). 권한이 아직 안 물어졌을 때만 셸 위에 선다. */}
          <NotificationPrimerGate />
          {/* QR 연결 직후 기기 키 등록과 맥 승인 대기(#3026). M3 뒤에 선다. */}
          <DeviceKeyLinkGate />
        </RealtimeProvider>
      </PushProvider>
    </SessionProvider>
  );
}

/** + 가 연 것: 메뉴, 또는 그 메뉴가 넘긴 무거운 시트. */
export type CreateStep = 'menu' | 'dm' | 'channel' | null;

/** 한 번 열린 뒤로 마운트된 채 남는 자리들. 탭 셋과, 탭이던 두 층. */
type Place = Tab | 'agentList' | 'workList';

/**
 * 셸 본체. 앱은 `AppShell`이 프로바이더 셋 안에서 세운다.
 *
 * 내보내는 이유는 **캡처 하네스** 하나다(`measure/surfaces.tsx`의 `shell-*`):
 * 셸 크롬(탭바·+·메뉴·시트)은 탭과 메뉴가 열린 판을 시안 옆에 나란히 놓아야
 * 확인되고, 시뮬레이터에서 그 판을 손으로 만들 수 없다. 시작값들은 그 판을 고르는
 * 것이고, 앱은 기본값(홈, 메뉴·시트 닫힘)만 쓴다.
 */
export function Shell({
  initialNav = INITIAL_NAV,
  initialCreate = null,
}: {
  initialNav?: typeof INITIAL_NAV;
  /** 처음부터 열어 둘 + 메뉴나 그 뒤의 시트. */
  initialCreate?: CreateStep;
} = {}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [nav, dispatch] = useReducer(navReducer, initialNav);
  // + 가 여는 것: 메뉴, 또는 메뉴에서 고른 무거운 시트 하나. 한 번에 하나만 선다.
  const [create, setCreate] = useState<CreateStep>(initialCreate);
  const closeCreate = useCallback(() => setCreate(null), []);
  // 「작업 맡기기」 시트(#3588). `create` 와 따로 둔다: 진입점이 에이전트·채널을 미리
  // 정해 넘기고, `CreateStep` 은 캡처 하네스의 시작값으로도 쓰이는 닫힌 집합이다.
  const [delegate, setDelegate] = useState<DelegatePrefill | null>(null);
  const closeDelegate = useCallback(() => setDelegate(null), []);
  // 「내 맥에 보내기」 시트(#3597). 맥이 꺼져 있을 때 사람이 누르면 N8 시트로 넘어간다.
  const [askMac, setAskMac] = useState(false);
  // 「개인 에이전트」 줄이 고른 하네스. 일반 입구로 열면 없다.
  const [askHarness, setAskHarness] = useState<HarnessKey | undefined>(undefined);
  // 「AI」 시트(N10 #3598). + 메뉴의 AI 줄이 연다. 줄을 고르면 닫히고 그 줄의 시트·목록이 선다.
  const [ai, setAi] = useState(false);
  const closeAi = useCallback(() => setAi(false), []);
  const closeAskMac = useCallback(() => setAskMac(false), []);
  const onDelegateWork = useCallback(
    (prefill: DelegatePrefill) => setDelegate(prefill),
    [],
  );
  const {member, workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  // 채널 만들기는 소유자·관리자만(ADR-0128). 명단이 오기 전에는 행을 세우지 않는다 —
  // 세웠다가 거두는 것이 한 박자 늦게 서는 것보다 나쁘다(core `canCreateChannelNow`).
  const canCreateChannel = canCreateChannelNow(
    !directoryQuery.isPending,
    memberFor(directoryQuery.directory, member.id)?.role,
  );
  // 탭 배지의 출처는 이 한 줄이다(#3342): 인박스 알약 = core `needsMe` 합, 홈 점 = 안 읽음.
  const needsMe = usePhoneNeedsMe();
  // 알림 본문 탭 → 대화 하나 (#2569). 못 가면 그 이유 한 문장을 대화 목록에 둔다.
  // 지금의 자리를 함께 건넨다: 답을 기다리는 탭은 사람이 다른 곳을 고르면 접힌다.
  const tapRouting = useNotificationTapRouting(dispatch, {
    tab: nav.tab,
    conversation: nav.conversation,
  });

  const onOpenConversation = useCallback(
    (
      channelId: string,
      title: string,
      anchor?: {messageId: string; seq: number},
    ) => {
      dispatch({
        type: 'openConversation',
        conversation: anchor
          ? {channelId, title, anchor}
          : {channelId, title},
      });
    },
    [],
  );

  const onBack = useCallback(() => dispatch({type: 'back'}), []);
  const onOpenSearch = useCallback(
    (initialQuery?: string) => dispatch({type: 'openSearch', initialQuery}),
    [],
  );
  const onOpenAgentList = useCallback(
    () => dispatch({type: 'openAgentList'}),
    [],
  );
  const onOpenAgent = useCallback(
    (agent: OpenAgent) => dispatch({type: 'openAgent', agent}),
    [],
  );
  const onOpenWorkSession = useCallback(
    (sessionId: string) =>
      dispatch({type: 'openWorkSession', workSession: {sessionId}}),
    [],
  );
  const onOpenHostedList = useCallback(
    () => dispatch({type: 'openHostedList'}),
    [],
  );
  const onOpenHostedConnection = useCallback(
    (connection: OpenHostedConnection) =>
      dispatch({type: 'openHostedConnection', connection}),
    [],
  );

  // Which places have ever been open. A ref rather than state: it is derived
  // from `nav` and is only ever read during the render that already follows the
  // change, so putting it in state would be a second render for a value the
  // first one could already see.
  const visited = useRef<Set<Place>>(new Set<Place>([initialNav.tab]));
  visited.current.add(nav.tab);
  if (nav.agentList) visited.current.add('agentList');
  if (nav.workList) visited.current.add('workList');
  const workConsole = workConsoleAvailable();

  // + 메뉴의 행. 순서는 Buzz 의 무게 순서(가장 자주 → 드물게)가 아니라 이 제품의
  // 동사 순서다: 사람에게 말하기, 방 만들기, 에이전트 부르기, 에이전트의 일 보기.
  // 「채널 둘러보기」는 없다 — 서버가 참여하지 않은 공개 채널을 내주지도, 스스로
  // 들어가게 하지도 않는다(PR #2750 「남은 일」).
  const plusItems = useMemo<PlusMenuItem[]>(() => {
    const items: PlusMenuItem[] = [
      {
        key: 'dm',
        icon: 'dm',
        label: '새 DM',
        hint: '받는 사람을 고르는 시트를 엽니다.',
        onPress: () => setCreate('dm'),
      },
    ];
    if (canCreateChannel) {
      items.push({
        key: 'channel',
        icon: 'channel',
        label: '새 채널',
        hint: '채널 이름과 공개 범위를 정하는 시트를 엽니다.',
        onPress: () => setCreate('channel'),
      });
    }
    // 에이전트 부르기 · 작업 맡기기 · 내 맥에 물어보기는 「AI」 시트 하나로 모였다(N10 #3598).
    // 4번째 탭은 없다(ADR-0189 D1) — 이 한 줄이 시트를 연다. 시트가 열리는 누름 한 번에
    // 햅틱 한 번(`lib/haptics.ts`).
    items.push({
      key: 'ai',
      icon: 'agent',
      label: 'AI',
      hint: '에이전트와 내 도구를 고르는 시트를 엽니다.',
      onPress: () => {
        haptics.light();
        setAi(true);
      },
    });
    if (workConsole) {
      items.push({
        key: 'work',
        icon: 'work',
        label: '작업',
        hint: '팀이 공유한 작업과 내가 시킨 작업을 봅니다.',
        onPress: () => dispatch({type: 'openWorkList'}),
      });
    }
    return items;
  }, [canCreateChannel, workConsole]);
  // 셸 위에 층이 하나라도 서 있는가. 크롬은 그 밑에 그려지고(트리 순서), 보조기술
  // 에서도 숨는다(`ShellChrome` 의 `coveredProps`).
  const covered =
    nav.conversation !== null ||
    nav.agentList ||
    nav.agent !== null ||
    nav.workList ||
    nav.workSession !== null ||
    nav.hosted !== null;
  // 메뉴가 열린 채 다른 길(알림 탭 등)로 층이 서면 메뉴를 **접는다**. 숨기기만 하면
  // 층이 닫힐 때 아무도 부르지 않은 메뉴가 다시 뜬다(design-review L1).
  useEffect(() => {
    if (covered) setCreate(open => (open === 'menu' ? null : open));
  }, [covered]);

  return (
    <Canvas>
      {/* Renders nothing. Mounted in the SHELL rather than in either surface
          that reads it (goal RN-T2), because the value of a 작업 중 badge is
          telling you an agent is working somewhere you are NOT looking — a rail
          that only ran while the agent list was open could never light a row
          you had not already opened. It detaches itself when the background
          policy parks the socket; see the file's own note on why. */}
      <AgentWorkingRail />
      {/* 탭 화면은 바닥 위에 투명하게 선다. 목록 끝은 탭바 밑에 숨지 않도록 시안의
          140 만큼 비운다(`useTabBarClearance`). */}
      <TabBarClearanceProvider>
        <View style={styles.tabBody}>
          <TabPane active={nav.tab === 'home'}>
            <SidebarScreen
              openChannelId={nav.conversation?.channelId ?? null}
              onOpenConversation={onOpenConversation}
              onOpenSearch={onOpenSearch}
              onOpenAgentList={onOpenAgentList}
              notificationNotice={tapRouting.notice}
              onDismissNotificationNotice={tapRouting.dismissNotice}
            />
          </TabPane>
          <TabPane active={nav.tab === 'inbox'}>
            {/* 숨김은 언마운트가 아니다 (goal RN-B4d / #1020). 탭을 여는 것이 마운트가
                아니므로 react-query 에는 재조회를 걸 계기가 없고, 그래서 승인이
                도착해도 인박스는 「지금 결정할 일이 없습니다」를 유지했다. 보이게 된
                그 순간을 화면에 말해 준다. */}
            <InboxScreen
              active={nav.tab === 'inbox'}
              onOpenConversation={onOpenConversation}
            />
          </TabPane>
          {visited.current.has('search') ? (
            <TabPane active={nav.tab === 'search'} fadeOnMount>
              {/* 씨앗이 바뀌면 새로 세운다: 검색 화면은 자기 입력을 들고 있어서,
                  사이드바가 넘긴 새 검색어는 새 화면으로만 들어간다. */}
              <SearchScreen
                key={nav.searchSeed?.seq ?? 0}
                initialQuery={nav.searchSeed?.initialQuery ?? ''}
                onOpenResult={onOpenConversation}
              />
            </TabPane>
          ) : null}
        </View>
      </TabBarClearanceProvider>

      <ScrollFade />
      <ShellBottomBar
        current={nav.tab}
        inboxCount={needsMe.total}
        homeUnread={needsMe.homeUnread}
        onSelect={tab => {
          setCreate(null);
          dispatch({type: 'selectTab', tab});
        }}
        onPlus={() => setCreate(open => (open === 'menu' ? null : 'menu'))}
        plusOpen={create === 'menu'}
        covered={covered}
      />
      {/* 메뉴는 크롬 바로 뒤, 층들 앞에 그린다: 탭바 위에 떠야 하고, 층이 열리는
          순간(행을 고른 순간)에는 이미 닫혀 있다. */}
      {create === 'menu' && !covered ? (
        <PlusMenu items={plusItems} onClose={closeCreate} />
      ) : null}

      {/* 탭이던 두 층 (ADR-0189 D1). + 메뉴가 열고, 한 번 열린 뒤로는 닫혀도
          마운트된 채 남는다 — 탭일 때와 같은 이유(스크롤 자리)로. */}
      {visited.current.has('workList') && workConsole ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={nav.workList && nav.workSession === null}
          style={[styles.overlay, !nav.workList && styles.hidden]}
          onBack={onBack}
          testID="work-list-pane">
          <TeamBoardScreen
            active={nav.workList && nav.workSession === null}
            onOpenConversation={onOpenConversation}
            onOpenAgentSession={onOpenWorkSession}
            onBack={onBack}
          />
        </EdgeSwipeBack>
      ) : null}

      {visited.current.has('agentList') ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={
            nav.agentList && nav.agent === null && nav.hosted === null
          }
          style={[styles.overlay, !nav.agentList && styles.hidden]}
          onBack={onBack}
          testID="agent-list-pane">
          <AgentsScreen
            onOpenAgent={onOpenAgent}
            onOpenHostedList={onOpenHostedList}
            onBack={onBack}
          />
        </EdgeSwipeBack>
      ) : null}

      {/* One agent sits UNDER the conversation it opens, and stays mounted
          behind it: coming back from an agent's DM must land on that agent
          rather than two steps out. */}
      {nav.agent ? (
        <EdgeSwipeBack style={styles.overlay} onBack={onBack}>
          <AgentDetailScreen
            agent={nav.agent}
            onBack={onBack}
            onOpenConversation={onOpenConversation}
            onDelegateWork={onDelegateWork}
          />
        </EdgeSwipeBack>
      ) : null}

      {/* The 작업 detail is a phone-native push over its list. A conversation
          opened from it sits above this layer, so one back returns here and a
          second back returns to the workspace-wide list. */}
      {nav.workSession ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={nav.conversation === null}
          style={styles.overlay}
          onBack={onBack}
          testID="work-detail-pane">
            <WorkSessionDetailScreen
              active={nav.conversation === null}
              sessionId={nav.workSession.sessionId}
            onBack={onBack}
            onOpenConversation={onOpenConversation}
          />
        </EdgeSwipeBack>
      ) : null}

      {/* 호스티드 연결 관전 (goal HAP-UX3). 목록은 에이전트 목록 위에 뜨고, 상세는
          그 목록 위에 뜬다. 목록은 상세가 열려 있는 동안에도 마운트된 채 밑에 남아,
          뒤로가기가 상세를 벗기면 리마운트 없이 드러난다. */}
      {nav.hosted ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={nav.hosted.kind === 'list'}
          style={styles.overlay}
          onBack={onBack}
          testID="hosted-list-pane">
          <HostedConnectionsScreen
            onBack={onBack}
            onOpenConnection={onOpenHostedConnection}
          />
        </EdgeSwipeBack>
      ) : null}

      {nav.hosted?.kind === 'detail' ? (
        <EdgeSwipeBack
          accessibilityViewIsModal
          style={styles.overlay}
          onBack={onBack}
          testID="hosted-detail-pane">
          <HostedConnectionDetailScreen
            connection={nav.hosted.connection}
            onBack={onBack}
          />
        </EdgeSwipeBack>
      ) : null}

      {/* ## 좌측 엣지에서 밀면 닫힌다 (goal RN-U2)
          성재: "화면 좌측을 슥 넘기면 뒤로가게 해주면 안돼?"

          래퍼가 여기 있는 것은 **움직여야 하는 것이 오버레이 자신**이기 때문이다.
          이 뷰가 셸을 덮는 불투명한 판이므로, 이것이 오른쪽으로 밀려나야 밑에
          있던 탭 화면이 드러난다. 안쪽(예: `Screen`)을 움직이면 이 판의 배경색이
          제자리에 남아 아무것도 드러나지 않는다.

          탭 전환에는 걸지 않는다 — 탭은 push 가 아니라 나란한 곳이고, 그 사이를
          스와이프로 잇는 것은 이 피드백이 요청한 것이 아니다. */}
      {nav.conversation ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={nav.workSession !== null}
          style={styles.overlay}
          onBack={onBack}
          testID="conversation-pane">
          <ConversationScreen
            channelId={nav.conversation.channelId}
            title={nav.conversation.title}
            anchor={nav.conversation.anchor}
            notification={nav.conversation.notification}
            onBack={onBack}
            // ADE 관제 목록의 카드가 자기 채널로 확대되는 길 (이슈 1137). 셸의
            // 같은 액션이라 뒤로가기는 여전히 한 겹씩 벗겨진다.
            onOpenConversation={onOpenConversation}
            onOpenAgent={onOpenAgent}
            onDelegateWork={onDelegateWork}
          />
        </EdgeSwipeBack>
      ) : null}

      {create === 'dm' ? (
        <NewMessageSheet
          onOpenConversation={onOpenConversation}
          onClose={closeCreate}
        />
      ) : null}
      {create === 'channel' ? (
        <NewChannelSheet
          onOpenConversation={onOpenConversation}
          onClose={closeCreate}
        />
      ) : null}
      {ai ? (
        <AiSheet
          onClose={closeAi}
          onDelegate={() => {
            setAi(false);
            setDelegate({});
          }}
          onOpenAgentList={() => {
            setAi(false);
            onOpenAgentList();
          }}
          onAskMac={harness => {
            setAi(false);
            setAskHarness(harness);
            setAskMac(true);
          }}
        />
      ) : null}
      {askMac ? (
        <AskMacSheet
          initialHarness={askHarness}
          onClose={closeAskMac}
          onUseAgent={() => {
            setAskMac(false);
            setDelegate({});
          }}
          onOpenSession={sessionId => {
            if (workConsole) dispatch({type: 'openWorkSession', workSession: {sessionId}});
          }}
          onOpenWorkList={() => {
            if (workConsole) dispatch({type: 'openWorkList'});
          }}
        />
      ) : null}
      {delegate !== null ? (
        <DelegateWorkSheet
          prefill={delegate}
          boardAvailable={workConsole}
          onClose={closeDelegate}
          // 접수되면 작업 보드로 간다. 보드는 닫혀 있던 사람에게도 한 번에 보이도록 층을
          // 새로 연다(`openWorkList`는 열린 대화·에이전트 층을 걷는다).
          onSubmitted={() => dispatch({type: 'openWorkList'})}
        />
      ) : null}
    </Canvas>
  );
}

/**
 * 탭 화면 하나의 칸. 보이는 칸은 `flex: 1`, 숨은 칸은 `display: none` — 언마운트가 아니다
 * (스크롤 자리 보존, 위 머리 주석).
 *
 * ## 탭이 바뀔 때의 움직임 (#3580)
 *
 * 새로 보이는 칸은 **불투명도만** 0 → 1 로 150ms(`EASE_OUT`) 드러난다. 이동·확대 없음:
 * 탭은 위계가 아니라 나란한 곳이고, 하루 수백 번 보는 전환에 깊이를 암시하는 슬라이드는
 * 값을 치른다(emil `animate-expo` §1). 선택이 어디로 옮겨갔는지는 탭바의 캡슐이 말한다.
 * 나가는 칸은 즉시 사라진다 — 둘을 동시에 그리면 비용과 겹침이 생긴다.
 *
 * - 첫 그림은 움직이지 않는다(앱 시작에 홈이 페이드인하지 않게). 처음 열릴 때 마운트되는
 *   검색 칸만 `fadeOnMount` 로 같은 페이드를 탄다.
 * - 도중에 다른 탭을 눌러도 입력을 잠그지 않는다: 값은 다시 열릴 때 0 에서 출발한다.
 * - 동작 줄이기: 페이드 없이 바로 1.
 * - 불투명도를 층 안쪽이 아니라 **칸**에 건다. 탭바의 `GlassView` 는 조상에 알파가 낮으면
 *   효과를 못 그리므로(`glass.tsx`), 이 칸은 탭바의 조상이 아니라 형제다.
 *
 * `useLayoutEffect` 인 이유: `display` 가 바뀐 그 그림이 불투명도 1 로 한 번 그려지고
 * 나서 0 으로 내려가면 깜빡임이 된다. 그리기 전에 0 을 세운다.
 */
export function TabPane({
  active,
  fadeOnMount = false,
  children,
}: {
  active: boolean;
  fadeOnMount?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const reduceMotion = useReduceMotionRef();
  const opacity = useRef(new Animated.Value(1)).current;
  const wasActive = useRef(fadeOnMount ? false : active);
  useLayoutEffect(() => {
    const opened = active && !wasActive.current;
    wasActive.current = active;
    if (!opened) return;
    if (reduceMotion.current) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: TAB_FADE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    }).start();
  }, [active, opacity, reduceMotion]);
  return (
    <Animated.View
      style={[active ? styles.visible : styles.hidden, {opacity}]}
      testID={active ? 'tab-pane-active' : undefined}>
      {/* 페이드되는 조상 안의 유리는 리퀴드가 될 수 없다(`LiquidGlassAllowed`). */}
      <LiquidGlassAllowed.Provider value={false}>{children}</LiquidGlassAllowed.Provider>
    </Animated.View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  tabBody: {flex: 1},
  // `display: none` rather than unmounting: see the header note on scroll
  // position. The hidden subtree keeps its state and does no layout work.
  visible: {flex: 1},
  hidden: {display: 'none'},
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bg,
  },
});
