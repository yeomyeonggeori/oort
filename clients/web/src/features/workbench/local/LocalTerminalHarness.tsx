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
import { TerminalSection } from "@/features/settings/TerminalSection";
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
// `?scene=one|four|full|exited|failed|exited-four|failed-four|exited-harness-four|settings-web|settings-desktop`

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

/** 브라우저용 흉내 PTY. 입력을 그대로 되울리고, Enter에 새 프롬프트를 낸다. */
function demoPty(mode: "live" | "exited" | "failed" = "live"): PtyPort {
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
        emit(id, BANNER);
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
        pty: demoPty(scene.startsWith("exited") ? "exited" : scene.startsWith("failed") ? "failed" : "live"),
        loadMirror: loadBrowserMirror,
        storage: () => null,
      }),
    [scene]
  );
  const dock = useDockState();
  // `-harness` 장면: 칸들이 하네스(Claude Code)를 띄운 것으로 둔다. 상태 줄의 가장
  // 긴 단추 문구(「Claude Code 다시 시작」)를 좁은 칸에서 재기 위해서다.
  useMemo(() => {
    if (!scene.includes("-harness")) return;
    for (const id of ["p1", "p2", "p3", "p4"]) sessions.setPendingProgram(id, { kind: "harness", id: "claude" });
  }, [scene, sessions]);

  useMemo(() => {
    try {
      const layout = scene === "four" || scene === "full" || scene.endsWith("-four") ? fourLayout() : defaultWorkbenchLayout();
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
      </div>
      <LocalTerminalDock sessions={sessions} platform="mac" />
    </main>
  );
}

