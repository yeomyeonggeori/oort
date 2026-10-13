// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type AgentLiveness,
  type AgentLivenessState,
  type RosterMember,
} from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { HostedAgentConnection } from "@momo/core/features/hostedAgents/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AgentLivenessBar, AgentLivenessLabel } from "./AgentLivenessLabel";
import { resetWakeCooldowns } from "./wakeCooldownStore";

const fetchLiveness = vi.fn<(ws: string, agent: string) => Promise<AgentLiveness>>();
const ring = vi.fn<(ws: string, connection: string) => Promise<{ requestedAtMs: number; nextAllowedAtMs: number }>>();
const roster: { members: RosterMember[] } = { members: [] };
let connections: HostedAgentConnection[] = [];

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchAgentLiveness: (ws: string, a: string) => fetchLiveness(ws, a) };
});
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return {
    ...actual,
    ringHostedDoorbell: (ws: string, c: string) => ring(ws, c),
    listHostedConnections: async () => ({ connections: connections.map((c) => ({ ...c })) }),
  };
});
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({ directory: makeDirectory(roster.members) }),
  };
});

// =============================================================================
// 생존 라벨과 「다시 깨우기」 (ADR-0200 D4, #3749).
//
// 지키는 것: ① hosted가 아닌 에이전트(404)에는 아무것도 서지 않는다 ② 서버가 준
// 상태가 그대로 낱말이 된다 ③ 다시 깨우기는 owner/admin에게만, 눌러도 되는 상태에서만
// 서고 쿨다운이 보인다 ④ 429는 오류가 아니라 서버가 준 쿨다운이다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000301";
const CONN = "00000000-0000-7000-8000-000000000401";
const NOW = 1_800_000_000_000;

function person(role: "owner" | "admin" | "member"): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as unknown as RosterMember;
}

function connection(extra: Partial<HostedAgentConnection> = {}): HostedAgentConnection {
  return {
    id: CONN,
    agentMemberId: AGENT,
    status: "active",
    authMode: "static_bearer",
    audience: "https://x.test",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...extra,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(ui: ReactElement): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = {
    session: { member: { id: ME } },
    workspaceId: WS,
  } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: session }, ui)
      )
    );
  });
  return host;
}

// 라벨이 먼저 서고(1틱), 그 뒤에야 버튼이 연결 목록을 읽는다(2틱).
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
};

function answer(state: AgentLivenessState, minutesAgo?: number) {
  fetchLiveness.mockResolvedValue({
    agentMemberId: AGENT,
    state,
    ...(minutesAgo === undefined ? {} : { lastSignalAtMs: Date.now() - minutesAgo * 60_000 }),
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  fetchLiveness.mockReset();
  ring.mockReset();
  roster.members = [person("admin")];
  connections = [connection()];
  resetWakeCooldowns();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("생존 라벨", () => {
  it("hosted가 아닌 에이전트(404)에는 아무것도 서지 않는다", async () => {
    fetchLiveness.mockRejectedValue(new ApiError(404, "not found"));
    const el = mount(createElement(AgentLivenessLabel, { agentId: AGENT }));
    await settle();
    expect(el.querySelector('[data-testid="agent-liveness"]')).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("서버가 준 상태가 그대로 낱말이 된다", async () => {
    const cases: [AgentLivenessState, number | undefined, string][] = [
      ["responsive", 3, "응답함 3분 전"],
      ["alive_idle", 1, "살아 있음 · 대기 중"],
      ["work_waiting", undefined, "일이 기다리는 중"],
      ["woken_not_collected", undefined, "깨웠지만 아직 안 가져감"],
      ["unresponsive", 12, "응답 없음 12분"],
    ];
    for (const [state, minutes, text] of cases) {
      answer(state, minutes);
      const el = mount(createElement(AgentLivenessLabel, { agentId: AGENT }));
      await settle();
      const node = el.querySelector('[data-testid="agent-liveness"]');
      expect(node?.getAttribute("data-state")).toBe(state);
      expect(node?.textContent).toContain(text);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("좁은 자리는 한두 낱말이고, 접근성 이름은 뜻을 읽어 준다", async () => {
    answer("woken_not_collected");
    const el = mount(createElement(AgentLivenessLabel, { agentId: AGENT, variant: "compact" }));
    await settle();
    const node = el.querySelector('[data-testid="agent-liveness"]');
    expect(node?.querySelector(".truncate")?.textContent).toBe("안 가져감");
    expect(node?.querySelector(".sr-only")?.textContent).toContain("다시 깨울 수 있어요");
  });
});

describe("다시 깨우기", () => {
  const button = (el: HTMLElement) =>
    el.querySelector('[data-testid="wake-agent-button"]') as HTMLButtonElement | null;
  const status = (el: HTMLElement) =>
    (el.querySelector('[data-testid="wake-agent-status"]')?.textContent ?? "").trim();

  it("관리자에게 보이고, 누르면 접수되고 쿨다운이 선다", async () => {
    answer("woken_not_collected");
    ring.mockResolvedValue({ requestedAtMs: NOW, nextAllowedAtMs: NOW + 60_000 });
    const el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    expect(button(el)).not.toBeNull();
    expect(button(el)?.disabled).toBe(false);

    await act(async () => {
      button(el)?.click();
    });
    await settle();
    expect(ring).toHaveBeenCalledWith(WS, CONN);
    expect(button(el)?.disabled).toBe(true);
    expect(status(el)).toBe("60초 뒤에 다시 깨울 수 있어요");
  });

  it("owner/admin이 아니면 보이지 않는다: 라벨만 남는다", async () => {
    roster.members = [person("member")];
    answer("woken_not_collected");
    const el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    expect(el.querySelector('[data-testid="agent-liveness"]')).not.toBeNull();
    expect(button(el)).toBeNull();
  });

  it("이미 응답하는 에이전트와 켜져 있지 않은 연결에는 권하지 않는다", async () => {
    answer("responsive", 2);
    let el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    expect(button(el)).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    connections = [connection({ status: "expired" })];
    answer("unresponsive", 90);
    el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    expect(button(el)).toBeNull();
  });

  it("429는 오류가 아니라 서버가 준 쿨다운이다", async () => {
    answer("work_waiting");
    const { DoorbellRingLimitedError } = await import("@momo/core/features/hostedAgents/api");
    ring.mockRejectedValue(new DoorbellRingLimitedError(2700));
    const el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    await act(async () => {
      button(el)?.click();
    });
    await settle();
    expect(status(el)).toBe("45분 뒤에 다시 깨울 수 있어요");
    expect(status(el)).not.toContain("못했어요");
    expect(button(el)?.disabled).toBe(true);
  });

  it("그 밖의 거절은 이유를 말하고 버튼은 다시 눌 수 있다", async () => {
    answer("unresponsive", 90);
    ring.mockRejectedValue(new ApiError(409, "conflict"));
    const el = mount(createElement(AgentLivenessBar, { agentId: AGENT }));
    await settle();
    await act(async () => {
      button(el)?.click();
    });
    await settle();
    expect(status(el)).toContain("도어벨");
    expect(button(el)?.disabled).toBe(false);
  });
});
