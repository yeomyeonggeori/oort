import type {Member} from '@momo/core/lib/api';
import React, {useCallback, useReducer, useRef} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {CountBadge} from '../design/atoms';
import {color, font, SAFE_GUTTER, space, TOUCH_TARGET} from '../design/tokens';
import {useMentionCount} from '../features/inbox/useInbox';
import {EdgeSwipeBack} from '../nav/EdgeSwipeBack';
import {
  INITIAL_NAV,
  navReducer,
  tabLabel,
  TABS,
  type OpenAgent,
  type Tab,
} from '../nav/state';
import PushProvider from '../push/PushProvider';
import {RealtimeProvider} from '../realtime/RealtimeProvider';
import AgentDetailScreen from '../screens/AgentDetailScreen';
import AgentsScreen from '../screens/AgentsScreen';
import ConversationScreen from '../screens/ConversationScreen';
import InboxScreen from '../screens/InboxScreen';
import SearchScreen from '../screens/SearchScreen';
import SidebarScreen from '../screens/SidebarScreen';
import {SessionProvider} from '../session/useSession';

// =============================================================================
// The signed-in tree: three tabs, and the surfaces that cover them.
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
// has no position to lose. 「에이전트」 is the first tab whose mount costs real
// requests — the session ledger, the host registry and one profile read per
// agent — and firing those on launch would spend a phone's radio on a screen
// the person may never open. So the set of tabs that have been visited is
// tracked and a tab is rendered from its first visit onward: mounting is
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

function Shell(): React.JSX.Element {
  const [nav, dispatch] = useReducer(navReducer, INITIAL_NAV);

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

  // Which tabs have ever been the current one. A ref rather than state: it is
  // derived from `nav.tab` and is only ever read during the render that already
  // follows a tab change, so putting it in state would be a second render for a
  // value the first one could already see.
  const visited = useRef<Set<Tab>>(new Set([INITIAL_NAV.tab]));
  visited.current.add(nav.tab);

  return (
    <View style={styles.root}>
      <View style={styles.tabBody}>
        <View style={nav.tab === 'channels' ? styles.visible : styles.hidden}>
          <SidebarScreen
            openChannelId={nav.conversation?.channelId ?? null}
            onOpenConversation={onOpenConversation}
            onOpenSearch={onOpenSearch}
          />
        </View>
        <View style={nav.tab === 'inbox' ? styles.visible : styles.hidden}>
          <InboxScreen onOpenConversation={onOpenConversation} />
        </View>
        {visited.current.has('agents') ? (
          <View style={nav.tab === 'agents' ? styles.visible : styles.hidden}>
            <AgentsScreen onOpenAgent={onOpenAgent} />
          </View>
        ) : null}
      </View>

      <TabBar current={nav.tab} onSelect={tab => dispatch({type: 'selectTab', tab})} />

      {/* Search and one agent sit UNDER the conversation they open, and stay
          mounted behind it: coming back from a result must land on the results
          with the typed query still there, and coming back from an agent's DM
          must land on that agent rather than two steps out. */}
      {nav.search ? (
        <EdgeSwipeBack style={styles.overlay} onBack={onBack}>
          <SearchScreen
            initialQuery={nav.search.initialQuery}
            onOpenResult={onOpenConversation}
            onBack={onBack}
          />
        </EdgeSwipeBack>
      ) : null}

      {nav.agent ? (
        <EdgeSwipeBack style={styles.overlay} onBack={onBack}>
          <AgentDetailScreen
            agent={nav.agent}
            onBack={onBack}
            onOpenConversation={onOpenConversation}
          />
        </EdgeSwipeBack>
      ) : null}

      {/* ## 좌측 엣지에서 밀면 닫힌다 (goal RN-U2)
          성재: "화면 좌측을 슥 넘기면 뒤로가게 해주면 안돼?"

          래퍼가 여기 있는 것은 **움직여야 하는 것이 오버레이 자신**이기 때문이다.
          이 뷰가 셸을 덮는 불투명한 판이므로, 이것이 오른쪽으로 밀려나야 밑에
          있던 탭 화면이 드러난다. 안쪽(예: `Screen`)을 움직이면 이 판의 배경색이
          제자리에 남아 아무것도 드러나지 않는다.

          탭 전환에는 걸지 않는다 — 탭은 push 가 아니라 나란한 두 곳이고, 그
          사이를 스와이프로 잇는 것은 이 피드백이 요청한 것이 아니다. */}
      {nav.conversation ? (
        <EdgeSwipeBack style={styles.overlay} onBack={onBack}>
          <ConversationScreen
            channelId={nav.conversation.channelId}
            title={nav.conversation.title}
            anchor={nav.conversation.anchor}
            onBack={onBack}
          />
        </EdgeSwipeBack>
      ) : null}
    </View>
  );
}

function TabBar({
  current,
  onSelect,
}: {
  current: Tab;
  onSelect: (tab: Tab) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const mentionCount = useMentionCount();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.tabBar, {paddingBottom: Math.max(insets.bottom, space.sm)}]}>
      {TABS.map(tab => {
        const selected = tab === current;
        const badge = tab === 'inbox' ? mentionCount : 0;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{selected}}
            accessibilityLabel={
              badge > 0 ? `${tabLabel(tab)}, 멘션 ${badge}개` : tabLabel(tab)
            }
            onPress={() => onSelect(tab)}
            style={({pressed}) => [styles.tab, pressed && styles.pressed]}
            testID={`tab-${tab}`}>
            <View style={styles.tabInner}>
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
                {tabLabel(tab)}
              </Text>
              <CountBadge count={badge} tone="mention" label={`멘션 ${badge}개`} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: color.bg},
  tabBody: {flex: 1},
  // `display: none` rather than unmounting: see the header note on scroll
  // position. The hidden subtree keeps its state and does no layout work.
  visible: {flex: 1},
  hidden: {display: 'none'},
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.bg,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
  },
  tab: {flex: 1, minHeight: TOUCH_TARGET, justifyContent: 'center'},
  tabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  tabLabel: {fontSize: font.label, color: color.textMuted},
  tabLabelActive: {color: color.text, fontWeight: '700'},
  pressed: {opacity: 0.6},
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bg,
  },
});
