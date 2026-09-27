import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, ListTree, Maximize, Minimize, PanelLeftOpen, Plus, SquareTerminal, X } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  defaultWorkbenchLayout,
  focusIndex,
  focusPane,
  minimumSize,
  paneIdFor,
  paneIds,
  splitPane,
  toggleMaximize,
  WORKBENCH_MIN_PANE,
  type PaneId,
} from "@momo/core/features/workbench/layoutTree";
import {
  isTerminalAppKey,
  keyPlatformOf,
  resolveDockKey,
  type DockCommand,
  type KeyPlatform,
} from "@momo/core/features/workbench/keymap";
import {
  dockMinPx,
  dockRatioFromPointer,
  toggleDockRatio,
} from "@momo/core/features/workbench/dockStore";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { detectLocalHarnesses, type PtyProgram } from "@/lib/tauri";
import { WORK_NAV } from "@momo/core/features/workbench/workTab";
import {
  statusFromPhase,
  PANE_GIT_UNKNOWN,
  type SessionListInput,
} from "@momo/core/features/workbench/sessionList";
import { SessionList, type SessionListHandle } from "./SessionList";
import { usePaneGit } from "./usePaneGit";
import { useSessionListOpen } from "./sessionListOpen";
import { WorkbenchGrid, type WorkbenchPaneInfo } from "../WorkbenchGrid";
import { useWorkbenchLayout } from "../useWorkbenchLayout";
import { DOCK_SESSION_KEY, localSessions, type LocalSessions } from "./localSessions";
import { HARNESS_LABEL, LocalTerminalPane, localPaneTitle, runningPaneNotice } from "./LocalTerminalPane";
import {
  closeDock,
  openDock,
  setDockRatio,
  toggleDock,
  toggleDockFullscreen,
  useDockState,
} from "./dockState";

// Reading this as: 로컬 터미널 도크(⌃`) for internal team users on Tauri desktop,
// density 7/10, motion 0/10.
//
// ADR-0190 D1·D5, 제안서 §3.3 (3)·§3.4. 이 기기의 셸과 하네스를 본문 판 바닥에
// 띄운다. 칸은 작업 공간 격자(#2773)이고, 칸 하나가 로컬 PTY 하나다(#2772).
//
// - 데스크탑 셸에서만 붙는다(AppShell이 `isDesktop()`으로 거른다). 브라우저에는
//   로컬 PTY가 없으므로 도크도 진입점도 그리지 않는다.
// - ⌃`는 어디서든 도크를 연다(한글 입력 중에도, 물리 키 판정). 창의 캡처
//   단계에서 받아 컴포저·터미널보다 먼저 본다.
// - 도크를 닫아도 칸의 프로세스는 계속된다. 칸을 닫아야(⌘W, 칸 머리 ×) 끝난다.
//   실행 중이면 확인을 받는다(D5 「칸 닫기」).
// - 터미널 안에서 앱이 가로채는 키는 D5 표뿐이다. 나머지 키가 앱의 다른
//   단축키(⌘K 검색, ⌥↑ 채널 이동, ⌘⇧A 인박스)에 닿지 않게 도크 뿌리에서
//   전파를 끊는다.

function detectPlatform(): KeyPlatform {
  if (typeof navigator === "undefined") return "other";
  return keyPlatformOf(navigator.platform || navigator.userAgent);
}


const NO_WAITING = "나를 기다리는 칸이 없습니다.";
const SPLIT_REFUSED = "칸이 좁아 새 세션을 열 수 없습니다. 칸을 닫거나 도크를 키우세요.";

/** 칸 머리에서 xterm으로 가지 않은 키: 터미널 안 사건인가. */
function fromTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm") !== null;
}

export type LocalWorkbenchPresentation = "dock" | "tab";

export function LocalTerminalDock({
  sessions = localSessions(),
  platform: platformProp,
  presentation = "dock",
}: {
  sessions?: LocalSessions;
  platform?: KeyPlatform;
  /**
   * `tab`(#2854): 사이드바 「내 작업」(`/work`)의 전체 화면 격자로 그린다. 같은
   * 세션·같은 배치(`DOCK_SESSION_KEY`)를 그리므로 도크와 **동시에 마운트하지
   * 않는다**(한 칸의 PTY에 xterm이 둘 붙는다). 셸이 이 보기에서 도크를 내린다.
   * 도크를 열고 닫는 키(⌃`·⌃⇧`)는 이 보기에서 아무것도 하지 않는다.
   */
  presentation?: LocalWorkbenchPresentation;
}) {
  const platform = platformProp ?? detectPlatform();
  const dock = useDockState();
  const tab = presentation === "tab";
  /** 칸을 그리는가. 탭은 늘 그린다. */
  const active = tab || dock.open;
  const { layout, storage, setLayout } = useWorkbenchLayout(DOCK_SESSION_KEY);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 메뉴가 닫힐 때 캐럿을 포커스 칸 터미널로 보낼지(골랐거나 키로 열었다). */
  const pickedRef = useRef(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [harnesses, setHarnesses] = useState<LocalHarnessProbe[]>([]);
  const [confirm, setConfirm] = useState<{ paneId: PaneId; close: () => void } | null>(null);
  const sessionMap = useSyncSessions(sessions);
  const listRef = useRef<SessionListHandle>(null);
  const list = useSessionListOpen(minimumSize(layout.root).width);
  const listOpenRef = useRef(list.open);
  listOpenRef.current = list.open;
  const setListOpen = list.setOpen;
  /** ⌘J(작업 탭): 접힌 목록은 펴고, 지금 칸 행으로 캐럿을 보낸다. */
  const openListAndFocus = useCallback(() => {
    if (!listOpenRef.current) setListOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => listRef.current?.focus()));
  }, [setListOpen]);
  // 세션 목록의 git 사실(#2855 `readWorkbenchGit`만). 목록이 보일 때만 읽는다.
  const gitPanes = tab ? paneIds(layout.root).map((id) => [id, sessions.ptyIdOf(id)] as const) : [];
  const gitFacts = usePaneGit(gitPanes, { enabled: tab && list.open });

  // 지금 배치에 없는 칸이 남긴 스크롤백을 한 번 치운다.
  useEffect(() => {
    sessions.prune(paneIds(layoutRef.current.root));
  }, [sessions]);

  // 새 세션 메뉴의 하네스: 이 Mac의 PATH에서 찾은 것만(ADR-0190 D3).
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void detectLocalHarnesses().then((found) => {
      if (alive) setHarnesses(found.filter((h) => h.installed));
    });
    return () => {
      alive = false;
    };
  }, [active]);

  const bodySize = () => {
    const rect = bodyRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  /** 새 세션: 비어 있는 첫 칸이면 그 칸이, 아니면 포커스 칸을 나눈 새 칸이 띄운다. */
  const newSession = useCallback(
    (program: PtyProgram) => {
      const current = layoutRef.current;
      const ids = paneIds(current.root);
      if (ids.length === 1 && !sessions.has(ids[0]!)) {
        sessions.setPendingProgram(ids[0]!, program);
        if (!tab) openDock();
        return;
      }
      if (!tab && !dock.open) openDock();
      const size = bodySize();
      const axis = size.width / 2 >= WORKBENCH_MIN_PANE.width || size.width === 0 ? "row" : "column";
      const newId = paneIdFor(current.seq);
      sessions.setPendingProgram(newId, program);
      const result = splitPane(current, current.focused, axis, size.width > 0 ? size : { width: 4000, height: 4000 });
      if (!result.ok) {
        setNotice(SPLIT_REFUSED);
        return;
      }
      setNotice(null);
      layoutRef.current = result.layout;
      setLayout(result.layout);
    },
    [dock.open, sessions, setLayout, tab]
  );

  const runDock = useCallback(
    (command: DockCommand) => {
      switch (command.type) {
        case "toggle-dock":
          // 「내 작업」 탭에는 여닫을 도크가 없다. 키는 삼킨다(터미널에 NUL이
          // 가지 않게).
          return tab ? undefined : toggleDock();
        case "toggle-fullscreen":
          return tab ? undefined : toggleDockFullscreen();
        case "new-session":
          return newSession({ kind: "shell" });
        case "jump-palette":
          if (tab) {
            // 「내 작업」에서 ⌘J는 세션 목록(시안 「⌘J 세션 점프」)으로 간다.
            openListAndFocus();
            return;
          }
          if (!dock.open) openDock();
          // 키로 연 목록은 닫힐 때(골랐든 Esc든) 터미널로 돌아간다. 사람은 목록
          // 단추를 만진 적이 없다(design-review R3 H).
          pickedRef.current = true;
          setJumpOpen(true);
          return;
        case "next-waiting":
          // 「나를 기다림」 상태는 상태 점(#2776)이 채운다. 그 전에는 기다리는
          // 칸이 없다는 사실만 말한다.
          if (active) setNotice(NO_WAITING);
          return;
      }
    },
    [active, dock.open, newSession, tab, openListAndFocus]
  );

  // 전역 키: 창의 캡처 단계. 컴포저에서든 터미널 안에서든 먼저 본다.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const dockFocused = rootRef.current?.contains(document.activeElement) ?? false;
      const command = resolveDockKey(event, platform, { dockFocused });
      if (command === null) return;
      event.preventDefault();
      event.stopPropagation();
      runDock(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [platform, runDock]);

  // 터미널 입력이 먼저: xterm이 받은 키 중 앱 키가 아닌 것은 여기서 끊는다.
  // 격자 키(⌘D 등)는 끊지 않고 격자의 onKeyDown으로 올라간다.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!fromTerminal(event.target)) return;
      if (isTerminalAppKey(event, platform)) return;
      event.stopPropagation();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [platform, active]);

  // 도크가 열리면 포커스 칸의 터미널로 캐럿을 보낸다.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const pane = root.querySelector<HTMLElement>(`[data-pane-id="${layoutRef.current.focused}"]`);
      const input = pane?.querySelector<HTMLElement>(".xterm-helper-textarea");
      (input ?? pane)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, dock.fullscreen]);

  const minPx = dockMinPx(layout.root);
  useLayoutEffect(() => {
    rootRef.current?.style.setProperty("--dock-ratio", String(dock.ratio));
    rootRef.current?.style.setProperty("--dock-min", `${minPx}px`);
  }, [dock.ratio, dock.open, minPx]);

  const requestClose = useCallback(
    (paneId: PaneId, close: () => void) => {
      const view = sessionMap.get(paneId);
      const closeIt = () => {
        sessions.close(paneId);
        close();
      };
      if (view?.phase === "running") setConfirm({ paneId, close: closeIt });
      else closeIt();
    },
    [sessionMap, sessions]
  );

  const onCloseLastPane = useCallback(() => {
    setLayout(defaultWorkbenchLayout());
    // 탭은 닫히지 않는다. 빈 칸 하나로 돌아가 새 세션을 기다린다.
    if (!tab) closeDock();
  }, [setLayout, tab]);

  /**
   * 메뉴에서 세션을 열거나 칸을 고른 뒤에는 캐럿이 그 칸의 터미널에 가야 한다.
   * Radix는 닫힐 때 트리거로 캐럿을 돌려주는데, 그러면 곧바로 친 키가 어디로도
   * 가지 않는다(design-review R2 H1). 고른 경우에만 그 복귀를 막고 포커스 칸으로
   * 보낸다. Esc로 그냥 닫으면 트리거로 돌아간다.
   */
  const onMenuCloseAutoFocus = (event: Event) => {
    if (!pickedRef.current) return;
    pickedRef.current = false;
    event.preventDefault();
    focusFocusedPane();
  };
  const applyFromList = (result: ReturnType<typeof focusPane>) => {
    if (!result.ok) return;
    layoutRef.current = result.layout;
    setLayout(result.layout);
    focusFocusedPane();
  };
  const focusFocusedPane = () => {
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const pane = root?.querySelector<HTMLElement>(`[data-pane-id="${layoutRef.current.focused}"]`);
      const input = pane?.querySelector<HTMLElement>(".xterm-helper-textarea");
      (input ?? pane)?.focus({ preventScroll: true });
    });
  };

  if (!active) return null;

  const ids = paneIds(layout.root);
  const titleOf = (pane: WorkbenchPaneInfo) => localPaneTitle(sessionMap.get(pane.id) ?? null);
  const confirmView = confirm ? sessionMap.get(confirm.paneId) ?? null : null;
  const confirmIndex = confirm ? ids.indexOf(confirm.paneId) + 1 : 0;

  const closeConfirm = (
    <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
      {confirm ? (
        <DialogContent className="gap-4 p-4" data-testid="local-terminal-close-confirm">
          <div className="flex flex-col gap-1">
            <DialogTitle>실행 중인 칸을 닫을까요?</DialogTitle>
            <DialogDescription>
              {`${confirmIndex}번 칸(${localPaneTitle(confirmView)})의 프로세스가 끝나고, 이 칸의 화면도 지워집니다.`}
            </DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirm(null)}>
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="local-terminal-close-confirm-ok"
              onClick={() => {
                const run = confirm.close;
                setConfirm(null);
                run();
              }}
            >
              칸 닫기
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );

  const newSessionItems = (
    <>
          <DropdownMenuItem
            onSelect={() => {
              pickedRef.current = true;
              newSession({ kind: "shell" });
            }}
            data-testid="local-terminal-new-shell"
          >
            셸
            <span className="ml-auto pl-4 text-meta text-ink-muted">⌃⇧N</span>
          </DropdownMenuItem>
          {harnesses.map((h) => (
            <DropdownMenuItem
              key={h.id}
              onSelect={() => {
                pickedRef.current = true;
                newSession({ kind: "harness", id: h.id });
              }}
              data-testid={`local-terminal-new-${h.id}`}
            >
              {HARNESS_LABEL[h.id] ?? h.id}
              {h.auth === "needs_login" ? (
                <span className="ml-auto pl-4 text-meta text-ink-muted">로그인 필요</span>
              ) : null}
            </DropdownMenuItem>
          ))}
    </>
  );

  const sessionMenus = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" data-testid="local-terminal-new" aria-keyshortcuts="Control+Shift+N">
            <Plus aria-hidden className="size-4" />
            새 세션
            <ChevronDown aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={onMenuCloseAutoFocus}>
          {newSessionItems}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open={jumpOpen} onOpenChange={setJumpOpen}>
        <DropdownMenuTrigger asChild>
          <DockIconButton label="칸 목록" keycap="⌘J" aria="Meta+J" testId="local-terminal-jump">
            <ListTree />
          </DockIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="local-terminal-jump-list"
          onCloseAutoFocus={onMenuCloseAutoFocus}
        >
          {ids.map((id, i) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => {
                pickedRef.current = true;
                const result = focusPane(layoutRef.current, id);
                if (result.ok) {
                  layoutRef.current = result.layout;
                  setLayout(result.layout);
                }
              }}
            >
              <span data-numeric className="w-4 font-mono text-meta text-ink-muted">
                {i + 1}
              </span>
              <span className="min-w-0 truncate">{localPaneTitle(sessionMap.get(id) ?? null)}</span>
              {sessionMap.get(id)?.phase === "exited" ? (
                <span className="ml-auto pl-4 text-meta text-ink-muted">끝남</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const grid = (
    <WorkbenchGrid
      className="flex-1"
      label={tab ? "내 작업 칸" : "로컬 터미널 칸"}
      layout={layout}
      onLayoutChange={(next) => {
        setNotice(null);
        setLayout(next);
      }}
      storage={storage}
      platform={platform}
      paneTitle={titleOf}
      renderPane={(pane) => <LocalTerminalPane pane={pane} platform={platform} sessions={sessions} />}
      onRequestClose={requestClose}
      onCloseLastPane={onCloseLastPane}
      notice={notice}
      lingeringNotice={runningPaneNotice(sessionMap, ids)}
      crampedHelp={tab || dock.fullscreen ? undefined : "⌃⇧` 전체 화면"}
    />
  );

  if (tab) {
    const listInputs: SessionListInput[] = ids.flatMap((id, i) => {
      const view = sessionMap.get(id);
      if (!view) return [];
      const harness = view.program.kind === "harness" ? view.program.id : "셸";
      const programName =
        view.program.kind === "harness" ? HARNESS_LABEL[view.program.id] ?? view.program.id : "셸";
      return [
        {
          paneId: id,
          index: i + 1,
          title: view.title ?? programName,
          harness,
          status: statusFromPhase(view.phase, view.exit?.code ?? null, view.exit?.signal ?? null),
          // L 세션 공유(ADR-0190 D4-b)는 이 기기에 아직 상태가 없다.
          shared: false,
          git: gitFacts.get(id) ?? PANE_GIT_UNKNOWN,
        },
      ];
    });
    const gitLoading = gitFacts.size === 0 && gitPanes.some(([, pty]) => pty !== null);
    // 「내 작업」(#2854·#2856, 시안 ①): 세션 목록 268 | 머리 줄 48 · 격자 좌우 여백 12.
    // 배치 프리셋(T5)·worktree 보기(T6)·로그 패널(T7)은 각 이슈가 머리 줄에 붙인다.
    return (
      <div
        ref={rootRef as RefObject<HTMLDivElement>}
        data-testid="my-work-tab"
        data-session-list={list.open ? "open" : "closed"}
        className="flex min-h-0 min-w-0 flex-1"
      >
        {list.open ? (
          <SessionList
            ref={listRef}
            sessions={listInputs}
            loading={gitLoading}
            focusedPaneId={layout.focused}
            platform={platform}
            onActivate={(paneId) => applyFromList(focusPane(layoutRef.current, paneId))}
            onMaximize={(paneId) => applyFromList(toggleMaximize(layoutRef.current, paneId))}
            onFocusIndex={(index) => applyFromList(focusIndex(layoutRef.current, index))}
            onCollapse={() => setListOpen(false)}
            newSessionItems={newSessionItems}
            onNewSessionMenuCloseAutoFocus={onMenuCloseAutoFocus}
          />
        ) : null}
        <section aria-labelledby="my-work-title" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-work-tab-bar shrink-0 items-center gap-2 pl-4 pr-3">
            {list.open ? null : (
              <DockIconButton
                label="세션 목록 펴기"
                keycap="⌘J"
                aria="Meta+J"
                testId="session-list-expand"
                onClick={() => openListAndFocus()}
              >
                <PanelLeftOpen />
              </DockIconButton>
            )}
            <h1 id="my-work-title" className="shrink-0 text-title font-bold text-ink">
              {WORK_NAV.mine}
            </h1>
            <p className="min-w-0 truncate text-meta text-ink-muted" data-testid="my-work-note">
              이 기기의 세션입니다. 서버에 기록하지 않습니다.
            </p>
            <span className="flex-1" />
            {list.open ? null : sessionMenus}
          </header>
          <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col px-3 pb-1">
            {grid}
          </div>
        </section>
        {closeConfirm}
      </div>
    );
  }

  return (
    <section
      ref={rootRef}
      aria-label="로컬 터미널"
      data-testid="local-terminal-dock"
      data-fullscreen={dock.fullscreen ? "" : undefined}
      className={cn(
        "local-dock border-t border-line bg-pane",
        dock.fullscreen && "border-t-0"
      )}
    >
      {dock.fullscreen ? null : <DockEdge ratio={dock.ratio} rootRef={rootRef} />}
      <header className="@container flex h-control shrink-0 items-center gap-1 px-2">
        <SquareTerminal aria-hidden className="size-4 shrink-0 text-icon" />
        <h2 className="min-w-0 truncate pl-1 text-meta font-medium text-ink">로컬 터미널</h2>
        {/* 설명은 도크 폭(창 폭이 아니다)이 넉넉할 때만. */}
        <p className="hidden min-w-0 truncate text-meta text-ink-muted @2xl:block">
          이 기기에서만 돌고 서버에 기록하지 않습니다.
        </p>
        <span className="flex-1" />
        {sessionMenus}
        <DockIconButton
          label={dock.fullscreen ? "전체 화면 끄기" : "전체 화면 켜기"}
          keycap="⌃⇧`"
          aria="Control+Shift+`"
          pressed={dock.fullscreen}
          onClick={() => toggleDockFullscreen()}
          testId="local-terminal-fullscreen"
        >
          {dock.fullscreen ? <Minimize /> : <Maximize />}
        </DockIconButton>
        <DockIconButton
          label="도크 닫기"
          keycap="⌃`"
          aria="Control+`"
          onClick={() => closeDock()}
          testId="local-terminal-dock-close"
        >
          <X />
        </DockIconButton>
      </header>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col px-2 pb-1">
        {grid}
      </div>
      {closeConfirm}
    </section>
  );
}

function useSyncSessions(sessions: LocalSessions) {
  return useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot);
}

type DockIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  keycap: string;
  aria: string;
  pressed?: boolean;
  testId: string;
  children: ReactNode;
};

/** 머리의 아이콘 단추. 드롭다운 트리거(asChild)가 ref와 속성을 넘기므로 받아 준다. */
const DockIconButton = forwardRef<HTMLButtonElement, DockIconButtonProps>(function DockIconButton(
  { label, keycap, aria, pressed, testId, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-keyshortcuts={aria}
      aria-pressed={pressed}
      title={`${label} (${keycap})`}
      data-testid={testId}
      className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring [&_svg]:size-4"
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * 도크 위 경계. 끌어서 높이, 더블클릭으로 두 단계, ↑↓로 조절한다. 격자의
 * 경계와 같은 WAI-ARIA 창 분할자 모양이다(Radix에 창 분할 프리미티브가 없다).
 */
function DockEdge({ ratio, rootRef }: { ratio: number; rootRef: RefObject<HTMLElement> }) {
  const [dragging, setDragging] = useState(false);
  const container = () => rootRef.current?.parentElement?.getBoundingClientRect() ?? null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const box = container();
    if (!box) return;
    setDockRatio(dockRatioFromPointer(event.clientY, box.top, box.height), box.height);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const box = container();
    const height = box?.height ?? 0;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setDockRatio(ratio + (event.key === "ArrowUp" ? 0.05 : -0.05), height);
    } else if (event.key === "Enter") {
      event.preventDefault();
      setDockRatio(toggleDockRatio(ratio, height), height);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="터미널 도크 높이 조절"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid="local-terminal-dock-edge"
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        const height = container()?.height ?? 0;
        setDockRatio(toggleDockRatio(ratio, height), height);
      }}
      onKeyDown={onKeyDown}
      className="group flex h-2 shrink-0 cursor-row-resize touch-none select-none items-center justify-center focus-visible:focus-ring"
    >
      <span
        aria-hidden
        className={cn(
          "h-px w-8 rounded-full bg-line transition-colors group-hover:bg-line-strong",
          dragging && "bg-line-strong"
        )}
      />
    </div>
  );
}
