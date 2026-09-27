import { describe, expect, it } from "vitest";
import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import { PANE_GIT_MAX_PARALLEL, createPaneGitScheduler } from "./usePaneGit";

// 검수 #2951 H1: 칸이 차례로 붙고 창 포커스가 돌아와도 동시 git 명령은 2를 넘지 않고,
// 칸마다 네 번(G1·G2·G3·G7)만 읽고, 사라진 칸·멈춘 큐는 다음 명령을 쏘지 않는다.

function fakeGit() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const waiting: Array<() => void> = [];
  const read = (command: GitReadCommand, pty: number): Promise<GitReadResult> => {
    calls.push(`${command}:${pty}`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      waiting.push(() => {
        inFlight -= 1;
        resolve(
          command === "g1"
            ? { outcome: "ok", value: { kind: "repo", name: "momo" } }
            : command === "g3"
              ? {
                  outcome: "ok",
                  value: {
                    kind: "worktrees",
                    worktrees: [{ folder: "momo", branch: "main", detached: false, locked: false, prunable: false }],
                  },
                }
              : { outcome: "noUpstream" }
        );
      });
    });
  };
  /** 기다리는 명령을 하나씩 끝낸다(마이크로태스크를 비우며). */
  const drain = async () => {
    for (let guard = 0; guard < 1000; guard += 1) {
      await new Promise((r) => setTimeout(r, 0));
      const next = waiting.shift();
      if (!next) return;
      next();
    }
  };
  return { read, calls, drain, stats: () => ({ inFlight, maxInFlight }), waiting };
}

const panes = (n: number) => Array.from({ length: n }, (_, i) => [`p${i + 1}`, i + 1] as const);

describe("createPaneGitScheduler", () => {
  it("칸 10개가 하나씩 붙고 그 사이 창 포커스가 돌아와도 동시 ≤ 2, 칸당 4번", async () => {
    const git = fakeGit();
    const results: string[] = [];
    const scheduler = createPaneGitScheduler(git.read, (id) => results.push(id));
    for (let n = 1; n <= 10; n += 1) {
      scheduler.sync(panes(n));
      // 읽기가 끝나기 전에 다음 칸이 붙는다(복원 순간). 포커스 복귀도 섞는다.
      if (n % 3 === 0) scheduler.refresh();
      const one = git.waiting.shift();
      one?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await git.drain();
    expect(git.stats().maxInFlight).toBeLessThanOrEqual(PANE_GIT_MAX_PARALLEL);
    const perPane = new Map<string, number>();
    for (const c of git.calls) perPane.set(c.split(":")[1]!, (perPane.get(c.split(":")[1]!) ?? 0) + 1);
    // 포커스 복귀(refresh)는 이미 읽은 칸을 한 번 더 읽으므로 칸당 최대 8(두 바퀴), 새로 붙은
    // 칸마다 전체를 다시 읽던 때(총 108)와 가른다.
    expect(Math.max(...perPane.values())).toBeLessThanOrEqual(8);
    expect(git.calls.length).toBeLessThanOrEqual(10 * 4 + 3 * 4 * 10);
    expect(new Set(results)).toEqual(new Set(panes(10).map(([id]) => id)));
  });

  it("다시 읽기 없이 칸이 붙기만 하면 칸당 정확히 4번(재읽기 전)", async () => {
    const git = fakeGit();
    const scheduler = createPaneGitScheduler(git.read, () => undefined);
    for (let n = 1; n <= 10; n += 1) scheduler.sync(panes(n));
    await git.drain();
    const counts = new Map<string, number>();
    for (const c of git.calls) counts.set(c.split(":")[1]!, (counts.get(c.split(":")[1]!) ?? 0) + 1);
    expect([...counts.values()]).toEqual(Array(10).fill(4));
    expect(git.stats().maxInFlight).toBe(PANE_GIT_MAX_PARALLEL);
  });

  it("멈춘(dispose) 뒤에는 다음 명령을 쏘지 않고 결과도 내지 않는다", async () => {
    const git = fakeGit();
    const results: string[] = [];
    const scheduler = createPaneGitScheduler(git.read, (id) => results.push(id));
    scheduler.sync(panes(4));
    expect(git.calls).toEqual(["g1:1", "g1:2"]);
    scheduler.dispose();
    await git.drain();
    expect(git.calls).toEqual(["g1:1", "g1:2"]);
    expect(results).toEqual([]);
  });

  it("사라진 칸은 다음 명령 전에 멈춘다", async () => {
    const git = fakeGit();
    const results: string[] = [];
    const scheduler = createPaneGitScheduler(git.read, (id) => results.push(id));
    scheduler.sync(panes(1));
    scheduler.sync([]);
    await git.drain();
    expect(git.calls).toEqual(["g1:1"]);
    expect(results).toEqual([]);
  });
});
