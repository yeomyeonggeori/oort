import { forwardRef } from "react";
import { ExternalLink, GitPullRequest, Lock, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { SharedWorkSession } from "@momo/core/lib/api";
import {
  TEAM_BOARD_COPY,
  channelLabel,
  diffFacts,
  harnessLabel,
  isRunItem,
  prFacts,
  sessionTitle,
  stageMarkers,
  stateSentence,
  whereLabel,
} from "@momo/core/features/workbench/teamBoard";
import { cn } from "@/design/lib/cn";
import { StateChip, LaneLabel } from "./TeamBoardParts";

// =============================================================================
// 세션 상세 드로어 (#2863, 제안서 §4.3, 시안 ④ `.drawer`).
//
// **큐레이션된 읽기 전용 뷰다.** 이 파일에는 터미널(xterm·관전·PTY), 입력 칸, 멈춤·허락
// 단추가 없고, 그것들을 끌어오는 import도 없다(소스 시험이 import를 잠근다). 공유 세션은
// 서버가 모든 컨트롤을 거부한다(ADR-0190 D4). 행동은 대화에서 한다: 바닥의 유일한
// 행동은 집 채널로 가는 링크다.
//
// 보이는 것은 서버가 준 S1 필드뿐이다: 레인, 이름, 주인·하네스·저장소/브랜치, 상태 문장,
// 단계 표지, 커밋·diff 숫자, PR. 커밋 제목은 어느 길로도 오지 않는다(Q2).
// =============================================================================

const SECTION_HEADING = "px-4 pt-3 pb-1 text-meta font-semibold text-ink-muted";

export const TeamBoardDrawer = forwardRef<
  HTMLElement,
  {
    item: SharedWorkSession;
    nowMs: number;
    onClose: () => void;
  }
>(function TeamBoardDrawer({ item, nowMs, onClose }, ref) {
  const where = whereLabel(item);
  const facts = diffFacts(item.diff);
  const markers = stageMarkers(item);
  const pr = prFacts(item.prUrl);
  const channel = channelLabel(item);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-labelledby="team-board-drawer-title"
      data-testid="team-board-drawer"
      data-session-id={item.sessionId}
      data-source={item.source}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-s border-line bg-surface focus-visible:focus-ring"
    >
      <div className="flex flex-col gap-2 border-b border-line px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <LaneLabel item={item} />
          <button
            type="button"
            onClick={onClose}
            aria-label={TEAM_BOARD_COPY.drawerClose}
            title={`${TEAM_BOARD_COPY.drawerClose} (Esc)`}
            data-testid="team-board-drawer-close"
            className="ms-auto flex size-control-sm shrink-0 items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <h2
          id="team-board-drawer-title"
          className="break-keep text-title font-bold text-ink"
        >
          {sessionTitle(item)}
        </h2>
        <p
          className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-ink-muted"
          data-testid="team-board-drawer-meta"
        >
          <span>{item.owner.displayName}</span>
          <span>{harnessLabel(item)}</span>
          {(where.primary !== null || where.secondary !== null) && (
            <span className="min-w-0 break-all font-mono text-timestamp text-ink">
              {[where.primary, where.secondary].filter(Boolean).join(" / ")}
            </span>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-2">
          <StateChip item={item} />
          <span className="break-keep text-meta text-ink">
            {stateSentence(item, nowMs)}
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {markers.length > 0 && (
          <section aria-labelledby="team-board-progress">
            <h3 id="team-board-progress" className={SECTION_HEADING}>
              {TEAM_BOARD_COPY.progressHeading}
            </h3>
            <ol
              className="flex flex-col gap-1 px-4 pb-2"
              data-testid="team-board-stages"
            >
              {markers.map((marker, i) => (
                <li
                  key={`${i}-${marker.label}`}
                  className="flex items-center gap-2 text-body text-ink"
                  data-tone={marker.tone}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      marker.tone === "current"
                        ? "bg-signal"
                        : "bg-ink-muted"
                    )}
                  />
                  <span className="min-w-0 break-keep">{marker.label}</span>
                  <span className="sr-only">
                    {marker.tone === "current" ? "지금 단계" : "지난 단계"}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {facts !== null && (
          <section aria-labelledby="team-board-log">
            <h3 id="team-board-log" className={SECTION_HEADING}>
              {TEAM_BOARD_COPY.logHeading}
              <span className="ms-2 font-normal">
                {TEAM_BOARD_COPY.logHint}
              </span>
            </h3>
            <ul
              className="flex flex-col gap-1 px-4 pb-2 text-body text-ink"
              data-testid="team-board-log"
            >
              <li data-numeric>
                {[
                  facts.commits !== null ? `커밋 ${facts.commits}개` : null,
                  facts.added !== null && facts.deleted !== null
                    ? `+${facts.added} −${facts.deleted}`
                    : null,
                  facts.files !== null ? `파일 ${facts.files}` : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" · ")}
              </li>
            </ul>
          </section>
        )}

        <section aria-labelledby="team-board-result">
          <h3 id="team-board-result" className={SECTION_HEADING}>
            {TEAM_BOARD_COPY.resultHeading}
          </h3>
          {pr !== null ? (
            <a
              href={pr.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="team-board-pr"
              className="mx-4 flex min-w-0 items-center gap-2 rounded-lg border border-line px-3 py-2 text-body text-ink press hover:bg-surface-hover focus-visible:focus-ring"
            >
              <GitPullRequest aria-hidden className="size-4 shrink-0 text-icon" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{pr.number}</span>
                <span className="truncate text-meta text-ink-muted">
                  {pr.repo}
                </span>
              </span>
              <ExternalLink aria-hidden className="size-3 shrink-0 text-icon" />
              <span className="sr-only">새 탭에서 열기</span>
            </a>
          ) : (
            <div
              className="mx-4 flex flex-col gap-1 rounded-lg border border-line px-3 py-2"
              data-testid="team-board-no-pr"
            >
              <p className="flex items-center gap-2 text-body font-medium text-ink">
                <GitPullRequest aria-hidden className="size-4 shrink-0 text-icon" />
                {TEAM_BOARD_COPY.noPr}
              </p>
              <p className="break-keep text-meta text-ink-muted">
                {isRunItem(item)
                  ? TEAM_BOARD_COPY.runNoPrBody
                  : TEAM_BOARD_COPY.noPrBody}
              </p>
            </div>
          )}
        </section>

        <p
          className="mx-4 mt-3 flex items-start gap-2 break-keep rounded-lg bg-sheet px-3 py-2 text-meta text-ink-muted"
          data-testid="team-board-terminal-note"
        >
          <Lock aria-hidden className="mt-px size-3 shrink-0 text-icon" />
          <span>
            {isRunItem(item)
              ? TEAM_BOARD_COPY.runNote
              : TEAM_BOARD_COPY.terminalNote}
          </span>
        </p>
      </div>

      {/* 바닥에는 행동이 없다. 집 채널로 가는 링크 하나뿐이다(행동은 대화에서 한다). */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Link
          to={`/c/${item.homeChannel.id}`}
          data-testid="team-board-open-channel"
          className="inline-flex h-control items-center gap-1 rounded-full bg-surface-muted px-4 text-body font-medium text-ink press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <span className="truncate">{channel}에서 보기</span>
        </Link>
      </div>
    </aside>
  );
});
