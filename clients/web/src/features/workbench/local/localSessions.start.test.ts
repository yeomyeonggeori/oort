import { describe, expect, it } from "vitest";
import type { PtySpawnRequest } from "@/lib/tauri";
import { createLocalSessions, type MirrorTerminal } from "./localSessions";

// #2775: 칸의 시작 위치. 셸에 보낸 요청의 cwd와 worktree 생성 횟수를 잰다.

function setup(opts: { worktree?: (repo: string) => Promise<{ path: string }> } = {}) {
  const spawns: PtySpawnRequest[] = [];
  const exits: Array<(exit: { id: number; code: number; signal: null }) => void> = [];
  let id = 1;
  const mirror = (): MirrorTerminal => ({
    cols: 80,
    rows: 24,
    write: (_d, cb) => cb?.(),
    resize: () => undefined,
    dispose: () => undefined,
    onTitleChange: () => ({ dispose: () => undefined }),
  });
  const sessions = createLocalSessions({
    pty: {
      spawn: async (request, _out, onExit) => {
        spawns.push(request);
        exits.push(onExit as never);
        return id++;
      },
      write: async () => undefined,
      resize: async () => undefined,
      kill: async () => undefined,
      ack: async () => undefined,
    },
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
    loadMirror: async () => ({ create: () => ({ mirror: mirror(), serialize: () => "" }) }),
    storage: () => null,
  });
  return { sessions, spawns, exits };
}

describe("칸의 시작 위치 (#2775)", () => {
  it("시작 위치를 주지 않으면 cwd를 보내지 않는다(홈)", async () => {
    const { sessions, spawns } = setup();
    sessions.setPendingProgram("p1", { kind: "shell" });
    await sessions.ensure("p1", 80, 24);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).not.toHaveProperty("cwd");
  });

  it("폴더를 주면 그 폴더가 spawn의 cwd로 간다", async () => {
    const { sessions, spawns } = setup();
    sessions.setPendingProgram("p1", { kind: "shell" }, { cwd: "/Users/t/projects/oort", worktree: false });
    await sessions.ensure("p1", 80, 24);
    expect(spawns[0]?.cwd).toBe("/Users/t/projects/oort");
  });

  it("worktree를 고르면 먼저 만들고 그 폴더에서 띄운다. 다시 시작해도 또 만들지 않는다", async () => {
    const made: string[] = [];
    const { sessions, spawns, exits } = setup({
      worktree: async (repo) => {
        made.push(repo);
        return { path: "/Users/t/.oort/worktrees/oort/wt-aaaa1111" };
      },
    });
    sessions.setPendingProgram("p1", { kind: "shell" }, { cwd: "/Users/t/projects/oort", worktree: true });
    await sessions.ensure("p1", 80, 24);
    expect(made).toEqual(["/Users/t/projects/oort"]);
    expect(spawns[0]?.cwd).toBe("/Users/t/.oort/worktrees/oort/wt-aaaa1111");
    exits[0]!({ id: 1, code: 0, signal: null });
    await sessions.restart("p1");
    expect(made).toHaveLength(1);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.cwd).toBe("/Users/t/.oort/worktrees/oort/wt-aaaa1111");
  });

  it("worktree를 못 만들면 PTY를 띄우지 않고 칸이 실패 상태가 된다", async () => {
    const { sessions, spawns } = setup({
      worktree: async () => {
        throw new Error("worktree_failed: git refused");
      },
    });
    sessions.setPendingProgram("p1", { kind: "shell" }, { cwd: "/Users/t/projects/oort", worktree: true });
    await sessions.ensure("p1", 80, 24);
    expect(spawns).toEqual([]);
    const view = sessions.getSnapshot().get("p1");
    expect(view?.phase).toBe("failed");
    expect(view?.error).toBe("worktree_failed: git refused");
  });

  it("worktree를 만들 수단이 없으면 원래 폴더로 가지 않고 실패한다", async () => {
    const { sessions, spawns } = setup();
    sessions.setPendingProgram("p1", { kind: "shell" }, { cwd: "/Users/t/projects/oort", worktree: true });
    await sessions.ensure("p1", 80, 24);
    expect(spawns).toEqual([]);
    expect(sessions.getSnapshot().get("p1")?.phase).toBe("failed");
  });

  it("셸이 폴더를 거부하면 칸이 실패 상태가 되고 원문은 풀이에 남는다", async () => {
    const spawnError = new Error("refused: folder does not exist");
    const sessions = createLocalSessions({
      pty: {
        spawn: async () => {
          throw spawnError;
        },
        write: async () => undefined,
        resize: async () => undefined,
        kill: async () => undefined,
        ack: async () => undefined,
      },
      loadMirror: async () => ({
        create: () => ({
          mirror: {
            cols: 80,
            rows: 24,
            write: (_d, cb) => cb?.(),
            resize: () => undefined,
            dispose: () => undefined,
            onTitleChange: () => ({ dispose: () => undefined }),
          },
          serialize: () => "",
        }),
      }),
      storage: () => null,
    });
    sessions.setPendingProgram("p1", { kind: "shell" }, { cwd: "/gone", worktree: false });
    await sessions.ensure("p1", 80, 24);
    expect(sessions.getSnapshot().get("p1")).toMatchObject({
      phase: "failed",
      error: "refused: folder does not exist",
    });
  });
});
