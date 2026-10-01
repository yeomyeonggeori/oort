// 새 세션이 어디서 시작하는가(#2775, ADR-0190 D3-c 증보 2026-10-01).
//
// 성재 결재(2026-10-01): 「1번으로 하되, 워크트리로 할지도 선택으로 해줘. 기본은
// 안쓰는게 기본. … 기본 폴더 기준으로.」 → 시작 위치는 최근 프로젝트 · 폴더 고르기 ·
// 홈에서 시작이고, 마지막에 쓴 곳이 기본이다(처음은 홈). worktree 격리는 선택이며
// 기본은 끔이다.
//
// 이 파일은 순수 규칙과 이 기기 저장(localStorage)만 맡는다. 폴더 검사·고르기·
// worktree 생성은 셸이 한다(`desktopStart`). 경로는 셸이 돌려준 정규화된 것만 저장한다.

import type { FolderFacts, FolderRepoState } from "@/lib/tauri";

export type StartFolder = FolderFacts;

/** 홈이거나, 셸이 검사한 폴더 하나. */
export type StartChoice = { kind: "home" } | { kind: "folder"; folder: StartFolder };

export interface StartState {
  choice: StartChoice;
  /** 이 기기에서 쓴 폴더, 최근 순. */
  recent: StartFolder[];
}

/** 이 기기에만 있다(서버에 가지 않는다). */
export const START_STORAGE_KEY = "oort.workbench.startLocation.v1";
export const RECENT_MAX = 5;

export const HOME_START_STATE: StartState = { choice: { kind: "home" }, recent: [] };

export const START_COPY = {
  heading: "시작 위치",
  home: "홈에서 시작",
  homeMeta: "기본",
  recent: "최근 프로젝트",
  pick: "폴더 고르기…",
  worktree: "새 worktree에서 격리",
  worktreeOff: "git 저장소를 고르면 켤 수 있어요",
  worktreeNoCommit: "아직 커밋이 없어서 쓸 수 없어요",
  worktreeHome: "홈에서는 쓸 수 없어요",
  worktreeHint: "원래 폴더는 그대로 두고, 새 브랜치로 따로 작업해요",
  cloud: "다른 기기·클라우드는 연결되면 나타나요",
  checking: "폴더를 확인하고 있어요",
  folderGone: "고른 폴더를 찾을 수 없어서 홈에서 시작해요.",
  makingWorktree: "worktree를 만들고 있어요",
} as const;

function isRepoState(value: unknown): value is FolderRepoState {
  return value === "none" || value === "empty" || value === "ready";
}

function parseFolder(raw: unknown): StartFolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.path !== "string" || !row.path.startsWith("/")) return null;
  if (typeof row.name !== "string") return null;
  return { path: row.path, name: row.name, repo: isRepoState(row.repo) ? row.repo : "none" };
}

export interface StartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StartStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 저장된 상태. 없거나 깨졌으면 홈, 최근 없음. */
export function readStartState(storage: StartStorage | null = browserStorage()): StartState {
  try {
    const raw = storage?.getItem(START_STORAGE_KEY);
    if (!raw) return HOME_START_STATE;
    const data = JSON.parse(raw) as { choice?: unknown; recent?: unknown };
    const recent: StartFolder[] = [];
    if (Array.isArray(data.recent)) {
      for (const row of data.recent) {
        const folder = parseFolder(row);
        if (folder !== null && !recent.some((r) => r.path === folder.path)) recent.push(folder);
        if (recent.length === RECENT_MAX) break;
      }
    }
    const choiceRow = data.choice as { kind?: unknown; folder?: unknown } | undefined;
    const folder = choiceRow?.kind === "folder" ? parseFolder(choiceRow.folder) : null;
    return { choice: folder ? { kind: "folder", folder } : { kind: "home" }, recent };
  } catch {
    return HOME_START_STATE;
  }
}

export function writeStartState(state: StartState, storage: StartStorage | null = browserStorage()): void {
  try {
    storage?.setItem(START_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 저장하지 못해도 이번 실행에서는 쓴다 */
  }
}

/** 폴더를 최근 맨 앞으로(같은 경로는 하나, 최대 `RECENT_MAX`). */
export function rememberFolder(recent: readonly StartFolder[], folder: StartFolder): StartFolder[] {
  return [folder, ...recent.filter((r) => r.path !== folder.path)].slice(0, RECENT_MAX);
}

export function forgetFolder(recent: readonly StartFolder[], path: string): StartFolder[] {
  return recent.filter((r) => r.path !== path);
}

/** 이 선택의 cwd. 홈은 없음(셸이 홈을 쓴다). */
export function cwdOf(choice: StartChoice): string | null {
  return choice.kind === "folder" ? choice.folder.path : null;
}

/** 메뉴 줄에 쓰는 이름. */
export function choiceLabel(choice: StartChoice): string {
  return choice.kind === "folder" ? choice.folder.name : START_COPY.home;
}

/** 메뉴의 부가 줄: 폴더의 부모 이름(같은 이름의 프로젝트를 가른다). */
export function parentName(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

/** worktree 격리를 켤 수 있는가, 못 켠다면 왜. */
export function worktreeAvailability(
  choice: StartChoice
): { enabled: true } | { enabled: false; reason: string } {
  if (choice.kind === "home") return { enabled: false, reason: START_COPY.worktreeHome };
  switch (choice.folder.repo) {
    case "ready":
      return { enabled: true };
    case "empty":
      return { enabled: false, reason: START_COPY.worktreeNoCommit };
    default:
      return { enabled: false, reason: START_COPY.worktreeOff };
  }
}

/**
 * 셸의 거부·실패 문구를 사람이 읽는 말로. 모르는 문구는 그대로 둔다(진단이 사라지지
 * 않게).
 */
export function startErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const table: Array<[string, string]> = [
    ["folder does not exist", "폴더를 찾을 수 없어요. 이름을 바꾸었거나 지웠을 수 있어요."],
    ["folder is not a directory", "폴더가 아니에요. 폴더를 골라 주세요."],
    ["outside the home directory", "홈 폴더 안의 폴더만 고를 수 있어요."],
    ["folder is not readable", "이 폴더를 읽을 권한이 없어요."],
    ["must be an absolute path", "폴더 경로가 올바르지 않아요."],
    ["must not contain '..'", "폴더 경로가 올바르지 않아요."],
    ["not a repository", "git 저장소가 아니라서 worktree를 만들 수 없어요."],
    ["no commit yet", "아직 커밋이 없어서 worktree를 만들 수 없어요. 커밋을 한 번 만든 뒤 다시 해 보세요."],
    ["unsupported filter", "이 저장소의 git 필터 설정을 안전하게 확인할 수 없어서 worktree를 만들지 않았어요."],
    ["timed out", "worktree를 만드는 데 너무 오래 걸려 멈췄어요."],
    ["git not found", "이 맥에서 git을 찾지 못했어요."],
  ];
  for (const [needle, line] of table) if (raw.includes(needle)) return line;
  if (raw.startsWith("worktree_failed")) {
    return "worktree를 만들지 못했어요. 터미널에서 직접 만들 수 있어요.";
  }
  return raw;
}
