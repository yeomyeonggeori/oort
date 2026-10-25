// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentLiveness } from "@momo/core/lib/api";
import type { AgentLivenessLookup } from "@momo/core/features/agents/turnCopy";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { useAgentLivenessLookup } from "./useAgentLiveness";

const fetchLiveness = vi.fn<(ws: string, agent: string) => Promise<AgentLiveness>>();

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchAgentLiveness: (ws: string, a: string) => fetchLiveness(ws, a) };
});

// =============================================================================
// 여러 에이전트의 생존 판정을 한 함수로 (#4285). 대화 아래 활동 줄이 아무도 가져가지 않은 요청의
// 근거 줄 맨 앞에 서버의 경고를 싣는 데 쓴다. 지키는 것: ① 호스티드는 판정, 호스티드가 아니면(404)
// null, 아직 읽는 중이면 undefined ② 같은 쿼리 키라 다른 표면이 읽은 답을 나눠 쓴다 ③ 답이 같으면
// 같은 함수를 돌려준다 ④ 읽을 에이전트가 없으면 요청을 보내지 않는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
let latest: AgentLivenessLookup | null = null;
const identities: AgentLivenessLookup[] = [];

function Probe({ ids }: { ids: string[] }) {
  const lookup = useAgentLivenessLookup(ids);
  latest = lookup;
  identities.push(lookup);
  return null;
}

function tree(ids: string[]): ReactNode {
  const session = { workspaceId: WS } as unknown as SessionContextValue;
  return createElement(
    QueryClientProvider,
    { client },
    createElement(SessionProvider, { value: session }, createElement(Probe, { ids }))
  );
}

function mount(ids: string[]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(tree(ids)));
  return (next: string[]) => act(() => root?.render(tree(next)));
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  client?.clear();
  latest = null;
  identities.length = 0;
  fetchLiveness.mockReset();
});

describe("useAgentLivenessLookup", () => {
  it("호스티드는 판정, 호스티드가 아니면(404) null, 아직 읽는 중이면 undefined", async () => {
    fetchLiveness.mockImplementation(async (_ws, agent) => {
      if (agent === A) return { agentMemberId: A, state: "woken_not_collected" };
      if (agent === B) throw new ApiError(404, "not found");
      return new Promise<AgentLiveness>(() => {});
    });
    mount([A, B, "pending-agent"]);
    expect(latest?.(A)).toBeUndefined();
    await settle();
    expect(latest?.(A)?.state).toBe("woken_not_collected");
    expect(latest?.(B)).toBeNull();
    expect(latest?.("pending-agent")).toBeUndefined();
    // 와이어 id는 대소문자가 섞여 온다.
    expect(latest?.(A.toUpperCase())?.state).toBe("woken_not_collected");
  });

  it("다른 표면이 같은 키로 이미 읽은 답을 다시 묻지 않고 쓴다", async () => {
    fetchLiveness.mockResolvedValue({ agentMemberId: A, state: "responsive" });
    mount([A]);
    await settle();
    expect(fetchLiveness).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["agent-liveness", WS, A])).toEqual({
      agentMemberId: A,
      state: "responsive",
    });
  });

  it("답이 같으면 다시 그려도 같은 함수를 돌려준다", async () => {
    fetchLiveness.mockResolvedValue({ agentMemberId: A, state: "responsive" });
    const draw = mount([A]);
    await settle();
    const first = latest;
    draw([A]);
    draw([A]);
    expect(latest).toBe(first);
  });

  it("읽을 에이전트가 없으면 요청을 보내지 않는다", async () => {
    mount([]);
    await settle();
    expect(fetchLiveness).not.toHaveBeenCalled();
    expect(latest?.(A)).toBeUndefined();
  });
});
