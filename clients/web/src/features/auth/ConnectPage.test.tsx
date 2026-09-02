// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { setServerBase } from "@/lib/serverBase";
import { clearRecentServers } from "./recentServers";
import { ConnectPage } from "./ConnectPage";

const login = vi.hoisted(() => vi.fn());
const joinWithInvite = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    login: (...args: unknown[]) => login(...args) as Promise<LoginResponse>,
    joinWithInvite: (...args: unknown[]) =>
      joinWithInvite(...args) as Promise<LoginResponse>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let rafCalls = 0;
let reducedMotion = false;

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  rafCalls = 0;
  reducedMotion = false;
  login.mockReset();
  joinWithInvite.mockReset();
  login.mockResolvedValue(session);
  joinWithInvite.mockResolvedValue(session);
  setServerBase(null);
  clearRecentServers();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("requestAnimationFrame", () => {
    rafCalls += 1;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  setServerBase(null);
  clearRecentServers();
  vi.unstubAllGlobals();
});

function mount(onLoggedIn: (next: LoginResponse) => void = () => undefined): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(ConnectPage, { onLoggedIn }));
  });
  return host;
}

function click(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node, testId).not.toBeNull();
  act(() => {
    (node as HTMLElement).click();
  });
}

function fill(testId: string, value: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null;
  expect(node, testId).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("BZ-6a onboarding shell", () => {
  it("renders the S0 mark, scatter field and two choices", () => {
    mount();
    expect(document.querySelector('[data-testid="onboarding-landing"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-mark"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="onboarding-wordmark"]')?.textContent
    ).toBe("oort");
    expect(
      document.querySelector('[data-testid="onboarding-tagline"]')?.textContent
    ).toBe("사람과 에이전트가 같은 자리에서 일하는 메신저.");
    expect(
      document.querySelectorAll("[data-onboarding-body]")
    ).toHaveLength(30);
    expect(document.querySelector('[data-testid="onboarding-choose-server"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-choose-invite"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-progress"]')).toBeNull();
  });

  it("does not start the wander loop when reduced motion is on", () => {
    reducedMotion = true;
    mount();
    expect(rafCalls).toBe(0);
  });

  it("starts the wander loop when motion is allowed", () => {
    mount();
    expect(rafCalls).toBeGreaterThan(0);
  });

  it("branches from the two choices into S1 then S2 with back and progress", () => {
    mount();
    click("onboarding-choose-server");
    expect(document.querySelector('[data-testid="onboarding-gateway"]')).not.toBeNull();
    const chrome = document.querySelector('[data-testid="onboarding-step-chrome"]');
    const back = document.querySelector('[data-testid="onboarding-back"]');
    const progress = document.querySelector('[data-testid="onboarding-progress"]');
    expect(chrome).not.toBeNull();
    expect(chrome?.contains(back)).toBe(true);
    expect(chrome?.contains(progress)).toBe(true);
    expect(back?.textContent).toContain("뒤로");
    expect(back?.querySelector("svg")).not.toBeNull();
    expect(back?.className).not.toMatch(/underline/);
    expect(progress?.textContent).toBe("2/3");
    expect(document.querySelector('[data-testid="login-server"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="login-invite-code"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("login-server");
    click("onboarding-next");
    expect(document.querySelector('[data-testid="onboarding-account"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "3/3"
    );
    expect(document.querySelector('[data-testid="login-email"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("login-email");
    click("onboarding-back");
    expect(document.querySelector('[data-testid="onboarding-gateway"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("login-server");
    click("onboarding-back");
    expect(document.querySelector('[data-testid="onboarding-landing"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "onboarding-choose-server"
    );
    click("onboarding-choose-invite");
    expect(document.querySelector('[data-testid="login-invite-code"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "login-invite-code"
    );
  });

  it("skips S0 when a server is already stored", () => {
    setServerBase("https://team.example.com");
    mount();
    expect(document.querySelector('[data-testid="onboarding-landing"]')).toBeNull();
    expect(document.querySelector('[data-testid="onboarding-gateway"]')).not.toBeNull();
    expect(
      (document.querySelector('[data-testid="login-server"]') as HTMLInputElement).value
    ).toBe("https://team.example.com");
  });

  it("keeps a /join?code= prefill on the invite path", () => {
    window.history.replaceState(null, "", "/?code=Ab3-_x");
    mount();
    expect(document.querySelector('[data-testid="onboarding-landing"]')).toBeNull();
    const code = document.querySelector(
      '[data-testid="login-invite-code"]'
    ) as HTMLInputElement | null;
    expect(code).not.toBeNull();
    expect(code?.value).toBe("Ab3-_x");
    expect(
      document
        .querySelector("[data-onboarding-effect]")
        ?.getAttribute("data-onboarding-effect")
    ).toBe("none");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "onboarding-next"
    );
  });

  it("still signs in through the stepped form", async () => {
    setServerBase("https://team.example.com");
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "correct-horse");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(login).toHaveBeenCalledWith(
        "seongjae@dawn.example",
        "correct-horse",
        ""
      );
    });
    expect(onLoggedIn).toHaveBeenCalledWith(session);
    expect(joinWithInvite).not.toHaveBeenCalled();
  });

  it("still joins through the stepped form with the prefilled code", async () => {
    window.history.replaceState(null, "", "/?code=Ab3-_x");
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(joinWithInvite).toHaveBeenCalledWith(
        "Ab3-_x",
        "seongjae@dawn.example",
        "new-pass"
      );
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="onboarding-phone-link"]')
      ).not.toBeNull();
    });
    expect(onLoggedIn).not.toHaveBeenCalled();
    click("onboarding-enter-app");
    expect(onLoggedIn).toHaveBeenCalledWith(session);
    expect(login).not.toHaveBeenCalled();
  });

  it("returns a code-status join failure to S1 with the banner on the code field", async () => {
    window.history.replaceState(null, "", "/?code=Ab3-_x");
    joinWithInvite.mockRejectedValue(new ApiError(404, "invite not found"));
    mount();
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-gateway"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="onboarding-account"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-invite-code"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="login-error"]')?.textContent).toContain(
      "유효하지 않은 초대 코드"
    );
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "login-invite-code"
    );
  });

  it("keeps a transport join failure on S2", async () => {
    window.history.replaceState(null, "", "/?code=Ab3-_x");
    joinWithInvite.mockRejectedValue(new NetworkError("unreachable", 15_000));
    mount();
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="login-error"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="onboarding-account"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-gateway"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-error"]')?.textContent).toContain(
      "서버에 닿지 못했습니다"
    );
  });

  it("says S2 is about signing in, not picking a server", () => {
    mount();
    click("onboarding-choose-server");
    click("onboarding-next");
    expect(document.querySelector('[data-testid="onboarding-account"]')?.textContent).toContain(
      "가입할 때 쓴 이메일로 로그인합니다."
    );
  });
});
