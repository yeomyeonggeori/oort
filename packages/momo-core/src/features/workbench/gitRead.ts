// =============================================================================
// 칸 폴더의 로컬 git 읽기 (ADR-0190 D3-c, #2855). 셸 계약은
// `clients/desktop/README.md`의 `workbench_git_read` 줄이다.
//
// - 웹뷰가 넘기는 것은 명령 번호(g1~g8)와 칸 ID뿐이다. 명령·인자·폴더는 넘기지
//   않는다. 셸이 그 칸을 열 때 기록한 폴더에서 고정 인자로 실행한다.
// - 셸이 stdout을 파싱해 아래 필드만 돌려준다. 커밋 제목·본문, 파일 내용,
//   원격 URL, 이메일, 전체 경로(G1·G3은 마지막 경로 요소)는 오지 않는다.
// - 서버로 보내지 않는다. 공유(D4-b)는 합계 숫자만, 공유를 켠 세션에서만이다.
// =============================================================================

/** G1..G8. */
export const GIT_READ_COMMANDS = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"] as const;

export type GitReadCommand = (typeof GIT_READ_COMMANDS)[number];

export interface GitWorktree {
  /** 폴더의 마지막 경로 요소. */
  folder: string;
  /** null = 분리된 HEAD 또는 bare. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitCommit {
  /** 짧은 해시. */
  hash: string;
  /** 커밋 시각(초). */
  time: number;
  /** Co-Authored-By 이름(이메일은 버림). */
  coAuthors: string[];
}

export interface GitDiffFile {
  /** 저장소 기준 상대 경로. 공유 페이로드에는 싣지 않는다(D4-b). */
  path: string;
  /** 이진 파일이면 null. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

export interface GitDiffTotals {
  files: number;
  added: number;
  deleted: number;
  binary: number;
}

export type GitValue =
  /** G1 */
  | { kind: "repo"; name: string }
  /** G2: null = 분리된 HEAD */
  | { kind: "branch"; name: string | null }
  /** G3 */
  | { kind: "worktrees"; worktrees: GitWorktree[] }
  /** G4 */
  | { kind: "aheadBehind"; behind: number; ahead: number }
  /** G5 */
  | { kind: "commits"; commits: GitCommit[] }
  /** G6(작업 폴더 대 HEAD)·G7(기준점 이후) */
  | { kind: "diff"; files: GitDiffFile[]; totals: GitDiffTotals }
  /** G8: 개수만 */
  | { kind: "status"; modified: number; added: number; deleted: number; untracked: number };

export type GitReadResult =
  | { outcome: "ok"; value: GitValue }
  /** G4·G5·G7: 기준점 없음 */
  | { outcome: "noUpstream" }
  /** 확인 못 함: 칸 없음, git 없음, 시간 초과, 실패 */
  | { outcome: "unknown" };

export const GIT_READ_UNKNOWN: GitReadResult = { outcome: "unknown" };

/** 셸 응답의 겉모양만 확인한다. 모르는 모양은 「확인 못 함」이다. */
export function normalizeGitReadResult(raw: unknown): GitReadResult {
  if (typeof raw !== "object" || raw === null) return GIT_READ_UNKNOWN;
  const row = raw as Record<string, unknown>;
  if (row.outcome === "noUpstream") return { outcome: "noUpstream" };
  if (
    row.outcome === "ok" &&
    typeof row.value === "object" &&
    row.value !== null &&
    typeof (row.value as Record<string, unknown>).kind === "string"
  ) {
    return { outcome: "ok", value: row.value as GitValue };
  }
  return GIT_READ_UNKNOWN;
}
