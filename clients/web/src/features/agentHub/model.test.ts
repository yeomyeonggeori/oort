import { describe, expect, it } from "vitest";
import type { AgentRunSummary, RosterMember } from "@/lib/api";
import type { AgentWorkingSignal } from "@/features/agents/agentWorkingSignal";
import {
  agentMembers,
  canInvalidateMemory,
  mergeRunPages,
  signalsForAgent,
} from "./model";

function member(
  id: string,
  kind: RosterMember["kind"],
  displayName: string
): RosterMember {
  return {
    id,
    workspaceId: "WS",
    kind,
    status: "active",
    displayName,
    handle: displayName,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function signal(overrides: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: "AGENT",
    channelId: "CHANNEL",
    state: "working",
    source: "run",
    headlines: [],
    lastActivityAtMs: 1_000,
    ...overrides,
  };
}

function run(id: string): AgentRunSummary {
  return {
    id,
    channelId: "CHANNEL",
    status: "succeeded",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("agent hub model", () => {
  it("keeps only agents and sorts the stable roster projection", () => {
    expect(
      agentMembers([
        member("H", "human", "사람"),
        member("B", "agent", "Zulu"),
        member("A", "agent", "Alpha"),
      ]).map((item) => item.id)
    ).toEqual(["A", "B"]);
  });

  it("matches UUIDs without case and removes stale current-work claims", () => {
    const signals = new Map([
      ["a", signal({ memberId: "agent", state: "awaiting_approval" })],
      ["b", signal({ memberId: "AGENT", channelId: "B", lastActivityAtMs: 0 })],
      ["c", signal({ memberId: "OTHER" })],
    ]);
    expect(signalsForAgent(signals, "AgEnT", 91_001)).toEqual([]);
    expect(signalsForAgent(signals, "agent", 2_000)).toHaveLength(2);
  });

  it("deduplicates cursor pages by lower-cased run id without reordering", () => {
    expect(
      mergeRunPages([
        { runs: [run("RUN-B"), run("RUN-A")] },
        { runs: [run("run-a"), run("RUN-0")] },
      ]).map((item) => item.id)
    ).toEqual(["run-b", "run-a", "run-0"]);
  });

  it("allows invalidation only for workspace managers or the creator", () => {
    expect(canInvalidateMemory("admin", "ME", undefined)).toBe(true);
    expect(canInvalidateMemory("member", "ME", "me")).toBe(true);
    expect(canInvalidateMemory("member", "ME", "OTHER")).toBe(false);
  });
});
