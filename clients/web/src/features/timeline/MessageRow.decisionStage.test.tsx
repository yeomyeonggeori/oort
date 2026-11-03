// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRunProgress, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AppShell } from "@/app/AppShell";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { DecisionStageHost } from "@/features/decisionStage/DecisionStage";
import { closeDecisionStage, decisionStageSnapshot } from "@/features/decisionStage/openDecisionStage";
import { resetSettledApprovalsForTest } from "./settledApprovals";
import { MessageRow } from "./MessageRow";

const api = vi.hoisted(() => ({ fetchMessages: vi.fn(), fetchAgentLiveness: vi.fn(), fetchAgentRunEvents: vi.fn(), authedResponse: vi.fn() }));
vi.mock("@momo/core/lib/api", async (original) => ({ ...await original<typeof import("@momo/core/lib/api")>(),
  fetchMessages: api.fetchMessages, fetchAgentLiveness: api.fetchAgentLiveness, fetchAgentRunEvents: api.fetchAgentRunEvents, authedResponse: api.authedResponse }));
// 셸의 실제 Host 배선을 검증하고, 주변 다이얼로그·네트워크 수명만 격리해요.
vi.mock("@/features/channels/CreateChannelDialog", () => ({ CreateChannelProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/workspace/AddWorkspaceDialog", () => ({ AddWorkspaceProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/channels/AddChannelMemberDialog", () => ({ AddChannelMemberProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/directory/NewDmDialog", () => ({ NewDmProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/routing/AgentProfileDialog", () => ({ AgentProfileProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/directory/MemberProfileDialog", () => ({ MemberProfileProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/app/QuickSwitcher", () => ({ QuickSwitcher: () => null }));
vi.mock("@/app/AppTitlebar", () => ({ AppTitlebar: () => null }));
vi.mock("@/features/sidebar/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/features/inbox/InboxHotkeys", () => ({ InboxHotkeys: () => null }));
vi.mock("@/features/agents/AgentTurnFixture", () => ({ AgentTurnFixture: () => null }));
vi.mock("@/design/wallpaper/WallpaperLayer", () => ({ WallpaperLayer: () => null }));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "stage-workspace";
const CH = "stage-channel";
const ME = "stage-human";
const AGENT = "stage-agent";
const RUN = "stage-run";
const ROOT = "stage-root";
const APPROVAL = "stage-approval";
const directory = makeDirectory([
  { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", role: "admin" },
  { id: AGENT, workspaceId: WS, kind: "agent", displayName: "달무리봇", role: "member" },
] as RosterMember[]);
const session: SessionContextValue = {
  workspaceId: WS, connStatus: "connected", realtime: null, logout: () => undefined, replaceSessionMember: () => undefined,
  session: { accessToken: "fixture", refreshToken: "fixture", realtimeWebSocketUrl: "wss://example.test",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" } },
};
function message(patch: Partial<Message> = {}): Message {
  return { id: ROOT, channelId: CH, authorMemberId: ME, seq: 1, hlcTs: 1, hlcCount: 0,
    type: "text", body: "안내를 고정해 줘", state: "sent", createdAtMs: Date.now(), ...patch };
}
function approval(mode?: "inline" | "open", props = {}): Message {
  return message({ id: "stage-card", rootId: ROOT, authorMemberId: AGENT, type: "approval_request", props: {
    approval_id: APPROVAL, run_id: RUN, status: "pending", title: "안내를 고정해도 될까요?", action_type: "workspace_action",
    can_decide: true, ...(mode ? { decision_mode: mode } : {}),
    action: { id: "message.pin", rows: [{ label: "채널", value: "출시 준비" }], rationale: "새 팀원이 안내를 바로 찾을 수 있어요", required_role: "admin" }, ...props,
  } });
}
function run(): AgentRunProgress {
  return { id: RUN, channelId: CH, triggerMessageId: ROOT, agentMemberId: AGENT, status: "running", phase: "awaiting_approval",
    leaseState: "live", approvalId: APPROVAL, stepCount: 1, ahead: [], createdAtMs: Date.now(), updatedAtMs: Date.now(),
    bundle: { approvalId: APPROVAL, status: "pending", decisionMode: "open", canDecide: true, actionType: "workspace_action", intent: "안내를 고정해도 될까요?" },
  };
}
function mount({ shell = false, card = approval("open"), runs = [run()] }: { shell?: boolean; card?: Message; runs?: AgentRunProgress[] } = {}) {
  const fallback = vi.fn();
  const rows = <><MessageRow message={message()} directory={directory} startsGroup runStatus={runs} onOpenThread={fallback} />
    <MessageRow message={card} directory={directory} startsGroup /></>;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OpenMemberProfileContext.Provider value={() => undefined}>
    {shell ? <MemoryRouter><Routes><Route element={<AppShell session={session.session} onLogout={session.logout} replaceSessionMember={session.replaceSessionMember} />}>
      <Route path="*" element={rows} /></Route></Routes></MemoryRouter>
      : <SessionProvider value={session}>{rows}<DecisionStageHost /></SessionProvider>}
  </OpenMemberProfileContext.Provider></QueryClientProvider>);
  return fallback;
}
const stage = () => screen.queryByTestId("decision-stage");
const originalCard = () => document.querySelector<HTMLElement>('[data-message-id="stage-card"] [data-testid="agent-card"]')!;
async function click(node: HTMLElement) { await act(async () => { fireEvent.click(node); }); }
async function close() {
  fireEvent.keyDown(stage()!, { key: "Escape" });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/?stress=1&agentwork=live");
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media.includes("prefers-reduced-motion"), media, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.fetchMessages.mockReset().mockResolvedValue({ messages: [approval()] });
  api.fetchAgentLiveness.mockReset().mockRejectedValue(new Error("isolated"));
  api.fetchAgentRunEvents.mockReset().mockResolvedValue({ runId: RUN, events: [] });
  api.authedResponse.mockReset().mockResolvedValue({ status: 200, ok: true,
    json: () => ({ status: "approved", decidedBy: ME, decidedAtMs: Date.now() }) });
  resetSettledApprovalsForTest();
});
afterEach(() => {
  const snapshot = decisionStageSnapshot();
  if (snapshot) act(() => closeDecisionStage(snapshot.ticket));
  cleanup();
  vi.unstubAllGlobals();
});

describe("요청에서 결정 무대로 연결", () => {
  it("실제 AppShell의 단 하나 Host에서 open 카드가 열리고, 닫으면 누른 요소로 포커스가 돌아와요", async () => {
    mount({ shell: true });
    const opener = within(originalCard()).getByRole("button", { name: "열어서 결정" });
    await click(opener);
    expect(screen.getAllByTestId("decision-stage")).toHaveLength(1);
    expect(screen.getByTestId("decision-stage-card").textContent).toContain("안내를 고정해도 될까요?");
    const request = decisionStageSnapshot()!.request;
    expect(request.opener).toBe(opener);
    expect(request.source?.(APPROVAL)).toBe(originalCard());
    expect(request.context).toMatchObject({ viewerMemberId: ME, viewerKind: "human", canDecide: true, isWorkspaceAdmin: true });
    await close();
    expect(stage()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("decision_mode 없는 서버: 카드의 인라인 승인·거부는 남고 승인 필요 칩이 그 run의 대기 카드만 열어요", async () => {
    const fallback = mount({ card: approval() });
    expect(within(originalCard()).getByRole("button", { name: /승인$/ })).toBeTruthy();
    expect(within(originalCard()).getByRole("button", { name: /거부$/ })).toBeTruthy();
    expect(within(originalCard()).queryByRole("button", { name: "열어서 결정" })).toBeNull();
    api.fetchMessages.mockResolvedValue({ messages: [approval(undefined, { run_id: "other-run", approval_id: "other-approval" }), approval()] });
    const opener = screen.getByTestId("trigger-chip");
    await click(opener);
    expect(stage()).toBeTruthy();
    expect(decisionStageSnapshot()!.request.cards.map((entry) => entry.card.approvalId)).toEqual([APPROVAL]);
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, CH, { after: 1, limit: 200 });
    expect(decisionStageSnapshot()!.request.opener).toBe(opener);
    expect(fallback).not.toHaveBeenCalled();
    await close();
    expect(document.activeElement).toBe(opener);
  });

  it("요약 줄의 열어서 결정은 무대를 열고, 결정할 카드가 없으면 기존 스레드를 열어요", async () => {
    const fallback = mount();
    const opener = within(screen.getByTestId("thread-request-summary")).getByRole("button", { name: "열어서 결정" });
    await click(opener);
    expect(stage()).toBeTruthy();
    expect(decisionStageSnapshot()!.request.source?.("stage-card")).toBe(originalCard());
    await close();
    expect(document.activeElement).toBe(opener);
    api.fetchMessages.mockResolvedValueOnce({ messages: [approval("open", { can_decide: false })] });
    await click(opener);
    expect(stage()).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  // #4960. 서버가 run 진행 bundle로 「이 사람은 지금 못 한다」고 말하면(보는 사람 기준 `canDecide:false`) 카드 props가 아무
  // 말이 없어도(`can_decide` 없음) 무대에 올리지 않는다. 「한다」는 단추를 더 세우지 않는다.
  it.each([
    ["서버가 못 한다고 말하면 무대 대신 기존 스레드를 연다", false, "fallback"],
    ["서버가 한다고 말하면 무대가 열린다", true, "stage"],
  ] as const)("run bundle canDecide: %s", async (_name, serverCanDecide, expected) => {
    const bundle = { ...run().bundle!, canDecide: serverCanDecide };
    const card = approval("open", { can_decide: undefined });
    const fallback = mount({ card, runs: [{ ...run(), bundle }] });
    api.fetchMessages.mockResolvedValue({ messages: [card] });
    await click(within(screen.getByTestId("thread-request-summary")).getByRole("button", { name: "열어서 결정" }));
    if (expected === "stage") {
      expect(stage()).toBeTruthy();
      expect(fallback).not.toHaveBeenCalled();
    } else {
      expect(stage()).toBeNull();
      expect(screen.queryByTestId("decision-stage-approve")).toBeNull();
      expect(fallback).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["inline", "open"] as const)("%s: 무대 승인 한 번이 기존 결정 경로와 원래 카드의 같은 영수증으로 돌아와요", async (mode) => {
    mount({ card: approval(mode) });
    if (mode === "inline") {
      expect(within(originalCard()).getAllByRole("button").filter((node) => ["승인", "거부"].includes(node.textContent!))).toHaveLength(2);
      await click(screen.getByTestId("trigger-chip"));
    } else await click(within(originalCard()).getByRole("button", { name: "열어서 결정" }));
    await click(screen.getByTestId("decision-stage-approve"));
    expect(api.authedResponse).toHaveBeenCalledTimes(1);
    const [path, options] = api.authedResponse.mock.calls[0];
    expect(path).toBe(`/v1/workspaces/${WS}/approvals/${APPROVAL}/decision`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toMatchObject({ approval_id: APPROVAL, approve: true, client_decision_id: expect.any(String) });
    expect(originalCard().dataset.status).toBe("approved");
    expect(originalCard().textContent).toContain("승인을 기록했어요.");
    expect(within(originalCard()).queryByRole("button", { name: /승인$/ })).toBeNull();
  });

  it("조회 오류를 재시도하고, 다음 페이지의 결정 가능 카드만 열어요", async () => {
    mount();
    api.fetchMessages.mockRejectedValueOnce(new Error("network"));
    await click(screen.getByTestId("trigger-chip"));
    expect(screen.getByText("결정할 카드를 불러오지 못했어요. 다시 불러와 주세요.")).toBeTruthy();
    api.fetchMessages.mockResolvedValueOnce({ messages: Array.from({ length: 200 }, (_, i) => message({ id: `history-${i}`, seq: i + 2 })) })
      .mockResolvedValueOnce({ messages: [approval()] });
    await click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(screen.getByTestId("decision-stage-approve")).toBeTruthy();
    expect(api.fetchMessages).toHaveBeenLastCalledWith(WS, CH, { after: 201, limit: 200 });
  });

  it("DM 본류에 놓인 카드도 run 칩에서 열어요", async () => {
    const dmCard = { ...approval(), rootId: undefined };
    mount({ card: dmCard });
    api.fetchMessages.mockResolvedValueOnce({ messages: [dmCard] });
    await click(screen.getByTestId("trigger-chip"));
    expect(screen.getByTestId("decision-stage-approve")).toBeTruthy();
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, CH, { after: 1, limit: 200 });
  });

  it("조회 중 닫힌 무대의 늦은 응답은 무대를 다시 열거나 스레드로 이동하지 않아요", async () => {
    const fallback = mount();
    let finish!: (value: { messages: Message[] }) => void;
    api.fetchMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(screen.getByTestId("trigger-chip"));
    expect(stage()).toBeTruthy();
    await close();
    await act(async () => finish({ messages: [] }));
    expect(stage()).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });
});
