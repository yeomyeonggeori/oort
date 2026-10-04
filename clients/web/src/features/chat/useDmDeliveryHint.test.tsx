// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { getAgentDmDelivery } from "@momo/core/features/hostedAgents/api";
import { makeDirectory } from "@/features/workspace/useWorkspace";
import { useDmDeliveryHint } from "./useDmDeliveryHint";

// =============================================================================
// #2891: 「멘션 없이 바로 말하면 …가 답합니다」는 서버가 이 DM을 전달할 때만.
// =============================================================================

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  getAgentDmDelivery: vi.fn(),
}));

const WS = "ws";
const DM = "dm";
const OWNER = "owner";
const AGENT = "agent";

function member(id: string, kind: "human" | "agent", displayName: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName,
    handle: displayName,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const agent = member(AGENT, "agent", "Claude Code");
const directory = makeDirectory([member(OWNER, "human", "성재"), agent]);

let root: Root;
let host: HTMLDivElement;
let seen: (string | null)[] = [];

function Probe() {
  seen.push(useDmDeliveryHint({ workspaceId: WS, channelId: DM, directory, dmAgent: agent }));
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  seen = [];
  host = document.createElement("div");
  root = createRoot(host);
  vi.mocked(getAgentDmDelivery).mockReset();
});
afterEach(() => act(() => root.unmount()));

async function settle() {
  const client = new QueryClient();
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useDmDeliveryHint", () => {
  it("promises nothing while the server has not answered, then follows it", async () => {
    vi.mocked(getAgentDmDelivery).mockResolvedValue({
      agentMemberId: AGENT,
      ownerMemberId: OWNER,
      state: "awaiting_owner",
    });
    await settle();
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe("성재님이 이 대화를 열어야 Claude Code가 답해요");
    expect(seen.some((hint) => hint?.includes("바로 말하면"))).toBe(false);
  });

  it("says the old sentence where the DM is open", async () => {
    vi.mocked(getAgentDmDelivery).mockResolvedValue({
      agentMemberId: AGENT,
      ownerMemberId: OWNER,
      state: "open",
    });
    await settle();
    expect(seen.at(-1)).toBe("멘션 없이 바로 말하면 Claude Code가 답해요");
  });

  it("promises nothing when the lookup fails for any other reason", async () => {
    const { ApiError } = await import("@momo/core/lib/api");
    vi.mocked(getAgentDmDelivery).mockRejectedValue(new ApiError(503, "unavailable"));
    await settle();
    expect(seen.at(-1)).toBeNull();
  });

  it("keeps the old sentence on a server without the route", async () => {
    const { ApiError } = await import("@momo/core/lib/api");
    vi.mocked(getAgentDmDelivery).mockRejectedValue(new ApiError(404, "not found"));
    await settle();
    expect(seen.at(-1)).toBe("멘션 없이 바로 말하면 Claude Code가 답해요");
  });
});
