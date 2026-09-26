import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useWorkHosts, useWorkSessions } from "./useWorkSessions";
import { ObserverTerminal, TerminalShortNotice } from "./ObserverTerminal";
import { useSession } from "@/app/session";
import { useSurfaceProvided } from "@/features/capabilities/useSurfaceProvided";

function readPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function viewportHeightPx(): number {
  // `--app-viewport-height` 의 기본값은 `100dvh` 라 parseFloat 가 100 이 된다.
  // px 로 덮인 값만 믿고, 아니면 창 높이를 본다.
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-viewport-height")
    .trim();
  if (raw.endsWith("px")) {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return window.visualViewport?.height || window.innerHeight;
}

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
//   * #2753: 이 도크는 #2166 작업 표면 판정(`isSurfaceProvided("work")`)
//     뒤에서만 마운트된다(ChatShell). 문구는 표면 중립이다: 데스크탑 앱도 같은
//     트리를 그리므로 「웹에서」라고 말하지 않는다. 빈 상태는 이 자리가 무엇을
//     하는 곳인지(호스트에서 도는 에이전트 세션의 관전)를 말한다.
//     로컬 워크벤치(M1, agent-workspace-2.0 §3.10)가 들어오면 빈 상태의 CTA와
//     헤더 진입점은 「로컬 터미널 열기」로 대체된다.
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
  // 「작업 콘솔 보기」는 `/work` 로 간다. 그 라우트는 `workConsole` 판정 뒤에만
  // 있으므로(App.tsx), 같은 판정 없이 버튼을 세우면 빈 화면으로 보내는 CTA가 된다.
  const workConsoleProvided = useSurfaceProvided("workConsole");
  const offline = useOffline();
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);
  const dockRef = useRef<HTMLElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const [short, setShort] = useState(false);
  const shortRef = useRef(false);
  const probedGeoRef = useRef("");
  const [canExpand, setCanExpand] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  expandedRef.current = expanded;

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

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;

    const measure = () => {
      const vh = viewportHeightPx();
      const reserve = readPx("--spacing-terminal-dock-reserve") || 280;
      const target = readPx("--spacing-terminal-dock") || 504;
      const floor = readPx("--spacing-terminal-floor") || 56;
      const strip = readPx("--spacing-timeline-strip") || 80;
      const collapsedMax = Math.min(target, vh - reserve);
      // 크롬은 폭에 따라 달라지므로 상수와 대조하지 않는다. 터미널 상자
      // 실높이가 floor 미만이면 접고, 접힌 뒤 창이 바뀌면 한 번 펼쳐 다시 잰다.
      const geo = `${Math.round(vh)}x${Math.round(window.innerWidth)}`;
      const box = dock.querySelector<HTMLElement>(
        "[data-testid='work-observer-terminal']"
      );
      let nextShort = false;
      if (box) {
        nextShort = box.getBoundingClientRect().height < floor;
        probedGeoRef.current = geo;
      } else if (shortRef.current) {
        if (geo !== probedGeoRef.current) {
          probedGeoRef.current = geo;
          nextShort = false;
        } else {
          nextShort = true;
        }
      }

      const timeline = document.querySelector("[data-testid='chat-timeline']");
      const timelineH = timeline?.getBoundingClientRect().height ?? strip;
      const slack = timelineH - strip;
      const dockH = dock.getBoundingClientRect().height;
      const isExpanded = expandedRef.current;
      // 확대가 실제로 벌 게 없으면 눌림을 거둔다. 이미 확대해서 띠까지
      // 가져간 자리(dock > 접힘 상한)는 그 자체가 이득이라 유지한다.
      const gained = dockH > collapsedMax + 1;
      const nextCanExpand = !nextShort && (isExpanded ? gained : slack > 1);

      shortRef.current = nextShort;
      setShort(nextShort);
      setCanExpand(nextCanExpand);
      if (nextShort || (isExpanded && !gained && slack <= 1)) {
        setExpanded(false);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    const timeline = document.querySelector("[data-testid='chat-timeline']");
    if (timeline) ro.observe(timeline);
    const box = dock.querySelector("[data-testid='work-observer-terminal']");
    if (box) ro.observe(box);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [selectedId, short]);

  const shownExpanded = canExpand && expanded;
  const expandTitle = !canExpand
    ? short
      ? "창이 낮아 터미널을 접었습니다"
      : "타임라인이 이미 최소입니다"
    : undefined;

  return (
    <section
      ref={dockRef}
      tabIndex={-1}
      id="channel-terminal-dock"
      aria-label="터미널"
      data-testid="terminal-dock"
      data-expanded={shownExpanded ? "" : undefined}
      data-short={short ? "" : undefined}
      onKeyDown={onDockKeyDown}
      className={cn(
        "flex flex-col border-t border-line bg-pane outline-none focus-visible:focus-ring",
        short
          ? "terminal-dock-short"
          : shownExpanded
            ? "terminal-dock-lg"
            : "terminal-dock"
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
            className="scrollbar-visible flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1"
            // N-3: 헤드리스 크로미움은 이 막대를 0px 로 숨긴다. 유틸은 정상이고
            // artifacts/design 캡처에는 막대가 영원히 안 나온다.
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
                  title={session.label}
                  className={cn(
                    "h-control-sm max-w-pane-sm shrink-0 truncate rounded-sm px-2 text-meta press focus-visible:focus-ring",
                    selectedTab
                      ? "bg-accent-soft font-medium text-ink active:bg-surface-pressed"
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
          disabled={!canExpand}
          onClick={() => {
            if (!canExpand) return;
            setExpanded((current) => !current);
          }}
          aria-pressed={shownExpanded}
          aria-label="터미널 크게 보기"
          title={expandTitle}
          data-testid="terminal-dock-expand"
          className="tap-target flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronsUpDown aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="터미널 닫기"
          data-testid="terminal-dock-close"
          className="tap-target flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div
        data-testid="terminal-dock-body"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {short ? (
          <TerminalShortNotice />
        ) : (
          <>
        {offline && (
          <InlineBanner
            tone="neutral"
            separator={false}
            message="연결이 끊겼습니다. 이미 불러온 세션은 그대로 두고, 다시 연결되면 출력을 이어서 받습니다."
            testId="terminal-dock-offline"
          />
        )}
        {pending ? (
          <div data-testid="terminal-dock-loading">
            <Skeleton ready={false} rows={4} className="p-4" />
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
            detail="에이전트가 코드 실행 호스트에서 돌리는 작업 세션의 터미널 출력을 관전하는 곳입니다. 에이전트가 이 채널에서 세션을 시작하면 여기에 나타납니다."
            className="py-4"
            testId="terminal-dock-empty"
            actions={
              workConsoleProvided ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/work")}
                  data-testid="terminal-dock-console"
                >
                  작업 콘솔 보기
                </Button>
              ) : undefined
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
              headingLevel={2}
            />
          </div>
        )}
          </>
        )}
      </div>
    </section>
  );
}
