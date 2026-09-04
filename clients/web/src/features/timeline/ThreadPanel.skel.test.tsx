// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT_ID = "00000000-0000-7000-8000-000000000301";
const AUTHOR = "00000000-0000-7000-8000-000000000101";

const replies = vi.hoisted(() => ({
  pending: false,
  result: { messages: [] as Message[] },
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchThreadReplies: () =>
      replies.pending
        ? new Promise(() => {})
        : Promise.resolve(replies.result),
  };
});

vi.mock("./MessageRow", () => ({
  MessageRow: () => createElement("div", { "data-testid": "thread-root-row" }),
}));

vi.mock("./ThreadComposer", () => ({
  ThreadComposer: () => null,
}));

vi.mock("./timelineLiveRegion", () => ({
  TimelineLiveRegionProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function rootMessage(): Message {
  return {
    id: ROOT_ID,
    channelId: CH,
    seq: 1,
    authorMemberId: AUTHOR,
    body: "이 스레드의 첫 글",
    type: "text",
    state: "sent",
    createdAtMs: 1_800_000_000_000,
    hlcTs: 1_800_000_000_000,
    hlcCount: 0,
  };
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(ThreadPanel, {
      workspaceId: WS,
      channelId: CH,
      root: rootMessage(),
      directory: makeDirectory([]),
      channels: [],
      onClose: () => undefined,
    })
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  replies.pending = false;
  replies.result = { messages: [] };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

describe("ThreadPanel skeleton host", () => {
  it("wraps the empty replies invite inside Skeleton (moving it out turns this red)", async () => {
    const host = await mount();
    const empty = await vi.waitFor(() => {
      const node = host.querySelector('[data-testid="thread-empty"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const skel = host.querySelector(
      '[data-testid="thread-replies"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.contains(empty)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while replies are loading (ready={true} turns this red)", async () => {
    replies.pending = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="thread-replies"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});
