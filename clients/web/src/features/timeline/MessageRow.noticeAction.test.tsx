// @vitest-environment jsdom
// #2871: the real MessageRow draws the in-app door a hosted skip notice
// carries, and only that door.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MemoryRouter } from "react-router-dom";
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

function member(): RosterMember {
  return {
    id: OTHER,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "Claude Code",
    handle: "intern-kim",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function notice(props: Record<string, unknown>): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000402",
    channelId: CH,
    seq: 2,
    hlcTs: 2,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "system",
    body: "Claude Code는 이 대화에서 답하도록 승인되지 않았어요. 설정 › 에이전트 자격에서 이 대화를 승인해 주세요.",
    state: "sent",
    createdAtMs: 2000,
    props,
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

function mountRow(message: Message): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        wrap(
          createElement(MessageRow, {
            message,
            startsGroup: true,
            directory: makeDirectory([member()]),
          }),
          client
        )
      )
    );
  });
  return host;
}

const HOSTED = {
  source: "server.hosted_agent.notice.v1",
  kind: "agent_hosted_skip",
  reason: "hosted_channel_unapproved",
  notice_action: { label: "에이전트 자격 열기", href: "/settings?section=agents" },
};

describe("MessageRow hosted skip notice door", () => {
  it("draws the door the server named under the sentence", () => {
    const root = mountRow(notice(HOSTED));
    const link = root.querySelector<HTMLAnchorElement>('[data-testid="notice-action"]');
    expect(link?.textContent).toBe("에이전트 자격 열기");
    expect(link?.getAttribute("href")).toBe("/settings?section=agents");
    expect(root.textContent).toContain("설정 › 에이전트 자격에서 이 대화를 승인해 주세요.");
  });

  it("draws nothing for a notice without a door or from another source", () => {
    const gate = mountRow(
      notice({ ...HOSTED, reason: "hosted_delivery_not_enabled", notice_action: undefined })
    );
    expect(gate.querySelector('[data-testid="notice-action"]')).toBeNull();
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    const other = mountRow(notice({ ...HOSTED, source: "someone.else" }));
    expect(other.querySelector('[data-testid="notice-action"]')).toBeNull();
  });
});
