// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, saveSubscriptionFee,
  type AgentUsageResponse,
} from "@momo/core/features/settings/agentUsage";
import { ApiError } from "@momo/core/lib/api";
import type { components } from "@/lib/usage.generated";
import { AgentMonthlyReport, AgentUsageLine } from "./AgentUsage";

vi.mock("@momo/core/features/settings/agentUsage", async importOriginal => ({
  ...await importOriginal<typeof import("@momo/core/features/settings/agentUsage")>(),
  fetchAgentUsage: vi.fn(), saveSubscriptionFee: vi.fn(),
}));
// 명단 읽기의 상태. 기본은 성공(옛 시험이 보던 모양)이고, 시험이 실패를 만든다.
const roster = vi.hoisted(() => ({isError: false, data: [{}] as unknown[] | undefined, refetch: vi.fn()}));
vi.mock("@/app/session", () => ({useSession: () => ({workspaceId: "w"})}));
vi.mock("@/features/workspace/useWorkspace", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/workspace/useWorkspace")>(),
  useDirectory: () => ({...roster, directory: makeDirectory([
    {id: "a", displayName: "기록 도우미", handle: "scribe", kind: "agent", callableBy: "everyone"} as never,
    {id: "b", displayName: "개인 도우미", handle: "personal", kind: "agent", callableBy: "owner_only"} as never,
  ])}),
}));

type Generated = components["schemas"]["AgentUsageResponse"];
// Both directions pin the core projection to the unchanged #4816 generated contract.
const sameContract: AgentUsageResponse extends Generated ? Generated extends AgentUsageResponse ? true : never : never = true;
const metrics: components["schemas"]["AgentUsageMetrics"] = {
  runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 50,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 0, source: "measured",
};
function data(admin = false): Generated {
  return {range: {from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day"},
    agents: [{...metrics, agentMemberId: "a"}, {...metrics, agentMemberId: "b"}],
    totals: {mine: metrics, shared: metrics, ...(admin ? {workspace: metrics} : {})}, hiddenPersonalAgents: admin ? 0 : 3};
}
let client: QueryClient;
function mount(line: boolean | "compact" = false) {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(<QueryClientProvider client={client}>{line ? <AgentUsageLine agentId="A" compact={line === "compact"} /> : <AgentMonthlyReport workspaceId="w" />}</QueryClientProvider>);
}
afterEach(() => {
  cleanup(); client?.clear(); onlineManager.setOnline(true); vi.resetAllMocks();
  roster.isError = false; roster.data = [{}]; roster.refetch = vi.fn();
});

describe("agent month usage", () => {
  it("has loading, error/retry, empty and offline states", async () => {
    vi.mocked(fetchAgentUsage).mockReturnValueOnce(new Promise(() => {}));
    const mounted = mount();
    expect(screen.getByText(COPY.loading)).toBeTruthy();
    mounted.unmount(); client.clear();
    vi.mocked(fetchAgentUsage).mockRejectedValueOnce(new Error("unavailable"));
    mount();
    await screen.findByText(COPY.error);
    vi.mocked(fetchAgentUsage).mockResolvedValue({...data(), agents: []});
    fireEvent.click(screen.getByRole("button", {name: "다시 불러오기"}));
    await screen.findByText(COPY.empty);
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByRole("button", {name: "다시 불러오기"}));
    await screen.findByText(COPY.offline);
  });
  it("honors the generated model A: hidden count only, no workspace total or fee controls for members", async () => {
    expect(sameContract).toBe(true);
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    await screen.findByText("숨겨진 개인 에이전트 3개");
    expect(screen.queryByText(/워크스페이스 전체/)).toBeNull();
    expect(screen.queryByLabelText(COPY.subscription)).toBeNull();
    expect(screen.getAllByText(/정확/).length).toBeGreaterThan(0);
    expect(screen.getByText("기록 도우미 (@scribe)")).toBeTruthy();
  });
  it("lets admins save/clear shared fees and keeps a refused draft for retry", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    const input = await screen.findByLabelText(COPY.subscription);
    expect(screen.getAllByLabelText(COPY.subscription)).toHaveLength(1);
    fireEvent.change(input, {target: {value: "20.000001"}});
    vi.mocked(saveSubscriptionFee).mockRejectedValueOnce(new Error("403"));
    fireEvent.click(screen.getByRole("button", {name: "저장"}));
    await screen.findByText(COPY.saveError);
    expect((input as HTMLInputElement).value).toBe("20.000001");
    vi.mocked(saveSubscriptionFee).mockResolvedValue({agentMemberId: "a", subscriptionFee: null});
    fireEvent.change(input, {target: {value: ""}});
    fireEvent.click(screen.getByRole("button", {name: "저장"}));
    await waitFor(() => expect(saveSubscriptionFee).toHaveBeenLastCalledWith("w", "a", null));
    await screen.findByText(COPY.saved);
  });
  it("carries no edge inset of its own: hub cells and rows give it theirs, so a second one would double it (#4912 R12)", async () => {
    // 프로필 대화의 틀(`AgentProfileDialog.usage.test.tsx`)만 `className` 으로 여백을 준다. 부품 기본에 `px-4` 를 넣으면
    // 허브 표 칸(`AiAgentsPane`)·허브 상세(`AgentHubRoute`)의 줄이 안으로 한 번 더 들어간다.
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount(true);
    const line = await screen.findByTestId("agent-month-usage");
    expect([...line.classList].filter(token => /^-?(?:p|px|pl|ps|m|mx|ml|ms)-/.test(token))).toEqual([]);
  });
  it("joins profiles case-insensitively and labels mixed/self-reported costs honestly", async () => {
    const response = data();
    response.agents[0] = {...response.agents[0]!, source: "self_reported", estimatedRuns: 1, subscriptionFee: {monthlyMicroUsd: 20000000, label: null}};
    vi.mocked(fetchAgentUsage).mockResolvedValue(response); mount(true);
    const line = await screen.findByTestId("agent-month-usage");
    await waitFor(() => expect(line.textContent).toContain("자기 보고 · 추정"));
    expect(line.textContent).toContain("구독 US$20.00/월");
    expect(line.textContent).not.toContain("정확");
  });
});

describe("월 보고와 목록 줄의 정리 (#4986)", () => {
  const reloadButtons = () => screen.queryAllByRole("button", {name: /^(다시 불러오기|불러오는 중)$/});

  it("목록·표 안의 줄(compact)은 긴 머리말을 되풀이하지 않고 낱말을 한 덩어리로 줄바꿈한다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount("compact");
    const line = await screen.findByTestId("agent-month-usage");
    await waitFor(() => expect(line.textContent).toContain("비용"));
    expect(line.textContent!.startsWith(COPY.period + " · 비용")).toBe(true);
    expect(line.textContent).not.toContain(COPY.title);
    // 한국어는 낱말 가운데에서 끊지 않는다: keep-all. 무조건 끊는 `break-all`·`break-words`가 아니다.
    expect(line.classList.contains("break-keep")).toBe(true);
    expect(line.classList.contains("break-words")).toBe(false);
    expect(line.classList.contains("break-all")).toBe(false);
  });

  it("목록 줄은 읽는 중·오류·오프라인을 줄마다 되풀이하지 않는다: 목록 위의 한 줄이 한 번 말한다", async () => {
    vi.mocked(fetchAgentUsage).mockReturnValueOnce(new Promise(() => {}));
    const loading = mount("compact");
    expect(screen.queryByTestId("agent-month-usage")).toBeNull(); // 읽는 중
    loading.unmount(); client.clear();
    vi.mocked(fetchAgentUsage).mockRejectedValueOnce(new Error("unavailable"));
    mount("compact");
    await waitFor(() => expect(client.getQueryState(["agent-usage", "w", new Date().toISOString().slice(0, 7)])?.status).toBe("error"));
    expect(screen.queryByTestId("agent-month-usage")).toBeNull(); // 오류: 열한 줄에 열한 번 서지 않는다
    expect(document.body.textContent).not.toContain(COPY.error);
  });

  it("한 줄짜리 자리(단독)는 긴 머리말과 오류 문장을 그대로 말한다", async () => {
    vi.mocked(fetchAgentUsage).mockRejectedValueOnce(new Error("unavailable"));
    mount(true);
    const line = await screen.findByTestId("agent-month-usage");
    await waitFor(() => expect(line.textContent).toContain(COPY.error));
    expect(line.textContent!.startsWith(COPY.title + ": ")).toBe(true);
    expect(line.classList.contains("break-keep")).toBe(true);
  });

  it("월 보고의 다시 불러오기는 섹션 머리의 단추 하나이고, 어느 상태에서도 둘이 되지 않는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    await screen.findByLabelText(COPY.subscription);
    expect(reloadButtons()).toHaveLength(1);
    const button = reloadButtons()[0]!;
    expect(button.getAttribute("data-testid")).toBe("agent-usage-reload");
    // 카드 안(본문)이 아니라 카드 위 머리 줄에 선다: 카드 폭 알약이 가장 무거운 요소가 되던 자리를 비운다.
    expect(button.closest(".settings-card")).toBeNull();
    expect(button.closest('[data-testid="agent-monthly-report"]')).toBeTruthy();
    cleanup(); client.clear();
    vi.mocked(fetchAgentUsage).mockRejectedValue(new Error("unavailable"));
    mount();
    await screen.findByText(COPY.error);
    expect(reloadButtons()).toHaveLength(1);
    cleanup(); client.clear();
    act(() => onlineManager.setOnline(false));
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    await screen.findByText(COPY.offline);
    expect(reloadButtons()).toHaveLength(1);
  });

  it("불러오는 동안 단추는 잠기지 않고 aria-busy와 바뀐 낱말로 말한다: 초점이 body로 떨어지지 않고 두 번 누르면 한 번만 읽는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValueOnce({...data(), agents: []}); mount();
    await screen.findByText(COPY.empty);
    let finish!: (value: Generated) => void;
    vi.mocked(fetchAgentUsage).mockImplementationOnce(() => new Promise<Generated>(resolve => { finish = resolve; }));
    const button = screen.getByRole("button", {name: "다시 불러오기"});
    button.focus();
    fireEvent.click(button);
    const busy = await screen.findByRole("button", {name: "불러오는 중"});
    expect(busy).toBe(button);
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(fetchAgentUsage).toHaveBeenCalledTimes(2); // 처음 읽기 + 다시 읽기 하나
    await act(async () => { finish({...data(), agents: []}); });
    await screen.findByRole("button", {name: "다시 불러오기"});
    expect(document.activeElement).toBe(button);
  });

  it("연결이 없을 때만 단추가 aria-disabled이고 눌러도 아무것도 시작하지 않는다(네이티브 disabled가 아니다)", async () => {
    roster.isError = true; roster.data = undefined; // 가드는 이 누름이 명단 읽기까지 시작하는지로 잰다(보고 읽기는 react-query가 멈춰 둔다)
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    await screen.findByText("숨겨진 개인 에이전트 3개");
    // 연결이 끊긴 뒤 처음 누른 읽기는 시작되자마자 멈춘다(react-query `paused`): 그때부터 단추가 잠긴다.
    act(() => onlineManager.setOnline(false));
    const button = screen.getByRole("button", {name: "다시 불러오기"});
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    await screen.findByText(COPY.offline);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.classList.contains("opacity-50")).toBe(true);
    vi.mocked(roster.refetch).mockClear();
    const before = vi.mocked(fetchAgentUsage).mock.calls.length;
    fireEvent.click(button);
    expect(vi.mocked(fetchAgentUsage).mock.calls.length).toBe(before);
    expect(roster.refetch).not.toHaveBeenCalled();
  });

  it("명단을 못 읽으면 줄 이름이 비는 이유를 한 번 말하고, 다시 불러오기가 명단도 다시 읽는다", async () => {
    roster.isError = true; roster.data = undefined;
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    const note = await screen.findByTestId("agent-usage-roster-error");
    expect(note.textContent).toBe(COPY.rosterError);
    expect(screen.getAllByTestId("agent-usage-roster-error")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", {name: "다시 불러오기"}));
    expect(roster.refetch).toHaveBeenCalledTimes(1);
  });

  it("명단이 있거나(옛 명단 포함) 보고를 못 읽었으면 명단 문장은 서지 않는다", async () => {
    roster.isError = true; roster.data = [{}]; // 옛 명단이 남아 있으면 이름은 아직 아는 것이다
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    await screen.findByText("숨겨진 개인 에이전트 3개");
    expect(screen.queryByTestId("agent-usage-roster-error")).toBeNull();
    cleanup(); client.clear();
    roster.isError = true; roster.data = undefined;
    vi.mocked(fetchAgentUsage).mockRejectedValue(new Error("unavailable")); mount();
    await screen.findByText(COPY.error);
    expect(screen.queryByTestId("agent-usage-roster-error")).toBeNull(); // 보고가 없으니 이름이 비는 줄도 없다
  });

  it("구독 정액을 저장하는 동안 초점은 입력 칸에서도 단추에서도 body로 떨어지지 않는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    const input = await screen.findByLabelText(COPY.subscription) as HTMLInputElement;
    fireEvent.change(input, {target: {value: "20"}});
    let finish!: (value: Awaited<ReturnType<typeof saveSubscriptionFee>>) => void;
    vi.mocked(saveSubscriptionFee).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    // 값 칸에서 Enter로 저장: 초점은 입력 칸에 있다.
    input.focus();
    fireEvent.submit(input.closest("form")!);
    const busy = await screen.findByRole("button", {name: "저장하고 있어요"});
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    // 같은 저장이 겹쳐 나가지 않는다.
    fireEvent.submit(input.closest("form")!);
    expect(saveSubscriptionFee).toHaveBeenCalledTimes(1);
    await act(async () => { finish({agentMemberId: "a", subscriptionFee: null}); });
    await screen.findByText(COPY.saved);
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("단추를 눌러 저장하는 동안에도 초점은 그 단추에 남는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    const input = await screen.findByLabelText(COPY.subscription);
    fireEvent.change(input, {target: {value: "20"}});
    let finish!: (value: Awaited<ReturnType<typeof saveSubscriptionFee>>) => void;
    vi.mocked(saveSubscriptionFee).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const save = screen.getByRole("button", {name: "저장"});
    save.focus();
    fireEvent.click(save);
    const busy = await screen.findByRole("button", {name: "저장하고 있어요"});
    expect(busy).toBe(save);
    expect(document.activeElement).toBe(busy);
    await act(async () => { finish({agentMemberId: "a", subscriptionFee: null}); });
    await screen.findByText(COPY.saved);
    expect(document.activeElement).toBe(save);
  });

  it("저장 실패는 원인별로 다른 문장을 말한다: 권한(403)에는 다시 시도를 권하지 않는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    const input = await screen.findByLabelText(COPY.subscription);
    fireEvent.change(input, {target: {value: "20"}});
    for (const [error, text] of [
      [new ApiError(403, "forbidden"), COPY.saveForbidden],
      [new ApiError(409, "conflict"), COPY.saveConflict],
      [new ApiError(500, "boom"), COPY.saveError],
    ] as const) {
      vi.mocked(saveSubscriptionFee).mockRejectedValueOnce(error);
      fireEvent.click(screen.getByRole("button", {name: "저장"}));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
    }
  });
});
