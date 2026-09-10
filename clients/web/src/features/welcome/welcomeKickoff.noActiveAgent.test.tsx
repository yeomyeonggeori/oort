// @vitest-environment jsdom
// SH-12d-w (#2335): 0 agents → FirstAgentStage ≤2s, backstop 0.
// 1 agent → kickoff hold + opener path unchanged.

import {
  act,
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import {
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";
import { Timeline } from "@/features/timeline/Timeline";
import { useTimeline } from "@/features/timeline/useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";
import { phoneLinkFirstRunIsPending } from "@/features/auth/phoneLinkFirstRunStore";
import { FirstAgentStage } from "./FirstAgentStage";
import { FIRST_AGENT_TITLE } from "./firstAgent";
import { WelcomeKickoffStage } from "./WelcomeKickoffStage";
import {
  clearAllFirstAgentMarkers,
} from "./firstAgentStore";
import { clearFreshSignup } from "./freshSignup";
import { recordFreshSignupFirstRun } from "./freshSignupFirstRun";
import {
  decideFirstRunForSession,
  peekKickoffSettled,
  resetKickoffHoldForTests,
  subscribeFirstRun,
  type FirstRunSurface,
} from "./firstRunGate";
import { useWelcomeKickoff, welcomePlayEntrance } from "./useWelcomeKickoff";
import { welcomeShownKey } from "./welcomeKickoff";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const MEMBER = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000201";
const OPENER_ID = "0199eeee-0000-7000-8000-000000000501";

/** Assert FirstAgentStage before the 120s backstop. Do not wait for it. */
const WITHIN_TWO_SECONDS_MS = 2_000;

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
    fetchRoster: vi.fn(async () => [] as RosterMember[]),
    listChannels: vi.fn(async () => [
      {
        id: CH,
        workspaceId: WS,
        name: "general",
        kind: "public",
        muted: false,
      },
    ]),
  };
});

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  listHostedConnections: vi.fn(async () => ({ connections: [] })),
  getHostedConnection: vi.fn(),
  createHostedConnection: vi.fn(),
  regenerateHostedPairing: vi.fn(),
  confirmHostedConnection: vi.fn(),
  disconnectHostedConnection: vi.fn(),
  acknowledgeHostedCleanupArtifact: vi.fn(),
  completeHostedDisconnect: vi.fn(),
  registerHostedDoorbell: vi.fn(),
  unregisterHostedDoorbell: vi.fn(),
}));

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(async () => ({
      schema: "momo.provider_link.v0",
      configured: false,
      source: "none",
      mode: "external-hermes",
      baseUrl: "",
      endpointLabel: "",
      bearerConfigured: false,
      availability: "unknown",
      keyConfigured: false,
      diagnostics: [] as string[],
    })),
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

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: MEMBER,
    workspaceId: WS,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let backstopSeen = 0;
let stopBackstop: { stop: () => void; flush: () => void } | null = null;

function humanMember(): RosterMember {
  return {
    id: MEMBER,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
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

function decide(): FirstRunSurface {
  return decideFirstRunForSession({
    workspaceId: WS,
    phonePending: phoneLinkFirstRunIsPending(),
  });
}

function sessionValue(): SessionContextValue {
  return {
    session,
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function wrap(node: ReactElement, client: QueryClient): ReactElement {
  return createElement(
    HashRouter,
    null,
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

function WelcomeTimeline(props: {
  directory: ReturnType<typeof makeDirectory>;
}): ReactElement {
  const timeline = useTimeline(realtime, WS, CH, MEMBER);
  const welcome = useWelcomeKickoff({
    workspaceId: WS,
    memberId: MEMBER,
    channelKind: "public",
    channelName: "general",
    channelId: CH,
    timelineStatus:
      timeline.status === "error"
        ? "error"
        : timeline.status === "loading"
          ? "loading"
          : "ready",
    directoryStatus: "success",
    messages: timeline.state.messages,
    directory: props.directory,
    realtime,
  });
  const pinArrivalGrant = timeline.pinArrivalGrant;
  useEffect(() => {
    pinArrivalGrant(welcome.holdEntranceId);
  }, [pinArrivalGrant, welcome.holdEntranceId]);
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory: props.directory,
    status: timeline.status === "error" ? "error" : "ready",
    reachedStart: true,
    channelKind: "public",
    channelName: "general",
    isPlayEntrance: (id: string) =>
      welcomePlayEntrance(welcome.holdEntranceId, id, timeline.isPlayEntrance),
    onEntranceConsumed: timeline.consumeEntrance,
    welcomePhase: welcome.phase,
    welcomeReducedMotion: welcome.reducedMotion,
    welcomeHoldWriteAction: welcome.holdWriteAction,
    onWelcomeExitComplete: welcome.onExitComplete,
  });
}

function AfterClaimSurface(props: {
  directory: ReturnType<typeof makeDirectory>;
}): ReactElement {
  useSyncExternalStore(subscribeFirstRun, peekKickoffSettled, peekKickoffSettled);
  const firstRun = decide();
  if (firstRun === "first-agent") {
    return createElement(FirstAgentStage, { onContinue: () => undefined });
  }
  return createElement(WelcomeTimeline, { directory: props.directory });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  stopBackstop?.flush();
}

function watchBackstop(root: HTMLElement): { stop: () => void; flush: () => void } {
  const seen = new Set<Element>();
  const count = (node: Element) => {
    if (seen.has(node)) return;
    seen.add(node);
    backstopSeen += 1;
  };
  const isBackstop = (node: Element) =>
    node.getAttribute("data-testid") === "welcome-kickoff-backstop";
  const scan = (node: Element) => {
    if (isBackstop(node)) count(node);
    for (const child of node.querySelectorAll(
      "[data-testid='welcome-kickoff-backstop']"
    )) {
      count(child);
    }
  };
  const ingest = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const el = mutation.target;
        if (!(el instanceof Element)) continue;
        if (isBackstop(el) || mutation.oldValue === "welcome-kickoff-backstop") {
          count(el);
        }
      }
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) scan(node);
        }
      }
    }
  };
  const observer = new MutationObserver(ingest);
  const flush = () => ingest(observer.takeRecords());
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-testid"],
    attributeOldValue: true,
  });
  scan(root);
  return {
    flush,
    stop: () => {
      flush();
      observer.disconnect();
    },
  };
}

async function mountAfterClaim(
  directory: ReturnType<typeof makeDirectory>
): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  stopBackstop?.stop();
  stopBackstop = watchBackstop(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    mountedRoot?.render(
      wrap(createElement(AfterClaimSurface, { directory }), client)
    );
  });
  await settle();
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: false });
  });
  await settle();
  stopBackstop.flush();
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

function resetFirstRunState() {
  sessionStorage.clear();
  clearAllFirstAgentMarkers();
  clearFreshSignup();
  resetKickoffHoldForTests();
  localStorage.removeItem(welcomeShownKey(WS, MEMBER));
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
  backstopSeen = 0;
  restPage.messages = [];
  resetFirstRunState();
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
  stopBackstop?.stop();
  stopBackstop = null;
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  rail.handlers = null;
  agentRail.handlers = null;
  restPage.messages = [];
  resetFirstRunState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("no-active-agent hold (#2335)", () => {
  it("0 agents after claim/login: FirstAgentStage within 2s, backstop 0 times", async () => {
    vi.useFakeTimers();
    recordFreshSignupFirstRun(session);
    expect(decide()).toBe("kickoff-hold");

    const root = await mountAfterClaim(makeDirectory([humanMember()]));

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(WITHIN_TWO_SECONDS_MS);
    });
    await settle();

    expect(root.querySelector("[data-testid='first-agent-stage']")).not.toBeNull();
    expect(root.textContent).toContain(FIRST_AGENT_TITLE);
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(root.querySelectorAll("[data-testid='welcome-kickoff-backstop']")).toHaveLength(
      0
    );
    expect(backstopSeen).toBe(0);
    expect(decide()).toBe("first-agent");
  });

  it("1 agent: hold kept, kickoff stage mounts, opener still exits the stage", async () => {
    vi.useFakeTimers();
    recordFreshSignupFirstRun(session);
    expect(decide()).toBe("kickoff-hold");

    const root = await mountAfterClaim(
      makeDirectory([humanMember(), agentMember()])
    );

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(WITHIN_TWO_SECONDS_MS);
    });
    await settle();

    expect(decide()).toBe("kickoff-hold");
    expect(peekKickoffSettled()).toBe(false);
    expect(root.querySelector("[data-testid='first-agent-stage']")).toBeNull();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).not.toBeNull();
    expect(root.querySelectorAll("[data-testid='welcome-kickoff-backstop']")).toHaveLength(
      0
    );

    await act(async () => {
      rail.handlers?.onMessage(
        frame(OPENER_ID, AGENT, 1, "시작할까요? 이 워크스페이스에서 같이 일해요.")
      );
    });
    await settle();
    const stage = root.querySelector("[data-testid='welcome-kickoff-stage']");
    expect(stage?.classList.contains(WELCOME_KICKOFF_EXIT_CLASS)).toBe(true);
    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
      });
      stage?.dispatchEvent(event);
    });
    await settle();
    expect(root.querySelector("[data-testid='welcome-kickoff-stage']")).toBeNull();
    expect(root.querySelector("[data-testid='welcome-kickoff-backstop']")).toBeNull();
    expect(backstopSeen).toBe(0);
  });

  it("observer before mount counts a 1-frame backstop flash (#2356)", async () => {
    host = document.createElement("div");
    document.body.append(host);
    stopBackstop = watchBackstop(host);
    mountedRoot = createRoot(host);

    function FlashThenClear(): ReactElement {
      const [phase, setPhase] = useState<"stage" | "backstop">("backstop");
      useLayoutEffect(() => {
        setPhase("stage");
      }, []);
      return createElement(WelcomeKickoffStage, {
        phase,
        reducedMotion: true,
        onExitComplete: () => undefined,
      });
    }

    await act(async () => {
      mountedRoot?.render(
        createElement(HashRouter, null, createElement(FlashThenClear))
      );
    });
    await settle();
    expect(backstopSeen).toBeGreaterThan(0);
    expect(host.querySelector("[data-testid='welcome-kickoff-backstop']")).toBeNull();
  });
});
