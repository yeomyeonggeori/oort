import { useEffect, useRef, useState } from "react";
import {
  PANE_GIT_UNKNOWN,
  paneGitFacts,
  type PaneGitFacts,
} from "@momo/core/features/workbench/sessionList";
import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import { readWorkbenchGit } from "@/lib/tauri";

// 세션 목록의 칸별 git 사실 (#2856). **읽기는 `readWorkbenchGit`(#2855 G1~G8)뿐이다.**
// 새 git 호출·폴더 인자는 없다. 칸마다 G1·G2·G3·G7 넷을 차례로 읽는다.
//
// - 칸 열쇠는 셸의 PTY 번호(`ptyIdOf`)다. 시작 중이라 번호가 없는 칸은 읽지 않는다.
// - 한 번에 두 칸까지(`MAX_PARALLEL`). 칸 여덟이면 명령 32번이고, 명령마다 셸이
//   5초 시간 제한을 둔다. 한꺼번에 쏘지 않는다.
// - 다시 읽기: 칸의 PTY가 바뀔 때, 창에 포커스가 돌아올 때, 목록이 보이는 동안
//   `REFRESH_MS`마다. 결과는 이 기기의 메모리에만 있다(서버로 보내지 않는다).

const READS: readonly GitReadCommand[] = ["g1", "g2", "g3", "g7"];
const MAX_PARALLEL = 2;
export const PANE_GIT_REFRESH_MS = 30_000;

export type PaneGitReader = (command: GitReadCommand, ptyId: number) => Promise<GitReadResult>;

async function readPane(ptyId: number, read: PaneGitReader): Promise<PaneGitFacts> {
  const out: Partial<Record<GitReadCommand, GitReadResult>> = {};
  for (const command of READS) {
    // G1이 저장소가 아니라고 하면 나머지는 읽지 않는다.
    if (command !== "g1" && out.g1?.outcome !== "ok") break;
    out[command] = await read(command, ptyId);
  }
  return paneGitFacts({ g1: out.g1 ?? null, g2: out.g2 ?? null, g3: out.g3 ?? null, g7: out.g7 ?? null });
}

/**
 * `panes`: 칸 ID → PTY 번호(없으면 null). 돌려주는 맵은 칸 ID → 사실이다.
 * 아직 읽지 못한 칸은 맵에 없다(「확인 중」과 「저장소 아님」을 가른다).
 */
export function usePaneGit(
  panes: ReadonlyArray<readonly [string, number | null]>,
  { enabled = true, read = readWorkbenchGit }: { enabled?: boolean; read?: PaneGitReader } = {}
): ReadonlyMap<string, PaneGitFacts> {
  const [facts, setFacts] = useState<ReadonlyMap<string, PaneGitFacts>>(new Map());
  const [tick, setTick] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const key = panes.map(([id, pty]) => `${id}:${pty ?? ""}`).join(",");

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), PANE_GIT_REFRESH_MS);
    const onFocus = () => setTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const queue = key === "" ? [] : key.split(",").map((entry) => {
      const [id, pty] = entry.split(":") as [string, string];
      return { id, pty: pty === "" ? null : Number(pty) };
    });
    const live = new Set(queue.map((q) => q.id));
    // 닫힌 칸의 사실을 치운다. PTY 번호가 없는 칸(시작 중·끝남)은 저장소 아님이 아니라 모름이다.
    setFacts((prev) => {
      const next = new Map<string, PaneGitFacts>();
      for (const [id, f] of prev) if (live.has(id)) next.set(id, f);
      return next;
    });
    const work = queue.filter((q): q is { id: string; pty: number } => q.pty !== null);
    const runOne = async () => {
      while (alive && work.length > 0) {
        const { id, pty } = work.shift()!;
        let result: PaneGitFacts;
        try {
          result = await readPane(pty, readRef.current);
        } catch {
          result = PANE_GIT_UNKNOWN;
        }
        if (!alive) return;
        setFacts((prev) => {
          const before = prev.get(id);
          if (before && sameFacts(before, result)) return prev;
          const next = new Map(prev);
          next.set(id, result);
          return next;
        });
      }
    };
    for (let i = 0; i < MAX_PARALLEL; i += 1) void runOne();
    return () => {
      alive = false;
    };
  }, [key, tick, enabled]);

  return facts;
}

function sameFacts(a: PaneGitFacts, b: PaneGitFacts): boolean {
  return (
    a.repo === b.repo &&
    a.worktree === b.worktree &&
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.isDefault === b.isDefault &&
    a.diff?.added === b.diff?.added &&
    a.diff?.deleted === b.diff?.deleted
  );
}
