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
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
} from "@/design/motion";
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

function textMessage(id: string, seq: number): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "새 메시지 도착 arrival",
    state: "sent",
    createdAtMs: seq * 1000,
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

function mountRow(
  playEntrance: boolean,
  onEntranceConsumed?: () => void
): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    mountedRoot?.render(
      wrap(
        createElement(MessageRow, {
          message: textMessage("0199eeee-0000-7000-8000-000000000401", 1),
          startsGroup: true,
          directory: makeDirectory([member()]),
          playEntrance,
          onEntranceConsumed,
        }),
        client
      )
    );
  });
  return host;
}

function rowEl(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>('[data-testid="timeline-message"]');
  if (!el) throw new Error("missing timeline-message");
  return el;
}

function dispatchAnimationEnd(el: HTMLElement, animationName: string): void {
  act(() => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: animationName });
    el.dispatchEvent(event);
  });
}

describe("MessageRow arrival render seam", () => {
  it("playEntrance true 는 행 자신에 data-entrance-play=1 과 클래스를 싣는다", () => {
    const root = mountRow(true);
    const row = rowEl(root);
    expect(row.getAttribute("data-entrance-play")).toBe("1");
    expect(row.classList.contains(ENTER_CONVERSATION_CLASS)).toBe(true);
    const classedChildren = [...row.querySelectorAll(`.${ENTER_CONVERSATION_CLASS}`)];
    expect(classedChildren).toEqual([]);
  });

  it("playEntrance false 는 data-entrance-play 속성과 클래스가 없다", () => {
    const root = mountRow(false);
    const row = rowEl(root);
    expect(row.hasAttribute("data-entrance-play")).toBe(false);
    expect(row.classList.contains(ENTER_CONVERSATION_CLASS)).toBe(false);
  });

  it("animationName 일치 animationend 후 행에서 재생이 0 이다", () => {
    const root = mountRow(true);
    const row = rowEl(root);
    dispatchAnimationEnd(row, ENTER_CONVERSATION_ANIMATION_NAME);
    expect(row.getAttribute("data-entrance-play")).toBeNull();
    expect(row.classList.contains(ENTER_CONVERSATION_CLASS)).toBe(false);
  });

  it("다른 animationName 의 animationend 는 행 재생 1 을 유지한다", () => {
    const root = mountRow(true);
    const row = rowEl(root);
    dispatchAnimationEnd(row, "motion-fade-in");
    expect(row.getAttribute("data-entrance-play")).toBe("1");
    expect(row.classList.contains(ENTER_CONVERSATION_CLASS)).toBe(true);
  });

  it("첫 마운트에서 onEntranceConsumed 를 1회 호출한다", () => {
    const consumed: number[] = [];
    mountRow(true, () => consumed.push(1));
    expect(consumed.length).toBe(1);
  });

  it("playEntrance false 마운트는 소비 0", () => {
    const consumed: number[] = [];
    mountRow(false, () => consumed.push(1));
    expect(consumed.length).toBe(0);
  });
});
