import type { RealtimeStatus } from "@/lib/realtime";

// =============================================================================
// Connection state (① in ADR-0160's vocabulary): whether MY client is attached
// to the server. This is a client-local fact and NOT presence — availability
// (②) and declared status (③, away/dnd) are a separate model ADR-0160 keeps
// deliberately apart, added on member surfaces in 6b. So this file carries no
// online/away/dnd vocabulary on purpose.
//
// Extracted from WorkspaceRail for feedback #6 / presence 6a: the indicator
// moves to the bottom profile panel (the "who I am" row), where "am I attached"
// reads as a truer neighbour than the workspace rail. The label and color are
// the single source both surfaces derive from, so the move cannot fork the
// strings. The load-bearing disconnect signal is still carried shell-wide by
// ConnectionBanner (AppShell), so relocating this ambient dot drops the meaning
// on no viewport.
// =============================================================================

/** Accessible name for each realtime status. One source, never forked per surface. */
export function connectionCopy(status: RealtimeStatus): string {
  if (status === "connected") return "실시간 연결됨";
  if (status === "connecting") return "연결 중";
  return "연결 끊김, 재연결 중";
}

/**
 * Status token color only (SKILL §2): connected/connecting/disconnected map to
 * --ok/--warn/--danger and nothing else. The dot is bound to real state, never
 * a standing ornament (SKILL §8), so the color always derives from the status.
 */
export function connectionDotClass(status: RealtimeStatus): string {
  if (status === "connected") return "bg-ok";
  if (status === "connecting") return "bg-warn";
  return "bg-danger";
}
