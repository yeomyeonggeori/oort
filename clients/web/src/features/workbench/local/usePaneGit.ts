import { useEffect, useRef, useState } from "react";
import {
  paneGitFacts,
  type PaneGitFacts,
} from "@momo/core/features/workbench/sessionList";
import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import { readWorkbenchGit } from "@/lib/tauri";

// 세션 목록의 칸별 git 사실 (#2856). **읽기는 `readWorkbenchGit`(#2855 G1~G8)뿐이다.**
// 새 git 호출·폴더 인자는 없다. 칸마다 G1·G2·G3·G7 넷을 차례로 읽는다.
//
// 읽기는 hook 수명 전체에 걸친 **큐 하나**(`createPaneGitScheduler`)가 한다(검수
// #2951 H1: effect마다 작업자를 새로 띄우면 칸이 붙을 때마다 전체를 다시 읽어 칸 10개에서
// 동시 19건이 떴다).
//
// - 동시에 도는 git 명령은 `MAX_PARALLEL`(2)개를 넘지 않는다. 명령마다 셸이 5초 제한을 둔다.
// - 칸 열쇠는 칸 ID + PTY 번호다. 이미 읽었거나, 큐에 있거나, 읽는 중인 열쇠는 다시
//   넣지 않는다(중복 합치기). 칸이 새로 붙으면 **그 칸만** 읽는다.
// - 다시 읽기(`REFRESH_MS`마다, 창 포커스 복귀): 전 칸을 큐 뒤에 한 번씩. 읽는 중인
//   칸은 끝난 뒤 한 번 더 읽는다고 표시만 한다.
// - 칸이 사라지거나 목록이 닫히면(취소) 그 칸의 남은 명령은 **다음 명령 전에** 멈추고
//   결과를 내지 않는다.
// 결과는 이 기기의 메모리에만 있다(서버로 보내지 않는다).

const READS: readonly GitReadCommand[] = ["g1", "g2", "g3", "g7"];
export const PANE_GIT_MAX_PARALLEL = 2;
export const PANE_GIT_REFRESH_MS = 30_000;

export type PaneGitReader = (command: GitReadCommand, ptyId: number) => Promise<GitReadResult>;

export interface PaneGitScheduler {
  /** 지금 칸 목록(칸 ID → PTY 번호). 새 칸만 큐에 넣고, 사라진 칸은 취소한다. */
  sync(panes: ReadonlyArray<readonly [string, number | null]>): void;
  /** 전 칸을 한 번씩 다시 읽는다. */
  refresh(): void;
  /** 모두 멈춘다. 이후 결과를 내지 않는다. */
  dispose(): void;
}

interface Job {
  paneId: string;
  pty: number;
  key: string;
}

export function createPaneGitScheduler(
  read: PaneGitReader,
  onResult: (paneId: string, facts: PaneGitFacts) => void,
  maxParallel = PANE_GIT_MAX_PARALLEL
): PaneGitScheduler {
  let disposed = false;
  /** 지금 살아 있는 열쇠(칸:PTY). */
  let live = new Map<string, Job>();
  const queue: Job[] = [];
  const queued = new Set<string>();
  const running = new Set<string>();
  /** 읽는 중에 다시 읽기를 요청받은 열쇠. */
  const again = new Set<string>();
  /** 한 번이라도 결과를 낸 열쇠. */
  const done = new Set<string>();

  const enqueue = (job: Job) => {
    if (queued.has(job.key)) return;
    if (running.has(job.key)) {
      again.add(job.key);
      return;
    }
    queued.add(job.key);
    queue.push(job);
  };

  const alive = (job: Job) => !disposed && live.has(job.key);

  const runJob = async (job: Job) => {
    const out: Partial<Record<GitReadCommand, GitReadResult>> = {};
    for (const command of READS) {
      // 취소는 명령 사이마다 본다: 사라진 칸에 남은 명령을 쏘지 않는다.
      if (!alive(job)) return;
      // G1이 저장소가 아니라고 하면 나머지는 읽지 않는다.
      if (command !== "g1" && out.g1?.outcome !== "ok") break;
      try {
        out[command] = await read(command, job.pty);
      } catch {
        out[command] = { outcome: "unknown" };
      }
    }
    if (!alive(job)) return;
    done.add(job.key);
    onResult(
      job.paneId,
      paneGitFacts({ g1: out.g1 ?? null, g2: out.g2 ?? null, g3: out.g3 ?? null, g7: out.g7 ?? null })
    );
  };

  const pump = () => {
    while (!disposed && running.size < maxParallel && queue.length > 0) {
      const job = queue.shift()!;
      queued.delete(job.key);
      if (!live.has(job.key)) continue;
      running.add(job.key);
      void runJob(job).finally(() => {
        running.delete(job.key);
        if (again.delete(job.key) && alive(job)) enqueue(job);
        pump();
      });
    }
  };

  return {
    sync(panes) {
      if (disposed) return;
      const next = new Map<string, Job>();
      for (const [paneId, pty] of panes) {
        if (pty === null) continue;
        const key = `${paneId}:${pty}`;
        next.set(key, live.get(key) ?? { paneId, pty, key });
      }
      live = next;
      // 새 칸만: 이미 읽었거나 읽는 중인 칸은 다시 넣지 않는다(중복 합치기).
      for (const job of next.values()) {
        if (!done.has(job.key) && !running.has(job.key)) enqueue(job);
      }
      pump();
    },
    refresh() {
      if (disposed) return;
      for (const job of live.values()) enqueue(job);
      pump();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      queued.clear();
      again.clear();
    },
  };
}

/**
 * `panes`: 칸 ID → PTY 번호(없으면 null). 돌려주는 맵은 칸 ID → 사실이다.
 * 아직 읽지 못한 칸은 맵에 없다(「확인 중」과 「저장소 아님」을 가른다). 칸이 끝나
 * PTY 번호가 없어져도 마지막 사실은 남긴다(끝난 칸은 셸이 git 읽기를 거절한다).
 */
export function usePaneGit(
  panes: ReadonlyArray<readonly [string, number | null]>,
  { enabled = true, read = readWorkbenchGit }: { enabled?: boolean; read?: PaneGitReader } = {}
): ReadonlyMap<string, PaneGitFacts> {
  const [facts, setFacts] = useState<ReadonlyMap<string, PaneGitFacts>>(new Map());
  const schedulerRef = useRef<PaneGitScheduler | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const key = panes.map(([id, pty]) => `${id}:${pty ?? ""}`).join(",");
  const panesRef = useRef(panes);
  panesRef.current = panes;

  // 큐는 목록이 보이는 동안 하나다.
  useEffect(() => {
    if (!enabled) return;
    const scheduler = createPaneGitScheduler(
      (command, pty) => readRef.current(command, pty),
      (paneId, result) =>
        setFacts((prev) => {
          const before = prev.get(paneId);
          if (before && sameFacts(before, result)) return prev;
          const next = new Map(prev);
          next.set(paneId, result);
          return next;
        })
    );
    schedulerRef.current = scheduler;
    scheduler.sync(panesRef.current);
    const timer = window.setInterval(() => scheduler.refresh(), PANE_GIT_REFRESH_MS);
    const onFocus = () => scheduler.refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    schedulerRef.current?.sync(panesRef.current);
    // 닫힌 칸의 사실을 치운다.
    const liveIds = new Set(panesRef.current.map(([id]) => id));
    setFacts((prev) => {
      if ([...prev.keys()].every((id) => liveIds.has(id))) return prev;
      const next = new Map<string, PaneGitFacts>();
      for (const [id, f] of prev) if (liveIds.has(id)) next.set(id, f);
      return next;
    });
  }, [key]);

  return facts;
}

function sameFacts(a: PaneGitFacts, b: PaneGitFacts): boolean {
  return (
    a.repo === b.repo &&
    a.repoKey === b.repoKey &&
    a.worktree === b.worktree &&
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.isDefault === b.isDefault &&
    a.diff?.added === b.diff?.added &&
    a.diff?.deleted === b.diff?.deleted
  );
}
