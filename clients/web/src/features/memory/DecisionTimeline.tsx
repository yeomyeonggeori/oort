import { useMemo } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import type {
  MemoryItem,
  MemoryItemEvent,
} from "@momo/core/features/memory/model";
import {
  BROWSER_PERSONAL_SPACE,
  itemReadError,
} from "@momo/core/features/memory/browser";
import {
  CLEANUP_NOTE,
  MERGED_INTO_LINE,
  OPEN_MERGE_WINNER,
  OPEN_REPLACED,
  OPEN_REPLACEMENT,
  TIMELINE_EMPTY_DETAIL,
  TIMELINE_EMPTY_HEADLINE,
  TIMELINE_LABEL,
  TIMELINE_LEAD,
  TIMELINE_LINKS_ERROR,
  TIMELINE_LOAD_ERROR,
  TIMELINE_LOAD_MORE,
  TIMELINE_LOAD_MORE_NOTE,
  TIMELINE_NO_SUBJECT,
  TIMELINE_ORDER_NOTE,
  decisionIntervalLabel,
  decisionStateLabel,
  deriveDecisionTimeline,
  needsEventsForLinks,
  replacedByLine,
  replacesLine,
  type DecisionState,
  type TimelineEntry,
} from "@momo/core/features/memory/timeline";
import { useDecisionTimelineItems, useTimelineEvents } from "./useMemory";

// =============================================================================
// 결정 타임라인 (ADR-0196 D12 V5, #3174).
//
// 채널·주제마다 결정을 시작 시각 순으로 세운다. 지금 유효한 것, 유효 기간이 닫힌 것(무엇이 바꿨는지),
// 다른 기억에 합쳐진 것, 오래 쓰지 않아 내려간 것을 상태로 구분한다. 「무엇이 무엇을 바꿨나」는
// 항목에 없고 옛 결정의 원장 사건에만 있어서, 닫힌·합쳐진 결정마다 이력을 읽어 링크를 만든다.
// 읽지 못한 것은 링크만 빠지고 구간과 상태는 그대로 그린다.
//
// 카드를 누르면 상세 창이 열리고, 거기서 근거 메시지 링크·정리 이력·되돌리기를 쓴다.
// =============================================================================

/** 링크를 위해 이력을 읽는 결정의 상한(닫힌·합쳐진 것 중 앞에서부터). */
const LINK_READ_CAP = 60;

const SAME_YEAR = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
});
const OTHER_YEAR = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function dayLabel(ms: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return (sameYear ? SAME_YEAR : OTHER_YEAR).format(ms);
}

const DOT_CLASS: Readonly<Record<DecisionState, string>> = {
  current: "bg-signal",
  closed: "bg-line-strong",
  merged: "bg-ink-muted",
  decayed: "bg-ink-muted",
};

export function DecisionTimeline({
  workspaceId,
  channelId,
  selectedItemId,
  channelNames,
  onOpenItem,
}: {
  workspaceId: string;
  channelId: string;
  selectedItemId: string | null;
  channelNames: ReadonlyMap<string, string>;
  onOpenItem: (itemId: string) => void;
}) {
  const list = useDecisionTimelineItems(workspaceId, channelId, true);
  const items: MemoryItem[] = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data]
  );
  const linkIds = useMemo(
    () =>
      items
        .filter((item) => needsEventsForLinks(item))
        .slice(0, LINK_READ_CAP)
        .map((item) => item.id),
    [items]
  );
  const eventQueries = useTimelineEvents(workspaceId, linkIds);
  const eventsByItem = useMemo(() => {
    const map = new Map<string, readonly MemoryItemEvent[]>();
    eventQueries.forEach((query, index) => {
      const id = linkIds[index];
      if (id !== undefined && query.data !== undefined) map.set(id, query.data);
    });
    return map;
  }, [eventQueries, linkIds]);
  const linksFailed = eventQueries.some((query) => query.isError);
  const groups = useMemo(
    () => deriveDecisionTimeline(items, eventsByItem),
    [items, eventsByItem]
  );
  const byId = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );

  if (list.isPending) {
    return (
      <div data-testid="memory-timeline-loading">
        <Skeleton ready={false} rows={5} />
      </div>
    );
  }
  if (list.isError) {
    const view = itemReadError(list.error, "list");
    return (
      <InlineBanner
        tone={view.kind === "absent" ? "neutral" : "error"}
        message={view.kind === "failed" ? TIMELINE_LOAD_ERROR : view.message}
        {...(view.kind === "absent"
          ? {}
          : { actionLabel: "다시 시도", onAction: () => void list.refetch() })}
        testId="memory-timeline-error"
      />
    );
  }

  return (
    <section
      aria-label={TIMELINE_LABEL}
      className="flex flex-col gap-4 px-4 py-3"
      data-testid="memory-timeline"
    >
      <div className="flex flex-col gap-1">
        <p className="break-keep text-meta text-ink-muted">{TIMELINE_LEAD}</p>
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="memory-timeline-cleanup"
        >
          {CLEANUP_NOTE}
        </p>
      </div>
      {linksFailed && (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="memory-timeline-links-error"
        >
          {TIMELINE_LINKS_ERROR}
        </p>
      )}
      {groups.length === 0 ? (
        <EmptyInvite
          headline={TIMELINE_EMPTY_HEADLINE}
          detail={TIMELINE_EMPTY_DETAIL}
          testId="memory-timeline-empty"
        />
      ) : (
        <>
          <p className="text-meta text-ink-muted">{TIMELINE_ORDER_NOTE}</p>
          {groups.map((group) => {
            const channelName = channelNames.get(group.channelId.toLowerCase());
            return (
              <section
                key={group.key}
                aria-label={`${channelName ?? "채널"} ${group.subjectKey ?? TIMELINE_NO_SUBJECT}`}
                className="flex flex-col gap-2"
                data-testid="memory-timeline-group"
              >
                <h3 className="break-keep text-meta font-medium text-ink-muted">
                  {channelName !== undefined && channelName !== ""
                    ? `# ${channelName}`
                    : BROWSER_PERSONAL_SPACE}
                  {" · "}
                  {group.subjectKey ?? TIMELINE_NO_SUBJECT}
                </h3>
                <ol
                  className="flex flex-col"
                  data-testid="memory-timeline-entries"
                >
                  {group.entries.map((entry) => (
                    <TimelineRow
                      key={entry.item.id}
                      entry={entry}
                      selected={
                        selectedItemId?.toLowerCase() ===
                        entry.item.id.toLowerCase()
                      }
                      replacement={
                        entry.replacedById !== undefined
                          ? byId.get(entry.replacedById)
                          : undefined
                      }
                      onOpenItem={onOpenItem}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
        </>
      )}
      {list.hasNextPage && (
        <div className="flex flex-col gap-1">
          <p className="break-keep text-meta text-ink-muted">
            {TIMELINE_LOAD_MORE_NOTE}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              className="tap-target"
              aria-busy={list.isFetchingNextPage || undefined}
              onClick={() => {
                if (!list.isFetchingNextPage) void list.fetchNextPage();
              }}
              data-testid="memory-timeline-more"
            >
              {TIMELINE_LOAD_MORE}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function TimelineRow({
  entry,
  selected,
  replacement,
  onOpenItem,
}: {
  entry: TimelineEntry;
  selected: boolean;
  /** The decision that closed this one, when it is on screen: its start is the date it changed. */
  replacement: MemoryItem | undefined;
  onOpenItem: (itemId: string) => void;
}) {
  const { item, state } = entry;
  const to =
    state === "closed" && item.validToMs !== undefined
      ? dayLabel(item.validToMs)
      : null;
  return (
    <li
      className="relative flex flex-col gap-2 border-l border-line-strong pb-4 pl-4 last:border-l-transparent last:pb-0"
      data-testid="memory-timeline-entry"
      data-state={state}
      data-item-id={item.id}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-1 top-2 size-2 rounded-full",
          DOT_CLASS[state]
        )}
      />
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-col gap-1 rounded-md border border-line px-3 py-2 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
          selected && "bg-surface-muted"
        )}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpenItem(item.id)}
        data-testid="memory-timeline-open"
      >
        <span
          className="text-meta text-ink-muted"
          data-testid="memory-timeline-state"
        >
          {decisionStateLabel(state)}
        </span>
        <span
          className={cn(
            "line-clamp-3 break-keep text-body",
            state === "current" ? "text-ink" : "text-ink-muted"
          )}
        >
          {item.body}
        </span>
        <span
          className="text-meta text-ink-muted"
          data-numeric=""
          data-testid="memory-timeline-interval"
        >
          {decisionIntervalLabel(state, dayLabel(item.validFromMs), to)} · 근거{" "}
          {item.sourceCount}개
        </span>
      </button>
      {(entry.replacedById !== undefined ||
        entry.mergedIntoId !== undefined ||
        entry.replacesIds.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
          {entry.replacedById !== undefined && (
            <>
              <span data-testid="memory-timeline-replaced">
                {replacedByLine(
                  replacement !== undefined
                    ? dayLabel(replacement.validFromMs)
                    : null
                )}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="tap-target"
                onClick={() => onOpenItem(entry.replacedById ?? "")}
                data-testid="memory-timeline-open-replacement"
              >
                {OPEN_REPLACEMENT}
              </Button>
            </>
          )}
          {entry.mergedIntoId !== undefined && (
            <>
              <span data-testid="memory-timeline-merged">
                {MERGED_INTO_LINE}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="tap-target"
                onClick={() => onOpenItem(entry.mergedIntoId ?? "")}
                data-testid="memory-timeline-open-winner"
              >
                {OPEN_MERGE_WINNER}
              </Button>
            </>
          )}
          {entry.replacesIds.length > 0 && (
            <>
              <span data-testid="memory-timeline-replaces">
                {replacesLine(entry.replacesIds.length)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="tap-target"
                onClick={() => onOpenItem(entry.replacesIds[0] ?? "")}
                data-testid="memory-timeline-open-replaced"
              >
                {OPEN_REPLACED}
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
