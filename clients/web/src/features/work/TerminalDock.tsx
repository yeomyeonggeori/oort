import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { uuidEq, type WorkSession } from "@momo/core/lib/api";
import {
  scopeSessions,
  sortSessions,
  workHostName,
} from "@momo/core/features/work/workSessionModel";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useWorkHosts, useWorkSessions } from "./useWorkSessions";
import { ObserverTerminal } from "./ObserverTerminal";
import { useSession } from "@/app/session";

// =============================================================================
// 채널 하단 터미널 도크 (TC-1 / #1758).
//
// Reading this as: channel shell / bottom terminal dock for internal team
// users on web+Tauri, density 7/10, motion 2/10.
//
// 조사 판정 (구현 전, PR 본문과 같음):
//   * T1~T3 작업 세션은 GET /work-sessions 원장 + 세션 스레드 이벤트 +
//     observer-grade 호스트 터미널 소켓이 실존한다. 웹 클라는
//     `issueObserverTerminalAttach({ mode: "observer" })` 만 보내고,
//     send_stdin/resize/kill 인코더가 없다 (observerStream.ts 부재가 계약).
//   * 우측 WorkPanel 은 목록·인수·화면 관전/조작·원장이고, 그 안의
//     ObserverTerminal 도 관찰 전용이다. 즉시 입력 왕복 터미널은 웹에 없다.
//   * 헤더 SquareTerminal 은 이 도크를 연다 (`open-terminal-dock`).
//     WorkPanel 은 타임라인 세션 카드 (`openWorkSession`)·사이드바
//     「작업 콘솔」(`/work` → `open-work-panel` → `?work-panel=1`)이 연다.
//     공존, 역할 분리. 같은 세션의 ObserverTerminal 이중 마운트를 막기 위해
//     둘은 XOR. 채널 스코프 관전은 도크, 전역 목록·원장은 작업 콘솔/WorkPanel.
//   * 새 세션 POST 는 웹 클라에 없다. + 버튼을 그리지 않는다.
//   * 원격(팀원) 터미널 조작은 TC-2. 여기 입력창 없음.
//
// 탭 위젯은 FilterTabs를 쓰지 않는다: 그 컨트롤은 닫힌 필터 어휘(인박스·작업
// 흐름)용이고, 세션 탭은 원장이 주는 열린 집합이다. 키보드 계약(로빙
// tabindex, ←/→)은 FilterTabs와 같고, @radix-ui/react-tabs 는 이 클라
// 의존성에 없다 (FilterTabs 머리말과 같은 이유).
// =============================================================================

function tabDomId(sessionId: string): string {
  return `terminal-dock-tab-${sessionId.toLowerCase()}`;
}

function panelDomId(sessionId: string): string {
  return `terminal-dock-panel-${sessionId.toLowerCase()}`;
}

export function TerminalDock({
  channelId,
  onClose,
}: {
  channelId: string | null;
  onClose: () => void;
}) {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const offline = useOffline();
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);
  const dockRef = useRef<HTMLElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessions = useMemo(
    () =>
      sortSessions(
        scopeSessions(sessionsQuery.data ?? [], "channel", channelId)
      ),
    [sessionsQuery.data, channelId]
  );

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && sessions.some((row) => uuidEq(row.id, selectedId))) {
      return;
    }
    setSelectedId(sessions[0].id);
  }, [sessions, selectedId]);

  useEffect(() => {
    dockRef.current?.focus();
  }, []);

  const selected: WorkSession | null =
    selectedId === null
      ? null
      : (sessions.find((row) => uuidEq(row.id, selectedId)) ?? null);

  const selectSession = useCallback((sessionId: string) => {
    setSelectedId(sessionId);
  }, []);

  const onTabListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (sessions.length === 0) return;
      event.preventDefault();
      const index = sessions.findIndex((row) =>
        uuidEq(row.id, selectedId ?? undefined)
      );
      const from = index < 0 ? 0 : index;
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next =
        sessions[(from + step + sessions.length) % sessions.length];
      selectSession(next.id);
      tabListRef.current
        ?.querySelector<HTMLElement>(`#${tabDomId(next.id)}`)
        ?.focus();
    },
    [sessions, selectedId, selectSession]
  );

  const onDockKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const pending = sessionsQuery.isPending && sessionsQuery.data === undefined;
  const failed = sessionsQuery.isError && sessionsQuery.data === undefined;

  return (
    <section
      ref={dockRef}
      tabIndex={-1}
      id="channel-terminal-dock"
      aria-label="터미널"
      data-testid="terminal-dock"
      data-expanded={expanded ? "" : undefined}
      onKeyDown={onDockKeyDown}
      className={cn(
        "flex shrink-0 flex-col border-t border-line bg-surface",
        expanded ? "h-pane-lg" : "h-pane"
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2">
        {sessions.length > 0 ? (
          <div
            ref={tabListRef}
            role="tablist"
            aria-label="작업 세션"
            data-scroll-x=""
            data-testid="terminal-dock-tabs"
            onKeyDown={onTabListKeyDown}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1"
          >
            {sessions.map((session) => {
              const selectedTab = uuidEq(session.id, selectedId ?? undefined);
              return (
                <button
                  key={session.id}
                  type="button"
                  role="tab"
                  id={tabDomId(session.id)}
                  {...(selectedTab
                    ? { "aria-controls": panelDomId(session.id) }
                    : {})}
                  aria-selected={selectedTab}
                  tabIndex={selectedTab ? 0 : -1}
                  data-testid="terminal-dock-tab"
                  data-session-id={session.id}
                  data-status={session.status}
                  onClick={() => selectSession(session.id)}
                  className={cn(
                    "h-control-sm max-w-pane-sm shrink-0 truncate rounded-sm px-2 text-meta transition-colors focus-visible:focus-ring",
                    selectedTab
                      ? "bg-accent-soft font-medium text-ink"
                      : "text-ink-muted hover:bg-surface-hover"
                  )}
                >
                  {session.label}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate px-2 py-2 text-meta text-ink-muted">
            터미널
          </p>
        )}
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-pressed={expanded}
          aria-label={expanded ? "패널 작게 보기" : "패널 크게 보기"}
          data-testid="terminal-dock-expand"
          className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        >
          <ChevronsUpDown aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="터미널 닫기"
          data-testid="terminal-dock-close"
          className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {offline && (
          <InlineBanner
            tone="neutral"
            separator={false}
            message="연결이 끊겼습니다. 이미 불러 온 세션은 그대로 두고, 다시 연결되면 출력을 이어서 받습니다."
            testId="terminal-dock-offline"
          />
        )}
        {pending ? (
          <div data-testid="terminal-dock-loading">
            <SkeletonRows rows={4} className="p-4" />
          </div>
        ) : failed ? (
          <InlineBanner
            message="작업 세션을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void sessionsQuery.refetch()}
            testId="terminal-dock-error"
          />
        ) : sessions.length === 0 ? (
          <EmptyInvite
            headline="이 채널에 관전할 작업 세션이 없습니다."
            detail="에이전트가 이 채널에서 세션을 시작하면 이 자리에 나타납니다. 웹에서 세션을 새로 만들 수는 없습니다."
            className="py-4"
            testId="terminal-dock-empty"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate("/work")}
                data-testid="terminal-dock-console"
              >
                작업 콘솔 보기
              </Button>
            }
          />
        ) : selected === null ? null : (
          <div
            role="tabpanel"
            id={panelDomId(selected.id)}
            aria-labelledby={tabDomId(selected.id)}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            data-testid="terminal-dock-panel"
          >
            <ObserverTerminal
              session={selected}
              hostName={workHostName(selected, hostsQuery.data)}
              wide
              onWideChange={() => {
                /* 도크는 이미 채널 열 전체 폭이라 패널 넓게 보기가 할 일이 없다. */
              }}
              variant="dock"
              headingLevel={3}
            />
          </div>
        )}
      </div>
    </section>
  );
}
