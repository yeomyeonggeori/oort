// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRunLedgerFromWire, ApiError, type AgentRunLedger } from "@momo/core/lib/api";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { RUN_LEDGER_POLL_MS, useRunLedger, type RunLedgerView } from "./useRunLedger";

const fetchEvents = vi.fn<(ws: string, runId: string) => Promise<AgentRunLedger>>();
// 무엇을 묻는지(`include` 옵션)는 호출 인자와 따로 모아서 잰다.
const seen = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchAgentRunEvents: (ws: string, runId: string, options?: unknown) => {
      seen.options.push(options);
      return fetchEvents(ws, runId);
    },
  };
});

// =============================================================================
// 서버 원장 읽기 (ADR-0200 U2). 원장은 커서가 없어 통째로 다시 읽는다. 다시 읽는
// 때는 셋이다: 열 때, 서버가 새 사실을 알릴 때(진행 읽기의 지문), 열린 run이 있는
// 동안 30초마다. 서버가 모르는 run은 묻지 않는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

const ledger = (stage: string): AgentRunLedger => ({
  runId: RUN,
  events: [{ ordinal: 1, kind: "stage", stage, createdAtMs: T }],
});

function facts(extra: Partial<ServerRunFacts> = {}): ServerRunFacts {
  return { phase: "running", leaseState: "live", queuedAtMs: T, ...extra };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: RunLedgerView | null = null;

function Probe({ runId, f }: { runId: string | null; f: ServerRunFacts | null }) {
  latest = useRunLedger(runId, f);
  return null;
}

function mount(runId: string | null, f: ServerRunFacts | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = { workspaceId: WS } as unknown as SessionContextValue;
  const render = (nextRun: string | null, nextFacts: ServerRunFacts | null) =>
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SessionProvider, { value: session }, createElement(Probe, { runId: nextRun, f: nextFacts }))
        )
      );
    });
  render(runId, f);
  return render;
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  // react-query는 갱신 알림을 setTimeout(0)으로 배치한다. 그것까지 가짜로 만들면 상태가
  // 영영 닿지 않으므로 주기(setInterval)만 가짜로 쓴다.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  fetchEvents.mockReset();
  seen.options.length = 0;
  latest = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("useRunLedger", () => {
  it("서버가 모르는 run은 원장을 묻지 않는다", async () => {
    mount(RUN, null);
    await settle();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(latest?.rows).toEqual([]);
  });

  it("열면 읽고, 줄이 기록으로 선다", async () => {
    fetchEvents.mockResolvedValue(ledger("채널 이름 확인"));
    mount(RUN, facts());
    await settle();
    expect(fetchEvents).toHaveBeenCalledWith(WS, RUN);
    expect(latest?.rows.map((r) => r.text)).toEqual(["채널 이름 확인"]);
  });

  it("서버가 새 사실(단계·승인·종료)을 알리면 다시 읽는다", async () => {
    fetchEvents.mockResolvedValue(ledger("1단계"));
    const render = mount(RUN, facts({ latestStage: "1단계", lastEventAtMs: T }));
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(1);

    fetchEvents.mockResolvedValue(ledger("2단계"));
    render(RUN, facts({ latestStage: "2단계", lastEventAtMs: T + 1_000 }));
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(latest?.rows[0]?.text).toBe("2단계");

    // 같은 사실이면 다시 읽지 않는다.
    render(RUN, facts({ latestStage: "2단계", lastEventAtMs: T + 1_000 }));
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("열린 run이 있는 동안에만 30초마다 읽는다", async () => {
    fetchEvents.mockResolvedValue(ledger("단계"));
    const render = mount(RUN, facts());
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_LEDGER_POLL_MS);
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);

    // 끝난 run은 지문이 바뀌어 한 번 더 읽고(종료 줄), 그 뒤에는 두드리지 않는다.
    render(RUN, facts({ phase: "succeeded" }));
    await settle();
    const afterEnd = fetchEvents.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_LEDGER_POLL_MS * 4);
    });
    expect(fetchEvents.mock.calls.length).toBe(afterEnd);
  });

  it("읽지 못하면 직전 줄을 두고 오류를 알린다. 없는 경로는 다시 묻지 않는다", async () => {
    fetchEvents.mockRejectedValue(new ApiError(404, "not found"));
    mount(RUN, facts());
    await settle();
    expect(latest?.isError).toBe(true);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });
  it("활동 include를 모르는 읽기에서 에이전트 보고를 0으로 지어내지 않는다: 「모름」이고 요약은 단계만 센다 (#4657)", async () => {
    fetchEvents.mockResolvedValue(ledger("단계"));
    mount(RUN, facts());
    await settle();
    expect(latest?.activity).toMatchObject({ supported: false, rows: [], plan: null, tally: null });
    expect(latest?.report).toEqual({ stages: 1, kinds: [] });
    expect(latest?.events.map((event) => event.kind)).toEqual(["stage"]);
  });
  it("열면 깨우는 신호·oort가 잰 도구 호출·에이전트가 알린 활동을 함께 묻는다 (#4654·#4657)", async () => {
    fetchEvents.mockResolvedValue(ledger("단계"));
    mount(RUN, facts());
    await settle();
    expect(seen.options).toEqual([{ includeDoorbell: true, includeTools: true, includeActivity: true }]);
  });

  it("합계가 오면 「oort 기록」 재료가 서고, 합계가 없으면 「모름」이다 (#4654)", async () => {
    fetchEvents.mockResolvedValue(
      agentRunLedgerFromWire({
        runId: RUN,
        events: [
          { ordinal: 1, kind: "tool_call", tool: "oort_run_event", code: "ok", durationMs: 4, createdAtMs: T },
        ],
        toolTally: [{ tool: "oort_run_event", ok: 1, error: 0, durationMsSum: 4 }],
        toolCallRowsCapped: false,
      })
    );
    const render = mount(RUN, facts());
    await settle();
    expect(latest?.tools).toMatchObject({ supported: true, tally: { calls: 1, failed: 0 }, capped: false });
    expect(latest?.tools?.rows.map((r) => r.label)).toEqual(["oort_run_event"]);
    // 기록 칸의 줄에는 도구 호출이 없다.
    expect(latest?.rows).toEqual([]);

    fetchEvents.mockResolvedValue(ledger("단계"));
    render(RUN, facts({ latestStage: "다음", lastEventAtMs: T + 1_000 }));
    await settle();
    expect(latest?.tools).toMatchObject({ supported: false, tally: null, rows: [] });
  });

  it("oort가 잰 호출은 요약에 섞이지 않는다: 요약의 숫자는 에이전트가 알린 것뿐이다 (#4654·#4657)", async () => {
    fetchEvents.mockResolvedValue(
      agentRunLedgerFromWire({
        runId: RUN,
        events: [
          { ordinal: 1, kind: "tool_call", tool: "oort_job_start", code: "ok", durationMs: 4, createdAtMs: T },
          { ordinal: 2, kind: "tool_call", tool: "oort_run_complete", code: "ok", durationMs: 6, createdAtMs: T + 1 },
          { ordinal: 3, kind: "stage", stage: "문서 읽기", createdAtMs: T + 2 },
          { ordinal: 4, kind: "activity", createdAtMs: T + 3, activity: { id: "a1", kind: "run", status: "completed", n: 12, startedAtMs: T + 3 } },
        ],
        toolTally: [
          { tool: "oort_job_start", ok: 1, error: 0, durationMsSum: 4 },
          { tool: "oort_run_complete", ok: 1, error: 0, durationMsSum: 6 },
        ],
        toolCallRowsCapped: false,
        activityTally: [{ kind: "run", completed: 12, failed: 0 }],
        activityRowsTrimmed: false,
      })
    );
    mount(RUN, facts({ phase: "succeeded" }));
    await settle();
    expect(latest?.tools?.tally?.calls).toBe(2);
    // 요약은 oort 호출 둘이 아니라 에이전트가 알린 단계 1·명령 12를 말한다.
    expect(latest?.report).toEqual({ stages: 1, kinds: [{ toolKind: "run", count: 12 }] });
    expect(latest?.activity).toMatchObject({ supported: true, trimmed: false });
    expect(latest?.activity?.rows.map((row) => row.id)).toEqual(["agent|activity|a1"]);
    // 기록 칸의 줄에는 도구 호출도 활동도 없다(단계만).
    expect(latest?.rows.map((row) => row.kind)).toEqual(["stage"]);
  });

  it("계획의 「지금 단계」는 서버가 running이라 할 때만 선다: 승인을 기다리는 열린 run은 일하는 중이 아니다 (#4657)", async () => {
    fetchEvents.mockResolvedValue(
      agentRunLedgerFromWire({
        runId: RUN,
        events: [{ ordinal: 1, kind: "plan", createdAtMs: T, plan: [{ text: "표 정리", status: "in_progress" }] }],
        activityTally: [],
      })
    );
    const render = mount(RUN, facts({ phase: "awaiting_approval" }));
    await settle();
    expect(latest?.activity?.plan).toMatchObject({ hasCurrent: false, live: false });
    render(RUN, facts({ phase: "running", lastEventAtMs: T + 1_000 }));
    await settle();
    expect(latest?.activity?.plan).toMatchObject({ hasCurrent: true, live: true });
  });
});
