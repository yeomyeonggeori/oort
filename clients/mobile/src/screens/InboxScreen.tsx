import {
  isSurfaceProvided,
  serverSurface,
} from '@momo/core/features/capabilities/serverSurfaces';
import {
  availableInboxFilters,
  filterLabel,
  parseFilter,
  relativeLabel,
  type FeedItem,
  type InboxFilter,
} from '@momo/core/features/inbox/model';
import NetInfo from '@react-native-community/netinfo';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
} from '../design/atoms';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../design/tokens';
import {
  useAgentFeed,
  useMarkRead,
  useMentions,
  useNeedsAction,
  type Feed,
} from '../features/inbox/useInbox';
import {isOnlineFromNetInfo} from '../query/queryClient';
import {useSession} from '../session/useSession';

// =============================================================================
// 인박스 — "무엇이 나를 기다리는가".
//
// ## The honest shape of this screen on THIS server
//
// ADR-0137 D5 names 승인 as one of v0's two axes, and this screen is where it
// lands. It does not land today, and pretending otherwise was not an option:
// `@momo/core/features/capabilities/serverSurfaces` records, from a route-by-route
// measurement on 2026-08-02, that the Rust server carries neither
// `GET …/approvals` nor `POST …/approvals/{id}/decision` (404) nor
// `GET …/channels/{ch}/agent-runs` (405 — the path is registered POST-only).
//
// So `availableInboxFilters` removes those two tabs, exactly as it does on web,
// and what remains is 멘션. Two consequences are stated on the screen rather than
// hidden:
//
//   * with one filter left there is no tab bar. One tab is not a choice, and
//     drawing it would suggest the other two are somewhere nearby.
//   * a short notice says, in the words `serverSurface('approvals')` already
//     carries, that this server does not record approval decisions yet, and what
//     to do instead. An empty "결정 대기" list would have read as "결정할 것이
//     없다" — a claim we cannot make.
//
// The code for all three feeds is present and gated. When those routes land, the
// change is one `provided: false` in the core's table and this screen grows its
// tabs back with no edit here. That is what that table is for.
//
// ## What this screen does not do yet
//
// It lists approvals; it does not decide them. `decideApproval` exists in the
// core, but the endpoint it posts to does not exist on this server, so the
// control could not be exercised even once before shipping — and an approval is
// the one action in this product that can be irreversible (`FeedItem.note`
// carries 되돌릴 수 없음 for exactly that reason). An untestable irreversible
// control is the wrong thing to ship; the row says where the decision can be made
// instead. This is called out in the PR as the next batch's first item.
// =============================================================================

const EMPTY_COPY: Record<InboxFilter, {headline: string; detail: string}> = {
  'needs-action': {
    headline: '지금 결정할 일이 없습니다. 조용한 게 정상입니다.',
    detail: '에이전트가 사람의 허가를 기다릴 때만 여기 쌓입니다.',
  },
  mentions: {
    headline: '읽지 않은 멘션이 없습니다. 조용한 게 정상입니다.',
    detail: '누군가 회원님을 부르면 중요한 것만 여기 모입니다.',
  },
  agents: {
    headline: '에이전트가 남긴 결과가 없습니다. 조용한 게 정상입니다.',
    detail: '회원님이 담당하는 에이전트가 무언가를 끝내면 여기 남습니다.',
  },
};

export default function InboxScreen({
  onOpenConversation,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
}): React.JSX.Element {
  const {member} = useSession();

  const availableFilters = useMemo(
    () => availableInboxFilters(surface => isSurfaceProvided(surface)),
    [],
  );
  const [filter, setFilter] = useState<InboxFilter>(() =>
    parseFilter(null, availableFilters),
  );
  const approvals = serverSurface('approvals');
  const approvalsProvided = isSurfaceProvided('approvals');

  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setOnline(isOnlineFromNetInfo(state));
    });
    return unsubscribe;
  }, []);

  // All three are mounted; `enabled` decides which ones actually fetch. Same
  // shape as the web route, so a tab switch is instant on a warm cache instead
  // of remounting a hook tree.
  const needsAction = useNeedsAction(approvalsProvided && filter === 'needs-action');
  const mentions = useMentions(filter === 'mentions');
  const agentFeed = useAgentFeed(filter === 'agents', member.id);

  const feed: Feed =
    filter === 'needs-action' ? needsAction : filter === 'agents' ? agentFeed : mentions;

  const markRead = useMarkRead();
  const marking = useMutation({
    mutationFn: ({channelId, seq}: {channelId: string; seq: number}) =>
      markRead(channelId, seq),
  });

  const onRowPress = useCallback(
    (item: FeedItem) => {
      onOpenConversation(item.channelId, item.channelLabel);
    },
    [onOpenConversation],
  );

  return (
    <Screen>
      <ScreenHeader title="인박스" />

      {availableFilters.length > 1 ? (
        <View
          accessibilityRole="tablist"
          accessibilityLabel="인박스 필터"
          style={styles.tabs}>
          {availableFilters.map(value => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{selected: value === filter}}
              onPress={() => setFilter(value)}
              style={({pressed}) => [
                styles.tab,
                value === filter && styles.tabActive,
                pressed && styles.pressed,
              ]}
              testID={`inbox-tab-${value}`}>
              <Text
                style={[styles.tabLabel, value === filter && styles.tabLabelActive]}>
                {filterLabel(value)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {!approvalsProvided ? (
        <NoticeBlock
          headline={approvals.absentReason}
          detail={approvals.fallback}
          testID="approvals-absent"
        />
      ) : null}

      {!online ? (
        <NoticeBlock
          headline={
            feed.updatedAtMs > 0
              ? `오프라인, 마지막 동기화 ${relativeLabel(feed.updatedAtMs, Date.now())}. 아래는 그때의 상태입니다.`
              : '오프라인. 아직 이 목록을 한 번도 받지 못했습니다.'
          }
          testID="inbox-offline"
        />
      ) : null}

      {feed.isLoading && feed.items.length === 0 ? (
        <LoadingState label="인박스를 불러오는 중입니다." testID="inbox-loading" />
      ) : feed.error && feed.items.length === 0 ? (
        <ErrorState
          headline="인박스를 불러오지 못했습니다."
          onRetry={feed.refetch}
          testID="inbox-error"
        />
      ) : feed.items.length === 0 ? (
        <EmptyState
          headline={EMPTY_COPY[filter].headline}
          detail={EMPTY_COPY[filter].detail}
          testID="inbox-empty"
        />
      ) : (
        <FlatList
          data={feed.items}
          keyExtractor={item => item.key}
          renderItem={({item}) => (
            <FeedRow
              item={item}
              busy={
                marking.isPending &&
                marking.variables?.channelId === item.channelId &&
                marking.variables?.seq === item.seq
              }
              onPress={() => onRowPress(item)}
              onMarkRead={
                item.kind === 'mention' && item.seq !== undefined
                  ? () =>
                      marking.mutate({channelId: item.channelId, seq: item.seq as number})
                  : undefined
              }
            />
          )}
          contentContainerStyle={styles.listContent}
          testID="inbox-list"
        />
      )}
    </Screen>
  );
}

/**
 * One row = one sentence, and the core wrote all of it.
 *
 * `actor` is a separate field from `predicate` on purpose (see `FeedItem`): the
 * agent identity colour applies to the actor token alone, and a Korean subject
 * particle after an arbitrary handle would have to be guessed. So the two are
 * rendered as two `Text` runs in one line rather than concatenated.
 */
function FeedRow({
  item,
  busy,
  onPress,
  onMarkRead,
}: {
  item: FeedItem;
  busy: boolean;
  onPress: () => void;
  onMarkRead?: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.row} testID={`feed-row-${item.key}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.actor} ${item.predicate}. ${item.channelLabel}. ${item.reason}`}
        onPress={onPress}
        style={({pressed}) => [styles.rowBody, pressed && styles.pressed]}>
        <View style={styles.rowHead}>
          <Text style={styles.sentence} numberOfLines={2}>
            <Text style={item.actorIsAgent ? styles.actorAgent : styles.actor}>
              {item.actor}
            </Text>
            <Text style={styles.predicate}> {item.predicate}</Text>
          </Text>
          {item.timeLabel !== '' ? (
            <Text style={styles.time}>{item.timeLabel}</Text>
          ) : null}
        </View>

        {item.detail ? (
          <Text style={styles.detail} numberOfLines={3} ellipsizeMode="tail">
            {item.detail}
          </Text>
        ) : null}

        <View style={styles.metaLine}>
          <Text style={styles.channel} numberOfLines={1}>
            {item.channelLabel}
          </Text>
          {item.outcome ? (
            <Text style={[styles.outcome, outcomeStyle(item.outcomeTone)]}>
              → {item.outcome}
            </Text>
          ) : null}
          {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
        </View>

        {item.managedBy ? (
          <Text style={styles.managed}>{item.managedBy} 님이 관리</Text>
        ) : null}

        {item.kind === 'approval' && item.pending ? (
          // Stated, not offered: the decision endpoint is not on this server, so
          // there is no control here to press. See the header note.
          <Text style={styles.managed}>결정은 데스크톱 앱에서 할 수 있습니다.</Text>
        ) : null}
      </Pressable>

      {onMarkRead ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.channelLabel}의 멘션을 읽음으로 표시`}
          disabled={busy}
          onPress={onMarkRead}
          style={({pressed}) => [styles.markRead, pressed && styles.pressed]}
          testID={`mark-read-${item.key}`}>
          <Text style={styles.markReadLabel}>{busy ? '…' : '읽음'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function outcomeStyle(tone: FeedItem['outcomeTone']) {
  if (tone === 'ok') return styles.outcomeOk;
  if (tone === 'danger') return styles.outcomeDanger;
  if (tone === 'warn') return styles.outcomeWarn;
  return styles.outcomeMuted;
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
  tab: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  tabActive: {backgroundColor: color.surface, borderColor: color.accent},
  tabLabel: {fontSize: font.label, color: color.textMuted},
  tabLabelActive: {color: color.text, fontWeight: '600'},
  listContent: {paddingBottom: space.lg},
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowBody: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.md,
    gap: space.xs,
  },
  rowHead: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
  sentence: {flex: 1, fontSize: font.label, lineHeight: 20},
  actor: {color: color.text, fontWeight: '600'},
  actorAgent: {color: color.agent, fontWeight: '600'},
  predicate: {color: color.text},
  time: {fontSize: font.meta, color: color.textFaint},
  detail: {
    fontSize: font.meta,
    color: color.textMuted,
    lineHeight: 18,
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: color.border,
  },
  metaLine: {flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap'},
  channel: {fontSize: font.meta, color: color.textFaint, flexShrink: 1},
  outcome: {fontSize: font.meta, fontWeight: '600'},
  outcomeOk: {color: color.ok},
  outcomeDanger: {color: color.danger},
  outcomeWarn: {color: color.warn},
  outcomeMuted: {color: color.textFaint},
  note: {fontSize: font.meta, color: color.warn},
  managed: {fontSize: font.meta, color: color.textFaint},
  markRead: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    marginTop: space.sm,
    marginRight: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
  },
  markReadLabel: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
  pressed: {backgroundColor: color.surfacePressed},
});
