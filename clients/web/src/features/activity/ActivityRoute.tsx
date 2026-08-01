import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { FeedList } from "@/features/inbox/FeedRow";
import { relativeLabel } from "@/features/inbox/model";
import { useAgentFeed } from "@/features/inbox/useInbox";

// =============================================================================
// 활동 (R-1 §1, the second global surface). One line per thing an agent did:
// "{누가} {무엇을} 해서 → {결과}". Same rows as the inbox 에이전트 tab, but for
// the whole workspace rather than only the agents one human is accountable for.
//
// Sources are the two agent projections the server already exposes: the
// approval ledger (what an agent asked permission for and what came of it) and
// the work-run projection. Turn liveness is deliberately NOT faked from typing
// indicators; a row appears when the server recorded something.
// =============================================================================

export function ActivityRoute() {
  const { connStatus } = useSession();
  const feed = useAgentFeed(true);
  const offline = connStatus === "disconnected";

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="activity-route">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold">활동</h1>
        </div>
        <span className="text-meta text-ink-muted">
          에이전트가 요청한 것과 그 결과
        </span>
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
          testId="activity-offline"
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {feed.isLoading && feed.items.length === 0 ? (
          <SkeletonRows rows={4} className="p-4" />
        ) : feed.error && feed.items.length === 0 ? (
          <InlineBanner
            message="활동을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={feed.refetch}
            testId="activity-error"
          />
        ) : feed.items.length === 0 ? (
          <EmptyInvite
            headline="에이전트 활동이 아직 없습니다."
            detail="에이전트가 실행 허가를 요청하거나 작업을 마치면 한 줄씩 쌓입니다. 담당자도 함께 표시됩니다."
            testId="activity-empty"
          />
        ) : (
          <FeedList items={feed.items} testId="activity-list" />
        )}
      </div>
    </div>
  );
}
