import { beforeEach, describe, expect, it } from "vitest";
import {
  agentWorkingSnapshot,
  clearAgentWorking,
  elapsedLabel,
  headlineFrom,
  IDLE_CUTOFF_MS,
  markAgentWorking,
  mergeAgentWorkingSignals,
  resetAgentWorking,
  resolveAgentWorkingSignals,
  sweepAgentWorking,
  workingInChannel,
  ZOMBIE_CLEAR_MS,
  type AgentWorkingSignal,
} from "./agentWorkingSignal";

const CHANNEL = "00000000-0000-7000-8000-000000000202";
const HERMES = "00000000-0000-7000-8000-000000000103";
const KIM = "00000000-0000-7000-8000-000000000102";
const NOW = 1_784_983_000_000;

function signal(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: HERMES,
    channelId: CHANNEL,
    source: "status",
    runId: "019f994e-6b8d-7f13-a324-ec4b954f2635",
    startedAtMs: NOW - 42_000,
    headlines: [],
    lastActivityAtMs: NOW - 1_000,
    ...over,
  };
}

beforeEach(() => resetAgentWorking());

describe("headlineFrom", () => {
  it("takes the last non-empty line of streamed text", () => {
    expect(headlineFrom("첫 줄입니다\n\nMOMO-004 SSE path verified.\n")).toBe(
      "MOMO-004 SSE path verified."
    );
  });

  it("has no headline for a tool-call partial that carries no text", () => {
    expect(headlineFrom(undefined)).toBeUndefined();
    expect(headlineFrom("   \n\n ")).toBeUndefined();
  });

  it("clips a runaway line instead of letting it own the composer", () => {
    const clipped = headlineFrom("가".repeat(400));
    expect(clipped).toHaveLength(141); // 140 + the ellipsis
    expect(clipped?.endsWith("…")).toBe(true);
  });
});

describe("mergeAgentWorkingSignals: one signal per agent per channel", () => {
  it("keeps the earliest clock and the run that owns it", () => {
    const merged = mergeAgentWorkingSignals([
      signal({ runId: "late", startedAtMs: NOW - 5_000 }),
      signal({ runId: "early", startedAtMs: NOW - 60_000 }),
    ]);
    expect(merged?.startedAtMs).toBe(NOW - 60_000);
    expect(merged?.runId).toBe("early");
  });

  it("unions headlines across concurrent runs, deduped and capped at three", () => {
    const merged = mergeAgentWorkingSignals([
      signal({ runId: "a", headlines: ["빌드 확인 중"] }),
      signal({ runId: "b", headlines: ["빌드 확인 중", "테스트 실행"] }),
      signal({ runId: "c", headlines: ["리뷰 정리", "PR 초안", "네 번째"] }),
    ]);
    expect(merged?.headlines).toEqual(["빌드 확인 중", "테스트 실행", "리뷰 정리"]);
  });

  it("promotes to the strongest source: run > status > typing", () => {
    expect(
      mergeAgentWorkingSignals([
        signal({ runId: "a", source: "typing" }),
        signal({ runId: "b", source: "status" }),
      ])?.source
    ).toBe("status");
    expect(
      mergeAgentWorkingSignals([
        signal({ runId: "a", source: "status" }),
        signal({ runId: "b", source: "run" }),
      ])?.source
    ).toBe("run");
    expect(
      mergeAgentWorkingSignals([
        signal({ runId: "a", source: "typing" }),
        signal({ runId: "b", source: "typing" }),
      ])?.source
    ).toBe("typing");
  });

  it("carries no clock when only a typing fallback proved the turn", () => {
    const merged = mergeAgentWorkingSignals([
      signal({ runId: undefined, source: "typing", startedAtMs: undefined }),
      signal({ runId: undefined, source: "typing", startedAtMs: undefined }),
    ]);
    expect(merged?.startedAtMs).toBeUndefined();
  });
});

describe("resolveAgentWorkingSignals", () => {
  it("collapses one agent's concurrent runs and keeps two agents apart", () => {
    const resolved = resolveAgentWorkingSignals(
      [
        signal({ runId: "a", startedAtMs: NOW - 10_000 }),
        signal({ runId: "b", startedAtMs: NOW - 30_000 }),
        signal({ memberId: KIM, runId: "c", startedAtMs: NOW - 4_000 }),
      ],
      NOW
    );
    expect(resolved).toHaveLength(2);
    expect(resolved.map((s) => s.memberId)).toEqual([HERMES, KIM]); // oldest first
    expect(resolved[0].startedAtMs).toBe(NOW - 30_000);
  });

  it("folds id case: the same agent in mixed case is still one signal", () => {
    const resolved = resolveAgentWorkingSignals(
      [
        signal({ runId: "a", memberId: HERMES.toUpperCase() }),
        signal({ runId: "b", memberId: HERMES.toLowerCase() }),
      ],
      NOW
    );
    expect(resolved).toHaveLength(1);
  });

  it("drops a candidate that went quiet past the 90s idle TTL", () => {
    const fresh = signal({ runId: "fresh", lastActivityAtMs: NOW - 1_000 });
    const stalled = signal({
      memberId: KIM,
      runId: "stalled",
      lastActivityAtMs: NOW - IDLE_CUTOFF_MS - 1,
    });
    const resolved = resolveAgentWorkingSignals([fresh, stalled], NOW);
    expect(resolved.map((s) => s.memberId)).toEqual([HERMES]);
  });

  it("keeps a candidate refreshed exactly at the cutoff", () => {
    const resolved = resolveAgentWorkingSignals(
      [signal({ lastActivityAtMs: NOW - IDLE_CUTOFF_MS })],
      NOW
    );
    expect(resolved).toHaveLength(1);
  });
});

describe("zombie defence", () => {
  it("hides a stale signal from a surface before the sweep removes it", () => {
    markAgentWorking(signal({ lastActivityAtMs: NOW - IDLE_CUTOFF_MS - 1 }));
    expect(agentWorkingSnapshot().size).toBe(1); // still stored
    expect(workingInChannel(agentWorkingSnapshot(), CHANNEL, NOW)).toEqual([]);
  });

  it("force clears an entry that has not been refreshed for two minutes", () => {
    markAgentWorking(signal({ lastActivityAtMs: NOW - ZOMBIE_CLEAR_MS - 1 }));
    markAgentWorking(
      signal({ memberId: KIM, runId: "live", lastActivityAtMs: NOW - 2_000 })
    );
    sweepAgentWorking(NOW);
    const left = [...agentWorkingSnapshot().values()];
    expect(left).toHaveLength(1);
    expect(left[0].memberId).toBe(KIM);
  });

  it("does not clear a signal still inside the two-minute window", () => {
    markAgentWorking(signal({ lastActivityAtMs: NOW - ZOMBIE_CLEAR_MS }));
    sweepAgentWorking(NOW);
    expect(agentWorkingSnapshot().size).toBe(1);
  });

  it("clears a turn by channel and member, whatever case the ids arrive in", () => {
    markAgentWorking(signal());
    clearAgentWorking(CHANNEL.toUpperCase(), HERMES.toUpperCase());
    expect(agentWorkingSnapshot().size).toBe(0);
  });
});

describe("elapsedLabel", () => {
  it("reads as a clock a person can compare at a glance", () => {
    expect(elapsedLabel(NOW - 42_000, NOW)).toBe("42s");
    expect(elapsedLabel(NOW - 192_000, NOW)).toBe("3m 12s");
    expect(elapsedLabel(NOW - 305_000, NOW)).toBe("5m 05s");
    expect(elapsedLabel(NOW - 3_840_000, NOW)).toBe("1h 04m");
  });

  it("never runs backwards when the clocks disagree", () => {
    expect(elapsedLabel(NOW + 5_000, NOW)).toBe("0s");
  });
});
