// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoginResponse, type RosterMember } from "@momo/core/lib/api";
import { setServerBase } from "@/lib/serverBase";
import { clearSession } from "@/lib/session";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { clearRecentServers } from "@/features/auth/recentServers";
import { REMEMBERED_LOGIN_STORAGE_KEY } from "@/features/auth/rememberedLogin";
import { releaseSessionRestore } from "@/features/auth/onboardingSessionHold";
import { classifyEntry } from "@/features/auth/entryInput";
import { ENTRY_KIND_CLAIM, ENTRY_KIND_EMPTY } from "@momo/core/features/auth/passwordHelp";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// =============================================================================
// 로그인 화면의 「비밀번호를 잊으셨나요?」 안내 (ADR-0215 D5, 수용 3·12b, #4601).
//
// 이 화면은 **서버를 부르지 않는다**: 열고 닫는 동안 네트워크 호출이 0건이고, 로그인 전에는 알 수
// 없는 멤버·관리자 이름을 어디에도 그리지 않는다(명단 호출이 없다). 복사하는 문구에는 입력해 둔
// 이메일과 서버 호스트만 들어간다(비밀번호는 문구로 갈 길이 없다). 링크 입구는 D0의 한 칸과 같은
// 판별 함수를 쓴다.
// =============================================================================

const login = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());
const navigateTo = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    login: (...args: unknown[]) => login(...args) as Promise<LoginResponse>,
    fetchRoster: (...args: unknown[]) => fetchRoster(...args) as Promise<RosterMember[]>,
  };
});
vi.mock("@/features/auth/claimHandoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/claimHandoff")>();
  return { ...actual, navigateTo: (href: string) => navigateTo(href) };
});
vi.mock("@/features/auth/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/discovery")>();
  return { ...actual, useDiscovery: () => ({ servers: [], available: false, searching: false }) };
});

const SERVER = "https://team.example.com";
const TOKEN = "C".repeat(43);
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let koLocale: AppLocale;
let fetchSpy: ReturnType<typeof vi.fn>;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  koLocale = await koreanLocaleForTest();
});

beforeEach(() => {
  login.mockReset();
  fetchRoster.mockReset();
  navigateTo.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  // 이 화면 안에서 나가는 모든 `fetch`를 센다(명단 호출은 따로 `fetchRoster`로 센다).
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  releaseSessionRestore();
  clearSession();
  setServerBase(SERVER);
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
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
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
    mountedRoot?.render(
      <LocaleProvider locale={koLocale}>
        {createElement(ConnectPage, { onLoggedIn: () => undefined })}
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

const click = (testId: string) => {
  const node = q(testId);
  expect(node, testId).not.toBeNull();
  act(() => node!.click());
};

function openHelp() {
  click("login-forgot");
  expect(q("onboarding-password-help")).not.toBeNull();
}

describe("로그인 화면의 「비밀번호를 잊으셨나요?」", () => {
  it("비밀번호 칸 아래에 서고, 누르면 로그인 폼 대신 안내가 선다", () => {
    mount();
    const link = q("login-forgot");
    expect(link?.textContent).toBe("비밀번호를 잊으셨나요?");
    const password = q("login-password")!;
    // 비밀번호 칸 뒤, 들어가기 단추 앞에 선다(Tab 순서도 그 자리다).
    expect(password.compareDocumentPosition(link!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link!.compareDocumentPosition(q("login-submit")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    openHelp();
    expect(q("login-submit")).toBeNull();
    expect(q("password-help-title")?.textContent).toBe("비밀번호를 잊어도 괜찮아요.");
    expect(q("password-help-title")?.tagName).toBe("H1");
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
  });

  it("열고 닫는 동안 네트워크 호출이 0건이고 명단도 부르지 않는다 (수용 3)", () => {
    fetchRoster.mockResolvedValue([
      { id: "owner-1", displayName: "데모 소유자", handle: "demo-owner", role: "owner" },
      { id: "admin-1", displayName: "정관리", handle: "jung-admin", role: "admin" },
    ]);
    mount();
    const before = fetchSpy.mock.calls.length;
    openHelp();
    act(() => q<HTMLButtonElement>("password-help-copy")!.click());
    click("password-help-back");
    expect(q("login-submit")).not.toBeNull();
    openHelp();
    expect(fetchSpy.mock.calls.length - before).toBe(0);
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    // 로그인 전에는 알 수 없는 사람의 이름을 그리지 않는다.
    const text = document.body.textContent ?? "";
    for (const name of ["데모 소유자", "demo-owner", "정관리", "jung-admin"]) {
      expect(text).not.toContain(name);
    }
  });

  it("「서버를 직접 운영한다면」 항목은 E-6이 머지되기 전에는 없다 (수용 12b)", () => {
    mount();
    openHelp();
    expect(q("password-help-operator")).toBeNull();
    expect(document.body.textContent).not.toContain("직접 운영");
    // 서명 재설정(D7)이 아직 없으므로 가리킬 화면이 없는 「로그인된 기기」 항목도 없다.
    expect(document.body.textContent).not.toContain("로그인된 기기");
  });

  it("요청 문구는 서버 호스트와 입력해 둔 이메일만 담고, 비밀번호는 담지 않는다", () => {
    mount();
    fill("login-email", "ada@team.example.com");
    fill("login-password", "my-secret-Pass-1");
    openHelp();
    const text = q("password-help-request")!.textContent ?? "";
    expect(text).toBe(
      "oort 비밀번호를 잊어서 재설정 링크가 필요해요. 서버: team.example.com, 이메일: ada@team.example.com"
    );
    expect(text).not.toContain("my-secret-Pass-1");
    expect(document.body.textContent).not.toContain("my-secret-Pass-1");
    act(() => q<HTMLButtonElement>("password-help-copy")!.click());
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("이메일을 아직 안 넣었으면 서버만 담는다", () => {
    mount();
    openHelp();
    expect(q("password-help-request")!.textContent).toBe(
      "oort 비밀번호를 잊어서 재설정 링크가 필요해요. 서버: team.example.com"
    );
  });

  it("뒤로 가면 로그인 폼으로 돌아오고 초점은 「잊으셨나요?」로 돌아온다. 입력한 이메일은 남는다", async () => {
    mount();
    fill("login-email", "ada@team.example.com");
    openHelp();
    click("password-help-back");
    expect(q("onboarding-password-help")).toBeNull();
    expect(q<HTMLInputElement>("login-email")!.value).toBe("ada@team.example.com");
    await vi.waitFor(() => expect(document.activeElement).toBe(q("login-forgot")));
  });

  it("머리 줄의 「뒤로」는 안내를 먼저 닫는다(첫 화면으로 나가지 않는다)", () => {
    mount();
    openHelp();
    click("onboarding-back");
    expect(q("onboarding-password-help")).toBeNull();
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("onboarding-welcome")).toBeNull();
  });
});

describe("「링크를 받았어요」 입구: D0의 한 칸과 같은 판별", () => {
  it("화면이 읽는 판정 이름은 실제 판별 함수가 돌려주는 이름과 같다 (두 번째 파서가 아니다)", () => {
    expect(classifyEntry(`${SERVER}/claim/${TOKEN}`).kind).toBe(ENTRY_KIND_CLAIM);
    expect(classifyEntry("   ").kind).toBe(ENTRY_KIND_EMPTY);
  });

  function paste(value: string) {
    fill("password-help-link", value);
    click("password-help-open");
  }

  it("다른 서버의 재설정 링크는 그 링크로 이동한다 (이 입구는 서버를 부르지 않는다)", () => {
    mount();
    openHelp();
    const before = fetchSpy.mock.calls.length;
    paste(`  ${SERVER}/claim/${TOKEN}  `);
    expect(navigateTo).toHaveBeenCalledWith(`${SERVER}/claim/${TOKEN}`);
    expect(fetchSpy.mock.calls.length - before).toBe(0);
    expect(q("password-help-link-error")).toBeNull();
  });

  it("이 페이지와 같은 출처의 링크는 이 페이지의 /claim 경로로 이동한다", () => {
    mount();
    openHelp();
    paste(`${window.location.origin}/claim/${TOKEN}`);
    expect(navigateTo).toHaveBeenCalledWith(`/claim/${TOKEN}`);
  });

  it("메신저에서 문단째 복사한 글에서도 링크를 찾는다", () => {
    mount();
    openHelp();
    paste(`관리자가 보냈어요: ${SERVER}/claim/${TOKEN} 오늘 안에 열어 주세요.`);
    expect(navigateTo).toHaveBeenCalledWith(`${SERVER}/claim/${TOKEN}`);
  });

  it("재설정 링크가 아닌 입력은 받지 않고 이유를 말한다", () => {
    mount();
    openHelp();
    for (const input of [SERVER, "team.example.com", `${SERVER}/?code=${"x".repeat(30)}`, `oort://claim/${TOKEN}`, `${SERVER}/claim/짧은`]) {
      paste(input);
      expect(q("password-help-link-error")?.textContent, input).toBe(
        "재설정 링크로 읽을 수 없습니다. 관리자가 보낸 링크를 그대로 붙여 넣으세요."
      );
      expect(q("password-help-link")?.getAttribute("aria-invalid")).toBe("true");
    }
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("빈 칸은 붙여 넣으라고 말한다", () => {
    mount();
    openHelp();
    click("password-help-open");
    expect(q("password-help-link-error")?.textContent).toBe("받은 링크를 붙여 넣으세요.");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("고치기 시작하면 오류가 걷힌다", () => {
    mount();
    openHelp();
    click("password-help-open");
    expect(q("password-help-link-error")).not.toBeNull();
    fill("password-help-link", SERVER);
    expect(q("password-help-link-error")).toBeNull();
  });
});
