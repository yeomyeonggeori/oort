// @vitest-environment jsdom
// Same-tick live burst: Centrifugo delivers several publications in one
// WS frame. The rows that mount in that commit must all play — the grant
// cap only evicts leftovers that survived a commit without mounting.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { ENTER_CONVERSATION_CLASS } from "@/design/motion";
import { useTimeline } from "./useTimeline";
import { MessageRow } from "./MessageRow";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));

vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

const restPage = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => ({
      messages: restPage.messages,
      nextBefore: undefined,
    })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

type Handlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
const rail: { handlers: Handlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: Handlers) => {
    rail.handlers = handlers;
    return () => {
      rail.handlers = null;
    };
  },
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
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
  host?.remove();
  host = null;
  rail.handlers = null;
  restPage.messages = [];
});

function member(): RosterMember {
  return {
    id: OTHER,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "김인턴",
    handle: "intern-kim",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function wrap(node: ReactElement, client: QueryClient): ReactElement {
  return createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(QueryClientProvider, { client }, node)
    )
  );
}

function frame(id: string, seq: number) {
  return {
    type: "message.new",
    v: 1,
    ts: Date.now(),
    seq,
    payload: {
      id,
      channel_id: CH,
      seq,
      hlc_ts: Date.now(),
      hlc_count: 0,
      author_member_id: OTHER,
      type: "text",
      body: "새 메시지 도착 arrival",
      state: "sent",
      created_at_ms: Date.now(),
    },
  } as unknown as Parameters<NonNullable<Handlers["onMessage"]>>[0];
}

function BurstRows(): ReactElement {
  const timeline = useTimeline(realtime, WS, CH, ME);
  const directory = makeDirectory([member()]);
  return createElement(
    "div",
    null,
    timeline.state.messages.map((message) =>
      createElement(MessageRow, {
        key: message.id,
        message,
        startsGroup: true,
        directory,
        playEntrance: timeline.isPlayEntrance(message.id),
        onEntranceConsumed: () => timeline.consumeEntrance(message.id),
      })
    )
  );
}

describe("MessageRow same-tick live burst", () => {
  it("같은 틱 라이브 3건은 마운트된 행 3개가 모두 재생한다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      mountedRoot?.render(wrap(createElement(BurstRows), client));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });
    const ids = [
      "0199eeee-0000-7000-8000-000000000411",
      "0199eeee-0000-7000-8000-000000000412",
      "0199eeee-0000-7000-8000-000000000413",
    ];
    await act(async () => {
      rail.handlers?.onMessage(frame(ids[0], 21));
      rail.handlers?.onMessage(frame(ids[1], 22));
      rail.handlers?.onMessage(frame(ids[2], 23));
    });
    const playing = host.querySelectorAll(
      '[data-testid="timeline-message"][data-entrance-play="1"]'
    );
    expect(playing.length).toBe(3);
    for (const node of playing) {
      expect(node.classList.contains(ENTER_CONVERSATION_CLASS)).toBe(true);
    }
  });
});
