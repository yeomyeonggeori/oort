import type {Member} from '@momo/core/lib/api';
import React, {useCallback, useReducer, useRef, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import type {Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {AgentWorkingRail} from '../features/agents/AgentWorkingRail';
import {useMentionCount} from '../features/inbox/useInbox';
import {EdgeSwipeBack} from '../nav/EdgeSwipeBack';
import {
  INITIAL_NAV,
  navReducer,
  workConsoleAvailable,
  type OpenAgent,
  type OpenHostedConnection,
  type Tab,
} from '../nav/state';
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
import WorkConsoleScreen from '../screens/WorkConsoleScreen';
import WorkSessionDetailScreen from '../screens/WorkSessionDetailScreen';
import {SessionProvider} from '../session/useSession';
import {NewMessageSheet} from './NewMessageSheet';
import {
  Canvas,
  FloatingTabBar,
  InkFab,
  ScrollFade,
  TabBarClearanceProvider,
} from './ShellChrome';

// =============================================================================
// The signed-in tree: three tabs on a gradient canvas, a floating pill tab bar,
// an ink FAB, and the surfaces that cover them (ADR-0189 D1, DS2-2 #2714).
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
// tabs (에이전트 · 작업 — now opened from the FAB sheet) cost real requests on
// mount, and firing those on launch would spend a phone's radio on a screen the
// person may never open. So the set of places that have been visited is
// tracked and each is rendered from its first visit onward: mounting is
// deferred, never undone.
//
// The 인박스 badge reads `useMentionCount()`, which is the read-state projection
// the sidebar is already holding — so it is free, and it cannot disagree with
// the per-channel counts one screen over.
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
        </RealtimeProvider>
      </PushProvider>
    </SessionProvider>
  );
}

/** 한 번 열린 뒤로 마운트된 채 남는 자리들. 탭 셋과, 탭이던 두 층. */
type Place = Tab | 'agentList' | 'workList';

function Shell(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [nav, dispatch] = useReducer(navReducer, INITIAL_NAV);
  const [composeOpen, setComposeOpen] = useState(false);
  const mentionCount = useMentionCount();
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
  const visited = useRef<Set<Place>>(new Set<Place>([INITIAL_NAV.tab]));
  visited.current.add(nav.tab);
  if (nav.agentList) visited.current.add('agentList');
  if (nav.workList) visited.current.add('workList');
  const workConsole = workConsoleAvailable();

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
          <View style={nav.tab === 'home' ? styles.visible : styles.hidden}>
            <SidebarScreen
              openChannelId={nav.conversation?.channelId ?? null}
              onOpenConversation={onOpenConversation}
              onOpenSearch={onOpenSearch}
              notificationNotice={tapRouting.notice}
              onDismissNotificationNotice={tapRouting.dismissNotice}
            />
          </View>
          <View style={nav.tab === 'inbox' ? styles.visible : styles.hidden}>
            {/* 숨김은 언마운트가 아니다 (goal RN-B4d / #1020). 탭을 여는 것이 마운트가
                아니므로 react-query 에는 재조회를 걸 계기가 없고, 그래서 승인이
                도착해도 인박스는 「지금 결정할 일이 없습니다」를 유지했다. 보이게 된
                그 순간을 화면에 말해 준다. */}
            <InboxScreen
              active={nav.tab === 'inbox'}
              onOpenConversation={onOpenConversation}
            />
          </View>
          {visited.current.has('search') ? (
            <View style={nav.tab === 'search' ? styles.visible : styles.hidden}>
              {/* 씨앗이 바뀌면 새로 세운다: 검색 화면은 자기 입력을 들고 있어서,
                  사이드바가 넘긴 새 검색어는 새 화면으로만 들어간다. */}
              <SearchScreen
                key={nav.searchSeed?.seq ?? 0}
                initialQuery={nav.searchSeed?.initialQuery ?? ''}
                onOpenResult={onOpenConversation}
              />
            </View>
          ) : null}
        </View>
      </TabBarClearanceProvider>

      <ScrollFade />
      <FloatingTabBar
        current={nav.tab}
        inboxCount={mentionCount}
        onSelect={tab => dispatch({type: 'selectTab', tab})}
      />
      <InkFab onPress={() => setComposeOpen(true)} />

      {/* 탭이던 두 층 (ADR-0189 D1). FAB 시트가 열고, 한 번 열린 뒤로는 닫혀도
          마운트된 채 남는다 — 탭일 때와 같은 이유(스크롤 자리)로. */}
      {visited.current.has('workList') && workConsole ? (
        <EdgeSwipeBack
          accessibilityViewIsModal={nav.workList && nav.workSession === null}
          style={[styles.overlay, !nav.workList && styles.hidden]}
          onBack={onBack}
          testID="work-list-pane">
          <WorkConsoleScreen
            active={nav.workList && nav.workSession === null}
            onOpenSession={onOpenWorkSession}
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
          />
        </EdgeSwipeBack>
      ) : null}

      {composeOpen ? (
        <NewMessageSheet
          workConsole={workConsole}
          onOpenAgentList={() => dispatch({type: 'openAgentList'})}
          onOpenWorkList={() => dispatch({type: 'openWorkList'})}
          onOpenConversation={onOpenConversation}
          onClose={() => setComposeOpen(false)}
        />
      ) : null}
    </Canvas>
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
