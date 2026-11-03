import { beforeEach, describe, expect, it } from "vitest";
import {
  agentTurnsInChannel,
  agentWorkingSnapshot,
  clearAgentWorking,
  elapsedLabel,
  hasChannelTurn,
  headlineFrom,
  IDLE_CUTOFF_MS,
  markAgentWorking,
  mergeAgentWorkingSignals,
  resetAgentWorking,
  resolveAgentWorkingSignals,
  sweepAgentWorking,
  withApprovalWaits,
  ZOMBIE_CLEAR_MS,
  type AgentWorkingSignal,
  type ApprovalWait,
} from "./agentWorkingSignal";

const CHANNEL = "00000000-0000-7000-8000-000000000202";
const OTHER_CHANNEL = "00000000-0000-7000-8000-000000000201";
const HERMES = "00000000-0000-7000-8000-000000000103";
const KIM = "00000000-0000-7000-8000-000000000102";
const NOW = 1_784_983_000_000;

function signal(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: HERMES,
    channelId: CHANNEL,
    state: "working",
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

  it("merges toward working: one running run makes the agent working", () => {
    const merged = mergeAgentWorkingSignals([
      signal({ runId: "waiting", state: "awaiting_approval", startedAtMs: NOW - 90_000 }),
      signal({ runId: "running", state: "working", startedAtMs: NOW - 10_000 }),
    ]);
    expect(merged?.state).toBe("working");
    // The clock belongs to the state being shown, so it is the running run's,
    // not the older one parked on an approval.
    expect(merged?.startedAtMs).toBe(NOW - 10_000);
    expect(merged?.runId).toBe("running");
  });

  it("stays awaiting when every run of that agent stopped for a person", () => {
    const merged = mergeAgentWorkingSignals([
      signal({ runId: "a", state: "awaiting_approval" }),
      signal({ runId: "b", state: "awaiting_approval", startedAtMs: NOW - 90_000 }),
    ]);
    expect(merged?.state).toBe("awaiting_approval");
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
    expect(agentTurnsInChannel(agentWorkingSnapshot(), CHANNEL, NOW)).toEqual([]);
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

describe("hasChannelTurn", () => {
  it("answers for one channel without consulting a clock", () => {
    // This is what decides whether the composer mounts a 1Hz interval, so it
    // must not need the number that interval produces.
    markAgentWorking(signal({ channelId: OTHER_CHANNEL, memberId: KIM }));
    expect(hasChannelTurn(agentWorkingSnapshot(), CHANNEL)).toBe(false);
    expect(hasChannelTurn(agentWorkingSnapshot(), OTHER_CHANNEL)).toBe(true);
    expect(hasChannelTurn(agentWorkingSnapshot(), OTHER_CHANNEL.toUpperCase())).toBe(
      true
    );
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

// =============================================================================
// 승인 원장을 열린 턴 **전체**(채널 너머)에 덮는 배선 (#5125). 규칙(누가 기다리나·기한이 지났나)은 코어 `applyApprovalWaits.test.ts` 가 재고, 여기서는
// 그 규칙을 **채널마다 부르는** 얇은 함수만 잰다. 화면 시험(`Sidebar.nowCardApproval`·`AdeSummaryLine.approval`)은 채널 하나에서만 서므로
// 채널을 넘는 것과 만료 신호의 순서는 여기서만 지켜진다. 폰 `approvalWaitSignals.test.ts` 의 같은 함수 시험과 같은 두 이야기다.
// =============================================================================

const THIRD_CHANNEL = "00000000-0000-7000-8000-000000000203";

const wait = (
  channelId: string,
  requestedBy: string,
  over: Partial<ApprovalWait> = {}
): ApprovalWait => ({ channelId, requestedBy, expiresAtMs: NOW + 3_600_000, ...over });

const keyOf = (channelId: string, memberId: string) =>
  `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;

describe("withApprovalWaits: 규칙은 코어의 것이고 여기서는 채널마다 부른다", () => {
  it("대기 승인이 있는 채널마다 덮는다: 한 채널이 아니라 채널 너머, 대기 없는 채널·다른 에이전트는 그대로", () => {
    markAgentWorking(signal({ channelId: CHANNEL, memberId: HERMES }));
    markAgentWorking(signal({ channelId: OTHER_CHANNEL, memberId: HERMES }));
    markAgentWorking(signal({ channelId: OTHER_CHANNEL, memberId: KIM }));
    markAgentWorking(signal({ channelId: THIRD_CHANNEL, memberId: HERMES }));
    const all = agentWorkingSnapshot();

    const out = withApprovalWaits(
      all,
      [wait(CHANNEL, HERMES), wait(OTHER_CHANNEL, HERMES)],
      NOW
    );

    const state = (channelId: string, memberId: string) =>
      out.get(keyOf(channelId, memberId))?.state;
    expect(state(CHANNEL, HERMES)).toBe("awaiting_approval");
    expect(state(OTHER_CHANNEL, HERMES)).toBe("awaiting_approval");
    expect(state(OTHER_CHANNEL, KIM)).toBe("working");
    expect(state(THIRD_CHANNEL, HERMES)).toBe("working");
    expect(out.size).toBe(4);
    // 입력은 바뀌지 않는다: 스토어가 이 사본을 읽는 표면과 같은 객체를 나눠 쓴다.
    expect(all.get(keyOf(CHANNEL, HERMES))?.state).toBe("working");
  });

  it("만료된 신호는 덮기 전에 걸러져서 살아 있는 승인이 새 턴을 세운다 — 덮지 않은 항목은 지우지 않고, 대기가 없으면 입력을 그대로 돌려준다", () => {
    const staleAt = NOW - IDLE_CUTOFF_MS - 1;
    markAgentWorking(signal({ memberId: HERMES, lastActivityAtMs: staleAt }));
    markAgentWorking(signal({ memberId: KIM, lastActivityAtMs: staleAt }));
    const all = agentWorkingSnapshot();
    expect(withApprovalWaits(all, [], NOW)).toBe(all);

    const out = withApprovalWaits(all, [wait(CHANNEL, HERMES)], NOW);

    // 옛 신호를 그 자리에서 바꿔 두면 읽는 쪽의 만료 거름(`agentTurnsInChannel`)이 그 턴을 지우고 살아 있는 승인은 어디에도 안 보인다. 먼저
    // 거르면 승인을 근거로 선 새 턴이 남고, 시작 시각은 지어내지 않는다.
    const [shown, ...rest] = agentTurnsInChannel(out, CHANNEL, NOW);
    expect(rest).toEqual([]);
    expect(shown).toMatchObject({
      memberId: HERMES,
      state: "awaiting_approval",
      lastActivityAtMs: NOW,
    });
    expect(shown.startedAtMs).toBeUndefined();
    // 덮지 않은 항목은 사본에도 남는다: 시계 없이 항목 유무만 보는 읽는 쪽(`hasChannelTurn`)이 원본 스토어와 다른 답을 하지 않는다.
    expect(out.get(keyOf(CHANNEL, KIM))).toBe(all.get(keyOf(CHANNEL, KIM)));
  });
});
