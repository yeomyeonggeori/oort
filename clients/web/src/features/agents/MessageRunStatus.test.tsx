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
// 보낸 메시지 아래 상태 줄 (#3824). 단계의 말은 core가 갖고 거기서 검증된다. 여기서
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

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

const steps = () =>
  [...(host?.querySelectorAll('[data-testid="message-run-status-steps"] [data-step]') ?? [])].map(
    (node) => node.getAttribute("data-step")
  );

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  fetchEvents.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("MessageRunStatus", () => {
  it("run이 없으면 아무것도 그리지 않는다(옛 서버·에이전트를 부르지 않은 메시지)", async () => {
    mount([]);
    await settle();
    expect(host?.querySelector('[data-testid="message-run-status"]')).toBeNull();
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("받았어요가 곧바로 서고, 원장의 깨우는 신호가 오면 그 단계가 더해진다", async () => {
    fetchEvents.mockResolvedValue({ runId: RUN, events: [{ ordinal: 1, kind: "queued", createdAtMs: T - 3_000 }] });
    mount([run()]);
    // 원장을 읽기 전에도 「받았어요」는 이미 사실이다.
    expect(steps()).toEqual(["received"]);
    await settle();
    expect(fetchEvents).toHaveBeenCalledWith(WS, RUN, { includeDoorbell: true });
    expect(steps()).toEqual(["received"]);

    // 깨우는 신호 프레임: 진행 지문은 그대로지만 원장을 다시 읽는다.
    fetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        { ordinal: 1, kind: "queued", createdAtMs: T - 3_000 },
        { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: T - 2_500 },
      ],
    });
    act(() => notifyRunLedgerFrame(RUN));
    await settle();
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(steps()).toEqual(["received", "woken"]);
    expect(host?.textContent).toContain("받았어요 → 깨우는 신호 보냄");
    expect(host?.textContent).toContain("째 기다려요");
  });

  it("모르는 원장 종류가 섞여 와도 줄이 선다", async () => {
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
    await settle();
    expect(steps()).toEqual(["received", "woken"]);
    expect(host?.textContent).toContain("깨우는 신호가 닿지 않음");
  });

  it("작업이 시작된 run은 원장을 새로 묻지 않고 phase로 말한다", async () => {
    mount([
      run({
        phase: "running",
        status: "running",
        leaseState: "live",
        claimedAtMs: T - 2 * 60_000,
        startedAtMs: T - 2 * 60_000,
        lastEventAtMs: T - 60_000,
      }),
    ]);
    await settle();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(steps()).toEqual(["received", "claimed", "working"]);
    expect(host?.querySelector('[data-testid="message-run-status-detail"]')?.textContent).toBe(
      "2분째 · 마지막 보고 1분 전"
    );
  });

  it("끝난 run은 결과와 걸린 시간을 말한다", async () => {
    mount([
      run({
        phase: "succeeded",
        status: "succeeded",
        claimedAtMs: T - 200_000,
        startedAtMs: T - 199_000,
        finishedAtMs: T - 3_000 + 192_000,
        createdAtMs: T - 3_000,
      }),
    ]);
    await settle();
    expect(steps()).toEqual(["received", "claimed", "result"]);
    expect(host?.textContent).toContain("완료");
    expect(host?.textContent).toContain("3분 12초 걸림");
  });
});
