// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Member, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ProfileSection } from "./ProfileSection";
import {
  clearOwnerOnboardingPending,
  hasOwnerOnboardingSettingsDoor,
  markOwnerOnboardingPending,
} from "@/features/onboarding/ownerOnboardingStore";
import { clearS1Draft, readS1Draft, writeS1Draft } from "@/features/onboarding/s1Draft";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const changeMyProfile = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    changeMyProfile: (
      workspaceId: string,
      patch: { displayName?: string; handle?: string }
    ) => changeMyProfile(workspaceId, patch) as Promise<Member>,
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
  changeMyProfile.mockReset();
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
  clearOwnerOnboardingPending();
  clearS1Draft();
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
    changeMyProfile.mockResolvedValue(member);
    const { host, client, replaceSessionMember } = mountSection();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const setQueryData = vi.spyOn(client, "setQueryData");

    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "성재"));
    const save = host.querySelector(
      '[data-testid="profile-save"]'
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });

    await vi.waitFor(() => {
      expect(changeMyProfile).toHaveBeenCalledTimes(1);
    });
    expect(changeMyProfile).toHaveBeenCalledWith(WS, { displayName: "성재" });
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
    expect(
      (host.querySelector('[data-testid="profile-handle"]') as HTMLInputElement)
        .value
    ).toBe("seongjae");
    expect(host.querySelectorAll('[data-testid="profile-save"]').length).toBe(1);
  });

  it("낙관 갱신 없이 PATCH가 끝날 때까지 이전 이름을 유지한다", async () => {
    let resolvePatch: ((member: Member) => void) | undefined;
    changeMyProfile.mockReturnValue(
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
        host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
      ).click();
    });

    expect(changeMyProfile).toHaveBeenCalledTimes(1);
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

  it("빈 이름과 공백만 있는 이름은 제출에서 막고 PATCH를 보내지 않는다", async () => {
    const { host, replaceSessionMember } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "   "));
    expect(host.querySelector("#profile-display-name-error")).toBeNull();
    const save = host.querySelector(
      '[data-testid="profile-save"]'
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector("#profile-display-name-error")?.textContent).toBe(
      "표시 이름을 비울 수 없습니다. 한 글자 이상 적으세요."
    );
    expect(changeMyProfile).not.toHaveBeenCalled();
    expect(replaceSessionMember).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("매핑되지 않은 오류는 와이어 문장 대신 일반 폴백을 쓴다", async () => {
    changeMyProfile.mockRejectedValue(new ApiError(500, "engine boom"));
    const { host } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "성재"));
    await act(async () => {
      (
        host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="profile-save-error"]')?.textContent).toBe(
        "요청을 끝내지 못했습니다. 잠시 뒤에 다시 시도하세요."
      );
    });
    expect(host.querySelector("#profile-display-name-error")?.textContent ?? "").toBe("");
    expect(
      host.querySelector('[data-testid="profile-display-name"]')?.getAttribute("aria-invalid")
    ).toBeNull();
    expect(host.textContent).not.toContain("engine boom");
  });

  it("101자는 제출에서 문장형으로 막고 PATCH를 보내지 않는다", async () => {
    const { host } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "가".repeat(101)));
    expect(host.querySelector("#profile-display-name-error")).toBeNull();
    const save = host.querySelector(
      '[data-testid="profile-save"]'
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    expect(host.querySelector("#profile-display-name-error")?.textContent).toBe(
      "표시 이름은 100자까지 쓸 수 있습니다."
    );
    expect(changeMyProfile).not.toHaveBeenCalled();
  });

  it("핸들 저장은 E2 PATCH 1회이고 성공 시에만 세션을 갱신한다", async () => {
    const member = sessionMember();
    changeMyProfile.mockResolvedValue({ ...member, handle: "kwak" });
    const { host, replaceSessionMember } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "kwak"));
    await act(async () => {
      (
        host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(changeMyProfile).toHaveBeenCalledTimes(1);
    });
    expect(changeMyProfile).toHaveBeenCalledWith(WS, { handle: "kwak" });
    expect(replaceSessionMember).toHaveBeenCalledWith({
      ...member,
      handle: "kwak",
    });
  });

  it("핸들 409는 필드 옆 제품 한국어이고 와이어 문장을 그리지 않는다", async () => {
    changeMyProfile.mockRejectedValue(new ApiError(409, "handle is already in use"));
    const { host } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "taken"));
    await act(async () => {
      (
        host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="profile-handle-error"]')?.textContent
      ).toBe("이미 쓰는 핸들이에요. 다른 핸들을 골라주세요.");
    });
    expect(host.textContent).not.toContain("handle is already in use");
    const field = host.querySelector('label[for="profile-handle"]');
    expect(field?.className).toContain("gap-1");
    expect(input.getAttribute("aria-describedby")).toContain("profile-handle-error");
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(input);
  });

  it("핸들은 첫 키입력에서 alert를 띄우지 않고 blur에서 검증한다", () => {
    const { host } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "k"));
    expect(host.querySelector('[data-testid="profile-handle-error"]')?.textContent ?? "").toBe(
      ""
    );
    expect(input.getAttribute("aria-invalid")).toBeNull();
    act(() => {
      input.focus();
      input.blur();
    });
    expect(host.querySelector('[data-testid="profile-handle-error"]')?.textContent).toBe(
      "핸들은 영문 소문자·숫자·하이픈 2~32자예요."
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("여러 칸이 틀리면 첫 칸으로 포커스를 옮긴다", async () => {
    const { host } = mountSection();
    const display = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    const handle = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(display, "   "));
    act(() => setInputValue(handle, "k"));
    await act(async () => {
      (
        host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(display);
  });

  it("표시 이름과 핸들을 같이 바꾸면 PATCH 1회 (M-R3-5)", async () => {
    changeMyProfile.mockResolvedValue({
      ...sessionMember("곽성재2"),
      handle: "kwak",
    });
    const { host } = mountSection();
    const display = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    const handle = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(display, "곽성재2"));
    act(() => setInputValue(handle, "kwak"));
    await act(async () => {
      (host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(changeMyProfile).toHaveBeenCalledTimes(1);
    });
    expect(changeMyProfile).toHaveBeenCalledWith(WS, {
      displayName: "곽성재2",
      handle: "kwak",
    });
  });

  it("프로필 500은 배너만 쓰고 표시 이름에 aria-invalid를 달지 않는다 (M-R3-4)", async () => {
    changeMyProfile.mockRejectedValue(new ApiError(500, "engine boom"));
    const { host } = mountSection();
    const display = host.querySelector(
      '[data-testid="profile-display-name"]'
    ) as HTMLInputElement;
    const handle = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(display, "곽성재2"));
    act(() => setInputValue(handle, "kwak"));
    await act(async () => {
      (host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="profile-save-error"]')).not.toBeNull();
    });
    expect(display.getAttribute("aria-invalid")).toBeNull();
    expect(handle.getAttribute("aria-invalid")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(
      document.activeElement?.querySelector('[data-testid="profile-save-error"]')
    ).not.toBeNull();
  });

  it("핸들 blur 오류 칸은 높이를 남겨 저장 클릭이 제출된다 (M-R3-3)", async () => {
    const { host } = mountSection();
    const handle = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    const save = host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement;
    const slot = host.querySelector('[data-testid="profile-handle-error"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("min-h-6");
    expect(slot?.textContent ?? "").toBe("");
    act(() => {
      handle.focus();
      setInputValue(handle, "k");
    });
    await act(async () => {
      handle.dispatchEvent(
        new FocusEvent("blur", { bubbles: true, relatedTarget: save })
      );
      save.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(changeMyProfile).not.toHaveBeenCalled();
    expect(handle.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(handle);
  });

  it("프로필 저장은 pending S1 플래그와 초안 핸들을 갱신한다 (M-R3-5)", async () => {
    markOwnerOnboardingPending();
    writeS1Draft({
      workspaceName: "여명거리",
      displayName: "곽성재",
      handle: "seongjae",
    });
    changeMyProfile.mockResolvedValue({ ...sessionMember(), handle: "kwak" });
    const { host } = mountSection();
    const input = host.querySelector(
      '[data-testid="profile-handle"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "kwak"));
    await act(async () => {
      (host.querySelector('[data-testid="profile-save"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(changeMyProfile).toHaveBeenCalledTimes(1);
    });
    expect(hasOwnerOnboardingSettingsDoor("profile")).toBe(true);
    expect(readS1Draft()?.handle).toBe("");
    expect(readS1Draft()?.workspaceName).toBe("여명거리");
  });
});
