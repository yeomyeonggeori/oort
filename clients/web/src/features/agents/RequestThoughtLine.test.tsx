// @vitest-environment jsdom
import { act } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { AgentRunProgress } from "@momo/core/lib/api";
import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { RequestThoughtLine } from "./RequestThoughtLine";

const ledger = vi.hoisted(() => ({ rows: [{ key: "stage", kind: "stage", atMs: 1, text: "소개를 읽었어요", tone: "agent" }], counts: { tools: 2, approvals: 1 }, isLoading: false, isError: false }));
vi.mock("./useRunLedger", () => ({ useRunLedger: () => ledger }));
vi.mock("./RespondingIndicator", async original => ({
  ...await original<typeof import("./RespondingIndicator")>(), RespondingAvatar: () => <span aria-hidden="true" />,
}));
const directory = makeDirectory([{ id: "agent", kind: "agent", displayName: "달무리봇", channelIds: [] }] as never);
const subscribeAgent = vi.fn();
let onEvent: ((event: AgentProgressEvent) => void) | undefined;
const stop = vi.fn();
function run(phase: AgentRunProgress["phase"] = "running"): AgentRunProgress {
  return {
    id: "run", channelId: "channel", agentMemberId: "agent", triggerMessageId: "request", phase,
    status: phase === "claimed" ? "queued" : phase, leaseState: "live", ahead: [], stepCount: 1,
    latestStage: "프로필 소개를 읽는 중", createdAtMs: 100_000, startedAtMs: 100_000, updatedAtMs: Date.now(),
    lastEventAtMs: Date.now(), ...(phase === "succeeded" ? { finishedAtMs: 220_000 } : {}),
  };
}
function tree(progress = run(), connStatus = "connected") {
  const value = { workspaceId: "workspace", session: { member: { id: "human", kind: "human" } }, realtime: { subscribeAgent }, connStatus } as unknown as SessionContextValue;
  return <SessionProvider value={value}><RequestThoughtLine run={progress} directory={directory} /></SessionProvider>;
}
function delta(text: string, id = "run"): AgentProgressEvent {
  return { type: "agent.partial", v: 1, ts: Date.now(), payload: { run_id: id, channel_id: "channel", text_delta: text } };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  subscribeAgent.mockImplementation((_ws, _ch, _agent, handlers) => { onEvent = handlers.onEvent; return stop; });
  ledger.isLoading = false; ledger.isError = false;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); onEvent = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("요청의 생각 줄", () => {
  it("일하는 동안 한 줄·공유 점 셋을 보이고, 국면만 낭독하며 끝나면 분 단위 원장 요약을 남긴다", () => {
    const view = render(tree());
    expect(screen.getAllByTestId("request-thought-line")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("달무리봇 생각 중");
    expect(screen.getByTestId("responding-dots").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("responding-dots").getAttribute("data-motion")).toBe("still");
    view.rerender(tree(run("succeeded")));
    expect(screen.getByTestId("request-thought-line").textContent).toContain("2분 작업 · 도구 2 · 승인 1");
    expect(screen.queryByTestId("responding-dots")).toBeNull();
    expect(screen.getByTestId("request-thought-line").textContent).not.toMatch(/\d+초/);
  });

  it("펼친 뒤의 델타만 읽고 재접속·종결·다시 열기·재마운트 뒤에는 없으며 단계 메모는 남는다", () => {
    const view = render(tree());
    expect(subscribeAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("request-thought-line"));
    expect(screen.getByText("소개를 읽었어요")).toBeTruthy();
    act(() => { onEvent?.(delta("다른 요청", "other")); onEvent?.(delta("지금 들어온 생각")); });
    expect(screen.getByTestId("request-thought-stream").textContent).toBe("지금 들어온 생각");
    const stale = onEvent;
    view.rerender(tree(run(), "disconnected"));
    expect(stop).toHaveBeenCalled();
    act(() => stale?.(delta("늦게 온 조각")));
    view.rerender(tree());
    expect(screen.queryByTestId("request-thought-stream")).toBeNull();
    act(() => onEvent?.(delta("연결 뒤 생각")));
    expect(screen.getByTestId("request-thought-stream").textContent).toBe("연결 뒤 생각");
    view.rerender(tree(run("succeeded")));
    expect(screen.queryByTestId("request-thought-stream")).toBeNull();
    view.unmount();
    render(tree());
    fireEvent.click(screen.getByTestId("request-thought-line"));
    expect(screen.queryByTestId("request-thought-stream")).toBeNull();
    expect(screen.getByText("소개를 읽었어요")).toBeTruthy();
  });

  it("기록 로딩·오류·연결 끊김을 과정 안에서 말한다", () => {
    ledger.isLoading = true;
    const view = render(tree());
    fireEvent.click(screen.getByTestId("request-thought-line"));
    expect(screen.getByText("과정을 불러오는 중이에요")).toBeTruthy();
    ledger.isLoading = false; ledger.isError = true;
    view.rerender(tree());
    expect(screen.getByText("과정을 불러오지 못했어요. 다시 열어 주세요.")).toBeTruthy();
    view.rerender(tree(run(), "disconnected"));
    expect(screen.getByText("연결이 끊겼어요. 다시 연결되면 진행을 확인해요.")).toBeTruthy();
  });
  it("REST 진행이 낡아도 종결 프레임을 받으면 흐르는 글을 즉시 지우고 늦은 조각을 버린다", () => {
    render(tree());
    fireEvent.click(screen.getByTestId("request-thought-line"));
    act(() => onEvent?.(delta("일하는 동안의 조각")));
    expect(screen.getByTestId("request-thought-stream")).toBeTruthy();
    const handler = onEvent;
    act(() => handler?.({ type: "agent.status", v: 1, ts: Date.now(), payload: { run_id: "run", channel_id: "channel", agent_member_id: "agent", phase: "done", run_status: "succeeded" } }));
    expect(screen.queryByTestId("request-thought-stream")).toBeNull();
    expect(screen.queryByTestId("responding-dots")).toBeNull();
    act(() => handler?.(delta("종결 뒤 조각")));
    expect(screen.queryByTestId("request-thought-stream")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("달무리봇 끝");
  });
});
