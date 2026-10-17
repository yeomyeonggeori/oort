// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunLedger, AgentRunProgress } from "@momo/core/lib/api";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { Directory } from "@/features/workspace/useWorkspace";
import { MessageRunStatus } from "./MessageRunStatus";
import { notifyRunLedgerFrame } from "./agentRunProgressStore";

const fetchEvents =
  vi.fn<(ws: string, runId: string, options?: { includeDoorbell?: boolean }) => Promise<AgentRunLedger>>();
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchAgentRunEvents: (ws: string, runId: string, options?: { includeDoorbell?: boolean }) =>
      fetchEvents(ws, runId, options),
  };
});

// =============================================================================
// 보낸 메시지 아래 상태 줄 (#3824, #4020에서 「사람이 알아야 하는 상태」로 좁힘). 평소의
// 영수증(받았어요 → 가져감 → 완료)은 타임라인 본 줄에 서지 않는다. 단계의 말은 core가 갖고 거기서 검증된다. 여기서
// 지키는 것: 줄이 서는가, 깨우는 신호를 원장에서 `?include=doorbell`로 읽는가, 그 행의
// 프레임이 오면 30초를 기다리지 않고 다시 읽는가, 모르는 원장 종류가 와도 줄이 서는가.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const MSG = "00000000-0000-7000-8000-0000000a0001";
const T = Date.now();

function run(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: MSG,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T - 3_000,
    updatedAtMs: T - 3_000,
    ...extra,
  };
}

const directory = { members: [], byId: new Map() } as unknown as Directory;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(runs: AgentRunProgress[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = { workspaceId: WS } as unknown as SessionContextValue;
  const render = (next: AgentRunProgress[]) =>
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session },
            createElement(MessageRunStatus, {
              messageId: MSG,
              channelId: CH,
              createdAtMs: T - 3_000,
              runs: next,
              directory,
            })
          )
        )
      );
    });
  render(runs);
  return render;
}

// 5 ms of the fake clock, not of the wall clock. The chain being waited for (mount -> effect ->
// query -> mocked fetch -> notify batching on setTimeout(0) -> render) hops through timers armed
// AFTER the wait started, and a real 5 ms sleep returns as soon as ITS timer fires -- on a starved
// machine that is before the later hops ran (seen: ["received"] where ["received","woken"] was
// expected). Advancing the fake clock runs every timer due inside the window, including the ones the
// advance itself causes, so the chain finishes in the order it would have run and the wait is as long
// as the work, not as long as the machine's mood.
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
};

const rows = () => [...(host?.querySelectorAll('[data-testid="message-run-status-row"]') ?? [])];

const steps = () =>
  [...(host?.querySelectorAll('[data-testid="message-run-status-steps"] [data-step]') ?? [])].map(
    (node) => node.getAttribute("data-step")
  );

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  // Timers only: `Date`, `performance`, the microtask queue and React's scheduler stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  fetchEvents.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("MessageRunStatus", () => {
  it("run이 없으면 아무것도 그리지 않는다(옛 서버·에이전트를 부르지 않은 메시지)", async () => {
    mount([]);
    await settle();
    expect(rows()).toHaveLength(0);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("평소의 진행은 줄을 세우지 않는다: 대기(깨우는 신호 정상)·가져감·작업 중·완료·취소", async () => {
    fetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        { ordinal: 1, kind: "queued", createdAtMs: T - 3_000 },
        { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: T - 2_500 },
      ],
    });
    mount([run()]);
    await settle();
    // 깨우는 신호는 읽어서 확인한다(닿지 않았으면 줄이 서야 하므로). 정상이면 줄이 없다.
    expect(fetchEvents).toHaveBeenCalledWith(WS, RUN, { includeDoorbell: true });
    expect(rows()).toHaveLength(0);

    for (const extra of [
      { phase: "claimed", status: "queued", leaseState: "live", claimedAtMs: T - 5_000 },
      {
        phase: "running",
        status: "running",
        leaseState: "live",
        claimedAtMs: T - 2 * 60_000,
        startedAtMs: T - 2 * 60_000,
        lastEventAtMs: T - 60_000,
      },
      { phase: "succeeded", status: "succeeded", finishedAtMs: T - 1_000 },
      { phase: "cancelled", status: "cancelled", endReason: "human_cancelled", finishedAtMs: T - 1_000 },
    ] as Partial<AgentRunProgress>[]) {
      act(() => root?.unmount());
      host?.remove();
      mount([run(extra)]);
      await settle();
      expect(rows(), String(extra.phase)).toHaveLength(0);
    }
  });

  it("작업이 시작된 run은 원장을 새로 묻지 않는다", async () => {
    mount([run({ phase: "running", status: "running", leaseState: "live", startedAtMs: T - 60_000 })]);
    await settle();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("깨우는 신호가 닿지 않았으면 줄이 선다(모르는 원장 종류가 섞여 와도)", async () => {
    fetchEvents.mockResolvedValue(
      agentRunLedgerFromWire({
        runId: RUN,
        events: [
          { ordinal: 1, kind: "queued", createdAtMs: T - 3_000 },
          { ordinal: 2, kind: "tool_call", createdAtMs: T - 2_900 },
          { ordinal: 3, kind: "doorbell_rung", code: "urgent_failed", createdAtMs: T - 2_000 },
        ],
      })
    );
    mount([run()]);
    // 원장을 읽기 전에는 줄이 없다: 닿았는지 모르는 채로 「받았어요」만 그리지 않는다.
    expect(rows()).toHaveLength(0);
    await settle();
    expect(steps()).toEqual(["received", "woken"]);
    expect(host?.textContent).toContain("깨우는 신호가 닿지 않음");
  });

  it("나중에 깨우는 신호가 닿지 않은 것이 원장에 오면(프레임) 그때 줄이 선다", async () => {
    fetchEvents.mockResolvedValue({ runId: RUN, events: [{ ordinal: 1, kind: "queued", createdAtMs: T - 3_000 }] });
    mount([run()]);
    await settle();
    expect(rows()).toHaveLength(0);
    fetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        { ordinal: 1, kind: "queued", createdAtMs: T - 3_000 },
        { ordinal: 2, kind: "doorbell_rung", code: "urgent_failed", createdAtMs: T - 2_000 },
      ],
    });
    act(() => notifyRunLedgerFrame(RUN));
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(steps()).toEqual(["received", "woken"]);
  });

  it("실패·시간 초과·승인 대기·가져간 뒤 소식 끊김은 줄이 선다", async () => {
    const trouble: [Partial<AgentRunProgress>, string[], string][] = [
      [
        {
          phase: "failed",
          status: "failed",
          claimedAtMs: T - 200_000,
          startedAtMs: T - 199_000,
          finishedAtMs: T - 3_000 + 192_000,
          createdAtMs: T - 3_000,
        },
        ["received", "claimed", "result"],
        "실패",
      ],
      [
        { phase: "timed_out", status: "timed_out", endReason: "lease_abandoned", finishedAtMs: T - 1_000 },
        ["received", "result"],
        "신호 소실",
      ],
      [
        { phase: "awaiting_approval", status: "awaiting_approval", leaseState: "live", claimedAtMs: T - 9_000, startedAtMs: T - 8_000 },
        ["received", "claimed", "working", "approval"],
        "승인 대기",
      ],
      [
        { phase: "claimed", status: "queued", leaseState: "stale", claimedAtMs: T - 6 * 60_000 },
        ["received", "claimed"],
        "소식이 없어요",
      ],
    ];
    for (const [extra, expected, word] of trouble) {
      act(() => root?.unmount());
      host?.remove();
      fetchEvents.mockResolvedValue({ runId: RUN, events: [] });
      mount([run(extra)]);
      await settle();
      expect(steps(), word).toEqual(expected);
      expect(host?.textContent, word).toContain(word);
    }
  });

  it("줄이 모두 빠지면 DOM에 아무것도 남지 않는다(타임라인 행에 빈 여백을 남기지 않는다)", async () => {
    mount([run({ phase: "succeeded", status: "succeeded", finishedAtMs: T - 1_000 })]);
    await settle();
    expect(host?.childElementCount ?? 0).toBe(0);
  });
});
