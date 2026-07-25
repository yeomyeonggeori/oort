import type { AgentWorkingSignal } from "./agentWorkingSignal";

// =============================================================================
// `?agentwork=<mode>`: the capture seam for the agent turn surfaces (SKILL §11).
//
// The design capture renders the real components against a mocked REST surface
// and no socket, so without this the sidebar pill and the composer activity line
// are the only shipped surfaces that never appear in artifacts/design. Reviewing
// them then depends on someone standing up momowebqa and posting a mention,
// which is not a loop this repo can run.
//
// Same shape of seam as `?stress=N` in ChatShell: a URL flag, off by default,
// that swaps live data for fixed data. It only produces SIGNALS; the resolver,
// the copy and both surfaces are the shipped ones.
//
// Two things keep it from being a way to fake product state at a reader:
//
//   1. It is not in a release build. `npm run build` compiles MODE=production
//      and the flag is dead there; the capture builds `--mode design` and the
//      dev server is DEV, which are the only two places anyone reviews pixels.
//      `?stress=N` can afford to ship because a header reading 스크롤 측정 (40)
//      cannot be mistaken for a channel; fabricated agent turns can be mistaken
//      for agent turns, which is the whole point of them.
//   2. Where it IS live, the sidebar prints a warn-colored line naming the mode
//      (Sidebar agent-fixture-notice), including the fact that `live` also pins
//      the connection status to connected. The synthetic surface names itself.
// =============================================================================

export type AgentTurnFixtureMode = "live" | "offline";

/**
 * Builds where the capture seam exists at all. A release bundle answers null to
 * every `?agentwork=` no matter what the URL says.
 */
const SEAM_ENABLED = import.meta.env.DEV || import.meta.env.MODE === "design";

/** The fixture mode this page was opened with, or null for a normal session. */
export function agentTurnFixtureMode(
  search: string = typeof location === "undefined" ? "" : location.search
): AgentTurnFixtureMode | null {
  if (!SEAM_ENABLED) return null;
  const value = new URLSearchParams(search).get("agentwork");
  return value === "live" || value === "offline" ? value : null;
}

/**
 * Turns spread across the fixture workspace to cover every branch the two
 * surfaces have: an agent with a headline and an hour-long clock, a second agent
 * in the same channel with no headline AND no observed start (so the composer
 * stacks two lines, one of them clockless, and the pill counts), the same agent
 * working a second channel, and a turn parked on an approval.
 */
export function agentTurnFixtureSignals(
  channelIds: readonly string[],
  agentIds: readonly string[],
  nowMs: number
): AgentWorkingSignal[] {
  if (channelIds.length === 0 || agentIds.length === 0) return [];
  const [first, second = first, third = first] = channelIds;
  const [agentA, agentB = agentA] = agentIds;
  return [
    {
      memberId: agentA,
      channelId: first,
      state: "working",
      source: "status",
      runId: "0199aa11-2222-7000-8000-0000000000b2",
      startedAtMs: nowMs - 3_742_000,
      headlines: ["outbox drain 워커 재시작 루프 원인 확인 중"],
      lastActivityAtMs: nowMs - 1_000,
    },
    {
      memberId: agentB,
      channelId: first,
      state: "working",
      source: "status",
      runId: "0199aa11-2222-7000-8000-0000000000b3",
      headlines: [],
      lastActivityAtMs: nowMs - 2_000,
    },
    {
      memberId: agentA,
      channelId: second,
      state: "working",
      source: "status",
      runId: "0199aa11-2222-7000-8000-0000000000b4",
      startedAtMs: nowMs - 46_000,
      headlines: ["게이트 로그 수집"],
      lastActivityAtMs: nowMs - 3_000,
    },
    {
      memberId: agentB,
      channelId: third,
      state: "awaiting_approval",
      source: "status",
      runId: "0199aa11-2222-7000-8000-0000000000b5",
      startedAtMs: nowMs - 120_000,
      headlines: [],
      lastActivityAtMs: nowMs - 4_000,
    },
  ];
}
