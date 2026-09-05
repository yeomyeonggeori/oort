// @vitest-environment jsdom
// Product path: real Timeline + real useTimeline store + useWelcomeKickoff.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import {
  ENTER_CONVERSATION_CLASS,
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";
import { Timeline } from "@/features/timeline/Timeline";
import { useTimeline } from "@/features/timeline/useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";
import { markFreshSignup, peekFreshSignup, clearFreshSignup } from "./freshSignup";
import { useWelcomeKickoff, welcomePlayEntrance } from "./useWelcomeKickoff";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_BACKSTOP_MS,
  readShownMarker,
  welcomeShownKey,
  writeShownMarker,
} from "./welcomeKickoff";
import { AGENTS_NAV } from "@/features/sidebar/workspaceNav";
import { EMPTY_WRITE_ACTION_LABEL } from "@momo/core/features/timeline/model";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const HUMAN = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000201";
const OPENER_ID = "0199eeee-0000-7000-8000-000000000501";
const HUMAN_MSG_ID = "0199eeee-0000-7000-8000-000000000502";
const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

const virtuoso = vi.hoisted(() => ({
  data: [] as { kind: string; key: string }[],
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (
        index: number,
        item: { kind: string; key: string }
      ) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
    }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

const restPage = vi.hoisted(() => ({ messages: [] as Message[] }));

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

type ChannelHandlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
type AgentHandlers = Parameters<RealtimeHandle["subscribeAgent"]>[3];
const rail: { handlers: ChannelHandlers | null } = { handlers: null };
const agentRail: { handlers: AgentHandlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: ChannelHandlers) => {
    rail.handlers = handlers;
    return () => {
      rail.handlers = null;
    };
  },
  subscribeAgent: (
    _ws: string,
    _ch: string,
    _agent: string,
    handlers: AgentHandlers
  ) => {
    agentRail.handlers = handlers;
    return () => {
      agentRail.handlers = null;
    };
  },
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
let reducedMotion = false;

function detectChromium(): { ok: true } | { ok: false; path: string } {
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return { ok: false, path: exe };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      path: err instanceof Error ? err.message : String(err),
    };
  }
}

const chromiumAvailability = detectChromium();
const chromiumAvailable = chromiumAvailability.ok;
if (!chromiumAvailable) {
  console.warn(
    `welcome kickoff Chromium probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
  );
}

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
});

beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  restPage.messages = [];
  markFreshSignup({ workspaceId: WS, memberId: ME });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  rail.handlers = null;
  agentRail.handlers = null;
  restPage.messages = [];
  clearFreshSignup();
  localStorage.removeItem(welcomeShownKey(WS, ME));
  localStorage.removeItem(welcomeShownKey(OTHER_WS, ME));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function humanMember(): RosterMember {
  return {
    id: HUMAN,
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

function agentMember(): RosterMember {
  return {
    id: AGENT,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "kim-intern",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const directory = makeDirectory([humanMember(), agentMember()]);

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
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function wrap(node: ReactElement, client: QueryClient): ReactElement {
  return createElement(
    MemoryRouter,
    { initialEntries: [`/c/${CH}`] },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(QueryClientProvider, { client }, node)
      )
    )
  );
}

function WelcomeFed(props: {
  messages: Message[];
  directory?: ReturnType<typeof makeDirectory>;
  directoryStatus?: "pending" | "success" | "error";
}): ReactElement {
  const welcome = useWelcomeKickoff({
    workspaceId: WS,
    memberId: ME,
    channelKind: "public",
    channelName: "general",
    channelId: CH,
    timelineStatus: "ready",
    directoryStatus: props.directoryStatus ?? "success",
    messages: props.messages,
    directory: props.directory ?? directory,
    realtime,
  });
  return createElement(Timeline, {
    messages: props.messages,
    directory,
    status: "ready",
    reachedStart: true,
    channelKind: "public",
    channelName: "general",
    isPlayEntrance: () => false,
    welcomePhase: welcome.phase,
    welcomeReducedMotion: welcome.reducedMotion,
    welcomeHoldWriteAction: welcome.holdWriteAction,
    onWelcomeExitComplete: welcome.onExitComplete,
  });
}

function WelcomeTimeline(props: {
  channelKind?: string;
  channelName?: string;
  directory?: ReturnType<typeof makeDirectory>;
  directoryStatus?: "pending" | "success" | "error";
}): ReactElement {
  const timeline = useTimeline(realtime, WS, CH, ME);
  const resolvedDirectory = props.directory ?? directory;
  const welcome = useWelcomeKickoff({
    workspaceId: WS,
    memberId: ME,
    channelKind: props.channelKind ?? "public",
    channelName: props.channelName ?? "general",
    channelId: CH,
    timelineStatus:
      timeline.status === "error"
        ? "error"
        : timeline.status === "loading"
          ? "loading"
          : "ready",
    directoryStatus: props.directoryStatus ?? "success",
    messages: timeline.state.messages,
    directory: resolvedDirectory,
    realtime,
  });
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory: resolvedDirectory,
    status: timeline.status === "error" ? "error" : "ready",
    reachedStart: true,
    channelKind: "public",
    channelName: props.channelName ?? "general",
    isPlayEntrance: (id: string) =>
      welcomePlayEntrance(welcome.holdEntranceId, id, timeline.isPlayEntrance),
    onEntranceConsumed: timeline.consumeEntrance,
    welcomePhase: welcome.phase,
    welcomeReducedMotion: welcome.reducedMotion,
    welcomeHoldWriteAction: welcome.holdWriteAction,
    onWelcomeExitComplete: welcome.onExitComplete,
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountWelcome(over: {
  channelKind?: string;
  channelName?: string;
  directory?: ReturnType<typeof makeDirectory>;
  directoryStatus?: "pending" | "success" | "error";
} = {}): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    mountedRoot?.render(
      wrap(
        createElement(WelcomeTimeline, {
          channelKind: over.channelKind,
          channelName: over.channelName,
          directory: over.directory,
          directoryStatus: over.directoryStatus,
        }),
        client
      )
    );
  });
  await settle();
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: false });
  });
  await settle();
  return host;
}

function frame(id: string, author: string, seq: number, body: string) {
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
      author_member_id: author,
      type: "text",
      body,
      state: "sent",
      created_at_ms: Date.now(),
    },
  } as unknown as Parameters<NonNullable<ChannelHandlers["onMessage"]>>[0];
}

function entranceCount(root: HTMLElement): number {
  return [...root.querySelectorAll("[data-testid='timeline-message']")].filter(
    (node) =>
      node instanceof HTMLElement &&
      node.classList.contains(ENTER_CONVERSATION_CLASS)
  ).length;
}

function restAgentMessage(): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000401",
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: "text",
    body: "이미 있는 에이전트 메시지",
    state: "sent",
    createdAtMs: 1,
  };
}

describe("welcome kickoff product path", () => {
  it("opener arrives → stage exits, enter-conversation on exactly one row, seam cleared, shown-marker written", async () => {
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    await act(async () => {
      rail.handlers?.onMessage(
        frame(OPENER_ID, AGENT, 1, "시작할까요? 이 워크스페이스에서 같이 일해요.")
      );
    });
    await settle();
    const stage = root.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    expect(entranceCount(root)).toBe(0);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      stage?.dispatchEvent(event);
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(entranceCount(root)).toBe(1);
    expect(peekFreshSignup()).toBeNull();
    expect(readShownMarker(WS, ME)).toBe(true);
  });

  it("120s without an opener → guidance card; seam cleared and shown-marker written; later opener still exits the card", async () => {
    vi.useFakeTimers();
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(WELCOME_BACKSTOP_MS);
    });
    const card = root.querySelector("[data-testid='welcome-kickoff-backstop']");
    expect(card?.textContent).toContain(WELCOME_BACKSTOP_COPY);
    expect(card?.textContent).not.toMatch(/실패|오류|error|fail/i);
    expect((card?.textContent ?? "").split(AGENTS_NAV.label).length - 1).toBe(1);
    expect(peekFreshSignup()).toBeNull();
    expect(readShownMarker(WS, ME)).toBe(true);
    const link = card?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(AGENTS_NAV.to);
    expect(link?.textContent).toBe(AGENTS_NAV.label);
    await act(async () => {
      rail.handlers?.onMessage(
        frame(OPENER_ID, AGENT, 1, "설정 › AI 연결에서 연결하고 돌아오면 시작해요")
      );
    });
    await settle();
    const exiting = root.querySelector("[data-testid='welcome-kickoff-backstop']");
    expect(exiting?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      exiting?.dispatchEvent(event);
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-backstop']")).toBeNull();
    expect(entranceCount(root)).toBe(1);
  });

  it("120s without an opener → reload of #general shows no stage and no card replay", async () => {
    vi.useFakeTimers();
    await mountWelcome();
    await act(async () => {
      vi.advanceTimersByTime(WELCOME_BACKSTOP_MS);
    });
    expect(peekFreshSignup()).toBeNull();
    expect(readShownMarker(WS, ME)).toBe(true);
    vi.useRealTimers();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    host?.remove();
    host = null;
    rail.handlers = null;
    restPage.messages = [];
    const again = await mountWelcome();
    expect(again.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(again.querySelector("[data-testid='welcome-kickoff-backstop']")).toBeNull();
  });

  it("re-entry with shown-marker → no stage", async () => {
    writeShownMarker(WS, ME);
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
  });

  it("channel with an existing agent message → no stage", async () => {
    restPage.messages = [restAgentMessage()];
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
  });

  it("loaded message whose author the directory cannot resolve → no stage", async () => {
    restPage.messages = [restAgentMessage()];
    const root = await mountWelcome({
      directory: makeDirectory([humanMember()]),
      directoryStatus: "success",
    });
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
  });

  it("agent head replaced by an empty fetch still mounts the stage", async () => {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fed = (messages: Message[]) =>
      wrap(createElement(WelcomeFed, { messages }), client);
    await act(async () => {
      mountedRoot?.render(fed([restAgentMessage()]));
    });
    await settle();
    expect(host.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    await act(async () => {
      mountedRoot?.render(fed([]));
    });
    await settle();
    expect(
      host.querySelector("[data-testid='welcome-kickoff-stage']")
    ).not.toBeNull();
  });

  it("shown-marker for another workspace → stage still mounts", async () => {
    writeShownMarker(OTHER_WS, ME);
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
  });

  it("human message does not exit the stage", async () => {
    const root = await mountWelcome();
    await act(async () => {
      rail.handlers?.onMessage(frame(HUMAN_MSG_ID, HUMAN, 1, "안녕하세요"));
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")?.classList.contains(
      WELCOME_KICKOFF_EXIT_CLASS
    )).toBe(false);
    expect(peekFreshSignup()).not.toBeNull();
  });

  it("provider-required static agent message exits on the same path", async () => {
    const root = await mountWelcome();
    await act(async () => {
      rail.handlers?.onMessage(
        frame(
          OPENER_ID,
          AGENT,
          1,
          "설정 › AI 연결에서 연결하고 돌아오면 시작해요"
        )
      );
    });
    await settle();
    expect(
      root
        .querySelector("[data-testid='welcome-kickoff-stage']")
        ?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)
    ).toBe(true);
  });

  it("agent.partial frame exits the stage without a message yet", async () => {
    const root = await mountWelcome();
    await act(async () => {
      agentRail.handlers?.onEvent({
        type: "agent.partial",
        v: 1,
        ts: Date.now(),
        payload: {
          run_id: "0199eeee-0000-7000-8000-000000000601",
          channel_id: CH,
          text_delta: "시",
        },
      });
    });
    await settle();
    expect(
      root
        .querySelector("[data-testid='welcome-kickoff-stage']")
        ?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)
    ).toBe(true);
  });

  it("reduced-motion: no stagger custom property, immediate exit", async () => {
    reducedMotion = true;
    const root = await mountWelcome();
    const stage = root.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage).not.toBeNull();
    expect(stage?.querySelector("[data-stagger-index]")).toBeNull();
    await act(async () => {
      rail.handlers?.onMessage(
        frame(OPENER_ID, AGENT, 1, "시작할까요? 이 워크스페이스에서 같이 일해요.")
      );
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    // takeArrivalPlay returns false under reduced-motion (existing enter-conversation rule).
    expect(entranceCount(root)).toBe(0);
    expect(peekFreshSignup()).toBeNull();
  });

  it("not-default-channel does not mount the stage", async () => {
    const root = await mountWelcome({
      channelKind: "public",
      channelName: "엔진",
    });
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
  });

  it("agent backlog + pending directory → no stage; success with the agent still no stage", async () => {
    restPage.messages = [restAgentMessage()];
    const empty = makeDirectory([]);
    const root = await mountWelcome({
      directory: empty,
      directoryStatus: "pending",
    });
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    await act(async () => {
      mountedRoot?.render(
        wrap(
          createElement(WelcomeTimeline, {
            directory,
            directoryStatus: "success",
          }),
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        )
      );
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
  });

  it("empty channel + pending directory → no stage; roster success → stage then opener exits once", async () => {
    const empty = makeDirectory([]);
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let settleRoster: (() => void) | null = null;
    function DelayedRoster(): ReactElement {
      const [status, setStatus] = useState<"pending" | "success">("pending");
      const [dir, setDir] = useState(empty);
      useEffect(() => {
        settleRoster = () => {
          setDir(directory);
          setStatus("success");
        };
      }, []);
      return createElement(WelcomeTimeline, {
        directory: dir,
        directoryStatus: status,
      });
    }
    await act(async () => {
      mountedRoot?.render(wrap(createElement(DelayedRoster), client));
    });
    await settle();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });
    await settle();
    expect(host.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(host.querySelector("[data-testid='timeline-empty-primary']")).toBeNull();
    expect(host.textContent).not.toContain(EMPTY_WRITE_ACTION_LABEL);
    await act(async () => {
      settleRoster?.();
    });
    await settle();
    expect(host.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    expect(host.textContent).not.toContain(EMPTY_WRITE_ACTION_LABEL);
    await act(async () => {
      rail.handlers?.onMessage(
        frame(OPENER_ID, AGENT, 1, "시작할까요? 이 워크스페이스에서 같이 일해요.")
      );
    });
    await settle();
    const stage = host.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      stage?.dispatchEvent(event);
    });
    await settle();
    expect(host.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(entranceCount(host)).toBe(1);
  });

  it("stage mounted → no 첫 메시지 쓰기", async () => {
    const withStage = await mountWelcome();
    expect(withStage.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    expect(withStage.querySelector("[data-testid='timeline-empty-primary']")).toBeNull();
    expect(withStage.textContent).not.toContain(EMPTY_WRITE_ACTION_LABEL);
  });

  it("no marker → 첫 메시지 쓰기 CTA as before", async () => {
    clearFreshSignup();
    const root = await mountWelcome();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(root.querySelector("[data-testid='timeline-empty-primary']")?.textContent).toContain(
      EMPTY_WRITE_ACTION_LABEL
    );
  });

  it.skipIf(!chromiumAvailable)(
    "exit fill both: no frame above end opacity after animationend (Chromium)",
    async () => {
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        throw new Error(
          `playwright import failed after skipIf: ${err instanceof Error ? err.message : err}`
        );
      }
      const { compile } = await import("tailwindcss");
      const tokensPath = join(HERE, "../../design/tokens.css");
      const compiler = await compile(readFileSync(tokensPath, "utf8"), {
        base: dirname(tokensPath),
        loadStylesheet: async (id: string, base: string) => {
          if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
            const path = require_.resolve("tailwindcss/index.css");
            return {
              path,
              base: dirname(path),
              content: readFileSync(path, "utf8"),
            };
          }
          const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
          return { path, base: dirname(path), content: readFileSync(path, "utf8") };
        },
      });
      const css = compiler.build([WELCOME_KICKOFF_EXIT_CLASS]);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body>
            <div id="stage" class="${WELCOME_KICKOFF_EXIT_CLASS}">팀이 준비하고 있어요</div>
          </body></html>`
        );
        const measured = await page.evaluate(async () => {
          const stage = document.getElementById("stage");
          if (!stage) throw new Error("missing stage");
          return await new Promise<{ samples: number[]; maxAfterEnd: number }>(
            (resolve, reject) => {
              const timeout = window.setTimeout(
                () => reject(new Error("stage exit animationend did not fire")),
                2000
              );
              stage.addEventListener("animationend", (event) => {
                if (event.animationName !== "motion-fade-out") return;
                const samples: number[] = [];
                const sample = () => {
                  samples.push(Number(getComputedStyle(stage).opacity));
                  if (samples.length >= 8) {
                    window.clearTimeout(timeout);
                    resolve({
                      samples,
                      maxAfterEnd: Math.max(...samples),
                    });
                    return;
                  }
                  requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
              });
            }
          );
        });
        console.info(
          `welcome kickoff H1 fill-both maxAfterEnd=${measured.maxAfterEnd.toFixed(4)} samples=${measured.samples.map((n) => n.toFixed(4)).join(",")}`
        );
        expect(measured.maxAfterEnd).toBeLessThan(0.02);
      } finally {
        await browser.close();
      }
    },
    20_000
  );
});
