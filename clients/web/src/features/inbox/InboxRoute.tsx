import { useCallback, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { Button } from "@/design/ui/button";
import { FilterTabs } from "@/features/common/FilterTabs";
import { FeedList } from "./FeedRow";
import {
  ApprovalActions,
  type Armed,
} from "@/features/timeline/ApprovalActions";
import type { DecisionOutcome } from "@/features/timeline/approvalDecision";
import {
  INBOX_FILTER_TABS,
  panelId,
  parseFilter,
  relativeLabel,
  tabId,
  type FeedItem,
  type InboxFilter,
} from "./model";
import {
  useAgentFeed,
  useInvalidateApprovals,
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

/**
 * 결정 대기 한 행의 승인/거부 (goal B5.3b D-5).
 *
 * 이 목록은 `GET …/approvals?status=pending`을 이미 읽고 있었지만, 결정하려면
 * 채널로 들어가 타임라인의 카드를 찾아야 했다. 결정에 필요한 사실(누가, 무엇을,
 * 언제까지, 되돌릴 수 있는지)은 전부 이 행에 이미 있으므로, 결정도 여기서 한다.
 * 컨트롤은 카드와 같은 것을 쓴다 — 두 번째 구현이 아니라 두 번째 호출자다.
 */
function InboxApprovalActions({
  approvalId,
  onSettled,
  reversible,
}: {
  approvalId: string;
  onSettled: (outcome: DecisionOutcome) => void;
  reversible?: boolean;
}) {
  const [armed, setArmed] = useState<Armed>(null);
  return (
    <ApprovalActions
      approvalId={approvalId}
      armed={armed}
      setArmed={setArmed}
      onSettled={onSettled}
      lead="실행 전에 회원님의 허가가 필요합니다."
      className="px-4 pb-2"
      testIdPrefix="inbox-approval"
      reversible={reversible}
    />
  );
}

function FeedPanel({
  filter,
  feed,
  onMarkRead,
  renderActions,
}: {
  filter: InboxFilter;
  feed: Feed;
  onMarkRead?: (item: FeedItem) => void;
  renderActions?: (item: FeedItem) => ReactNode;
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
    <FeedList
      items={feed.items}
      onMarkRead={onMarkRead}
      renderActions={renderActions}
      testId="inbox-list"
    />
  );
}

export function InboxRoute() {
  const { session } = useSession();
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
  const invalidateApprovals = useInvalidateApprovals();
  // 위에서 선언한다: 아래 결정 컨트롤이 이 값을 읽는다.
  // useOffline: connStatus==="disconnected"는 실절단에도 connecting에 머물러
  // false가 된다(useOffline.ts 주석) — 파괴적 결정의 게이트는 허브와 같은 판정 하나로.
  const offline = useOffline();
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [decisionNote, setDecisionNote] = useState<string | null>(null);

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

  // 결정이 기록되면 그 행은 대기 목록에서 사라진다. 사라지는 것만으로는 무엇이
  // 됐는지 알 수 없으므로, 원장이 답한 그대로 한 줄을 남기고 목록을 다시 읽는다.
  const onDecided = useCallback(
    (outcome: DecisionOutcome) => {
      if (outcome.kind === "superseded") {
        setDecisionNote(outcome.note ?? "이 요청은 이미 결정되어 있었습니다.");
      } else if (outcome.status === "approved") {
        setDecisionNote("승인했습니다. 에이전트가 이어서 실행합니다.");
      } else if (outcome.status === "rejected") {
        setDecisionNote("거부했습니다. 이 실행은 취소되었습니다.");
      } else {
        // 200을 받았지만 원장이 알아볼 수 없는 상태를 답했다. 무엇으로 기록됐는지
        // 우리가 모르므로, 안다고 말하지 않는다.
        setDecisionNote("결정을 보냈습니다. 기록된 상태는 목록에서 확인하세요.");
      }
      invalidateApprovals();
    },
    [invalidateApprovals]
  );

  const renderApprovalActions = useCallback(
    (item: FeedItem) => {
      if (item.approvalId === undefined) return null;
      // 끊긴 채로 버튼을 그대로 두면 15초 뒤 실패로 반박당하고, 말없이 치우면
      // 무엇이 사라졌는지 알 수 없다. 자리는 지키고 이유를 말한다.
      if (offline) {
        return (
          <p
            className="px-4 pb-2 text-meta text-ink-muted"
            data-testid="inbox-approval-offline"
          >
            연결이 끊겨 지금은 결정할 수 없습니다. 다시 연결되면 여기서 승인하거나
            거부할 수 있습니다.
          </p>
        );
      }
      return (
        <InboxApprovalActions
          approvalId={item.approvalId}
          onSettled={onDecided}
          reversible={item.reversible}
        />
      );
    },
    [offline, onDecided]
  );

  const markAllRead = useCallback(() => {
    setConfirmingAll(false);
    for (const channel of unreadChannels) {
      void markRead(channel.channelId, channel.seq);
    }
  }, [unreadChannels, markRead]);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="inbox-route">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h1 className="text-body font-semibold">인박스</h1>
        <FilterTabs
          spec={INBOX_FILTER_TABS}
          value={filter}
          onChange={(next) => setParams({ filter: next }, { replace: true })}
          counts={{
            "needs-action": needsAction.items.length,
            mentions: mentionCount,
          }}
        />
      </header>

      {decisionNote && (
        <InlineBanner
          tone="neutral"
          message={decisionNote}
          actionLabel="닫기"
          onAction={() => setDecisionNote(null)}
          testId="inbox-decision-note"
        />
      )}

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
          // 결정 컨트롤은 결정 대기 탭에만. 에이전트 탭의 승인 행은 이미 끝난
          // 결정의 기록이고, 멘션 행은 승인이 아니다.
          renderActions={
            filter === "needs-action" ? renderApprovalActions : undefined
          }
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
