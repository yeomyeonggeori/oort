// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { CohostedModelLogin, ModelLoginPanel } from "./ModelLoginPanel";

// #4080 (ADR-0203 증보 2026-10-19 L4, ADR-0004 증보 7): 모델 인증 화면. 붙여넣은 값과 기기 코드는 한 번 지나가고
// 상태·캐시·저장소·로그·화면에 남지 않는다. 운영자가 아니면 아무것도 그리지 않는다. 중계가 꺼져 있으면 셸 명령이다.

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  settingsRequest: api.request,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT = "00000000-0000-7000-8000-0000000000aa";
const PASTE = "MARKER-PASTE-7f3a#MARKER-STATE-91c";
const CODE = "MARKER-CODE-5d2e";

const TARGETS = {
  schema: "momo.login_relay.targets.v0",
  targets: [
    { target: "openai-codex", connected: false },
    { target: "anthropic", connected: false },
  ],
};
const codexStart = {
  schema: "momo.login_relay.start.v0",
  loginId: "login_codex_0123456789",
  mode: "device",
  url: "https://auth.openai.com/codex/device",
  userCode: CODE,
  expiresAt: Math.floor(Date.now() / 1000) + 900,
};
const claudeStart = {
  schema: "momo.login_relay.start.v0",
  loginId: "login_claude_0123456789",
  mode: "paste",
  url: "https://claude.ai/oauth/authorize?code=true",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const status = (word: string, reason?: string) => ({
  schema: "momo.login_relay.status.v0",
  status: word,
  ...(reason ? { reason } : {}),
});

const flags = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

function mount(offline = false): HTMLElement {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ModelLoginPanel, { workspaceId: WS, agentId: AGENT, offline })
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

const spies: Array<ReturnType<typeof vi.spyOn>> = [];
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
  vi.useRealTimers();
  act(() => root?.unmount());
  // 언마운트가 미룬 취소(한 틱 뒤)를 이 시험 안에서 끝낸다.
  await new Promise((resolve) => setTimeout(resolve, 5));
  host?.remove();
  root = null;
  host = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** 값이 남을 수 있는 모든 곳을 한 덩어리로 직렬화한다(화면·캐시·저장소·콘솔). */
function everywhere(): string {
  const cache = client
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify({ key: query.queryKey, data: query.state.data }))
    .join("|");
  const mutations = client
    .getMutationCache()
    .getAll()
    .map((mutation) => JSON.stringify({ v: mutation.state.variables, d: mutation.state.data }))
    .join("|");
  const logs = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))).join("|");
  const inputs = Array.from(host?.querySelectorAll("input") ?? [])
    .map((input) => input.value)
    .join("|");
  return [
    host?.innerHTML ?? "",
    inputs,
    cache,
    mutations,
    logs,
    JSON.stringify({ ...window.localStorage }),
    JSON.stringify({ ...window.sessionStorage }),
  ].join("\n");
}

describe("ModelLoginPanel", () => {
  it("draws nothing for a non-operator (403) and keeps asking nothing else", async () => {
    api.request.mockRejectedValue(new ApiError(403, "no"));
    const el = mount();
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    // 읽는 동안은 「불러오는 중」이 서 있다. 403 이 도착해 그것마저 사라진 뒤에야 아무것도 없음을 본다.
    await waitFor(() => expect(q("model-login-loading")).toBeNull());
    expect(el.querySelector("[data-testid='model-login']")).toBeNull();
    expect(calls()).toEqual([`GET /v1/workspaces/${WS}/agents/${AGENT}/model-login`]);
  });

  it("shows a loading state, then the three choices", async () => {
    api.request.mockResolvedValue(TARGETS);
    mount();
    expect(q("model-login-loading")).not.toBeNull();
    await until("model-login-codex");
    expect(q("model-login-claude")?.textContent).toContain("Claude 로그인");
    expect(q("model-login-key")?.textContent).toContain("API 키");
    expect(q("model-login-key")?.querySelector("input")).toBeNull();
  });

  it("shows the shell command instead when the relay is off (409 login_relay_off), starting nothing", async () => {
    api.request.mockRejectedValue(new ApiError(409, "off", "login_relay_off"));
    mount();
    const shell = await until("model-login-shell");
    expect(shell.textContent).toContain("hermes auth add openai-codex --type oauth --no-browser");
    expect(shell.textContent).toContain("hermes auth add anthropic --type oauth --no-browser");
    expect(q("model-login-start-openai-codex")).toBeNull();
    expect(calls().every((call) => call.startsWith("GET"))).toBe(true);
  });

  it("reports a load failure with a retry", async () => {
    api.request.mockRejectedValueOnce(new ApiError(502, "bad"));
    mount();
    await until("model-login-error");
    api.request.mockResolvedValue(TARGETS);
    click(q("model-login-error")?.querySelector("button") as HTMLElement);
    await until("model-login-codex");
  });

  it("Codex: shows the host and the device code from the start response, polls to done, then drops the code", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(codexStart);
      if (path.endsWith("/login_codex_0123456789")) return Promise.resolve(status("done"));
      return Promise.resolve(TARGETS);
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    click(q("model-login-start-openai-codex") as HTMLElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(q("login-host")?.textContent).toBe("auth.openai.com");
    expect(q("login-device-code")?.textContent).toContain(CODE);
    const open = q("login-open") as HTMLAnchorElement;
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
    expect(q("login-paste")).toBeNull();
    // 폴링은 상태만 읽고, 끝나면 코드가 화면에서 사라진다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(q("model-login-result")?.getAttribute("data-status")).toBe("done");
    expect(everywhere()).not.toContain(CODE);
    expect(q("login-device-code")).toBeNull();
  });

  it("Claude: asks for the terms line before starting, and sends nothing until confirmed", async () => {
    api.request.mockResolvedValue(TARGETS);
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    const terms = await until("model-login-claude-terms");
    expect(terms.textContent).toContain("이 로그인은 운영자 본인 구독이며 약관 책임은 운영자에게 있어요");
    expect(calls().every((call) => call.startsWith("GET"))).toBe(true);
  });

  it("Claude: pastes once, clears the field before the request returns, and leaves the value nowhere", async () => {
    let release: (value: unknown) => void = () => undefined;
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path.endsWith("/complete")) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (init?.method === "POST") return Promise.resolve(claudeStart);
      return Promise.resolve(TARGETS);
    });
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    click(await until("model-login-claude-confirm"));
    const input = (await until("login-paste")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: PASTE } });
    expect(input.value).toBe(PASTE);
    click(q("login-paste-send") as HTMLElement);
    // 요청이 아직 돌아오지 않았는데도 칸은 비어 있다.
    await waitFor(() => expect(calls().some((call) => call.endsWith("/complete"))).toBe(true));
    expect(input.value).toBe("");
    expect(everywhere()).not.toContain("MARKER-PASTE");
    expect(everywhere()).not.toContain("MARKER-STATE");
    await act(async () => release(status("submitted")));
    expect(everywhere()).not.toContain("MARKER-PASTE");
    // 양성 대조: 값은 정확히 한 번, 본문으로만 나갔다.
    const bodies = api.request.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ""));
    expect(bodies.filter((body) => body.includes("MARKER-PASTE"))).toHaveLength(1);
    expect(bodies.find((body) => body.includes("MARKER-PASTE"))).toBe(JSON.stringify({ pasted: PASTE }));
    expect(q("login-status")?.textContent).toContain("확인하고 있어요");
  });

  it("Claude: a refused paste shows a fixed sentence without the value and leaves the field empty", async () => {
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path.endsWith("/complete")) {
        return Promise.reject(new ApiError(400, `echo ${PASTE}`, "state_mismatch"));
      }
      if (init?.method === "POST") return Promise.resolve(claudeStart);
      return Promise.resolve(TARGETS);
    });
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    click(await until("model-login-claude-confirm"));
    const input = (await until("login-paste")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PASTE } });
    click(q("login-paste-send") as HTMLElement);
    const banner = await until("login-send-error");
    expect(banner.textContent).toContain("이 로그인에서 받은 것이 아니에요");
    expect(input.value).toBe("");
    expect(everywhere()).not.toContain("MARKER-PASTE");
  });

  it("cancel ends the login on the server and drops the address", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? codexStart : TARGETS)
    );
    mount();
    await until("model-login-codex");
    click(q("model-login-start-openai-codex") as HTMLElement);
    await until("login-session");
    click(q("login-cancel") as HTMLElement);
    expect(q("login-session")).toBeNull();
    expect(calls().some((call) => call.startsWith("DELETE") && call.endsWith("/login_codex_0123456789"))).toBe(true);
    expect(everywhere()).not.toContain(CODE);
  });

  it("unmounting mid-login cancels it on the server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? codexStart : TARGETS)
    );
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    click(q("model-login-start-openai-codex") as HTMLElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() => root?.unmount());
    root = null;
    await vi.advanceTimersByTimeAsync(10);
    expect(calls().some((call) => call.startsWith("DELETE") && call.endsWith("/login_codex_0123456789"))).toBe(true);
  });

  it("a start refusal (429) says why in a fixed sentence and keeps the choices", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === "POST" ? Promise.reject(new ApiError(429, "slow")) : Promise.resolve(TARGETS)
    );
    mount();
    await until("model-login-codex");
    click(q("model-login-start-openai-codex") as HTMLElement);
    const banner = await until("model-login-start-error");
    expect(banner.textContent).toContain("너무 자주");
    expect(q("login-session")).toBeNull();
  });

  it("offline: the start buttons are locked and the reason is said", async () => {
    api.request.mockResolvedValue(TARGETS);
    mount(true);
    await until("model-login-codex");
    expect(q("model-login-start-openai-codex")?.getAttribute("aria-disabled")).toBe("true");
    expect(q("model-login-offline")).not.toBeNull();
  });

  it("refuses an address on a lookalike host even over https", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? { ...claudeStart, url: "https://claude.ai.evil.example/x" } : TARGETS)
    );
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    click(await until("model-login-claude-confirm"));
    await until("login-url-refused");
    expect(q("login-open")).toBeNull();
  });

  it("moves focus to the new block's first action, and back to the start button when it closes", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? claudeStart : init?.method === "DELETE" ? status("cancelled") : TARGETS)
    );
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    const confirm = await until("model-login-claude-confirm");
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    click(confirm);
    const paste = await until("login-paste");
    await waitFor(() => expect(document.activeElement).toBe(paste));
    click(q("login-cancel") as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(q("model-login-start-anthropic")));
  });

  it("a poll that finds the login erased (404) ends it and drops the address", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    api.request.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(codexStart);
      if (path.endsWith("/login_codex_0123456789")) return Promise.reject(new ApiError(404, "gone", "login_not_found"));
      return Promise.resolve(TARGETS);
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    click(q("model-login-start-openai-codex") as HTMLElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(q("model-login-result")?.getAttribute("data-status")).toBe("expired");
    expect(everywhere()).not.toContain(CODE);
  });

  it("an expired countdown cancels the login and drops the code, even when the server clock is far off", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? { ...codexStart, expiresAt: 1 } : TARGETS)
    );
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    click(q("model-login-start-openai-codex") as HTMLElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // 서버 시각이 이 기기보다 한참 과거여도 시작 즉시 만료되지 않는다.
    expect(q("login-device-code")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(301_000);
    });
    expect(q("model-login-result")?.getAttribute("data-status")).toBe("expired");
    expect(q("login-device-code")).toBeNull();
    expect(calls().some((call) => call.startsWith("DELETE"))).toBe(true);
    expect(everywhere()).not.toContain(CODE);
  });

  it("when the target read starts failing mid-login, the session ends and the start response is not kept for a later retry", async () => {
    let readOk = true;
    api.request.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(codexStart);
      if (init?.method === "DELETE") return Promise.resolve(status("cancelled"));
      return readOk ? Promise.resolve(TARGETS) : Promise.reject(new ApiError(502, "bad"));
    });
    mount();
    await until("model-login-codex");
    click(q("model-login-start-openai-codex") as HTMLElement);
    await until("login-device-code");
    readOk = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["login-relay"] });
    });
    await until("model-login-error");
    expect(q("login-device-code")).toBeNull();
    readOk = true;
    click(q("model-login-error")?.querySelector("button") as HTMLElement);
    await until("model-login-codex");
    // 다시 읽어 와도 지난 로그인의 주소·코드는 되살아나지 않는다.
    expect(q("login-session")).toBeNull();
    expect(q("login-device-code")).toBeNull();
  });

  it("cancels a login whose start finished after the panel was gone", async () => {
    let release: (value: unknown) => void = () => undefined;
    api.request.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(TARGETS);
    });
    mount();
    await until("model-login-codex");
    click(q("model-login-start-openai-codex") as HTMLElement);
    act(() => root?.unmount());
    root = null;
    await act(async () => release(codexStart));
    await waitFor(() => expect(calls().some((call) => call.startsWith("DELETE") && call.endsWith("/login_codex_0123456789"))).toBe(true));
  });

  it("refuses to open an address that is not https", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? { ...claudeStart, url: "http://evil.example/x" } : TARGETS)
    );
    mount();
    await until("model-login-claude");
    click(q("model-login-start-anthropic") as HTMLElement);
    click(await until("model-login-claude-confirm"));
    await until("login-url-refused");
    expect(q("login-open")).toBeNull();
  });
});

describe("CohostedModelLogin (welcome door)", () => {
  function mountDoor(): HTMLElement {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(QueryClientProvider, { client }, createElement(CohostedModelLogin, { workspaceId: WS, offline: false }))
      );
    });
    return host;
  }
  const STATUS = {
    schema: "momo.cohosted_agent.status.v0",
    declaration: "ready",
    toolsLockAttested: true,
    connectable: false,
  };

  it("draws nothing for a stranger or while no Hermes is connected, and asks no login route", async () => {
    for (const outcome of [() => Promise.reject(new ApiError(403, "no")), () => Promise.resolve(STATUS)]) {
      api.request.mockReset();
      api.request.mockImplementation(outcome);
      const el = mountDoor();
      await waitFor(() => expect(api.request).toHaveBeenCalled());
      await act(async () => undefined);
      expect(el.querySelector("[data-testid='model-login']")).toBeNull();
      expect(calls()).toEqual([`GET /v1/workspaces/${WS}/cohosted-agent`]);
      act(() => root?.unmount());
      el.remove();
      root = null;
    }
  });

  it("shows the panel for the operator once Hermes is connected", async () => {
    api.request.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/cohosted-agent") ? { ...STATUS, connectedAgentId: AGENT } : TARGETS)
    );
    mountDoor();
    await until("model-login-codex");
    expect(calls()).toContain(`GET /v1/workspaces/${WS}/agents/${AGENT}/model-login`);
  });
});
