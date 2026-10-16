// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AgentProviderPinSection } from "./AgentProviderPinSection";

// #3875: 에이전트별 AI 연결 고정 선택기. 운영자가 아니거나 서버에 길이 없으면 절이 없고,
// 개인 에이전트에는 그리지 않으며, 저장은 참조 한 줄만 보내고, 풀리지 않는 고정은 문장으로 말한다.

const api = vi.hoisted(() => ({ request: vi.fn(), chain: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  settingsRequest: api.request,
  fetchProviderChain: api.chain,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const PIN_PATH = `/v1/workspaces/${WS}/agents/${AGENT}/provider-pin`;
const SCHEMA = "momo.agent.provider_pin.v0";

const CHAIN = {
  schema: "momo.provider_link.chain.v0",
  fallbackCount: 1,
  entries: [
    { position: 0, source: "provider_link", mode: "external-hermes", baseUrl: "https://a.example/v1", endpointLabel: "https://a.example/v1", enabled: true, bearerConfigured: true },
    { position: 1, source: "chain", mode: "external-hermes", baseUrl: "https://b.example/v1", endpointLabel: "https://b.example/v1", enabled: true, bearerConfigured: true },
  ],
};
const COHOSTED = {
  schema: "momo.cohosted_agent.status.v0",
  declaration: "ready",
  toolsLockAttested: true,
  connectable: true,
};

function agent(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: AGENT,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "intern",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    brain: "team_key",
    callableBy: "everyone",
    ...over,
  } as RosterMember;
}

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

function mount(member: RosterMember, offline = false): HTMLElement {
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
          SessionProvider,
          { value: sessionValue() },
          createElement(AgentProviderPinSection, { agent: member, offline })
        )
      )
    );
  });
  return host;
}

/** 길 별 답: pin 은 호출마다 `pin` 값을 읽는다. */
function serve(state: { pin: unknown; pinError?: ApiError }) {
  api.chain.mockResolvedValue(CHAIN);
  api.request.mockImplementation((path: string, init?: RequestInit) => {
    if (path === PIN_PATH && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { kind: string; linkPosition?: number };
      state.pin =
        body.kind === "default"
          ? null
          : { kind: body.kind, linkPosition: body.linkPosition, endpointLabel: "x", linkResolved: true, updatedAtMs: 2 };
      return Promise.resolve({ schema: SCHEMA, agentId: AGENT, pin: state.pin });
    }
    if (path === PIN_PATH) {
      return state.pinError ? Promise.reject(state.pinError) : Promise.resolve({ schema: SCHEMA, agentId: AGENT, pin: state.pin });
    }
    if (path.endsWith("/cohosted-agent")) return Promise.resolve(COHOSTED);
    return Promise.reject(new ApiError(404, "nope"));
  });
}

const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
async function until(id: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!q(id)) throw new Error(id);
  });
  return q(id) as HTMLElement;
}
const puts = () => api.request.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT");

beforeEach(() => {
  flags.IS_REACT_ACT_ENVIRONMENT = true;
  api.request.mockReset();
  api.chain.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AgentProviderPinSection", () => {
  it("is absent for a non-operator (403) and for a server without the route (404)", async () => {
    for (const status of [403, 404]) {
      api.request.mockReset();
      serve({ pin: null, pinError: new ApiError(status, "x") });
      const el = mount(agent());
      await waitFor(() => expect(api.request).toHaveBeenCalled());
      await act(async () => undefined);
      expect(el.querySelector("[data-testid='agent-pin-section']")).toBeNull();
      act(() => root?.unmount());
      el.remove();
      root = null;
    }
  });

  it("does not even ask for a personal or subscription agent", async () => {
    serve({ pin: null });
    const el = mount(agent({ callableBy: "owner_only", brain: "subscription" }));
    await act(async () => undefined);
    expect(el.querySelector("[data-testid='agent-pin-section']")).toBeNull();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("offers default, the same-server Hermes and the enabled team links, defaulting to following the team", async () => {
    serve({ pin: null });
    mount(agent());
    await until("agent-pin-section");
    await until("agent-pin-option-operator_env");
    await until("agent-pin-option-team_link:1");
    const keys = [...(host?.querySelectorAll("[data-testid^='agent-pin-option-']") ?? [])].map((el) => el.getAttribute("data-testid"));
    expect(keys).toEqual([
      "agent-pin-option-default",
      "agent-pin-option-operator_env",
      "agent-pin-option-team_link:0",
      "agent-pin-option-team_link:1",
    ]);
    expect((q("agent-pin-option-default")?.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(q("agent-pin-option-team_link:1")?.textContent).toContain("연결 2: https://b.example/v1");
    expect(q("agent-pin-save")?.hasAttribute("disabled")).toBe(true);
  });

  it("saves one reference and nothing else", async () => {
    serve({ pin: null });
    mount(agent());
    await until("agent-pin-option-operator_env");
    await act(async () => (q("agent-pin-option-operator_env")?.querySelector("input") as HTMLInputElement).click());
    await act(async () => q("agent-pin-save")?.click());
    await until("agent-pin-saved");
    expect(puts()).toHaveLength(1);
    expect(JSON.parse(String((puts()[0]?.[1] as RequestInit).body))).toEqual({ kind: "operator_env" });
  });

  it("team links stay locked until the agent owns its model, with the reason beside them", async () => {
    serve({ pin: null });
    mount(agent({ brain: "instance_default" }));
    const row = await until("agent-pin-option-team_link:0");
    expect((row.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(row.textContent).toContain("자기 모델을 정한 뒤");
  });

  it("says plainly that an unresolved pin does not fall over to another link", async () => {
    serve({
      pin: { kind: "team_link", linkPosition: 3, endpointLabel: "https://gone.example/v1", linkResolved: false, updatedAtMs: 1 },
    });
    mount(agent());
    const banner = await until("agent-pin-unresolved");
    expect(banner.textContent).toContain("다른 연결로 넘어가지 않고");
    expect(q("agent-pin-option-team_link:3")?.textContent).toContain("(바뀜)");
  });

  it("names the server's refusal in context when the save is refused", async () => {
    serve({ pin: null });
    mount(agent());
    await until("agent-pin-option-operator_env");
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? Promise.reject(new ApiError(409, "x", "agent_own_model_required"))
        : Promise.resolve({ schema: SCHEMA, agentId: AGENT, pin: null })
    );
    await act(async () => (q("agent-pin-option-operator_env")?.querySelector("input") as HTMLInputElement).click());
    await act(async () => q("agent-pin-save")?.click());
    const banner = await until("agent-pin-save-error");
    expect(banner.textContent).toContain("자기 모델");
  });

  it("locks the picker while offline, and says why", async () => {
    serve({ pin: null });
    mount(agent(), true);
    await until("agent-pin-offline");
    expect((q("agent-pin-options") as HTMLFieldSetElement).disabled).toBe(true);
    expect(q("agent-pin-save")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows an error with a retry when the server answered something unreadable", async () => {
    api.request.mockResolvedValue({ schema: "proxy" });
    mount(agent());
    await until("agent-pin-error");
  });
});
