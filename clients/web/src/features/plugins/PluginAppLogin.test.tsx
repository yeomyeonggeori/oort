// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { PluginAppLogin } from "./PluginAppLogin";

// #4074 (ADR-0203 증보 2026-10-19 L4): 앱 상세의 로그인. 운영자·같은 서버 Hermes·Hermes가 아는 앱일 때만 서고,
// 돌아온 주소는 한 번 지나가고 어디에도 남지 않는다. 만료는 단정하지 않는다.

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  settingsRequest: api.request,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT = "00000000-0000-7000-8000-0000000000aa";
const GMAIL = "com.momo.plugins.gmail";
const PASTE = "http://127.0.0.1:4182/callback?code=MARKER-APPCODE-3b9&state=MARKER-APPSTATE-77";
const COHOSTED = {
  schema: "momo.cohosted_agent.status.v0",
  declaration: "ready",
  toolsLockAttested: true,
  connectable: false,
  connectedAgentId: AGENT,
};
const targets = (connected: boolean) => ({
  schema: "momo.login_relay.targets.v0",
  targets: [{ target: "gmail", connected }],
});
const start = {
  schema: "momo.login_relay.start.v0",
  loginId: "login_gmail_0123456789ab",
  mode: "paste",
  url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=capture",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const status = (word: string) => ({ schema: "momo.login_relay.status.v0", status: word });

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: "m", workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const flags = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

function mount(pluginId = GMAIL, offline = false): HTMLElement {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: sessionValue() }, createElement(PluginAppLogin, { pluginId, offline }))
      )
    );
  });
  return host;
}
const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
async function until(id: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!q(id)) throw new Error(id);
  });
  return q(id) as HTMLElement;
}
const click = (el: HTMLElement) => act(() => el.click());
const calls = () =>
  api.request.mock.calls.map((call) => `${(call[1] as RequestInit | undefined)?.method ?? "GET"} ${call[0]}`);

/** `reads`: 연결 읽기 순서대로 줄 목록 답. */
function route(options: { targets?: unknown | (() => unknown); cohosted?: unknown }) {
  api.request.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith("/cohosted-agent")) {
      return options.cohosted instanceof Error ? Promise.reject(options.cohosted) : Promise.resolve(options.cohosted ?? COHOSTED);
    }
    if (init?.method === "POST" && path.endsWith("/complete")) return Promise.resolve(status("submitted"));
    if (init?.method === "POST") return Promise.resolve(start);
    if (init?.method === "DELETE") return Promise.resolve(status("cancelled"));
    if (path.includes("/app-login/")) return Promise.resolve(status("done"));
    const value = typeof options.targets === "function" ? (options.targets as () => unknown)() : options.targets;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? targets(false));
  });
}

function everywhere(): string {
  const cache = client
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify({ key: query.queryKey, data: query.state.data }))
    .join("|");
  const mutations = client
    .getMutationCache()
    .getAll()
    .map((m) => JSON.stringify({ v: m.state.variables, d: m.state.data }))
    .join("|");
  const logs = spies
    .flatMap((spy) => spy.mock.calls.map((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")))
    .join("|");
  const inputs = Array.from(host?.querySelectorAll("input") ?? [])
    .map((input) => input.value)
    .join("|");
  return [host?.innerHTML ?? "", inputs, cache, mutations, logs, JSON.stringify({ ...window.localStorage }), JSON.stringify({ ...window.sessionStorage })].join("\n");
}

beforeEach(() => {
  flags.IS_REACT_ACT_ENVIRONMENT = true;
  api.request.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});
afterEach(async () => {
  act(() => root?.unmount());
  await new Promise((resolve) => setTimeout(resolve, 5));
  host?.remove();
  root = null;
  host = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("PluginAppLogin", () => {
  it("draws nothing and asks nothing for an app Hermes cannot log in to", async () => {
    route({});
    const el = mount("com.momo.plugins.github");
    await act(async () => undefined);
    expect(el.innerHTML).toBe("");
    expect(api.request).not.toHaveBeenCalled();
    // 그리다 터져서 비어 보이는 것과 구별한다.
    expect(spies[3]?.mock.calls.length).toBe(0);
  });

  it("draws nothing for a stranger (403), for no connected Hermes, and for an app Hermes does not list", async () => {
    for (const setup of [
      () => route({ cohosted: new ApiError(403, "no") }),
      () => route({ cohosted: { ...COHOSTED, connectedAgentId: undefined } }),
      () => route({ targets: new ApiError(403, "no") }),
      () => route({ targets: { schema: "momo.login_relay.targets.v0", targets: [{ target: "google_drive", connected: true }] } }),
    ]) {
      api.request.mockReset();
      setup();
      const el = mount();
      await waitFor(() => expect(api.request).toHaveBeenCalled());
      await waitFor(() => expect(q("app-login-loading")).toBeNull());
      await act(async () => undefined);
      expect(el.querySelector("[data-testid='app-login']")).toBeNull();
      expect(calls().every((call) => call.startsWith("GET"))).toBe(true);
      expect(spies[3]?.mock.calls.length).toBe(0);
      act(() => root?.unmount());
      el.remove();
      root = null;
    }
  });

  it("shows the connection state, a login button, and a hedged expiry note", async () => {
    route({ targets: targets(true) });
    mount();
    await until("app-login-row");
    expect(q("app-login-row")?.textContent).toContain("연결됨");
    expect(q("app-login-start")?.textContent).toBe("다시 로그인");
    const note = q("app-login-expiry")?.textContent ?? "";
    expect(note).toContain("테스트 모드(외부 사용자)라면");
    expect(note).toContain("7일쯤");
    expect(note).toContain("알 수 없어요");
    expect(note).not.toMatch(/만료됩니다|만료돼요\./);
  });

  it("shows the probe command when the relay is off, starting nothing", async () => {
    route({ targets: new ApiError(409, "off", "login_relay_off") });
    mount();
    const shell = await until("app-login-shell");
    expect(shell.textContent).toContain("mcp_login_probe.py gmail");
    expect(q("app-login-start")).toBeNull();
  });

  it("opens the address, takes the pasted address once, clears it at once, and keeps it nowhere", async () => {
    let release: (value: unknown) => void = () => undefined;
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/cohosted-agent")) return Promise.resolve(COHOSTED);
      if (init?.method === "POST" && path.endsWith("/complete")) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (init?.method === "POST") return Promise.resolve(start);
      return Promise.resolve(targets(false));
    });
    mount();
    click(await until("app-login-start"));
    const open = (await until("login-open")) as HTMLAnchorElement;
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(q("login-host")?.textContent).toBe("accounts.google.com");
    expect(JSON.parse(api.request.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST")?.[1].body)).toEqual({ app: "gmail" });
    const input = q("login-paste") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: PASTE } });
    click(q("login-paste-send") as HTMLElement);
    await waitFor(() => expect(calls().some((call) => call.endsWith("/complete"))).toBe(true));
    expect(input.value).toBe("");
    expect(everywhere()).not.toContain("MARKER-APP");
    await act(async () => release(status("submitted")));
    expect(everywhere()).not.toContain("MARKER-APP");
    const bodies = api.request.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ""));
    expect(bodies.filter((body) => body.includes("MARKER-APPCODE"))).toHaveLength(1);
    expect(bodies.find((body) => body.includes("MARKER-APPCODE"))).toBe(JSON.stringify({ pasted: PASTE }));
  });

  it("a refused start says why in a fixed sentence", async () => {
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/cohosted-agent")) return Promise.resolve(COHOSTED);
      if (init?.method === "POST") return Promise.reject(new ApiError(409, "x", "connector_trial_members"));
      return Promise.resolve(targets(false));
    });
    mount();
    click(await until("app-login-start"));
    const banner = await until("app-login-start-error");
    expect(banner.textContent).toContain("사람 멤버가 한 명일 때만");
    expect(q("login-session")).toBeNull();
  });

  it("offline locks the button and says why", async () => {
    route({ targets: targets(false) });
    mount(GMAIL, true);
    await until("app-login-row");
    expect(q("app-login-start")?.getAttribute("aria-disabled")).toBe("true");
    expect(q("app-login-offline")).not.toBeNull();
  });

  it("cancelling closes the session, cancels it on the server and returns focus to the button", async () => {
    route({ targets: targets(false) });
    mount();
    click(await until("app-login-start"));
    await until("login-session");
    click(q("login-cancel") as HTMLElement);
    expect(q("login-session")).toBeNull();
    expect(calls().some((call) => call.startsWith("DELETE") && call.endsWith("/login_gmail_0123456789ab"))).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(q("app-login-start")));
  });
});
