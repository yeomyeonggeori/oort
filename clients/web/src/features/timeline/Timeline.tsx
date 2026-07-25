import { useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Message } from "@/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import {
  buildTimelineItems,
  type RecoveryMarker,
  type TimelineItem,
} from "./model";
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
} from "./MessageRow";

// =============================================================================
// Timeline (R-1 §3). Virtualised by react-virtuoso, ordered by seq only, with
// the derived render stream (day / unread / recovery markers) folded in by
// buildTimelineItems. The four states live here so the surface is never a bare
// blank area; offline is one banner above, owned by the shell.
// =============================================================================

export function Timeline({
  messages,
  directory,
  status,
  lastReadSeq,
  unreadCount,
  recoveryMarkers,
  onStartReached,
  onRetry,
  onOpenThread,
  onInviteMember,
}: {
  messages: Message[];
  directory: Directory;
  status: "loading" | "ready" | "error";
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  onStartReached?: () => void;
  onRetry?: () => void;
  onOpenThread?: (message: Message) => void;
  onInviteMember?: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);

  const items = useMemo(
    () =>
      buildTimelineItems(messages, {
        lastReadSeq,
        unreadCount,
        recoveryMarkers,
      }),
    [messages, lastReadSeq, unreadCount, recoveryMarkers]
  );

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

  if (status === "loading" && messages.length === 0) {
    return <SkeletonRows rows={6} className="p-4" />;
  }

  if (status === "ready" && messages.length === 0) {
    return (
      <EmptyInvite
        headline="이 채널을 함께 시작하세요."
        detail="사람과 에이전트를 같은 자격으로 추가할 수 있습니다."
        actions={
          <>
            <Button size="sm" onClick={onInviteMember}>
              사람 추가
            </Button>
            <Button size="sm" variant="outline" onClick={onInviteMember}>
              에이전트 추가
            </Button>
          </>
        }
        testId="timeline-empty"
      />
    );
  }

  return (
    <Virtuoso
      ref={ref}
      className="h-full"
      data={items}
      data-testid="timeline-virtuoso"
      alignToBottom
      followOutput="auto"
      startReached={onStartReached}
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
        return (
          <MessageRow
            message={item.message}
            startsGroup={item.startsGroup}
            directory={directory}
            onOpenThread={onOpenThread}
          />
        );
      }}
    />
  );
}
