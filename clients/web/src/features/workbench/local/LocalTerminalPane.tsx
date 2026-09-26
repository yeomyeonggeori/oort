import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { subscribeTheme } from "@/design/theme";
import { isTerminalAppKey, type KeyPlatform } from "@momo/core/features/workbench/keymap";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { localSessions, type LocalSessions, type LocalSessionView } from "./localSessions";
import { attachHangulInput, isImeProcessedKey } from "./hangulInput";
import type { ITheme, Terminal } from "./localTerminalRuntime";

// Reading this as: 작업 공간 격자의 로컬 터미널 칸 for internal team users on
// Tauri desktop, density 7/10, motion 0/10.
//
// 보이는 xterm만 여기 산다. PTY와 미러는 세션 관리자(localSessions.ts)가 든다.
// 이 칸이 사라져도(도크 닫기, 최대화 전환) 세션은 계속되고, 다시 붙으면 미러가
// 받아 둔 화면부터 그린다.
//
// 키: 터미널 입력이 먼저다(ADR-0190 D5). D5 표의 앱 키(`isTerminalAppKey`)만
// xterm에 주지 않고 위로 흘려 격자와 도크가 받는다. 나머지 키는 xterm이 받고,
// 도크 뿌리(LocalTerminalDock)가 전파를 끊어 앱의 다른 단축키(⌘K, ⌥↑ 등)가
// 보지 못하게 한다. Esc도 터미널 것이다(vim). 칸을 떠나는 길은 ⌃`(도크 닫기,
// 연 곳으로 캐럿 복귀)와 ⌘]·⌘[(다음·이전 칸)이다.
//
// 한글: WKWebView는 조합 중인 글자를 「바꿔 넣기」 input 사건으로 보내고 xterm은
// 그것을 버린다. hangulInput.ts가 그 사건을 받아 DEL과 새 글자로 보낸다.
//
// 색은 관전 터미널(ObserverTerminal)과 같은 방식으로 DOM에서 읽는다. 토큰을
// 다시 적지 않는다.

type TerminalTheme = Pick<
  ITheme,
  "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground"
>;

function readTheme(surface: HTMLElement, selection: HTMLElement, cursor: HTMLElement): TerminalTheme {
  const surfaceStyle = getComputedStyle(surface);
  return {
    background: surfaceStyle.backgroundColor,
    foreground: surfaceStyle.color,
    // 입력을 받는 터미널이므로 커서가 보여야 한다. 신호색(한 표면 하나의 신호)이
    // 곧 캐럿 색이다(design-taste-web §2 「caret」).
    cursor: getComputedStyle(cursor).backgroundColor,
    cursorAccent: surfaceStyle.backgroundColor,
    selectionBackground: getComputedStyle(selection).backgroundColor,
  };
}

/** 캐럿이 이미 이 칸(머리 포함) 안에 있는가. */
function paneOwnsFocus(mount: HTMLElement): boolean {
  const section = mount.closest("[data-pane-id]");
  const active = typeof document === "undefined" ? null : document.activeElement;
  return section !== null && active !== null && section !== active && section.contains(active);
}

const EMPTY_VIEW: ReadonlyMap<string, LocalSessionView> = new Map();

export function useLocalSessionView(
  paneId: string,
  sessions: LocalSessions = localSessions()
): LocalSessionView | null {
  const map = useSyncExternalStore(
    sessions.subscribe,
    sessions.getSnapshot,
    () => EMPTY_VIEW
  );
  return map.get(paneId) ?? null;
}

/** 하네스 표시 이름. 새 세션 메뉴·칸 제목·다시 시작 단추가 같은 이름을 쓴다. */
export const HARNESS_LABEL: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

function programLabel(view: LocalSessionView | null): string {
  if (view?.program.kind !== "harness") return "셸";
  return HARNESS_LABEL[view.program.id] ?? view.program.id;
}

/** 칸 머리 제목. `로컬`로 시작해 에이전트 칸과 문구로 구분한다(ADR-0190 D7). */
export function localPaneTitle(view: LocalSessionView | null): string {
  const program = programLabel(view);
  const title = view?.title;
  return title ? `로컬 · ${program} · ${title}` : `로컬 · ${program}`;
}

export function LocalTerminalPane({
  pane,
  platform,
  sessions = localSessions(),
}: {
  pane: WorkbenchPaneInfo;
  platform: KeyPlatform;
  sessions?: LocalSessions;
}) {
  const view = useLocalSessionView(pane.id, sessions);
  const mountRef = useRef<HTMLDivElement>(null);
  const selectionProbeRef = useRef<HTMLSpanElement>(null);
  const cursorProbeRef = useRef<HTMLSpanElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const platformRef = useRef(platform);
  platformRef.current = platform;

  // 보이는 xterm 하나를 만들고 세션에 붙인다. 칸이 사라지면 떼고 버린다
  // (세션은 남는다).
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      let runtime: typeof import("./localTerminalRuntime");
      try {
        runtime = await import("./localTerminalRuntime");
      } catch {
        if (!cancelled) setRuntimeFailed(true);
        return;
      }
      const mount = mountRef.current;
      const selection = selectionProbeRef.current;
      const cursor = cursorProbeRef.current;
      if (cancelled || !mount || !selection || !cursor) return;
      const style = getComputedStyle(mount);
      const terminal = new runtime.Terminal({
        fontFamily: style.fontFamily,
        fontSize: Number.parseFloat(style.fontSize) || 12,
        scrollback: 5_000,
        cursorBlink: false,
        // 신호색은 「키가 여기로 간다」 한 곳에만(칸 링 + 그 칸의 커서). 포커스
        // 없는 칸은 커서를 그리지 않는다(관전 터미널과 같은 선택).
        cursorInactiveStyle: "none",
        macOptionIsMeta: false,
        allowProposedApi: true,
        theme: readTheme(mount, selection, cursor),
      });
      terminal.attachCustomKeyEventHandler(
        (event) => !isImeProcessedKey(event) && !isTerminalAppKey(event, platformRef.current)
      );
      const fit = new runtime.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(mount);
      mount.querySelector(".xterm-viewport")?.setAttribute("data-scroll-x", "");
      terminalRef.current = terminal;

      const refit = () => {
        try {
          fit.fit();
        } catch {
          /* 배치 중인 칸. 다음 크기 변화가 다시 맞춘다 */
        }
      };
      refit();
      await sessions.ensure(pane.id, terminal.cols, terminal.rows);
      if (cancelled) {
        terminal.dispose();
        return;
      }
      const detach = sessions.attach(pane.id, terminal);
      const helper = mount.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      const detachHangul = helper
        ? attachHangulInput(mount, helper, (text) => sessions.input(pane.id, text))
        : () => undefined;
      const data = terminal.onData((text) => sessions.input(pane.id, text));
      const binary = terminal.onBinary((raw) => {
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
        sessions.input(pane.id, bytes);
      });
      const resized = terminal.onResize(({ cols, rows }) => sessions.resize(pane.id, cols, rows));
      sessions.resize(pane.id, terminal.cols, terminal.rows);

      const observer = new ResizeObserver(refit);
      observer.observe(mount);
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const applyTheme = () => {
        terminal.options.theme = readTheme(mount, selection, cursor);
      };
      media.addEventListener("change", applyTheme);
      const unsubscribeTheme = subscribeTheme(applyTheme);
      if (pane.focused && !paneOwnsFocus(mount)) terminal.focus();

      cleanup = () => {
        observer.disconnect();
        media.removeEventListener("change", applyTheme);
        unsubscribeTheme();
        data.dispose();
        binary.dispose();
        resized.dispose();
        detach();
        detachHangul();
        terminal.dispose();
        terminalRef.current = null;
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // 칸 id가 같으면 같은 xterm을 쓴다. 포커스는 아래 효과가 따로 맞춘다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, sessions]);

  // 격자의 포커스 칸이 이 칸이 되면 키가 터미널로 가게 한다. 단 캐럿이 이미
  // 이 칸 안(머리 단추 등)에 있으면 그대로 둔다: Tab으로 머리 단추에 온
  // 사람의 캐럿을 셸로 끌어가면 다음 Tab이 셸에 먹힌다(design-review H2).
  useEffect(() => {
    const mount = mountRef.current;
    if (!pane.focused || !mount || paneOwnsFocus(mount)) return;
    terminalRef.current?.focus();
  }, [pane.focused]);

  const phase = view?.phase ?? "starting";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="local-terminal-pane">
      {/* 틀과 마운트는 두 상자다. FitAddon은 부모의 계산 높이를 테두리 상자로
          읽어서, 마운트에 안쪽 여백이 있으면 한 줄을 더 제안한다(ObserverTerminal
          머리말의 실측). 여백은 바깥 틀이 진다. */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pt-2">
        <div
          ref={mountRef}
          role="group"
          aria-label={`${pane.index}번 칸 로컬 터미널`}
          aria-description="입력은 이 터미널로 갑니다. ⌃` 도크 닫기, ⌘] 다음 칸."
          data-testid="local-terminal"
          data-phase={phase}
          className="min-h-0 flex-1 overflow-hidden bg-surface font-mono text-meta text-ink"
        />
      </div>
      <span ref={selectionProbeRef} aria-hidden="true" className="hidden bg-accent-soft" />
      <span ref={cursorProbeRef} aria-hidden="true" className="hidden bg-signal" />
      <PaneFooter view={view} runtimeFailed={runtimeFailed} onRestart={() => void sessions.restart(pane.id)} />
    </div>
  );
}

function PaneFooter({
  view,
  runtimeFailed,
  onRestart,
}: {
  view: LocalSessionView | null;
  runtimeFailed: boolean;
  onRestart: () => void;
}) {
  // 문장은 짧게: 240px 칸(최소 폭)에서도 두 줄 안에 든다. 다음 행동은 단추가 말한다.
  let message: string | null = null;
  let detail: string | null = null;
  let action: string | null = null;
  if (runtimeFailed) {
    message = "터미널 화면을 불러오지 못했습니다. 앱을 다시 여세요.";
  } else if (view === null || view.phase === "starting") {
    message = null;
  } else if (view.phase === "failed") {
    message = "터미널을 열지 못했습니다.";
    // 셸의 거부 사유는 영어 원문이라 화면 문장에 섞지 않고 풀이에만 둔다.
    detail = view.error;
    action = "다시 열기";
  } else if (view.phase === "exited") {
    message = "프로세스가 끝났습니다.";
    action = view.program.kind === "harness" ? `${programLabel(view)} 다시 시작` : "새 셸 시작";
  } else if (view.inputNotice) {
    message = view.inputNotice;
  } else if (view.storageFailed) {
    message = "이 칸의 화면을 이 기기에 저장하지 못했습니다.";
  }
  return (
    // 상태 줄은 칸 폭(창 폭이 아니다)으로 모양을 정한다. 좁으면(20rem 미만)
    // 문장 한 줄, 단추 한 줄로 쌓고, 넓으면 한 줄에 둔다(design-review R3 B1).
    <div
      className={cn("@container shrink-0 border-t border-line", message ? "block" : "hidden")}
      data-testid="local-terminal-status"
    >
      <div className="flex flex-col items-start gap-1 px-3 py-1 text-meta text-ink @xs:flex-row @xs:items-center @xs:gap-2">
        <p
          role="status"
          aria-live="polite"
          className="w-full min-w-0 break-keep @xs:w-auto @xs:flex-1"
          title={detail ? `${message ?? ""} (${detail})` : undefined}
        >
          {message ?? ""}
        </p>
        {action ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRestart}
            className="shrink-0"
            data-testid="local-terminal-restart"
          >
            <RotateCcw aria-hidden className="size-4" />
            {action}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
