// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchAgentProfile,
  fetchAgentRunDetail,
  fetchAgentRunSummaries,
  fetchRoster,
  type RosterMember,
} from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { AgentHubRoute } from "./AgentHubRoute";

// =============================================================================
// #5242: 에이전트 허브의 불러오기 실패 네 자리(명부·프로필·작업 이력·작업 상세). 옛 「…불러오지 못했어요.」 배너는 원인 상자다:
// 제목은 자리마다, 이유는 오류 객체의 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을 따라가고, 다시 시도가 그 자리의 읽기만 다시 부른다.
// =============================================================================

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: vi.fn(),
    fetchAgentProfile: vi.fn(),
    fetchAgentRunSummaries: vi.fn(),
    fetchAgentRunDetail: vi.fn(),
  };
});
// 이력 탭만 세운다(다른 표면은 이 시험의 관심이 아니다).
vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>()),
  isSurfaceProvided: (id: string) => id === "agentRunHistory",
}));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const A1 = "00000000-0000-7000-8000-000000000301";
const RUN = "00000000-0000-7000-8000-000000000701";
const row = (id: string, name: string, kind: "human" | "agent"): RosterMember => ({
  id, workspaceId: WS, kind, status: "active", displayName: name, handle: name, role: kind === "human" ? "owner" : undefined,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, paused: false,
});
const ROSTER = [row(ME, "곽성재", "human"), row(A1, "가나다", "agent")];

const session: SessionContextValue = {
  session: {
    accessToken: "a", refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(LocaleProvider, {
        locale: ko,
        children: createElement(
          MemoryRouter,
          { initialEntries: [`/agents?agent=${A1}`] },
          createElement(
            QueryClientProvider,
            { client },
            createElement(SessionProvider, { value: session }, createElement(AgentHubRoute))
          )
        ),
      })
    );
  });
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);
const REASON_SERVER = "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요.";
const REASON_UNKNOWN = "문제가 생겼어요. 다시 시도해 주세요.";

beforeAll(async () => {
  ko = await koreanLocale();
  env.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
  vi.mocked(fetchRoster).mockReset().mockResolvedValue(ROSTER);
  vi.mocked(fetchAgentProfile).mockReset().mockResolvedValue({} as never);
  vi.mocked(fetchAgentRunSummaries).mockReset().mockResolvedValue({ runs: [] });
  vi.mocked(fetchAgentRunDetail).mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// 상자 하나가 지키는 것: 역할·원인 표시·제목·원인별 이유·상태 코드 없음. 다시 시도는 호출부가 단정한다.
function expectBox(box: HTMLElement | null, title: string, cause: string, reason: string): HTMLElement {
  expect(box, title).not.toBeNull();
  const node = box as HTMLElement;
  expect(node.getAttribute("role")).toBe("alert");
  expect(node.getAttribute("data-cause") ?? "").toBe(cause);
  expect(node.textContent).toContain(title);
  expect(node.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
  expect(node.textContent).not.toMatch(/\d{3}/);
  return node;
}

describe("에이전트 허브: 불러오기 실패 (#5242)", () => {
  it("명부를 못 읽으면 원인 상자가 서고, 다시 시도가 명부를 다시 읽는다", async () => {
    vi.mocked(fetchRoster).mockRejectedValue(new NetworkError("unreachable", 15_000));
    mount();
    await waitFor(() => expect(byId("agent-hub-roster-error")).not.toBeNull());
    const box = expectBox(byId("agent-hub-roster-error"), "에이전트 목록을 불러오지 못했어요", "serverUnreachable", REASON_SERVER);
    expect(document.body.textContent).not.toContain("에이전트 명부를 불러오지 못했어요.");
    const reads = vi.mocked(fetchRoster).mock.calls.length;
    act(() => fireEvent.click(box.querySelector("button") as HTMLElement));
    await waitFor(() => expect(vi.mocked(fetchRoster).mock.calls.length).toBeGreaterThan(reads));
  });

  it("프로필을 못 읽으면 원인 상자가 서고(이름·사진 카드는 그대로), 다시 시도가 프로필을 다시 읽는다", async () => {
    vi.mocked(fetchAgentProfile).mockRejectedValue(new ApiError(500, "boom", "internal"));
    mount();
    await waitFor(() => expect(byId("agent-hub-profile-error")).not.toBeNull());
    const box = expectBox(byId("agent-hub-profile-error"), "에이전트 프로필을 불러오지 못했어요", "", REASON_UNKNOWN);
    const reads = vi.mocked(fetchAgentProfile).mock.calls.length;
    act(() => fireEvent.click(box.querySelector("button") as HTMLElement));
    await waitFor(() => expect(vi.mocked(fetchAgentProfile).mock.calls.length).toBeGreaterThan(reads));
  });

  it("작업 이력을 못 읽으면 원인 상자가 서고, 다시 시도가 이력을 다시 읽는다", async () => {
    vi.mocked(fetchAgentRunSummaries).mockRejectedValue(new NetworkError("unreachable", 15_000));
    mount();
    await waitFor(() => expect(byId("agent-hub-tab-history")).not.toBeNull());
    act(() => fireEvent.click(byId("agent-hub-tab-history") as HTMLElement));
    await waitFor(() => expect(byId("agent-history-error")).not.toBeNull());
    const box = expectBox(byId("agent-history-error"), "에이전트 작업 이력을 불러오지 못했어요", "serverUnreachable", REASON_SERVER);
    const reads = vi.mocked(fetchAgentRunSummaries).mock.calls.length;
    act(() => fireEvent.click(box.querySelector("button") as HTMLElement));
    await waitFor(() => expect(vi.mocked(fetchAgentRunSummaries).mock.calls.length).toBeGreaterThan(reads));
  });

  it("작업 상세를 못 읽으면 대화상자 안에 원인 상자가 서고, 다시 시도가 상세를 다시 읽는다", async () => {
    vi.mocked(fetchAgentRunSummaries).mockResolvedValue({
      runs: [{ id: RUN, channelId: A1, triggerSummary: "주간 보고 정리", status: "succeeded", createdAtMs: 1_800_000_000_000, updatedAtMs: 1_800_000_000_000 }],
    });
    vi.mocked(fetchAgentRunDetail).mockRejectedValue(new ApiError(500, "boom", "internal"));
    mount();
    await waitFor(() => expect(byId("agent-hub-tab-history")).not.toBeNull());
    act(() => fireEvent.click(byId("agent-hub-tab-history") as HTMLElement));
    await waitFor(() => expect(byId("agent-history-row")).not.toBeNull());
    act(() => fireEvent.click(byId("agent-history-row") as HTMLElement));
    await waitFor(() => expect(byId("agent-run-detail-error")).not.toBeNull());
    const box = expectBox(byId("agent-run-detail-error"), "작업 상세를 불러오지 못했어요", "", REASON_UNKNOWN);
    const reads = vi.mocked(fetchAgentRunDetail).mock.calls.length;
    act(() => fireEvent.click(box.querySelector("button") as HTMLElement));
    await waitFor(() => expect(vi.mocked(fetchAgentRunDetail).mock.calls.length).toBeGreaterThan(reads));
  });
});
