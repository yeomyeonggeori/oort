// @vitest-environment jsdom
// #3955 (ADR-0205): the real MessageRow draws the GitHub notification strip, and only for
// the agent member named 「GitHub」.

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
const GITHUB = "00000000-0000-7000-8000-000000000a01";

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

function member(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: GITHUB,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "GitHub",
    handle: "github",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

const PROPS = {
  source: "github",
  github_author_member_id: GITHUB,
  github_event: "pull_request",
  github_action: "opened",
  github_repository: "yeomyeonggeori/oort",
  github_url: "https://github.com/yeomyeonggeori/oort/pull/12",
};

function githubMessage(props: Record<string, unknown> | undefined, author = GITHUB): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000501",
    channelId: CH,
    seq: 2,
    hlcTs: 2,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: "yeomyeonggeori/oort · @haneul님이 PR을 열었어요\n[#12 알림 설정 개선](https://github.com/yeomyeonggeori/oort/pull/12)",
    state: "sent",
    createdAtMs: 2000,
    ...(props ? { props } : {}),
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

function mountRowWith(message: Message, roster: RosterMember[]): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        wrap(
          createElement(MessageRow, { message, startsGroup: true, directory: makeDirectory(roster) }),
          client
        )
      )
    );
  });
  return host;
}

describe("MessageRow GitHub 알림 아랫줄 (ADR-0205, #3955)", () => {
  it("에이전트 「GitHub」가 보낸 알림에는 알림 칩, 소식, 열기 링크가 선다", () => {
    const root = mountRowWith(githubMessage(PROPS), [member()]);
    const strip = root.querySelector('[data-testid="github-notice"]');
    expect(strip?.textContent).toContain("GitHub 알림");
    expect(strip?.textContent).toContain("PR 열림");
    expect(strip?.getAttribute("aria-label")).toBe("GitHub 알림, yeomyeonggeori/oort, PR 열림");
    const open = root.querySelector<HTMLAnchorElement>('[data-testid="github-notice-open"]');
    expect(open?.getAttribute("href")).toBe("https://github.com/yeomyeonggeori/oort/pull/12");
    expect(open?.getAttribute("rel")).toContain("noopener");
    // 본문은 서버가 쓴 그대로 남는다. 사람인 척하는 말을 덧붙이지 않는다.
    expect(root.textContent).toContain("@haneul님이 PR을 열었어요");
  });

  it("사람이 같은 props 를 실어 보내도 줄이 서지 않는다", () => {
    const human = member({ id: OTHER, kind: "human", displayName: "GitHub", handle: "gh-human" });
    const root = mountRowWith(githubMessage(PROPS, OTHER), [human]);
    expect(root.querySelector('[data-testid="github-notice"]')).toBeNull();
  });

  it("다른 이름의 에이전트가 props 를 실어도 줄이 서지 않는다", () => {
    const hermes = member({ id: OTHER, displayName: "Hermes", handle: "hermes" });
    const root = mountRowWith(githubMessage(PROPS, OTHER), [hermes]);
    expect(root.querySelector('[data-testid="github-notice"]')).toBeNull();
  });

  it("props 가 없는 옛 서버의 메시지는 화면 변화가 없다", () => {
    const root = mountRowWith(githubMessage(undefined), [member()]);
    expect(root.querySelector('[data-testid="github-notice"]')).toBeNull();
  });

  it("https 가 아닌 주소는 링크가 되지 않지만 줄은 선다", () => {
    const root = mountRowWith(githubMessage({ ...PROPS, github_url: "javascript:alert(1)" }), [member()]);
    expect(root.querySelector('[data-testid="github-notice"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="github-notice-open"]')).toBeNull();
  });
});
