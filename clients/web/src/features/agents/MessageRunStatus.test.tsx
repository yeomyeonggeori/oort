// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type AgentLiveness,
  type AgentRunCancelResult,
  type AgentRunProgress,
  type RosterMember,
} from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { UNCOLLECTED_AFTER_MS, UNCOLLECTED_WORD } from "@momo/core/features/agents/runWaiting";
import { RUN_STATUS_WOKEN_FAILED } from "@momo/core/features/agents/runStatusLine";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { MessageRunStatus } from "./MessageRunStatus";
import { closeWorkPanel, workPanelSnapshot } from "./workLogStore";

const api = vi.hoisted(() => ({
  fetchAgentLiveness: vi.fn(),
  fetchAgentRunEvents: vi.fn(),
  cancelAgentRun: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

const nudge = vi.hoisted(() => vi.fn());
vi.mock("./agentRunProgressStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentRunProgressStore")>();
  return { ...actual, nudgeRunProgress: nudge };
});

// 「다시 깨우기」는 호스티드 연결 목록·쿨다운·권한을 스스로 읽는 별도 컴포넌트다(`WakeAgentButton`). 여기서는
// **언제 서는가**(어떤 run·어떤 생존 상태일 때 줄이 그것을 세우는가)만 잰다.
vi.mock("./WakeAgentButton", async () => {
  const { createElement: h } = await import("react");
  return {
    WakeAgentButton: (props: { agentId: string; state: string }) =>
      h("span", { "data-testid": "wake-stub", "data-agent": props.agentId, "data-state": props.state }),
  };
});

// =============================================================================
// 보낸 메시지 아래 **예외 줄** (#4619 D). 평소의 진행은 줄을 세우지 않는다(레일과 칩이 말한다). 줄이 서는 것은
// 아직 받지 않았어요(유예 뒤)·깨우는 신호가 닿지 않음·실패·시간 초과뿐이고, 행동은 기존 것(다시 깨우기·취소·
// 에이전트 설정)이며, 줄은 가만히 있다가 유예 마감에 **한 번만** 다시 그려진다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const MSG = "00000000-0000-7000-8000-0000000a0001";
const SEC = 1000;
const MIN = 60 * SEC;

const REQUESTER = "00000000-0000-7000-8000-000000000101";
const ADMIN = "00000000-0000-7000-8000-000000000102";
const BYSTANDER = "00000000-0000-7000-8000-000000000103";

const human = (id: string, name: string, role: "owner" | "admin" | "member") =>
  ({
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: name,
    handle: name,
    role,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as unknown as RosterMember;

const bot = {
  id: AGENT,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "달무리봇",
  handle: "dalmuri-bot",
  channelCount: 1,
  channelIds: [CH],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as RosterMember;
const directory = makeDirectory([
  bot,
  human(REQUESTER, "이도현", "member"),
  human(ADMIN, "박서연", "admin"),
  human(BYSTANDER, "최민수", "member"),
]);

function run(now: number, extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
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
    createdAtMs: now - 10 * MIN,
    updatedAtMs: now - 10 * MIN,
    ...extra,
  };
}

function liveness(state: AgentLiveness["state"]): AgentLiveness {
  return { agentMemberId: AGENT, state, lastSignalAtMs: Date.now() - 3 * 60 * MIN };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(
  runs: AgentRunProgress[],
  options: {
    createdAtMs?: number;
    openProfile?: ((id: string) => void) | null;
    /** 화면을 보는 사람(기본: 요청자 본인). */
    viewer?: string;
    /** 에이전트를 부른 메시지의 작성자(기본: 요청자). `null`이면 모른다. */
    requester?: string | null;
  } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = {
    workspaceId: WS,
    connStatus: "connected",
    session: { member: { id: options.viewer ?? REQUESTER } },
  } as unknown as SessionContextValue;
  const draw = (nextRuns: AgentRunProgress[]) =>
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session },
            createElement(
              OpenAgentProfileContext.Provider,
              { value: options.openProfile ?? null },
              createElement(MessageRunStatus, {
                messageId: MSG,
                channelId: CH,
                createdAtMs: options.createdAtMs ?? Date.now() - 60 * MIN,
                ...(options.requester === null ? {} : { requesterId: options.requester ?? REQUESTER }),
                runs: nextRuns,
                directory,
              })
            )
          )
        )
      );
    });
  draw(runs);
  redraw = draw;
  return client;
}

/** 같은 루트를 그대로 두고 run 목록만 바꿔 다시 그린다(서버가 진행을 새로 읽어 준 것처럼): 행이 다시 마운트되지 않는다. */
let redraw: (runs: AgentRunProgress[]) => void = () => undefined;

const settle = async (ms = 5) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const lines = () => [...(host?.querySelectorAll('[data-testid="run-exception"]') ?? [])];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  api.fetchAgentLiveness.mockReset();
  api.fetchAgentRunEvents.mockReset();
  api.cancelAgentRun.mockReset();
  api.fetchAgentLiveness.mockRejectedValue(new ApiError(404, "not found"));
  // 원장(깨우는 신호 행): 기본은 행이 없다. 깨우는 신호가 닿지 않은 경우는 시험이 따로 채운다.
  api.fetchAgentRunEvents.mockResolvedValue({ runId: RUN, events: [] });
  nudge.mockReset();
  closeWorkPanel();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  closeWorkPanel();
});

describe("예외 줄이 서는 때", () => {
  it("run이 없으면 아무것도 그리지 않는다(옛 서버·에이전트를 부르지 않은 메시지)", async () => {
    mount([]);
    await settle();
    expect(host?.childElementCount ?? 0).toBe(0);
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });

  it("평소의 진행에는 줄이 없다: 유예 안의 대기·가져감(소식 끊김 포함)·작업 중·승인 대기·일시 정지·완료·취소", async () => {
    const now = Date.now();
    const quiet: Partial<AgentRunProgress>[] = [
      { createdAtMs: now - 20 * SEC, updatedAtMs: now - 20 * SEC },
      { phase: "claimed", leaseState: "live", claimedAtMs: now - 5 * SEC },
      { phase: "claimed", leaseState: "stale", claimedAtMs: now - 34 * MIN },
      { phase: "running", status: "running", leaseState: "live", startedAtMs: now - 2 * MIN, lastEventAtMs: now - MIN },
      { phase: "awaiting_approval", status: "awaiting_approval", startedAtMs: now - 8 * SEC },
      { phase: "paused", status: "paused", startedAtMs: now - 8 * SEC },
      { phase: "succeeded", status: "succeeded", finishedAtMs: now - SEC },
      { phase: "cancelled", status: "cancelled", endReason: "human_cancelled", finishedAtMs: now - SEC },
    ];
    for (const extra of quiet) {
      mount([run(now, extra)]);
      await settle();
      expect(lines(), JSON.stringify(extra)).toHaveLength(0);
      expect(host?.childElementCount ?? 0).toBe(0);
      act(() => root?.unmount());
      host?.remove();
    }
    // 유예 안의 대기는 서버의 생존 판정도 읽지 않는다: 줄이 서기 전에는 쓸 데가 없다.
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });

  it("아직 받지 않았어요(유예 뒤): 낱말, 서버 판정에 근거가 있을 때만 이유, 행동 셋", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    const now = Date.now();
    mount([run(now)], { openProfile: () => undefined });
    await settle();
    expect(lines()).toHaveLength(1);
    const line = q("run-exception");
    expect(line?.getAttribute("data-kind")).toBe("uncollected");
    expect(q("run-exception-text")?.textContent).toBe(
      `달무리봇: ${UNCOLLECTED_WORD} · 연결이 꺼져 있을 수 있어요`
    );
    // 행동: 다시 깨우기(생존 판정이 있을 때), 취소(StopRunControl), 에이전트 설정 열기.
    expect(q("wake-stub")?.getAttribute("data-state")).toBe("woken_not_collected");
    expect(q("wake-stub")?.getAttribute("data-agent")).toBe(AGENT);
    expect(q("agent-work-panel-stop-arm")?.textContent).toBe("취소");
    expect(q("run-exception-settings")?.textContent).toBe("에이전트 설정 열기");
    expect(api.fetchAgentLiveness).toHaveBeenCalledWith(WS, AGENT);
  });

  it("생존 판정이 없으면(호스티드 아님) 이유도 다시 깨우기도 없다 — 지어내지 않는다", async () => {
    mount([run(Date.now())]);
    await settle();
    expect(q("run-exception-text")?.textContent).toBe(`달무리봇: ${UNCOLLECTED_WORD}`);
    expect(q("wake-stub")).toBeNull();
    // 취소는 생존 판정과 무관하다(요청이 열려 있으면 취소할 수 있다).
    expect(q("agent-work-panel-stop-arm")).not.toBeNull();
  });

  it("살아 있는데 일을 안 가져가는 에이전트에게는 이유를 붙이지 않는다", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("work_waiting"));
    mount([run(Date.now())]);
    await settle();
    expect(q("run-exception-text")?.textContent).toBe(`달무리봇: ${UNCOLLECTED_WORD}`);
  });

  it("실패·시간 초과: 낱말과 서버가 쓴 이유, 행동 없음(되돌릴 것이 없다), 색이 다르다", async () => {
    const now = Date.now();
    mount([run(now, { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: now - SEC })]);
    await settle();
    expect(q("run-exception")?.getAttribute("data-kind")).toBe("failed");
    expect(q("run-exception-text")?.textContent).toBe("달무리봇: 실패 · 에이전트가 오류로 끝냈어요");
    expect(q("run-exception")?.querySelector("svg")?.getAttribute("class")).toContain("text-danger");
    expect(q("agent-work-panel-stop-arm")).toBeNull();
    expect(q("wake-stub")).toBeNull();
    expect(q("run-exception-settings")).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    mount([
      run(now, { phase: "timed_out", status: "timed_out", endReason: "lease_abandoned", finishedAtMs: now - SEC }),
    ]);
    await settle();
    expect(q("run-exception")?.getAttribute("data-kind")).toBe("timed_out");
    expect(q("run-exception-text")?.textContent).toBe(
      "달무리봇: 신호 소실 · 가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요"
    );
    // 신호 없음은 오류가 아니다(ADR-0132): 경고색이다.
    expect(q("run-exception")?.querySelector("svg")?.getAttribute("class")).toContain("text-warn");
  });

  it("줄이 모두 빠지면 DOM에 아무것도 남지 않는다(타임라인 행에 빈 여백을 남기지 않는다)", async () => {
    mount([run(Date.now(), { phase: "succeeded", status: "succeeded", finishedAtMs: Date.now() - SEC })]);
    await settle();
    expect(host?.childElementCount ?? 0).toBe(0);
  });

  it("어떤 줄에도 「n초」가 없다", async () => {
    const now = Date.now();
    mount([run(now), run(now, { id: "r2", phase: "failed", status: "failed", endReason: "agent_error" })]);
    await settle();
    expect(lines()).toHaveLength(2);
    expect(host?.textContent).not.toMatch(/\d+\s*초/);
  });
});

describe("깨우는 신호가 닿지 않음 — 4번째 예외 (#4619 planner 결정 5)", () => {
  const rung = (code: string, createdAtMs: number) => ({
    runId: RUN,
    events: [
      { ordinal: 1, kind: "queued" as const, createdAtMs: createdAtMs - SEC },
      { ordinal: 2, kind: "doorbell_rung" as const, code, createdAtMs },
    ],
  });

  it("아직 아무도 가져가지 않은 요청에 신호가 닿지 않았으면 유예를 기다리지 않고 줄이 선다(낱말은 폰과 같은 것)", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockResolvedValue(rung("leading_failed", now - 10 * SEC));
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(now, { createdAtMs: now - 20 * SEC, updatedAtMs: now - 20 * SEC })], {
      openProfile: () => undefined,
    });
    // 원장을 읽은 뒤에야 줄이 서고(첫 번째 정착), 그 줄의 에이전트 생존 판정을 읽는다(두 번째 정착).
    await settle();
    await settle();
    expect(lines()).toHaveLength(1);
    expect(q("run-exception")?.getAttribute("data-kind")).toBe("wake_failed");
    expect(q("run-exception-text")?.textContent).toBe(
      `달무리봇: ${RUN_STATUS_WOKEN_FAILED} · 연결이 꺼져 있을 수 있어요`
    );
    // 행동: 다시 깨우기(생존 판정이 있을 때)·취소·설정.
    expect(q("wake-stub")?.getAttribute("data-state")).toBe("woken_not_collected");
    expect(q("agent-work-panel-stop-arm")?.textContent).toBe("취소");
    expect(q("run-exception-settings")).not.toBeNull();
    // 원장은 작업 패널과 같은 캐시 키로 읽는다(`?include=doorbell`).
    expect(api.fetchAgentRunEvents).toHaveBeenCalledWith(WS, RUN.toLowerCase(), { includeDoorbell: true, includeTools: true });
  });

  it("생존 판정이 없어도(호스티드 아님) 줄은 서고, 이유와 다시 깨우기만 빠진다 — 지어내지 않는다", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockResolvedValue(rung("trailing_failed", now - 5 * SEC));
    mount([run(now, { createdAtMs: now - 30 * SEC, updatedAtMs: now - 30 * SEC })]);
    await settle();
    expect(q("run-exception-text")?.textContent).toBe(`달무리봇: ${RUN_STATUS_WOKEN_FAILED}`);
    expect(q("wake-stub")).toBeNull();
    expect(q("agent-work-panel-stop-arm")).not.toBeNull();
  });

  it("신호가 닿았으면(ok) 줄이 없고 서버의 생존 판정도 읽지 않는다", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockResolvedValue(rung("leading_ok", now - 10 * SEC));
    mount([run(now, { createdAtMs: now - 20 * SEC, updatedAtMs: now - 20 * SEC })]);
    await settle();
    expect(lines()).toHaveLength(0);
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });

  it("원장을 못 읽으면 줄을 지어내지 않는다", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockRejectedValue(new ApiError(404, "not found"));
    mount([run(now, { createdAtMs: now - 20 * SEC, updatedAtMs: now - 20 * SEC })]);
    await settle();
    expect(lines()).toHaveLength(0);
  });

  it("가져간 run은 신호가 닿지 않았어도 줄이 없고 원장도 읽지 않는다(에이전트가 일을 잡았다)", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockResolvedValue(rung("leading_failed", now - 10 * SEC));
    mount([run(now, { phase: "claimed", leaseState: "live", claimedAtMs: now - 5 * SEC })]);
    await settle();
    expect(lines()).toHaveLength(0);
    expect(api.fetchAgentRunEvents).not.toHaveBeenCalled();
  });

  it("유예를 넘으면 같은 run은 「아직 받지 않았어요」가 되고 신호 실패는 이유로 남는다", async () => {
    const now = Date.now();
    api.fetchAgentRunEvents.mockResolvedValue(rung("leading_failed", now - 9 * MIN));
    mount([run(now)]);
    await settle();
    expect(q("run-exception")?.getAttribute("data-kind")).toBe("uncollected");
    expect(q("run-exception-text")?.textContent).toBe(
      `달무리봇: ${UNCOLLECTED_WORD} · 깨우는 신호가 닿지 않았어요`
    );
  });

  it("끝난 run(실패·시간 초과)은 원장을 읽지 않는다 — 줄에 필요한 사실은 진행 읽기에 다 있다", async () => {
    const now = Date.now();
    mount([run(now, { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: now - SEC })]);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(api.fetchAgentRunEvents).not.toHaveBeenCalled();
  });
});

describe("유예 마감에 한 번 다시 그린다", () => {
  // 시계가 필요한 시험: `Date`도 가짜로 돌려 타이머와 함께 흐르게 한다.
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date("2026-10-27T03:00:00Z") });
  });

  it("마감 전에는 줄이 없고, 마감이 지난 뒤에 선다 — 매초 도는 시계 없이", async () => {
    const now = Date.now();
    // 마감까지 5초 남은 대기 run.
    mount([run(now, { createdAtMs: now - (UNCOLLECTED_AFTER_MS - 5 * SEC) })]);
    await settle(1);
    expect(lines()).toHaveLength(0);
    await settle(4 * SEC);
    expect(lines()).toHaveLength(0);
    await settle(2 * SEC);
    expect(lines()).toHaveLength(1);
    expect(q("run-exception")?.getAttribute("data-kind")).toBe("uncollected");
  });

  it("가져가면(마감 전에 run이 바뀌면) 줄은 끝내 서지 않는다", async () => {
    const now = Date.now();
    const waiting = run(now, { createdAtMs: now - (UNCOLLECTED_AFTER_MS - 5 * SEC) });
    mount([waiting]);
    await settle(1);
    act(() => root?.unmount());
    host?.remove();
    mount([{ ...waiting, phase: "claimed", leaseState: "live", claimedAtMs: now }]);
    await settle(10 * SEC);
    expect(lines()).toHaveLength(0);
  });
});

describe("행동은 기존 것이다", () => {
  it("줄의 글을 누르면 그 run의 작업 패널(진행 과정)이 열린다", async () => {
    mount([run(Date.now())]);
    await settle();
    act(() => q("run-exception-open")?.click());
    expect(workPanelSnapshot()).toMatchObject({
      runId: RUN,
      memberId: AGENT,
      channelId: CH,
      origin: "message",
    });
    expect(q("run-exception-open")?.getAttribute("aria-label")).toBe(
      `달무리봇: ${UNCOLLECTED_WORD}. 진행 과정 열기`
    );
  });

  it("취소: 첫 탭은 묻고 둘째 탭이 `cancelAgentRun`을 보낸다(요청의 취소 낱말)", async () => {
    api.cancelAgentRun.mockResolvedValue({
      runId: RUN,
      status: "cancelled",
      linkedWorkSessionIds: [],
      workSessionsTerminated: false,
    } satisfies AgentRunCancelResult);
    mount([run(Date.now())]);
    await settle();
    act(() => q("agent-work-panel-stop-arm")?.click());
    expect(api.cancelAgentRun).not.toHaveBeenCalled();
    expect(q("agent-work-panel-stop-confirm")?.textContent).toContain("취소하면 이 요청은 여기서 끝나요.");
    await act(async () => {
      q("agent-work-panel-stop-commit")?.click();
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(api.cancelAgentRun).toHaveBeenCalledWith(WS, RUN);
    expect(q("agent-work-panel-stop-outcome")?.textContent).toBe("달무리봇의 요청을 취소했어요.");
  });

  it("취소 확인 줄·결과 문장은 같은 줄의 다른 행동 곁이 아니라 자기 줄을 쓴다(basis-full) — 쉬는 단추는 그렇지 않다", async () => {
    api.cancelAgentRun.mockResolvedValue({
      runId: RUN,
      status: "cancelled",
      linkedWorkSessionIds: [],
      workSessionsTerminated: false,
    } satisfies AgentRunCancelResult);
    mount([run(Date.now())]);
    await settle();
    const section = () => q("agent-work-panel-stop");
    expect(section()?.className).not.toContain("basis-full");
    act(() => q("agent-work-panel-stop-arm")?.click());
    expect(section()?.className).toContain("basis-full");
    await act(async () => {
      q("agent-work-panel-stop-commit")?.click();
      await vi.advanceTimersByTimeAsync(5);
    });
    // 결과 문장이 서도 자기 줄이다.
    expect(q("agent-work-panel-stop-outcome")).not.toBeNull();
    expect(section()?.className).toContain("basis-full");
  });

  it("에이전트 설정 열기는 다이얼로그 열기 함수를 에이전트 id로 부른다. 그 함수가 없으면 단추도 없다", async () => {
    const open = vi.fn();
    mount([run(Date.now())], { openProfile: open });
    await settle();
    act(() => q("run-exception-settings")?.click());
    expect(open).toHaveBeenCalledWith(AGENT);
    act(() => root?.unmount());
    host?.remove();

    mount([run(Date.now())], { openProfile: null });
    await settle();
    expect(lines()).toHaveLength(1);
    expect(q("run-exception-settings")).toBeNull();
  });
});

describe("행동 단추는 요청자와 owner/admin에게만 선다 (design-review r1 M2)", () => {
  const actionIds = ["agent-work-panel-stop-arm", "run-exception-settings", "wake-stub"] as const;
  const actionsShown = () => actionIds.filter((id) => q(id) !== null);

  it("요청자 본인: 문장과 행동 셋(다시 깨우기는 생존 판정이 있을 때)이 선다", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined });
    await settle();
    expect(q("run-exception-text")).not.toBeNull();
    expect(actionsShown()).toEqual([...actionIds]);
  });

  it("구경꾼(요청자도 owner/admin도 아님): 문장만 서고 행동 단추는 없다 — 문장은 작업 패널로 가는 입구로 남는다", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined, viewer: BYSTANDER });
    await settle();
    expect(q("run-exception-text")?.textContent).toBe(`달무리봇: ${UNCOLLECTED_WORD} · 연결이 꺼져 있을 수 있어요`);
    expect(actionsShown()).toEqual([]);
    act(() => q("run-exception-open")?.click());
    expect(workPanelSnapshot()).toMatchObject({ runId: RUN, origin: "message" });
  });

  it("workspace owner/admin은 남의 요청에도 행동 셋이 선다", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined, viewer: ADMIN });
    await settle();
    expect(actionsShown()).toEqual([...actionIds]);
  });

  it("작성자를 모르면 owner/admin에게만 선다", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined, requester: null, viewer: REQUESTER });
    await settle();
    expect(actionsShown()).toEqual([]);
    act(() => root?.unmount());
    host?.remove();
    mount([run(Date.now())], { openProfile: () => undefined, requester: null, viewer: ADMIN });
    await settle();
    expect(actionsShown()).toEqual([...actionIds]);
  });

  it("끝난 줄(실패)은 누구에게나 문장뿐이다(행동이 원래 없다)", async () => {
    const now = Date.now();
    mount([run(now, { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: now - SEC })], {
      viewer: BYSTANDER,
    });
    await settle();
    expect(q("run-exception-text")?.textContent).toBe("달무리봇: 실패 · 에이전트가 오류로 끝냈어요");
    expect(actionsShown()).toEqual([]);
  });
});

describe("행동 단추의 누르는 면 (design-review r1 M3)", () => {
  it("「에이전트 설정 열기」는 폰 폭 44(tap-target)다: 같은 줄의 「취소」·「다시 깨우기」와 같은 표적 크기", async () => {
    mount([run(Date.now())], { openProfile: () => undefined });
    await settle();
    const settings = q("run-exception-settings");
    expect(settings).not.toBeNull();
    expect(settings?.classList.contains("tap-target")).toBe(true);
  });
});

describe("줄의 모양 (design-review r1 M7)", () => {
  it("실패 줄은 칩과 같은 가위표, 나머지 예외는 느낌표다 — 색으로만 갈리지 않는다", async () => {
    const now = Date.now();
    mount([run(now, { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: now - SEC })]);
    await settle();
    expect(q("run-exception")?.querySelector("svg")?.getAttribute("class")).toContain("lucide-circle-x");
    act(() => root?.unmount());
    host?.remove();
    mount([run(now)]);
    await settle();
    expect(q("run-exception")?.querySelector("svg")?.getAttribute("class")).toContain("lucide-circle-alert");
    act(() => root?.unmount());
    host?.remove();
    mount([run(now, { phase: "timed_out", status: "timed_out", endReason: "lease_abandoned", finishedAtMs: now - SEC })]);
    await settle();
    expect(q("run-exception")?.querySelector("svg")?.getAttribute("class")).toContain("lucide-circle-alert");
  });

  it("행동 단추의 순서는 다시 깨우기 → 설정 → 취소다(위험한 행동은 마지막)", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined });
    await settle();
    const line = q("run-exception")!;
    const order = [...line.querySelectorAll<HTMLElement>('[data-testid="run-exception-open"], [data-testid="wake-stub"], [data-testid="run-exception-settings"], [data-testid="agent-work-panel-stop-arm"]')].map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["run-exception-open", "wake-stub", "run-exception-settings", "agent-work-panel-stop-arm"]);
  });

  it("취소를 열면 설정 단추가 확인 줄 아래 혼자 남지 않는다(취소가 맨 뒤라 확인 줄이 자기 줄로 내려가도 앞의 단추는 그대로 윗줄이다)", async () => {
    api.fetchAgentLiveness.mockResolvedValue(liveness("woken_not_collected"));
    mount([run(Date.now())], { openProfile: () => undefined });
    await settle();
    act(() => q("agent-work-panel-stop-arm")?.click());
    const children = [...q("run-exception")!.children].map((el) => el.getAttribute("data-testid"));
    expect(children.at(-1)).toBe("agent-work-panel-stop");
    expect(children.indexOf("run-exception-settings")).toBeLessThan(children.indexOf("agent-work-panel-stop"));
  });
});

describe("취소 영수증은 줄이 사라져도 남는다 (design-review r1 M9)", () => {
  const cancelledRow = (now: number) =>
    run(now, { phase: "cancelled", status: "cancelled", endReason: "human_cancelled", finishedAtMs: now });

  async function cancelFromLine() {
    api.cancelAgentRun.mockResolvedValue({
      runId: RUN,
      status: "cancelled",
      linkedWorkSessionIds: [],
      workSessionsTerminated: false,
    } satisfies AgentRunCancelResult);
    const now = Date.now();
    mount([run(now)], { openProfile: () => undefined });
    await settle();
    act(() => q("agent-work-panel-stop-arm")?.click());
    await act(async () => {
      q("agent-work-panel-stop-commit")?.click();
      await vi.advanceTimersByTimeAsync(5);
    });
    return now;
  }

  it("확정 → run이 취소로 넘어가 예외가 걷혀도 결과 문장이 같은 자리에 남고 줄의 글·행동은 사라진다", async () => {
    const now = await cancelFromLine();
    expect(q("agent-work-panel-stop-outcome")?.textContent).toBe("달무리봇의 요청을 취소했어요.");
    expect(q("run-exception")?.hasAttribute("data-receipt")).toBe(false);
    const outcome = q("agent-work-panel-stop-outcome");

    // 서버가 run을 취소로 돌려준다(진행 읽기).
    redraw([cancelledRow(now)]);
    await settle();
    const line = q("run-exception");
    expect(line, "줄이 영수증으로 남는다").not.toBeNull();
    expect(line?.hasAttribute("data-receipt")).toBe(true);
    // 같은 결과 문장 노드가 그대로다(다시 마운트되지 않았다: 캐럿·낭독이 사라지지 않는다).
    expect(q("agent-work-panel-stop-outcome")).toBe(outcome);
    expect(q("agent-work-panel-stop-outcome")?.textContent).toBe("달무리봇의 요청을 취소했어요.");
    // 줄의 글(작업 패널 입구)·행동 단추는 걷힌다: 이미 끝난 요청이라 권할 것이 없다.
    expect(q("run-exception-open")).toBeNull();
    expect(q("run-exception-settings")).toBeNull();
    expect(q("agent-work-panel-stop-arm")).toBeNull();
    expect(q("agent-work-panel-stop-commit")).toBeNull();
  });

  it("취소하지 않고 run이 취소로 넘어간 경우(다른 곳에서 취소)는 아무것도 남기지 않는다", async () => {
    const now = Date.now();
    mount([run(now)], { openProfile: () => undefined });
    await settle();
    expect(q("run-exception")).not.toBeNull();
    redraw([cancelledRow(now)]);
    await settle();
    expect(q("run-exception")).toBeNull();
    expect(host?.childElementCount ?? 0).toBe(0);
  });

  it("처음부터 취소된 run(이력)은 줄도 영수증도 없다", async () => {
    mount([cancelledRow(Date.now())]);
    await settle();
    expect(q("run-exception")).toBeNull();
    expect(host?.childElementCount ?? 0).toBe(0);
  });

  it("영수증은 서버의 취소 답이 오기 전에 걷히지 않는다: 오류 문장이 서면 다시 누를 수 있게 줄이 그대로다", async () => {
    api.cancelAgentRun.mockRejectedValue(new ApiError(500, "boom"));
    const now = Date.now();
    mount([run(now)], { openProfile: () => undefined });
    await settle();
    act(() => q("agent-work-panel-stop-arm")?.click());
    await act(async () => {
      q("agent-work-panel-stop-commit")?.click();
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(q("agent-work-panel-stop-outcome")?.getAttribute("data-kind")).toBe("error");
    expect(q("run-exception")?.hasAttribute("data-receipt")).toBe(false);
    expect(q("run-exception-open")).not.toBeNull();
    expect(q("agent-work-panel-stop-commit")).not.toBeNull();
  });
});

describe("방금 보낸 메시지의 진행 당겨 읽기", () => {
  it("방금 보냈는데 run이 아직 없으면 그 채널을 한 번 당겨 읽는다", async () => {
    mount([], { createdAtMs: Date.now() - 2 * SEC });
    await settle();
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith(CH);
  });

  it("오래된 메시지나 run이 이미 있는 메시지는 당기지 않는다", async () => {
    mount([], { createdAtMs: Date.now() - 5 * MIN });
    await settle();
    act(() => root?.unmount());
    host?.remove();
    mount([run(Date.now(), { phase: "succeeded", status: "succeeded" })], {
      createdAtMs: Date.now() - 2 * SEC,
    });
    await settle();
    expect(nudge).not.toHaveBeenCalled();
  });
});
