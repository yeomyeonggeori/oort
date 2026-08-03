import type {Channel, Message, RosterMember} from '@momo/core/lib/api';
import {
  buildTimelineItems,
  emptyChannelCopy,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineItem,
} from '@momo/core/features/timeline/model';
import {chipsFor, type ReactionMap} from '@momo/core/features/timeline/reactions';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo, useRef} from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {EmptyState, ErrorState, LoadingState} from '../../design/atoms';
import {color, font, SAFE_GUTTER, space} from '../../design/tokens';
import {
  DayDivider,
  MessageRow,
  PendingRow,
  RecoveryDivider,
  UnreadDivider,
} from './MessageRow';

// =============================================================================
// The message list. **Forward — newest at the bottom.**
//
// ## The list runs forward, and that is a measured decision (spike #837 gate 5)
//
// On a physical iPhone 17, a reversed list moved a scrolled-back reader's
// position by 46–91px every time a message arrived, on all three libraries
// tried (FlatList, FlashList v2, @legendapp/list). The same data drawn forward
// measured 0px. The jump was never React Native's virtualisation — it was the
// reversal, inherited from other chat clients rather than chosen here.
// Mattermost patches React Native's own Fabric scroll view to live with it;
// this product does not have to. `__tests__/projectShape.test.ts` fails the
// build if that word reappears anywhere under `src/`.
//
// Forward buys the harder half for free: new messages land at the BOTTOM, so
// content only ever grows below the reader and the anchor cannot move. It costs
// the other half, which is the whole subject of the next section.
//
// ## Prepending older messages needs an explicit correction
//
// Loading history inserts rows ABOVE the reader. Without a correction the
// viewport keeps its offset while the content underneath it slides down, and
// the line being read jumps by a page. The web client solves this with
// react-virtuoso's `firstItemIndex`, lowered by exactly the number of inserted
// items in the same commit as the longer array.
//
// `maintainVisibleContentPosition` is the same idea, and — this is why it is
// the right answer rather than merely an available one — it corrects by KEY
// IDENTITY, not by count. `VirtualizedList.getDerivedStateFromProps` remembers
// the key at `minIndexForVisible`, finds that same key's new index in the next
// data array, and shifts by the difference; the native scroll view pins the
// matching subview and moves `contentOffset` by its frame delta.
//
// That distinction is exactly the trap `Timeline.tsx` warns about on web: the
// shift **cannot** be the page size. `items` is the DERIVED stream, so a 50
// message page can insert 51 rows when a day separator moves in with it, and a
// correction computed from the page size would be off by one row every time a
// page happened to cross midnight. Nothing here counts anything — the key does
// the work, so the derived rows are free.
//
// `minIndexForVisible: 0`, and the 0 is load-bearing. It is an index into
// `data`, so 0 is the OLDEST row — the one a prepend pushes down, and therefore
// the only one whose key changing proves a prepend happened. React Native adds
// the offset for `ListHeaderComponent` itself before handing the prop to the
// native scroll view (`VirtualizedList.js`: `minIndexForVisible +
// (ListHeaderComponent ? 1 : 0)`), so passing 1 here to "skip the header"
// double-counts it and pins the SECOND row, leaving the first one uncorrected.
// `__tests__/timelineRender.test.tsx` asserts the value that reaches the
// scroll view, because that is where the off-by-one is visible.
//
// ## Why FlatList and not FlashList v2 / @legendapp/list
//
// All three render fine (the spike mounted 1,000 rows on each). FlatList wins
// on the one axis that matters here: it is the only one whose prepend
// correction is a documented contract with the native scroll view rather than a
// library's own emulation, it adds no dependency, and its behaviour is the one
// `maintainVisibleContentPosition` was built for. The spike's forward numbers
// also put Legend at 25px on prepend — the only non-zero forward reading anyone
// took — while FlatList's forward run failed to measure at all for a harness
// reason (`scrollToIndex` without `getItemLayout`), which is a gap in that
// harness and not evidence against the list. So this batch measures it
// properly instead of inheriting either result: see `measure/`.
// =============================================================================

/** How near the bottom still counts as "following", in points. */
const FOLLOW_THRESHOLD_PX = 120;

export function Timeline({
  messages,
  directory,
  status,
  channelKind,
  peer,
  lastReadSeq,
  unreadCount,
  recoveryMarkers,
  pending,
  reactions,
  myMemberId,
  loadingOlder,
  reachedStart,
  nowMs,
  onStartReached,
  onRetry,
  onResend,
  onResendPending,
  anchorSeq,
  anchorRef,
  listRef: externalListRef,
}: {
  messages: Message[];
  directory: Directory;
  status: 'loading' | 'ready' | 'error';
  channelKind?: Channel['kind'];
  peer?: RosterMember | null;
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  pending?: PendingMessage[];
  reactions?: ReactionMap;
  myMemberId: string;
  loadingOlder?: boolean;
  reachedStart?: boolean;
  nowMs: number;
  onStartReached?: () => void;
  onRetry?: () => void;
  onResend?: (message: Message) => void;
  onResendPending?: (clientMsgId: string) => void;
  /**
   * Measurement seam (`measure/ScrollMeasure.tsx`), inert in the app.
   *
   * When set, the row carrying this seq is wrapped in a non-collapsable View
   * bound to `anchorRef`, so a harness can read its absolute window position
   * with `measureInWindow` before and after an insertion. It is here rather
   * than in a copy of this component because a measurement of a replica proves
   * nothing about what ships — the spike's own gate 5 note says the same.
   */
  anchorSeq?: number;
  anchorRef?: React.MutableRefObject<View | null>;
  /** Same seam: lets the harness put the reader mid-history before measuring. */
  listRef?: React.MutableRefObject<FlatList<TimelineItem> | null>;
}): React.JSX.Element {
  const ownListRef = useRef<FlatList<TimelineItem> | null>(null);
  const listRef = externalListRef ?? ownListRef;
  /** Is the reader at the bottom? Decides whether new content is followed. */
  const followingRef = useRef(true);
  const didInitialScrollRef = useRef(false);

  const items = useMemo(
    () =>
      buildTimelineItems(messages, {
        lastReadSeq,
        unreadCount,
        recoveryMarkers,
        pending,
      }),
    [messages, lastReadSeq, unreadCount, recoveryMarkers, pending],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      const distanceFromEnd =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      followingRef.current = distanceFromEnd <= FOLLOW_THRESHOLD_PX;
    },
    [],
  );

  // Follow the tail only when the reader is already there. Anyone scrolled back
  // is READING, and yanking them to the bottom because someone else typed is
  // the same lost-place complaint the reversed list caused, arriving by a
  // different route.
  const onContentSizeChange = useCallback(() => {
    if (!didInitialScrollRef.current) {
      if (items.length === 0) return;
      didInitialScrollRef.current = true;
      listRef.current?.scrollToEnd({animated: false});
      return;
    }
    if (followingRef.current) listRef.current?.scrollToEnd({animated: true});
    // `listRef` is listed because it can be the caller's ref object rather than
    // this component's own — a prop, so the linter is right that it is not
    // guaranteed stable. Ref objects are compared by identity and the harness
    // passes one fixed object, so this costs nothing at runtime.
  }, [items.length, listRef]);

  const renderItem = useCallback(
    ({item}: {item: TimelineItem}) => {
      if (item.kind === 'day') return <DayDivider atMs={item.atMs} />;
      if (item.kind === 'unread') return <UnreadDivider count={item.count} />;
      if (item.kind === 'recovery') {
        return <RecoveryDivider seq={item.seq} source={item.source} />;
      }
      if (item.kind === 'pending') {
        return (
          <PendingRow
            pending={item.pending}
            startsGroup={item.startsGroup}
            directory={directory}
            onResend={onResendPending}
          />
        );
      }
      const row = (
        <MessageRow
          message={item.message}
          startsGroup={item.startsGroup}
          directory={directory}
          chips={chipsFor(reactions ?? {}, item.message.id, myMemberId)}
          pausedRepeat={item.pausedRepeat}
          nowMs={nowMs}
          onResend={onResend}
        />
      );
      if (anchorSeq !== undefined && item.message.seq === anchorSeq) {
        return (
          <View
            ref={node => {
              if (anchorRef) anchorRef.current = node;
            }}
            collapsable={false}>
            {row}
          </View>
        );
      }
      return row;
    },
    [
      directory,
      reactions,
      myMemberId,
      nowMs,
      onResend,
      onResendPending,
      anchorSeq,
      anchorRef,
    ],
  );

  const keyExtractor = useCallback((item: TimelineItem) => item.key, []);

  if (status === 'error') {
    return (
      <ErrorState
        headline="이 대화를 불러오지 못했습니다."
        detail="연결을 확인한 뒤 다시 시도하세요."
        onRetry={onRetry}
        testID="timeline-error"
      />
    );
  }

  // A local echo counts as content: the first message in an empty channel must
  // appear the moment it is sent, not after the round trip finishes.
  const empty = messages.length === 0 && items.length === 0;

  if (status === 'loading' && empty) {
    return <LoadingState label="대화를 불러오는 중입니다." testID="timeline-loading" />;
  }

  if (status === 'ready' && empty) {
    const copy = emptyChannelCopy(channelKind, peer ?? null);
    return (
      <EmptyState
        headline={copy.headline}
        detail={copy.detail}
        testID="timeline-empty"
      />
    );
  }

  return (
    <FlatList
      ref={listRef}
      testID="timeline-list"
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // The correction. See the header note: key-identity based, so the derived
      // stream's extra dividers cost nothing.
      maintainVisibleContentPosition={{minIndexForVisible: 0}}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={onContentSizeChange}
      onStartReached={reachedStart ? undefined : onStartReached}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={
        <View style={styles.header}>
          {loadingOlder ? (
            <ActivityIndicator color={color.accentText} />
          ) : reachedStart && items.length > 0 ? (
            <Text style={styles.headerLabel}>대화의 시작입니다.</Text>
          ) : null}
        </View>
      }
      ListFooterComponent={<View style={styles.footer} />}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      // The list is the only thing that scrolls, and only up and down: a row
      // that could drag sideways is how a horizontal scroll gets into an app
      // that has no horizontal content.
      showsHorizontalScrollIndicator={false}
      removeClippedSubviews={false}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    alignItems: 'center',
  },
  headerLabel: {fontSize: font.meta, color: color.textFaint},
  footer: {height: space.sm},
});
