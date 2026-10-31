// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { fetchAgentUsage, type AgentUsageResponse } from "@momo/core/features/settings/agentUsage";
import { AgentProfileDialog } from "./AgentProfileDialog";

// =============================================================================
// #4912 2차(디자인 검수 R12): 프로필 대화의 「이번 달 비용·토큰·작업 수」 줄이 다른 전폭 띠와 같은 가장자리에서 시작한다.
//
// 대화 상자의 틀(`Frame`)은 자식이 제 가장자리를 스스로 지게 한다(머리 `p-4`, 배너 `px-4 py-2`, 폼·스켈레톤 `p-4`).
// 비용 줄만 여백이 없어서 상자 왼쪽 끝(464px)에 붙었다. 줄은 허브 표·허브 상세에서도 쓰는 부품이라 여백은 부품이 아니라
// 틀이 `className` 으로 준다(부품 단독 가드는 `settings/AgentUsage.test.tsx`).
//
// jsdom 에는 레이아웃이 없다. 그래서 첫 수리의 확인 창 여백(`expressions.test.tsx`)처럼 **클래스 토큰**으로 잰다:
// 줄에서 대화 상자까지 올라가며 가장자리를 미는 토큰(`p-*`·`px-*`·`pl-*`·`ps-*`·`m*-*`)을 모두 모은다. 정확히
// 한 겹이어야 하고(비면 가장자리에 붙고, 둘이면 이중 인셋이다) 그 값은 같은 상자의 다른 띠와 같아야 한다.
// =============================================================================

vi.mock("@momo/core/features/settings/agentUsage", async importOriginal => ({
  ...await importOriginal<typeof import("@momo/core/features/settings/agentUsage")>(),
  fetchAgentUsage: vi.fn(), saveSubscriptionFee: vi.fn(),
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w", connStatus: "connected" }) }));
vi.mock("@/features/workspace/useWorkspace", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/workspace/useWorkspace")>(),
  useDirectory: () => ({ directory: makeDirectory([
    { id: "a", displayName: "기록 도우미", handle: "scribe", kind: "agent", callableBy: "everyone" } as never,
  ]) }),
}));
const handle = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./useAgentProfile", async importOriginal => ({
  ...await importOriginal<typeof import("./useAgentProfile")>(),
  useAgentProfile: () => handle.current,
}));
vi.mock("./capability", async importOriginal => ({
  ...await importOriginal<typeof import("./capability")>(),
  useRoutingCapability: () => ({ support: "absent", table: null, reason: "서버가 표를 보내지 않았습니다.", recheck: () => {} }),
  useAllowedAgentModels: () => null,
  useAgentEditingCapability: () => ({ support: "ready", reason: null, recheck: () => {} }),
}));

const metrics = {
  runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 0,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 0, source: "measured" as const,
};
const usage = (withRow = true): AgentUsageResponse => ({
  range: { from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day" },
  agents: withRow ? [{ ...metrics, agentMemberId: "a" }] : [],
  totals: { mine: metrics, shared: metrics }, hiddenPersonalAgents: 0,
});
const base = {
  profile: null, missing: false, isPending: false, error: null, refetch: () => {},
  saving: false, failure: null, clearFailure: () => {}, replace: vi.fn(), save: vi.fn(),
};

let client: QueryClient;
function open() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentProfileDialog agentMemberId="a" onOpenChange={() => {}} />
    </QueryClientProvider>
  );
}
afterEach(() => { cleanup(); client?.clear(); vi.resetAllMocks(); });

const EDGE = /^-?(?:p|px|pl|ps|m|mx|ml|ms)-(?:\d+(?:\.\d+)?|px)$/;
/** 한 요소가 가장자리를 미는 토큰. 세로(`py`·`mt`…)는 가장자리가 아니다. */
const edgeTokens = (el: Element) => [...el.classList].filter(token => EDGE.test(token));
/** 토큰의 칸 수(`px-4` → "4"). `p-4` 와 `px-4` 는 같은 16px 이다. */
const step = (token: string | undefined) => token?.replace(/^-?[a-z]+-/, "");
/** 줄에서 대화 상자(포함)까지의 요소들. */
function upToDialog(line: HTMLElement): HTMLElement[] {
  const dialog = screen.getByTestId("agent-profile-dialog");
  const chain: HTMLElement[] = [];
  for (let el: HTMLElement | null = line; el; el = el.parentElement) {
    chain.push(el);
    if (el === dialog) break;
  }
  expect(chain.at(-1)).toBe(dialog);
  return chain;
}
/** 줄이 이웃 띠와 같은 칸 수의 한 겹으로 서 있다. 이웃은 `test id` 로 고른다. */
async function expectSameEdgeAs(neighbourTestId: string) {
  const line = await screen.findByTestId("agent-month-usage");
  const layers = upToDialog(line).flatMap(edgeTokens);
  expect(layers).toEqual(["px-4"]);
  const neighbour = edgeTokens(screen.getByTestId(neighbourTestId));
  expect(neighbour.length).toBeGreaterThan(0);
  expect(step(layers[0])).toBe(step(neighbour[0]));
  // 제목 블록(머리)과도 같은 칸이다: 제목·설명과 비용 줄의 첫 글자가 한 줄에 선다.
  const header = screen.getByText("기록 도우미 라우팅").parentElement!;
  expect(step(layers[0])).toBe(step(edgeTokens(header)[0]));
}

describe("프로필 대화의 비용 줄", () => {
  it("불러오는 중: 스켈레톤과 같은 가장자리, 한 겹", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(usage());
    handle.current = { ...base, isPending: true };
    open();
    await expectSameEdgeAs("agent-profile-skeleton");
  });
  it("프로필을 못 읽었을 때: 오류 배너와 같은 가장자리, 한 겹", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(usage());
    handle.current = { ...base, error: new Error("unavailable") };
    open();
    await expectSameEdgeAs("agent-profile-error");
  });
  it("본문(프로필 없음 고지가 서는 폼): 고지 띠와 같은 가장자리, 한 겹", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(usage());
    handle.current = { ...base, missing: true };
    open();
    await expectSameEdgeAs("agent-profile-empty");
  });
  it("줄은 제자리에 있다: 머리와 본문 사이, 틀의 첫 자식 다음", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(usage());
    handle.current = { ...base, missing: true };
    open();
    const line = await screen.findByTestId("agent-month-usage");
    const dialog = screen.getByTestId("agent-profile-dialog");
    const kids = [...dialog.children];
    expect(kids.indexOf(line)).toBe(1);
    expect(kids[0]?.textContent).toContain("기록 도우미 라우팅");
    expect(kids[2]?.getAttribute("data-testid")).toBe("agent-profile-empty");
  });
  it("사용량 행이 없는 에이전트: 줄이 없으면 빈 띠도 남지 않는다(틀이 여백을 래퍼로 주면 16px 빈 자리가 생긴다)", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(usage(false));
    handle.current = { ...base, missing: true };
    open();
    await screen.findByTestId("agent-profile-empty");
    // 불러오는 동안은 줄이 서고, 행이 없다고 확정되면 사라진다.
    await vi.waitFor(() => expect(screen.queryByTestId("agent-month-usage")).toBeNull());
    const dialog = screen.getByTestId("agent-profile-dialog");
    const emptyBands = [...dialog.children].filter(
      el => el.classList.contains("px-4") && el.classList.contains("py-2") && el.textContent === ""
    );
    expect(emptyBands).toEqual([]);
  });
});
