import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import {
  defaultWorkbenchLayout,
  splitPane,
  type WorkbenchLayout,
} from "@momo/core/features/workbench/layoutTree";
import {
  serializeWorkbenchLayout,
  workbenchLayoutEntry,
} from "@momo/core/features/workbench/layoutStore";
import { TerminalSection, TerminalThemeChoiceGroup } from "@/features/settings/TerminalSection";
import { isTerminalThemeChoice } from "@momo/core/features/workbench/terminalTheme";
import { setTerminalTheme } from "./terminalTheme";
import { LocalTerminalDock } from "./LocalTerminalDock";
import { createLocalSessions, DOCK_SESSION_KEY, loadBrowserMirror, type PtyPort } from "./localSessions";
import { openDock, resetDockStateForTest, toggleDockFullscreen, useDockState } from "./dockState";

// Reading this as: 로컬 터미널 도크 하네스(진단 표면) for internal team users on
// web+Tauri, density 7/10, motion 0/10.
//
// `#/design/local-terminal` (design 모드에서만). 브라우저에는 PTY가 없으므로
// 흉내 PTY가 셸 모양의 출력을 내고 입력을 되울린다. 캡처(`capture:local-terminal`)와
// 디자인 검수가 라이트·다크에서 도크를 보는 자리다. 실제 PTY는 데스크탑 debug
// 앱에서 확인한다(PR 본문).
//
// `?scene=one|four|full|palette|exited|failed|exited-four|failed-four|exited-harness-four|storage-fail|stack3|stack3-exited|settings-web|settings-desktop`
// `&term=dark|app|light`: 칸 색 테마(#2849). 없으면 저장된 값(기본 어둡게).
// `palette` 장면은 ANSI 16색·powerline 모양 프롬프트·Claude Code 모양 TUI를 찍고,
// 채널 자리에 설정 › 터미널의 색 고르기를 둔다(바꾸면 칸이 바로 따라 바뀐다).

const ENC = new TextEncoder();

const BANNER = [
  "\u001b[2mLast login: Sat Sep 26 20:02:58 on ttys004\u001b[0m",
  "\u001b[32m~/momo\u001b[0m \u001b[2m(feat/2774)\u001b[0m $ cargo test -p momo-desktop pty",
  "   Compiling momo-desktop v0.1.0",
  "    Finished `test` profile [unoptimized + debuginfo] target(s) in 4.21s",
  "test pty::tests::queued_input_arrives_in_order_and_in_full ... \u001b[32mok\u001b[0m",
  "test pty::tests::closing_the_app_kills_every_session ... \u001b[32mok\u001b[0m",
  "test result: \u001b[32mok\u001b[0m. 75 passed; 0 failed",
  "\u001b[32m~/momo\u001b[0m $ echo 한글 입력 확인",
  "한글 입력 확인",
  "\u001b[32m~/momo\u001b[0m $ ",
].join("\r\n");

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/**
 * 팔레트 장면(#2849). 이름표 글자는 ANSI 색 그대로, 바탕 조각은 ANSI 바탕색이다.
 * powerline 모양 프롬프트는 흔한 p10k 16색 모양(검은 조각 위 파랑·초록)을 흉내 낸다.
 * Claude Code 모양 줄은 24비트 색과 흐림(SGR 2)을 쓴다.
 */
const PALETTE_BANNER = [
  "\u001b[1mANSI 16\u001b[0m",
  ANSI_NAMES.map((n, i) => `\u001b[3${i}m${n.padEnd(8)}\u001b[0m`).join(" "),
  ANSI_NAMES.map((n, i) => `\u001b[9${i}m${("b-" + n).padEnd(8)}\u001b[0m`).join(" "),
  ANSI_NAMES.map((n, i) => `\u001b[4${i}m ${n.padEnd(7)}\u001b[0m`).join(" "),
  "\u001b[2m흐림(SGR 2) 글자: Last login: Sat Sep 26 20:02:58 on ttys004\u001b[0m",
  "",
  "\u001b[40m\u001b[34m ~/momo \u001b[0m ── \u001b[40m\u001b[32m ✔ system \u001b[90m00:22:16 \u001b[0m",
  "\u001b[32m❯\u001b[0m git status",
  "On branch \u001b[36mfix/2849-desktop-ansi\u001b[0m",
  "Changes not staged: \u001b[31mmodified: tokens.css\u001b[0m  \u001b[32mnew file: terminalTheme.ts\u001b[0m",
  "",
  "\u001b[38;2;215;119;87m✻\u001b[0m \u001b[1mClaude Code\u001b[0m \u001b[2mv2.1.280\u001b[0m",
  "\u001b[2m  Opus 5.5 (1M context) · /Users/kwakseongjae\u001b[0m",
  "\u001b[2m" + "─".repeat(48) + "\u001b[0m",
  "\u001b[1m❯\u001b[0m 터미널 색을 어둡게로 바꿔 줘",
  "\u001b[2m" + "─".repeat(48) + "\u001b[0m",
  "  \u001b[33m⏵⏵ auto mode on\u001b[0m \u001b[2m(shift+tab to cycle)\u001b[0m",
  "\u001b[32m~/momo\u001b[0m $ echo 한글 입력 확인",
  "한글 입력 확인",
  "\u001b[32m~/momo\u001b[0m $ ",
].join("\r\n");

/** 브라우저용 흉내 PTY. 입력을 그대로 되울리고, Enter에 새 프롬프트를 낸다. */
function demoPty(mode: "live" | "exited" | "failed" = "live", banner = BANNER): PtyPort {
  const outputs = new Map<number, (b: ArrayBuffer) => void>();
  let next = 1;
  const emit = (id: number, text: string) => {
    const bytes = ENC.encode(text);
    outputs.get(id)?.(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  };
  return {
    spawn: async (_request, onOutput, onExit) => {
      if (mode === "failed") throw new Error("refused: folder is outside the home directory");
      const id = next++;
      outputs.set(id, onOutput);
      setTimeout(() => {
        emit(id, banner);
        if (mode === "exited") onExit({ id, code: 0, signal: null });
      }, 0);
      return id;
    },
    write: async (id, bytes) => {
      const text = new TextDecoder().decode(bytes);
      emit(id, text.replace(/\r/g, "\r\n\u001b[32m~/momo\u001b[0m $ "));
    },
    resize: async () => undefined,
    kill: async (id) => void outputs.delete(id),
    ack: async () => undefined,
  };
}

const SIZE = { width: 1600, height: 1000 };

const memoryMap = new Map<string, string>();
const memory = {
  getItem: (k: string) => memoryMap.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryMap.set(k, v),
  removeItem: (k: string) => void memoryMap.delete(k),
  keys: () => [...memoryMap.keys()],
};

/** 전체 화면에서 아래로 두 번 나눈 배치(½·¼·¼). */
function stack3Layout(): WorkbenchLayout {
  let l = splitPane(defaultWorkbenchLayout(), "p1", "column", SIZE).layout;
  l = splitPane(l, "p2", "column", SIZE).layout;
  return l;
}

function fourLayout(): WorkbenchLayout {
  let l = splitPane(defaultWorkbenchLayout(), "p1", "row", SIZE).layout;
  l = splitPane(l, "p1", "column", SIZE).layout;
  l = splitPane(l, "p2", "column", SIZE).layout;
  return l;
}

export function LocalTerminalHarness() {
  const [params] = useSearchParams();
  const scene = params.get("scene") ?? "one";
  const sessions = useMemo(
    () =>
      createLocalSessions({
        pty: demoPty(
          scene.startsWith("exited") || scene.endsWith("-exited")
            ? "exited"
            : scene.startsWith("failed")
              ? "failed"
              : "live",
          scene === "palette" ? PALETTE_BANNER : BANNER
        ),
        loadMirror: loadBrowserMirror,
        // 보통 장면은 메모리 저장소(저장 성공). `storage-fail`만 저장소 없음.
        storage: () => (scene === "storage-fail" ? null : memory),
      }),
    [scene]
  );
  const dock = useDockState();
  const term = params.get("term");
  // 칸이 처음 그려지기 전에 고른다(첫 테마부터 맞게).
  useMemo(() => {
    if (isTerminalThemeChoice(term)) setTerminalTheme(term);
  }, [term]);
  // `-harness` 장면: 칸들이 하네스(Claude Code)를 띄운 것으로 둔다. 상태 줄의 가장
  // 긴 단추 문구(「Claude Code 다시 시작」)를 좁은 칸에서 재기 위해서다.
  useMemo(() => {
    if (!scene.includes("-harness")) return;
    for (const id of ["p1", "p2", "p3", "p4"]) sessions.setPendingProgram(id, { kind: "harness", id: "claude" });
  }, [scene, sessions]);

  useMemo(() => {
    try {
      const layout = scene.startsWith("stack3")
        ? stack3Layout()
        : scene === "four" || scene === "full" || scene.endsWith("-four")
          ? fourLayout()
          : defaultWorkbenchLayout();
      window.localStorage.setItem(workbenchLayoutEntry(DOCK_SESSION_KEY), serializeWorkbenchLayout(layout));
    } catch {
      /* 저장소 없는 캡처 */
    }
  }, [scene]);

  useEffect(() => {
    resetDockStateForTest();
    if (scene !== "full") openDock();
    if (scene === "full") toggleDockFullscreen();
  }, [scene]);

  if (scene === "settings-web" || scene === "settings-desktop") {
    return (
      <div className="h-full overflow-auto bg-pane p-6 text-ink">
        <TerminalSection desktop={scene === "settings-desktop"} />
      </div>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-pane text-ink" data-testid="local-terminal-harness">
      <div className={cn("flex min-h-0 flex-1 flex-col gap-2 p-4", dock.open && dock.fullscreen && "hidden")}>
        <h1 className="text-title font-medium"># engine</h1>
        <p className="text-body text-ink-muted">
          채널 화면 자리입니다. ⌃`로 로컬 터미널 도크를 열고 닫습니다.
        </p>
        {scene === "palette" ? (
          <div className="max-w-md">
            <TerminalThemeChoiceGroup />
          </div>
        ) : null}
      </div>
      <LocalTerminalDock sessions={sessions} platform="mac" />
    </main>
  );
}

