// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { MemberRow } from "./MemberRow";

// The directory row (#4692): who is connected, said by the avatar-corner dot and
// carried into the row's accessible name. There was no render test of this row
// before (the model tests cover the label function, not what the row draws), so
// this is a new file for an existing target.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const PEER = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000103";

// An agent row also draws a liveness chip, which reads its own endpoint. This
// test is about the person's dot, so the chip is stood down.
vi.mock("@/features/agents/AgentLivenessLabel", () => ({
  AgentLivenessLabel: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function sessionValue(connStatus: SessionContextValue["connStatus"]): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function render(
  row: RosterMember,
  connStatus: SessionContextValue["connStatus"] = "connected"
): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(workspaceIdentityKey(WS), {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 0,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: sessionValue(connStatus) },
          createElement(
            "ul",
            null,
            createElement(MemberRow, {
              member: row,
              directory: makeDirectory([row]),
              selfMemberId: ME,
              onOpenProfile: () => undefined,
            })
          )
        )
      )
    )
  );
  return host;
}

const dot = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="presence-dot"]');
const name = (el: HTMLElement) =>
  el.querySelector('[data-testid="directory-row"]')?.getAttribute("aria-label") ?? "";

describe("MemberRow: a person's availability (#4692)", () => {
  it("a connected person has a filled green dot and the word in the accessible name", () => {
    const el = render(member({ id: PEER, online: true }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("ok");
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 온라인, 프로필 열기");
  });

  it("a person with no connection has the hollow ring, and the name says 오프라인", () => {
    const el = render(member({ id: PEER, online: false }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("muted");
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 오프라인, 프로필 열기");
  });

  it("a declared pause is drawn and named instead of the connection", () => {
    const el = render(member({ id: PEER, online: true, presenceStatus: "dnd" }));
    expect(dot(el)?.getAttribute("data-tone")).toBe("danger");
    expect(name(el)).toContain("방해 금지");
    expect(name(el)).not.toContain("온라인");
  });

  it("unknown availability draws no dot and says nothing: the row reads as it did before", () => {
    const el = render(member({ id: PEER }));
    expect(dot(el)).toBeNull();
    expect(name(el)).toBe("이도현 @dohyun, 멤버, 프로필 열기");
  });

  it("an agent row has no person's dot, even if it carries `online`", () => {
    const el = render(
      member({ id: AGENT, kind: "agent", displayName: "김인턴", handle: "kim-intern", online: true })
    );
    expect(dot(el)).toBeNull();
    expect(name(el)).not.toContain("온라인");
  });

  it("the viewer's own row is as online as this client's connection, whatever the broker says", () => {
    const own = member({ id: ME, displayName: "박서연", handle: "seoyeon" });
    const connected = render(own, "connected");
    expect(dot(connected)?.getAttribute("data-tone")).toBe("ok");
    expect(name(connected)).toBe("박서연 @seoyeon, 멤버, 온라인, 나, 프로필 열기");
    act(() => root?.unmount());
    root = null;
    host?.remove();
    const cut = render({ ...own, online: true }, "disconnected");
    expect(dot(cut)?.getAttribute("data-tone")).toBe("muted");
    expect(name(cut)).toContain("오프라인");
  });
});
