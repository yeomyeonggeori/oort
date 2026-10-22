// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import { clearPhoneLinkCardForTests } from "@/features/welcome/phoneLinkCardStore";

// GitHub 앱 만들기의 브라우저 쪽 두 문(#4220)이 App 에서 제자리에 서는가:
//   1) `/github/handoff#…` 는 세션과 무관한 공개 페이지다(HashRouter 밖의 실경로).
//   2) 로그인 안 된 브라우저가 `?githubApp=`·`?githubInstall=` 로 돌아오면 결과 한 문장이다.
//   3) 로그인된 브라우저는 지금처럼 GitHub 알림 화면으로 간다(웹 동작은 그대로다).

const restoreSession = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
  };
});

vi.mock("@/features/chat/ChatShell", () => ({
  ChatShell: () => createElement("div", { "data-testid": "channel-list" }, "shell"),
}));

vi.mock("@/app/AppShell", async () => {
  const { createElement: h } = await import("react");
  const { Outlet } = await import("react-router-dom");
  return {
    AppShell: () => h("div", { "data-testid": "app-shell" }, h(Outlet)),
  };
});

vi.mock("@/features/aiHub/AiHubRoute", async () => {
  const { createElement: h } = await import("react");
  const { useLocation } = await import("react-router-dom");
  return {
    AiHubRoute: () => {
      const location = useLocation();
      const returned = (location.state as { githubReturn?: { word: string } } | null)?.githubReturn;
      return h(
        "div",
        { "data-testid": "ai-hub-route-stub", "data-return-word": returned?.word ?? "" },
        location.pathname
      );
    },
  };
});

// 로그인 화면(ConnectPage)이 업데이트 알림 훅을 읽으므로 감시 시작만 막고 나머지는 실물을 쓴다.
vi.mock("@/features/updates/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/updates/store")>();
  return { ...actual, startUpdateWatch: () => () => undefined };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

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

const STATE = `00000000-0000-7000-8000-000000000001.${"5d0e".repeat(16)}`;
const ORG_URL = `https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=${STATE}`;
const submitted: string[] = [];

function handoffHash(): string {
  const origin = window.location.origin;
  const payload = {
    v: 1,
    u: ORG_URL,
    m: {
      name: "oort-test",
      url: origin,
      redirect_url: `${origin}/v1/integrations/github/app/callback`,
      hook_attributes: { url: `${origin}/v1/integrations/github/webhook`, active: true },
      setup_url: `${origin}/v1/integrations/github/setup`,
    },
    e: 3600,
  };
  return `#${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // 첫 마운트가 `./App` 모듈 그래프 전체를 읽는다(콜드 임포트, App.aiHub.test 와 같은 까닭).
  await import("./App");
}, 60_000);

beforeEach(() => {
  submitted.length = 0;
  sessionStorage.clear();
  clearPhoneLinkCardForTests(session.member.workspaceId);
  clearSession();
  restoreSession.mockReset();
  restoreSession.mockResolvedValue(session);
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push(this.getAttribute("action") ?? "");
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  sessionStorage.clear();
  clearPhoneLinkCardForTests(session.member.workspaceId);
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountApp(): Promise<HTMLElement> {
  const { App } = await import("./App");
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
  });
  return host;
}

const at = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("App: GitHub 앱 만들기 핸드오프 경로 (#4220)", { timeout: 20_000 }, () => {
  it("/github/handoff 는 로그인 없이 공개 페이지를 세우고 조각을 지운다", async () => {
    window.history.replaceState(null, "", `/github/handoff${handoffHash()}`);
    const host = await mountApp();
    expect(at(host, "github-handoff-page")).not.toBeNull();
    expect(at(host, "onboarding-welcome")).toBeNull();
    expect(at(host, "github-handoff-title")?.textContent).toBe("GitHub 앱 만들기 화면으로 이동해요.");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/github/handoff");
    // 자동 제출은 한 번, 등록 주소로.
    expect(submitted).toEqual([ORG_URL]);
  });

  it("이 브라우저에 세션이 있어도 같은 공개 페이지다(세션을 기다리지 않는다)", async () => {
    applyLogin(session);
    window.history.replaceState(null, "", `/github/handoff${handoffHash()}`);
    const host = await mountApp();
    expect(at(host, "github-handoff-page")).not.toBeNull();
    expect(at(host, "app-shell")).toBeNull();
    expect(submitted).toEqual([ORG_URL]);
  });

  it("조각이 없으면 폼 없이 「한 번만 열 수 있어요」", async () => {
    window.history.replaceState(null, "", "/github/handoff");
    const host = await mountApp();
    expect(at(host, "github-handoff-title")?.textContent).toBe("이 주소는 한 번만 열 수 있어요.");
    expect(at(host, "github-handoff-form")).toBeNull();
    expect(submitted).toEqual([]);
  });
});

describe("App: 로그인 안 된 브라우저의 GitHub 착지 (#4220)", { timeout: 20_000 }, () => {
  it("?githubApp=created 는 로그인 화면 대신 결과 문장과 「oort 앱으로 돌아가세요」다", async () => {
    window.history.replaceState(null, "", "/?githubApp=created");
    const host = await mountApp();
    expect(at(host, "github-public-return")).not.toBeNull();
    expect(at(host, "onboarding-welcome")).toBeNull();
    expect(at(host, "github-public-return-title")?.textContent).toContain("GitHub 앱을 만들었어요.");
    expect(at(host, "github-public-return-back")?.textContent).toBe("oort 앱으로 돌아가세요.");
    expect(window.location.search).toBe("");
  });

  it("?githubInstall=linked_elsewhere 도 같다(막힌 단어)", async () => {
    window.history.replaceState(null, "", "/?githubInstall=linked_elsewhere");
    const host = await mountApp();
    expect(at(host, "github-public-return-body")?.getAttribute("data-return-tone")).toBe("stop");
  });

  it("다시 그려져도 문장이 사라지지 않는다(읽은 단어를 붙든다)", async () => {
    window.history.replaceState(null, "", "/?githubApp=created");
    const host = await mountApp();
    await act(async () => {
      window.dispatchEvent(new Event("hashchange"));
      window.dispatchEvent(new Event("popstate"));
    });
    expect(window.location.search).toBe("");
    expect(at(host, "github-public-return")).not.toBeNull();
  });

  it("모르는 단어와 단어 없는 주소는 지금처럼 로그인 화면이다", async () => {
    window.history.replaceState(null, "", "/?githubApp=%3Cscript%3E");
    const host = await mountApp();
    expect(at(host, "github-public-return")).toBeNull();
    expect(at(host, "onboarding-welcome")).not.toBeNull();
    expect(window.location.search).toBe("?githubApp=%3Cscript%3E");
  });

  it("단어 없는 첫 화면은 그대로 로그인 화면이다", async () => {
    const host = await mountApp();
    expect(at(host, "github-public-return")).toBeNull();
    expect(at(host, "onboarding-welcome")).not.toBeNull();
  });

  it("로그인된 브라우저는 지금처럼 GitHub 알림 화면으로 가고 공개 착지를 거치지 않는다", async () => {
    applyLogin(session);
    window.history.replaceState(null, "", "/?githubApp=created");
    const host = await mountApp();
    await vi.waitFor(() => {
      expect(at(host, "ai-hub-route-stub")?.textContent).toBe("/ai/external/github");
    });
    // 단어는 라우터 상태로 넘어가고 주소에서는 지워진다(GithubReturnLanding 그대로).
    expect(at(host, "ai-hub-route-stub")?.getAttribute("data-return-word")).toBe("created");
    expect(at(host, "github-public-return")).toBeNull();
    expect(window.location.search).toBe("");
  });
});
