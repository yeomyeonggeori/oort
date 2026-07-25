import type { WorkRowState, WorkSessionStatusKey } from "./workSessionModel";

// =============================================================================
// Presentation constants for the 작업 세션 panel: one token color per state,
// text first, no pulse (design-taste-web §8). Kept beside the model rather than
// inside a component so the list and the detail cannot drift into two colors
// for one fact, and kept in a .ts so nothing here is a fast-refresh boundary.
// =============================================================================

/**
 * Session ledger state. 호스트 연결 끊김 wears the accent because it is the one
 * state waiting on a PERSON (resume it, or let it go), the same way the timeline
 * card paints 승인 대기; a failed exit wears --danger, and a clean end wears
 * --ok because a session that finished is good news, not neutral.
 */
export const SESSION_STATUS_CLASS: Readonly<Record<WorkSessionStatusKey, string>> = {
  running: "bg-surface-hover text-warn",
  orphaned: "bg-accent-soft text-accent",
  done: "bg-surface-hover text-ok",
  failed: "bg-surface-hover text-danger",
};

/** Step state. 완료 stays muted: a wall of green is not a reading aid. */
export const ROW_STATE_CLASS: Readonly<Record<WorkRowState, string>> = {
  running: "bg-surface-hover text-warn",
  pending: "bg-accent-soft text-accent",
  done: "bg-surface-hover text-ink-muted",
  error: "bg-surface-hover text-danger",
};

/** Wall clock for a row, HH:MM. Numbers carry data-numeric at the call site. */
export function clockLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes()
  ).padStart(2, "0")}`;
}

/** Wall clock with seconds, for the panel's "마지막 갱신" line. */
export function freshnessLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${clockLabel(atMs)}:${String(at.getSeconds()).padStart(2, "0")}`;
}

/**
 * How long the stream has actually been silent, in words.
 *
 * The survival signal turns on at SLOW_STEP_MS, and the copy used to state that
 * THRESHOLD ("10초 넘게 새 신호가 없습니다") no matter how long the silence had
 * really run: a five minute gap read as ten seconds, which is the threshold
 * masquerading as an observation. The number a reader needs in order to decide
 * whether to wait or to intervene is the elapsed one, so that is the number
 * every surface says.
 */
export function silenceLabel(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}
