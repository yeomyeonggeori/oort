// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type JoinResponse, type LoginResponse, type Member } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { setServerBase } from "@/lib/serverBase";
import { applyLogin, clearSession } from "@/lib/session";
import { useRestoredSession } from "@/app/session";
import { clearRecentServers } from "./recentServers";
import { ConnectPage } from "./ConnectPage";
import { PHONE_LINK_FIRST_RUN_KEY } from "./phoneLinkFirstRunStore";
import { releaseSessionRestore, holdSessionRestore, sessionRestoreHeld } from "./onboardingSessionHold";

const FRESH_SIGNUP_SLOT = "oort.freshSignup.v1";

const login = vi.hoisted(() => vi.fn());
const joinWithInvite = vi.hoisted(() => vi.fn());
const changeMyDisplayName = vi.hoisted(() => vi.fn());
const restoreSession = vi.hoisted(() => vi.fn());
const releaseSessionRestoreMock = vi.hoisted(() => vi.fn());
const discoveredServersMock = vi.hoisted(() =>
  vi.fn((): { base: string; displayHost: string }[] => [])
);

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    login: (...args: unknown[]) => login(...args) as Promise<LoginResponse>,
    joinWithInvite: (...args: unknown[]) =>
      joinWithInvite(...args) as Promise<JoinResponse>,
    changeMyDisplayName: (...args: unknown[]) =>
      changeMyDisplayName(...args) as Promise<Member>,
    restoreSession: () => restoreSession() as Promise<LoginResponse | null>,
  };
});

vi.mock("./onboardingSessionHold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onboardingSessionHold")>();
  return {
    ...actual,
    releaseSessionRestore: () => {
      releaseSessionRestoreMock();
      actual.releaseSessionRestore();
    },
  };
});

vi.mock("./discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery")>();
  return {
    ...actual,
    useDiscoveredServers: () => discoveredServersMock(),
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
  changeMyDisplayName.mockReset();
  restoreSession.mockReset();
  login.mockResolvedValue(session);
  joinWithInvite.mockResolvedValue({ ...session, createdMember: true });
  restoreSession.mockResolvedValue(session);
  discoveredServersMock.mockReturnValue([]);
  releaseSessionRestore();
  releaseSessionRestoreMock.mockClear();
  clearSession();
  setServerBase(null);
  clearRecentServers();
  sessionStorage.removeItem(PHONE_LINK_FIRST_RUN_KEY);
  sessionStorage.removeItem(FRESH_SIGNUP_SLOT);
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
  releaseSessionRestore();
  clearSession();
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

function SessionGate() {
  const { session: current, signIn, status } = useRestoredSession();
  if (status === "restoring") {
    return createElement("div", { "data-testid": "session-restoring" });
  }
  if (!current) return createElement(ConnectPage, { onLoggedIn: signIn });
  return createElement("div", { "data-testid": "signed-in-shell" });
}

function mountGate(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(SessionGate));
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
    expect(progress?.textContent).toBe("2/4");
    expect(document.querySelector('[data-testid="login-server"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="login-invite-code"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("login-server");
    click("onboarding-next");
    expect(document.querySelector('[data-testid="onboarding-account"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "3/4"
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
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    expect(sessionStorage.getItem(PHONE_LINK_FIRST_RUN_KEY)).toBe("pending");
    expect(
      document.querySelector('[data-testid="onboarding-phone-link"]')
    ).toBeNull();
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

async function submitJoinFromPrefill() {
  window.history.replaceState(null, "", "/?code=Ab3-_x");
  const onLoggedIn = vi.fn();
  mount(onLoggedIn);
  click("onboarding-next");
  fill("login-email", "seongjae@dawn.example");
  fill("login-password", "new-pass");
  await act(async () => {
    click("login-submit");
  });
  return onLoggedIn;
}

describe("BZ-6b onboarding profile step", () => {
  it("does not open S3 after sign-in and calls onLoggedIn immediately", async () => {
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
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith(session);
    expect(document.querySelector('[data-testid="onboarding-profile"]')).toBeNull();
    expect(joinWithInvite).not.toHaveBeenCalled();
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FRESH_SIGNUP_SLOT)).toBeNull();
  });

  it("does not open S3 when join reports createdMember false", async () => {
    joinWithInvite.mockResolvedValue({ ...session, createdMember: false });
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith({ ...session, createdMember: false });
    expect(document.querySelector('[data-testid="onboarding-profile"]')).toBeNull();
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FRESH_SIGNUP_SLOT)).toBeNull();
  });

  it("writes the fresh-signup marker at join success, before any S3 interaction, and only once", async () => {
    const writes: string[] = [];
    const orig = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === FRESH_SIGNUP_SLOT) writes.push(value);
      return orig.call(this, key, value);
    });
    try {
      const onLoggedIn = await submitJoinFromPrefill();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
      });
      expect(onLoggedIn).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0] ?? "null")).toEqual({
        workspaceId: session.member.workspaceId,
        memberId: session.member.id,
      });
      await act(async () => {
        click("onboarding-profile-skip");
      });
      await vi.waitFor(() => {
        expect(onLoggedIn).toHaveBeenCalledTimes(1);
      });
      expect(writes).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("opens S3 after a join that created the member, with no 뒤로 and counter 4/4", async () => {
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    });
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "4/4"
    );
    expect(document.querySelector('[data-testid="onboarding-back"]')).toBeNull();
    const name = document.querySelector(
      '[data-testid="onboarding-profile-name"]'
    ) as HTMLInputElement | null;
    expect(name?.value).toBe("곽성재");
  });

  it("labels the display-name field as 선택, never 필수", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    });
    const card = document.querySelector('[data-testid="onboarding-profile"]');
    expect(card?.textContent).toContain("선택");
    expect(card?.textContent).not.toContain("필수");
  });

  it("does not render the discovered-servers picker on S3", async () => {
    discoveredServersMock.mockReturnValue([
      { base: "https://lan.example", displayHost: "Mac.local:28000" },
    ]);
    window.history.replaceState(null, "", "/?code=Ab3-_x");
    mount();
    expect(document.querySelector('[data-testid="connect-discovery"]')).not.toBeNull();
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="connect-discovery"]')).toBeNull();
    expect(document.querySelector('[data-testid="connect-discovery-item"]')).toBeNull();
  });

  it("wires the helper sentence as a description of the name field", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-name"]')).not.toBeNull();
    });
    const input = document.querySelector('[data-testid="onboarding-profile-name"]');
    const hint = document.getElementById("onboarding-profile-name-hint");
    const label = document.querySelector('label[for="onboarding-profile-name"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("나중에 설정에서 언제든 바꿀 수 있습니다");
    expect(input?.getAttribute("aria-describedby")).toContain("onboarding-profile-name-hint");
    expect(label).not.toBeNull();
  });

  it("skip lands without PATCHing; the marker was already written at join", async () => {
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-skip"]')).not.toBeNull();
    });
    await act(async () => {
      click("onboarding-profile-skip");
    });
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(onLoggedIn).toHaveBeenCalledWith({ ...session, createdMember: true });
    expect(JSON.parse(sessionStorage.getItem(FRESH_SIGNUP_SLOT) ?? "null")).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
  });

  it("rejects 101 characters in a sentence, disables save, and does not PATCH", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-name"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "가".repeat(101));
    const message = document.querySelector(
      '[data-testid="onboarding-profile-name-error"]'
    )?.textContent;
    expect(message).toBe("표시 이름은 100자까지 쓸 수 있습니다.");
    expect(message).not.toMatch(/100자 초과/);
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      click("onboarding-profile-submit");
    });
    expect(changeMyDisplayName).not.toHaveBeenCalled();
  });

  it("rejects empty and whitespace names client-side and never PATCHes an empty displayName", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-name"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "");
    expect(
      document.querySelector('[data-testid="onboarding-profile-name-error"]')
        ?.textContent
    ).toBe("표시 이름을 비울 수 없습니다. 한 글자 이상 적으세요.");
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      click("onboarding-profile-submit");
    });
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(changeMyDisplayName.mock.calls.map((args) => args[1])).not.toContain("");

    fill("onboarding-profile-name", "   ");
    expect(
      document.querySelector('[data-testid="onboarding-profile-name-error"]')
        ?.textContent
    ).toBe("표시 이름을 비울 수 없습니다. 한 글자 이상 적으세요.");
    expect(submit.disabled).toBe(true);
    await act(async () => {
      click("onboarding-profile-submit");
    });
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(changeMyDisplayName.mock.calls.map((args) => args[1])).not.toEqual(
      expect.arrayContaining(["", "   "])
    );
  });

  it("accepts a 100-character name and PATCHes that body", async () => {
    const name = "가".repeat(100);
    const renamed = { ...session.member, displayName: name };
    changeMyDisplayName.mockResolvedValue(renamed);
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-name"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", name);
    expect(document.querySelector('[data-testid="onboarding-profile-name-error"]')).toBeNull();
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    });
    expect(changeMyDisplayName).toHaveBeenCalledWith(session.member.workspaceId, name);
    expect(changeMyDisplayName.mock.calls[0]?.[1]).toHaveLength(100);
  });

  it("shows a fail-forward banner on PATCH failure and 계속 lands with the original member", async () => {
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-banner"]')).not.toBeNull();
    });
    const banner = document.querySelector('[data-testid="onboarding-profile-banner"]')
      ?.textContent;
    expect(banner).toContain("요청을 끝내지 못했습니다. 잠시 뒤에 다시 시도하세요.");
    expect(banner).toContain("설정 › 프로필에서 언제든 바꿀 수 있어요.");
    expect(banner).not.toContain("나중에 설정에서 언제든 바꿀 수 있습니다");
    expect(banner).not.toContain("engine boom");
    expect(onLoggedIn).not.toHaveBeenCalled();
    const retry = document.querySelector(
      '[data-testid="onboarding-profile-banner"] button'
    );
    expect(retry?.textContent).toContain("다시 시도");
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    expect(submit.textContent).toContain("계속");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith({ ...session, createdMember: true });
    expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    expect(changeMyDisplayName).toHaveBeenCalledWith(session.member.workspaceId, "성재");
  });

  it("editing after a PATCH failure re-arms save so the primary PATCHes the new name", async () => {
    changeMyDisplayName.mockRejectedValueOnce(new ApiError(500, "engine boom"));
    const renamed = { ...session.member, displayName: "두번째이름" };
    changeMyDisplayName.mockResolvedValueOnce(renamed);
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-banner"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "두번째이름");
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    expect(submit.textContent).toContain("저장");
    expect(submit.textContent).not.toContain("계속");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(changeMyDisplayName).toHaveBeenCalledTimes(2);
    });
    expect(changeMyDisplayName.mock.calls[1]?.[1]).toBe("두번째이름");
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith({
      ...session,
      createdMember: true,
      member: renamed,
    });
  });

  it("keeps keyboard focus on the name field after a failed Enter save, not body", async () => {
    let rejectPatch: ((error: unknown) => void) | undefined;
    changeMyDisplayName.mockImplementation(
      () =>
        new Promise<Member>((_, reject) => {
          rejectPatch = reject;
        })
    );
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    const submit = document.querySelector(
      '[data-testid="onboarding-profile-submit"]'
    ) as HTMLButtonElement;
    const name = document.querySelector(
      '[data-testid="onboarding-profile-name"]'
    ) as HTMLInputElement;
    act(() => {
      submit.focus();
    });
    expect(document.activeElement).toBe(submit);
    await act(async () => {
      submit.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
      submit.form?.requestSubmit();
    });
    await vi.waitFor(() => {
      expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    });
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.disabled).toBe(false);
    await act(async () => {
      rejectPatch?.(new ApiError(500, "engine boom"));
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-banner"]')).not.toBeNull();
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(name);
    expect(document.activeElement?.getAttribute("data-testid")).not.toBe(
      "onboarding-profile-skip"
    );
  });

  it("다시 시도 after a PATCH failure re-sends the current draft", async () => {
    changeMyDisplayName.mockRejectedValueOnce(new ApiError(500, "engine boom"));
    const renamed = { ...session.member, displayName: "성재" };
    changeMyDisplayName.mockResolvedValueOnce(renamed);
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-banner"] button')).not.toBeNull();
    });
    await act(async () => {
      (
        document.querySelector(
          '[data-testid="onboarding-profile-banner"] button'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(changeMyDisplayName).toHaveBeenCalledTimes(2);
    });
    expect(changeMyDisplayName.mock.calls.map((args) => args[1])).toEqual([
      "성재",
      "성재",
    ]);
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith({
      ...session,
      createdMember: true,
      member: renamed,
    });
  });

  it("save success lands with the renamed member", async () => {
    const renamed = { ...session.member, displayName: "성재" };
    changeMyDisplayName.mockResolvedValue(renamed);
    const onLoggedIn = await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith({
      ...session,
      createdMember: true,
      member: renamed,
    });
    expect(JSON.parse(sessionStorage.getItem(FRESH_SIGNUP_SLOT) ?? "null")).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
  });

  it("releases the restore hold once on skip", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-skip"]')).not.toBeNull();
    });
    expect(sessionRestoreHeld()).toBe(true);
    releaseSessionRestoreMock.mockClear();
    await act(async () => {
      click("onboarding-profile-skip");
    });
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the restore hold once on save", async () => {
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "성재" });
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    expect(sessionRestoreHeld()).toBe(true);
    releaseSessionRestoreMock.mockClear();
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    });
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the restore hold once on fail-forward 계속", async () => {
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-submit"]')).not.toBeNull();
    });
    fill("onboarding-profile-name", "성재");
    await act(async () => {
      click("onboarding-profile-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile-banner"]')).not.toBeNull();
    });
    expect(sessionRestoreHeld()).toBe(true);
    releaseSessionRestoreMock.mockClear();
    await act(async () => {
      click("onboarding-profile-submit");
    });
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the restore hold once on unmount during S3", async () => {
    await submitJoinFromPrefill();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    });
    expect(sessionRestoreHeld()).toBe(true);
    releaseSessionRestoreMock.mockClear();
    act(() => {
      mountedRoot?.unmount();
      mountedRoot = null;
    });
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("keeps S3 on screen after join applyLogin instead of restoring the shell", async () => {
    joinWithInvite.mockImplementation(async () => {
      applyLogin(session);
      return { ...session, createdMember: true };
    });
    mountGate();
    click("onboarding-choose-invite");
    fill("login-invite-code", "Ab3-_x");
    click("onboarding-next");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    await act(async () => {
      click("login-submit");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="onboarding-profile"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="session-restoring"]')).toBeNull();
    expect(document.querySelector('[data-testid="signed-in-shell"]')).toBeNull();
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it("starts a restore after applyLogin when nothing holds it", async () => {
    mountGate();
    await act(async () => {
      applyLogin(session);
    });
    await vi.waitFor(() => {
      expect(restoreSession).toHaveBeenCalled();
    });
  });

  it("does not start restore while the join hold is on", async () => {
    mountGate();
    await act(async () => {
      holdSessionRestore();
      applyLogin(session);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restoreSession).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="session-restoring"]')).toBeNull();
  });
});

