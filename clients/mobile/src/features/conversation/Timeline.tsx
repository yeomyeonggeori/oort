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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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

// ## A conversation shorter than the screen has to sit at the BOTTOM (goal RN-U1)
//
// 성재, iPhone 17: "스레드에서도 뭔가 채팅을 하면 위에 숨겨져 있어서 채팅 닫아야
// 보이더라."
//
// The ticket read this as the RN-P3 defect reaching a surface the fix had missed,
// and that is not what it is — RN-P3's correction is in THIS component, and
// `ThreadPanel` has passed `selfSendToken` since the day it was written
// (`__tests__/threadSelfSend.test.tsx` holds that). The arithmetic says something
// else, and it says it about any short conversation rather than about threads:
//
//   A `FlatList` whose content is shorter than its viewport draws that content at
//   the TOP and has nothing to scroll — `scrollToEnd` is a no-op, correctly.
//   `ConversationLayout` meanwhile lifts the whole pane by the keyboard's height
//   under an `overflow: 'hidden'` clip, so the top of the list travels up under
//   the header and is cut off. On an iPhone 17 that lift is 302pt (336 keyboard −
//   34 home indicator), the list's top edge sits at ~103pt (safe area + header),
//   and a thread holding a root and one reply is ~120pt of content. Every one of
//   those points ends up at a negative window y. The conversation is not below
//   the fold, it is ABOVE the screen — which is exactly the sentence, and exactly
//   why closing the keyboard brought it back.
//
// A thread is where it bites first because a thread is nearly always short, but
// nothing here is about threads: a channel with three messages does the same, and
// that is the one a person meets on their first day.
//
// So the content container grows to the viewport and packs to the end. When the
// content is TALLER than the viewport — every established channel — `flexGrow`
// has no free space to hand out and this changes nothing at all, which is why it
// can be turned on for both surfaces without re-earning RN-P3's numbers. When it
// is shorter, the rows sit on top of the composer where a lift cannot reach them.
// It is also what every messenger does with a new conversation, for this reason
// rather than for a stylistic one.
const CONTENT_ALIGNMENT = {flexGrow: 1, justifyContent: 'flex-end'} as const;

/** How near the bottom still counts as "following", in points. */
const FOLLOW_THRESHOLD_PX = 120;

/**
 * How long a send may keep the scroll position WITHOUT getting closer, in ms.
 *
 * This was a flat 1,200ms deadline until the simulator measured it. From 155
 * rows back the correction was still climbing when the clock ran out, and
 * `measure/` read 2,385px of conversation still below the fold — a fix that
 * worked everywhere except the case it was written for.
 *
 * The rounds are not the slow part; each is one frame. The limit is that a round
 * can only advance as far as the list has MEASURED, and `VirtualizedList`
 * measures on its own schedule — `maxToRenderPerBatch` 10 rows every
 * `updateCellsBatchingPeriod` 50ms. 155 rows is therefore a second and a half of
 * batches no matter how often it is asked to scroll.
 *
 * So the bound is behavioural instead of a constant: keep going while the
 * distance to the end is shrinking, stop when it stops. A send from two rows
 * back finishes in two frames and never reaches this; a send from the far end
 * takes as long as the list needs and not a frame longer; a send that is getting
 * nowhere gives up in 400ms rather than holding the list to a number someone
 * once guessed.
 */
const SELF_SEND_IDLE_MS = 400;

/**
 * The backstop, in ms. Nothing should reach it — arriving ends the correction
 * and so does making no progress. It is here because a scroll position that
 * cannot be got back is a worse defect than the one being fixed, and
 * `onScrollBeginDrag` (a finger) must not be the only way out.
 */
const SELF_SEND_MAX_MS = 4000;

/** Close enough to the end that another correction would move nothing. */
const ARRIVED_PX = 1;

/** How far the scroll has to advance to count as getting somewhere. */
const PROGRESS_PX = 1;

/**
 * The prepend correction, as one stable object so the prop does not churn.
 *
 * See the header for why `minIndexForVisible` is 0 and why that 0 is
 * load-bearing. It is hoisted here because a send now has to be able to take it
 * OFF — see `KEEPING_POSITION_FIGHTS_A_LONG_SCROLL` below.
 */
const KEEP_VISIBLE_POSITION = {minIndexForVisible: 0} as const;

// ## …and keeping the position fights a long scroll (goal RN-P3, measured)
//
// The correction above still could not finish from far back, and two guesses at
// why were both wrong before the harness was asked. Sampling the list's own
// geometry every 100ms through a send from 134 rows back gave the answer in one
// line:
//
//     오프셋 13589→15450(최대 15452) · 콘텐츠 13968→19677(최대 19681)
//
// The scroll advances. The content it is chasing is real and already reported by
// the scroll view. And the scroll stops 3,847px short of content that exists —
// so nothing is missing and nothing is mis-estimated; something is holding the
// offset back. The only thing that holds a `contentOffset` back in this list is
// `maintainVisibleContentPosition`, which is doing exactly its job: it pins the
// first visible subview, and a long programmatic scroll changes what is above
// the viewport on every round, so every round is met with a compensating
// adjustment.
//
// The two features are both right and they want opposite things. They do not
// have to want them at the same time: the correction is bounded, runs toward the
// END, and cannot overlap a prepend (`onStartReached` needs the reader at the
// TOP). So the pin comes off for the length of the correction and goes straight
// back on. `__tests__/timelineRender.test.tsx` still holds the resting value,
// because that is the one every other moment of this list's life uses.

/**
 * How long to leave between correction rounds, in ms.
 *
 * Matched to `VirtualizedList`'s own `updateCellsBatchingPeriod` (50ms), because
 * that is the rate at which new content can appear: a round can only advance as
 * far as the list has measured, so asking more often than it measures buys
 * nothing. It also costs something — every correction emits a scroll event, and
 * a list kept permanently in motion is a list whose batched render keeps being
 * rescheduled. One round per batch is the fastest cadence that is not fighting
 * the thing it is waiting for.
 */
const SELF_SEND_ROUND_MS = 50;


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
  /**
   * Is a correction currently travelling to the end?
   *
   * State rather than a ref because it has to reach the scroll view: while it is
   * true the prepend correction is off, for the reason in the note above
   * `KEEP_VISIBLE_POSITION`. Exactly two renders per far send.
   */
  const [chasingTail, setChasingTail] = useState(false);
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
    // And the prepend correction comes straight back: the reader taking the list
    // is the likeliest prelude to them scrolling UP into history, which is the
    // one thing that must never move under them.
    setChasingTail(false);
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
    const startedAt = Date.now();
    const hardStop = startedAt + SELF_SEND_MAX_MS;
    /** Extended on every round that gets somewhere; see `SELF_SEND_IDLE_MS`. */
    let idleStop = startedAt + SELF_SEND_IDLE_MS;
    /**
     * The furthest down this send has reached, as a scroll OFFSET.
     *
     * Offset, and not distance-to-the-end, and the measurement is what settled
     * it. Distance was the obvious choice and it reads backwards during exactly
     * the case that needs it: every round teaches the list about rows it had
     * only estimated, so `contentHeight` grows FASTER than the scroll advances
     * and the gap to the end gets bigger while the reader is visibly getting
     * closer. Judged on that, the correction declared itself stuck almost at
     * once — `measure/` read 4,007px left below the fold, worse than the flat
     * deadline it replaced. The offset only ever grows while this loop runs, so
     * it says what "getting somewhere" means without lying about it.
     */
    let furthest = Number.NEGATIVE_INFINITY;
    selfSendPinUntilRef.current = idleStop;

    // Near the tail there is no clamp to climb and the glide that shipped is
    // right. `null` — a list that has never scrolled or been laid out — counts
    // as near: it has no history to be lost in.
    const distance = distanceToEnd(geometryRef.current);
    const near =
      distance === null || distance <= geometryRef.current.viewportHeight;
    convergingRef.current = !near;
    // Off for the correction, back on the moment it ends.
    if (!near) setChasingTail(true);

    const release = () => {
      convergingRef.current = false;
      setChasingTail(false);
      // Hand the scroll back at once rather than at the deadline: the list is
      // where the send wanted it, so the ordinary rule ("far from the end means
      // the reader is reading") is true again and should apply again.
      selfSendPinUntilRef.current = 0;
    };

    // The first hop still waits a frame: the token and the echo row arrive in
    // the same commit, and an offset computed before that row has a height is
    // computed against the list as it was.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({animated: near});
      if (near) return;
      const converge = () => {
        const now = Date.now();
        if (now >= idleStop || now >= hardStop) {
          // Out of road. `following` is NOT forced here — whatever the next
          // scroll event says about where the reader ended up is now the truth,
          // including "still far from the end", which is the honest reading of a
          // correction that could not finish.
          release();
          return;
        }
        const geometry = geometryRef.current;
        if (geometry.offsetY > furthest + PROGRESS_PX) {
          furthest = geometry.offsetY;
          idleStop = Math.min(now + SELF_SEND_IDLE_MS, hardStop);
          selfSendPinUntilRef.current = idleStop;
        }
        const left = distanceToEnd(geometry);
        if (left !== null && left <= ARRIVED_PX) {
          release();
          return;
        }
        // `scrollToEnd` rather than an offset computed from `geometryRef`: the
        // list's own metrics are live, ours are one scroll event behind, and a
        // stale content height would ask the list to scroll BACKWARDS. Its
        // estimate overshoots the clamped content end (it estimates the DATA
        // end) and the scroll view clamps — so every round lands exactly as far
        // as the list will currently go, which is the most a round can do.
        listRef.current?.scrollToEnd({animated: false});
        timer = setTimeout(converge, SELF_SEND_ROUND_MS);
      };
      converge();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
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
      // See `CONTENT_ALIGNMENT`: a conversation shorter than the screen packs to
      // the bottom, because the keyboard lifts this list's top edge out of sight.
      contentContainerStyle={CONTENT_ALIGNMENT}
      // `renderItem` closes over these, and a `FlatList` cell will happily keep
      // rendering with a stale closure otherwise. The measurement seam found
      // this the hard way: moving `anchorSeq` to another row left the wrapper on
      // the old one, so the harness measured nothing and reported it as a
      // failure of the thing it was measuring.
      extraData={anchorSeq}
      // The correction. See the header note: key-identity based, so the derived
      // stream's extra dividers cost nothing.
      maintainVisibleContentPosition={
        chasingTail ? undefined : KEEP_VISIBLE_POSITION
      }
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
      // ## Putting the keyboard away (goal RN-U1 결함 1)
      //
      // 성재: "채팅창은 여는 건 성공했는데, 그냥 다시 닫을 때는 어떻게 해야 해?"
      //
      // This was `interactive`, and `interactive` cannot work in THIS layout. It
      // dismisses when a drag reaches the keyboard and drags it down — but since
      // RN-P2 the pane slides, so the list's bottom edge stops at the composer,
      // which stops above the keyboard. The finger never arrives at the thing the
      // mode is about, and the mode therefore does nothing. It was not a weak
      // affordance; it was an affordance with no surface to act on.
      //
      // `on-drag` asks nothing of where the drag ends: moving the conversation at
      // all puts the keyboard away, which is the gesture people already make when
      // they want to read instead of type.
      keyboardDismissMode="on-drag"
      // The other half of the rule is `handled`, and it is deliberately NOT
      // `never`. Both dismiss on a tap; they disagree about what else that tap
      // does, and `never` makes the scroll view swallow it — so while the
      // keyboard is up a long press would open no action sheet and a reaction
      // chip would refuse. `handled` leaves the row's own gesture intact and lets
      // `MessageRow` decide, which is where the tap rule is written down and
      // where `__tests__/messageTap.test.tsx` can reach it. A tap landing on
      // nothing (the gap under a short conversation) still dismisses here, which
      // is the case a row cannot answer for.
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
