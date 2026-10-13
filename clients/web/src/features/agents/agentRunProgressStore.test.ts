import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentRunProgress } from "@momo/core/lib/api";
import type {
  AgentRunEventFrame,
  RealtimeHandle,
} from "@momo/core/lib/realtimeEvents";
import { WireShapeError } from "@momo/core/lib/wire";
import {
  resetRunProgress,
  runFactsFor,
  runProgressSignals,
  runProgressSnapshot,
  runProgressUnsupported,
  RUN_PROGRESS_POLL_MS,
  startRunProgress,
} from "./agentRunProgressStore";
import {
  clearAgentWorking,
  markAgentWorking,
  resetAgentWorking,
  sweepAgentWorking,
  agentWorkingSnapshot,
  ZOMBIE_CLEAR_MS,
} from "./agentWorkingSignal";

// =============================================================================
// 서버 진행 스토어 (ADR-0200, #3747). 규칙(phase → 낱말)은 core가 갖고 거기서
// 검증된다. 여기서 지키는 것은 core가 알 수 없는 것이다: **언제 다시 읽는가**,
// 그리고 **구 서버에서 두드리지 않는가**.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH_A = "00000000-0000-7000-8000-000000000201";
const CH_B = "00000000-0000-7000-8000-000000000202";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN_1 = "0199aa11-2222-7000-8000-0000000000b1";
const T0 = 1_800_000_000_000;

function row(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN_1,
    channelId: CH_A,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    queuePosition: 2,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...extra,
  };
}

function fakeRealtime() {
  const handlers = new Map<
    string,
    { onRunEvent: (f: AgentRunEventFrame) => void; onResync: () => void }
  >();
  const stops: string[] = [];
  const realtime = {
    subscribeRunEvents: (
      _ws: string,
      channelId: string,
      h: { onRunEvent: (f: AgentRunEventFrame) => void; onResync: () => void }
    ) => {
      handlers.set(channelId, h);
      return () => stops.push(channelId);
    },
  } as unknown as RealtimeHandle;
  const frame = (channelId: string): AgentRunEventFrame => ({
    type: "agent.run.event",
    v: 1,
    ts: Date.now(),
    payload: { run_id: RUN_1, channel_id: channelId, kind: "stage" },
  });
  return { realtime, handlers, stops, frame };
}

/** 이어지는 마이크로태스크를 흘려 보낸다. */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRunProgress();
  resetAgentWorking();
});
afterEach(() => {
  vi.useRealTimers();
  resetRunProgress();
});

describe("진행 읽기", () => {
  it("시작하면 에이전트가 있는 채널마다 한 번 읽고, 대기 순번이 신호가 된다", async () => {
    const fetchProgress = vi.fn(async (_ws: string, ch: string) =>
      ch === CH_A ? [row()] : []
    );
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B, CH_A.toUpperCase()],
      realtime: null,
      fetchProgress,
    });
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    const [signal] = runProgressSignals();
    expect(signal).toMatchObject({ state: "queued", runId: RUN_1 });
    expect(runFactsFor(RUN_1.toUpperCase())?.queuePosition).toBe(2);
    stop();
  });

  it("agent.run.event 프레임이 오면 그 채널만 다시 읽는다", async () => {
    const fetchProgress = vi.fn(async (_ws: string, _ch: string) => [row()]);
    const { realtime, handlers, frame } = fakeRealtime();
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B],
      realtime,
      fetchProgress,
    });
    await settle();
    fetchProgress.mockClear();
    fetchProgress.mockResolvedValue([row({ phase: "claimed", queuePosition: undefined })]);
    handlers.get(CH_A)?.onRunEvent(frame(CH_A));
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchProgress.mock.calls[0]?.[1]).toBe(CH_A);
    expect(runFactsFor(RUN_1)?.phase).toBe("claimed");
    stop();
  });

  it("프레임이 몰려도 읽기는 겹치지 않고 끝난 뒤 한 번 더 읽는다", async () => {
    let release: (rows: AgentRunProgress[]) => void = () => {};
    const fetchProgress = vi.fn(
      () => new Promise<AgentRunProgress[]>((resolve) => (release = resolve))
    );
    const { realtime, handlers, frame } = fakeRealtime();
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A],
      realtime,
      fetchProgress,
    });
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) handlers.get(CH_A)?.onRunEvent(frame(CH_A));
    expect(fetchProgress).toHaveBeenCalledTimes(1); // 진행 중에는 새 요청이 없다
    release([row()]);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2); // 몰린 프레임은 한 번으로 접힌다
    release([row()]);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    stop();
  });

  it("열린 run이 있는 동안에만 30초마다 다시 읽는다", async () => {
    const fetchProgress = vi.fn(async () => [row()]);
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A],
      realtime: null,
      fetchProgress,
    });
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS);
    expect(fetchProgress).toHaveBeenCalledTimes(2);

    // 끝난 run만 남으면 타이머가 더는 두드리지 않는다.
    fetchProgress.mockResolvedValue([row({ phase: "succeeded", status: "succeeded" })]);
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS);
    expect(fetchProgress).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS * 4);
    expect(fetchProgress).toHaveBeenCalledTimes(3);
    expect(runProgressSignals()).toEqual([]); // 끝난 run은 열린 턴이 아니다
    expect(runFactsFor(RUN_1)?.phase).toBe("succeeded"); // 패널은 끝난 사유를 읽는다
    stop();
  });

  it("멈추면 구독과 타이머를 놓는다", async () => {
    const fetchProgress = vi.fn(async () => [row()]);
    const { realtime, stops } = fakeRealtime();
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B],
      realtime,
      fetchProgress,
    });
    await settle();
    stop();
    expect(stops.sort()).toEqual([CH_A, CH_B].sort());
    fetchProgress.mockClear();
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS * 3);
    expect(fetchProgress).not.toHaveBeenCalled();
  });
});

describe("구 서버 후퇴 경로", () => {
  it("404는 한 번 확인하고 접는다: 이후 프레임·타이머가 요청을 만들지 않는다", async () => {
    const fetchProgress = vi.fn(async () => {
      throw new ApiError(404, "not found");
    });
    const { realtime, handlers, frame } = fakeRealtime();
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B],
      realtime,
      fetchProgress,
    });
    await settle();
    expect(runProgressUnsupported()).toBe(true);
    const calls = fetchProgress.mock.calls.length;
    handlers.get(CH_A)?.onRunEvent(frame(CH_A));
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS * 5);
    expect(fetchProgress.mock.calls.length).toBe(calls);
    expect(runProgressSignals()).toEqual([]);
    expect(runFactsFor(RUN_1)).toBeNull();
    stop();
  });

  it("읽지 못하는 모양도 같다 (서버가 클라이언트보다 앞선 경우)", async () => {
    const fetchProgress = vi.fn(async () => {
      throw new WireShapeError();
    });
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A],
      realtime: null,
      fetchProgress,
    });
    await settle();
    expect(runProgressUnsupported()).toBe(true);
    stop();
  });

  it("네트워크·5xx는 접지 않는다: 직전 답을 두고 다음에 다시 읽는다", async () => {
    const fetchProgress = vi
      .fn()
      .mockResolvedValueOnce([row()])
      .mockRejectedValueOnce(new ApiError(503, "unavailable"))
      .mockResolvedValue([row({ phase: "claimed", queuePosition: undefined })]);
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A],
      realtime: null,
      fetchProgress,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS);
    expect(runProgressUnsupported()).toBe(false);
    expect(runFactsFor(RUN_1)?.phase).toBe("queued"); // 오류가 상태를 지우지 않았다
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_POLL_MS);
    expect(runFactsFor(RUN_1)?.phase).toBe("claimed");
    expect(runProgressSnapshot().get(CH_A)).toHaveLength(1);
    stop();
  });
});

describe("서버가 답한 신호는 클라이언트 시계로 지워지지 않는다 (ADR-0200)", () => {
  it("zombie 청소는 server 신호를 건드리지 않는다 — 11분 대기도 그대로다", async () => {
    vi.setSystemTime(T0 + 11 * 60_000);
    const fetchProgress = vi.fn(async () => [row()]);
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A],
      realtime: null,
      fetchProgress,
    });
    await settle();
    const [signal] = runProgressSignals();
    if (signal === undefined) throw new Error("signal");
    markAgentWorking(signal);
    sweepAgentWorking(Date.now() + ZOMBIE_CLEAR_MS * 10);
    expect(agentWorkingSnapshot().size).toBe(1);

    // 같은 신호에서 server만 빼면 청소가 지운다 — 시험이 규칙을 잡는다는 증거.
    clearAgentWorking(signal.channelId, signal.memberId);
    const { server: _s, ...legacy } = signal;
    markAgentWorking(legacy);
    sweepAgentWorking(Date.now() + ZOMBIE_CLEAR_MS * 10);
    expect(agentWorkingSnapshot().size).toBe(0);
    stop();
  });
});
