// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import { ClaimPage } from "@/features/auth/ClaimPage";
import { rememberServerBeforeClaim, takeServerBeforeClaim } from "@/features/auth/claimHandoff";
import { releaseSessionRestore } from "@/features/auth/onboardingSessionHold";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { clearSession } from "@/lib/session";
import { getServerBase, setServerBase } from "@/lib/serverBase";

// =============================================================================
// claim 화면의 서버 확인 (ADR-0215 D8, 수용 9b, #4601). 데스크탑(Tauri)에는 주소창이 없다.
//
// `POST /v1/claim`은 **링크의 서버**로 새 비밀번호를 보낸다. 그래서 서버 호스트를 칩으로 보이고,
// 사용자가 확인하기 전에는 비밀번호 칸이 닫혀 있고, 요청이 가는 곳은 칩이 보인 그 호스트다. 가짜
// `fetch`로 실제 `claimOwnerPassword`를 돌려 「칩의 호스트 = 요청이 간 호스트」를 직접 잰다.
// `IS_TAURI`는 모듈 상수라 시험은 `isTauri` prop으로 셸을 흉내 낸다.
// =============================================================================

const TOKEN = "B".repeat(43);
const LINK_SERVER = "https://team.example.com";
const PREVIOUS = "https://previous.example.com";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let koLocale: AppLocale;
const replaceSpy = vi.fn<(href: string) => void>();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  koLocale = await koreanLocaleForTest();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setServerBase(null);
  clearSession();
  releaseSessionRestore();
  replaceSpy.mockReset();
  window.history.replaceState(null, "", `/claim/${TOKEN}`);
  // `openConnectScreen`은 `location.replace("/")`다. jsdom은 이동을 못 하므로 부름만 잰다.
  vi.stubGlobal("location", {
    pathname: `/claim/${TOKEN}`,
    origin: "http://localhost:3000",
    href: `http://localhost:3000/claim/${TOKEN}`,
    host: "localhost:3000",
    replace: (href: string) => replaceSpy(href),
  });
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
  setServerBase(null);
  clearSession();
  releaseSessionRestore();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function mount(isTauri: boolean): void {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    mountedRoot?.render(
      <LocaleProvider locale={koLocale}>
        {createElement(
          QueryClientProvider,
          { client },
          createElement(ClaimPage, { onLoggedIn: () => undefined, isTauri })
        )}
      </LocaleProvider>
    );
  });
}

const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

function fill(testId: string, value: string) {
  const node = q<HTMLInputElement>(testId)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("claim 화면의 서버 확인: 주소창이 없는 셸", () => {
  it("확인하기 전에는 비밀번호 칸이 닫혀 있고, 서버 호스트가 칩으로 보인다", () => {
    setServerBase(LINK_SERVER);
    mount(true);
    expect(q("claim-host-gate")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
    expect(q("claim-password")).toBeNull();
    expect(q("claim-confirm")).toBeNull();
    expect(q("claim-submit")).toBeNull();
    expect(document.activeElement).toBe(q("claim-host-gate"));
  });

  it("확인하면 칸이 열리고 칩은 그대로 남는다", () => {
    setServerBase(LINK_SERVER);
    mount(true);
    act(() => q<HTMLButtonElement>("claim-host-confirm")!.click());
    expect(q("claim-host-gate")).toBeNull();
    expect(q("claim-password")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
  });

  it("요청은 칩이 보인 그 호스트로 간다", async () => {
    setServerBase(LINK_SERVER);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ error: { message: "used" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      })
    );
    mount(true);
    const chipHost = q("connect-server-chip-host")!.textContent;
    act(() => q<HTMLButtonElement>("claim-host-confirm")!.click());
    fill("claim-password", "correct-horse-battery");
    fill("claim-confirm", "correct-horse-battery");
    await act(async () => {
      q<HTMLButtonElement>("claim-submit")!.click();
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(new URL(calls[0]!).host).toBe(chipHost);
    expect(calls[0]).toBe(`${LINK_SERVER}/v1/claim`);
  });

  it("「아니에요」는 링크가 저장한 서버를 전의 선택으로 되돌리고 로그인 화면으로 간다", () => {
    setServerBase(PREVIOUS);
    // 링크가 서버를 바꾸기 직전의 선택을 적어 두고, 그다음 링크의 서버를 저장한다(D0 핸드오프와 같은 순서).
    rememberServerBeforeClaim(getServerBase());
    setServerBase("https://evil.example");
    mount(true);
    expect(q("connect-server-chip-host")?.textContent).toBe("evil.example");
    act(() => q<HTMLButtonElement>("claim-host-reject")!.click());
    expect(getServerBase()).toBe(PREVIOUS);
    expect(replaceSpy).toHaveBeenCalledWith("/");
    expect(q("claim-password")).toBeNull();
  });

  it("전의 선택이 적혀 있지 않으면 거절은 저장된 서버를 비운다", () => {
    setServerBase("https://evil.example");
    mount(true);
    act(() => q<HTMLButtonElement>("claim-host-reject")!.click());
    expect(getServerBase()).toBeNull();
    expect(replaceSpy).toHaveBeenCalledWith("/");
  });

  it("주소창이 있는 브라우저에는 단계도 칩도 없다", () => {
    mount(false);
    expect(q("claim-host-gate")).toBeNull();
    expect(q("connect-server-chip-host")).toBeNull();
    expect(q("claim-password")).not.toBeNull();
  });
});

describe("링크가 바꾸기 전의 서버 선택", () => {
  it("적은 선택을 한 번만 꺼낸다 (서버가 없던 기기는 null)", () => {
    rememberServerBeforeClaim(PREVIOUS);
    expect(takeServerBeforeClaim()).toEqual({ found: true, base: PREVIOUS });
    expect(takeServerBeforeClaim()).toEqual({ found: false });
    rememberServerBeforeClaim(null);
    expect(takeServerBeforeClaim()).toEqual({ found: true, base: null });
  });

  it("읽을 수 없거나 서버 주소가 아닌 값은 믿지 않는다", () => {
    for (const raw of ["not json", JSON.stringify({ base: 7 }), JSON.stringify({ base: "ftp://x.example" }), "null"]) {
      sessionStorage.setItem("momo.claim.serverBeforeLink.v1", raw);
      expect(takeServerBeforeClaim()).toEqual({ found: false });
    }
  });
});
