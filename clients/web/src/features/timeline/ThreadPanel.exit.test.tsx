// @vitest-environment jsdom

import {
  act,
  createElement,
  useState,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ThreadPanel } from "./ThreadPanel";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT_A = "00000000-0000-7000-8000-000000000301";
const ROOT_B = "00000000-0000-7000-8000-000000000302";
const AUTHOR = "00000000-0000-7000-8000-000000000101";

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
    body: id === ROOT_A ? "첫 글" : "다른 스레드",
    type: "text",
    state: "sent",
    createdAtMs: 1_800_000_000_000,
    hlcTs: 1_800_000_000_000,
    hlcCount: 0,
  };
}

function Host({ initial }: { initial: Message | null }) {
  const [root, setRoot] = useState<Message | null>(initial);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "open-a",
        onClick: () => setRoot(message(ROOT_A)),
      },
      "A"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "open-b",
        onClick: () => setRoot(message(ROOT_B)),
      },
      "B"
    ),
    createElement(ThreadPanel, {
      workspaceId: WS,
      channelId: CH,
      root,
      directory: makeDirectory([]),
      channels: [],
      onClose: () => setRoot(null),
    })
  );
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
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
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
        animationDuration: `${180}ms`,
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

describe("ThreadPanel exit does not own parent state (#1997 B-1)", () => {
  it("opening a second root during the exit renders that root", async () => {
    const host = await mount(message(ROOT_A));
    expect(host.querySelector("[data-testid='thread-panel']")).not.toBeNull();
    expect(
      host.querySelector("[data-testid='thread-root-row']")?.getAttribute("data-root-id")
    ).toBe(ROOT_A);

    const close = host.querySelector("[data-testid='thread-close']");
    expect(close).not.toBeNull();
    await act(async () => {
      (close as HTMLButtonElement).click();
    });
    // Exit is in flight (fallback held by fake timers). Parent is
    // already closed; a new open must interrupt rather than be cleared by a
    // stale onExitComplete.
    expect(host.querySelector("[data-testid='thread-panel']")).not.toBeNull();

    await act(async () => {
      (host.querySelector("[data-testid='open-b']") as HTMLButtonElement).click();
    });

    const panel = host.querySelector(
      `[data-testid='thread-panel'][data-root-id='${ROOT_B}']`
    );
    const panels = host.querySelectorAll("[data-testid='thread-panel']");
    expect(panels).toHaveLength(1);
    expect(
      host.querySelector(`[data-testid='thread-panel'][data-root-id='${ROOT_A}']`)
    ).toBeNull();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-root-id")).toBe(ROOT_B);
    expect(
      panel?.querySelector("[data-testid='thread-root-row']")?.getAttribute("data-root-id")
    ).toBe(ROOT_B);
  });
});
