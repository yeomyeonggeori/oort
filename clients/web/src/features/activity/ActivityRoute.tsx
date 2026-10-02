import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import { FilterTabs } from "@/features/common/FilterTabs";
import {
  ACTIVITY_FILTER_TABS,
  matchesActivityFilter,
  parseActivityFilter,
  type ActivityFilter,
} from "@momo/core/features/inbox/activityFilter";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import {
  EmptyInvite,
  InlineBanner,
  Skeleton,
} from "@/features/common/States";
import { FeedList } from "@/features/inbox/FeedRow";
import { relativeLabel } from "@momo/core/features/inbox/model";
import { useAgentFeed } from "@/features/inbox/useInbox";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";

// =============================================================================
// 활동 (R-1 §1, the second global surface). One line per thing an agent did:
// "{누가} {무엇을} 해서 → {결과}". Same rows as the inbox 에이전트 tab, but for
// the whole workspace rather than only the agents one human is accountable for.
//
// 인박스와의 역할(#3337): 인박스 = 나에게 필요한 것(읽음·수·처리), 활동 = 일어난 일의
// 기록(읽음 없음, 수 없음, 필터 칩으로 범위만 좁힌다). 인박스의 「에이전트」 탭은 이
// 표면의 부분집합이라 없앴고 여기로 이어진다.
//
// Sources are the two agent projections the server already exposes: the
// approval ledger (what an agent asked permission for and what came of it) and
// the work-run projection. Turn liveness is deliberately NOT faked from typing
// indicators; a row appears when the server recorded something.
// =============================================================================

const EMPTY_COPY: Record<ActivityFilter, { headline: string; detail: string }> = {
  all: {
    headline: "에이전트 활동이 아직 없습니다.",
    detail:
      "에이전트가 실행 허가를 요청하거나 작업을 마치면 한 줄씩 쌓입니다. 담당자도 함께 표시됩니다.",
  },
  mine: {
    headline: "회원님이 담당하는 에이전트의 활동이 아직 없습니다.",
    detail: "담당 에이전트가 허가를 요청하거나 작업을 마치면 여기 남습니다.",
  },
  approvals: {
    headline: "승인 기록이 아직 없습니다.",
    detail: "에이전트가 실행 허가를 요청하면 그 요청과 결과가 여기 남습니다.",
  },
  done: {
    headline: "끝난 작업이 아직 없습니다.",
    detail: "에이전트의 작업 실행이 끝나면 한 줄씩 남습니다.",
  },
};

export function ActivityRoute() {
  const { connStatus, session } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = parseActivityFilter(params.get("filter"));
  // 이 표면의 두 원천이 **둘 다** 이 서버에 없다 (goal B12): 승인 원장(404)과
  // 작업 실행 기록(경로가 POST 전용이라 GET은 405). 요청을 보내 놓고 빈 목록을
  // 그리면 "에이전트가 한 일이 없다"고 말하는 셈인데, 그것은 우리가 모르는
  // 사실이다. 그래서 묻지 않고, 못 한다고 말한다.
  const provided =
    isSurfaceProvided("approvals") || isSurfaceProvided("agentRunHistory");
  const feed = useAgentFeed(provided, {
    ownedBy: filter === "mine" ? session.member.id : undefined,
  });
  const items = useMemo(
    () => feed.items.filter((item) => matchesActivityFilter(item, filter)),
    [feed.items, filter]
  );
  const offline = connStatus === "disconnected";

  // 2R B2: 위 판정은 **둘 중 하나라도 있으면** 이 표면을 연다. 승인이 제공으로
  // 뒤집힌 지금 그 조건은 참이 되었고, 그래서 이 라우트는 다시 요청을 보낸다.
  // 그런데 승인 라우트를 아직 배포하지 않은 서버에서는 승인이 404, 작업 기록이
  // 405로 돌아와 `allFailed`가 참이 되고, 화면은 "활동을 불러오지 못했습니다 /
  // 다시 시도"를 그렸다. 다시 눌러도 영영 같은 답이 오는 막다른 길이다.
  //
  // 판정을 새로 만들지 않는다: `useAgentFeed`가 두 원장의 미제공을 이미 함께
  // 계산해 둔다(useInbox.ts). 정적으로 막히든 런타임에 접히든 사람이 보는 문장은
  // 하나여야 하므로, 두 경우를 같은 갈래로 모은다.
  const unavailable = !provided || feed.absent;

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

      {/* 필터 칩은 보는 범위만 좁힌다. 활동에는 읽음도 수도 없어 칩에 개수를 달지
          않는다(수가 붙으면 「처리할 것」으로 읽혀 인박스와 역할이 섞인다). */}
      {!unavailable && (
        <div className="border-b border-line px-4 py-2">
          <FilterTabs
            spec={ACTIVITY_FILTER_TABS}
            value={filter}
            onChange={(next) =>
              setParams(next === "all" ? {} : { filter: next }, { replace: true })
            }
          />
        </div>
      )}

      {/* 제공되지 않는 표면에서는 오프라인 줄도 세우지 않는다: "아직 이 목록을
          한 번도 받지 못했습니다"는 연결 탓처럼 들리는데, 연결이 돌아와도 이
          목록은 오지 않는다. 두 문장이 겹치면 사용자는 기다리면 된다고 읽는다. */}
      {!unavailable && offline && (
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

      <div
        {...(!unavailable
          ? {
              role: "tabpanel",
              id: ACTIVITY_FILTER_TABS.panelId(filter),
              "aria-labelledby": ACTIVITY_FILTER_TABS.tabId(filter),
            }
          : {})}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {unavailable ? (
          <SurfaceUnavailableSection
            surface="agentRunHistory"
            testId="activity-unavailable"
          />
        ) : (
          <Skeleton
            ready={!(feed.isLoading && items.length === 0)}
            rows={4}
            className="p-4"
          >
            {feed.isLoading && items.length === 0 ? null : feed.error &&
              items.length === 0 ? (
              <InlineBanner
                message="활동을 불러오지 못했습니다."
                actionLabel="다시 시도"
                onAction={feed.refetch}
                testId="activity-error"
              />
            ) : items.length === 0 ? (
              <EmptyInvite
                headline={EMPTY_COPY[filter].headline}
                detail={EMPTY_COPY[filter].detail}
                testId="activity-empty"
              />
            ) : (
              <FeedList
                items={items}
                testId="activity-list"
                renderActions={renderPendingLink}
              />
            )}
          </Skeleton>
        )}
      </div>
    </div>
  );
}

/**
 * 아직 결정이 안 난 승인 행은 이 표면에서 처리하지 않는다(활동은 기록이다). 결정은
 * 인박스가 한다 — 눌러서 해당 자리로 건너간다(#3337).
 */
function renderPendingLink(item: FeedItem) {
  if (item.kind !== "approval" || !item.pending) return null;
  return (
    <p className="px-4 pb-2 text-meta">
      <Link
        to="/inbox"
        data-testid="activity-pending-link"
        className="press rounded-sm text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
      >
        인박스에서 처리
      </Link>
    </p>
  );
}
