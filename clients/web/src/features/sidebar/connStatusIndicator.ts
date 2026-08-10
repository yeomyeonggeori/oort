import type { RealtimeStatus } from "@/lib/realtime";

// =============================================================================
// Connection state (① in ADR-0160's vocabulary): whether MY client is attached
// to the server. This is a client-local fact and NOT presence — availability
// (②) and declared status (③, away/dnd) are a separate model ADR-0160 keeps
// deliberately apart. So this file carries no online/away/dnd vocabulary on
// purpose.
//
// Extracted from WorkspaceRail for feedback #6 / presence 6a: the indicator
// moved to the bottom profile panel (the "who I am" row), where "am I attached"
// reads as a truer neighbour than the workspace rail. The label is the single
// source both surfaces derive from, so the move cannot fork the strings. The
// load-bearing disconnect signal is still carried shell-wide by
// ConnectionBanner (AppShell), so this ambient indicator drops the meaning on no
// viewport.
//
// ## 6b design-review H1: health is SILENCE, and the shape is a bar
//
// 6a landed this as an 8px dot with `rounded-sm`, one row away from where 6b
// then put the presence badge. Two things were wrong and the review measured
// both:
//
//   1. **The dot was not a square.** `rounded-sm` is 6px and the box is 8px, so
//      the radius clamped and it rendered a full circle — the old comment
//      calling it a square described something no one could see. Two 8px circles
//      on one row, and at away/dnd they contradicted each other: an amber
//      presence badge beside a green connection dot reads as one confused
//      signal, not two facts.
//   2. **A standing green dot carries zero information.** "Connected" is the
//      state ~100% of the time, so a permanent green dot is decoration, which
//      SKILL §8 bans outright ("status indicators only when bound to real
//      state").
//
// Both are fixed by the same rule: **the indicator says nothing while healthy,
// and when it does speak it is a BAR, not a dot.** Connecting/disconnected get a
// 12x4 bar — the marker grammar the workspace rail already uses for its
// selection bar — so at the pixel level it cannot be confused with the round
// presence badge on the avatar even by someone who is not looking carefully.
// Nothing is lost by the silence: ConnectionBanner still carries the full
// disconnect story shell-wide.
// =============================================================================

/** Accessible name for each realtime status. One source, never forked per surface. */
export function connectionCopy(status: RealtimeStatus): string {
  if (status === "connected") return "실시간 연결됨";
  if (status === "connecting") return "연결 중";
  return "연결 끊김, 재연결 중";
}

/**
 * Does the indicator stand at all?
 *
 * `false` while connected, and that is the whole of H1's first half: a healthy
 * rail is reported by the absence of a warning, not by a green ornament nobody
 * reads. The two unhealthy states are the only ones worth a pixel.
 */
export function showsConnectionBar(status: RealtimeStatus): boolean {
  return status !== "connected";
}

/**
 * Status token color for the bar (SKILL §2): connecting maps to --warn,
 * disconnected to --danger, and nothing else is ever painted.
 *
 * `connected` returns the empty string rather than `bg-ok`, and that emptiness
 * is load-bearing: it is what makes "a standing green connection dot" impossible
 * to reintroduce by rendering unconditionally. The colour is still always
 * derived from real state, never hardcoded (SKILL §8).
 */
export function connectionBarClass(status: RealtimeStatus): string {
  switch (status) {
    case "connecting":
      return "bg-warn";
    case "disconnected":
      return "bg-danger";
    case "connected":
      return "";
  }
}
