// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT_A = "00000000-0000-7000-8000-000000000301";
const AUTHOR = "00000000-0000-7000-8000-000000000101";

const reducedMotion = vi.hoisted(() => ({ current: true }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = (await importOriginal()) as { [key: string]: unknown };
  return {
    ...actual,
    useReducedMotion: () => reducedMotion.current,
  };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchThreadReplies: () => Promise.resolve({ messages: [] }),
  };
});

vi.mock("./MessageRow", () => ({
  MessageRow: ({ message }: { message: Message }) =>
    createElement("div", {
      "data-testid": "thread-root-row",
      "data-root-id": message.id,
    }),
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

function message(id: string): Message {
  return {
    id,
    channelId: CH,
    seq: 1,
    authorMemberId: AUTHOR,
    body: "첫 글",
    type: "text",
    state: "sent",
    createdAtMs: 1_800_000_000_000,
    hlcTs: 1_800_000_000_000,
    hlcCount: 0,
  };
}

function Host({ initial }: { initial: Message | null }) {
  const [root, setRoot] = useState<Message | null>(initial);
  return createElement(ThreadPanel, {
    workspaceId: WS,
    channelId: CH,
    root,
    directory: makeDirectory([]),
    channels: [],
    onClose: () => setRoot(null),
  });
}

async function mount(initial: Message | null): Promise<HTMLElement> {
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
    createElement(Host, { initial })
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
  reducedMotion.current = true;
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        animationDuration: `${150}ms`,
        getPropertyValue: () => "",
      }) as unknown as CSSStyleDeclaration
  );
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThreadPanel reduced-motion (#1997 N-2)", () => {
  it("detaches within one frame even when computed duration is the CSS exit", async () => {
    const host = await mount(message(ROOT_A));
    expect(host.querySelector("[data-testid='thread-panel']")).not.toBeNull();
    await act(async () => {
      (host.querySelector("[data-testid='thread-close']") as HTMLButtonElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(host.querySelector("[data-testid='thread-panel']")).toBeNull();
  });
});
