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
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
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
  type MessageRowActions,
} from './MessageRow';
import {buildThreadContext, parentOf, rollupFor} from './threadContext';

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

// ## Following the tail is TWO rules, not one (성재, iPhone 17)
//
// "채팅을 입력하면 채팅창 아래로 떠서 스크롤을 해야 내가 친 채팅이 나와."
//
// The first rule was here and is right: **someone else talking must not move the
// reader.** Anyone scrolled back is READING, and yanking them to the bottom
// because a colleague typed is the same lost-place complaint the reversed list
// caused, arriving by a different route.
//
// The second rule was missing: **my own message always comes to me.** Sending is
// not something that happens to a reader, it is something they did, and the one
// thing they expect to see afterwards is the thing they just wrote. Treating the
// two the same is what produced the defect — opening the keyboard shrinks the
// list, `following` stops being true, and from then on the sender's own messages
// landed below the fold with no sign they had been sent at all.
//
// So a send scrolls unconditionally (`selfSendToken`), and it does so at the
// OPTIMISTIC insert rather than after the round trip: the echo is on screen
// immediately, and that is the moment it has to be visible.
//
// A third, quieter case belongs to the same rule: when the list itself gets
// shorter (the keyboard rising), a reader who WAS at the bottom must stay there.
// `onContentSizeChange` cannot see that — the content did not change, the
// viewport did — so the layout pass carries it.
//
// ## …and one `scrollToEnd` is not enough to honour it (goal RN-P3)
//
// 성재 kept seeing the defect from MID-history while it behaved near the tail.
// That split is the clue, and the reason is in `VirtualizedList` rather than
// here. Two facts, read out of `@react-native/virtualized-lists@0.86.2`:
//
//   `VirtualizedList.js:135` — `scrollToEnd` asks
//   `ListMetricsAggregator.getCellMetricsApprox(veryLast)` where the end IS, and
//   the row just sent has never been laid out. `ListMetricsAggregator.js:164`
//   answers such an index with `offset = highestMeasuredFrame.offset + length +
//   averageCellLength * gap` and `length = averageCellLength`. A GUESS, and the
//   further back the reader is, the wider the gap it is multiplied over.
//
//   `VirtualizedList.js:1010` — "Without getItemLayout, we limit our tail spacer
//   to the _highestMeasuredFrameIndex to prevent the user for hyperscrolling
//   into un-measured area". So the content is not merely mis-measured, it is
//   deliberately SHORTER than the data: the native scroll view clamps the jump
//   to a content end that does not include the message just sent. That is the
//   "접힌 아래" exactly — the row is below a floor the list is holding down.
//
// The list resolves this by itself given a second chance: landing there mounts
// the cells, measuring them extends the spacer, and the resulting content-size
// change is the signal to scroll again. `onContentSizeChange` above is already
// that second chance — and `onScroll` was destroying it. **Every intermediate
// position of a scroll TO the end is far FROM the end**, so the handler read
// this component's own travel as "the reader chose to read history" and cleared
// `following` before the correction could run.
//
// So a send takes the wheel for a bounded window (`SELF_SEND_PIN_MS`): while it
// holds, `onScroll` records geometry but does not revoke `following`. The reader
// takes it back the only way that means anything — `onScrollBeginDrag`, a finger
// on the glass. Neither a timer nor a finger is a guess about intent.
//
// A far send additionally corrects INSTANTLY rather than gliding, and that is
// arithmetic, not taste: each round trip through the clamp advances by about one
// viewport, so an animated round costs UIScrollView's fixed ~300ms and a hundred
// rows would take five seconds of smear. Instant rounds cost a frame each. Near
// the tail there is no clamp to climb, so the glide that shipped stays.
//
// ## What this is NOT (checked, because the ticket suspected it)
//
// The keyboard shrinking the list. It no longer can: RN-P2 moved
// `ConversationLayout` from an animated `paddingBottom` to a `translateY`, so a
// raised keyboard SLIDES this list at constant height. `__tests__/timelineFollow`
// pins that the resize path still behaves, but it is not the road to this
// defect — the defect reproduces with the keyboard down, from mid-history, and
// the reproduction is `__tests__/timelineFollow`'s 「따라가다 만다」 case.

/** How near the bottom still counts as "following", in points. */
const FOLLOW_THRESHOLD_PX = 120;

/**
 * How long a send owns the scroll position, in ms.
 *
 * Long enough for several correction rounds (each is one frame), short enough
 * that a send can never be an argument the reader is still having a second
 * later. It is an upper bound, not a duration: arriving ends it early, and so
 * does a finger.
 */
const SELF_SEND_PIN_MS = 1200;

/** Close enough to the end that another correction would move nothing. */
const ARRIVED_PX = 1;

/**
 * What the list last said about itself. Kept because the two questions a send
 * has to answer — "how far am I from the end" and "have I arrived" — are
 * answerable only from the scroll view, and asking React for them re-renders a
 * list in the middle of scrolling it.
 */
export interface TimelineGeometry {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}

/**
 * `null` when the list has not reported both halves yet, which is NOT the same
 * as zero — a zero distance reads as "already at the end" and would skip the
 * correction the caller asked for.
 */
function distanceToEnd(geometry: TimelineGeometry): number | null {
  if (geometry.contentHeight <= 0 || geometry.viewportHeight <= 0) return null;
  return geometry.contentHeight - (geometry.offsetY + geometry.viewportHeight);
}

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
  actions,
  emptyOverride,
  selfSendToken,
  markReplies = true,
  anchorSeq,
  anchorRef,
  tailRef,
  metricsRef,
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
   * What each row may do. Absent on read-only mounts — the measurement harness
   * renders this component with no session behind it, and a row that offered
   * 지우기 there would be offering a request nothing could answer.
   */
  actions?: MessageRowActions;
  /** A surface-specific empty state (a thread's is not a channel's). */
  emptyOverride?: {headline: string; detail?: string};
  /**
   * Bumped by the surface every time THIS person sends. Any change scrolls to
   * the end regardless of where they were — see the two-rule note above. It is a
   * counter rather than a boolean because two sends in a row must each scroll,
   * and it carries no other meaning.
   */
  selfSendToken?: number;
  /**
   * Whether a reply row says that it is one.
   *
   * True on a channel, where a reply otherwise looks exactly like every other
   * message and the person who wrote it cannot find it. False inside a thread,
   * where it is already true of every row on screen.
   */
  markReplies?: boolean;
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
  /**
   * The seam that had to exist before this batch could measure anything, and the
   * reason the last one reported 「미측정」 instead of a number.
   *
   * `anchorRef` above can only answer about a row the virtualiser decided to
   * mount, so the exact failure being hunted — the just-sent row is BELOW the
   * fold — is also the case in which it answers `null`. "Could not measure" and
   * "measured, and it was hidden" then arrive as the same reading, and a harness
   * that cannot tell them apart cannot fail.
   *
   * The list footer can. `VirtualizedList` renders `ListFooterComponent`
   * outside the render mask, so it is mounted at every scroll position, and its
   * window position IS the end of the content. So this always answers, and the
   * answer is a distance in points rather than a word.
   */
  tailRef?: React.MutableRefObject<View | null>;
  /**
   * Same seam, for the geometry: the list's own last scroll report, written
   * without a re-render. What a harness wants to know after a send is how far
   * from the end it ended up, and that number exists nowhere else.
   */
  metricsRef?: React.MutableRefObject<TimelineGeometry | null>;
  /** Same seam: lets the harness put the reader mid-history before measuring. */
  listRef?: React.MutableRefObject<FlatList<TimelineItem> | null>;
}): React.JSX.Element {
  const ownListRef = useRef<FlatList<TimelineItem> | null>(null);
  const listRef = externalListRef ?? ownListRef;
  /** Is the reader at the bottom? Decides whether new content is followed. */
  const followingRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  /**
   * Until when a send owns the scroll position. `0` means nobody does.
   *
   * Read by `onScroll`, which must not mistake this component's own travel for
   * the reader choosing to read history — see the header note.
   */
  const selfSendPinUntilRef = useRef(0);
  /** Is that pin being served by instant corrections rather than one glide? */
  const convergingRef = useRef(false);
  const geometryRef = useRef<TimelineGeometry>({
    offsetY: 0,
    contentHeight: 0,
    viewportHeight: 0,
  });

  const noteGeometry = useCallback(
    (next: Partial<TimelineGeometry>) => {
      geometryRef.current = {...geometryRef.current, ...next};
      if (metricsRef) metricsRef.current = geometryRef.current;
    },
    [metricsRef],
  );

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

  // One pass over the array this list is already rendering, so that a row can
  // answer two questions it cannot answer alone: "what does this reply answer"
  // and "how many replies are under this root, INCLUDING the ones I have that
  // the server's rollup predates". See `threadContext.ts` for why the second one
  // is the difference between replying and replying visibly.
  const threads = useMemo(() => buildThreadContext(messages), [messages]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      noteGeometry({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
      // A scroll this component STARTED is not the reader going anywhere. Every
      // intermediate position of a travel to the end is far from the end, so
      // answering them would revoke `following` mid-flight and cancel the very
      // correction that gets the sender to their own message. See the header.
      if (Date.now() < selfSendPinUntilRef.current) return;
      const distanceFromEnd =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      followingRef.current = distanceFromEnd <= FOLLOW_THRESHOLD_PX;
    },
    [noteGeometry],
  );

  /**
   * A finger on the glass ends the send's claim immediately.
   *
   * The pin has a deadline so that a stuck correction cannot hold the list
   * forever, but a deadline is a guess about intent and this is not: someone
   * dragging the list is telling us where they want to be, and a send from a
   * second ago does not get to argue.
   */
  const onScrollBeginDrag = useCallback(() => {
    selfSendPinUntilRef.current = 0;
    convergingRef.current = false;
  }, []);

  // Follow the tail only when the reader is already there. Anyone scrolled back
  // is READING, and yanking them to the bottom because someone else typed is
  // the same lost-place complaint the reversed list caused, arriving by a
  // different route.
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      // The one place the true content length is announced, and therefore the
      // signal that the tail spacer has grown past the clamp described in the
      // header. A send in flight is waiting for exactly this.
      noteGeometry({contentHeight: height});
      if (!didInitialScrollRef.current) {
        if (items.length === 0) return;
        didInitialScrollRef.current = true;
        listRef.current?.scrollToEnd({animated: false});
        return;
      }
      if (followingRef.current) {
        // Instant while a far send is climbing the clamp — a glide there is a
        // 300ms round trip per viewport, and there are as many rounds as there
        // are viewports between the reader and the end.
        listRef.current?.scrollToEnd({animated: !convergingRef.current});
      }
      // `listRef` is listed because it can be the caller's ref object rather than
      // this component's own — a prop, so the linter is right that it is not
      // guaranteed stable. Ref objects are compared by identity and the harness
      // passes one fixed object, so this costs nothing at runtime.
    },
    [items.length, listRef, noteGeometry],
  );

  // My own send: always, and from wherever they were. Skipped on the first
  // render so that merely opening a channel does not count as a send.
  //
  // **Two paths, because one of them loses a race.** The echo row and the token
  // arrive in the SAME commit, and `onContentSizeChange` is a native callback
  // that can fire either side of this effect. Measured on the simulator: a
  // single `scrollToEnd()` here left the reader in mid-history — the content
  // callback had already run while `following` was still false, and the call
  // below then computed its offset from a list whose new row had not been laid
  // out yet, so it scrolled to where the end USED to be.
  //
  // So: raise the flag first (any content-size change from here on follows), and
  // scroll on the next frame, once the inserted row has a height.
  //
  // **And one call does not arrive**, which is goal RN-P3 and the header note
  // above `SELF_SEND_PIN_MS`. From mid-history the offset `scrollToEnd` computes
  // is a guess over unmeasured rows AND the scroll view is holding a content
  // floor short of the real end, so the single call lands somewhere above the
  // message that was just written. The correction is to keep asking until the
  // list agrees it has arrived, for a bounded window, with the reader able to
  // end it by touching the list.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (selfSendToken === undefined) return;
    // Following again, because they are now at the bottom on purpose — the next
    // arrival from anyone else should keep them there.
    followingRef.current = true;
    selfSendPinUntilRef.current = Date.now() + SELF_SEND_PIN_MS;

    // Near the tail there is no clamp to climb and the glide that shipped is
    // right. `null` — a list that has never scrolled or been laid out — counts
    // as near: it has no history to be lost in.
    const distance = distanceToEnd(geometryRef.current);
    const near =
      distance === null || distance <= geometryRef.current.viewportHeight;
    convergingRef.current = !near;

    // The first hop still waits a frame: the token and the echo row arrive in
    // the same commit, and an offset computed before that row has a height is
    // computed against the list as it was.
    let frame = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({animated: near});
      if (near) return;
      const converge = () => {
        if (Date.now() >= selfSendPinUntilRef.current) {
          convergingRef.current = false;
          return;
        }
        const left = distanceToEnd(geometryRef.current);
        if (left !== null && left <= ARRIVED_PX) {
          convergingRef.current = false;
          return;
        }
        listRef.current?.scrollToEnd({animated: false});
        frame = requestAnimationFrame(converge);
      };
      frame = requestAnimationFrame(converge);
    });
    return () => {
      cancelAnimationFrame(frame);
      convergingRef.current = false;
    };
  }, [selfSendToken, listRef]);

  // The viewport changed size rather than the content growing. A reader who was
  // at the bottom stays at the bottom; one who was reading history is left
  // exactly where they were.
  //
  // The keyboard no longer reaches this handler and no longer needs to:
  // `ConversationLayout` moved from an animated `paddingBottom` to a transform,
  // so a raised keyboard SLIDES this list instead of shrinking it and the tail
  // keeps its distance to the composer with nothing to correct. What is left
  // here is the case that still resizes a list — rotation, and a banner
  // appearing above it — which is why it stays.
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      noteGeometry({viewportHeight: event.nativeEvent.layout.height});
      if (followingRef.current) listRef.current?.scrollToEnd({animated: false});
    },
    [listRef, noteGeometry],
  );

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
          actions={actions}
          rollup={rollupFor(item.message, threads)}
          // `undefined` turns the marker off for the whole surface. A thread
          // panel passes `markReplies={false}`: every row in there is a reply,
          // and a 답글 line on each would be noise wearing the shape of
          // information.
          replyParent={
            markReplies ? parentOf(item.message, threads) : undefined
          }
        />
      );
      if (anchorSeq !== undefined && item.message.seq === anchorSeq) {
        return (
          <View
            // The cleanup form, and it is the difference between a seam and a
            // coin toss. Moving `anchorSeq` to another row mounts a new wrapper
            // and unmounts the old one, and React does not promise which order
            // those land in; the plain `ref={node => ref.current = node}` form
            // is therefore free to attach the new node and THEN null it out on
            // the old one's behalf. That is a measurement that reports 「미측정」
            // for a row which is on screen — the exact reading the last batch
            // was left holding. Returning a cleanup makes the detach name the
            // node it is detaching, so it can only clear its own.
            ref={node => {
              if (!anchorRef) return undefined;
              anchorRef.current = node;
              return () => {
                if (anchorRef.current === node) anchorRef.current = null;
              };
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
      actions,
      anchorSeq,
      anchorRef,
      threads,
      markReplies,
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
    const copy = emptyOverride ?? emptyChannelCopy(channelKind, peer ?? null);
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
      // `renderItem` closes over these, and a `FlatList` cell will happily keep
      // rendering with a stale closure otherwise. The measurement seam found
      // this the hard way: moving `anchorSeq` to another row left the wrapper on
      // the old one, so the harness measured nothing and reported it as a
      // failure of the thing it was measuring.
      extraData={anchorSeq}
      // The correction. See the header note: key-identity based, so the derived
      // stream's extra dividers cost nothing.
      maintainVisibleContentPosition={{minIndexForVisible: 0}}
      onScroll={onScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      scrollEventThrottle={16}
      onContentSizeChange={onContentSizeChange}
      onLayout={onLayout}
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
      // The always-answerable seam. `collapsable={false}` unconditionally, and
      // the harness measures the SAME node the app renders: a footer that only
      // becomes measurable when someone is measuring is a footer whose position
      // was never the app's.
      ListFooterComponent={
        <View
          ref={node => {
            if (!tailRef) return undefined;
            tailRef.current = node;
            return () => {
              if (tailRef.current === node) tailRef.current = null;
            };
          }}
          collapsable={false}
          style={styles.footer}
        />
      }
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
