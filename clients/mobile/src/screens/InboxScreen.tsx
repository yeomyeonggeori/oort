import {
  isSurfaceProvided,
  serverSurface,
  type SurfaceId,
} from '@momo/core/features/capabilities/serverSurfaces';
import {
  agentsFeedPartial,
  availableInboxFilters,
  filterLabel,
  parseFilter,
  relativeLabel,
  type FeedItem,
  type InboxFilter,
} from '@momo/core/features/inbox/model';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
} from '../design/atoms';
import {useRefreshControl} from '../design/refresh';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../design/tokens';
import {
  ApprovalDecision,
  decisionReceiptCopy,
} from '../features/inbox/ApprovalDecision';
import {APPROVAL_OFFLINE_COPY, useOnline} from '../features/inbox/useOnline';
import {
  useAgentFeed,
  useInvalidateApprovals,
  useInvalidateInboxLedgers,
  useMarkRead,
  useMentions,
  useNeedsAction,
  type Feed,
} from '../features/inbox/useInbox';
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

/**
 * 각 탭이 서 있는 표면. 미제공을 말하려면 **무엇이** 미제공인지 이름을 댈 수 있어야
 * 한다 (3R N-A, 웹 `InboxRoute`의 같은 표와 같은 값).
 *
 * 멘션이 `null`인 것은 빠뜨린 것이 아니다: 그 탭은 read-state 투영과 메시지 읽기
 * 위에 서 있고 둘 다 어느 서버에나 있다. 이름 댈 표면이 없는 탭은 미제공이 될 수
 * 없으므로 접을 곳도 없다.
 */
const PANEL_SURFACE: Record<InboxFilter, SurfaceId | null> = {
  'needs-action': 'approvals',
  mentions: null,
  agents: 'agentRunHistory',
};

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
  active = true,
  onOpenConversation,
}: {
  /**
   * 지금 이 탭이 보이는가 (goal RN-B4d / #1020).
   *
   * 이 화면은 언마운트되지 않는다 — `AppShell` 이 탭을 `display:'none'` 으로 숨기고
   * 마운트는 유지한다(그래야 탭 전환이 즉시다). 그 대가로 **탭을 여는 것이 마운트가
   * 아니고**, react-query 가 재조회를 걸 계기가 사라진다. 그래서 「보이게 되었다」를
   * prop 으로 받아 그 순간에 원장을 다시 읽는다.
   *
   * 리얼타임 무효화(`AgentWorkingRail`)가 이미 대부분을 덮지만 이것이 남아야 하는
   * 이유가 있다: 백그라운드 정책이 소켓을 세워 둔 동안 도착한 것, 그리고 이 화면이
   * 처음 마운트되기 전에 일어난 것. 그 둘은 레일이 볼 수 없고, 사람이 탭을 여는 그
   * 순간이 「지금 결정할 일이 없습니다」가 참인지 물어보기 가장 좋은 때다.
   *
   * 기본값 `true`: 이 화면을 단독으로 마운트하는 테스트·표면에서 「보이지 않는다」가
   * 조용한 기본값이 되면, 재조회가 사라진 것을 아무도 알아채지 못한다.
   */
  active?: boolean;
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
  // 반쪽 원장 고지 (3R N-B). 판정은 core의 한 벌이고 웹이 같은 것을 쓴다.
  const runHistoryMissing = agentsFeedPartial(surface =>
    isSurfaceProvided(surface),
  );
  const runHistory = serverSurface('agentRunHistory');

  // 배선은 `useOnline` 이 든다 — 승인 컨트롤이 서는 화면이 둘이 됐고, 같은
  // 컨트롤이 화면마다 다른 오프라인 결을 가지면 그것은 어휘 분열이다.
  const online = useOnline();

  // All three are mounted; `enabled` decides which ones actually fetch. Same
  // shape as the web route, so a tab switch is instant on a warm cache instead
  // of remounting a hook tree.
  const needsAction = useNeedsAction(approvalsProvided && filter === 'needs-action');
  const mentions = useMentions(filter === 'mentions');
  const agentFeed = useAgentFeed(filter === 'agents', member.id);

  const feed: Feed =
    filter === 'needs-action' ? needsAction : filter === 'agents' ? agentFeed : mentions;
  const panelSurface = PANEL_SURFACE[filter];

  // 당겨서 새로고침 (goal RN-B4b / #1026). 각 탭은 이미 자기를 다시 읽는 법을
  // 알고 있으므로(`feed.refetch` = 무효화), 당김은 그것을 부르는 새 입구일 뿐이다 —
  // 탭을 바꾸면 대상도 함께 바뀐다.
  const refreshControl = useRefreshControl(feed.refetch, 'inbox-refresh');

  // 탭이 열리는 순간 원장을 다시 읽는다 (#1020). `active` 가 거짓→참으로 바뀔 때만
  // 돈다: 참인 채로 다시 그려지는 것(필터 전환, 결정 한 번)은 여는 것이 아니다.
  //
  // 두 경우에는 묻지 않는다. 둘 다 「다시 묻는 것이 답을 바꾸지 못한다」이다:
  //
  //   * **이미 묻고 있는 중**(`isLoading`) — 첫 조회가 날아가고 있다면 낡은 것은
  //     아무것도 없다. 여기서 무효화하면 같은 답을 두 번 받으러 가는 왕복이 하나
  //     늘 뿐이고, 폰에서 그 왕복은 라디오를 켠다.
  //   * **서버가 그 경로를 모른다고 답했다**(`absent`) — 404/405/501 은 두 번 물어도
  //     같은 답이 온다. `retryUnlessAbsent` 가 그래서 재시도를 끄는 것이고, 탭을
  //     열 때마다 그 판정을 뒤집으면 그 결정이 무의미해진다.
  const invalidateLedgers = useInvalidateInboxLedgers();
  const feedStateRef = useRef({isLoading: feed.isLoading, absent: feed.absent});
  feedStateRef.current = {isLoading: feed.isLoading, absent: feed.absent};
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (!active) {
      wasActiveRef.current = false;
      return;
    }
    if (wasActiveRef.current) return;
    wasActiveRef.current = true;
    if (feedStateRef.current.isLoading || feedStateRef.current.absent) return;
    invalidateLedgers();
  }, [active, invalidateLedgers]);

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
  //
  // ## 영수증은 결정한 그 행 자리에 (2R H3/M6)
  //
  // 1R은 화면 맨 위 한 칸에 적었다. 두 가지가 틀렸다: 목록을 내려 결정한 사람의
  // 눈은 그 행에 있는데 답은 화면 위쪽에 뜨고, 두 번째 결정이 첫 번째 영수증을
  // 덮어써서 무엇이 어떻게 됐는지 하나가 사라졌다. 그래서 영수증은 **승인 id로
  // 키를 잡아** 그 행 자리에 그린다. 그 행이 원장 재조회로 목록에서 빠지면
  // 영수증만 남으므로, 갈 곳 없는 영수증은 위쪽 알림으로 올려 보낸다 — 사라지는
  // 것과 답을 못 본 것은 다르다.
  const invalidateApprovals = useInvalidateApprovals();
  const [receipts, setReceipts] = useState<{id: string; note: string}[]>([]);
  const onDecided = useCallback(
    (approvalId: string, outcome: DecisionOutcome) => {
      const note = decisionReceiptCopy(outcome);
      setReceipts(previous => [
        ...previous.filter(entry => entry.id !== approvalId),
        {id: approvalId, note},
      ]);
      // 결과도 말해 준다 (2R H3). 무장은 알리고 결과는 알리지 않으면, 화면을 보지
      // 않는 사람에게는 되돌릴 수 없는 행동이 소리 없이 끝난 것이 된다.
      AccessibilityInfo.announceForAccessibility(note);
      invalidateApprovals();
    },
    [invalidateApprovals],
  );
  const dismissReceipt = useCallback((approvalId: string) => {
    setReceipts(previous => previous.filter(entry => entry.id !== approvalId));
  }, []);

  // 목록에 아직 남아 있는 행의 영수증은 그 행이 그린다. 여기 남는 것은 행이
  // 사라진 뒤의 영수증뿐이다.
  const visibleApprovalIds = useMemo(
    () => new Set(feed.items.map(item => item.approvalId).filter(Boolean)),
    [feed.items],
  );
  const orphanReceipts = receipts.filter(
    entry => !visibleApprovalIds.has(entry.id),
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
      // 이 행에서 방금 결정했다면 컨트롤 자리에 그 답을 둔다. 같은 행에 컨트롤과
      // 영수증이 함께 있으면 이미 끝난 결정을 다시 누를 수 있다는 뜻이 된다.
      const receipt = receipts.find(entry => entry.id === item.approvalId);
      if (receipt) {
        return (
          <Text style={styles.receipt} testID={`decision-receipt-${item.key}`}>
            {receipt.note}
          </Text>
        );
      }
      if (!online) {
        return (
          <Text style={styles.managed} testID={`decision-offline-${item.key}`}>
            {APPROVAL_OFFLINE_COPY}
          </Text>
        );
      }
      return (
        <ApprovalDecision
          approvalId={item.approvalId}
          reversible={item.reversible}
          execution={item.execution ?? null}
          deadlinePassed={item.deadlinePassed}
          onSettled={outcome => onDecided(item.approvalId as string, outcome)}
          testIDPrefix={`inbox-approval-${item.approvalId}`}
        />
      );
    },
    [approvalsProvided, filter, onDecided, online, receipts],
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

      {orphanReceipts.map(entry => (
        <NoticeBlock
          key={entry.id}
          headline={entry.note}
          onDismiss={() => dismissReceipt(entry.id)}
          testID="inbox-decision-note"
        />
      ))}

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

      {/* 반쪽인 채로 조용한 것과 조용한 것은 다르다 (3R N-B). 목록은 그대로 둔다 —
          있는 절반을 감추는 것은 반대 방향의 같은 거짓말이다. */}
      {filter === 'agents' && runHistoryMissing ? (
        <NoticeBlock
          headline={runHistory.absentReason}
          detail="아래 목록은 승인 기록만 담고 있습니다."
          testID="inbox-agents-partial"
        />
      ) : null}

      {feed.isLoading && feed.items.length === 0 ? (
        <LoadingState label="인박스를 불러오는 중입니다." testID="inbox-loading" />
      ) : panelSurface !== null && feed.absent && feed.items.length === 0 ? (
        // 서버가 "그런 경로 없다"고 **직접 답한** 경우다 (3R N-A). 오류가 아니므로
        // 붉게 그리지 않고, 다시 시도할 것이 없으므로 재시도를 주지 않는다 —
        // 그 버튼은 영영 같은 답을 받는다.
        <NoticeBlock
          headline={serverSurface(panelSurface).absentReason}
          detail={serverSurface(panelSurface).fallback}
          testID="inbox-unavailable"
        />
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
          refreshControl={refreshControl}
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
          refreshControl={refreshControl}
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
  receipt: {fontSize: font.meta, color: color.text, paddingBottom: space.md},
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
