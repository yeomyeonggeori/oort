import type { GitReadResult } from "./gitRead";
import type { PaneSignal } from "./paneStatus";
import { derivePaneStatus } from "./paneStatus";
import type { SessionPhaseInput, SessionStatus } from "./sessionList";

// =============================================================================
// 로컬 칸 공유 요약 수집기 S1 (#2861, 제안서 §8.4 T9, ADR-0190 D4-b).
//
// 이 모듈이 만드는 것은 **S1 필드뿐**이다: 저장소 표시 이름 · 브랜치 · 하네스 ·
// 파생 상태 · 단계 표지 · diff 숫자 · PR URL · 마지막 활동. 서버로 보내는 길은
// #2862(PATCH /work-sessions/:id/share, host 서명)가 `ShareSender`를 구현해 붙인다.
// 이 PR은 보내지 않는다(`noopShareSender`, 기본 꺼짐).
//
// 입력은 아래 **타입 있는 메서드** 다섯 개뿐이다(ADR-0190 D4-b 허용 출처 셋).
//   - `onSignal`    하네스 hook·notify 구조 신호 (닫힌 목록 `PaneSignal`)
//   - `onTitle`     OSC 제목. **글자 모양 한 가지만** 읽고 글은 버린다
//   - `onGit`       D3-c git 읽기 결과 (G1·G2·G4·G7·G8). 파싱은 셸에서 끝난 필드
//   - `onLifecycle` 칸 생명주기: 시작·종료 코드
//   - `onPrUrl`     주인이 칸 메뉴에 붙여 넣은 URL(형식 검증 통과분만)
//
// **PTY 출력은 입력이 아니다.** 출력 바이트·문자열을 받는 메서드도 필드도
// import도 없다. 화면에 토큰·커밋 제목·「Allow?」가 찍혀도 요약은 바뀌지 않는다.
// 소스 시험(`shareSummary.test.ts`)이 이 파일의 import·식별자를 잠그고, 행동
// 시험이 출력 모양의 문자열을 모든 문자열 입구에 넣어 봐도 요약에 없음을 잰다.
//
// 단계 표지의 글은 이 파일의 닫힌 표(`STAGE_LABEL`)에서만 온다. 하네스가 hook·
// 제목에 실어 보낸 글(작업 제목, 권한 요청 본문)은 어느 경로로도 표지가 되지
// 않는다. 커밋 제목은 G5를 받는 입구가 없어서 들어올 수 없다(Q2).
//
// 한계(PR 본문 REMAINING): statusLine은 아직 배선하지 않았다. Claude Code는
// statusLine이 하나뿐이라 사용자 설정과 충돌한다 — 후속에서 사용자 것을 감싸는
// 방식으로 다룬다. 셸 칸은 hook이 없어 상태·생명주기·git 숫자만 만들어진다.
// =============================================================================

/** ADR-0190 D4-b 하네스 라벨의 닫힌 목록. */
export const S1_HARNESSES = ["claude", "codex", "grok", "opencode", "shell", "other"] as const;
export type S1Harness = (typeof S1_HARNESSES)[number];

export const S1_STATES: readonly SessionStatus[] = ["waiting", "running", "review", "idle", "done", "stopped"];

/** 단계 표지 상한(ADR-0190 D4-b: 최대 12개, 각 80자). */
export const MAX_STAGES = 12;
export const MAX_STAGE_CHARS = 80;
export const MAX_REPO_CHARS = 100;
export const MAX_BRANCH_CHARS = 200;
export const MAX_PR_URL_CHARS = 300;

/** diff 숫자. 파일 이름은 싣지 않는다. */
export interface S1Diff {
  /** G7: 기준점 이후 추가·삭제 줄과 파일 수. 기준점이 없으면 null. */
  added: number | null;
  deleted: number | null;
  files: number | null;
  /** G4: 기준점과 앞·뒤 커밋 수. 기준점이 없으면 null. */
  ahead: number | null;
  behind: number | null;
  /** G8: 커밋 안 한 변경 개수(수정+추가+삭제+추적 안 함). */
  uncommitted: number | null;
}

/** 서버로 가는 S1 요약. #2862가 이 모양을 그대로 PATCH 본문에 싣는다. */
export interface ShareSummaryS1 {
  /** 저장소 표시 이름(G1, 마지막 경로 요소). 모르면 null. */
  repo: string | null;
  branch: string | null;
  harness: S1Harness;
  state: SessionStatus;
  stages: string[];
  diff: S1Diff;
  prUrl: string | null;
  /** 마지막 활동 시각, epoch **초**(초 단위로 버림). */
  lastActivityAt: number | null;
}

/** #2862가 구현한다. 이 PR에서는 `noopShareSender`만 있다. */
export interface ShareSender {
  send(summary: ShareSummaryS1): void | Promise<void>;
}

export const noopShareSender: ShareSender = { send: () => undefined };

// ---- 정제 ------------------------------------------------------------------

// 제어 문자·ESC·양방향 서식·보이지 않는 서식 문자. 코드 포인트로 판정한다.
function isHiddenFormat(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff
  );
}

/** 제어 문자·서식 문자를 지우고 상한으로 자른다. 비면 null. */
export function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  let out = "";
  for (const ch of value) {
    if (!isHiddenFormat(ch.codePointAt(0)!)) out += ch;
  }
  out = [...out.trim()].slice(0, max).join("");
  return out === "" ? null : out;
}

/** 저장소 표시 이름: 경로 구분자가 있으면 거부한다(D4-b). */
function cleanRepo(value: unknown): string | null {
  const name = cleanLabel(value, MAX_REPO_CHARS);
  return name === null || /[/\\]/.test(name) ? null : name;
}

const PR_PATH = /^\/[^/\s]+\/[^/\s]+\/pull\/\d{1,9}$/;

/**
 * PR URL: 한 줄, `https`, `/<소유자>/<저장소>/pull/<번호>`로 끝남. 자격 증명·질의·
 * 조각이 붙은 값은 거부한다(토큰이 섞일 수 있다). 형식의 정본은 ADR-0194.
 */
export function parsePrUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PR_URL_CHARS) return null;
  const text = value.trim();
  if (/\s/.test(text) || [...text].some((ch) => isHiddenFormat(ch.codePointAt(0)!))) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (!PR_PATH.test(url.pathname)) return null;
  return `https://${url.host}${url.pathname}`;
}

// ---- 구조 신호 → 단계 표지 -------------------------------------------------

/** 표지 글의 유일한 출처. 신호 하나에 문구 하나. */
export const STAGE_LABEL: Readonly<Record<PaneSignal | "title-working" | "started" | "exited" | "failed", string>> = {
  ready: "세션 시작",
  working: "작업 중",
  "waiting-permission": "실행 허락 기다림",
  "waiting-input": "답 기다림",
  "turn-done": "턴 끝남",
  "title-working": "작업 중",
  started: "칸 시작",
  exited: "칸 종료",
  failed: "시작 실패",
};

const TITLE_WORKING_GLYPHS = new Set(["◐", "◑", "◒", "◓"]);

/**
 * OSC 제목에서 읽는 것은 **첫 글자의 모양 하나**다(#2776: Claude Code의 작업 중
 * 점 ◐◑◒◓). 제목의 나머지 글(작업 내용이 섞인다)은 이 함수 안에서 버려지고
 * 어디에도 전달되지 않는다.
 */
export function titleActivity(title: string | null): "working" | null {
  if (title === null) return null;
  const first = [...title][0];
  return first !== undefined && TITLE_WORKING_GLYPHS.has(first) ? "working" : null;
}

// ---- 수집기 ----------------------------------------------------------------

export type ShareClock = () => number;
export type ShareScheduler = (fn: () => void, ms: number) => () => void;

export interface ShareCollectorOptions {
  harness: S1Harness;
  sender?: ShareSender;
  /** 밀리초. 기본 `Date.now`. */
  now?: ShareClock;
  schedule?: ShareScheduler;
  /** 모양이 바뀐 갱신 사이 최소 간격. 이 안의 변화는 하나로 합쳐 마지막에 한 번 보낸다. */
  minIntervalMs?: number;
  /** 마지막 활동 시각만 바뀐 갱신 사이 최소 간격. */
  activityIntervalMs?: number;
}

export const DEFAULT_MIN_INTERVAL_MS = 5_000;
export const DEFAULT_ACTIVITY_INTERVAL_MS = 60_000;

const EMPTY_DIFF: S1Diff = {
  added: null,
  deleted: null,
  files: null,
  ahead: null,
  behind: null,
  uncommitted: null,
};

export interface ShareCollector {
  onSignal(signal: PaneSignal): void;
  onTitle(title: string | null): void;
  onGit(results: GitInputs): void;
  onLifecycle(phase: SessionPhaseInput, exitCode?: number | null, exitSignal?: string | number | null): void;
  onPrUrl(url: string | null): void;
  /** 공유를 켜면 현재 요약을 바로 보내고, 끄면 보류 중인 갱신을 버린다. 기본은 꺼짐(D4). */
  setSharing(on: boolean): void;
  /** 지금까지 모인 요약. 공유 여부와 무관하게 읽을 수 있다(로컬 표시용). */
  snapshot(): ShareSummaryS1;
  dispose(): void;
}

/** 칸 폴더의 git 읽기 결과. 주지 않은 명령은 건드리지 않는다. */
export interface GitInputs {
  g1?: GitReadResult;
  g2?: GitReadResult;
  g4?: GitReadResult;
  g7?: GitReadResult;
  g8?: GitReadResult;
}

const defaultSchedule: ShareScheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

function nonNegInt(n: unknown): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function createShareCollector(options: ShareCollectorOptions): ShareCollector {
  const sender = options.sender ?? noopShareSender;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const activityInterval = options.activityIntervalMs ?? DEFAULT_ACTIVITY_INTERVAL_MS;

  let phase: SessionPhaseInput | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | number | null = null;
  let signal: PaneSignal | null = null;
  let repo: string | null = null;
  let branch: string | null = null;
  let diff: S1Diff = { ...EMPTY_DIFF };
  let prUrl: string | null = null;
  let stages: string[] = [];
  let lastActivityMs: number | null = null;

  let sharing = false;
  let lastSentShape: string | null = null;
  let lastSentAt: number | null = null;
  let cancelPending: (() => void) | null = null;

  const shape = (s: ShareSummaryS1): string => JSON.stringify({ ...s, lastActivityAt: null });

  function snapshot(): ShareSummaryS1 {
    return {
      repo,
      branch,
      harness: options.harness,
      state: derivePaneStatus({ phase, exitCode, exitSignal, signal }),
      stages: [...stages],
      diff: { ...diff },
      prUrl,
      lastActivityAt: lastActivityMs === null ? null : Math.floor(lastActivityMs / 1000),
    };
  }

  function flush(): void {
    cancelPending?.();
    cancelPending = null;
    if (!sharing) return;
    const summary = snapshot();
    lastSentShape = shape(summary);
    lastSentAt = now();
    try {
      void Promise.resolve(sender.send(summary)).catch(() => undefined);
    } catch {
      // 보내기 실패는 수집을 멈추지 않는다. 다음 변화가 다시 시도한다.
    }
  }

  function changed(): void {
    if (!sharing) return;
    if (lastSentShape !== null && shape(snapshot()) === lastSentShape) {
      // 활동 시각만 달라졌다: 느린 간격으로만 보낸다.
      if (lastSentAt !== null && now() - lastSentAt >= activityInterval) flush();
      return;
    }
    const wait = lastSentAt === null ? 0 : Math.max(0, minInterval - (now() - lastSentAt));
    if (wait === 0) {
      flush();
    } else if (cancelPending === null) {
      cancelPending = schedule(flush, wait);
    }
  }

  function touch(): void {
    lastActivityMs = now();
  }

  function pushStage(label: string): void {
    if (stages[stages.length - 1] === label) return;
    const text = cleanLabel(label, MAX_STAGE_CHARS);
    if (text === null) return;
    stages = [...stages, text].slice(-MAX_STAGES);
  }

  return {
    onSignal(next) {
      signal = next;
      pushStage(STAGE_LABEL[next]);
      touch();
      changed();
    },
    onTitle(title) {
      // 글은 여기서 버린다. 읽는 것은 「작업 중 점」인지 아닌지 하나뿐이다.
      if (titleActivity(title) === null) return;
      pushStage(STAGE_LABEL["title-working"]);
      touch();
      changed();
    },
    onGit(results) {
      if (results.g1) repo = results.g1.outcome === "ok" && results.g1.value.kind === "repo" ? cleanRepo(results.g1.value.name) : null;
      if (results.g2) {
        branch =
          results.g2.outcome === "ok" && results.g2.value.kind === "branch"
            ? cleanLabel(results.g2.value.name, MAX_BRANCH_CHARS)
            : null;
      }
      if (results.g4) {
        const v = results.g4.outcome === "ok" && results.g4.value.kind === "aheadBehind" ? results.g4.value : null;
        diff = { ...diff, ahead: v ? nonNegInt(v.ahead) : null, behind: v ? nonNegInt(v.behind) : null };
      }
      if (results.g7) {
        const v = results.g7.outcome === "ok" && results.g7.value.kind === "diff" ? results.g7.value.totals : null;
        diff = {
          ...diff,
          added: v ? nonNegInt(v.added) : null,
          deleted: v ? nonNegInt(v.deleted) : null,
          files: v ? nonNegInt(v.files) : null,
        };
      }
      if (results.g8) {
        const v = results.g8.outcome === "ok" && results.g8.value.kind === "status" ? results.g8.value : null;
        const parts = v ? [v.modified, v.added, v.deleted, v.untracked].map(nonNegInt) : [];
        diff = {
          ...diff,
          uncommitted: parts.length === 4 && parts.every((n) => n !== null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null,
        };
      }
      changed();
    },
    onLifecycle(nextPhase, code = null, sig = null) {
      phase = nextPhase;
      exitCode = nextPhase === "exited" ? code : null;
      exitSignal = nextPhase === "exited" ? sig : null;
      if (nextPhase === "running") pushStage(STAGE_LABEL.started);
      if (nextPhase === "exited") pushStage(STAGE_LABEL.exited);
      if (nextPhase === "failed") pushStage(STAGE_LABEL.failed);
      if (nextPhase === "starting" || nextPhase === "exited" || nextPhase === "failed") signal = null;
      touch();
      changed();
    },
    onPrUrl(url) {
      prUrl = url === null ? null : parsePrUrl(url);
      changed();
    },
    setSharing(on) {
      if (on === sharing) return;
      sharing = on;
      if (on) {
        lastSentShape = null;
        lastSentAt = null;
        flush();
      } else {
        cancelPending?.();
        cancelPending = null;
        lastSentShape = null;
        lastSentAt = null;
      }
    },
    snapshot,
    dispose() {
      sharing = false;
      cancelPending?.();
      cancelPending = null;
    },
  };
}
