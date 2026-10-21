// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { CohostedAgentCard } from "./CohostedAgentCard";

// #3883 짝 UI (ADR-0203 D3·Q2): 카드는 서버가 알 때만, 운영자에게만 보이고, 잠금 선언 전에는 체크리스트뿐이며,
// 선언 뒤에야 찾은 결과와 한 번 클릭이 나온다. 도구 잠금은 운영자의 선언이라고 늘 말한다.

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  settingsRequest: api.request,
}));

// DM 열기(POST /dms)는 코어 lib/api의 `request`를 탄다. 설정 요청과 따로 가로챈다.
const dm = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  openDirectMessage: dm.open,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const STATUS = {
  schema: "momo.cohosted_agent.status.v0",
  declaration: "ready",
  endpointLabel: "http://hermes.railway.internal:8642/v1",
  toolsLockAttested: false,
  connectable: false,
};
const PROBE = {
  schema: "momo.cohosted_agent.probe.v0",
  state: "ok",
  requestsSent: 3,
  modelCount: 1,
  toolsLockAttested: true,
  toolsets: { signal: "none_listed", proof: false },
  connectable: true,
};

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

function LocationProbe() {
  return createElement("output", { "data-testid": "probe-path" }, useLocation().pathname);
}

function mount(offline = false): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(
            SessionProvider,
            { value: sessionValue() },
            createElement(CohostedAgentCard, { offline, workspaceId: WS }),
            createElement(LocationProbe)
          )
        )
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
const calls = () => api.request.mock.calls.map((call) => `${(call[1] as RequestInit | undefined)?.method ?? "GET"} ${call[0]}`);

beforeEach(() => {
  flags.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  api.request.mockReset();
  dm.open.mockReset();
  dm.open.mockResolvedValue({ channel: { id: "dm-1", kind: "dm", name: "Hermes" } });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("CohostedAgentCard", () => {
  it("draws nothing for a stranger, an old server or an undeclared instance, and never probes", async () => {
    for (const outcome of [
      () => Promise.reject(new ApiError(403, "no")),
      () => Promise.reject(new ApiError(404, "no")),
      () => Promise.resolve({ ...STATUS, declaration: "not_declared" }),
    ]) {
      api.request.mockReset();
      api.request.mockImplementation(outcome);
      const el = mount();
      await waitFor(() => expect(api.request).toHaveBeenCalled());
      await act(async () => undefined);
      expect(el.querySelector("[data-testid='ai-cohosted']")).toBeNull();
      expect(calls().every((call) => call.startsWith("GET"))).toBe(true);
      act(() => root?.unmount());
      el.remove();
      root = null;
    }
  });

  it("before the operator attests, shows the checklist only and sends no probe or connect", async () => {
    api.request.mockResolvedValue(STATUS);
    mount();
    const row = await until("ai-cohosted-checklist-row");
    expect(row.textContent).toContain("체크리스트");
    expect(q("ai-cohosted-connect")).toBeNull();
    expect(q("ai-cohosted-found")).toBeNull();
    expect(row.textContent).not.toContain("연결할까요");
    expect(calls()).toEqual([`GET /v1/workspaces/${WS}/cohosted-agent`]);
    expect(q("ai-cohosted-checklist")?.getAttribute("href")).toContain("SELF_HOST_AGENT");
  });

  it("after attestation it finds the agent and connects with one click, saying the lock is the operator's own word", async () => {
    api.request.mockImplementation((path: string) => {
      if (path.endsWith("/probe")) return Promise.resolve(PROBE);
      if (path.endsWith("/connect")) {
        return Promise.resolve({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" });
      }
      return Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: true });
    });
    mount();
    const found = await until("ai-cohosted-found");
    expect(found.textContent).toContain("같은 서버의 Hermes를 찾았어요.");
    expect(q("ai-cohosted-attest-note")?.textContent).toContain("운영자님이 서버에 직접 선언한 값");
    expect(q("ai-cohosted-attest-note")?.textContent).toContain("확인한 것이 아니에요");
    const probeBody = api.request.mock.calls.find((call) => String(call[0]).endsWith("/probe"))?.[1] as RequestInit;
    expect(JSON.parse(String(probeBody.body))).toEqual({ checkToolsets: true });

    api.request.mockImplementation((path: string) => {
      if (path.endsWith("/connect")) {
        return Promise.resolve({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" });
      }
      return Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: false, connectedAgentId: "a1" });
    });
    await act(async () => q("ai-cohosted-connect")?.click());
    const done = await until("ai-cohosted-connected");
    expect(done.textContent).toContain("Hermes 연결됨");
    expect(q("ai-cohosted-open-agent")?.getAttribute("href")).toBe("/agents?agent=a1");
    expect(calls().filter((call) => call.startsWith("POST") && call.endsWith("/connect"))).toHaveLength(1);
  });

  it("a toolsets caution is a warning, not a block, and the 'none listed' line says it proves nothing", async () => {
    api.request.mockImplementation((path: string) =>
      path.endsWith("/probe")
        ? Promise.resolve({ ...PROBE, toolsets: { signal: "dangerous_listed", listed: ["terminal"], proof: false } })
        : Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: true })
    );
    mount();
    const warn = await until("ai-cohosted-toolsets-warn");
    expect(warn.textContent).toContain("terminal");
    expect(q("ai-cohosted-connect")?.hasAttribute("disabled")).toBe(false);
  });

  it("says what to do next when the agent does not answer, and offers to look again", async () => {
    api.request.mockImplementation((path: string) =>
      path.endsWith("/probe")
        ? Promise.resolve({ ...PROBE, state: "unreachable", connectable: false })
        : Promise.resolve({ ...STATUS, toolsLockAttested: true })
    );
    mount();
    const row = await until("ai-cohosted-not-found");
    expect(row.textContent).toContain("HERMES_BASE_URL");
    expect(row.textContent).toContain("다시 찾기");
    expect(q("ai-cohosted-connect")).toBeNull();
  });

  it("shows the server's refusal in context when connect fails", async () => {
    api.request.mockImplementation((path: string) => {
      if (path.endsWith("/connect")) return Promise.reject(new ApiError(409, "x", "cohosted_agent_not_reachable"));
      if (path.endsWith("/probe")) return Promise.resolve(PROBE);
      return Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: true });
    });
    mount();
    await until("ai-cohosted-found");
    await act(async () => q("ai-cohosted-connect")?.click());
    const banner = await until("ai-cohosted-connect-error");
    expect(banner.textContent).toContain("지금 답하지 않아");
  });

  it("does not probe while offline", async () => {
    api.request.mockResolvedValue({ ...STATUS, toolsLockAttested: true });
    mount(true);
    await until("ai-cohosted-offline");
    expect(calls().some((call) => call.endsWith("/probe"))).toBe(false);
  });

  describe("연결 성공 알림과 대화 (#4141)", () => {
    const attested = (connected: boolean) => (path: string) => {
      if (path.endsWith("/probe")) return Promise.resolve(PROBE);
      if (path.endsWith("/connect")) {
        return Promise.resolve({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" });
      }
      return Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: !connected, ...(connected ? { connectedAgentId: "a1" } : {}) });
    };
    const flipToConnected = () => {
      api.request.mockImplementation(attested(true));
    };
    const noticeText = () => q("ai-cohosted-connected-notice")?.textContent ?? "";
    const path = () => q("probe-path")?.textContent;

    it("카드 단추로 연결하면 「Hermes를 연결했어요」가 뜨고 카드가 연결됨으로 바뀌고 DM이 만들어진다", async () => {
      api.request.mockImplementation(attested(false));
      mount();
      await until("ai-cohosted-found");
      expect(q("ai-cohosted-connected-notice")).toBeNull();
      flipToConnected();
      await act(async () => q("ai-cohosted-connect")?.click());
      await until("ai-cohosted-connected");
      expect(noticeText()).toContain("Hermes를 연결했어요");
      expect(q("ai-cohosted-connected")?.textContent).toContain("Hermes 연결됨");
      expect(q("ai-cohosted-found")).toBeNull();
      await waitFor(() => expect(dm.open).toHaveBeenCalledWith(WS, "a1"));
      // 만들기만 하고 가지는 않는다: 사이드바에 보이면 충분하다.
      expect(path()).toBe("/");
    });

    it("알림의 「대화 열기」는 그 DM으로 간다", async () => {
      api.request.mockImplementation(attested(false));
      mount();
      await until("ai-cohosted-found");
      flipToConnected();
      await act(async () => q("ai-cohosted-connect")?.click());
      await until("ai-cohosted-connected-notice");
      await act(async () => q("ai-cohosted-notice-open-dm")?.click());
      await waitFor(() => expect(path()).toBe("/c/dm-1"));
    });

    it("처음 한 번 창에서 연결해도 같은 알림이 뜬다", async () => {
      api.request.mockImplementation(attested(false));
      mount();
      await waitFor(() => expect(document.querySelector("[data-testid='ai-cohosted-prompt']")).not.toBeNull());
      flipToConnected();
      await act(async () => document.querySelector<HTMLElement>("[data-testid='ai-cohosted-prompt-connect']")?.click());
      await until("ai-cohosted-connected-notice");
      expect(noticeText()).toContain("Hermes를 연결했어요");
      await waitFor(() => expect(dm.open).toHaveBeenCalledWith(WS, "a1"));
    });

    it("연결에 실패하면 알림도 DM도 없다", async () => {
      api.request.mockImplementation((p: string) => {
        if (p.endsWith("/connect")) return Promise.reject(new ApiError(409, "x", "cohosted_agent_not_reachable"));
        return attested(false)(p);
      });
      mount();
      await until("ai-cohosted-found");
      await act(async () => q("ai-cohosted-connect")?.click());
      await until("ai-cohosted-connect-error");
      expect(q("ai-cohosted-connected-notice")).toBeNull();
      expect(dm.open).not.toHaveBeenCalled();
    });

    it("이미 연결된 상태면 연결됨 줄의 「대화 열기」가 DM을 열어 간다 (알림은 없다)", async () => {
      api.request.mockImplementation(attested(true));
      mount();
      await until("ai-cohosted-connected");
      expect(q("ai-cohosted-connected-notice")).toBeNull();
      expect(dm.open).not.toHaveBeenCalled();
      await act(async () => q("ai-cohosted-open-dm")?.click());
      await waitFor(() => expect(path()).toBe("/c/dm-1"));
      expect(dm.open).toHaveBeenCalledWith(WS, "a1");
    });

    it("DM을 못 열면 그 자리에 문장으로 말하고 이동하지 않는다", async () => {
      dm.open.mockRejectedValue(new ApiError(403, "no"));
      api.request.mockImplementation(attested(true));
      mount();
      await until("ai-cohosted-connected");
      await act(async () => q("ai-cohosted-open-dm")?.click());
      const banner = await until("ai-cohosted-dm-error");
      expect(banner.textContent).toContain("다이렉트 메시지를 열 권한");
      expect(path()).toBe("/");
    });
  });

  describe("모델 구획 (#4145)", () => {
    const MODELS = {
      schema: "momo.cohosted_agent.models.v0",
      agentId: "a1",
      pinned: true,
      current: { provider: "anthropic", model: "claude-sonnet-5-5" },
      providers: [{ provider: "anthropic", models: [{ id: "claude-sonnet-5-5", featured: true, current: true }] }],
    };
    const serve = (connected: boolean, models: unknown = MODELS) => (path: string, init?: RequestInit) => {
      if (path.endsWith("/models")) return typeof models === "function" ? (models as () => Promise<unknown>)() : Promise.resolve(models);
      if (path.endsWith("/probe")) return Promise.resolve(PROBE);
      if (path.endsWith("/connect")) {
        return Promise.resolve({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" });
      }
      void init;
      return Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: !connected, ...(connected ? { connectedAgentId: "a1" } : {}) });
    };

    // 처음 한 번 창(#4113)이 초점을 잡고 있으면 초점 시험이 흐려진다: 먼저 닫는다.
    const closePrompt = async () => {
      await waitFor(() => expect(document.querySelector("[data-testid='ai-cohosted-prompt']")).not.toBeNull());
      await act(async () => document.querySelector<HTMLElement>("[data-testid='ai-cohosted-prompt-later']")?.click());
      await waitFor(() => expect(document.querySelector("[data-testid='ai-cohosted-prompt']")).toBeNull());
    };

    it("연결된 카드는 지금 답하는 모델을 말하고, 연결 전에는 모델을 읽지도 않는다", async () => {
      api.request.mockImplementation(serve(false));
      mount();
      await until("ai-cohosted-found");
      expect(calls().some((c) => c.endsWith("/models"))).toBe(false);
      act(() => root?.unmount());
      host?.remove();
      api.request.mockImplementation(serve(true));
      mount();
      const now = await until("ai-cohosted-model-select");
      expect(now.textContent).toBe("Claude Sonnet 5.5 · Anthropic");
    });

    it("연결 직후에는 「Hermes를 연결했어요」 다음에 「어떤 모델로 쓸까요?」를 묻고 초점이 그 구획으로 간다", async () => {
      api.request.mockImplementation(serve(false));
      mount();
      await until("ai-cohosted-found");
      await closePrompt();
      api.request.mockImplementation(serve(true));
      await act(async () => q("ai-cohosted-connect")?.click());
      await until("ai-cohosted-connected-notice");
      await until("ai-cohosted-model-select");
      expect(q("ai-cohosted-model")?.querySelector("h4")?.textContent).toBe("어떤 모델로 쓸까요?");
      expect(document.activeElement).toBe(q("ai-cohosted-model-anchor"));
    });

    it("이미 연결된 채 열면 묻지 않고 제목은 「모델」이다", async () => {
      api.request.mockImplementation(serve(true));
      mount();
      await until("ai-cohosted-model-select");
      expect(q("ai-cohosted-model")?.querySelector("h4")?.textContent).toBe("모델");
    });

    it("모델 구획이 보이지 않는 서버(403)에서는 연결 직후 초점이 연결됨 줄로 간다", async () => {
      const gone = () => Promise.reject(new ApiError(403, "no"));
      api.request.mockImplementation(serve(false, gone));
      mount();
      await until("ai-cohosted-found");
      await closePrompt();
      api.request.mockImplementation(serve(true, gone));
      await act(async () => q("ai-cohosted-connect")?.click());
      await until("ai-cohosted-connected");
      await waitFor(() => expect(document.activeElement).toBe(q("ai-cohosted-connected")));
      expect(q("ai-cohosted-model")).toBeNull();
    });

    it("모델 목록이 말한 로그인된 제공자는 모델 인증 블록에서 명령 없이 접힌다", async () => {
      api.request.mockImplementation((path: string, init?: RequestInit) =>
        path.includes("/model-login")
          ? Promise.reject(new ApiError(409, "off", "login_relay_off"))
          : serve(true)(path, init)
      );
      mount();
      await until("model-login-shell");
      await until("ai-cohosted-model-select");
      await waitFor(() => expect(q("model-login-in-anthropic")).not.toBeNull());
      const shell = q("model-login-shell");
      expect(shell?.textContent).not.toContain("hermes auth add anthropic");
      expect(shell?.textContent).toContain("hermes auth add openai-codex");
    });
  });

  describe("first-time prompt (#4113)", () => {
    const attested = (path: string, probe: object = PROBE) =>
      path.endsWith("/probe") ? Promise.resolve(probe) : Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: true });
    const promptEl = () => document.querySelector<HTMLElement>("[data-testid='ai-cohosted-prompt']");
    const press = async (id: string) => act(async () => document.querySelector<HTMLElement>(`[data-testid='${id}']`)?.click());

    it("asks once, then stays quiet after 'later' on a fresh mount; the card stays", async () => {
      api.request.mockImplementation((path: string) => attested(path));
      mount();
      await waitFor(() => expect(promptEl()).not.toBeNull());
      expect(promptEl()?.textContent).toContain("같은 서버에서 Hermes를 찾았어요. 연결할까요?");
      await press("ai-cohosted-prompt-later");
      await waitFor(() => expect(promptEl()).toBeNull());
      expect(calls().some((c) => c.startsWith("POST") && c.endsWith("/connect"))).toBe(false);
      act(() => root?.unmount());
      host?.remove();
      mount();
      await until("ai-cohosted-found");
      await act(async () => undefined);
      expect(promptEl()).toBeNull();
    });

    it("does not ask again after Esc, and asks again for another Hermes address", async () => {
      api.request.mockImplementation((path: string) => attested(path));
      mount();
      await waitFor(() => expect(promptEl()).not.toBeNull());
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await waitFor(() => expect(promptEl()).toBeNull());
      act(() => root?.unmount());
      host?.remove();
      mount();
      await until("ai-cohosted-found");
      expect(promptEl()).toBeNull();
      // 다른 Hermes 주소는 새 후보다.
      act(() => root?.unmount());
      host?.remove();
      api.request.mockImplementation((path: string) =>
        path.endsWith("/probe")
          ? Promise.resolve(PROBE)
          : Promise.resolve({ ...STATUS, toolsLockAttested: true, connectable: true, endpointLabel: "http://other:8642/v1" })
      );
      mount();
      await waitFor(() => expect(promptEl()).not.toBeNull());
    });

    it("connects from the prompt with one POST", async () => {
      api.request.mockImplementation((path: string) =>
        path.endsWith("/connect")
          ? Promise.resolve({ schema: "momo.cohosted_agent.connect.v0", agentId: "a1", displayName: "Hermes", handle: "hermes" })
          : attested(path)
      );
      mount();
      await waitFor(() => expect(promptEl()).not.toBeNull());
      await press("ai-cohosted-prompt-connect");
      await waitFor(() => expect(calls().filter((c) => c.startsWith("POST") && c.endsWith("/connect"))).toHaveLength(1));
      expect(promptEl()).toBeNull();
    });

    it("never asks when already connected, not connectable, unreachable, dangerous signal, offline or before attestation", async () => {
      const cases: Array<[string, (path: string) => Promise<unknown>, boolean]> = [
        ["connected", (p) => (p.endsWith("/probe") ? Promise.resolve(PROBE) : Promise.resolve({ ...STATUS, toolsLockAttested: true, connectedAgentId: "a1" })), false],
        ["not connectable", (p) => attested(p, { ...PROBE, connectable: false }), false],
        ["unreachable", (p) => attested(p, { ...PROBE, state: "unreachable", connectable: false }), false],
        ["dangerous signal", (p) => attested(p, { ...PROBE, toolsets: { signal: "dangerous_listed", listed: ["terminal"], proof: false } }), false],
        ["not attested", () => Promise.resolve(STATUS), false],
        ["offline", (p) => attested(p), true],
      ];
      for (const [name, impl, offline] of cases) {
        window.localStorage.clear();
        api.request.mockReset();
        api.request.mockImplementation(impl);
        mount(offline);
        await waitFor(() => expect(api.request).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 30));
        await act(async () => undefined);
        expect(promptEl(), name).toBeNull();
        act(() => root?.unmount());
        host?.remove();
        root = null;
      }
    });

    it("keeps the caution line to a real dangerous signal and folds the explanatory sentences under 자세히", async () => {
      api.request.mockImplementation((path: string) => attested(path));
      mount();
      await until("ai-cohosted-found");
      expect(q("ai-cohosted-toolsets-warn")).toBeNull();
      const more = q("ai-cohosted-more") as HTMLDetailsElement;
      expect(more.open).toBe(false);
      expect(more.textContent).toContain("자세히");
      expect(more.textContent).toContain("Hermes의 대화 기록");
      expect((q("ai-cohosted-found")?.textContent ?? "").replace(more.textContent ?? "", "")).not.toContain("평소처럼 채널에 초대해");
      expect(more.querySelector("summary")?.textContent).toBe("자세히");
    });
  });
});
