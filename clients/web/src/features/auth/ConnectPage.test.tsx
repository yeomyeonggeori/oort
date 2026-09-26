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
import { firstAgentIsPending } from "@/features/welcome/firstAgentStore";
import { releaseSessionRestore, holdSessionRestore, sessionRestoreHeld } from "./onboardingSessionHold";

const FRESH_SIGNUP_SLOT = "oort.freshSignup.v1";

const login = vi.hoisted(() => vi.fn());
const joinWithInvite = vi.hoisted(() => vi.fn());
const changeMyDisplayName = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());
const navigateTo = vi.hoisted(() => vi.fn());
const restoreSession = vi.hoisted(() => vi.fn());
const releaseSessionRestoreMock = vi.hoisted(() => vi.fn());
const discoveryMock = vi.hoisted(() =>
  vi.fn(
    (): {
      servers: { base: string; displayHost: string }[];
      available: boolean;
      searching: boolean;
    } => ({ servers: [], available: false, searching: false })
  )
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
    fetchRoster: (...args: unknown[]) => fetchRoster(...args) as Promise<unknown[]>,
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
    useDiscovery: () => discoveryMock(),
  };
});

vi.mock("./claimHandoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claimHandoff")>();
  return { ...actual, navigateTo: (href: string) => navigateTo(href) };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let reducedMotion = false;
let online = true;

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
  reducedMotion = false;
  login.mockReset();
  joinWithInvite.mockReset();
  changeMyDisplayName.mockReset();
  fetchRoster.mockReset();
  fetchRoster.mockResolvedValue([]);
  navigateTo.mockReset();
  online = true;
  restoreSession.mockReset();
  login.mockResolvedValue(session);
  joinWithInvite.mockResolvedValue({ ...session, createdMember: true });
  restoreSession.mockResolvedValue(session);
  discoveryMock.mockReturnValue({ servers: [], available: false, searching: false });
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
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
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

const CODE = "Ab3-_xYz0123456789abcdefghij01";
const INVITE_LINK = `oort://join?server=https%3A%2F%2Fteam.example.com&code=${CODE}`;
const CLAIM_TOKEN = "A".repeat(20) + "b-_" + "9".repeat(20);

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function focused(): string | null {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

function guideLine(): string | undefined {
  return q("kometto-guide-line")?.textContent ?? undefined;
}

/** 말풍선을 든 안내자(D1·D1′) 또는 D0 말풍선의 표정. */
function guideExpression(): string | null {
  return (
    q("kometto-guide")?.getAttribute("data-expression") ??
    q("kometto-guide-bubble")?.getAttribute("data-expression") ??
    null
  );
}

function submitEntry(value: string) {
  fill("connect-entry", value);
  click("connect-entry-submit");
}

async function submitForm() {
  await act(async () => {
    click("login-submit");
  });
}

/**
 * 필수 입력 화면 세기 (#2809·#2810 시험). 온보딩 화면(`data-onboarding-screen`) 중
 * 사람이 채우는 칸(`input`)이 있는 화면을, 마운트부터 앱으로 들어갈 때까지 센다.
 */
function watchInputScreens(): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const record = () => {
    for (const node of document.querySelectorAll("[data-onboarding-screen]")) {
      const id = node.getAttribute("data-onboarding-screen") ?? "";
      const fields = node.querySelectorAll("input:not([type=hidden])").length;
      if (fields > 0 && seen[seen.length - 1] !== id) seen.push(id);
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { childList: true, subtree: true });
  record();
  return { seen, stop: () => observer.disconnect() };
}

describe("D0 환영 (#2808 OB2-2)", () => {
  it("asks one question over the hero, with no dots and no 뒤로", () => {
    mount();
    expect(q("onboarding-welcome")).not.toBeNull();
    expect(q("onboarding-frame")).not.toBeNull();
    expect(q("onboarding-dots")).toBeNull();
    expect(q("onboarding-back")).toBeNull();
    expect(q("kometto-face")?.getAttribute("data-size")).toBe("hero");
    const line = q("kometto-guide-line");
    expect(line?.tagName).toBe("H1");
    expect(line?.textContent).toBe("안녕하세요, 저는 코메토예요. 어디로 갈까요?");
    expect(guideExpression()).toBe("idle");
    expect((q("connect-entry") as HTMLInputElement).placeholder).toBe(
      "https://team.example.com 또는 초대 링크"
    );
    expect(focused()).toBe("connect-entry");
    // 옛 S0 두 갈래는 사라졌다.
    expect(q("onboarding-choose-server")).toBeNull();
    expect(q("onboarding-choose-invite")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\/\d/);
  });

  it("sends a team address to D1 with the server chip and one dot", () => {
    mount();
    submitEntry("  Team.Example.com:28000/ ");
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com:28000");
    expect(q("onboarding-dots")?.getAttribute("data-total")).toBe("1");
    expect(q("onboarding-dots-label")?.textContent).toBe("1단계 중 1단계");
    expect(focused()).toBe("login-email");
    expect(localStorage.getItem("momo.web.server.v1")).toBe("https://team.example.com:28000");
  });

  it("sends an invite link to D1′ with server and code filled and no field for either", () => {
    mount();
    submitEntry(`초대 링크입니다\n${INVITE_LINK}\n`);
    expect(q("onboarding-join")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
    expect(q("onboarding-dots")?.getAttribute("data-total")).toBe("2");
    expect(q("onboarding-dots")?.getAttribute("data-current")).toBe("1");
    const values = [...document.querySelectorAll("input")].map((i) => i.value);
    expect(values).not.toContain(CODE);
    expect(values).not.toContain("https://team.example.com");
    expect(focused()).toBe("login-email");
  });

  it("hands a claim link to the claim screen (#2811 path) without keeping the token", () => {
    mount();
    submitEntry(`${window.location.origin}/claim/${CLAIM_TOKEN}`);
    expect(navigateTo).toHaveBeenCalledTimes(1);
    expect(navigateTo).toHaveBeenCalledWith(`/claim/${CLAIM_TOKEN}`);
    expect(JSON.stringify(localStorage)).not.toContain(CLAIM_TOKEN);
    expect(JSON.stringify(sessionStorage)).not.toContain(CLAIM_TOKEN);
  });

  it("opens another server's claim page on that server", () => {
    mount();
    submitEntry(`https://other.example.com/claim/${CLAIM_TOKEN}`);
    expect(navigateTo).toHaveBeenCalledWith(`https://other.example.com/claim/${CLAIM_TOKEN}`);
  });

  it("answers anything else with 당황 코메토 and a 합니다체 error that says what to do", () => {
    mount();
    submitEntry("hello");
    expect(q("onboarding-welcome")).not.toBeNull();
    expect(guideExpression()).toBe("flustered");
    expect(guideLine()).toBe("그 주소로는 길을 못 찾았어요.");
    const error = q("connect-entry-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toMatch(/붙여 넣으세요/);
    expect(q("connect-entry")?.getAttribute("aria-invalid")).toBe("true");
    expect(q("connect-entry")?.getAttribute("aria-describedby")).toBe("connect-entry-error");
    fill("connect-entry", "team.example.com");
    expect(q("connect-entry-error")).toBeNull();
    expect(guideExpression()).toBe("idle");
    expect(guideLine()).toBe("안녕하세요, 저는 코메토예요. 어디로 갈까요?");
  });

  it("reads an empty box as this page's server on the web (old S1 same-origin rule)", () => {
    mount();
    click("connect-entry-submit");
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe(window.location.host);
    expect(localStorage.getItem("momo.web.server.v1")).toBeNull();
  });

  it("skips D0 when a server is stored", () => {
    setServerBase("https://team.example.com");
    mount();
    expect(q("onboarding-welcome")).toBeNull();
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
  });

  it("skips D0 when an invite link opened the page", () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mount();
    expect(q("onboarding-welcome")).toBeNull();
    expect(q("onboarding-join")).not.toBeNull();
    expect(
      document.querySelector("[data-onboarding-effect]")?.getAttribute("data-onboarding-effect")
    ).toBe("none");
    // 초대 코드는 주소창에서 걷힌다(bearer secret).
    expect(window.location.href).not.toContain(CODE);
  });

  it("offers servers found on this network and goes to D1 on 여기로", () => {
    discoveryMock.mockReturnValue({
      servers: [{ base: "http://192.168.0.7:28000", displayHost: "momo-mini.local:28000" }],
      available: true,
      searching: false,
    });
    mount();
    expect(q("connect-discovery")?.textContent).toContain("이 네트워크에서 찾은 서버");
    expect(q("connect-discovery-item")?.textContent).toContain("momo-mini.local:28000");
    click("connect-discovery-item-go");
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("connect-server-chip-host")?.textContent).toBe("192.168.0.7:28000");
  });

  it("says what to do when discovery found nothing, and says nothing before it has looked", () => {
    discoveryMock.mockReturnValue({ servers: [], available: true, searching: true });
    mount();
    expect(q("connect-discovery-empty")?.textContent).toBe(
      "이 네트워크에서 팀 서버를 찾고 있어요."
    );
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    discoveryMock.mockReturnValue({ servers: [], available: true, searching: false });
    mount();
    expect(q("connect-discovery-empty")?.textContent).toBe(
      "이 네트워크에서는 찾은 서버가 없어요. 팀 주소를 받았다면 위 칸에 붙여 넣어요."
    );
  });

  it("does not claim to have searched in a browser tab", () => {
    mount();
    expect(q("connect-discovery")).toBeNull();
  });

  it("lists recent servers and goes to D1 on 여기로", () => {
    localStorage.setItem(
      "momo.web.server.history.v1",
      JSON.stringify(["https://team.example.com"])
    );
    mount();
    expect(q("connect-recent-servers")?.textContent).toContain("최근에 들어간 서버");
    click("connect-recent-server-go");
    expect(q("connect-server-chip-host")?.textContent).toBe("team.example.com");
  });

  it("shows the self-host note with the claim section of the first-day doc", () => {
    mount();
    expect(q("connect-self-host")).toBeNull();
    click("connect-self-host-toggle");
    expect(q("connect-self-host-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(q("connect-self-host")?.textContent).toContain("claim 링크");
    expect(q("connect-self-host-doc")?.getAttribute("href")).toContain(
      "docs/SELF_HOST_FIRST_DAY.ko.md#"
    );
  });

  it("goes back from D1 to D0 with the server in the box", () => {
    mount();
    submitEntry("team.example.com");
    click("onboarding-back");
    expect(q("onboarding-welcome")).not.toBeNull();
    expect((q("connect-entry") as HTMLInputElement).value).toBe("https://team.example.com");
    expect(focused()).toBe("connect-entry");
    submitEntry("team.example.com");
    click("connect-server-change");
    expect(q("onboarding-welcome")).not.toBeNull();
  });
});

describe("D1 로그인 한 화면 (#2809 OB2-3)", () => {
  it("needs exactly one input screen when the server is stored", async () => {
    setServerBase("https://team.example.com");
    const watch = watchInputScreens();
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "correct-horse");
    await submitForm();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(session));
    watch.stop();
    expect(watch.seen).toEqual(["sign-in"]);
    expect(watch.seen).toHaveLength(1);
  });

  it("asks with 코메토 72 and the server chip, then signs in", async () => {
    setServerBase("https://team.example.com");
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    expect(q("kometto-guide")?.getAttribute("data-size")).toBe("head");
    expect(guideLine()).toBe("다시 왔군요. 이메일로 들어가요.");
    expect(guideExpression()).toBe("idle");
    expect(q("login-submit")?.textContent).toBe("들어가기");
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "correct-horse");
    await submitForm();
    await vi.waitFor(() => {
      expect(login).toHaveBeenCalledWith("seongjae@dawn.example", "correct-horse", "");
    });
    expect(onLoggedIn).toHaveBeenCalledWith(session);
    expect(joinWithInvite).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FRESH_SIGNUP_SLOT)).toBeNull();
  });

  it("thinks while it checks", async () => {
    setServerBase("https://team.example.com");
    let resolve: (value: LoginResponse) => void = () => undefined;
    login.mockImplementation(() => new Promise<LoginResponse>((r) => (resolve = r)));
    mount();
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "correct-horse");
    await submitForm();
    expect(guideExpression()).toBe("thinking");
    expect(guideLine()).toBe("들어갈 수 있는지 확인하고 있어요.");
    expect(q("login-submit")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve(session));
  });

  it("on a rejected sign-in: 당황, the error at the password field with the next step, and the password gone", async () => {
    setServerBase("https://team.example.com");
    login.mockRejectedValue(new ApiError(401, "invalid credentials"));
    const onLoggedIn = vi.fn();
    mount(onLoggedIn);
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "wrong-horse");
    await submitForm();
    await vi.waitFor(() => expect(q("login-password-error")).not.toBeNull());
    expect(guideExpression()).toBe("flustered");
    expect(guideLine()).toBe("들어가지 못했어요.");
    expect((q("login-password") as HTMLInputElement).value).toBe("");
    expect(focused()).toBe("login-password");
    const error = q("login-password-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toMatch(/다시 넣고/);
    expect(q("login-password")?.getAttribute("aria-describedby")).toBe("connect-password-error");
    expect(q("login-error")).toBeNull();
    expect(onLoggedIn).not.toHaveBeenCalled();
    fill("login-password", "x");
    expect(q("login-password-error")).toBeNull();
    expect(guideExpression()).toBe("idle");
  });

  it("says an empty field at that field instead of asking the server", async () => {
    setServerBase("https://team.example.com");
    mount();
    fill("login-password", "");
    fill("login-email", "");
    await submitForm();
    expect(q("login-email-error")?.textContent).toBe("이메일을 넣으세요.");
    expect(login).not.toHaveBeenCalled();
    fill("login-email", "seongjae@dawn.example");
    await submitForm();
    expect(q("login-password-error")?.textContent).toBe("비밀번호를 넣으세요.");
    expect(login).not.toHaveBeenCalled();
  });

  it("on a server that does not answer: 당황 and the password gone too", async () => {
    setServerBase("https://team.example.com");
    login.mockRejectedValue(new NetworkError("unreachable", 15_000));
    mount();
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "correct-horse");
    await submitForm();
    await vi.waitFor(() => expect(q("login-error")).not.toBeNull());
    expect(guideExpression()).toBe("flustered");
    expect((q("login-password") as HTMLInputElement).value).toBe("");
  });

  it("offline: 당황 with its own sentence, the banner, and a held submit", () => {
    setServerBase("https://team.example.com");
    mount();
    expect(guideExpression()).toBe("idle");
    act(() => {
      online = false;
      window.dispatchEvent(new Event("offline"));
    });
    expect(guideExpression()).toBe("flustered");
    expect(guideLine()).toBe("지금은 인터넷에 닿지 않아요.");
    expect(q("connect-offline")).not.toBeNull();
    expect((q("login-submit") as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      online = true;
      window.dispatchEvent(new Event("online"));
    });
    expect(guideExpression()).toBe("idle");
    expect(guideLine()).toBe("다시 왔군요. 이메일로 들어가요.");
  });

  it("keeps the workspace-ID escape hatch", () => {
    setServerBase("https://team.example.com");
    mount();
    click("login-workspace-toggle");
    expect(q("login-workspace")).not.toBeNull();
  });
});

async function joinFromLink(options: { name?: string } = {}) {
  window.history.replaceState(null, "", `/?code=${CODE}`);
  const onLoggedIn = vi.fn();
  mount(onLoggedIn);
  fill("login-email", "seongjae@dawn.example");
  fill("login-password", "new-pass");
  if (options.name !== undefined) fill("onboarding-profile-name", options.name);
  await submitForm();
  return onLoggedIn;
}

describe("D1′ 초대 수락 한 화면 (#2810 OB2-4)", () => {
  it("needs exactly one input screen when a link opened it", async () => {
    const watch = watchInputScreens();
    const onLoggedIn = await joinFromLink({ name: "성재" });
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "성재" });
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    watch.stop();
    expect(watch.seen).toEqual(["join"]);
  });

  it("greets with 기쁨 코메토 and asks email, new password and name on one screen", () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mount();
    expect(guideExpression()).toBe("happy");
    expect(guideLine()).toBe("초대를 받았어요.");
    expect(q("kometto-guide-detail")?.textContent).toBe("세 칸만 채우면 바로 들어가요.");
    expect(q("login-email")).not.toBeNull();
    expect(q("login-password")?.getAttribute("autocomplete")).toBe("new-password");
    expect(q("onboarding-profile-name")).not.toBeNull();
    expect(document.querySelector('label[for="onboarding-profile-name"]')?.textContent).toContain(
      "선택"
    );
    expect(q("login-submit")?.textContent).toBe("팀에 들어가기");
    expect(q("join-sign-in-link")).not.toBeNull();
  });

  it("joins, saves the name, and lands with the renamed member", async () => {
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "성재" });
    const onLoggedIn = await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(joinWithInvite).toHaveBeenCalledWith(CODE, "seongjae@dawn.example", "new-pass");
    expect(changeMyDisplayName).toHaveBeenCalledWith(session.member.workspaceId, "성재");
    expect(onLoggedIn.mock.calls[0]?.[0].member.displayName).toBe("성재");
  });

  it("joins without a PATCH when the name is left empty", async () => {
    const onLoggedIn = await joinFromLink();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(onLoggedIn).toHaveBeenCalledWith({ ...session, createdMember: true });
  });

  it("writes the fresh-signup marker at join success, once, before the name is saved", async () => {
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
    let patchedAfter = -1;
    changeMyDisplayName.mockImplementation(async () => {
      patchedAfter = writes.length;
      return { ...session.member, displayName: "성재" };
    });
    try {
      const onLoggedIn = await joinFromLink({ name: "성재" });
      await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
      expect(writes).toHaveLength(1);
      expect(patchedAfter).toBe(1);
      expect(JSON.parse(writes[0] ?? "null")).toEqual({
        workspaceId: session.member.workspaceId,
        memberId: session.member.id,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("goes straight to the first conversation when the team already has an active agent", async () => {
    fetchRoster.mockResolvedValue([
      { id: "a1", workspaceId: session.member.workspaceId, kind: "agent", status: "active", displayName: "김인턴", handle: "intern", channelCount: 1, channelIds: [], capabilities: [] },
    ]);
    const onLoggedIn = await joinFromLink();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(fetchRoster).toHaveBeenCalledWith(session.member.workspaceId);
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(false);
    expect(sessionStorage.getItem(PHONE_LINK_FIRST_RUN_KEY)).toBe("pending");
  });

  it("keeps AI 연결 when the team has no active agent, or when the directory did not answer", async () => {
    fetchRoster.mockResolvedValue([
      { id: "a1", workspaceId: session.member.workspaceId, kind: "agent", status: "suspended", displayName: "김인턴", handle: "intern", channelCount: 1, channelIds: [], capabilities: [] },
    ]);
    const onLoggedIn = await joinFromLink();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(true);

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    sessionStorage.clear();
    fetchRoster.mockRejectedValue(new NetworkError("unreachable", 15_000));
    const again = await joinFromLink();
    await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1));
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(true);
  });

  it("lands an existing member (createdMember false) without renaming", async () => {
    joinWithInvite.mockResolvedValue({ ...session, createdMember: false });
    const onLoggedIn = await joinFromLink({ name: "다른 이름" });
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FRESH_SIGNUP_SLOT)).toBeNull();
  });

  it("does not block the join on a name-save failure, and says where to change it", async () => {
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    const onLoggedIn = await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    expect(q("onboarding-profile-banner")?.textContent).toContain(
      "설정 › 프로필에서 언제든 바꿀 수 있어요"
    );
    expect(guideExpression()).toBe("flustered");
    expect(guideLine()).toBe("팀에는 들어왔는데 이름을 저장하지 못했어요.");
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(q("onboarding-back")).toBeNull();
    expect(q("join-sign-in-link")).toBeNull();
    expect((q("login-email") as HTMLInputElement).readOnly).toBe(true);
    expect(q("login-submit")?.textContent).toBe("계속");
    expect(focused()).toBe("onboarding-profile-name");
    await submitForm();
    expect(onLoggedIn).toHaveBeenCalledWith({ ...session, createdMember: true });
  });

  it("re-arms the save when the name is edited after a failure", async () => {
    changeMyDisplayName.mockRejectedValueOnce(new ApiError(500, "engine boom"));
    const onLoggedIn = await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "곽성재2" });
    fill("onboarding-profile-name", "곽성재2");
    expect(q("onboarding-profile-banner")).toBeNull();
    expect(q("login-submit")?.textContent).toBe("팀에 들어가기");
    await submitForm();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(changeMyDisplayName).toHaveBeenLastCalledWith(session.member.workspaceId, "곽성재2");
    expect(joinWithInvite).toHaveBeenCalledTimes(1);
  });

  it("다시 시도 re-sends the current name", async () => {
    changeMyDisplayName.mockRejectedValueOnce(new ApiError(500, "engine boom"));
    const onLoggedIn = await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "성재" });
    const retry = q("onboarding-profile-banner")?.querySelector("button") as HTMLButtonElement;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(changeMyDisplayName).toHaveBeenCalledTimes(2);
  });

  it("rejects a 101-character name before joining", async () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mount();
    fill("onboarding-profile-name", "가".repeat(101));
    expect(q("onboarding-profile-name-error")?.textContent).toBe(
      "표시 이름은 100자까지 쓸 수 있습니다."
    );
    expect((q("login-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(joinWithInvite).not.toHaveBeenCalled();
  });

  it("puts a code verdict in place, with 당황 and a way back to paste a new link", async () => {
    joinWithInvite.mockRejectedValue(new ApiError(404, "invite not found"));
    await joinFromLink();
    await vi.waitFor(() => expect(q("login-error")).not.toBeNull());
    expect(q("onboarding-join")).not.toBeNull();
    expect(guideExpression()).toBe("flustered");
    expect(guideLine()).toBe("초대로 들어가지 못했어요.");
    expect(q("login-error")?.textContent).toContain("유효하지 않은 초대 코드");
    const relink = q("login-error")?.querySelector("button") as HTMLButtonElement;
    expect(relink.textContent).toBe("링크 다시 넣기");
    act(() => relink.click());
    expect(q("onboarding-welcome")).not.toBeNull();
    expect(focused()).toBe("connect-entry");
  });

  it("sends an already-redeemed invite to D1 on the same server, as guidance not a failure", async () => {
    joinWithInvite.mockRejectedValue(new ApiError(409, "invite already redeemed by this email"));
    await joinFromLink();
    await vi.waitFor(() => expect(q("onboarding-sign-in")).not.toBeNull());
    expect(q("login-error")?.textContent).toContain("로그인하세요");
    expect(guideExpression()).toBe("idle");
  });

  it("keeps a transport failure on D1′ with a retry", async () => {
    joinWithInvite.mockRejectedValue(new NetworkError("unreachable", 15_000));
    await joinFromLink();
    await vi.waitFor(() => expect(q("login-error")).not.toBeNull());
    expect(q("onboarding-join")).not.toBeNull();
    expect(q("login-error")?.textContent).toContain("다시 시도");
    expect((q("login-password") as HTMLInputElement).value).toBe("new-pass");
  });

  it("keeps the invite when 뒤로 leaves a link-opened D1′, and 계속 returns to it", () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mount();
    click("onboarding-back");
    expect(q("onboarding-welcome")).not.toBeNull();
    expect(guideLine()).toBe("초대 코드를 받았어요. 어느 팀 서버인가요?");
    click("connect-entry-submit");
    expect(q("onboarding-join")).not.toBeNull();
  });

  it("drops the invite on 링크 다시 넣기 after a code verdict", async () => {
    joinWithInvite.mockRejectedValue(new ApiError(404, "invite not found"));
    await joinFromLink();
    await vi.waitFor(() => expect(q("login-error")).not.toBeNull());
    act(() => (q("login-error")?.querySelector("button") as HTMLButtonElement).click());
    expect(guideLine()).toBe("안녕하세요, 저는 코메토예요. 어디로 갈까요?");
    click("connect-entry-submit");
    expect(q("onboarding-sign-in")).not.toBeNull();
  });

  it("says it is saving the name, not joining, while a name retry runs", async () => {
    changeMyDisplayName.mockRejectedValueOnce(new ApiError(500, "engine boom"));
    await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    changeMyDisplayName.mockImplementation(() => new Promise(() => undefined));
    const retry = q("onboarding-profile-banner")?.querySelector("button") as HTMLButtonElement;
    await act(async () => retry.click());
    expect(guideExpression()).toBe("thinking");
    expect(guideLine()).toBe("이름을 저장하고 있어요.");
  });

  it("offers 로그인 for someone who already has an account here", () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mount();
    click("join-sign-in-link");
    expect(q("onboarding-sign-in")).not.toBeNull();
    expect(q("onboarding-dots-label")?.textContent).toBe("1단계 중 1단계");
  });
});

describe("join session hold (BZ-6b, kept through the merge)", () => {
  it("releases the hold once when the join lands without a name", async () => {
    releaseSessionRestoreMock.mockClear();
    const onLoggedIn = await joinFromLink();
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the hold once when the name is saved", async () => {
    changeMyDisplayName.mockResolvedValue({ ...session.member, displayName: "성재" });
    releaseSessionRestoreMock.mockClear();
    const onLoggedIn = await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("holds through a name-save failure and releases once on 계속", async () => {
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    expect(sessionRestoreHeld()).toBe(true);
    releaseSessionRestoreMock.mockClear();
    await submitForm();
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the hold once on unmount mid-flow", async () => {
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    await joinFromLink({ name: "성재" });
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    releaseSessionRestoreMock.mockClear();
    act(() => {
      mountedRoot?.unmount();
      mountedRoot = null;
    });
    expect(releaseSessionRestoreMock).toHaveBeenCalledTimes(1);
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("releases the hold on a failed join", async () => {
    joinWithInvite.mockRejectedValue(new ApiError(404, "invite not found"));
    await joinFromLink();
    await vi.waitFor(() => expect(q("login-error")).not.toBeNull());
    expect(sessionRestoreHeld()).toBe(false);
  });

  it("keeps D1′ on screen after join applyLogin instead of restoring the shell", async () => {
    joinWithInvite.mockImplementation(async () => {
      applyLogin(session);
      return { ...session, createdMember: true };
    });
    changeMyDisplayName.mockRejectedValue(new ApiError(500, "engine boom"));
    window.history.replaceState(null, "", `/?code=${CODE}`);
    mountGate();
    fill("login-email", "seongjae@dawn.example");
    fill("login-password", "new-pass");
    fill("onboarding-profile-name", "성재");
    await submitForm();
    await vi.waitFor(() => expect(q("onboarding-profile-banner")).not.toBeNull());
    expect(q("onboarding-join")).not.toBeNull();
    expect(q("session-restoring")).toBeNull();
    expect(q("signed-in-shell")).toBeNull();
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
    expect(q("session-restoring")).toBeNull();
  });
});
