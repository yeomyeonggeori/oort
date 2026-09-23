import {uuidEq, type Channel, type Message, type RosterMember} from '@momo/core/lib/api';
import {
  buildTimelineItems,
  emptyChannelCopy,
  withTurnPlaceholders,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineStreamItem,
} from '@momo/core/features/timeline/model';
import {chipsFor, type ReactionMap} from '@momo/core/features/timeline/reactions';
import {isPinned, type PinMap} from '@momo/core/features/timeline/pins';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {JumpPill, JumpPillDock} from './JumpPill';
import {
  countNewerThan,
  countUnreadJump,
  dividerRelation,
  jumpLatestAccessibilityLabel,
  jumpLatestSegments,
  jumpUnreadAccessibilityLabel,
  jumpUnreadSegments,
  shouldShowJumpUnread,
  type DividerViewportRelation,
} from './jumpPills';
import {EmptyState, ErrorState, LoadingState} from '../../design/atoms';
import {font, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';
import {
  DayDivider,
  MessageRow,
  PendingRow,
  RecoveryDivider,
  UnreadDivider,
  WorkingRow,
  type MessageRowActions,
} from './MessageRow';
import {resolveQuote} from '@momo/core/features/timeline/quote';
import {isStreamRunEnded} from '@momo/core/features/timeline/streamStop';
import {useEndedRuns} from '../agents/endedRuns';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import type {ApprovalGate, ApprovalReceipt} from './approvalGate';
import {buildThreadContext, parentOf, rollupFor} from './threadContext';
// 접기는 이제 **코어 정본**이다 (U4-6, #1102). 이 파일이 부르던 폰 로컬 판은
// 자기 머리말에 「정본 자리는 코어다」라고 적어 두고 폰에 있는 이유가 설계가
// 아니라 동시 작업임을 밝혀 두었다(#1100 이탈 1). 그 배치가 끝나면서 규칙·문구·
// **대리 착지 계약**이 그대로 올라갔고, 여기서는 임포트 경로만 바뀐다 — 규칙이
// 한 글자도 다르지 않다는 것은 `conversationHygiene.test.tsx` 가 단정한다.
import {
  foldDeletedRuns,
  foldedStandInIndex,
  type FoldedTimelineItem,
} from '@momo/core/features/timeline/deletedFold';

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
// So a send takes the wheel for a bounded window (`CONVERGE_IDLE_MS`): while it
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
const CONVERGE_IDLE_MS = 400;

/**
 * The backstop, in ms. Nothing should reach it — arriving ends the correction
 * and so does making no progress. It is here because a scroll position that
 * cannot be got back is a worse defect than the one being fixed, and
 * `onScrollBeginDrag` (a finger) must not be the only way out.
 */
const CONVERGE_MAX_MS = 4000;

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

/**
 * 반응이 하나도 없는 표면이 매번 새로 만들던 빈 맵.
 *
 * `reactions ?? {}` 를 `renderItem` 안에서 쓰면 호출마다 새 객체가 생기고, 그
 * 객체는 `chipsFor` 를 거쳐 새 배열이 된다. 상수 하나면 그 사슬이 끊긴다.
 */
const NO_REACTIONS: ReactionMap = {};
/** 같은 이유의 상수 (이슈 #1112). */
const NO_PINS: PinMap = {};

/** 측정 seam 이 읽는 필 판정 (#1892). 앱에서는 아무도 읽지 않는다. */
export interface PillState {
  /**
   * 목록이 위 필을 세우기로 했다. 키보드가 판을 들어 올린 동안에는 그 자리가
   * 스스로 물러나고(`JumpPillDock`, R1 M-4) 이 값은 그것을 모른다 — 하네스의 두
   * 앵커 판독은 키보드가 내려간 판에서 읽는다.
   */
  unread: boolean;
  latest: boolean;
  relation: 'above' | 'in' | 'below' | 'absent' | null;
  latched: boolean;
  /** `seen@<offset>` = 창 안에서 봤다 · `pressed` = 위 필을 눌렀다. */
  latchNote: string | null;
  settled: boolean;
}

/** 아직 아무 행도 보고되지 않았다. 빈 배열 하나를 모두가 나눠 쓴다. */
const NO_KEYS: readonly string[] = [];

/**
 * 같은 방인가 (#1892 R1 H-1). 호출자가 방을 알려 주지 않는 표면(스레드 패널·측정
 * 하네스)은 방이 하나뿐이므로 `undefined` 끼리는 같다. 와이어가 id 의 대소문자를
 * 섞어 보내므로 문자열 비교가 아니라 `uuidEq` 다.
 */
function sameChannel(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return uuidEq(a, b);
}

/**
 * 점프가 데려간 행을 찾지 못하면 얼마 동안 다시 볼지, ms (#1892 R1 M-3).
 *
 * 행은 목록이 그 자리에 도착해 셀을 붙여야 생긴다. `scrollToIndex` 가 한 번 실패해
 * 회복 경로를 타면 두 프레임이 더 든다. 1초면 그 둘을 넉넉히 덮고, 그보다 늦게
 * 초점이 옮겨 가면 사람이 이미 다른 곳을 만지고 있을 때다.
 */
const FOCUS_WAIT_MS = 1000;

/** 목록의 가장 아래 메시지 행 — 「최신으로」가 착지하는 행. */
function lastMessageId(items: readonly FoldedTimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'message') return item.message.id;
  }
  return null;
}

/** 구분선 바로 아래의 첫 메시지 행 — 「안읽음으로」가 초점을 두는 행(웹과 같다). */
function firstMessageIdAfter(
  items: readonly FoldedTimelineItem[],
  from: number,
): string | null {
  for (let index = from + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === 'message') return item.message.id;
  }
  return null;
}

/**
 * 「보인다」의 문턱 (#1892). 한 픽셀이라도 창에 걸리면 보인다 — 웹이 구분선에
 * 거는 IntersectionObserver 의 `threshold: 0` 과 같은 판정이다(「한 픽셀이어도
 * 소멸」). `FlatList` 는 이 객체가 도중에 바뀌는 것도 허락하지 않으므로 상수다.
 */
const PILL_VIEWABILITY = {itemVisiblePercentThreshold: 0} as const;

/**
 * 목록이 보인다고 한 **키**들로 구분선의 자리를 판정한다.
 *
 * 첨자가 아니라 키인 이유: 옛 페이지가 위에 붙으면(prepend) 같은 행들의 첨자가
 * 통째로 밀리는데, 보이는 행 집합은 그대로라 목록은 새 보고를 하지 않는다. 첨자를
 * 들고 있으면 그 순간부터 판정이 페이지 크기만큼 어긋난다 — 이 파일 머리말이
 * 「세지 말고 키로」라고 적어 둔 바로 그 함정이다.
 */
function relationFromKeys(
  items: readonly FoldedTimelineItem[],
  keys: readonly string[],
): DividerViewportRelation | null {
  const dividerAt = items.findIndex(item => item.kind === 'unread');
  if (dividerAt < 0) return 'absent';
  if (keys.length === 0) return null;
  const wanted = new Set(keys);
  const visible: number[] = [];
  items.forEach((item, index) => {
    if (wanted.has(item.key)) visible.push(index);
  });
  return dividerRelation(dividerAt, visible);
}

// =============================================================================
// 셀 계측 seam (goal RN-P2a / #997)
//
// `MessageRow` 의 계수기가 재는 것은 **행 본문**이고, 그것은 memo 아래층이다. 이
// 계수기는 그 위층을 잰다: `renderItem` 이 몇 번 불렸는가 = 몇 개의 셀이 bail-out 을
// 잃었는가. 둘이 따로 있어야 수리가 **어느 층**을 산 것인지 말할 수 있다 — 행 memo
// 하나만 있어도 행 렌더 수는 0으로 떨어지지만, 그 위에서는 여전히 셀마다 엘리먼트가
// 만들어지고 비교가 돈다.
// =============================================================================

let renderItemCalls = 0;

/** `renderItem` 이 불린 총 횟수 = 다시 그려진 셀의 수. */
export function timelineRenderItemCount(): number {
  return renderItemCalls;
}

/** 계측 구간의 시작점. */
export function resetTimelineRenderItemCount(): void {
  renderItemCalls = 0;
}


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
const CONVERGE_ROUND_MS = 50;


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

/** The offset at which the window's last pixel is the content's last pixel. */
function contentEnd(geometry: TimelineGeometry): number {
  return Math.max(0, geometry.contentHeight - geometry.viewportHeight);
}

/**
 * How long 「최신으로」 keeps the list on the end after arriving, in ms (#1892).
 * Long enough to outlast the adjustment measured in `holdLanding` (it came one
 * round after release); short enough that nobody could have meant to scroll in
 * it — and a finger ends it at once anyway (`onScrollBeginDrag`).
 */
const LANDING_HOLD_MS = 600;

/** UIKit's animated `setContentOffset` is ~300ms; wait for it to be down. */
const GLIDE_SETTLE_MS = 350;

/**
 * A jump's travel is over once the list has not moved for this long, in ms
 * (#1892 R2 H-A). The travel itself — why a jump owns the scroll while it moves,
 * and why it must look again when it stops — is the note above
 * `beginJumpTravel`.
 *
 * Every scroll event of a moving list is one frame apart (`scrollEventThrottle`
 * 16), and the first one follows the request by a frame or two. 250ms is several
 * of those gaps wide, so a list that is still moving is never taken for one
 * that stopped; a list that never moved at all — the landing whose target is
 * where it already stands, which sends no event — is judged 250ms after the
 * request.
 */
const JUMP_SETTLE_MS = 250;

/**
 * The backstop, in ms: a travel that never goes still (a recovery that keeps
 * failing) ends here and is judged where it stands. Nothing should reach it.
 */
const JUMP_TRAVEL_MAX_MS = 1500;

/** A jump on its way to its row (#1892 R1 M-1 · R2 H-A). See `beginJumpTravel`. */
interface JumpTravel {
  startedAt: number;
  /** When the list last moved — the request itself, until it first does. */
  lastMotionAt: number;
  /** A failed `scrollToIndex` is being asked again a frame from now. */
  recovering: boolean;
  /** The newest seq when the jump left — where the 「최신으로」 count starts. */
  leftAtSeq: number | null;
  /** What the landing is for, once it is over (the unread pill's focus move). */
  onLanded?: () => void;
}

// =============================================================================
// ## 이 목록이 다시 그려지는 값 (goal RN-P2a / #997)
//
// 성재, iPhone 17 릴리스 빌드: "스크롤 버벅임". 원인은 스크롤 자체가 아니라 **그
// 옆에서 도는 렌더**였고, RN 0.86.2 의 목록 3층이 전부 `PureComponent` 인데도
// 그 셋이 모두 무력화돼 있었다:
//
//   `FlatList`(`FlatList.js:307`) · `VirtualizedList`(`VirtualizedList.js:128`,
//   StateSafePureComponent) · `CellRenderer`
//   (`VirtualizedListCellRenderer.js:63`)
//
// 무력화된 자리는 셋이다.
//
//   1. `ConversationScreen` 이 `onResend`/`onResendPending` 을 **JSX 안의 인라인
//      화살표**로 넘기고 있었다. 그 둘은 아래 `renderItem` 의 의존성이므로,
//      화면이 무슨 이유로든 다시 그려지면 `renderItem` 이 새 함수가 되고
//      `CellRenderer` 의 얕은 비교가 거기서 실패한다 → **붙어 있는 모든 셀**이
//      `renderItem` 을 다시 부른다. 계측: 신호 갱신 2회 = 행 렌더 **16회**
//      (마운트된 행 8 × 2). 턴이 열려 있으면 여기에 1Hz 시계가 더 얹힌다.
//   2. `ListHeaderComponent`/`ListFooterComponent` 를 매 렌더 **새 엘리먼트**로
//      넘기고 있었다. 둘 다 평범한 prop 이므로 `FlatList` 의 얕은 비교가 언제나
//      실패하고, 이 목록은 "아무것도 바뀌지 않았다"를 말할 방법이 없었다.
//   3. `MessageRow` 에 memo 가 없었다. 1·2를 고쳐도 **데이터가 진짜 바뀔 때**는
//      갈리지 않는다: `buildTimelineItems` 가 항목 객체를 전부 새로 만들므로
//      메시지 하나가 도착하면 모든 셀이 다시 그려진다. 계측: 도착 1건에 행 렌더
//      **9회**(있어야 할 값은 1).
//
// 셋을 다 고쳐야 사슬이 끊긴다. `__tests__/conversationRenders.test.tsx` 가 그
// 사슬을 행 렌더 **수**로 잠근다 — 위 두 숫자가 그 파일에서 나온 것이다.
// =============================================================================

function TimelineInner({
  messages,
  directory,
  status,
  channelId,
  channelKind,
  peer,
  lastReadSeq,
  unreadCount,
  recoveryMarkers,
  pending,
  working,
  reactions,
  pins,
  approvalGates,
  approvalReceipts,
  approvalOffline,
  approvalsProvided,
  onApprovalSettled,
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
  showRollup = true,
  anchorSeq,
  anchorRef,
  jumpTarget,
  onJumpMissed,
  onJumpLanded,
  jumpPills = false,
  pillsRef,
  tailRef,
  metricsRef,
  listRef: externalListRef,
}: {
  messages: Message[];
  directory: Directory;
  status: 'loading' | 'ready' | 'error';
  /**
   * 이 목록이 지금 그리는 방 (#1892 R1 H-1).
   *
   * 대화 화면은 방을 옮길 때 이 컴포넌트를 언마운트하지 않는다 — 셸이 `channelId`
   * 만 갈아 끼운다. 그래서 「다른 대화가 됐다」를 이 목록이 스스로 알아야 하고, 그
   * 판정을 **방의 정체성**에 묶는 것이 이 prop 이다. 첫 판은 「목록이 비었는가」로
   * 판정했는데, 에이전트가 일하는 방은 메시지를 비우는 동안에도 「작업 중」 자리가
   * 서 있어 목록이 한 번도 비지 않았다(design-review 2594 R1 H-1). 웹이 `epoch` 로
   * 버리는 것과 같은 자리다.
   *
   * 바뀌면 필의 판정(래치·기준선·바닥·구분선 자리)과 진입 앵커를 전부 새로 한다.
   * 진입 앵커(#1025)는 **이 방의 메시지가 도착한 뒤에** 탄다 — 방이 바뀐 첫
   * 렌더에는 아직 앞 방의 행이 들려 있기 때문이다(`useTimeline` 은 효과에서 비운다).
   *
   * 방이 하나뿐인 표면(스레드 패널·측정 하네스)은 주지 않는다.
   */
  channelId?: string;
  channelKind?: Channel['kind'];
  peer?: RosterMember | null;
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  pending?: PendingMessage[];
  /**
   * 지금 이 채널에서 열린 턴을 가진 에이전트들 (#999). 스트림의 맨 끝에 「작업 중」
   * 한 칸씩을 얻는다 — 답이 나타날 바로 그 자리다.
   *
   * 이미 `turnPlaceholderKey` 가 `working` 만 남긴 뒤의 목록이고(승인 대기는 여기
   * 들어오지 않는다), 값이 같으면 **동일성도 같아야 한다**: 이 배열이 렌더마다
   * 새로 만들어지면 `items` 가 그때마다 다시 빌드되고, goal RN-P2a 가 막아 둔
   * 전파가 그대로 돌아온다. 그래서 호출자는 키로 memo 한다.
   */
  working?: readonly {memberId: string}[];
  reactions?: ReactionMap;
  /**
   * 이슈 #1112 — 채널의 고정들. 행마다의 `pinned` 는 여기서 유도한다: 행이 지도를
   * 통째로 들면 어디서 무엇이 고정되든 붙어 있는 행이 전부 다시 그려진다.
   */
  pins?: PinMap;
  /**
   * 결정 가능한 대기 승인, `approvalId` 로.
   *
   * 화면이 **한 번** 구독해서 내려보낸다. 행마다 물으면 스크롤 한 번이 요청
   * 폭풍이 되고, 승인 카드가 셋 있는 화면에서 그 셋이 같은 목록을 각자 부른다.
   * 왜 카드 대신 원장을 봐야 하는지는 `approvalGate.ts` 머리말에 있다.
   */
  approvalGates?: ReadonlyMap<string, ApprovalGate>;
  /** 결정이 끝난 카드가 말할 영수증, `approvalId` 로. 컨트롤과 자리를 바꾼다. */
  approvalReceipts?: ReadonlyMap<string, ApprovalReceipt>;
  /** 연결이 끊겼는가 — 끊겼으면 컨트롤 대신 인박스와 같은 문장. */
  approvalOffline?: boolean;
  /** 서버가 승인 경로를 실었는가. 행이 코어 판정에 그대로 넘긴다. */
  approvalsProvided?: boolean;
  onApprovalSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
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
   * 루트 행이 「답글 N개 · 마지막 …」을 그리는가 (goal RN-U2).
   *
   * 채널에서는 참이다. 그 줄은 **"여기 스레드가 있다"를 알리는 유일한 장치**이고,
   * 그것이 없으면 답글이 달렸다는 사실이 목록 어디에도 남지 않는다.
   *
   * 스레드 패널에서는 거짓이다 — 성재: "답글에서 개수 업데이트는 굳이 왜 해? 목록에
   * 나오면 몇 개의 reply가 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로
   * 보이는 건 자연스럽지 않은 거 같아." 이미 그 스레드 안에 있는 사람에게 그 줄이
   * 나르는 정보는 0이고, 답글을 달 때마다 숫자가 오르는 것은 산만하다.
   *
   * **핸들러 유무와는 다른 축이다.** 패널은 `onOpenThread` 를 주지 않으므로 롤업이
   * 이미 버튼이 아니라 글로 그려지고 있었지만, 글이어도 그려지기는 했다 — 조건이
   * `rollup` 하나였기 때문이다. 여기서 끊는 것은 그 조건이다.
   */
  showRollup?: boolean;
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
   * 이 메시지로 이동하라 (ADR-0148 인용 점프).
   *
   * `token` 이 함께 오는 이유: 같은 인용을 두 번 누르는 것은 두 번의 요청이고,
   * id 만 보면 두 번째 누름은 아무 일도 안 일어난다. 값이 아니라 **사건**이므로
   * 사건마다 다른 값이 필요하다.
   */
  jumpTarget?: {messageId: string; seq: number | null; token: number};
  /**
   * 그 행이 이 화면에 없다. 「더 위쪽이라 아직 안 불러왔다」와 「모르겠다」를
   * 가른 채로 돌려준다 — 인용은 원본의 `seq` 를 들고 오므로 그 구별이 추측이
   * 아니라 사실이다. 라이브 프레임으로 온 인용에는 seq 가 없어서 `null` 이 온다.
   */
  onJumpMissed?: (reason: 'older' | 'unknown') => void;
  /** 점프가 실제로 착지했다. 앞선 「못 찾았습니다」 고지를 거두는 신호. */
  onJumpLanded?: () => void;
  /**
   * 위 「안읽음으로」·아래 「최신으로」 점프 필을 띄우는가 (#1892).
   *
   * 채널 대화만 켠다 — 웹도 채널 타임라인에만 둔다. 스레드 패널은 짧고 안읽음
   * 경계가 없으며, 측정 하네스는 자기가 재는 것에 맞춰 고른다.
   *
   * **마운트 동안 바뀌지 않아야 한다.** 이 값이 `onViewableItemsChanged` 를 걸고
   * 떼는데, `FlatList` 는 그 콜백이 도중에 바뀌는 것을 허락하지 않는다.
   */
  jumpPills?: boolean;
  /**
   * Measurement seam (`measure/harness.tsx`), inert in the app (#1892).
   *
   * Which pills are on screen right now, written on every render. The anchor
   * claims are only a statement about the pills if the harness can say a pill
   * was actually standing over the list while the anchor was read — otherwise
   * "0px with the pills on" is a claim about a frame nobody looked at.
   */
  pillsRef?: React.MutableRefObject<PillState | null>;
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
  listRef?: React.MutableRefObject<FlatList<TimelineStreamItem> | null>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const ownListRef = useRef<FlatList<TimelineStreamItem> | null>(null);
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
  const scrollPinUntilRef = useRef(0);
  /**
   * A jump travelling to its row, or `null` (#1892 R1 M-1 · R2 H-A). While one
   * is, a scroll event is its motion rather than the reader's choice — see
   * `beginJumpTravel`.
   */
  const jumpTravelRef = useRef<JumpTravel | null>(null);
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
  /**
   * 방금 점프해서 도착한 행의 id (#1076). 없으면 `null`.
   *
   * 상태인 이유: 이 값은 **화면에 닿아야** 한다. 한 번에 한 행만 참이어야 하므로
   * 목록이 들고(행은 자기가 목적지였는지 모른다), 점프 한 번에 정확히 두 번
   * 바뀐다 — 세울 때와 사람이 화면을 다시 가져갈 때.
   */
  const [landedId, setLandedId] = useState<string | null>(null);
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

  const stream = useMemo(
    () =>
      withTurnPlaceholders(
        buildTimelineItems(messages, {
          lastReadSeq,
          unreadCount,
          recoveryMarkers,
          pending,
        }),
        working,
      ),
    [messages, lastReadSeq, unreadCount, recoveryMarkers, pending, working],
  );

  // One pass over the array this list is already rendering, so that a row can
  // answer two questions it cannot answer alone: "what does this reply answer"
  // and "how many replies are under this root, INCLUDING the ones I have that
  // the server's rollup predates". See `threadContext.ts` for why the second one
  // is the difference between replying and replying visibly.
  const threads = useMemo(() => buildThreadContext(messages), [messages]);

  // 연달아 지워진 메시지는 한 줄로 접힌다 (감사 M-1). 무엇을 접지 **않는지**와
  // 그 이유는 코어 `features/timeline/deletedFold.ts` 머리말에 있다.
  //
  // `threads`·`reactions` 뒤에 서는 이유가 그 규칙이다: 답글이 달렸거나 반응이
  // 붙은 묘비는 접지 않으므로, 접기는 그 둘을 **아는 상태에서만** 판정할 수 있다.
  const items = useMemo(
    () =>
      foldDeletedRuns(stream, item => ({
        // `showRollup` 이 거짓인 표면(스레드 패널)은 롤업을 아예 안 그리므로,
        // 그 표면에서 롤업은 접기를 막을 이유가 되지 못한다 — 없는 문은 문이
        // 아니다.
        hasRollup: showRollup && rollupFor(item.message, threads) !== null,
        hasReactions:
          chipsFor(reactions ?? NO_REACTIONS, item.message.id, myMemberId)
            .length > 0,
      })),
    [stream, threads, reactions, myMemberId, showRollup],
  );

  // ===========================================================================
  // 점프 필의 상태 (#1892 — 웹 `Timeline.tsx` 「항법 상태」의 폰판)
  //
  // 셋이다.
  //
  //   **아래에 있는가** (`atBottom`) — 이 목록이 이미 들고 있던 「따라가기」 판정의
  //     거울이다. 따로 재면 아래 필이 떠 있는데 목록은 꼬리를 따라가는, 서로 모순인
  //     두 말이 동시에 선다. 그래서 `followingRef` 에 쓰는 문을 `noteFollowing` 하나로
  //     모았다.
  //   **기준선** (`baselineSeq`) — 바닥을 떠난 순간의 가장 새 seq. 아래 필의 N 은 그
  //     뒤에 붙은 **남의 말**이다(`countNewerThan`).
  //   **래치** (`unreadLatched`) — 이 방문에서 구분선을 봤거나 위 필을 눌렀다. 서면
  //     위 필은 다시 서지 않는다. 방이 바뀌면(`channelId`) 풀린다.
  //
  // 위 필의 N 은 여기서 세지 않는다. 호출자가 방을 연 순간 얼린 `unreadCount` —
  // 구분선에 적힌 바로 그 수다(동결 N).
  // ===========================================================================
  // 「동작 줄이기」는 점프를 **누르는 순간**에만 읽는다. 그래서 상태가 아니라 ref 다
  // — 값이 바뀌어도 그릴 것이 없고, 비동기 첫 답이 렌더를 부르지 않는다(R1 N-1).
  const reduceMotionRef = useReduceMotionRef();
  const [atBottom, setAtBottom] = useState(true);
  /**
   * The pill's half of the following verdict, read without a render — see
   * `noteFollowing`, and `beginJumpTravel` for the one moment the two halves may
   * differ.
   */
  const atBottomRef = useRef(true);
  const [baselineSeq, setBaselineSeq] = useState<number | null>(null);
  /**
   * 구분선이 창의 어디에 있는가 — **바뀔 때만** 상태가 된다.
   *
   * 보이는 행의 목록 자체를 상태로 두면 스크롤 중 행 하나가 창을 드나들 때마다 이
   * 목록이 다시 그려진다. 필에 필요한 것은 네 값(위·안·아래·없음) 중 하나뿐이고,
   * 같은 값이면 React 가 렌더를 건너뛴다. 끝으로 가는 수렴처럼 행이 수십 개씩 창을
   * 지나가는 순간에 JS 스레드를 비워 두는 것이 이 모양의 이유다.
   */
  const [relationState, setRelationState] =
    useState<DividerViewportRelation | null>(null);
  const [unreadLatched, setUnreadLatched] = useState(false);
  /** 지금 가장 새 확정 메시지. 바닥을 떠나는 순간 기준선이 된다. */
  const newestSeqRef = useRef<number | null>(null);
  newestSeqRef.current =
    messages.length === 0 ? null : messages[messages.length - 1].seq;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** 목록이 마지막으로 「보인다」고 한 행들. 콜백이 렌더보다 먼저 읽는다. */
  const viewableKeysRef = useRef<readonly string[]>(NO_KEYS);
  /**
   * 목록이 **자기 출발점에 앉았는가** — 진입 수렴이 끝났거나, 사람이 목록을
   * 잡았거나, 끝 근처에서 쉬고 있는 것이 관측됐다.
   *
   * 래치를 무장하는 조건이다. 마운트 순간의 목록은 오프셋 0 에 서 있고, 그 첫
   * 보고에서는 맨 위 행들이 「보인다」 — 구분선이 거기 있으면 사람이 한 번도 못 본
   * 경계로 래치가 걸려 이 방문 내내 위 필이 서지 않는다. 웹이 겪은 「채널 오픈 스윕」
   * (design-review H-1 오발)과 같은 모양이고, 폰에서 그 스윕은 진입 수렴이다.
   */
  const entrySettledRef = useRef(false);

  /** 구분선이 **지금** 창의 어디에 있는가. 렌더를 기다리지 않고 ref 로 판정한다. */
  const relationNow = useCallback(
    (): DividerViewportRelation | null =>
      relationFromKeys(itemsRef.current, viewableKeysRef.current),
    [],
  );

  /** 래치가 **왜** 걸렸는가 — 측정 seam 이 사진에 적는다(`pillsRef`). */
  const latchNoteRef = useRef<string | null>(null);

  // ---- 방이 바뀌면 이 목록의 판정을 전부 새로 한다 (#1892 R1 H-1) -------------
  //
  // 판정은 **방의 정체성**에 묶는다(`channelId`). 첫 판은 「목록이 비었는가」에
  // 묶었고, 에이전트가 일하는 방으로 옮기면 「작업 중」 자리 때문에 목록이 한 번도
  // 비지 않아 앞 방의 래치·기준선·바닥 판정이 새 방으로 넘어왔다. 앞 방에서 구분선을
  // 봤으면 새 방의 「안읽음으로」가 그 방문 내내 서지 않았고, 앞 방에서 위로 올라가
  // 있었으면 아래 필의 N 이 앞 방의 seq 를 기준선으로 새 방의 메시지를 셌다 — seq 는
  // 방마다 따로 매기므로 그 수는 거짓이다.
  //
  // 렌더 중에 바로잡는다(React 의 「이전 prop 과 비교해 상태를 고친다」 모양). 효과로
  // 미루면 새 방의 첫 프레임이 앞 방의 필을 한 번 그린다. 여기서 비우는 ref 들은
  // 이 렌더 직후 도착하는 네이티브 보고가 곧바로 읽는 것들이다. 타이머를 거두는 일은
  // 부수 효과라 아래 `convergeToEnd` 옆의 효과가 한다.
  const [judgedChannel, setJudgedChannel] = useState(channelId);
  if (!sameChannel(judgedChannel, channelId)) {
    setJudgedChannel(channelId);
    setAtBottom(true);
    setBaselineSeq(null);
    setRelationState(null);
    setUnreadLatched(false);
    setLandedId(null);
    followingRef.current = true;
    atBottomRef.current = true;
    // 진입 앵커(#1025)를 다시 태운다. 새 목록은 앞 방의 오프셋에 서 있거나(자리
    // 표시가 목록을 붙잡은 경우) 오프셋 0 에서 다시 선다. 어느 쪽이든 새 방의 바닥이
    // 아니다.
    didInitialScrollRef.current = false;
    entrySettledRef.current = false;
    viewableKeysRef.current = NO_KEYS;
    latchNoteRef.current = null;
  }

  /**
   * 진입 앵커가 기다리는 것 — **이 방의 메시지**가 목록에 왔다 (#1892 R1 H-1).
   *
   * `items` 의 길이로 보면 안 된다. 「작업 중」 자리와 보내는 중인 메아리는 메시지가
   * 하나도 없어도 행이 되고, 방이 바뀐 첫 렌더에는 `messages` 가 아직 앞 방의 것이다.
   * 둘 중 어느 것에 진입 앵커를 태워도 새 방의 첫 페이지는 앵커 없이 도착한다.
   */
  const holdsChannelContent =
    messages.length > 0 &&
    (channelId === undefined || uuidEq(messages[0].channelId, channelId));
  const holdsChannelContentRef = useRef(holdsChannelContent);
  holdsChannelContentRef.current = holdsChannelContent;

  /**
   * 목록(스크롤뷰) **자체의** 정체성 — 지금 든 행들의 방이다 (#1892 R1 H-1, 시뮬레이터 실측).
   *
   * 판정만 새로 해서는 모자랐다. 「작업 중」 자리가 목록을 붙잡으면 앞 방의 스크롤뷰가
   * 그대로 새 방을 받는다. 그 스크롤뷰의 `maintainVisibleContentPosition` 은 앞 판에서
   * 기록한 앵커를 들고 있고, 새 방의 진입 수렴이 끝나 그 prop 이 다시 켜지는 순간
   * 그 낡은 앵커를 clamp 없이 적용한다(리뷰 M-2 의 원인). 잰 기록
   * (`JUMP-PILLS-ROOMS`): 진입이 `2192→2396/3008` 로 끝을 오르다가 101ms 뒤
   * **`357`** 로 밀려났고, 목록은 구분선이 보이는 그 자리에 서서 래치가 걸렸다 —
   * 새 방의 「안읽음으로」는 서지 않았다. 자리표시가 없던 길은 로딩 표시가 목록을
   * 언마운트하므로 늘 새 스크롤뷰였고, 그래서 멀쩡했다.
   *
   * 그래서 새 방의 행이 도착하면 **새 스크롤뷰**에서 받는다(`key`). 모든 방 진입이
   * 첫 마운트와 같은 길을 탄다. 행이 빈 동안은 앞 방의 이름을 그대로 들고 있다 —
   * 방이 바뀐 첫 렌더(앞 방의 행)나 빈 목록에서 다시 마운트하면, 새 목록은 앞 방의
   * 행이나 자리표시로 앵커를 기록하고 같은 일이 다시 난다.
   */
  const listRoomRef = useRef<string | null>(null);
  const contentRoom =
    messages.length > 0
      ? messages[0].channelId.toLowerCase()
      : listRoomRef.current;
  if (contentRoom !== listRoomRef.current) {
    listRoomRef.current = contentRoom;
    // 새 스크롤뷰는 맨 위에서, 아무것도 재지 않은 채 선다. 앞 스크롤뷰의 기하를
    // 들고 있으면 새 방의 수렴이 첫 라운드를 앞 방의 오프셋으로 판정한다.
    geometryRef.current = {offsetY: 0, contentHeight: 0, viewportHeight: 0};
    if (metricsRef) metricsRef.current = geometryRef.current;
  }
  const listKey = contentRoom ?? 'empty';

  /** 출발점에 앉은 뒤 구분선이 창 안에 있으면 — 봤다. 래치를 건다. */
  const armLatchIfDividerSeen = useCallback(() => {
    if (!entrySettledRef.current) return;
    if (relationNow() !== 'in') return;
    latchNoteRef.current = `seen@${Math.round(geometryRef.current.offsetY)}`;
    setUnreadLatched(true);
  }, [relationNow]);

  const settleEntry = useCallback(() => {
    if (entrySettledRef.current) return;
    entrySettledRef.current = true;
    // 측정 seam 은 렌더마다 쓰인다. 앉는 순간 화면이 바뀌지 않으면(착지가 필을 그대로
    // 두면) 다시 그려지지 않아 사진이 옛 값을 읽으므로, 여기서도 적는다(R2 N-B 캡처).
    if (pillsRef?.current) pillsRef.current = {...pillsRef.current, settled: true};
    // 앉은 자리에서 이미 보이는 구분선은 본 것이다. 뒤에 새 메시지가 그것을 위로
    // 밀어내도 위 필이 「안 본 경계」처럼 서지 않는다(웹 IO 의 첫 보고와 같은 판정).
    armLatchIfDividerSeen();
  }, [armLatchIfDividerSeen, pillsRef]);

  /**
   * 따라가기 판정을 내리는 문 — `followingRef` 와 필(`atBottom`)을 한 번에 맞춘다.
   *
   * 필이 바뀔 때만 상태를 건드린다 — 스크롤 이벤트는 초당 60번 오고, 그때마다
   * 렌더를 부르면 목록 옆에서 도는 렌더가 곧 goal RN-P2a 의 버벅임이다.
   *
   * 판정을 내리지 않고 따라가기만 **붙드는** 자리가 하나 있다 — 점프가 가는 동안
   * (`beginJumpTravel`). 그때 필은 판정이 날 때까지 그대로 두고, 판정은 이 문으로
   * 온다. 비교를 `followingRef` 가 아니라 필 쪽(`atBottomRef`)과 하는 이유가 그것이다:
   * 붙들린 `false` 와 같은 값이라고 필을 건너뛰면 착지 판정이 필에 닿지 못한다.
   */
  const noteFollowing = useCallback(
    (next: boolean, leftAtSeq?: number | null) => {
      followingRef.current = next;
      if (atBottomRef.current === next) return;
      atBottomRef.current = next;
      setAtBottom(next);
      // 떠나는 순간의 가장 새 seq 가 기준선이다. 바닥에 닿으면 아래에 쌓인 것은 0이다.
      // 점프는 떠난 순간을 들고 온다 — 판정이 착지 뒤로 미뤄지기 때문이다.
      setBaselineSeq(
        next ? null : leftAtSeq !== undefined ? leftAtSeq : newestSeqRef.current,
      );
    },
    [],
  );

  /**
   * `onViewableItemsChanged` 는 **처음 받은 함수 하나**여야 한다 — `FlatList` 는
   * 그것이 도중에 바뀌는 것을 허락하지 않는다. 그래서 ref 에 한 번 만들고, 읽는
   * 것은 전부 ref 다.
   */
  const onViewableItemsChanged = useRef(
    ({viewableItems}: {viewableItems: ViewToken<FoldedTimelineItem>[]}) => {
      viewableKeysRef.current = viewableItems.map(token => token.key);
      setRelationState(relationFromKeys(itemsRef.current, viewableKeysRef.current));
      armLatchIfDividerSeen();
    },
  ).current;

  // 목록이 바뀌어도 자리는 다시 판정한다 — 방을 연 뒤에야 읽음 스냅샷이 도착해
  // 구분선이 새로 서는 경우, 보이는 행 보고는 새로 오지 않는다.
  useEffect(() => {
    if (!jumpPills) return;
    setRelationState(relationFromKeys(items, viewableKeysRef.current));
  }, [jumpPills, items]);

  const unreadJumpCount = countUnreadJump(unreadCount);
  const relation: DividerViewportRelation | null = jumpPills
    ? relationState
    : 'absent';
  const showJumpUnread =
    jumpPills && shouldShowJumpUnread(relation, unreadJumpCount, unreadLatched);
  const newCount = useMemo(
    () =>
      baselineSeq === null
        ? 0
        : countNewerThan(messages, baselineSeq, myMemberId),
    [messages, baselineSeq, myMemberId],
  );
  const showJumpLatest = jumpPills && !atBottom;
  if (pillsRef) {
    pillsRef.current = {
      unread: showJumpUnread,
      latest: showJumpLatest,
      relation,
      latched: unreadLatched,
      latchNote: unreadLatched ? latchNoteRef.current : null,
      settled: entrySettledRef.current,
    };
  }

  /**
   * 다음 `scrollToIndex` 가 목적지를 창의 어디에 놓는가. 인용은 가운데(앞뒤가
   * 함께 읽혀야 뜻이 산다), 안읽음 필은 위(경계 아래부터 읽어 내려간다).
   * `onScrollToIndexFailed` 의 회복이 같은 자리에 다시 놓으려면 이 값을 알아야 한다.
   */
  const scrollViewPositionRef = useRef(0.5);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      const previous = geometryRef.current;
      noteGeometry({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
      // A jump is still on its way (#1892 R2 H-A): this event is its motion, and
      // the verdict waits for the list to stop (`beginJumpTravel`). The geometry
      // above is kept either way — it is exactly what that verdict reads.
      const travel = jumpTravelRef.current;
      if (travel !== null) {
        travel.lastMotionAt = Date.now();
        return;
      }
      // A scroll this component STARTED is not the reader going anywhere. Every
      // intermediate position of a travel to the end is far from the end, so
      // answering them would revoke `following` mid-flight and cancel the very
      // correction that gets the sender to their own message. See the header.
      if (Date.now() < scrollPinUntilRef.current) return;
      // ## 창이 좁아진 것도 사람이 움직인 것이 아니다 (goal RN-P2b / #998)
      //
      // 성재, iPhone 17: *"채팅치면 채팅바에 내 최근 채팅이 가려진다."*
      //
      // 컴포저는 고정 높이가 아니다 — 두 줄째로 넘어가는 글자, `@` 가 여는 멘션
      // 목록(최대 180pt), 턴이 열리며 서는 활동 줄. 전부 아래에서 위로 자라고,
      // 리스트는 `flex: 1` 이라 그만큼 짧아진다.
      //
      // 그때 `contentOffset` 은 그대로인데 `layoutMeasurement.height` 만 ΔH 작아지고,
      // 아래 식은 ΔH 만큼 커진다. 그 값을 실은 스크롤 이벤트가 `onLayout` 보다 먼저
      // 도착하면 이 줄은 그것을 「읽던 사람이 위로 올라갔다」로 읽어 버린다 — 멘션
      // 목록 하나면 임계값 120pt 를 이미 넘는다. 그러고 나면 뒤따라온 `onLayout` 은
      // `following` 이 거짓이라 아무것도 하지 않고, 방금 쓴 메시지는 컴포저 뒤에
      // 남는다. 손가락은 유리에 닿은 적이 없다.
      //
      // 그래서 **줄어든 만큼은 거리에서 뺀다.** 창의 변화는 창의 것이지 사람의 것이
      // 아니다. 보정은 전환이 실린 그 한 이벤트에만 걸린다(다음 이벤트부터는
      // `previous.viewportHeight` 가 이미 새 값이라 `shrankBy` 가 0이다), 그리고
      // 진짜로 과거를 읽고 있던 사람은 그대로 남는다 — 500pt 떨어져 있었으면 보정
      // 뒤에도 500pt 이고, 임계값을 넘는다.
      const shrankBy = Math.max(
        0,
        previous.viewportHeight - layoutMeasurement.height,
      );
      const distanceFromEnd =
        contentSize.height -
        (contentOffset.y + layoutMeasurement.height) -
        shrankBy;
      // 출발점에 앉았는지는 여기서 판정하지 않는다 (#1892). 마운트 직후의 목록은
      // 첫 배치만 든 짧은 콘텐츠라 오프셋 0 에서도 「끝 근처」로 읽히고, 그 순간
      // 보이는 맨 위 행들 사이에 구분선이 있으면 사람이 본 적 없는 경계로 래치가
      // 걸린다(시뮬레이터에서 실제로 그렇게 위 필이 끝내 안 섰다). 앉았다는 것은
      // 진입 수렴이 끝났거나(`release`) 손가락이 목록을 잡았을 때(`onScrollBeginDrag`)
      // 뿐이다.
      noteFollowing(distanceFromEnd <= FOLLOW_THRESHOLD_PX);
    },
    [noteGeometry, noteFollowing],
  );

  // ---- 점프가 데려간 행에 초점을 둔다 (#1892 R1 M-3) --------------------------
  //
  // 필은 누르는 순간 사라진다. VoiceOver 초점이 그 필에 있었으면 초점은 갈 곳을
  // 잃고, 화면을 보지 않는 사람은 목록이 어디에 섰는지 모른다. 웹은 두 점프 모두
  // 착지한 행으로 초점을 옮긴다(`scheduleFocusRowStationBySeq`). 폰도 같은 행으로
  // 옮긴다 — 「최신으로」는 가장 아래 메시지, 「안읽음으로」는 구분선 아래 첫 메시지.
  //
  // 행의 노드는 행이 스스로 알린다(`MessageRow` 의 `registerRowNode`). 행을 새 틀로
  // 감싸 ref 를 달면 감싸고 벗기는 순간마다 행이 다시 마운트되고, 초점을 줄 노드가
  // 바로 그 순간 바뀐다. 알리는 함수는 하나를 모든 행이 나눠 쓰므로 행의 memo 는
  // 그대로 맞는다.
  const rowNodesRef = useRef(new Map<string, View>());
  const registerRowNode = useCallback((id: string, node: View) => {
    const key = id.toLowerCase();
    rowNodesRef.current.set(key, node);
    // 떼는 쪽이 자기 노드를 이름으로 지목한다 — 같은 행이 다시 붙은 뒤에 앞 노드의
    // 정리가 도착해도 새 노드를 지우지 않는다(`anchorRef` 래퍼와 같은 이유).
    return () => {
      if (rowNodesRef.current.get(key) === node) rowNodesRef.current.delete(key);
    };
  }, []);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const cancelFocus = useCallback(() => {
    if (focusTimerRef.current !== undefined) {
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = undefined;
    }
  }, []);
  /**
   * `delayMs` 뒤에 그 행으로 초점을 옮긴다. 행이 아직 안 붙었으면 라운드마다 다시
   * 보고, `FOCUS_WAIT_MS` 를 넘기면 조용히 그만둔다. 새 이동·손가락·방 전환이
   * 걸린 것을 거둔다 — 초점은 사람이 **방금** 한 동작의 결과여야 한다.
   */
  const focusRow = useCallback(
    (id: string | null, delayMs: number) => {
      cancelFocus();
      if (id === null) return;
      const key = id.toLowerCase();
      const giveUpAt = Date.now() + delayMs + FOCUS_WAIT_MS;
      const attempt = () => {
        focusTimerRef.current = undefined;
        const node = rowNodesRef.current.get(key);
        if (node === undefined) {
          if (Date.now() < giveUpAt) {
            focusTimerRef.current = setTimeout(attempt, CONVERGE_ROUND_MS);
          }
          return;
        }
        // `WorkConsoleScreen` 과 같은 두 줄이다(노드 → 손잡이 → 초점). 그쪽이 감싼
        // `InteractionManager` 는 RN 0.86 에서 폐기 경고를 내므로 새로 쓰지 않는다 —
        // 기다림은 이미 위의 `delayMs` 가 착지 시각으로 한다.
        const handle = findNodeHandle(node);
        if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
      };
      focusTimerRef.current = setTimeout(attempt, delayMs);
    },
    [cancelFocus],
  );

  /** 지금 창에 보이는 가장 아래 메시지 행 — 보고가 없으면 `null`. */
  const lastVisibleMessageId = useCallback((): string | null => {
    const visible = new Set(viewableKeysRef.current);
    const all = itemsRef.current;
    for (let index = all.length - 1; index >= 0; index -= 1) {
      const item = all[index];
      if (item.kind === 'message' && visible.has(item.key)) return item.message.id;
    }
    return null;
  }, []);

  // ---- 점프의 이동 — 멈추면 끝나고, 끝나면 다시 판정한다 (#1892 R1 M-1 · R2 H-A) ----
  //
  // 인용·고정·검색·세션 앵커·알림 착지, 그리고 「안읽음으로」는 전부 `scrollToIndex`
  // 로 한 줄에 간다. 가는 동안의 스크롤 보고는 **이 목록이 움직인 것**이지 사람이 고른
  // 자리가 아니다. R1 이 시뮬레이터에서 잰 대로, 아직 안 잰 줄로 가는 점프는
  // `onScrollToIndexFailed` 가 목록을 대략의 자리에 세우는데 새 목록에서는 그 자리가
  // 잰 데까지의 끝(788/1399)으로 clamp 되고, 그 보고를 「바닥에 있다」로 읽으면
  // 따라가기가 켜져 착지 대신 꼬리로 끌려갔다. 그래서 점프는 가는 동안 판정을 쥔다.
  //
  // R2 는 그것을 시계(800ms)로 쥐었고, **놓을 때 다시 보지 않았다**(design-review 2594
  // R2 H-A). 끝난 프로그램 스크롤이 보내는 마지막 보고(RN `_handleFinishedScrolling`)는
  // 그 800ms 안에 와서 버려졌고, 목표가 지금 자리로 clamp 되면(끝 근처 착지·짧은
  // 대화) 보고는 아예 오지 않는다(`scrollToOffset:animated:` 의 같은 점 반환). 가장 새
  // 메시지 위에 서서 「최신 메시지로 이동」을 보았고, 다음 메시지는 따라가지 않았다.
  // base 는 마지막 보고로 다시 판정했으므로, 오프셋이 움직인 절반은 R2 가 만든 회귀다.
  //
  // 이제 쥐는 것은 **이동과 함께 끝난다**:
  //
  //   - 가는 동안의 보고는 움직임으로만 센다(`onScroll`). 기하는 그대로 적는다.
  //   - `JUMP_SETTLE_MS` 동안 움직임이 없으면 이동이 끝난 것이다. 움직이지 않은
  //     착지도 요청 시각부터 같은 규칙으로 끝난다 — 보고가 오지 않는 절반이 그것이다.
  //   - 끝나면 **멈춘 자리에서**(`geometryRef`) 바닥을 다시 판정한다. 회복이 걸려 있는
  //     동안(다음 프레임에 다시 묻는 중)에는 끝나지 않는다 — 대략의 자리는 착지가 아니다.
  //   - 손가락·전송·「최신으로」·다른 점프·방 전환은 걸린 이동을 판정 없이 거둔다.
  //     그 뒤의 보고나 그 요청이 스스로 판정한다.
  //
  // **필은 판정이 날 때까지 그대로 둔다.** 점프는 따라가기만 붙든다 — 가는 동안 도착한
  // 메시지가 목록을 끌어내리면 안 되기 때문이다. 떠나자마자 「최신으로」를 세우면, 제자리
  // 착지는 그 필을 한 번 번쩍이고 거둔다. 멀리 가는 점프의 필은 착지하며 선다.
  const jumpTravelTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const recoveryFrameRef = useRef<number | undefined>(undefined);

  /** 걸린 이동을 판정 없이 거둔다. 다음 보고나 새 요청이 판정한다. */
  const cancelJumpTravel = useCallback(() => {
    if (jumpTravelTimerRef.current !== undefined) {
      clearInterval(jumpTravelTimerRef.current);
      jumpTravelTimerRef.current = undefined;
    }
    if (recoveryFrameRef.current !== undefined) {
      cancelAnimationFrame(recoveryFrameRef.current);
      recoveryFrameRef.current = undefined;
    }
    jumpTravelRef.current = null;
  }, []);

  /**
   * 이동이 끝났다 — 멈춘 자리에서 판정한다.
   *
   * 기하를 모르면(목록이 아직 한 번도 보고하지 않았다) 판정하지 않는다: 붙든 따라가기는
   * 그대로 두고, 핀이 풀렸으니 다음 보고가 판정한다. 모르는 것을 「바닥이 아니다」로
   * 말하면 필이 거짓을 말한다.
   *
   * **착지는 출발점이다**(R2 N-B). 점프가 진입의 몫을 가져간 방문은 진입 수렴이 없어
   * 드래그·필·전송 없이는 「앉음」이 오지 않았고, 드래그하지 않는 VoiceOver 사용자는
   * 구분선을 보고도 래치가 안 걸려 위 필이 다시 섰다. R1 이 점프 순간에 앉히지 않은
   * 이유 — 애니메이션 중 지나가는 구분선 보고가 래치를 건다 — 는 이동이 끝난 지금은
   * 없다. 창에 남은 행이 사람이 보는 것이다(`release` 와 같은 판단).
   */
  const endJumpTravel = useCallback(() => {
    const travel = jumpTravelRef.current;
    if (travel === null) return;
    cancelJumpTravel();
    const left = distanceToEnd(geometryRef.current);
    if (left !== null) noteFollowing(left <= FOLLOW_THRESHOLD_PX, travel.leftAtSeq);
    settleEntry();
    travel.onLanded?.();
  }, [cancelJumpTravel, noteFollowing, settleEntry]);

  /** 점프 하나가 떠난다. 앞선 이동은 판정 없이 거둔다 — 새 요청이 이긴다. */
  const beginJumpTravel = useCallback(
    (onLanded?: () => void) => {
      cancelJumpTravel();
      const now = Date.now();
      jumpTravelRef.current = {
        startedAt: now,
        lastMotionAt: now,
        recovering: false,
        leftAtSeq: newestSeqRef.current,
        onLanded,
      };
      // 따라가기만 붙든다 — 필은 판정이 날 때까지 그대로다(위 머리말).
      followingRef.current = false;
      jumpTravelTimerRef.current = setInterval(() => {
        const travel = jumpTravelRef.current;
        if (travel === null) return;
        const at = Date.now();
        if (at - travel.startedAt >= JUMP_TRAVEL_MAX_MS) {
          endJumpTravel();
          return;
        }
        if (travel.recovering) return;
        if (at - travel.lastMotionAt >= JUMP_SETTLE_MS) endJumpTravel();
      }, CONVERGE_ROUND_MS);
    },
    [cancelJumpTravel, endJumpTravel],
  );

  // ===========================================================================
  // 끝까지 데려가는 일 하나 (goal RN-P3 · RN-B4a/#1025)
  //
  // 아래 루프는 원래 **전송**만을 위한 것이었다. #1025 가 밝힌 것은 **진입**이 같은
  // 물리에 걸려 있다는 사실이다 — 성재: *"채널에 진입을 하면 제일 하단으로 이동해야
  // 하는데, 왜 자꾸 상단 어중간한 부분에서 진입되는 거야?"*
  //
  // 진입 시점의 리스트는 첫 배치(기본 10행)만 측정돼 있고, 헤더에 적어 둔 대로
  // `VirtualizedList` 는 tail spacer 를 측정된 데까지로 **자른다**. 그래서 최초
  // `scrollToEnd` 는 「지금까지 측정된 끝」에 착지하고, 그 자리는 긴 대화의 위쪽
  // 어딘가다 — 어중간한 그 자리. 리스트는 착지한 자리에서 다음 배치를 재고 콘텐츠가
  // 자란다. 그 `onContentSizeChange` 가 두 번째 기회이고, 두 가지가 그것을 죽이고
  // 있었다:
  //
  //   1. 두 번째 호출은 `animated: !converging` = **활강**이었다. 활강의 중간 지점은
  //      새 끝에서 한 배치(≈600pt)만큼 떨어져 있고 임계값은 120pt 다. 그 스크롤
  //      이벤트 하나가 `following` 을 끄고, 그 뒤로는 아무도 데려가지 않는다.
  //   2. 자란 콘텐츠를 실은 스크롤 이벤트도 똑같이 읽힌다 — 오프셋은 그대로인데
  //      `contentSize` 만 커졌으니 「끝에서 멀어졌다」가 되고, 사람은 손도 대지 않았다.
  //
  // 전송이 이미 답을 갖고 있었다: 보정이 도는 동안 스크롤에 **핀**을 걸고, 즉시
  // (비애니메이션) 라운드를 도착할 때까지 돌리고, 그동안만
  // `maintainVisibleContentPosition` 을 뗀다. 그래서 그 기계를 이름 있는 함수로 꺼내
  // 진입도 같이 쓴다. 진입은 언제나 `near=false` 로 들어간다 — 진입 시점의
  // 「가깝다」는 잘린 콘텐츠 높이가 하는 거짓말이고(뷰포트를 아직 못 재었으면 거리는
  // 아예 `null` 이라 「가깝다」로 접힌다), 그 거짓말을 믿은 것이 결함 그 자체였다.
  //
  // **읽던 위치 복원 정책은 이 코드에 없다**(#1025 진단 결과): `lastReadSeq` 는 안 읽은
  // 구분선을 그리는 데만 쓰이고, 진입 앵커는 처음부터 「최신(하단)」 하나였다. 그러니
  // 이 수리는 정책 충돌이 아니라 **원래의 의도가 물리에 져 있던 것**의 복구다.
  // ===========================================================================
  const convergeFrameRef = useRef<number | undefined>(undefined);
  const convergeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const cancelConvergence = useCallback(() => {
    if (convergeFrameRef.current !== undefined) {
      cancelAnimationFrame(convergeFrameRef.current);
      convergeFrameRef.current = undefined;
    }
    if (convergeTimerRef.current !== undefined) {
      clearTimeout(convergeTimerRef.current);
      convergeTimerRef.current = undefined;
    }
    convergingRef.current = false;
  }, []);

  const convergeToEnd = useCallback(
    (mode: 'entry' | 'send' | 'latest') => {
      cancelConvergence();
      // A new travel supersedes a focus still waiting for an earlier landing, and
      // a jump still on its way — without a verdict: this travel sets its own.
      cancelFocus();
      cancelJumpTravel();
      // Following again, because they are now at the bottom on purpose — the next
      // arrival from anyone else should keep them there. Through the one door, so
      // the 「최신으로」 pill steps down in the same moment (#1892).
      noteFollowing(true);
      const startedAt = Date.now();
      const hardStop = startedAt + CONVERGE_MAX_MS;
      /** Extended on every round that gets somewhere; see `CONVERGE_IDLE_MS`. */
      let idleStop = startedAt + CONVERGE_IDLE_MS;
      /**
       * The furthest down this correction has reached, as a scroll OFFSET.
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
      scrollPinUntilRef.current = idleStop;

      // Near the tail there is no clamp to climb and the glide that shipped is
      // right. `null` — a list that has never scrolled or been laid out — counts
      // as near: it has no history to be lost in. **Entry is never near**, for the
      // reason in the note above.
      //
      // `latest` is the 「최신으로」 pill (#1892): the same travel as a send, and
      // the one of the three a person asked for by pressing something — so it is
      // the one that honours 「동작 줄이기」, as the web jump does
      // (`timelineScrollBehavior`). Far away it is instant rounds already.
      const distance = distanceToEnd(geometryRef.current);
      const near =
        mode !== 'entry' &&
        (distance === null || distance <= geometryRef.current.viewportHeight);
      const glide = near && !(mode === 'latest' && reduceMotionRef.current);
      convergingRef.current = !near;
      // Off for the correction, back on the moment it ends.
      if (!near) setChasingTail(true);

      /**
       * One hop toward the end.
       *
       * `latest` aims at the content the scroll view actually holds, not at the
       * list's estimate of where the data ends (#1892, measured below). The
       * other two keep `scrollToEnd`, for the reason in the round's comment —
       * this change is scoped to the travel that had to be made to land.
       */
      const hop = (animated: boolean) => {
        const geometry = geometryRef.current;
        if (
          mode === 'latest' &&
          geometry.contentHeight > 0 &&
          geometry.viewportHeight > 0
        ) {
          listRef.current?.scrollToOffset({offset: contentEnd(geometry), animated});
          return;
        }
        listRef.current?.scrollToEnd({animated});
      };

      /**
       * 「최신으로」 lands and STAYS landed (#1892).
       *
       * Measured on the simulator (iOS 26.5, `measure/` JUMP-PILLS, the offset
       * trace printed on the capture): the hop landed exactly on the end
       * (2463 over content 3062 in a 599 window) and 50ms later — after this
       * loop had already released — the offset moved to 2878, 415pt past the
       * end, and stayed there: a blank list. From the unread line the same
       * travel came to rest 1412pt past the end. Nothing in this file scrolled
       * it; the only thing that changes the offset without being asked is
       * `maintainVisibleContentPosition` coming back on at release and applying
       * an anchor recorded before the jump. The pill is a thing a person
       * presses and then looks at, so for a short while after arriving any
       * movement off the end that no finger made is put back.
       */
      const holdLanding = (firstTickAt: number) => {
        const until = firstTickAt + LANDING_HOLD_MS;
        scrollPinUntilRef.current = until;
        const tick = () => {
          const geometry = geometryRef.current;
          const left = distanceToEnd(geometry);
          if (left !== null && Math.abs(left) > ARRIVED_PX) {
            listRef.current?.scrollToOffset({
              offset: contentEnd(geometry),
              animated: false,
            });
          }
          if (Date.now() >= until) {
            scrollPinUntilRef.current = 0;
            return;
          }
          convergeTimerRef.current = setTimeout(tick, CONVERGE_ROUND_MS);
        };
        convergeTimerRef.current = setTimeout(
          tick,
          Math.max(0, firstTickAt - Date.now()),
        );
      };

      const release = (arrived: boolean) => {
        convergingRef.current = false;
        setChasingTail(false);
        // Hand the scroll back at once rather than at the deadline: the list is
        // where the correction wanted it, so the ordinary rule ("far from the end
        // means the reader is reading") is true again and should apply again.
        scrollPinUntilRef.current = 0;
        // And the list is where it was going to rest, so what is on screen now is
        // what the reader sees (#1892 — the latch waits for exactly this).
        settleEntry();
        if (mode !== 'latest') return;
        if (arrived) holdLanding(Date.now() + CONVERGE_ROUND_MS);
        // The pill that had VoiceOver's focus is gone; the row it brought the
        // reader to takes it (#1892 R1 M-3). When the travel could not finish
        // (R2 N-C) that row is still where the reader asked to go, and focusing
        // it has VoiceOver scroll the rest of the way — if it is mounted. When it
        // is not, the lowest row on screen takes the focus rather than nothing.
        const newest = lastMessageId(itemsRef.current);
        const mounted =
          newest !== null && rowNodesRef.current.has(newest.toLowerCase());
        focusRow(
          arrived || mounted ? newest : lastVisibleMessageId() ?? newest,
          0,
        );
      };

      const converge = () => {
        const now = Date.now();
        const geometry = geometryRef.current;
        const left = distanceToEnd(geometry);
        // **Past the end is never a resting place** (#1892). The round below
        // used to read any `left <= 1` as arrival, including a negative one,
        // and "arrived" at 415pt past the content is a blank list. So an
        // overshoot is brought back to the content the scroll view holds, and
        // the loop goes on to judge from there.
        //
        // **This is an after-the-fact correction, not the cause** (design-review
        // 2594 R1 M-2). A JS `scrollTo` IS clamped natively
        // (`RCTScrollViewComponentView.mm` `scrollTo:y:animated:`). What writes
        // an offset past the end without clamping is `maintainVisibleContentPosition`
        // coming back on: while the prop is off the scroll view records no new
        // anchor, and the first transaction after it returns applies the anchor
        // recorded BEFORE the travel straight to `contentOffset`
        // (`_adjustForMaintainVisibleContentPosition`). That is where the blank
        // list comes from, it also follows a far entry and a far send when they
        // release, and fixing it at its source — so that the stale anchor is
        // never applied — is #2588's to decide, together with #2586. Until then
        // this branch and `holdLanding` put the list back after it was shoved.
        const overshot = left !== null && left < -ARRIVED_PX;
        if (overshot) {
          listRef.current?.scrollToOffset({
            offset: contentEnd(geometry),
            animated: false,
          });
        }
        if (now >= idleStop || now >= hardStop) {
          // Out of road. `following` is NOT forced here — whatever the next
          // scroll event says about where the reader ended up is now the truth,
          // including "still far from the end", which is the honest reading of a
          // correction that could not finish.
          release(false);
          return;
        }
        if (geometry.offsetY > furthest + PROGRESS_PX) {
          furthest = geometry.offsetY;
          idleStop = Math.min(now + CONVERGE_IDLE_MS, hardStop);
          scrollPinUntilRef.current = idleStop;
        }
        if (!overshot && left !== null && left <= ARRIVED_PX) {
          release(true);
          return;
        }
        // `scrollToEnd` rather than an offset computed from `geometryRef`: the
        // list's own metrics are live, ours are one scroll event behind, and a
        // stale content height would ask the list to scroll BACKWARDS. Its
        // estimate overshoots the clamped content end (it estimates the DATA
        // end) — and when the scroll view does not clamp it, the branch above
        // brings it back. (`latest` aims at the held content instead; `hop`.)
        if (!overshot) hop(false);
        convergeTimerRef.current = setTimeout(converge, CONVERGE_ROUND_MS);
      };

      // The first hop still waits a frame. For a send: the token and the echo row
      // arrive in the same commit, and an offset computed before that row has a
      // height is computed against the list as it was. For entry: the caller has
      // already asked once, synchronously — a channel must never be seen
      // travelling to its own bottom — and this is the round after that one.
      convergeFrameRef.current = requestAnimationFrame(() => {
        convergeFrameRef.current = undefined;
        hop(glide);
        if (near) {
          settleEntry();
          // A glide takes UIKit's ~300ms; the hold starts once it is down, and
          // so does the focus move (#1892 R1 M-3) — VoiceOver focusing a row
          // that is still gliding would scroll it a second time.
          if (mode === 'latest') {
            const landedAfter = glide ? GLIDE_SETTLE_MS : CONVERGE_ROUND_MS;
            holdLanding(Date.now() + landedAfter);
            focusRow(lastMessageId(itemsRef.current), landedAfter);
          }
          return;
        }
        converge();
      });
    },
    // `reduceMotionRef` is one ref object for the life of the mount (a hook's
    // `useRef`); listing it costs nothing and keeps the linter honest.
    [
      cancelConvergence,
      cancelFocus,
      cancelJumpTravel,
      focusRow,
      lastVisibleMessageId,
      listRef,
      noteFollowing,
      reduceMotionRef,
      settleEntry,
    ],
  );

  // A correction still running when this list goes away is a timer holding a ref
  // to a scroll view that no longer exists. Same for a focus move still waiting.
  useEffect(
    () => () => {
      cancelConvergence();
      cancelFocus();
      cancelJumpTravel();
    },
    [cancelConvergence, cancelFocus, cancelJumpTravel],
  );

  // 방이 바뀌면 앞 방의 이동도 이 방의 일이 아니다 (#1892 R1 H-1). 전송의 끝 쫓기나
  // 「최신으로」의 착지 유지가 돌고 있으면 새 방의 목록을 바닥으로 끌고, 걸린 초점은
  // 앞 방의 행을 찾는다. 판정 자체는 렌더 중에 이미 새로 했다(`judgedChannel`).
  // 방이 하나뿐인 표면에서는 마운트 때 한 번 돌고 거둘 것이 없다.
  useEffect(() => {
    cancelConvergence();
    cancelFocus();
    cancelJumpTravel();
    scrollPinUntilRef.current = 0;
    setChasingTail(false);
  }, [channelId, cancelConvergence, cancelFocus, cancelJumpTravel]);

  /**
   * A finger on the glass ends the correction's claim immediately.
   *
   * The pin has a deadline so that a stuck correction cannot hold the list
   * forever, but a deadline is a guess about intent and this is not: someone
   * dragging the list is telling us where they want to be, and neither a send
   * from a second ago nor a channel opened a moment ago gets to argue.
   */
  const onScrollBeginDrag = useCallback(() => {
    cancelConvergence();
    // The reader has taken the list; a focus move queued by a jump would pull
    // VoiceOver back to where they are leaving (#1892 R1 M-3).
    cancelFocus();
    // And a jump still on its way is theirs to end — including the recovery's
    // next round, which would otherwise move the list under the finger and take
    // the verdict back for itself (R2 N-A). Their own scroll events judge next.
    cancelJumpTravel();
    scrollPinUntilRef.current = 0;
    convergingRef.current = false;
    // The reader has the list now. Whatever it shows from here on, they are
    // looking at (#1892 latch).
    settleEntry();
    // 착지 표시도 여기서 물러난다 (#1076). 그것을 세운 것이 사람의 동작(점프)이
    // 었으므로 거두는 것도 사람의 동작이다 — 타이머가 아니라. 이유는
    // `MessageRow` 의 `rowLanded` 주석에 있다: 폰의 점프는 애니메이션이고,
    // 목표 행이 아직 안 측정됐으면 한 번 더 도므로, 시한은 이동과 경주한다.
    setLandedId(null);
    // And the prepend correction comes straight back: the reader taking the list
    // is the likeliest prelude to them scrolling UP into history, which is the
    // one thing that must never move under them.
    setChasingTail(false);
  }, [cancelConvergence, cancelFocus, cancelJumpTravel, settleEntry]);

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
        // Not the length of `items`: a working placeholder or a pending echo is a
        // row with no message behind it, and on the render where the room
        // changes `messages` is still the previous room's (#1892 R1 H-1). The
        // anchor waits for THIS room's messages.
        if (!holdsChannelContentRef.current) return;
        didInitialScrollRef.current = true;
        // Instant and now, so the channel is simply AT its newest message rather
        // than seen arriving there…
        listRef.current?.scrollToEnd({animated: false});
        // …and then kept asking, because this one call lands on a content end the
        // list is holding short of the data. See the note above `convergeToEnd`:
        // this is the whole of #1025.
        convergeToEnd('entry');
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
    [convergeToEnd, listRef, noteGeometry],
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
  // above `CONVERGE_IDLE_MS`. From mid-history the offset `scrollToEnd` computes
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
    convergeToEnd('send');
  }, [selfSendToken, convergeToEnd]);


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

  // ---- 두 필이 데려가는 곳 (#1892) ------------------------------------------
  //
  // 위 필은 **구분선을 창 맨 위에** 놓는다(웹 `align: "start"`). 경계 아래부터 읽어
  // 내려가는 동작이라, 가운데에 놓으면 이미 읽은 줄이 화면의 절반을 먹는다.
  //
  // 누르는 것 자체가 진입이다 — 목록이 도착해 구분선이 보고되기를 기다리지 않고 그
  // 자리에서 래치를 건다(웹과 같다). 걸려 있던 수렴은 거둔다: 진입이나 전송의 끝
  // 쫓기가 남아 있으면 방금 올려 보낸 목록을 다시 바닥으로 끌어내린다.
  //
  // 화면을 보지 않는 사람에게는 **도착한 행으로 초점을 옮긴다** — 구분선 아래 첫
  // 메시지, 웹 `jumpToUnread` 와 같은 행이다(R1 M-3). 첫 판은 구분선의 문장을
  // 낭독했는데, 그 낭독은 초점을 쥔 필이 사라지는 바로 그 순간에 나가 VoiceOver 가
  // 초점을 다시 잡으며 끊을 수 있었고, 「최신으로」는 아무것도 하지 않아 두 필이
  // 스크린리더 사용자를 다르게 대했다. 이제 둘 다 같은 한 가지를 한다.
  const jumpToUnread = useCallback(() => {
    const index = itemsRef.current.findIndex(item => item.kind === 'unread');
    if (index < 0) return;
    latchNoteRef.current = 'pressed';
    setUnreadLatched(true);
    entrySettledRef.current = true;
    cancelConvergence();
    cancelFocus();
    scrollPinUntilRef.current = 0;
    setChasingTail(false);
    // 가는 동안의 자리는 사람의 것이 아니다 — 인용 점프와 같은 이동이다(R1 M-1).
    // 멈추면 착지한 자리에서 바닥을 다시 판정하고(R2 H-A — 안읽음 묶음이 한 화면보다
    // 조금 길면 끝 근처에 앉는다), 그때 초점을 옮긴다: 움직이는 행에 초점을 주면
    // VoiceOver 가 한 번 더 스크롤한다.
    const focusTarget = firstMessageIdAfter(itemsRef.current, index);
    beginJumpTravel(() => focusRow(focusTarget, 0));
    scrollViewPositionRef.current = 0;
    listRef.current?.scrollToIndex({
      index,
      viewPosition: 0,
      animated: !reduceMotionRef.current,
    });
  }, [
    beginJumpTravel,
    cancelConvergence,
    cancelFocus,
    focusRow,
    listRef,
    reduceMotionRef,
  ]);

  // 아래 필은 전송과 같은 여정이다 — 먼 과거에서 끝까지 가는 길은 RN-P3 가 이미
  // 닦았고(측정된 클램프를 오르는 즉시 라운드), 두 번째 길을 내면 그 수리를 다시
  // 벌어야 한다.
  const jumpToLatest = useCallback(() => {
    convergeToEnd('latest');
  }, [convergeToEnd]);

  // ---- 라이브로 온 인용을 화면에 있는 행에서 푼다 (ADR-0148) ----------------
  //
  // `message.new` 프레임에는 `reply_to` 가 없다 — outbox 행은 한 번 쓰이고 영원히
  // 재생되므로 본문을 실으면 그것이 곧 규칙 3 이 금지한 스냅샷이다. 그래서 코어의
  // `resolveQuote` 는 두 재료만 쓴다: 페이지가 동봉한 것, 아니면 **이미 여기 있는
  // 행**. 어느 쪽도 요청이 아니다.
  //
  // Map 을 한 번 만들고 행들이 공유한다: 행마다 `messages.find` 를 돌면 화면에
  // 50개 행이 있을 때 조회가 2500번이 되고, 그 값은 스크롤마다 다시 계산된다.
  // 키는 소문자 id 다 — 와이어가 대소문자를 섞어 보낸다(Swift `uuidString` 은
  // 대문자, 페이지 행은 소문자).
  const quoteLookup = useMemo(() => {
    const index = new Map<string, Message>();
    for (const message of messages) index.set(message.id.toLowerCase(), message);
    return (messageId: string) => index.get(messageId.toLowerCase());
  }, [messages]);

  // ADR-0155 — 끝난 것을 **본** run 들. 여기서 한 번 구독하고 행에는 boolean 하나만
  // 내려 보낸다. 행마다 구독하면 아무 run 이나 끝날 때 붙어 있는 모든 줄이 다시
  // 그려진다.
  const endedRuns = useEndedRuns();

  const renderItem = useCallback(
    ({item}: {item: FoldedTimelineItem}) => {
      renderItemCalls += 1;
      if (item.kind === 'day') return <DayDivider atMs={item.atMs} nowMs={nowMs} />;
      if (item.kind === 'unread') return <UnreadDivider count={item.count} />;
      if (item.kind === 'recovery') {
        return <RecoveryDivider seq={item.seq} source={item.source} />;
      }
      if (item.kind === 'working') {
        return <WorkingRow memberId={item.memberId} directory={directory} />;
      }
      if (item.kind === 'pending') {
        return (
          <PendingRow
            pending={item.pending}
            startsGroup={item.startsGroup}
            directory={directory}
            quote={resolveQuote(
              {replyToId: item.pending.replyToId},
              quoteLookup,
            )}
            quoteAttachmentCount={
              item.pending.replyToId
                ? quoteLookup(item.pending.replyToId)?.attachments?.length ?? 0
                : 0
            }
            onResend={onResendPending}
          />
        );
      }
      const row = (
        <MessageRow
          message={item.message}
          startsGroup={item.startsGroup}
          directory={directory}
          chips={chipsFor(reactions ?? NO_REACTIONS, item.message.id, myMemberId)}
          pinned={isPinned(pins ?? NO_PINS, item.message.id)}
          pausedRepeat={item.pausedRepeat}
          deletedRepeat={item.deletedRepeat}
          landed={landedId !== null && uuidEq(item.message.id, landedId)}
          nowMs={nowMs}
          onResend={onResend}
          actions={actions}
          // `null` 은 "이 표면에는 롤업이 없다"이고 `undefined` 였다면 행이 서버의
          // 롤업으로 되돌아간다 — 끄려는 자리에서 정확히 반대가 된다.
          rollup={showRollup ? rollupFor(item.message, threads) : null}
          // `undefined` turns the marker off for the whole surface. A thread
          // panel passes `markReplies={false}`: every row in there is a reply,
          // and a 답글 line on each would be noise wearing the shape of
          // information.
          replyParent={
            markReplies ? parentOf(item.message, threads) : undefined
          }
          quote={resolveQuote(item.message, quoteLookup)}
          quoteAttachmentCount={
            item.message.replyToId
              ? quoteLookup(item.message.replyToId)?.attachments?.length ?? 0
              : 0
          }
          approvalGates={approvalGates}
          approvalReceipts={approvalReceipts}
          approvalOffline={approvalOffline}
          approvalsProvided={approvalsProvided}
          onApprovalSettled={onApprovalSettled}
          runEnded={isStreamRunEnded(item.message, endedRuns)}
          // 필이 착지한 행에 초점을 줄 때만 읽는다(R1 M-3). 필이 없는 표면에서는
          // 모을 이유가 없다.
          registerRowNode={jumpPills ? registerRowNode : undefined}
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
      pins,
      myMemberId,
      nowMs,
      onResend,
      onResendPending,
      actions,
      anchorSeq,
      anchorRef,
      landedId,
      threads,
      markReplies,
      showRollup,
      quoteLookup,
      // 승인 표가 바뀌면 `renderItem` 의 동일성도 바뀌어야 한다 — 안 그러면
      // 결정한 뒤에도 목록이 옛 표를 든 클로저를 계속 쓴다. 붙어 있는 행이
      // 전부 다시 그려지는 값이지만 승인은 드물고, 대안은 결정이 화면에
      // 반영되지 않는 것이다.
      approvalGates,
      approvalReceipts,
      approvalOffline,
      approvalsProvided,
      onApprovalSettled,
      endedRuns,
      // 둘 다 마운트 동안 바뀌지 않는다(`jumpPills` 는 규약, 등록 함수는 빈 의존성).
      jumpPills,
      registerRowNode,
    ],
  );

  // ---- 인용이 가리키는 줄로 이동 (ADR-0148) ---------------------------------
  //
  // 새 앵커 기계를 만들지 않는다: 목적지는 **이 목록이 이미 들고 있는 항목**이고,
  // 없으면 없다고 말한다. 웹은 행이 나타나기를 기다리는 워처를 두지만, 그것이
  // 성립하는 이유는 웹이 위로 자동으로 더 불러오기 때문이다. 이 목록은 사람이
  // 끌어올려야 더 불러오므로, 기다리는 워처는 영영 안 오는 행을 기다린다 —
  // 그 자리에서 「더 위쪽에 있습니다」라고 말하는 편이 정직하고, 그 말이 곧 사람이
  // 해야 할 동작(위로 끌어올리기)을 알려 준다.
  const jumpToken = jumpTarget?.token;
  useEffect(() => {
    if (jumpTarget === undefined) return;
    let index = items.findIndex(
      item =>
        item.kind === 'message' && uuidEq(item.message.id, jumpTarget.messageId),
    );
    // ## 접힌 묘비는 자기 행이 없다 (design-review H-1)
    //
    // 삭제 원본을 가리키는 인용은 문이다(`QuoteBlock` 의 `jumpable` 은 `deleted` 를
    // 배제하지 않는다 — 지워진 것도 **어디서** 지워졌는지는 볼 수 있어야 한다).
    // 그런데 그 원본이 연속 묘비 묶음 안에 있으면 `foldDeletedRuns` 가 앞선 행으로
    // 접어 넣으므로 위의 `findIndex` 는 빈손으로 돌아온다. 그 자리에서 아래 고지가
    // 뜨면 화면은 「위로 올려 이전 대화를 더 불러오세요」라고 **거짓 지시**를 한다 —
    // 그 메시지는 이미 로드돼 있고 접혀 있을 뿐이다.
    //
    // 그래서 접기가 적어 둔 것을 한 번 더 본다. 착지 지점은 그 묘비를 **대신해 서
    // 있는 행**이고, 그 행은 「삭제된 메시지 N개」라고 자기가 무엇을 포함하는지
    // 말한다. 왜 이쪽이고 「인용된 묘비는 접지 않는다」가 아닌지는 코어
    // `features/timeline/deletedFold.ts` 머리말에 적혀 있다 — **승격이 되돌려서는
    // 안 되는 자리**로 거기에 다시 못박혀 있고(#1105 인계), 이 줄이 그 계약의
    // 폰 쪽 소비처다.
    if (index < 0) index = foldedStandInIndex(items, jumpTarget.messageId);
    if (index < 0) {
      // 로드된 범위의 가장 오래된 seq 보다 위면 그것은 **사실**이다.
      const oldest = items.reduce(
        (min, item) =>
          item.kind === 'message' ? Math.min(min, item.message.seq) : min,
        Number.POSITIVE_INFINITY,
      );
      onJumpMissed?.(
        jumpTarget.seq !== null && jumpTarget.seq < oldest ? 'older' : 'unknown',
      );
      return;
    }
    // 이동은 **따라가기를 끈다**. 안 끄면 다음 메시지 한 통에 맨 아래로 되돌아가고,
    // 사람은 자기가 방금 연 자리를 잃는다.
    //
    // 걸려 있던 끝 쫓기도 거둔다 (#1892). 방금 보낸 전송의 수렴이나 「최신으로」의
    // 착지 유지가 아직 돌고 있으면, 사람이 방금 가리킨 줄에서 목록을 도로 바닥으로
    // 끌어내린다 — 새 요청이 앞선 요청을 이긴다.
    cancelConvergence();
    cancelFocus();
    scrollPinUntilRef.current = 0;
    setChasingTail(false);
    // 그리고 가는 동안은 이 점프가 판정을 쥐고, 멈추면 착지한 자리에서 다시 판정한다
    // (`beginJumpTravel`). 끝 근처에 앉으면 따라가기로 돌아오고(R2 H-A), 멀리 앉으면
    // 그때 「최신으로」가 선다.
    beginJumpTravel();
    // **이 점프가 방의 진입이다** (#1892 R1 M-1). 다른 방으로 가는 착지(ADE
    // 「대화로」·알림 탭)는 새 방의 목록이 도착한 뒤 걸리고, 그 순간이 새 목록의 첫
    // `onContentSizeChange` 보다 앞설 수 있다 — 네이티브 레이아웃 보고와 효과의 순서는
    // 약속되지 않는다. 앞서면, 뒤따라온 그 보고가 진입 앵커를 태워 방금 데려간 줄에서
    // 목록을 바닥으로 끌어내리고, 착지 틴트는 화면 밖 행에 걸린다. 그래서 착지하는
    // 점프가 진입의 몫을 가져간다. 늦게 온 보고는 따라가기가 꺼져 있어 아무것도 하지
    // 않는다. 반대 순서(진입이 먼저 달리는 중)는 바로 위의 `cancelConvergence` 가
    // 거둔다.
    //
    // 출발점에 **앉혔다고** 하지는 않는다(`settleEntry`). 애니메이션 이동 중의 보이는
    // 행 보고는 지나가는 구분선을 「창 안」이라고 한 번 말할 수 있고, 그 한 번에
    // 래치가 걸리면 새 방의 위 필이 끝내 서지 않는다 — 진입 스윕과 같은 모양이다.
    didInitialScrollRef.current = true;
    // 도착했으므로 「못 찾았습니다」 고지는 물러난다 (design-review H-5).
    onJumpLanded?.();
    // 「방금 여기로 왔다」 (#1076). 가운데로 옮겨 놓는 것만으로는 **어느 줄이
    // 원본인지**를 사람이 다시 찾아야 한다 — 밀집한 타임라인에서 가운데는
    // 좌표이지 표시가 아니다. 색과 사라짐 규칙의 근거는 `MessageRow` 의
    // `rowLanded` 주석에 있다.
    //
    // 표시를 **먼저** 세우고 스크롤한다. 반대로 두면 이동이 실패해
    // (`onScrollToIndexFailed` 회복 경로) 두 프레임 뒤에 앉는 동안 표시가 없는
    // 창이 생기고, 그 창에서 사람이 보는 것은 표시 없이 움직이는 화면이다.
    //
    // 표시는 **착지한 행**의 것이다. 목적지 id 를 그대로 쓰면 접힌 묘비로 간 경우
    // (H-1) 화면에 없는 id 에 틴트를 걸게 되고, 사람은 움직이기만 하고 아무것도
    // 켜지지 않는 화면을 본다.
    const landing = items[index];
    setLandedId(
      landing?.kind === 'message' ? landing.message.id : jumpTarget.messageId,
    );
    // 화면 가운데에 놓는다: 인용의 원본은 그 앞뒤가 함께 읽혀야 뜻이 산다.
    // 「동작 줄이기」면 즉시다 — 두 필과 같은 규율이다(R1 N-4). 이 클라에서 점프가
    // 움직임을 거르는 자리가 둘이면 같은 설정이 버튼마다 다르게 듣는다.
    scrollViewPositionRef.current = 0.5;
    listRef.current?.scrollToIndex({
      index,
      viewPosition: 0.5,
      animated: !reduceMotionRef.current,
    });
  }, [jumpToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScrollToIndexFailed = useCallback(
    (info: {index: number; averageItemLength: number}) => {
      // `getItemLayout` 이 없는 목록에서 아직 측정되지 않은 행을 겨누면 여기로
      // 온다. RN 이 권하는 회복 그대로: 대략의 자리로 한 번 밀어 두면 그 행이
      // 마운트되고, 다음 프레임에 정확히 앉는다. 실패를 삼키지 않는 이유는
      // 삼키면 「눌렀는데 아무 일도 안 일어남」이 되기 때문이다.
      //
      // 회복은 **걸린 이동의 일부**다(`beginJumpTravel`). 대략의 자리는 새 목록에서 흔히
      // 재어 둔 행들의 끝으로 clamp 되고 — 그 자리는 착지가 아니다 — 그래서 다시 묻는
      // 동안 이동은 끝나지 않는다. 걸린 이동이 없으면(손가락이나 새 요청이 거뒀다)
      // 아무것도 하지 않는다: 회복의 다음 라운드가 사람 손 밑에서 목록을 옮기면 안
      // 된다(R2 N-A).
      const travel = jumpTravelRef.current;
      if (travel === null) return;
      travel.recovering = true;
      travel.lastMotionAt = Date.now();
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: false,
      });
      if (recoveryFrameRef.current !== undefined) {
        cancelAnimationFrame(recoveryFrameRef.current);
      }
      recoveryFrameRef.current = requestAnimationFrame(() => {
        recoveryFrameRef.current = undefined;
        if (jumpTravelRef.current !== travel) return;
        travel.recovering = false;
        travel.lastMotionAt = Date.now();
        listRef.current?.scrollToIndex({
          index: info.index,
          // 실패하기 전 그 요청이 원한 자리 — 인용은 가운데, 안읽음 필은 위 (#1892).
          viewPosition: scrollViewPositionRef.current,
          animated: false,
        });
      });
    },
    [listRef],
  );

  const keyExtractor = useCallback((item: FoldedTimelineItem) => item.key, []);

  /**
   * `renderItem` 이 닫아 잡은 값들 중 **셀이 다시 그려져야 하는 것**.
   *
   * `anchorSeq` 하나였을 때의 이유는 아래 `extraData` 주석에 있다. `landedId` 가
   * 같은 종류로 하나 더 붙는다 — 착지 표시를 세우고 거두는 두 순간에 붙어 있는
   * 셀들이 새 클로저를 봐야 한다. `useMemo` 로 감싸는 이유는 `VirtualizedList` 가
   * 이 값을 **동일성**으로 비교하기 때문이다: 인라인 객체는 매 렌더 새것이 되고,
   * 그러면 이 목록은 「아무것도 안 바뀌었다」를 말할 방법을 잃는다.
   */
  const extraData = useMemo(
    () => ({anchorSeq, landedId}),
    [anchorSeq, landedId],
  );

  // ---- 목록의 머리와 꼬리는 **엘리먼트**이므로 동일성이 값이다 ----------------
  //
  // 이 둘을 JSX 안에 인라인으로 두면 `Timeline` 이 다시 그려질 때마다 새 엘리먼트가
  // 되고, `FlatList` 의 `PureComponent` 비교는 거기서 언제나 실패한다. 즉 이 목록은
  // "무엇 하나 바뀌지 않았다"를 말할 방법이 없었다. 머리는 자기가 그리는 세 값에만,
  // 꼬리는 아무것에도 매이지 않는다.
  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        {loadingOlder ? (
          <ActivityIndicator color={palette.accentText} />
        ) : reachedStart && items.length > 0 ? (
          <Text style={styles.headerLabel}>대화의 시작입니다.</Text>
        ) : null}
      </View>
    ),
    // 스킴이 바뀌면 `styles` 는 **다른 객체**가 되고, 그때 이 메모도 다시 계산되어야
    // 한다 (U2). `useStyles` 의 캐시가 (팩토리 × 스킴) 당 하나이므로 같은 스킴이
    // 이어지는 동안 이 참조는 변하지 않고, 메모는 스킴이 실제로 바뀔 때만 깨진다.
    [loadingOlder, reachedStart, items.length, palette, styles],
  );

  // 정리(cleanup) 형식의 ref — `renderItem` 안의 앵커 래퍼와 같은 이유다: 떼어내는
  // 쪽이 자기가 붙인 노드를 이름으로 지목해야 남의 것을 지우지 않는다.
  const tailNodeRef = useCallback(
    (node: View | null) => {
      if (!tailRef) return undefined;
      tailRef.current = node;
      return () => {
        if (tailRef.current === node) tailRef.current = null;
      };
    },
    [tailRef],
  );

  const listFooter = useMemo(
    () => (
      // The always-answerable seam. `collapsable={false}` unconditionally, and
      // the harness measures the SAME node the app renders: a footer that only
      // becomes measurable when someone is measuring is a footer whose position
      // was never the app's.
      <View ref={tailNodeRef} collapsable={false} style={styles.footer} />
    ),
    [tailNodeRef, styles],
  );

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

  const list = (
    <FlatList
      // 새 방의 행은 새 스크롤뷰가 받는다 — `listRoomRef` 주석(R1 H-1 실측).
      key={listKey}
      ref={listRef}
      testID="timeline-list"
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      onScrollToIndexFailed={onScrollToIndexFailed}
      // See `CONTENT_ALIGNMENT`: a conversation shorter than the screen packs to
      // the bottom, because the keyboard lifts this list's top edge out of sight.
      contentContainerStyle={CONTENT_ALIGNMENT}
      // `renderItem` closes over these, and a `FlatList` cell will happily keep
      // rendering with a stale closure otherwise. The measurement seam found
      // this the hard way: moving `anchorSeq` to another row left the wrapper on
      // the old one, so the harness measured nothing and reported it as a
      // failure of the thing it was measuring.
      extraData={extraData}
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
      // #1892: where the unread line is, measured by the list itself. Both are
      // fixed for the life of the mount — `FlatList` refuses a callback that
      // changes on the fly, which is why `jumpPills` may not change either.
      onViewableItemsChanged={jumpPills ? onViewableItemsChanged : undefined}
      viewabilityConfig={jumpPills ? PILL_VIEWABILITY : undefined}
      onStartReached={reachedStart ? undefined : onStartReached}
      onStartReachedThreshold={0.5}
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
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

  // Surfaces without the pills keep the list as the direct child they always had
  // — the harness and the thread panel render exactly what they rendered before.
  if (!jumpPills) return list;

  return (
    // 필은 목록 **안에** 산다(웹 `relative h-full` 과 같은 자리). 그 줄이 가리키는
    // 곳도, 눌렀을 때 움직이는 것도 이 스크롤러다. 떠 있으므로 목록의 배치는 한
    // 픽셀도 바뀌지 않는다 — `measure/` 의 앵커 이동 두 줄이 그것을 잰다.
    <View style={styles.pillFrame}>
      {list}
      {showJumpUnread ? (
        <JumpPillDock side="top">
          <JumpPill
            direction="up"
            testID="jump-unread"
            segments={jumpUnreadSegments(unreadJumpCount)}
            accessibilityLabel={jumpUnreadAccessibilityLabel(unreadJumpCount)}
            onPress={jumpToUnread}
          />
        </JumpPillDock>
      ) : null}
      {showJumpLatest ? (
        <JumpPillDock side="bottom">
          <JumpPill
            direction="down"
            testID="jump-latest"
            segments={jumpLatestSegments(newCount)}
            accessibilityLabel={jumpLatestAccessibilityLabel(newCount)}
            onPress={jumpToLatest}
          />
        </JumpPillDock>
      ) : null}
    </View>
  );
}

/**
 * 얕은 비교 하나로 충분한 이유.
 *
 * 이 컴포넌트의 prop 은 전부 **호출자가 이미 안정화해 들고 있는 값**이다 — 메시지
 * 배열과 반응 맵은 상태, 디렉터리·피어·대기행은 `useMemo`, 핸들러 넷은
 * `useCallback`. 그래서 값 비교를 따로 쓸 자리가 없고, 대신 이 memo 는 **턴이 열려
 * 있는 동안 초당 한 번 도는 `ConversationScreen` 의 렌더가 목록에 닿지 않게** 한다.
 * 그 시계는 활동 줄의 경과 숫자를 위한 것이고, 목록은 그 숫자와 아무 관계가 없다.
 *
 * 호출자가 인라인 화살표를 다시 넣으면 이 memo 는 조용히 아무것도 하지 않게 되므로,
 * 그것을 잠그는 것은 이 파일이 아니라 `__tests__/conversationRenders.test.tsx` 다.
 */
export const Timeline = React.memo(TimelineInner);
Timeline.displayName = 'Timeline';

const buildStyles = (color: Palette) => StyleSheet.create({
  header: {
    minHeight: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    alignItems: 'center',
  },
  headerLabel: {fontSize: font.meta, color: color.textFaint},
  footer: {height: space.sm},
  /** 필이 떠 있을 틀. 목록과 같은 자리·같은 크기다. */
  pillFrame: {flex: 1},
});
