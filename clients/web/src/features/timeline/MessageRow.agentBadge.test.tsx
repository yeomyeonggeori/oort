// @vitest-environment jsdom
// Render the real MessageRow and assert the grant→class seam on the row
// element. arrivalWiring.test.ts greps cannot see substitutions (B9),
// relocations (B12), or a second ChatShell consume binding going missing.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";

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
});

const AGENT = "00000000-0000-7000-8000-000000000102";

function roster(id: string, kind: "human" | "agent", name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function msg(author: string): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000501",
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: "안녕하세요",
    state: "sent",
    createdAtMs: 1000,
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

function mount(author: string): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    mountedRoot?.render(
      wrap(
        createElement(MessageRow, {
          message: msg(author),
          startsGroup: true,
          directory: makeDirectory([
            roster(OTHER, "human", "김인턴", "intern-kim"),
            roster(AGENT, "agent", "그록", "grok"),
          ]),
        }),
        client
      )
    );
  });
  return host;
}

describe("메시지 이름 옆 「에이전트」 배지 제거 (#4065)", () => {
  it("에이전트 작성자 줄에 눈에 보이는 「에이전트」 배지가 없다", () => {
    const root = mount(AGENT);
    const visible = [...root.querySelectorAll("*")].filter(
      (el) => !el.closest(".sr-only") && el.children.length === 0
    );
    expect(visible.map((el) => el.textContent)).not.toContain("에이전트");
    expect(root.querySelector('[data-testid="row-avatar"]')?.getAttribute("data-avatar-kind")).toBe("agent");
  });

  it("에이전트임은 낭독 전용 낱말로 남는다", () => {
    const root = mount(AGENT);
    const sr = root.querySelector('[data-testid="row-agent-sr"]');
    expect(sr?.className).toContain("sr-only");
    expect(sr?.textContent).toContain("에이전트");
  });

  it("사람 작성자에는 낭독 낱말이 없다", () => {
    const root = mount(OTHER);
    expect(root.querySelector('[data-testid="row-agent-sr"]')).toBeNull();
  });
});
