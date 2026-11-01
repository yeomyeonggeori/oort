// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse } from "@momo/core/lib/api";
import { setServerBase } from "@/lib/serverBase";
import { clearSession } from "@/lib/session";
import { clearRecentServers } from "./recentServers";
import { ConnectPage } from "./ConnectPage";
import { REMEMBERED_LOGIN_STORAGE_KEY } from "./rememberedLogin";
import { releaseSessionRestore } from "./onboardingSessionHold";

// =============================================================================
// 로그인 화면의 「이메일 기억하기」 (#4669), 웹(브라우저 기본 끔).
//
// 시험은 **화면을 쓰는 순서대로** 간다: 서버를 고르고 → 켜고 → 로그인하고 → 로그아웃해서
// 화면을 다시 마운트하면 같은 서버의 이메일 칸이 채워져 있다. 「지우지 않았다」가 아니라
// 다시 그린 칸의 값과 저장소에 적힌 글자를 잰다.
// =============================================================================

const login = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, login: (...args: unknown[]) => login(...args) as Promise<LoginResponse> };
});

// 테스트 프리필(`VITE_MOMO_DEV_EMAIL`)은 빌드 상수다. 한 시험에서만 켠다.
const envSlot = vi.hoisted(() => ({ devEmail: "" }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get DEV_EMAIL() {
      return envSlot.devEmail;
    },
    get TEST_PREFILL_ACTIVE() {
      return envSlot.devEmail !== "";
    },
  };
});

vi.mock("./discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery")>();
  return {
    ...actual,
    useDiscovery: () => ({ servers: [], available: false, searching: false }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const SERVER_A = "https://a.example.com";
const SERVER_B = "https://b.example.com";
const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  envSlot.devEmail = "";
  login.mockReset();
  login.mockResolvedValue(session);
  releaseSessionRestore();
  clearSession();
  setServerBase(null);
  clearRecentServers();
  localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  unmount();
  setServerBase(null);
  clearRecentServers();
  localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
  releaseSessionRestore();
  clearSession();
  vi.unstubAllGlobals();
});

function mount(): void {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(ConnectPage, { onLoggedIn: () => undefined }));
  });
}

function unmount(): void {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
}

function q<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

function click(testId: string) {
  const node = q(testId);
  expect(node, testId).not.toBeNull();
  act(() => node!.click());
}

function fill(testId: string, value: string) {
  const node = q<HTMLInputElement>(testId);
  expect(node, testId).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function focused(): string | null {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

const emailValue = () => q<HTMLInputElement>("login-email")?.value;
const toggleOn = () => q("login-remember")?.getAttribute("aria-checked") === "true";
const stored = () => localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY);

function enterServer(base: string) {
  fill("connect-entry", base);
  click("connect-entry-submit");
}

async function signInWith(email: string, password = "pw-1234") {
  fill("login-email", email);
  fill("login-password", password);
  await act(async () => {
    click("login-submit");
  });
}

/** 로그아웃: 세션을 지우고 화면을 새로 연다. 다음 실행과 같다(저장된 서버로 바로 D1). */
function logoutAndReopen() {
  unmount();
  clearSession();
  mount();
}

describe("이메일 기억하기: 웹", () => {
  it("브라우저에서는 꺼진 채 시작하고, 꺼진 채로 로그인하면 아무것도 저장하지 않는다", async () => {
    mount();
    enterServer(SERVER_A);
    expect(q("login-remember-row")).not.toBeNull();
    expect(toggleOn()).toBe(false);
    await signInWith("me@example.com");
    expect(login).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
    logoutAndReopen();
    expect(emailValue()).toBe("");
  });

  it("켜고 로그인하면 로그아웃·재실행 뒤 같은 서버의 이메일 칸이 채워지고 커서는 비밀번호에 선다", async () => {
    mount();
    enterServer(SERVER_A);
    click("login-remember");
    expect(toggleOn()).toBe(true);
    await signInWith("  me@example.com ");
    expect(JSON.parse(stored()!).entries).toEqual([[SERVER_A, "me@example.com"]]);

    logoutAndReopen();
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(emailValue()).toBe("me@example.com");
    expect(toggleOn()).toBe(true);
    expect(focused()).toBe("login-password");
    // 비밀번호는 어디에도 남지 않는다.
    expect(stored()).not.toContain("pw-1234");
    expect(q<HTMLInputElement>("login-password")?.value).toBe("");
  });

  it("로그인에 실패하면 저장하지 않는다(오타는 남기지 않는다)", async () => {
    login.mockRejectedValueOnce(new ApiError(401, "invalid credentials"));
    mount();
    enterServer(SERVER_A);
    click("login-remember");
    await signInWith("typo@example.com");
    expect(q("login-password-error")).not.toBeNull();
    // 켠 선택은 적혀 있지만(재실행 뒤에도 켬) 이메일은 하나도 없다.
    expect(JSON.parse(stored()!)).toMatchObject({ enabled: true, entries: [] });
    expect(stored()).not.toContain("typo@example.com");
  });

  it("서버마다 따로다: 다른 서버의 칸에는 채우지 않고, 돌아오면 다시 채운다", async () => {
    mount();
    enterServer(SERVER_A);
    click("login-remember");
    await signInWith("a-user@example.com");

    logoutAndReopen();
    expect(emailValue()).toBe("a-user@example.com");
    click("connect-server-change");
    enterServer(SERVER_B);
    expect(emailValue()).toBe("");
    expect(focused()).toBe("login-email");
    click("onboarding-back");
    enterServer(SERVER_A);
    expect(emailValue()).toBe("a-user@example.com");
  });

  it("끄면 저장된 이메일이 그 자리에서 사라지고, 재실행 뒤에도 꺼져 있다", async () => {
    mount();
    enterServer(SERVER_A);
    click("login-remember");
    await signInWith("me@example.com");
    logoutAndReopen();
    expect(stored()).toContain("me@example.com");

    click("login-remember");
    expect(toggleOn()).toBe(false);
    // 저장소의 글자에서 사라졌다. 칸에 떠 있는 글자는 로그인 중인 사람의 것이라 그대로 둔다.
    expect(stored()).not.toContain("me@example.com");
    expect(emailValue()).toBe("me@example.com");

    logoutAndReopen();
    expect(emailValue()).toBe("");
    expect(toggleOn()).toBe(false);
  });

  it("비밀번호 모양·토큰 모양은 켜 둔 채 로그인해도 저장하지 않는다", async () => {
    const jwtLocal = "eyJfakehdr.eyJfakepld.fakesig@evil.example.com";
    for (const shaped of ["P@ssw0rd!", "Tr0ub4dor&3", jwtLocal]) {
      // 저장된 서버가 있으면 D0을 건너뛴다. 매 바퀴를 처음 켠 사람처럼 시작한다.
      setServerBase(null);
      mount();
      enterServer(SERVER_A);
      if (!toggleOn()) click("login-remember");
      await signInWith(shaped);
      const raw = stored() ?? "";
      expect(raw, shaped).not.toContain("ssw0rd");
      expect(raw, shaped).not.toContain("Tr0ub4dor");
      expect(raw, shaped).not.toContain("eyJ");
      unmount();
      clearSession();
    }
    setServerBase(SERVER_A);
    mount();
    expect(emailValue()).toBe("");
  });

  it("테스트 프리필 빌드는 기억한 이메일보다 프리필이 먼저이고, 서버를 바꿔도 덮지 않는다", () => {
    localStorage.setItem(
      REMEMBERED_LOGIN_STORAGE_KEY,
      JSON.stringify({ v: 1, enabled: true, entries: [[SERVER_A, "remembered@example.com"]] })
    );
    envSlot.devEmail = "dev@example.com";
    setServerBase(SERVER_A);
    mount();
    expect(emailValue()).toBe("dev@example.com");
    expect(focused()).toBe("login-password");
    click("connect-server-change");
    enterServer(SERVER_A);
    expect(emailValue()).toBe("dev@example.com");
  });
});
