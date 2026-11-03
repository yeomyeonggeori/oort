// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ClaimApiError, type ClaimedSession } from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { ClaimPage } from "@/features/auth/ClaimPage";
import { releaseSessionRestore } from "@/features/auth/onboardingSessionHold";
import { clearAllFirstAgentMarkers } from "@/features/welcome/firstAgentStore";
import { clearFreshSignup, peekFreshSignup } from "@/features/welcome/freshSignup";
import { resetKickoffHoldForTests } from "@/features/welcome/firstRunGate";
import { clearPhoneLinkCardForTests } from "@/features/welcome/phoneLinkCardStore";
import {
  clearOwnerOnboardingPending,
  ownerOnboardingIsPending,
  resetOwnerOnboardingLoadState,
} from "@/features/onboarding/ownerOnboardingStore";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// =============================================================================
// claim 화면: 링크의 종류(`claimKind`, ADR-0215 D6)가 갈리는 곳 (#4601).
//
// 종류는 응답을 받은 뒤에야 안다. 그래서 갈리는 것은 둘이다: **성공 뒤에 어디로 가나**(재설정 링크는
// 소유자 온보딩도 첫 실행 표지도 없이 앱으로 들어간다)와 **막힌 링크의 안내**(409·410이 종류별이다).
// 종류를 말하지 않는 서버는 예전 그대로 소유자 경로라서 기존 시험(`ClaimPage.claimToS2`)이 그것을 잰다.
// 한국어 사전을 실제로 올려 사람이 읽는 문장 그대로 단정한다.
// =============================================================================

const claimOwnerPassword = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    claimOwnerPassword: (...args: unknown[]) => claimOwnerPassword(...args) as Promise<ClaimedSession>,
  };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args) as Promise<WorkspaceIdentity> };
});

const TOKEN = "A".repeat(43);
const PASSWORD = "correct-horse-battery-staple";
const WS = "00000000-0000-7000-8000-000000000001";

const session: ClaimedSession = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: WS,
    kind: "human",
    displayName: "김인턴",
    handle: "intern-kim",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let koLocale: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  koLocale = await koreanLocaleForTest();
});

function resetState() {
  sessionStorage.clear();
  clearPhoneLinkCardForTests(WS);
  clearAllFirstAgentMarkers();
  clearFreshSignup();
  clearOwnerOnboardingPending();
  resetOwnerOnboardingLoadState();
  resetKickoffHoldForTests();
  releaseSessionRestore();
}

beforeEach(() => {
  resetState();
  claimOwnerPassword.mockReset();
  fetchWorkspace.mockReset();
  fetchWorkspace.mockResolvedValue({
    id: WS,
    slug: "demo",
    name: "momo Demo Workspace",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
  });
  window.history.replaceState(null, "", `/claim/${TOKEN}`);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  resetState();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function mount(onLoggedIn: (s: ClaimedSession) => void = () => undefined): void {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    mountedRoot?.render(
      <LocaleProvider locale={koLocale}>
        {createElement(QueryClientProvider, { client }, createElement(ClaimPage, { onLoggedIn }))}
      </LocaleProvider>
    );
  });
}

const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

function fill(testId: string, value: string) {
  const node = q<HTMLInputElement>(testId);
  expect(node, testId).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitClaim(password = PASSWORD) {
  fill("claim-password", password);
  fill("claim-confirm", password);
  await act(async () => {
    q<HTMLButtonElement>("claim-submit")!.click();
  });
}

describe("claim 성공 뒤: 링크 종류가 가는 곳을 가른다", () => {
  it("재설정 링크는 소유자 온보딩도 첫 실행 표지도 없이 앱으로 들어간다", async () => {
    claimOwnerPassword.mockResolvedValue({ ...session, claimKind: "password_reset" });
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    await submitClaim();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(claimOwnerPassword).toHaveBeenCalledWith(TOKEN, PASSWORD);
    expect(onLoggedIn.mock.calls[0]?.[0].member.id).toBe(session.member.id);
    // 이미 있는 멤버의 비밀번호다: 첫 주인의 표지도, 소유자 온보딩 대기도 없다.
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(peekFreshSignup()).toBeNull();
    // 소유자 온보딩의 첫 칸(S1)이 뜨지 않는다. 화면을 내리는 것은 부모(App)의 일이다.
    expect(q("onboarding-s1-submit")).toBeNull();
    // 링크 주소는 주소창에서 지운다(재설정 토큰이 기록에 남지 않는다).
    expect(window.location.pathname).toBe("/");
  });

  it("첫 주인 링크는 소유자 온보딩으로 간다 (종류가 owner_bootstrap일 때도)", async () => {
    claimOwnerPassword.mockResolvedValue({ ...session, claimKind: "owner_bootstrap" });
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    await submitClaim();
    await vi.waitFor(() => expect(ownerOnboardingIsPending()).toBe(true));
    // 재설정 경로가 「없다」고 말하는 그 요소가 이 경로에서는 실제로 선다(부정 단정이 빈 말이 아니다).
    await vi.waitFor(() => expect(q("onboarding-s1-submit")).not.toBeNull());
    // 온보딩이 끝나기 전에는 앱으로 들여보내지 않는다.
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(peekFreshSignup()).not.toBeNull();
  });
});

describe("claim 실패: 막힌 링크의 안내가 종류별이다", () => {
  const refuse = (status: number, kind?: "owner_bootstrap" | "password_reset") =>
    kind === undefined
      ? new ApiError(status, "refused")
      : new ClaimApiError(new ApiError(status, "refused"), kind);

  it("만료된 재설정 링크(410)는 관리자에게 새 링크를 요청하라고 한다", async () => {
    claimOwnerPassword.mockRejectedValue(refuse(410, "password_reset"));
    mount();
    await submitClaim();
    await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
    const text = q("claim-error")!.textContent ?? "";
    expect(text).toContain("24시간이 지나 만료되었습니다. 관리자에게 새 링크를 요청하세요.");
    expect(text).not.toContain("설치를 실행한");
  });

  it("만료된 첫 주인 링크(410)와 종류를 모르는 410은 설치한 쪽에 요청하라고 한다", async () => {
    for (const error of [refuse(410, "owner_bootstrap"), refuse(410)]) {
      claimOwnerPassword.mockRejectedValue(error);
      mount();
      await submitClaim();
      await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
      expect(q("claim-error")!.textContent).toContain("설치를 실행한 쪽에 새 링크를 요청하세요");
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      mountedHost?.remove();
      mountedHost = null;
    }
  });

  it("이미 쓴 재설정 링크(409)는 로그인하거나 새 링크를 요청하라고 한다", async () => {
    claimOwnerPassword.mockRejectedValue(refuse(409, "password_reset"));
    mount();
    await submitClaim();
    await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
    const text = q("claim-error")!.textContent ?? "";
    expect(text).toContain("이미 사용되었거나 새 링크로 바뀌었습니다");
    expect(text).toContain("로그인하세요");
    expect(text).toContain("관리자에게 새 링크를 요청하세요");
  });
});

describe("claim 입력칸: 규칙 안내와 오류 연결 (E-1 이월)", () => {
  it("새 비밀번호 칸 밑에 규칙을 미리 말한다 (10자·72바이트·한글 24자)", () => {
    mount();
    const hint = q("claim-password-hint")!.textContent ?? "";
    expect(hint).toContain("10자 이상");
    expect(hint).toContain("72바이트 이하");
    expect(hint).toContain("한글만이면 24자");
    expect(q("claim-password")!.getAttribute("aria-describedby")).toBe("claim-password-hint");
  });

  it("규칙을 어긴 400은 그 칸에 연결되고, 칸을 고치기 시작하면 사라진다", async () => {
    claimOwnerPassword.mockRejectedValue(new ApiError(400, "short", "password_too_short"));
    mount();
    await submitClaim("short");
    await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
    const field = q<HTMLInputElement>("claim-password")!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("claim-password-hint claim-error-text");
    expect(document.getElementById("claim-error-text")?.textContent).toContain("10자 이상");

    fill("claim-password", "short2");
    expect(q("claim-error")).toBeNull();
    expect(q<HTMLInputElement>("claim-password")!.getAttribute("aria-invalid")).toBeNull();
  });

  it("너무 잦은 요청(429)은 비밀번호를 탓하지 않고, 고쳐도 남는다", async () => {
    claimOwnerPassword.mockRejectedValue(new ApiError(429, "slow"));
    mount();
    await submitClaim();
    await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
    expect(q<HTMLInputElement>("claim-password")!.getAttribute("aria-invalid")).toBeNull();
    fill("claim-password", `${PASSWORD}!`);
    expect(q("claim-error")).not.toBeNull();
  });

  it("NUL 문자(password_invalid_char)는 전용 문장으로 말한다", async () => {
    claimOwnerPassword.mockRejectedValue(new ApiError(400, "NUL", "password_invalid_char"));
    mount();
    await submitClaim();
    await vi.waitFor(() => expect(q("claim-error")).not.toBeNull());
    expect(q("claim-error")!.textContent).toContain("비밀번호에 사용할 수 없는 문자가 들어 있습니다.");
  });
});
