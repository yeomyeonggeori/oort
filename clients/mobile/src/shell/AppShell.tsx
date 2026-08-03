import type {Member} from '@momo/core/lib/api';
import React, {useCallback, useReducer} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {CountBadge} from '../design/atoms';
import {color, font, SAFE_GUTTER, space, TOUCH_TARGET} from '../design/tokens';
import {useMentionCount} from '../features/inbox/useInbox';
import {INITIAL_NAV, navReducer, tabLabel, TABS, type Tab} from '../nav/state';
import {RealtimeProvider} from '../realtime/RealtimeProvider';
import ConversationScreen from '../screens/ConversationScreen';
import InboxScreen from '../screens/InboxScreen';
import SidebarScreen from '../screens/SidebarScreen';
import {SessionProvider} from '../session/useSession';

// =============================================================================
// The signed-in tree: two tabs, and a conversation that covers them.
//
// `SessionProvider` is mounted here rather than in `App.tsx` so that everything
// below can take a signed-in member for granted. The gate above has already
// decided; re-checking for null on four screens would be four chances to decide
// differently.
//
// Both tab screens stay MOUNTED while a conversation is open, and the
// conversation is drawn over them with `position: absolute` rather than by
// swapping the tree. That is a deliberate choice about scroll position: a
// sidebar that unmounts loses where the person had scrolled to, and coming back
// from a conversation to the top of a 40-channel list is the kind of small
// wrongness that makes an app feel borrowed. It costs one extra mounted subtree.
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
    <SessionProvider member={member}>
      <RealtimeProvider>
        <Shell />
      </RealtimeProvider>
    </SessionProvider>
  );
}

function Shell(): React.JSX.Element {
  const [nav, dispatch] = useReducer(navReducer, INITIAL_NAV);

  const onOpenConversation = useCallback((channelId: string, title: string) => {
    dispatch({type: 'openConversation', conversation: {channelId, title}});
  }, []);

  const onBack = useCallback(() => dispatch({type: 'back'}), []);

  return (
    <View style={styles.root}>
      <View style={styles.tabBody}>
        <View style={nav.tab === 'channels' ? styles.visible : styles.hidden}>
          <SidebarScreen
            openChannelId={nav.conversation?.channelId ?? null}
            onOpenConversation={onOpenConversation}
          />
        </View>
        <View style={nav.tab === 'inbox' ? styles.visible : styles.hidden}>
          <InboxScreen onOpenConversation={onOpenConversation} />
        </View>
      </View>

      <TabBar current={nav.tab} onSelect={tab => dispatch({type: 'selectTab', tab})} />

      {nav.conversation ? (
        <View style={styles.overlay}>
          <ConversationScreen
            channelId={nav.conversation.channelId}
            title={nav.conversation.title}
            onBack={onBack}
          />
        </View>
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
