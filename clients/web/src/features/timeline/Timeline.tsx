import { useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Channel, Message, RosterMember } from "@/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import {
  buildTimelineItems,
  emptyChannelCopy,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineItem,
} from "./model";
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
} from "./MessageRow";
import { PendingRow } from "./PendingRow";

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
  onStartReached,
  onRetry,
  onOpenThread,
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
  onStartReached?: () => void;
  onRetry?: () => void;
  onOpenThread?: (message: Message) => void;
  onResend?: (message: Message) => Promise<void> | void;
  onResendPending?: (clientMsgId: string) => Promise<void> | void;
  onInviteMember?: () => void;
  /** Put the caret in the composer: the only next step an empty DM has. */
  onStartWriting?: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);

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
      className="h-full"
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
              onResend={onResendPending}
            />
          );
        }
        return (
          <MessageRow
            message={item.message}
            startsGroup={item.startsGroup}
            directory={directory}
            onOpenThread={onOpenThread}
            onResend={onResend}
          />
        );
      }}
    />
  );
}
