import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { CHIP_CLASS } from "@/features/common/chip";
import { FilterTabs } from "@/features/common/FilterTabs";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { relativeLabel } from "@momo/core/features/inbox/model";
import {
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { type Workstream } from "@momo/core/lib/api";
import {
  WORKSTREAM_FILTER_TABS,
  WORKSTREAM_STATUS_CLASS,
  WORKSTREAM_STATUS_LABEL,
  channelDisplayName,
  parseStatusFilter,
  workstreamActor,
  workstreamFilterOf,
  workstreamStatusOf,
} from "@momo/core/features/workstreams/model";
import { useWorkstreams } from "./useWorkstreams";

// =============================================================================
// 작업 흐름 목록 (MOMO-677 / ADR-0143 이행 3).
//
// One row per GOAL, not per run. The reason this surface exists is the question
// ADR-0143 opened with: "A가 시작한 일을 다른 사람이나 에이전트가 이어받을 수
// 있는가?" — which nobody can answer from the 작업 세션 패널, because that panel
// is scoped to one channel and, in its most used range, to your own sessions.
// Someone looking for work to pick up is by definition looking for work that is
// not theirs, so the goal layer is a workspace destination beside 인박스 · 활동
// · 멤버 · 에이전트 rather than a drawer inside one conversation (the same call
// the agent hub made in MOMO-652).
//
// The status filter is the SERVER's vocabulary (`?status=`), carried in the URL
// the way 인박스 carries its tab, so a filtered list survives a reload and can
// be pasted to someone else.
//
// What this list must never do is turn a zero into an accusation. A caller
// outside the anchor channel gets zero rows — not a 403 — precisely so these
// reads cannot be used to probe for other people's work (WorkstreamRoutes
// "minimum exposure"), and an empty state that said "권한이 없습니다" would hand
// back the existence signal the server just refused to give.
// =============================================================================

// 헤더와 행이 같은 오른쪽 끝을 갖게 하는 한 줄. 구분선과 hover 배경은 판 전폭,
// 내용만 여기서 멈춘다 — MemberRow가 적어두고 실측한 계약 그대로다
// (MemberRow.tsx §measure, DirectoryRoute 헤더 176-182). v1은 헤더는 내용을,
// 목록은 컨테이너를 캡했고 그래서 1280에서 오른쪽 가장자리가 셋이었다(헤더
// 카운트 896, ul 880, 상태칩 864 — 1R H1). 한 상수를 헤더와 행이 같이 쓰면 그
// 어긋남은 다시 생길 수 없다.
const MEASURE_CLASS = "w-full max-w-pane-lg";

/**
 * 목록이 시작한 사람을 부르는 이름. 상세와 같은 규칙을 지나므로(에이전트 병기는
 * 상세의 실행 이력이 가진다) 한 사람이 두 화면에서 두 이름으로 불리지 않는다.
 */
function starterName(directory: Directory, memberId: string): string {
  return workstreamActor(directory, memberId).name;
}

function StatusChip({ status }: { status: Workstream["status"] }) {
  return (
    <span
      className={cn(CHIP_CLASS, WORKSTREAM_STATUS_CLASS[status])}
      data-testid="workstream-status"
      data-status={status}
    >
      {WORKSTREAM_STATUS_LABEL[status]}
    </span>
  );
}

function WorkstreamRow({
  workstream,
  channelName,
  starterName,
  nowMs,
}: {
  workstream: Workstream;
  channelName: string;
  /** 이 목표를 시작한 사람. 접두사가 같은 두 목표를 가르는 두 번째 사실이다. */
  starterName: string;
  nowMs: number;
}) {
  return (
    <li
      className="border-b border-line"
      data-testid="workstream-row"
      data-workstream-id={workstream.id}
      data-status={workstream.status}
    >
      <Link
        to={`/workstreams/${workstream.id}`}
        className="flex px-4 py-2 transition-colors hover:bg-surface-hover focus-visible:focus-ring"
      >
        <span
          className={cn(MEASURE_CLASS, "flex min-w-0 flex-col gap-1 break-keep")}
          data-testid="workstream-row-content"
        >
          {/* 칩은 목표의 첫 줄에 맞춰 선다(items-baseline). 목표가 두 줄이 되면
              가운데 정렬은 칩을 두 줄 사이 허공에 놓는다. */}
          <span className="flex min-w-0 items-baseline gap-2">
            {/* 목표는 최대 200자다(마이그레이션 055). 한 줄 말줄임은 그 200자를
                ~545px 폭에서 30자쯤으로 자르고, 행에 남는 나머지 사실은 채널
                이름뿐이라 접두사가 같은 두 목표는 구분되지 않았다(PR 918 R1 M4).
                두 줄까지 접으면 그 폭에서 60자 넘게 읽히고, 첫 문장이 아니라
                문장 두 개가 서로 다르다는 것이 보인다.

                `title`은 붙이지 않는다: 네이티브 툴팁은 키보드로 열 수 없고
                포인터에만 답하는데, 전체 목표는 이 행이 이미 링크하고 있는
                상세에서 잘리지 않고 읽힌다. 접힌 것을 펴는 길이 이미 하나
                있으면 두 번째 길은 되도록 쓰지 않는 쪽이 낫다.

                keep-all은 부모(row-content)가, break-words는 여기가 갖는다:
                tailwind-merge는 둘을 한 `break` 그룹으로 접는다. */}
            <span
              className="line-clamp-2 min-w-0 flex-1 break-words text-body text-ink"
              data-testid="workstream-goal"
            >
              {workstream.goal}
            </span>
            <StatusChip status={workstream.status} />
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
            <span className="min-w-0 truncate" data-testid="workstream-channel">
              {channelName}
            </span>
            {/* 시작한 사람. 목표 문장만으로 가르기 어려운 두 행을 실제로 가르는
                두 번째 사실이고, 목록이 곧 작업 큐라 "누가 벌여둔 일인가"는
                인수하러 온 사람이 다음으로 묻는 것이다. 이미 상세가 같은
                사실을 같은 이름 규칙으로 말한다(workstreamActor). */}
            <span className="shrink-0">· 시작</span>
            <span className="min-w-0 truncate" data-testid="workstream-starter">
              {starterName}
            </span>
            <span className="shrink-0">· 실행</span>
            {/* Two counts on one line, so both are tabular: 실행 12 over 실행 3
                must line up down the column, and the pair is the fact that
                decides whether anyone is on this goal right now. */}
            <span
              className="shrink-0 font-mono"
              data-numeric
              data-testid="workstream-run-count"
            >
              {workstream.runCount}
            </span>
            <span className="shrink-0">· 활성</span>
            <span
              className="shrink-0 font-mono"
              data-numeric
              data-testid="workstream-active-count"
            >
              {workstream.activeRunCount}
            </span>
            <span className="shrink-0">· 갱신</span>
            <span className="shrink-0" data-testid="workstream-updated">
              {relativeLabel(workstream.updatedAtMs, nowMs)}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

export function WorkstreamListRoute() {
  const { session, workspaceId } = useSession();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const status = parseStatusFilter(params.get("status"));
  const query = useWorkstreams(workspaceId, status);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const nowMs = Date.now();

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  const workstreams = query.data ?? [];
  const settled = !query.isPending && query.error === null;
  const filter = workstreamFilterOf(status);

  function setStatus(next: Workstream["status"] | null) {
    const nextParams = new URLSearchParams(params);
    if (next === null) nextParams.delete("status");
    else nextParams.set("status", next);
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="workstream-route">
      <header className="flex flex-col gap-2 border-b border-line px-4 py-2">
        <div
          className={cn(MEASURE_CLASS, "flex items-baseline justify-between gap-3")}
          data-testid="workstream-header-content"
        >
          {/* 한국어 산문이므로 음절이 아니라 어절에서 끊는다(MOMO-676 M-5).
              keep-all은 부모에, break-words는 자식에 둔다: 둘은 tailwind-merge의
              같은 `break` 그룹이라 한 엘리먼트에 쓰면 하나가 조용히 사라진다
              (common/States.tsx가 세운 형태). */}
          <div className="min-w-0 break-keep">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarDrawerToggle />
              <h1 className="text-body font-semibold text-ink">작업 흐름</h1>
            </div>
            <p className="break-words text-meta text-ink-muted">
              목표 하나와 그 목표를 실행한 사람들. 멈춘 목표는 같은 채널 멤버가
              인수합니다.
            </p>
          </div>
          {settled && (
            <span
              className="shrink-0 text-meta text-ink-muted"
              data-testid="workstream-count"
            >
              <span data-numeric className="font-mono">
                {workstreams.length}
              </span>
              개
            </span>
          )}
        </div>
        {/* 인박스와 같은 탭 컨트롤이다(features/common/FilterTabs). 값만 이
            표면의 것이고 — 서버의 `?status=` 어휘 다섯 — 키보드 계약(정거장 1개,
            ←/→ 이동)과 기하는 그 컨트롤의 것이다. 여기서 다시 만들면 같은 화면의
            같은 질문이 두 가지 방식으로 답해진다. */}
        <FilterTabs
          spec={WORKSTREAM_FILTER_TABS}
          value={filter}
          onChange={(next) => setStatus(workstreamStatusOf(next))}
        />
      </header>

      {/* The banner dates what is on screen and stops there. It used to add
          "이어받기는 다시 연결된 뒤에" as well, which names an action this
          surface does not carry (the takeover lives in the detail) and which
          the detail then repeats 200px from its own control: one fact, said
          once, where the control is. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 아래는 마지막으로 확인된 목록입니다."
          testId="workstream-offline"
        />
      )}

      {/* 탭이 지배하는 패널. 탭이 자기 패널을 `aria-controls`로 가리키므로 그
          패널이 실제로 존재해야 하고, 그 관계를 아는 것은 라우트다(인박스와 같은
          형태). */}
      <div
        role="tabpanel"
        id={WORKSTREAM_FILTER_TABS.panelId(filter)}
        aria-labelledby={WORKSTREAM_FILTER_TABS.tabId(filter)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {query.isPending ? (
          <SkeletonRows rows={5} className="p-4" />
        ) : query.error ? (
          <InlineBanner
            message="작업 흐름을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="workstream-error"
          />
        ) : workstreams.length === 0 ? (
          status === null ? (
            <EmptyInvite
              headline="아직 작업 흐름이 없습니다."
              detail="채널 스레드에서 작업을 시작하면 그 목표가 여기에 한 줄로 쌓입니다. 내가 속한 채널의 목표만 보입니다."
              testId="workstream-empty"
              dataAttrs={{ "data-variant": "all" }}
            />
          ) : (
            <EmptyInvite
              headline={`${WORKSTREAM_STATUS_LABEL[status]} 상태인 작업 흐름이 없습니다.`}
              detail="다른 상태에는 있을 수 있습니다."
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStatus(null)}
                  data-testid="workstream-empty-all"
                >
                  전체 보기
                </Button>
              }
              testId="workstream-empty"
              dataAttrs={{ "data-variant": "filtered" }}
            />
          )
        ) : (
          /* 측정 폭은 이 컨테이너가 아니라 각 행의 내용이 갖는다(MEASURE_CLASS).
             ul을 캡하면 구분선과 hover 배경까지 640px에서 잘려, 판 전폭으로
             그어지는 헤더 구분선과 어긋난 두 번째 오른쪽 가장자리가 생긴다 —
             1R H1이 실측한 셋 중 하나가 바로 이 ul이었다. 집의 계약은
             "구분선·hover는 전폭, 내용만 캡"이다(MemberRow.tsx §measure). */
          <ul data-testid="workstream-list">
            {workstreams.map((workstream) => (
              <WorkstreamRow
                key={workstream.id}
                workstream={workstream}
                channelName={channelDisplayName(
                  workstream.channelId,
                  channels,
                  directoryQuery.directory,
                  session.member.id
                )}
                starterName={starterName(
                  directoryQuery.directory,
                  workstream.createdByMemberId
                )}
                nowMs={nowMs}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
