// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Member, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ProfileSection } from "./ProfileSection";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const changeMyDisplayName = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    changeMyDisplayName: (
      workspaceId: string,
      displayName: string
    ) => changeMyDisplayName(workspaceId, displayName) as Promise<Member>,
    fetchRoster: (workspaceId: string) =>
      fetchRoster(workspaceId) as Promise<RosterMember[]>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  changeMyDisplayName.mockReset();
  fetchRoster.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

function rosterMember(displayName = "곽성재"): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function sessionMember(displayName = "곽성재"): Member {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    displayName,
    handle: "seongjae",
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mountSection(options?: {
  client?: QueryClient;
}): {
  host: HTMLElement;
  client: QueryClient;
  replaceSessionMember: ReturnType<typeof vi.fn>;
} {
  const client =
    options?.client ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
  client.setQueryData(["roster", WS], [rosterMember()]);
  fetchRoster.mockResolvedValue([rosterMember("성재")]);
  const replaceSessionMember = vi.fn();
  const session: SessionContextValue = {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: sessionMember(),
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember,
  };
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session },
      createElement(ProfileSection, { offline: false })
    )
  );
  act(() => mountedRoot?.render(tree));
  return { host, client, replaceSessionMember };
}

describe("ProfileSection", () => {
  it("표시 이름 저장은 PATCH 1회이고 성공 시에만 invalidate한다", async () => {
    const member = sessionMember("성재");
    changeMyDisplayName.mockResolvedValue(member);
    const { host, client, replaceSessionMember } = mountSection();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const setQueryData = vi.spyOn(client, "setQueryData");

    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "성재"));
    const save = host.querySelector(
      '[data-testid="profile-display-name-save"]'
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });

    await vi.waitFor(() => {
      expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    });
    expect(changeMyDisplayName).toHaveBeenCalledWith(WS, "성재");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    expect(replaceSessionMember).toHaveBeenCalledTimes(1);
    expect(replaceSessionMember).toHaveBeenCalledWith(member);
    expect(
      setQueryData.mock.calls.some(
        (call) =>
          JSON.stringify(call[0]) === JSON.stringify(["roster", WS]) &&
          Array.isArray(call[1]) &&
          (call[1] as RosterMember[])[0]?.displayName === "성재"
      )
    ).toBe(false);
    expect(host.querySelector('[data-testid="logout"]')).toBeNull();
    expect(host.textContent).toContain("@seongjae");
  });

  it("낙관 갱신 없이 PATCH가 끝날 때까지 이전 이름을 유지한다", async () => {
    let resolvePatch: ((member: Member) => void) | undefined;
    changeMyDisplayName.mockReturnValue(
      new Promise<Member>((resolve) => {
        resolvePatch = resolve;
      })
    );
    const { host, client, replaceSessionMember } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "성재"));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="profile-display-name-save"]'
        ) as HTMLButtonElement
      ).click();
    });

    expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    expect(replaceSessionMember).not.toHaveBeenCalled();
    expect(
      (client.getQueryData(["roster", WS]) as RosterMember[])[0].displayName
    ).toBe("곽성재");

    await act(async () => {
      resolvePatch?.(sessionMember("성재"));
    });
    await vi.waitFor(() => {
      expect(replaceSessionMember).toHaveBeenCalledTimes(1);
    });
  });

  it("400 문장을 InlineBanner에 그대로 보여 준다", async () => {
    changeMyDisplayName.mockRejectedValue(
      new ApiError(400, "displayName is required")
    );
    const { host, replaceSessionMember } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "   "));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="profile-display-name-save"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="profile-display-name-error"]')
          ?.textContent
      ).toBe("displayName is required");
    });
    expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    expect(replaceSessionMember).not.toHaveBeenCalled();
  });
});
