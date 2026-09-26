// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchProviderLink, fetchWorkspace } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiLinkSection } from "@/features/settings/AiLinkSection";
import { AiMyAccountsSection } from "@/features/settings/AiMyAccountsSection";
import { SubscriptionAgentEntryButton } from "./SubscriptionAgentEntry";

// #2870: 설정 › AI 연결과 에이전트 화면의 구독 줄 입구.
// #2877: 설정 쪽 입구는 「내 계정 · 이 맥」 절의 빈 줄 행동([구독 추가])이 되었다.

const envSlot = vi.hoisted(() => ({ tauri: true, flag: true }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return envSlot.flag;
    },
  };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn() };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchProviderLink: vi.fn(), fetchWorkspace: vi.fn() };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

function me(role: RosterMember["role"]): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function workspace(subscriptionAgentsEnabled: boolean) {
  return {
    id: WS,
    slug: "team",
    name: "우리 팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled,
  };
}

const session: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: ReturnType<typeof createElement>): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: session }, node)
      )
    );
  });
  return host;
}

function q(testId: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
}

async function settle(): Promise<void> {
  await rtlWaitFor(() => {
    if (vi.mocked(fetchRoster).mock.calls.length === 0) throw new Error("roster");
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  envSlot.tauri = true;
  envSlot.flag = true;
  window.history.replaceState(null, "", "/");
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(fetchRoster).mockResolvedValue([me("owner")]);
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue(workspace(true));
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("설정 › AI 연결 입구 (#2870)", () => {
  it("owner + 데스크탑 + 서버 켬: 버튼이 재진입 주소를 연다", async () => {
    mount(createElement(AiMyAccountsSection));
    await rtlWaitFor(() => {
      if (!q("subscription-entry-open")) throw new Error("entry");
    });
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("rows");
    act(() => q("subscription-entry-open")?.click());
    expect(window.location.hash).toBe("#/ai-connect?from=settings");
  });

  it("provider 연결이 운영자 403 이어도 owner 에게는 입구가 선다", async () => {
    mount(createElement(AiLinkSection, { offline: false }));
    // 운영자 안내(403 분기)가 선 **뒤에** 입구를 잰다. 로딩 분기에서 한 번 보인
    // 입구로 통과하지 않게.
    await rtlWaitFor(() => {
      if (!q("operator-notice")) throw new Error("operator notice");
    });
    expect(q("operator-notice")?.textContent).toContain("운영자만");
    await settle();
    expect(q("subscription-entry-open")).not.toBeNull();
  });

  it("일반 멤버에게는 행동이 서지 않는다(서버가 합류를 owner·admin 에게만 연다)", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([me("member")]);
    mount(createElement(AiMyAccountsSection));
    await settle();
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("denied");
    expect(q("subscription-entry-open")).toBeNull();
  });

  it("명부 조회가 실패하면 입구를 세우지 않는다(#2893: 역할을 모르면 합류 권한도 모른다)", async () => {
    vi.mocked(fetchRoster).mockRejectedValue(new ApiError(500, "roster down"));
    mount(createElement(AiMyAccountsSection));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("denied");
    expect(q("subscription-entry-open")).toBeNull();
  });

  it("명부 조회가 실패하면 에이전트 화면 머리 버튼도 없다(#2893)", async () => {
    vi.mocked(fetchRoster).mockRejectedValue(new ApiError(500, "roster down"));
    mount(createElement(SubscriptionAgentEntryButton, { from: "agents" }));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("agent-hub-subscription-entry")).toBeNull();
  });

  it("데스크탑 앱이 아니면 버튼 대신 이유 한 줄", async () => {
    envSlot.tauri = false;
    mount(createElement(AiMyAccountsSection));
    await rtlWaitFor(() => {
      if (!q("subscription-entry")) throw new Error("entry");
    });
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("desktop-only");
    expect(q("subscription-entry-open")).toBeNull();
    expect(q("subscription-entry-detail")?.textContent).toContain("데스크탑 앱에서만");
  });

  it("서버 킬 스위치가 꺼지면 버튼 대신 이유 한 줄", async () => {
    vi.mocked(fetchWorkspace).mockResolvedValue(workspace(false));
    mount(createElement(AiMyAccountsSection));
    await rtlWaitFor(() => {
      if (!q("subscription-entry")) throw new Error("entry");
    });
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("server-off");
    expect(q("subscription-entry-open")).toBeNull();
  });

  it("서버 값을 못 읽으면 server-off 한 줄로 떨어진다", async () => {
    vi.mocked(fetchWorkspace).mockRejectedValue(new Error("down"));
    mount(createElement(AiMyAccountsSection));
    await rtlWaitFor(() => {
      if (!q("subscription-entry")) throw new Error("entry");
    });
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("server-off");
    expect(q("subscription-entry-open")).toBeNull();
  });

  it("빌드가 구독 표면을 걷으면 행동도 이유도 없이 빈 줄만 선다", async () => {
    envSlot.flag = false;
    mount(createElement(AiMyAccountsSection));
    await settle();
    expect(q("subscription-entry")?.getAttribute("data-surface")).toBe("hidden");
    expect(q("subscription-entry-open")).toBeNull();
    expect(q("subscription-entry-detail")).toBeNull();
  });
});

describe("에이전트 화면 입구 (#2870)", () => {
  it("구독 줄이 설 때만 머리 버튼이 서고, 누르면 출발지를 싣는다", async () => {
    mount(createElement(SubscriptionAgentEntryButton, { from: "agents" }));
    await rtlWaitFor(() => {
      if (!q("agent-hub-subscription-entry")) throw new Error("entry");
    });
    act(() => q("agent-hub-subscription-entry")?.click());
    expect(window.location.hash).toBe("#/ai-connect?from=agents");
  });

  it("서버 킬 스위치가 꺼지면 머리 버튼은 없다", async () => {
    vi.mocked(fetchWorkspace).mockResolvedValue(workspace(false));
    mount(createElement(SubscriptionAgentEntryButton, { from: "agents" }));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("agent-hub-subscription-entry")).toBeNull();
  });
});
