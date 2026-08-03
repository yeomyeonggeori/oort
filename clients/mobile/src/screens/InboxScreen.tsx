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
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
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
import {ApprovalDecision} from '../features/inbox/ApprovalDecision';
import {
  useAgentFeed,
  useInvalidateApprovals,
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
// lands. Whether it lands TODAY is not this file's opinion:
// `@momo/core/features/capabilities/serverSurfaces` is the one place that judges
// which surfaces this server carries, and everything below is gated on
// `isSurfaceProvided('approvals')`.
//
// While that judgement is false, `availableInboxFilters` removes two of the
// three tabs and what remains is 멘션. Two consequences are stated on the screen
// rather than hidden:
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
// ## 결정은 여기서 한다 (goal M-AP1)
//
// 이 화면은 승인을 **목록으로 보여주기만 하고 결정은 못 하는** 상태로 출하됐다.
// 이유는 취향이 아니라 검증 불가였다: 결정 엔드포인트가 이 서버에 없어서 되돌릴
// 수 없는 컨트롤을 한 번도 눌러보지 못한 채 내보내야 했다. 서버가 그 경로를
// 실었으므로(#979) 그 보류를 푼다.
//
// 결정에 필요한 사실 — 누가, 무엇을, 언제까지, 되돌릴 수 있는지 — 은 이미 이 행에
// 전부 있다. 그래서 결정도 여기서 한다. 컨트롤은 `ApprovalDecision`이고, 그것은
// 잠금화면 알림이 이미 쓰는 core의 `decideApproval`을 그대로 부른다 — 두 번째
// 구현이 아니라 두 번째 호출자다(`src/push/notifications.ts:133`).
//
// 세 갈래로만 붙는다:
//
//   * `결정 대기` 탭의 **대기 중** 승인 행 → 컨트롤. `approvalId`는 core가 대기
//     행에만 싣는다(`features/inbox/model.ts:152`), 그래서 이미 끝난 결정에는
//     컨트롤이 붙을 자리 자체가 없다.
//   * 같은 행이 `에이전트` 탭에 있을 때 → 컨트롤 없이 어디서 결정하는지 한 줄.
//     그 탭은 "내 에이전트가 무엇을 했는가"의 기록이지 결정하는 자리가 아니다.
//   * 서버가 승인을 아직 안 실었을 때 → 예전 그대로, 데스크톱에서 하라고 말한다.
//
// 오프라인이면 버튼을 그대로 두지 않는다. 15초 뒤 실패로 반박당할 컨트롤이고,
// 말없이 치우면 무엇이 사라졌는지 알 수 없다 — 자리는 지키고 이유를 말한다.
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

  // 결정이 기록되면 그 행은 대기 목록에서 사라진다. 사라지는 것만으로는 무엇이
  // 됐는지 알 수 없으므로, 원장이 답한 그대로 한 줄을 남기고 목록을 다시 읽는다.
  const invalidateApprovals = useInvalidateApprovals();
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  const onDecided = useCallback(
    (outcome: DecisionOutcome) => {
      if (outcome.kind === 'superseded') {
        setDecisionNote(outcome.note ?? '이 요청은 이미 결정되어 있었습니다.');
      } else if (outcome.status === 'approved') {
        setDecisionNote('승인했습니다. 에이전트가 이어서 실행합니다.');
      } else if (outcome.status === 'rejected') {
        setDecisionNote('거부했습니다. 이 실행은 취소되었습니다.');
      } else {
        // 200을 받았지만 원장이 알아볼 수 없는 상태를 답했다. 무엇으로 기록됐는지
        // 우리가 모르므로, 안다고 말하지 않는다.
        setDecisionNote('결정을 보냈습니다. 기록된 상태는 목록에서 확인하세요.');
      }
      invalidateApprovals();
    },
    [invalidateApprovals],
  );

  // 한 행에 결정 컨트롤을 붙일지, 대신 무슨 말을 할지. 판정이 행 안이 아니라
  // 여기 있는 이유: 어느 탭인지·서버가 승인을 싣는지·지금 연결돼 있는지는 전부
  // 화면이 아는 사실이고, 행은 자기 항목만 안다.
  const renderDecision = useCallback(
    (item: FeedItem): React.ReactNode => {
      if (item.kind !== 'approval' || !item.pending) return null;
      // 서버가 승인 결정을 아직 기록하지 않는다면 예전 문장 그대로. 없는 경로에
      // 컨트롤을 세우는 것이 이 화면이 원래 거절했던 바로 그 일이다.
      if (!approvalsProvided) {
        return (
          <Text style={styles.managed} testID={`decision-elsewhere-${item.key}`}>
            결정은 데스크톱 앱에서 할 수 있습니다.
          </Text>
        );
      }
      // `approvalId`는 core가 대기 행에만 싣는다. 없으면 결정할 대상이 없다는
      // 뜻이므로 컨트롤도 없다.
      if (item.approvalId === undefined) return null;
      if (filter !== 'needs-action') {
        return (
          <Text style={styles.managed} testID={`decision-elsewhere-${item.key}`}>
            결정 대기 탭에서 승인하거나 거부할 수 있습니다.
          </Text>
        );
      }
      if (!online) {
        return (
          <Text style={styles.managed} testID={`decision-offline-${item.key}`}>
            연결이 끊겨 지금은 결정할 수 없습니다. 다시 연결되면 여기서 승인하거나
            거부할 수 있습니다.
          </Text>
        );
      }
      return (
        <ApprovalDecision
          approvalId={item.approvalId}
          reversible={item.reversible}
          onSettled={onDecided}
          testIDPrefix={`inbox-approval-${item.approvalId}`}
        />
      );
    },
    [approvalsProvided, filter, onDecided, online],
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

      {decisionNote !== null ? (
        <NoticeBlock
          headline={decisionNote}
          onDismiss={() => setDecisionNote(null)}
          testID="inbox-decision-note"
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
              decision={renderDecision(item)}
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
  decision,
}: {
  item: FeedItem;
  busy: boolean;
  onPress: () => void;
  onMarkRead?: () => void;
  /**
   * 결정 컨트롤(또는 그 자리에 놓일 한 문장). 행이 짓지 않고 받아 온다 — 무엇을
   * 붙일지는 탭·서버 제공 여부·연결 상태가 정하고, 그 셋 다 행이 모르는 것이다.
   *
   * 행 본문 **바깥**에 놓인다. Pressable 안의 Pressable은 iOS에서 바깥쪽이 탭을
   * 삼키기도 하고, 무엇보다 이 컨트롤을 누르는 것은 대화를 여는 것과 다른 일이다.
   */
  decision?: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.rowShell} testID={`feed-row-${item.key}`}>
      <View style={styles.row}>
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

      {decision ? <View style={styles.decision}>{decision}</View> : null}
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
  rowShell: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  row: {flexDirection: 'row', alignItems: 'flex-start'},
  decision: {paddingHorizontal: SAFE_GUTTER},
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
