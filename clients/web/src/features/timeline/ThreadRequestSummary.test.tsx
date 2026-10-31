// @vitest-environment jsdom
import { act } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { ThreadRequestSummary } from "./ThreadRequestSummary";
import { resetSettledApprovalsForTest } from "./settledApprovals";

const session = { workspaceId: "workspace", session: { member: { id: "human", kind: "human" } } } as unknown as SessionContextValue;
let fits = true;
function run(bundle: Record<string, unknown> = {}): AgentRunProgress {
  return {
    id: "run", channelId: "channel", agentMemberId: "agent", phase: "awaiting_approval", status: "awaiting_approval",
    leaseState: "live", stepCount: 1, ahead: [], createdAtMs: 1, updatedAtMs: 1,
    bundle: { approval_id: "approval", status: "pending", decision_mode: "inline", can_decide: true, intent: "소개를 바꿔도 될까요?", ...bundle },
  } as AgentRunProgress;
}
function mount(runs = [run()], kind: string | undefined = "human") {
  const open = vi.fn();
  render(<SessionProvider value={{ ...session, session: { ...session.session, member: { ...session.session.member, kind: kind === "missing" ? undefined : kind } } } as SessionContextValue}><ThreadRequestSummary runs={runs} onOpen={open} /></SessionProvider>);
  return open;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fits = true;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => fits ? 300 : 900);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  resetSettledApprovalsForTest();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("스레드 요청 요약", () => {
  it("대기 하나·결정 권한·명시 inline·같은 줄 질문일 때만 버튼 쌍이 선다", () => {
    mount();
    expect(screen.getByTestId("thread-request-question").textContent).toBe("소개를 바꿔도 될까요?");
    expect(screen.getByRole("button", { name: "소개를 바꿔도 될까요? 승인" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "소개를 바꿔도 될까요? 거부" })).toBeTruthy();
  });
  it.each([
    ["open", { decision_mode: "open" }], ["서버 모드 없음", { decision_mode: undefined }],
    ["권한 없음", { can_decide: false }], ["질문 없음", { intent: undefined }],
    ["질문이 아닌 의도 구절", { intent: "소개를 바꾸려고 해요" }],
    ["질문이 잘림", {}], ["대기 여럿", {}],
  ])("%s에서는 열어서 결정만 서고 버튼이 숨은 채 남지도 않는다", (name, bundle) => {
    if (name === "질문이 잘림") fits = false;
    const open = mount(name === "대기 여럿" ? [run(), run({ approval_id: "other" })] : [run(bundle)]);
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "열어서 결정" }));
    expect(open).toHaveBeenCalledOnce();
  });
  it("확인 단계 없이 한 번 결정하고, 같은 카드의 낡은 대기 버튼이 다시 서지 않는다", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ approval_id: "approval", status: "approved" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    mount();
    await act(async () => { fireEvent.click(screen.getByTestId("thread-approval-approve")); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
    expect(screen.getByTestId("thread-request-summary")).toBeTruthy();
  });
  it.each(["agent", "missing"])("사람임을 확인할 수 없는 %s 세션에는 결정 버튼이 없다", (kind) => {
    mount([run()], kind);
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
  });
  it("종결 run의 지난 기한이 있어도 새 대기 제안의 기한을 지켜 버튼을 내린다", () => {
    vi.useFakeTimers();
    const old = { ...run({ status: "approved", action_type: "workspace_action" }), approvalExpiresAtMs: Date.now() - 1000 };
    const pending = { ...run(), approvalExpiresAtMs: Date.now() + 1000 };
    mount([old, pending]);
    expect(screen.getByTestId("thread-request-actions")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
  });
  it("대기 둘이 차례로 만료되면 다음 기한도 예약한다", () => {
    vi.useFakeTimers();
    mount([{ ...run(), approvalExpiresAtMs: Date.now() + 1000 }, { ...run({ approval_id: "other" }), approvalExpiresAtMs: Date.now() + 2000 }]);
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.getByTestId("thread-request-actions")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("thread-request-actions")).toBeNull();
  });
});
