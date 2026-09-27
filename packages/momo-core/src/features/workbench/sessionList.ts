import type { GitDiffTotals, GitReadResult, GitWorktree } from "./gitRead";

// =============================================================================
// 작업 탭 세션 목록 (#2856, 제안서 §3.2, 시안 ①②의 `.slist`).
//
// 저장소 → worktree → 세션 세 단. 모든 git 사실은 칸마다 `readWorkbenchGit`
// (#2855 G1~G8)이 준 것만 쓴다. 이 모듈은 새 git 호출을 하지 않는다.
//
// - **저장소 열쇠는 G3의 첫 항목(주 worktree 폴더)**이다. G1(`--show-toplevel`)은
//   연결된 worktree에서 그 worktree 폴더를 준다. G1로 묶으면 한 저장소가 worktree
//   수만큼 쪼개진다.
// - **worktree**는 G3 목록에서 G1 폴더와 같은 항목이다. 첫 항목이 「기본」이다.
//   브랜치는 그 항목의 것, 없으면 G2다.
// - **diff 숫자**는 G7(`@{upstream}...HEAD`)뿐이다. 기준점이 없으면 숫자를 보이지
//   않는다. G6(작업 폴더 대 HEAD)을 같은 숫자인 것처럼 대신 쓰지 않는다.
// - 칸 폴더는 셸이 칸을 열 때 기록한 폴더다(`pty_spawn` cwd). 셸 안에서 `cd`해도
//   바뀌지 않는다.
//
// 상태 어휘는 제안서 §3.4의 모양 + 글자다. 이 목록은 상태를 **판정하지 않는다**.
// 「나를 기다림」「검토 대기」「대기」의 출처(OSC·hook)는 #2776이 세운다. 그 전에는
// 칸의 프로세스 단계(`running`·`exited`·`failed`)가 주는 것만 보인다.
// =============================================================================

export type SessionStatus = "waiting" | "running" | "review" | "idle" | "done" | "stopped";

/** 정렬 순서: 나를 기다림 → 실행 중 → 검토 대기 → 나머지(§3.2, ADR-0188 D4). */
export const SESSION_STATUS_ORDER: readonly SessionStatus[] = [
  "waiting",
  "running",
  "review",
  "idle",
  "done",
  "stopped",
];

export const SESSION_STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  waiting: "나를 기다림",
  running: "실행 중",
  review: "검토 대기",
  idle: "대기",
  done: "끝남",
  stopped: "멈춤",
};

export type SessionPhaseInput = "starting" | "running" | "exited" | "failed";

/**
 * 칸의 프로세스 단계를 상태 어휘로 읽는다. #2776 전에는 이것이 전부다.
 * 종료 코드 0은 「끝남」, 그 밖의 종료와 시작 실패는 「멈춤」(§3.4 표).
 */
export function statusFromPhase(
  phase: SessionPhaseInput | null,
  exitCode: number | null = null,
  exitSignal: string | number | null = null
): SessionStatus {
  if (phase === "running") return "running";
  if (phase === "failed") return "stopped";
  if (phase === "exited") return exitCode === 0 && exitSignal === null ? "done" : "stopped";
  return "idle";
}

/** 칸 하나의 git 사실. 모르면 필드가 null이다. */
export interface PaneGitFacts {
  /** 저장소 표시 이름(G3 첫 항목의 폴더). null = 저장소가 아니거나 모름. */
  repo: string | null;
  /** 이 칸의 worktree 폴더(G1). */
  worktree: string | null;
  branch: string | null;
  detached: boolean;
  /** G3의 첫 항목(주 worktree)인가. */
  isDefault: boolean;
  /** G7 합계. null = 기준점 없음 또는 모름. */
  diff: Pick<GitDiffTotals, "added" | "deleted"> | null;
}

export const PANE_GIT_UNKNOWN: PaneGitFacts = {
  repo: null,
  worktree: null,
  branch: null,
  detached: false,
  isDefault: false,
  diff: null,
};

/**
 * G1·G2·G3·G7 네 답을 칸 하나의 사실로 합친다. G1이나 G3을 모르면 저장소가
 * 아닌 것으로 본다(「폴더」 묶음).
 */
export function paneGitFacts(reads: {
  g1: GitReadResult | null;
  g2: GitReadResult | null;
  g3: GitReadResult | null;
  g7: GitReadResult | null;
}): PaneGitFacts {
  const top = reads.g1?.outcome === "ok" && reads.g1.value.kind === "repo" ? reads.g1.value.name : null;
  const list: GitWorktree[] | null =
    reads.g3?.outcome === "ok" && reads.g3.value.kind === "worktrees" ? reads.g3.value.worktrees : null;
  if (top === null || list === null || list.length === 0) return PANE_GIT_UNKNOWN;
  const main = list[0]!;
  const mine = list.find((w) => w.folder === top) ?? null;
  const g2Branch =
    reads.g2?.outcome === "ok" && reads.g2.value.kind === "branch" ? reads.g2.value.name : null;
  const branch = mine?.branch ?? g2Branch;
  const diff =
    reads.g7?.outcome === "ok" && reads.g7.value.kind === "diff"
      ? { added: reads.g7.value.totals.added, deleted: reads.g7.value.totals.deleted }
      : null;
  return {
    repo: main.folder,
    worktree: top,
    branch,
    detached: mine?.detached ?? branch === null,
    isDefault: mine === main,
    diff,
  };
}

/** 목록이 받는 칸 하나. */
export interface SessionListInput {
  paneId: string;
  /** 칸 번호(격자 순서, 1부터). ⌃1–9와 같은 번호다. */
  index: number;
  /** 작업 이름(OSC 제목, 없으면 프로그램 이름). */
  title: string;
  /** 하네스 표시(claude·codex·셸). */
  harness: string;
  status: SessionStatus;
  /** 팀에 공유 중인가(ADR-0190 D4). L 세션 공유가 서기 전에는 늘 false. */
  shared: boolean;
  git: PaneGitFacts;
}

export type SessionFilter = "all" | "waiting" | "shared";
export type SessionGrouping = "repo" | "status";

export interface SessionRow {
  kind: "session";
  paneId: string;
  index: number;
  title: string;
  harness: string;
  status: SessionStatus;
  shared: boolean;
  /**
   * 평탄화된 줄이면 worktree 이름(브랜치)을 함께 싣는다(자식이 하나뿐인
   * worktree는 worktree 행이 곧 세션 행이다).
   */
  branch: string | null;
  diff: PaneGitFacts["diff"];
  isDefault: boolean;
  /** 저장소로 묶지 않을 때 행마다 저장소 이름(Orca #13937). */
  repo: string | null;
  /** 들여쓰기 깊이: 0 = 머리 없이 맨 위, 1 = worktree 밑. */
  depth: 0 | 1;
}

export interface WorktreeRow {
  kind: "worktree";
  key: string;
  branch: string | null;
  folder: string;
  isDefault: boolean;
  diff: PaneGitFacts["diff"];
}

export interface GroupHeader {
  kind: "group";
  key: string;
  label: string;
  count: number;
  /** 상태로 묶을 때의 상태. */
  status?: SessionStatus;
}

export type SessionListRow = GroupHeader | WorktreeRow | SessionRow;

export interface SessionListModel {
  rows: SessionListRow[];
  /** 필터 칩의 숫자(저장소 선택 뒤, 필터 전). */
  counts: Record<SessionFilter, number>;
  /** 저장소 선택기의 목록(이름순). 「폴더」 묶음은 null 이름이다. */
  repos: { name: string | null; worktrees: number; sessions: number }[];
  /** 필터를 거친 세션 수. */
  visible: number;
}

export interface SessionListOptions {
  filter: SessionFilter;
  grouping: SessionGrouping;
  /** 한 저장소만 보기. undefined = 전부. null = 「폴더」(저장소 아님). */
  repo?: string | null;
  /** 검색어(작업 이름·브랜치·하네스·저장소). */
  query?: string;
}

/** 「폴더」 묶음 이름(저장소가 아닌 폴더의 셸, §3.2). */
export const FOLDER_GROUP_LABEL = "폴더";

const rank = (s: SessionStatus) => SESSION_STATUS_ORDER.indexOf(s);

function compareSessions(a: SessionListInput, b: SessionListInput): number {
  return rank(a.status) - rank(b.status) || a.index - b.index;
}

function matchesFilter(s: SessionListInput, filter: SessionFilter): boolean {
  if (filter === "waiting") return s.status === "waiting";
  if (filter === "shared") return s.shared;
  return true;
}

function matchesQuery(s: SessionListInput, query: string): boolean {
  if (query === "") return true;
  const hay = [s.title, s.harness, s.git.branch ?? "", s.git.repo ?? "", String(s.index)]
    .join("\n")
    .toLocaleLowerCase();
  return hay.includes(query);
}

function sessionRow(s: SessionListInput, depth: 0 | 1, flattened: boolean, showRepo: boolean): SessionRow {
  return {
    kind: "session",
    paneId: s.paneId,
    index: s.index,
    title: s.title,
    harness: s.harness,
    status: s.status,
    shared: s.shared,
    branch: flattened ? s.git.branch : null,
    diff: flattened ? s.git.diff : null,
    isDefault: flattened ? s.git.isDefault : false,
    repo: showRepo ? s.git.repo ?? FOLDER_GROUP_LABEL : null,
    depth,
  };
}

/** 저장소 안의 worktree 묶음과 그 세션. 정렬: 기본 → 가장 급한 세션 → 가장 작은 번호. */
function worktreeGroups(sessions: SessionListInput[]) {
  const byWorktree = new Map<string, SessionListInput[]>();
  for (const s of sessions) {
    const key = s.git.worktree ?? `pane:${s.paneId}`;
    const list = byWorktree.get(key);
    if (list) list.push(s);
    else byWorktree.set(key, [s]);
  }
  const groups = [...byWorktree.entries()].map(([key, list]) => ({
    key,
    list: [...list].sort(compareSessions),
  }));
  groups.sort((a, b) => {
    const da = a.list[0]!.git.isDefault ? 0 : 1;
    const db = b.list[0]!.git.isDefault ? 0 : 1;
    return da - db || compareSessions(a.list[0]!, b.list[0]!);
  });
  return groups;
}

export function buildSessionList(
  inputs: readonly SessionListInput[],
  options: SessionListOptions
): SessionListModel {
  // 저장소 선택기의 목록은 선택·필터 전의 전부다.
  const repoMap = new Map<string | null, { worktrees: Set<string>; sessions: number }>();
  for (const s of inputs) {
    const entry = repoMap.get(s.git.repo) ?? { worktrees: new Set<string>(), sessions: 0 };
    entry.sessions += 1;
    entry.worktrees.add(s.git.worktree ?? `pane:${s.paneId}`);
    repoMap.set(s.git.repo, entry);
  }
  const repos = [...repoMap.entries()]
    .map(([name, e]) => ({ name, worktrees: e.worktrees.size, sessions: e.sessions }))
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));

  const inRepo =
    options.repo === undefined ? [...inputs] : inputs.filter((s) => s.git.repo === options.repo);
  const counts: Record<SessionFilter, number> = {
    all: inRepo.length,
    waiting: inRepo.filter((s) => matchesFilter(s, "waiting")).length,
    shared: inRepo.filter((s) => matchesFilter(s, "shared")).length,
  };
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  const visible = inRepo.filter((s) => matchesFilter(s, options.filter) && matchesQuery(s, query));

  const rows: SessionListRow[] = [];
  if (options.grouping === "status") {
    // 상태로 묶으면 행마다 저장소 이름을 보인다. 브랜치도 함께(평탄화와 같은 모양).
    for (const status of SESSION_STATUS_ORDER) {
      const list = visible.filter((s) => s.status === status).sort(compareSessions);
      if (list.length === 0) continue;
      rows.push({ kind: "group", key: `status:${status}`, label: SESSION_STATUS_LABEL[status], count: list.length, status });
      for (const s of list) rows.push(sessionRow(s, 0, true, true));
    }
    return { rows, counts, repos, visible: visible.length };
  }

  const byRepo = new Map<string | null, SessionListInput[]>();
  for (const s of visible) {
    const list = byRepo.get(s.git.repo);
    if (list) list.push(s);
    else byRepo.set(s.git.repo, [s]);
  }
  const repoKeys = [...byRepo.keys()].sort((a, b) => {
    // 가장 급한 세션이 있는 저장소가 먼저, 「폴더」는 끝.
    if (a === null) return 1;
    if (b === null) return -1;
    const ra = Math.min(...byRepo.get(a)!.map((s) => rank(s.status)));
    const rb = Math.min(...byRepo.get(b)!.map((s) => rank(s.status)));
    return ra - rb || a.localeCompare(b);
  });
  // 자식이 하나뿐인 단계는 접는다: 저장소가 하나뿐이면 저장소 머리를 숨긴다.
  const showRepoHeader = repoKeys.length > 1;
  for (const repo of repoKeys) {
    const sessions = byRepo.get(repo)!;
    if (showRepoHeader) {
      rows.push({
        kind: "group",
        key: `repo:${repo ?? ""}`,
        label: repo ?? FOLDER_GROUP_LABEL,
        count: sessions.length,
      });
    }
    for (const group of worktreeGroups(sessions)) {
      const first = group.list[0]!;
      // 저장소가 아닌 폴더의 셸은 worktree 단이 없다.
      if (repo === null || first.git.worktree === null) {
        for (const s of group.list) rows.push(sessionRow(s, 0, false, false));
        continue;
      }
      // 세션 하나뿐인 worktree는 worktree 행이 곧 세션 행이다.
      if (group.list.length === 1) {
        rows.push(sessionRow(first, 0, true, false));
        continue;
      }
      rows.push({
        kind: "worktree",
        key: `wt:${repo}:${group.key}`,
        branch: first.git.branch,
        folder: first.git.worktree,
        isDefault: first.git.isDefault,
        diff: first.git.diff,
      });
      for (const s of group.list) rows.push(sessionRow(s, 1, false, false));
    }
  }
  return { rows, counts, repos, visible: visible.length };
}

/** 목록에서 세션 행만(⌘J 뒤 ↑↓ 이동 순서). */
export function sessionRowsOf(model: SessionListModel): SessionRow[] {
  return model.rows.filter((r): r is SessionRow => r.kind === "session");
}

/** 필터가 비었을 때 한 줄(§5 states: 한 문장 + 한 행동). */
export const SESSION_LIST_EMPTY: Readonly<Record<SessionFilter, string>> = {
  all: "이 기기에서 연 세션이 없습니다.",
  waiting: "나를 기다리는 세션이 없습니다.",
  shared: "팀에 공유한 세션이 없습니다.",
};

export const SESSION_FILTER_LABEL: Readonly<Record<SessionFilter, string>> = {
  all: "전부",
  waiting: "나를 기다림",
  shared: "공유",
};

export const SESSION_GROUPING_LABEL: Readonly<Record<SessionGrouping, string>> = {
  repo: "저장소",
  status: "상태",
};
