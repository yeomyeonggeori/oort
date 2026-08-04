import { useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Channel, Message, RosterMember } from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import {
  buildTimelineItems,
  emptyChannelCopy,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineItem,
} from "@momo/core/features/timeline/model";
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
  type MessageRowActions,
} from "./MessageRow";
import { PendingRow } from "./PendingRow";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";

// =============================================================================
// Timeline (R-1 §3). Virtualised by react-virtuoso, ordered by seq only, with
// the derived render stream (day / unread / recovery markers) folded in by
// buildTimelineItems. The four states live here so the surface is never a bare
// blank area; offline is one banner above, owned by the shell.
// =============================================================================

// ---- virtualisation contract (R-1 §3: "firstItemIndex 조정으로 스크롤 점프 없이
// prepend") -------------------------------------------------------------------
//
// react-virtuoso only holds the row under the reader when `firstItemIndex`
// DECREASES by exactly the number of items inserted at the head, in the SAME
// commit that hands it the longer `data` array. Without that it treats the
// prepend as new content and the viewport jumps forward by a page.
//
// The shift cannot be "page size": `items` is the derived stream, so a 50
// message page can insert 51 items (a day separator moves in with it). So the
// shift is measured against the anchor row itself, the oldest message that was
// already on screen, by how far it moved.
const START_INDEX = 1_000_000;

/** Oldest message currently in the stream, with its position. */
function anchorOf(
  items: TimelineItem[]
): { seq: number; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "message") return { seq: item.message.seq, index: i };
  }
  return null;
}

function indexOfSeq(items: TimelineItem[], seq: number): number {
  return items.findIndex(
    (item) => item.kind === "message" && item.message.seq === seq
  );
}

interface AnchorState {
  /** Identity of the stream this index was computed for. */
  items: TimelineItem[];
  firstItemIndex: number;
  /** Bumped when the stream is replaced, to remount instead of shifting. */
  epoch: number;
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
  actions,
  reactions,
  onStartReached,
  onRetry,
  onOpenThread,
  onQuoteMessage,
  onJumpToMessage,
  onOpenWorkSession,
  onResend,
  onResendPending,
  onInviteMember,
  onStartWriting,
}: {
  messages: Message[];
  directory: Directory;
  status: "loading" | "ready" | "error";
  /** Decides what "empty" means here: a channel gains members, a DM cannot. */
  channelKind?: Channel["kind"];
  /** The other participant, for a DM. */
  peer?: RosterMember | null;
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes awaiting their seq; folded in at the tail (M10). */
  pending?: PendingMessage[];
  /**
   * B11 — what a row may do to its message. Omitted where the surface is a
   * transcript rather than a conversation (the work session event log), and the
   * rows there then render exactly as before.
   *
   * `chips` is filled per row from `reactions` below, so the caller hands over
   * the map once instead of deriving a list for every message in the channel.
   */
  actions?: Omit<MessageRowActions, "chips">;
  reactions?: ReactionMap;
  onStartReached?: () => void;
  onRetry?: () => void;
  onOpenThread?: (message: Message) => void;
  /** ADR-0148 - pin a row to the composer as a quote. */
  onQuoteMessage?: (message: Message) => void;
  /** Jump to a quoted original (the channel surface's existing anchor watcher). */
  onJumpToMessage?: (messageId: string, seq: number | null) => void;
  onOpenWorkSession?: (sessionId: string) => void;
  onResend?: (message: Message) => Promise<void> | void;
  onResendPending?: (clientMsgId: string) => Promise<void> | void;
  onInviteMember?: () => void;
  /** Put the caret in the composer: the only next step an empty DM has. */
  onStartWriting?: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);

  // ADR-0148 - 라이브로 도착한 인용 답글의 원본을 화면에 이미 있는 행에서 푼다.
  //
  // Map을 한 번 만들고 행들이 공유한다: 행마다 `messages.find`를 돌면 화면에 50개
  // 행이 있을 때 조회가 2500번이 되고, 그 값은 스크롤마다 다시 계산된다. 키는
  // 소문자 id다 - 와이어가 대소문자를 섞어 보낸다(Swift `uuidString`은 대문자,
  // 페이지 행은 소문자).
  const byId = useMemo(() => {
    const index = new Map<string, Message>();
    for (const message of messages) index.set(message.id.toLowerCase(), message);
    return index;
  }, [messages]);
  const quoteLookup = useMemo(
    () => (messageId: string) => byId.get(messageId.toLowerCase()),
    [byId]
  );

  const items = useMemo(
    () =>
      buildTimelineItems(messages, {
        lastReadSeq,
        unreadCount,
        recoveryMarkers,
        pending,
      }),
    [messages, lastReadSeq, unreadCount, recoveryMarkers, pending]
  );

  // Derived during render, not in an effect: virtuoso has to receive the new
  // `data` and the lowered `firstItemIndex` together or the correction lands a
  // frame late, which is exactly the jump it is meant to prevent. Keyed on the
  // `items` reference so a double render (StrictMode) cannot apply it twice.
  const anchorRef = useRef<AnchorState>({
    items: [],
    firstItemIndex: START_INDEX,
    epoch: 0,
  });
  if (anchorRef.current.items !== items) {
    const previous = anchorRef.current;
    const anchor = anchorOf(previous.items);
    const moved = anchor === null ? -1 : indexOfSeq(items, anchor.seq);
    if (anchor === null) {
      // Nothing was on screen to hold (first fill, or an empty channel).
      anchorRef.current = { ...previous, items };
    } else if (moved < 0) {
      // The stream was replaced (channel switch / reload). A RISING
      // firstItemIndex means "rows fell off the head" to virtuoso, so remount
      // instead and start the next channel from a clean index.
      anchorRef.current = {
        items,
        firstItemIndex: START_INDEX,
        epoch: previous.epoch + 1,
      };
    } else {
      const prepended = Math.max(0, moved - anchor.index);
      anchorRef.current = {
        items,
        firstItemIndex: previous.firstItemIndex - prepended,
        epoch: previous.epoch,
      };
    }
  }
  const { firstItemIndex, epoch } = anchorRef.current;

  if (status === "error") {
    return (
      <InlineBanner
        message="이 구간을 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={() => onRetry?.()}
        testId="timeline-error"
      />
    );
  }

  // A local echo counts as content: the first message in an empty channel must
  // appear the moment it is sent, not after the server round trip finishes.
  const empty = messages.length === 0 && items.length === 0;

  if (status === "loading" && empty) {
    return <SkeletonRows rows={6} className="p-4" />;
  }

  if (status === "ready" && empty) {
    const copy = emptyChannelCopy(channelKind, peer ?? null);
    return (
      <EmptyInvite
        headline={copy.headline}
        detail={copy.detail}
        actions={
          // One action, because there is one act. Adding an agent is not a
          // second, lesser door beside adding a person (R-1 §3): they are the
          // same invite, so two buttons on one handler said nothing twice.
          copy.invitable ? (
            <Button size="sm" variant="outline" onClick={onInviteMember}>
              멤버 초대하기
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onStartWriting}>
              첫 메시지 쓰기
            </Button>
          )
        }
        testId="timeline-empty"
        dataAttrs={{ "data-empty-kind": copy.invitable ? "channel" : "dm" }}
      />
    );
  }

  return (
    <Virtuoso
      key={epoch}
      ref={ref}
      // `overscroll-contain` (goal B9): 목록 끝에 닿은 뒤 한 번 더 미는 손가락이
      // 브라우저에게 넘어가지 않는다. 넘어가면 안드로이드 크롬은 pull-to-refresh로
      // 페이지를 다시 읽고 iOS는 화면 전체를 고무줄처럼 끌어당긴다 — 타임라인 맨
      // 위에서 더 당기는 몸짓의 뜻은 언제나 "더 옛날 것"이지 "앱을 다시 열기"가
      // 아니다. `none`이 아닌 이유는 고무줄 자체는 남겨야 화면이 살아 있게
      // 느껴지기 때문이다.
      className="overscroll-contain h-full"
      data={items}
      data-testid="timeline-virtuoso"
      alignToBottom
      followOutput="auto"
      startReached={onStartReached}
      firstItemIndex={firstItemIndex}
      // initialItemCount forces a first paint of rows independent of the
      // ResizeObserver measurement pass (in an embedded webview the scroller
      // height can resolve a tick after mount, leaving the list empty).
      initialItemCount={Math.min(items.length, 24)}
      defaultItemHeight={48}
      increaseViewportBy={{ top: 600, bottom: 600 }}
      computeItemKey={(_index, item: TimelineItem) => item.key}
      itemContent={(_index, item: TimelineItem) => {
        if (item.kind === "day") return <DayDivider atMs={item.atMs} />;
        if (item.kind === "unread") return <UnreadDivider count={item.count} />;
        if (item.kind === "recovery") {
          return <RecoveryDivider seq={item.seq} source={item.source} />;
        }
        if (item.kind === "pending") {
          return (
            <PendingRow
              pending={item.pending}
              startsGroup={item.startsGroup}
              directory={directory}
              quoteLookup={quoteLookup}
              onResend={onResendPending}
            />
          );
        }
        return (
          <MessageRow
            message={item.message}
            startsGroup={item.startsGroup}
            directory={directory}
            actions={
              actions && {
                ...actions,
                chips: chipsFor(
                  reactions ?? {},
                  item.message.id,
                  actions.myMemberId
                ),
              }
            }
            pausedRepeat={item.pausedRepeat}
            onOpenThread={onOpenThread}
            onQuoteMessage={onQuoteMessage}
            onJumpToMessage={onJumpToMessage}
            quoteLookup={quoteLookup}
            onOpenWorkSession={onOpenWorkSession}
            onResend={onResend}
          />
        );
      }}
    />
  );
}
