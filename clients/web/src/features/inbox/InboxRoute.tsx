import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
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
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import {
  isSurfaceProvided,
  serverSurface,
  type SurfaceId,
} from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";
import {
  agentsFeedPartial,
  approvalRowControl,
  approvalsPanelState,
  decidableCount,
  decisionNote,
  type DecisionNote,
} from "./approvalsPanel";
import {
  availableInboxFilters,
  INBOX_FILTER_TABS,
  panelId,
  parseFilter,
  relativeLabel,
  tabId,
  type FeedItem,
  type InboxFilter,
} from "@momo/core/features/inbox/model";
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
//
// ## 이 표면이 곧 승인함이다 (goal W-AP1)
//
// 승인 결정을 위한 네 번째 라우트를 파지 않았다. 「결정 대기」 탭이 이미
// `GET …/approvals?status=pending` 하나를 통째로 읽고 있고, 결정 컨트롤은
// 타임라인 카드와 공유하는 `ApprovalActions` 한 벌이다. 세 번째 표면을 세우면
// 세 번째 멱등 정책과 세 번째 409 문구가 생기고, 보고 있지 않은 쪽이 흘러간다.
//
// 정작 없던 것은 화면이 아니라 **판정**이었다: `approvals.provided`가 false인
// 동안 `availableInboxFilters`는 이 탭 자체를 세우지 않았으므로, 코드로 존재하는
// 결정 UI에 도달할 경로가 0이었다. 그 줄이 뒤집힌 지금 이 파일이 할 일은 셋이다 —
// 목록의 다섯 상태를 한 판정으로 모으고(approvalsPanel.ts), 배포되지 않은 서버의
// 404를 장애가 아니라 미제공으로 접고, 결정의 답을 색까지 판정으로 말하는 것.
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

/**
 * 이 탭이 미제공일 때 이름을 댈 표면.
 *
 * 「결정 대기」는 승인 원장 하나 위에 서 있고, 「에이전트」는 그 원장에 작업 실행
 * 기록을 얹는다 — 활동 라우트가 이미 그 둘이 함께 없을 때 작업 기록 쪽 문구를
 * 쓰므로(ActivityRoute), 같은 사실에 같은 이름을 댄다. 멘션은 어느 세대의
 * 서버에나 있는 경로 위에 있어 미제공이 될 수 없다.
 */
const PANEL_SURFACE: Record<InboxFilter, SurfaceId | null> = {
  "needs-action": "approvals",
  mentions: null,
  agents: "agentRunHistory",
};

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
  const surface = PANEL_SURFACE[filter];
  const state = approvalsPanelState({
    isLoading: feed.isLoading,
    // 이름 댈 표면이 없는 탭은 미제공이 될 수 없다: 접을 곳이 없으면 접지 않는다.
    absent: feed.absent && surface !== null,
    error: feed.error,
    count: feed.items.length,
  });

  if (state === "unavailable" && surface !== null) {
    return (
      <SurfaceUnavailableSection
        surface={surface}
        testId="inbox-unavailable"
      />
    );
  }
  if (state === "loading") {
    return <SkeletonRows rows={3} className="p-4" />;
  }
  if (state === "error") {
    return (
      <InlineBanner
        message="인박스를 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={feed.refetch}
        testId="inbox-error"
      />
    );
  }
  if (state === "empty") {
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
  // 이 서버가 답할 수 있는 탭만 (goal B12). 승인 원장이 없는 서버에서는 결정
  // 대기와 에이전트가 사라지고 멘션 하나만 남는다.
  const availableFilters = useMemo(
    () => availableInboxFilters((surface) => isSurfaceProvided(surface)),
    []
  );
  const filter = parseFilter(params.get("filter"), availableFilters);
  const approvalsProvided = isSurfaceProvided("approvals");
  // 2R H1: 「에이전트」 탭의 나머지 절반. 정적 판정으로 묻는다 — 요청을 보내
  // 405를 받아 보고 알아낼 필요가 없는 사실이다.
  const runHistoryMissing = agentsFeedPartial((surface) =>
    isSurfaceProvided(surface)
  );
  const runHistorySurface = serverSurface("agentRunHistory");

  // 결정 대기 stays loaded on every tab: it is the count that decides whether a
  // person needs to come here at all. The mention count is free (read-state is
  // already in cache for the sidebar), and 에이전트 has no cheap count, so it
  // shows none rather than a guess.
  //
  // 승인 원장이 없는 서버에서는 이 요청을 아예 만들지 않는다. 404를 받아 놓고
  // 0으로 세는 것은 "결정할 것이 없다"를 지어내는 일이고, 그 숫자가 탭 배지에
  // 올라간다 (goal B12).
  const needsAction = useNeedsAction(approvalsProvided);
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
  const [note, setNote] = useState<DecisionNote | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreListFocus = useRef(false);

  const feed =
    filter === "needs-action"
      ? needsAction
      : filter === "mentions"
        ? mentions
        : agents;

  // 2R L1: 결정 영수증은 **그 목록에 대한 답**이다. 탭을 옮기면 그 답이 가리키던
  // 행은 화면에 없는데 줄만 남아, 멘션 목록 위에 "승인을 기록했습니다"가 떠 있는
  // 상태가 된다. 무엇에 대한 말인지 알 수 없는 문장은 정보가 아니라 잔해다.
  useEffect(() => {
    setNote(null);
  }, [filter]);

  // 2R M6의 착지점. 목록이 다시 그려진 뒤에 옮겨야 방금 사라진 행이 아니라
  // 새 목록을 잡는다.
  useEffect(() => {
    if (!restoreListFocus.current) return;
    restoreListFocus.current = false;
    panelRef.current?.focus();
  }, [feed.items]);

  const onMarkRead = useCallback(
    (item: FeedItem) => {
      if (item.seq === undefined) return;
      void markRead(item.channelId, item.seq);
    },
    [markRead]
  );

  // 결정이 기록되면 그 행은 대기 목록에서 사라진다. 사라지는 것만으로는 무엇이
  // 됐는지 알 수 없으므로, 원장이 답한 그대로 한 줄을 남기고 목록을 다시 읽는다.
  // 무슨 말을 어떤 색으로 할지는 `decisionNote`가 정한다: 이미 다른 곳에서
  // 결정된 요청(superseded)은 정상적인 상태 전이이지 사고가 아니므로, 그 갈래가
  // 조용히 --danger로 흘러가지 않도록 판정을 컴포넌트 밖에 못 박아 둔다.
  const onDecided = useCallback(
    (outcome: DecisionOutcome) => {
      setNote(decisionNote(outcome));
      invalidateApprovals();
      // 2R M6: 결정한 행은 원장을 다시 읽는 순간 사라진다. 그 행 안에 있던
      // 초점도 함께 사라져 body로 떨어지므로, 키보드 사용자는 방금 일한 자리를
      // 잃고 문서 맨 위에서 다시 Tab을 시작한다. 캐럿을 목록 자체에 돌려주면
      // ↑/↓가 바로 다음 행으로 이어진다.
      restoreListFocus.current = true;
    },
    [invalidateApprovals]
  );

  const renderApprovalActions = useCallback(
    (item: FeedItem) => {
      const control = approvalRowControl(item, { offline });
      if (control.kind === "none") return null;
      // 끊긴 채로 버튼을 그대로 두면 15초 뒤 실패로 반박당하고, 말없이 치우면
      // 무엇이 사라졌는지 알 수 없다. 자리는 지키고 이유를 말한다.
      if (control.kind === "offline") {
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
          approvalId={control.approvalId}
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
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold">인박스</h1>
        </div>
        {/* 탭이 하나뿐이면 탭 줄을 세우지 않는다 (goal B12). 고를 것이 없는
            고르개는 컨트롤이 아니라 장식이고, 남은 하나에 이미 있는 이름을
            한 번 더 적을 뿐이다. */}
        {availableFilters.length > 1 && (
          <FilterTabs
            spec={{ ...INBOX_FILTER_TABS, values: availableFilters }}
            value={filter}
            onChange={(next) => setParams({ filter: next }, { replace: true })}
            // 2R M3: 행 수가 아니라 **결정할 수 있는 행 수**. 배지는 "지금
            // 당신이 해야 할 일이 몇 개인가"를 말하는 자리이고, 결정할 수 없는
            // 행이 그 수에 들어가면 사람은 인박스를 열고 셀 것을 찾지 못한다.
            counts={{
              "needs-action": decidableCount(needsAction.items),
              mentions: mentionCount,
            }}
          />
        )}
      </header>

      {/* tone이 판정에서 온다. `InlineBanner`는 error면 role="alert"+--danger,
          neutral이면 role="status"를 그리므로, 게이트는 그 role 하나로
          "이미 결정됨이 오류로 그려지지 않았다"를 단언할 수 있다.

          `unavailable`은 배너에서 neutral과 같은 모양이다(2R M1). 이 배너가 가진
          색은 둘뿐이고, 미제공이 속할 곳은 조용한 쪽이다 — 목록이 같은 404를
          이미 조용히 접고 있으므로. 판정으로는 갈라져 있어서 테스트가 그 사실을
          못으로 박을 수 있고, 화면에서는 같은 조용함으로 만난다. */}
      {note && (
        <InlineBanner
          tone={note.tone === "error" ? "error" : "neutral"}
          message={note.text}
          actionLabel="닫기"
          onAction={() => setNote(null)}
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

      {/* 탭 줄이 없으면 이 상자는 tabpanel이 아니다. 역할만 남겨 두면
          `aria-labelledby`가 존재하지 않는 탭을 가리키고, 보조기술은 이름 없는
          패널을 읽는다. 탭이 하나뿐일 때 이 표면은 그냥 목록이다. */}
      {/* 2R H1: 「에이전트」 탭은 승인 원장과 작업 실행 기록 두 원장 위에 서 있는데,
          이 서버는 뒤의 것을 읽는 경로를 싣지 않았다(POST 전용 경로라 GET은 405).
          그 사실을 삼키면 화면은 승인 기록만 담긴 목록을 그려 놓고 "조용한 게
          정상입니다"라고 말하고, 사용자는 에이전트가 아무 작업도 하지 않았다고
          읽는다 — 우리가 모르는 사실이다. 목록은 그대로 남긴다: 있는 절반을 감추는
          것은 반대 방향의 같은 거짓말이다. */}
      {filter === "agents" && runHistoryMissing && (
        <InlineBanner
          tone="neutral"
          message={`${runHistorySurface.absentReason} 아래 목록은 승인 기록만 담고 있습니다.`}
          testId="inbox-agents-partial"
        />
      )}

      <div
        {...(availableFilters.length > 1
          ? {
              role: "tabpanel",
              id: panelId(filter),
              "aria-labelledby": tabId(filter),
            }
          : {})}
        ref={panelRef}
        // 2R M6의 착지점. 결정한 행이 사라진 뒤 캐럿이 여기로 오면 ↑/↓가 바로
        // 다음 행으로 이어진다. -1이라 Tab 순서에는 끼어들지 않는다.
        tabIndex={-1}
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

      {/* 컴포저와 같은 이유의 안전 영역 (goal B6): 이것도 셸의 마지막 줄이고,
          폰에서는 그 아래가 홈 인디케이터다. */}
      <footer className="safe-area-bottom flex flex-wrap items-center gap-3 border-t border-line px-4 py-2">
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
