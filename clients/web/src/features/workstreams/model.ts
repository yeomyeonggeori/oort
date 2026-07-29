import {
  ApiError,
  WORKSTREAM_STATUSES,
  uuidEq,
  type Channel,
  type WorkHost,
  type WorkstreamRun,
  type WorkstreamStatus,
} from "@/lib/api";
import { workSessionResumeTargets } from "@/features/work/workSessionModel";
import { channelLabel, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 작업 흐름 (ADR-0143): the goal layer, as a set of pure functions.
//
// Everything a reader is told about a workstream that is not a server field is
// decided here rather than in JSX, for the reason the work session panel keeps
// its own model beside it: the list and the detail must not drift into two
// answers for one fact, and the honest-refusal branches below are the whole
// point of the surface, so they are testable rather than inline conditions.
// =============================================================================

export const WORKSTREAM_STATUS_LABEL: Readonly<Record<WorkstreamStatus, string>> = {
  active: "진행 중",
  paused: "멈춤",
  done: "완료",
  cancelled: "취소됨",
};

/**
 * One token colour per state, text first, no pulse (design-taste-web §8).
 *
 * 진행 중 is the CALM state here and takes no status token at all. It is what
 * almost every row says (nothing in the server writes a workstream out of
 * `active` yet — status transitions are ADR-0143 P2), and a column of amber
 * chips reporting that work is proceeding normally is a status board announcing
 * that nothing is happening, which is the same mistake the 잔여량 gauges fixed
 * by dropping their calm chip (tokens.md §5a).
 *
 * 멈춤 wears the accent for the reason the session ledger paints 호스트 연결
 * 끊김 with it: it is the one state waiting on a PERSON, and this surface exists
 * so that person can be someone other than whoever started it.
 */
export const WORKSTREAM_STATUS_CLASS: Readonly<Record<WorkstreamStatus, string>> = {
  active: "bg-surface-hover text-ink",
  paused: "bg-accent-soft text-accent",
  done: "bg-surface-hover text-ok",
  cancelled: "bg-surface-hover text-ink-muted",
};

/**
 * The 404 both workstream reads answer for "not yours, and no more than that".
 *
 * It is a predicate and not a status comparison at the call site because the
 * distinction is load-bearing: 404 is the read refusing to confirm that a
 * workstream exists, 403 belongs to the resume path alone, and a surface that
 * folded them would talk about permission for something the server declined to
 * admit exists. Named the way `isAgentProfileMissing` is, beside the surface
 * that means it rather than in the transport.
 */
export function isWorkstreamMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** `?status=` on the route, which is also the server's own filter vocabulary. */
export function parseStatusFilter(raw: string | null): WorkstreamStatus | null {
  if (raw === null) return null;
  return (WORKSTREAM_STATUSES as readonly string[]).includes(raw)
    ? (raw as WorkstreamStatus)
    : null;
}

/**
 * A run clock that survives leaving today, in two pieces.
 *
 * The session panel's bare HH:MM is right for a list of live sessions and wrong
 * here: a goal's history routinely spans days, and "09:12" three rows under
 * another "09:12" from last week reads as one morning's work.
 *
 * It comes back split because only ONE of the two halves is a figure. The clock
 * is tabular (a column of them has to line up); the date is Korean prose with
 * its units attached, and prose set in the mono stack renders with visibly
 * stretched gaps between syllables ("7월  29일", measured — tokens.md §4). So
 * the caller tags the time and leaves the day in the sans stack, rather than
 * this returning one string that forces the wrong answer for half of it.
 */
export interface RunClock {
  /** null when the run started today: the reader already knows the day. */
  day: string | null;
  time: string;
}

export function runClockLabel(atMs: number, nowMs: number): RunClock {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return { day: null, time };
  const day = `${at.getMonth() + 1}월 ${at.getDate()}일`;
  return {
    day:
      at.getFullYear() === now.getFullYear()
        ? day
        : `${at.getFullYear()}년 ${day}`,
    time,
  };
}

/**
 * How many DIFFERENT members ran this goal. This is the number ADR-0143 exists
 * to make possible ("A가 시작한 일을 B가 이어받는다"), so the detail states it
 * rather than leaving the reader to compare names down a column.
 */
export function actorCount(runs: readonly WorkstreamRun[]): number {
  return new Set(runs.map((run) => run.memberId.toLowerCase())).size;
}

/**
 * The Run a takeover would continue: the most recent ORPHANED one.
 *
 * Orphaned is not a presentation choice, it is the server's precondition
 * (`only an orphaned work session can resume`). A live session's control is a
 * Writer Lease question and belongs to ADR-0141, which is on hold, so this
 * surface offers exactly one thing: picking up something that stopped.
 */
export function continuableRun(
  runs: readonly WorkstreamRun[]
): WorkstreamRun | null {
  let candidate: WorkstreamRun | null = null;
  for (const run of runs) {
    if (run.status !== "orphaned") continue;
    if (candidate === null || run.startedAtMs > candidate.startedAtMs) {
      candidate = run;
    }
  }
  return candidate;
}

export type ContinuationState =
  | { kind: "ready"; run: WorkstreamRun; targets: WorkHost[] }
  | { kind: "offline" }
  | { kind: "no-runs" }
  | { kind: "no-stopped-run" }
  | { kind: "no-host"; run: WorkstreamRun };

/**
 * Whether 이어받기 can be offered, and when it cannot, which fact stopped it.
 *
 * Every branch is a different sentence to the reader, which is why this returns
 * a reason rather than a boolean: "아직 실행이 없습니다", "이어받을 수 있는
 * 실행이 없습니다" and "온라인인 호스트가 없습니다" are three different next
 * actions, and a disabled button with one generic tooltip is none of them.
 */
export function continuationState(
  runs: readonly WorkstreamRun[],
  hosts: readonly WorkHost[],
  viewerMemberId: string,
  offline: boolean
): ContinuationState {
  if (offline) return { kind: "offline" };
  if (runs.length === 0) return { kind: "no-runs" };
  const run = continuableRun(runs);
  if (run === null) return { kind: "no-stopped-run" };
  const targets = workSessionResumeTargets(run, hosts, viewerMemberId);
  return targets.length === 0
    ? { kind: "no-host", run }
    : { kind: "ready", run, targets };
}

/**
 * What the surface says when it cannot offer a takeover. Kept beside the state
 * that produced it so a new branch cannot ship without its sentence.
 *
 * None of these promise the working tree. momo's ledger knows the WIP branch
 * name, its base commit and the checkpoint metadata; whether the git remote
 * will actually hand those commits to the next person is git's answer, not
 * momo's (ADR-0143 D3), so no copy on this surface says "가져옵니다".
 */
export function continuationBlockedCopy(
  state: Exclude<ContinuationState, { kind: "ready" }>
): string {
  switch (state.kind) {
    case "offline":
      return "연결이 끊겨 지금은 이어받을 수 없습니다. 다시 연결되면 이 자리에서 이어받을 수 있습니다.";
    case "no-runs":
      return "아직 실행이 없습니다. 채널 스레드에서 작업을 시작하면 이 목표의 첫 실행으로 기록됩니다.";
    case "no-stopped-run":
      return "지금 이어받을 실행이 없습니다. 호스트 연결이 끊긴 실행만 다른 호스트에서 이어받을 수 있습니다.";
    case "no-host":
      return "온라인인 다른 호스트가 없습니다. 호스트를 연결한 뒤 다시 시도하세요.";
  }
}

/**
 * The takeover failed. The status code decides the sentence because the server
 * uses the codes to mean different things, and folding them into one apology
 * would hide the only one the reader can act on.
 */
export function continuationErrorCopy(status: number | null): string {
  if (status === 403) {
    return "이 채널의 멤버만 이어받을 수 있습니다. 채널에서 나갔거나 권한이 바뀌었는지 확인하세요.";
  }
  if (status === 409) {
    return "이 실행은 더 이상 이어받을 수 있는 상태가 아닙니다. 이력을 새로고침한 뒤 다시 확인하세요.";
  }
  if (status === 404) {
    return "이 실행을 찾지 못했습니다. 이력을 새로고침한 뒤 다시 확인하세요.";
  }
  return "이어받지 못했습니다. 호스트 상태를 확인한 뒤 다시 시도하세요.";
}

/**
 * Name a channel the way the 작업 세션 패널 names it: `#채널` for a channel, the
 * peer's name for a DM, and 다른 채널 for one this client has not listed. Two
 * work surfaces calling one channel by two names is a reader's problem, not a
 * style question, so the idiom is shared rather than copied.
 *
 * It never HIDES a row: the server decides what is visible, and a client-side
 * channel miss is a naming gap, not a permission answer.
 */
export function channelDisplayName(
  channelId: string,
  channels: readonly Channel[],
  directory: Directory,
  selfMemberId: string
): string {
  const channel = channels.find((candidate) => uuidEq(candidate.id, channelId));
  if (!channel) return "다른 채널";
  const label = channelLabel(channel, directory, selfMemberId);
  return channel.kind === "dm" ? label : `#${label}`;
}
