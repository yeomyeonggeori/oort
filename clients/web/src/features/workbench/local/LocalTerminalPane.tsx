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
import { terminalSchemeAttribute, useTerminalTheme } from "./terminalTheme";

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
// 다시 적지 않는다. 팔레트는 tokens.css의 `--term-*`이고(#2849), 칸 틀이
// `data-term-scheme`으로 스킴을 고정하면 틀 안의 탐침이 그 스킴의 값을 낸다.
// 기본은 어둡게다(앱이 라이트여도 칸은 어둡다). 칸 머리·테두리·상태 줄은 틀
// 밖이라 앱 테마를 따른다.

type AnsiKey =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** ANSI 16색 탐침. Tailwind가 읽을 수 있게 클래스 이름을 글자 그대로 적는다. */
const ANSI_PROBES: ReadonlyArray<readonly [AnsiKey, string]> = [
  ["black", "text-term-ansi-black"],
  ["red", "text-term-ansi-red"],
  ["green", "text-term-ansi-green"],
  ["yellow", "text-term-ansi-yellow"],
  ["blue", "text-term-ansi-blue"],
  ["magenta", "text-term-ansi-magenta"],
  ["cyan", "text-term-ansi-cyan"],
  ["white", "text-term-ansi-white"],
  ["brightBlack", "text-term-ansi-bright-black"],
  ["brightRed", "text-term-ansi-bright-red"],
  ["brightGreen", "text-term-ansi-bright-green"],
  ["brightYellow", "text-term-ansi-bright-yellow"],
  ["brightBlue", "text-term-ansi-bright-blue"],
  ["brightMagenta", "text-term-ansi-bright-magenta"],
  ["brightCyan", "text-term-ansi-bright-cyan"],
  ["brightWhite", "text-term-ansi-bright-white"],
];

type TerminalTheme = Pick<
  ITheme,
  | "background"
  | "foreground"
  | "cursor"
  | "cursorAccent"
  | "selectionBackground"
  | "selectionInactiveBackground"
  | AnsiKey
>;

/** 칸 틀 안의 탐침에서 xterm 테마 전체를 읽는다. */
export function readTerminalTheme(surface: HTMLElement, probes: HTMLElement): TerminalTheme {
  const surfaceStyle = getComputedStyle(surface);
  const probe = (name: string) => probes.querySelector<HTMLElement>(`[data-term-probe="${name}"]`);
  const bgOf = (name: string) => {
    const el = probe(name);
    return el ? getComputedStyle(el).backgroundColor : undefined;
  };
  const theme: TerminalTheme = {
    background: surfaceStyle.backgroundColor,
    foreground: surfaceStyle.color,
    // 입력을 받는 터미널이므로 커서가 보여야 한다. 신호색(한 표면 하나의 신호)이
    // 곧 캐럿 색이다(design-taste-web §2 「caret」). 탐침이 틀 안에 있어 터미널
    // 스킴의 신호색이다.
    cursor: bgOf("cursor"),
    cursorAccent: surfaceStyle.backgroundColor,
    selectionBackground: bgOf("selection"),
    selectionInactiveBackground: bgOf("selection-inactive"),
  };
  for (const [key] of ANSI_PROBES) {
    const el = probe(key);
    if (el) theme[key] = getComputedStyle(el).color;
  }
  return theme;
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

/**
 * 도는 칸의 알림 한 줄(격자 상태 줄에 뜬다). 칸 번호를 앞에 붙인다. 입력 거부가
 * 저장 실패보다 먼저다(방금 친 키에 대한 답이다).
 */
export function runningPaneNotice(
  views: ReadonlyMap<string, LocalSessionView>,
  paneOrder: readonly string[]
): string | null {
  for (const pick of ["input", "storage"] as const) {
    for (let i = 0; i < paneOrder.length; i++) {
      const v = views.get(paneOrder[i]!);
      if (!v || v.phase !== "running") continue;
      if (pick === "input" && v.inputNotice) return `${i + 1}번 칸: ${v.inputNotice}`;
      if (pick === "storage" && v.storageFailed) {
        return `${i + 1}번 칸의 화면을 저장하지 못했습니다. 앱을 다시 열면 이 화면은 사라집니다.`;
      }
    }
  }
  return null;
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
  label,
  restartable = true,
}: {
  pane: WorkbenchPaneInfo;
  platform: KeyPlatform;
  sessions?: LocalSessions;
  /** 터미널의 접근성 이름. 없으면 격자 칸 이름(「N번 칸 로컬 터미널」). */
  label?: string;
  /**
   * 끝난 칸에 「다시 시작」을 두는가. 로그인 모달(#2816)은 끄고 자기 [다시 시도]로
   * 흐름을 다시 연다(모달 밖에서 로그인 명령이 다시 뜨지 않게).
   */
  restartable?: boolean;
}) {
  const view = useLocalSessionView(pane.id, sessions);
  const mountRef = useRef<HTMLDivElement>(null);
  const probesRef = useRef<HTMLDivElement>(null);
  const applyThemeRef = useRef<(() => void) | null>(null);
  const { theme: terminalTheme } = useTerminalTheme();
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
      const probes = probesRef.current;
      if (cancelled || !mount || !probes) return;
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
        theme: readTerminalTheme(mount, probes),
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
        // 가려진 칸(최대화·좁은 자리)은 PTY 크기를 정하지 않는다. 트리 자리에서
        // 짜부라진 크기로 TUI를 다시 그리게 하지 않는다(design-review R6 M-1).
        if (mount.closest("[inert]") !== null) return;
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
      // 가림이 풀리는 순간에도 맞춘다(크기 변화 알림이 가림 해제보다 먼저 올 수 있다).
      const section = mount.closest("[data-pane-id]");
      const inertWatch = new MutationObserver(refit);
      if (section) inertWatch.observe(section, { attributes: true, attributeFilter: ["inert"] });
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const applyTheme = () => {
        terminal.options.theme = readTerminalTheme(mount, probes);
      };
      applyThemeRef.current = applyTheme;
      media.addEventListener("change", applyTheme);
      const unsubscribeTheme = subscribeTheme(applyTheme);
      if (pane.focused && !paneOwnsFocus(mount)) terminal.focus();

      cleanup = () => {
        observer.disconnect();
        inertWatch.disconnect();
        media.removeEventListener("change", applyTheme);
        unsubscribeTheme();
        applyThemeRef.current = null;
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

  // 설정 › 터미널에서 테마를 바꾸면 틀의 `data-term-scheme`이 바뀐다. 탐침은
  // 커밋 뒤에야 새 스킴의 값을 내므로 효과에서 다시 읽는다(저장소 구독자에서
  // 읽으면 한 박자 늦은 색을 읽는다).
  useEffect(() => {
    applyThemeRef.current?.();
  }, [terminalTheme]);

  const phase = view?.phase ?? "starting";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="local-terminal-pane">
      {/* 틀과 마운트는 두 상자다. FitAddon은 부모의 계산 높이를 테두리 상자로
          읽어서, 마운트에 안쪽 여백이 있으면 한 줄을 더 제안한다(ObserverTerminal
          머리말의 실측). 여백은 바깥 틀이 진다. */}
      <div
        className="flex min-h-0 flex-1 flex-col bg-term-bg px-2 pt-2"
        data-term-scheme={terminalSchemeAttribute(terminalTheme)}
        data-testid="local-terminal-frame"
      >
        <div
          ref={mountRef}
          role="group"
          aria-label={label ?? `${pane.index}번 칸 로컬 터미널`}
          aria-description={
            label === undefined ? "입력은 이 터미널로 갑니다. ⌃` 도크 닫기, ⌘] 다음 칸." : undefined
          }
          data-testid="local-terminal"
          data-phase={phase}
          className="min-h-0 flex-1 overflow-hidden bg-term-bg font-mono text-meta text-term-fg"
        />
        <div ref={probesRef} aria-hidden="true" className="hidden">
          <span data-term-probe="selection" className="bg-term-selection" />
          <span data-term-probe="selection-inactive" className="bg-term-selection-inactive" />
          <span data-term-probe="cursor" className="bg-signal" />
          {ANSI_PROBES.map(([key, className]) => (
            <span key={key} data-term-probe={key} className={className} />
          ))}
        </div>
      </div>
      <PaneFooter
        view={view}
        runtimeFailed={runtimeFailed}
        onRestart={restartable ? () => void sessions.restart(pane.id) : null}
      />
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
  onRestart: (() => void) | null;
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
  }
  // 도는 칸의 알림(입력 거부·저장 실패)은 칸 안에 두지 않는다. 캐럿 줄을 가리거나
  // PTY 크기를 바꾸기 때문이다. 도크가 격자 상태 줄에 띄운다(`runningPaneNotice`).
  return (
    // 상태 줄은 칸 폭(창 폭이 아니다)으로 모양을 정한다. 좁으면(20rem 미만)
    // 문장 한 줄, 단추 한 줄로 쌓고, 넓으면 한 줄에 둔다(design-review R3 B1).
    <div
      className={cn("@container shrink-0 border-t border-line bg-surface", message ? "block" : "hidden")}
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
        {action && onRestart ? (
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
