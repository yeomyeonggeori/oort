// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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
            createElement(CohostedAgentCard, { offline, workspaceId: WS })
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
  api.request.mockReset();
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
    expect(found.textContent).toContain("같은 서버의 Hermes를 찾았어요, 연결할까요?");
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
    expect(done.textContent).toContain("Hermes가 연결돼 있어요.");
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
});
