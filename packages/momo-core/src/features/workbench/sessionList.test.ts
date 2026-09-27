import { describe, expect, it } from "vitest";
import type { GitReadResult } from "./gitRead";
import {
  PANE_GIT_UNKNOWN,
  buildSessionList,
  paneGitFacts,
  sessionRowsOf,
  statusFromPhase,
  type PaneGitFacts,
  type SessionListInput,
  type SessionListRow,
} from "./sessionList";

const ok = (value: unknown) => ({ outcome: "ok", value }) as GitReadResult;
const worktrees = ok({
  kind: "worktrees",
  worktrees: [
    { folder: "momo", branch: "main", detached: false, locked: false, prunable: false },
    { folder: "2774-xterm", branch: "feat/2774-xterm", detached: false, locked: false, prunable: false },
    { folder: "push-dup", branch: "fix/push-dup", detached: false, locked: false, prunable: false },
  ],
});

function git(repo: string | null, worktree: string | null, branch: string | null, extra: Partial<PaneGitFacts> = {}): PaneGitFacts {
  return { repo, repoKey: repo, worktree, branch, detached: false, isDefault: worktree === repo, diff: null, ...extra };
}

function pane(index: number, g: PaneGitFacts | null, over: Partial<SessionListInput> = {}): SessionListInput {
  return {
    paneId: `p${index}`,
    index,
    title: `세션 ${index}`,
    harness: "claude",
    status: "running",
    shared: false,
    git: g,
    ...over,
  };
}

/** 행을 사람이 읽는 한 줄씩으로(평탄화·순서를 한눈에 비교). */
function shape(rows: SessionListRow[]): string[] {
  return rows.map((r) => {
    if (r.kind === "group") return `# ${r.label}`;
    if (r.kind === "worktree") return `wt ${r.branch}`;
    return `${r.depth === 1 ? "  " : ""}${r.index}${r.branch ? ` @${r.branch}` : ""}${r.repo ? ` [${r.repo}]` : ""}`;
  });
}

describe("paneGitFacts", () => {
  it("저장소 열쇠는 G1이 아니라 G3의 첫 항목이다(연결된 worktree도 한 저장소)", () => {
    const main = paneGitFacts({ g1: ok({ kind: "repo", name: "momo" }), g2: null, g3: worktrees, g7: null });
    const linked = paneGitFacts({ g1: ok({ kind: "repo", name: "2774-xterm" }), g2: null, g3: worktrees, g7: null });
    expect(main.repo).toBe("momo");
    expect(linked.repo).toBe("momo");
    expect(linked.worktree).toBe("2774-xterm");
    expect(linked.branch).toBe("feat/2774-xterm");
    expect(main.isDefault).toBe(true);
    expect(linked.isDefault).toBe(false);
  });

  it("diff 숫자는 G7뿐이다. 기준점이 없으면 숫자가 없다", () => {
    const g7 = ok({ kind: "diff", files: [], totals: { files: 3, added: 128, deleted: 40, binary: 0 } });
    const withBase = paneGitFacts({ g1: ok({ kind: "repo", name: "momo" }), g2: null, g3: worktrees, g7 });
    expect(withBase.diff).toEqual({ added: 128, deleted: 40 });
    const noBase = paneGitFacts({
      g1: ok({ kind: "repo", name: "momo" }),
      g2: null,
      g3: worktrees,
      g7: { outcome: "noUpstream" },
    });
    expect(noBase.diff).toBeNull();
  });

  it("G1이나 G3을 모르면 저장소가 아니다(「폴더」)", () => {
    expect(paneGitFacts({ g1: { outcome: "unknown" }, g2: null, g3: worktrees, g7: null })).toEqual(PANE_GIT_UNKNOWN);
    expect(
      paneGitFacts({ g1: ok({ kind: "repo", name: "momo" }), g2: null, g3: { outcome: "unknown" }, g7: null })
    ).toEqual(PANE_GIT_UNKNOWN);
  });

  it("G3에 없는 폴더면 G2 브랜치를 쓴다", () => {
    const f = paneGitFacts({
      g1: ok({ kind: "repo", name: "elsewhere" }),
      g2: ok({ kind: "branch", name: "spike/presets" }),
      g3: worktrees,
      g7: null,
    });
    expect(f.branch).toBe("spike/presets");
    expect(f.isDefault).toBe(false);
  });
});

describe("statusFromPhase", () => {
  it("프로세스 단계만 읽는다(#2776 전)", () => {
    expect(statusFromPhase("running")).toBe("running");
    expect(statusFromPhase("starting")).toBe("idle");
    expect(statusFromPhase("exited", 0)).toBe("done");
    expect(statusFromPhase("exited", 1)).toBe("stopped");
    expect(statusFromPhase("exited", null, "SIGKILL")).toBe("stopped");
    expect(statusFromPhase("failed")).toBe("stopped");
    expect(statusFromPhase(null)).toBe("idle");
  });
});

// 시안 ①의 여덟 칸.
const MOCK: SessionListInput[] = [
  pane(1, git("momo", "momo", "main")),
  pane(2, git("momo", "momo", "main"), { status: "idle", harness: "셸" }),
  pane(3, git("momo", "2774-xterm", "feat/2774-xterm"), { status: "waiting", shared: true }),
  pane(4, git("momo", "2774-xterm", "feat/2774-xterm")),
  pane(5, git("momo", "push-dup", "fix/push-dup"), { status: "waiting", shared: true }),
  pane(6, git("momo", "push-dup", "fix/push-dup"), { status: "done", shared: true }),
  pane(7, git("momo", "presets", "spike/presets")),
  pane(8, git("momo", "presets", "spike/presets")),
];

describe("buildSessionList", () => {
  it("시안 ①: 저장소 하나면 머리를 숨기고, worktree는 기본 → 급한 순", () => {
    const m = buildSessionList(MOCK, { filter: "all", grouping: "repo" });
    expect(shape(m.rows)).toEqual([
      "wt main",
      "  1",
      "  2",
      "wt feat/2774-xterm",
      "  3",
      "  4",
      "wt fix/push-dup",
      "  5",
      "  6",
      "wt spike/presets",
      "  7",
      "  8",
    ]);
    expect(m.counts).toEqual({ all: 8, waiting: 2, shared: 3 });
    expect(m.repos).toEqual([{ id: "momo\u0001momo", name: "momo", worktrees: 4, sessions: 8 }]);
  });

  it("세션 안의 순서: 나를 기다림 → 실행 중 → 검토 대기 → 나머지, 같으면 번호", () => {
    const m = buildSessionList(
      [
        pane(1, git("r", "r", "main"), { status: "done" }),
        pane(2, git("r", "r", "main"), { status: "review" }),
        pane(3, git("r", "r", "main"), { status: "running" }),
        pane(4, git("r", "r", "main"), { status: "waiting" }),
        pane(5, git("r", "r", "main"), { status: "running" }),
      ],
      { filter: "all", grouping: "repo" }
    );
    expect(sessionRowsOf(m).map((r) => r.index)).toEqual([4, 3, 5, 2, 1]);
  });

  it("자식 하나 평탄화: 세션 하나뿐인 worktree는 worktree 행이 곧 세션 행이다", () => {
    const m = buildSessionList(
      [
        pane(1, git("momo", "momo", "main")),
        pane(2, git("momo", "momo", "main")),
        pane(3, git("momo", "push-dup", "fix/push-dup", { diff: { added: 42, deleted: 18 } })),
      ],
      { filter: "all", grouping: "repo" }
    );
    expect(shape(m.rows)).toEqual(["wt main", "  1", "  2", "3 @fix/push-dup"]);
    const flat = sessionRowsOf(m).find((r) => r.index === 3)!;
    expect(flat.depth).toBe(0);
    expect(flat.diff).toEqual({ added: 42, deleted: 18 });
  });

  it("저장소가 둘이면 저장소 머리를 보이고, 저장소 아닌 폴더는 「폴더」로 끝에", () => {
    const m = buildSessionList(
      [
        pane(1, PANE_GIT_UNKNOWN, { harness: "셸" }),
        pane(2, git("oort-site", "oort-site", "main")),
        pane(3, git("momo", "momo", "main"), { status: "waiting" }),
      ],
      { filter: "all", grouping: "repo" }
    );
    expect(shape(m.rows)).toEqual(["# momo", "3 @main", "# oort-site", "2 @main", "# 폴더", "1"]);
    // 저장소가 아닌 폴더의 셸은 worktree로 세지 않는다(design-review M1).
    expect(m.repos.find((r) => r.id === null)).toEqual({ id: null, name: "폴더", worktrees: 0, sessions: 1 });
  });

  it("필터: 나를 기다림·공유. 숫자는 필터 전이다", () => {
    const waiting = buildSessionList(MOCK, { filter: "waiting", grouping: "repo" });
    expect(sessionRowsOf(waiting).map((r) => r.index)).toEqual([3, 5]);
    // 걸러진 뒤 worktree마다 하나씩 남으면 평탄화된다.
    expect(shape(waiting.rows)).toEqual(["3 @feat/2774-xterm", "5 @fix/push-dup"]);
    expect(waiting.counts.all).toBe(8);
    const shared = buildSessionList(MOCK, { filter: "shared", grouping: "repo" });
    expect(sessionRowsOf(shared).map((r) => r.index)).toEqual([3, 5, 6]);
    expect(shared.visible).toBe(3);
  });

  it("상태로 묶으면 행마다 브랜치를 싣고, 저장소가 하나면 저장소 이름은 반복하지 않는다(planner 결정)", () => {
    const m = buildSessionList(MOCK, { filter: "all", grouping: "status" });
    expect(shape(m.rows)).toEqual([
      "# 나를 기다림",
      "3 @feat/2774-xterm",
      "5 @fix/push-dup",
      "# 실행 중",
      "1 @main",
      "4 @feat/2774-xterm",
      "7 @spike/presets",
      "8 @spike/presets",
      "# 대기",
      "2 @main",
      "# 끝남",
      "6 @fix/push-dup",
    ]);
  });

  it("상태로 묶기에서 저장소가 둘이면 행마다 저장소 이름, 한 저장소를 고르면 다시 숨긴다", () => {
    const two = [pane(1, git("momo", "momo", "main")), pane(2, git("oort-site", "oort-site", "main"))];
    expect(shape(buildSessionList(two, { filter: "all", grouping: "status" }).rows)).toEqual([
      "# 실행 중",
      "1 @main [momo]",
      "2 @main [oort-site]",
    ]);
    const one = buildSessionList(two, { filter: "all", grouping: "status", repo: "momo\u0001momo" });
    expect(shape(one.rows)).toEqual(["# 실행 중", "1 @main"]);
  });

  it("이름이 같은 다른 저장소(worktree 집합이 다름)는 합치지 않고 「web」「web 2」로 가른다", () => {
    const a = paneGitFacts({
      g1: ok({ kind: "repo", name: "web" }),
      g2: null,
      g3: ok({ kind: "worktrees", worktrees: [{ folder: "web", branch: "main", detached: false, locked: false, prunable: false }] }),
      g7: null,
    });
    const b = paneGitFacts({
      g1: ok({ kind: "repo", name: "web" }),
      g2: null,
      g3: ok({
        kind: "worktrees",
        worktrees: [
          { folder: "web", branch: "main", detached: false, locked: false, prunable: false },
          { folder: "web-fix", branch: "fix/a", detached: false, locked: false, prunable: false },
        ],
      }),
      g7: null,
    });
    expect(a.repoKey).not.toBe(b.repoKey);
    const m = buildSessionList([pane(1, a), pane(2, b)], { filter: "all", grouping: "repo" });
    expect(m.repos.map((r) => r.name)).toEqual(["web", "web 2"]);
    expect(shape(m.rows)).toEqual(["# web", "1 @main", "# web 2", "2 @main"]);
  });

  it("연결 worktree 폴더 이름이 주 worktree와 같으면 G2 브랜치로 고른다", () => {
    const f = paneGitFacts({
      g1: ok({ kind: "repo", name: "app" }),
      g2: ok({ kind: "branch", name: "feat/x" }),
      g3: ok({
        kind: "worktrees",
        worktrees: [
          { folder: "app", branch: "main", detached: false, locked: false, prunable: false },
          { folder: "app", branch: "feat/x", detached: false, locked: false, prunable: false },
        ],
      }),
      g7: null,
    });
    expect(f.branch).toBe("feat/x");
    expect(f.isDefault).toBe(false);
  });

  it("bare 저장소: 이름은 `.git`을 떼거나 「bare 저장소」, 어느 worktree도 「기본」이 아니다", () => {
    const wt = (folder: string, branch: string | null) => ({ folder, branch, detached: false, locked: false, prunable: false });
    const dotBare = paneGitFacts({
      g1: ok({ kind: "repo", name: "main" }),
      g2: null,
      g3: ok({ kind: "worktrees", worktrees: [wt(".bare", null), wt("main", "main")] }),
      g7: null,
    });
    expect(dotBare.repo).toBe("bare 저장소");
    expect(dotBare.isDefault).toBe(false);
    const dotGit = paneGitFacts({
      g1: ok({ kind: "repo", name: "main" }),
      g2: null,
      g3: ok({ kind: "worktrees", worktrees: [wt("tool.git", null), wt("main", "main")] }),
      g7: null,
    });
    expect(dotGit.repo).toBe("tool");
  });

  it("분리된 HEAD인 세션 하나짜리 worktree도 worktree 줄(폴더)을 싣는다", () => {
    const m = buildSessionList(
      [
        pane(1, git("momo", "momo", "main")),
        pane(2, git("momo", "momo", "main")),
        pane(3, git("momo", "bisect", null, { detached: true })),
      ],
      { filter: "all", grouping: "repo" }
    );
    const row = sessionRowsOf(m).find((r) => r.index === 3)!;
    expect(row).toMatchObject({ worktree: "bisect", branch: null, detached: true, depth: 0 });
  });

  it("확인 중(git null)인 세션은 묶지 않고 pending으로, 숫자에는 든다", () => {
    const m = buildSessionList([pane(1, git("momo", "momo", "main")), pane(2, null)], { filter: "all", grouping: "repo" });
    expect(shape(m.rows)).toEqual(["1 @main"]);
    expect(m.pending.map((s) => s.index)).toEqual([2]);
    expect(m.counts.all).toBe(2);
    expect(m.visible).toBe(2);
  });

  it("저장소 선택과 검색", () => {
    const two = [...MOCK, pane(9, git("oort-site", "oort-site", "main"), { title: "랜딩 문구" })];
    expect(buildSessionList(two, { filter: "all", grouping: "repo", repo: "oort-site\u0001oort-site" }).visible).toBe(1);
    const q = buildSessionList(two, { filter: "all", grouping: "repo", query: "PUSH-DUP" });
    expect(sessionRowsOf(q).map((r) => r.index)).toEqual([5, 6]);
    const none = buildSessionList(two, { filter: "all", grouping: "repo", query: "없는 말" });
    expect(none.rows).toEqual([]);
  });
});
