import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { Button } from "@/design/ui/button";
import { FeedList } from "./FeedRow";
import { FilterTabs } from "./FilterTabs";
import {
  panelId,
  parseFilter,
  relativeLabel,
  tabId,
  type FeedItem,
  type InboxFilter,
} from "./model";
import {
  useAgentFeed,
  useMarkRead,
  useMentionCount,
  useMentions,
  useNeedsAction,
  useUnreadMentionChannels,
  type Feed,
} from "./useInbox";

// =============================================================================
// 인박스 (R-1 §2). Zero is the default: notifications are not something you
// switch off here, they were never sent. This surface is the safety net that
// makes that radical reduction safe, so an empty inbox is framed as the design
// working, never as a failure.
//
// Every row comes from a server projection that already exists (approval
// ledger, read-state mention decision, work-run projection). Nothing on this
// surface is counted or inferred client-side.
// =============================================================================

const EMPTY_COPY: Record<InboxFilter, { headline: string; detail: string }> = {
  "needs-action": {
    headline: "지금 결정할 일이 없습니다. 조용한 게 정상입니다.",
    detail: "에이전트가 사람의 허가를 기다릴 때만 여기 쌓입니다.",
  },
  mentions: {
    headline: "읽지 않은 멘션이 없습니다. 조용한 게 정상입니다.",
    detail: "누군가 회원님을 부르면 중요한 것만 여기 모입니다.",
  },
  agents: {
    headline: "에이전트가 남긴 결과가 없습니다. 조용한 게 정상입니다.",
    detail: "회원님이 담당하는 에이전트가 무언가를 끝내면 여기 남습니다.",
  },
};

function FeedPanel({
  filter,
  feed,
  onMarkRead,
}: {
  filter: InboxFilter;
  feed: Feed;
  onMarkRead?: (item: FeedItem) => void;
}) {
  if (feed.isLoading && feed.items.length === 0) {
    return <SkeletonRows rows={3} className="p-4" />;
  }
  if (feed.error && feed.items.length === 0) {
    return (
      <InlineBanner
        message="인박스를 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={feed.refetch}
        testId="inbox-error"
      />
    );
  }
  if (feed.items.length === 0) {
    const copy = EMPTY_COPY[filter];
    return (
      <EmptyInvite
        headline={copy.headline}
        detail={copy.detail}
        testId="inbox-empty"
      />
    );
  }
  return (
    <FeedList items={feed.items} onMarkRead={onMarkRead} testId="inbox-list" />
  );
}

export function InboxRoute() {
  const { session, connStatus } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get("filter"));

  // 결정 대기 stays loaded on every tab: it is the count that decides whether a
  // person needs to come here at all. The mention count is free (read-state is
  // already in cache for the sidebar), and 에이전트 has no cheap count, so it
  // shows none rather than a guess.
  const needsAction = useNeedsAction(true);
  const mentions = useMentions(filter === "mentions");
  const agents = useAgentFeed(filter === "agents", {
    ownedBy: session.member.id,
  });
  const mentionCount = useMentionCount();

  const markRead = useMarkRead();
  const unreadChannels = useUnreadMentionChannels();
  const [confirmingAll, setConfirmingAll] = useState(false);

  const feed =
    filter === "needs-action"
      ? needsAction
      : filter === "mentions"
        ? mentions
        : agents;

  const onMarkRead = useCallback(
    (item: FeedItem) => {
      if (item.seq === undefined) return;
      void markRead(item.channelId, item.seq);
    },
    [markRead]
  );

  const markAllRead = useCallback(() => {
    setConfirmingAll(false);
    for (const channel of unreadChannels) {
      void markRead(channel.channelId, channel.seq);
    }
  }, [unreadChannels, markRead]);

  const offline = connStatus === "disconnected";

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="inbox-route">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h1 className="text-body font-semibold">인박스</h1>
        <FilterTabs
          value={filter}
          onChange={(next) => setParams({ filter: next }, { replace: true })}
          counts={{
            "needs-action": needsAction.items.length,
            mentions: mentionCount,
          }}
        />
      </header>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={
            feed.updatedAtMs > 0
              ? `오프라인, 마지막 동기화 ${relativeLabel(
                  feed.updatedAtMs,
                  Date.now()
                )}. 아래는 그때의 상태입니다.`
              : "오프라인. 아직 이 목록을 한 번도 받지 못했습니다."
          }
          testId="inbox-offline"
        />
      )}

      <div
        role="tabpanel"
        id={panelId(filter)}
        aria-labelledby={tabId(filter)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <FeedPanel
          filter={filter}
          feed={feed}
          onMarkRead={filter === "mentions" ? onMarkRead : undefined}
        />
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2">
        {confirmingAll ? (
          <>
            <span className="text-meta text-ink">
              멘션 {mentionCount}개를 읽음으로 표시합니다. 해당 채널의 다른 안 읽은 메시지도 함께 읽음 처리되며, 되돌릴 수 없습니다.
            </span>
            <Button size="sm" onClick={markAllRead} data-testid="mark-all-confirm">
              읽음으로 표시
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingAll(false)}
            >
              취소
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={mentionCount === 0}
            onClick={() => setConfirmingAll(true)}
            data-testid="mark-all-read"
          >
            모두 읽음 처리
          </Button>
        )}
        <Link
          to="/settings"
          className="rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          data-testid="inbox-notification-rules"
        >
          알림 규칙 설정
        </Link>
      </footer>
    </div>
  );
}
