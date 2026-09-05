import { createElement, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { Timeline } from "@/features/timeline/Timeline";
import { useTimeline } from "@/features/timeline/useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";
import { markFreshSignup } from "./freshSignup";
import {
  useWelcomeKickoff,
  welcomePlayEntrance,
} from "./useWelcomeKickoff";

/**
 * UX-R2b Chromium probe. Not a product route. Mounts the shipped Timeline +
 * useTimeline + useWelcomeKickoff chain so exit→arrival timestamps come off
 * the product wiring, not a test that adds `enter-conversation` itself.
 *
 * ChatShell wires arrival through `welcomePlayEntrance` (ChatShell.tsx next
 * to the Timeline `isPlayEntrance` binding). This harness mounts Timeline
 * directly — it cannot import ChatShell (Session + channel queries + shell
 * chrome). The shared helper is the same function ChatShell calls. A
 * ChatShell-only drop of that call is guarded by arrivalWiring.test.ts (S6b).
 */

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const HUMAN = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000201";
const OPENER_ID = "0199eeee-0000-7000-8000-000000000501";
const BACKLOG_ID = "0199eeee-0000-7000-8000-000000000401";

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
    _agentId: string,
    handlers: AgentHandlers
  ) => {
    agentRail.handlers = handlers;
    return () => {
      agentRail.handlers = null;
    };
  },
} as unknown as RealtimeHandle;

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
    displayName: "hermes",
    handle: "hermes",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const fullDirectory = makeDirectory([humanMember(), agentMember()]);
const emptyDirectory = makeDirectory([]);

function backlogAgentMessage(): Message {
  return {
    id: BACKLOG_ID,
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

type HarnessOpts = {
  directoryDelayMs: number;
  backlogAgent: boolean;
};

function readOpts(): HarnessOpts {
  const given = window.__welcomeKickoffOpts;
  return {
    directoryDelayMs: given?.directoryDelayMs ?? 0,
    backlogAgent: Boolean(given?.backlogAgent),
  };
}

const opts = readOpts();
const restMessages: Message[] = opts.backlogAgent ? [backlogAgentMessage()] : [];

window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/messages")) {
    return new Response(JSON.stringify({ messages: restMessages }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/reactions") || url.includes("/pins") || url.includes("/unfurls")) {
    return new Response(JSON.stringify({ reactions: [], pins: [], unfurls: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

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

function WelcomeTimeline(): ReactElement {
  const [directory, setDirectory] = useState(
    opts.directoryDelayMs > 0 ? emptyDirectory : fullDirectory
  );
  const [directoryStatus, setDirectoryStatus] = useState<
    "pending" | "success" | "error"
  >(opts.directoryDelayMs > 0 ? "pending" : "success");
  useEffect(() => {
    if (opts.directoryDelayMs <= 0) return;
    const timer = window.setTimeout(() => {
      setDirectory(fullDirectory);
      setDirectoryStatus("success");
    }, opts.directoryDelayMs);
    return () => window.clearTimeout(timer);
  }, []);
  const timeline = useTimeline(realtime, WS, CH, ME);
  const welcome = useWelcomeKickoff({
    workspaceId: WS,
    memberId: ME,
    channelKind: "public",
    channelName: "general",
    channelId: CH,
    timelineStatus:
      timeline.status === "error"
        ? "error"
        : timeline.status === "loading"
          ? "loading"
          : "ready",
    directoryStatus,
    messages: timeline.state.messages,
    directory,
    realtime,
  });
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory,
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

function wrap(node: ReactElement): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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

markFreshSignup({ workspaceId: WS, memberId: ME });

const root = document.getElementById("root");
if (!root) throw new Error("welcome kickoff harness missing #root");
createRoot(root).render(wrap(createElement(WelcomeTimeline)));

let stageSeenEver = false;
const seenWatch = new MutationObserver(() => {
  if (document.querySelector("[data-testid='welcome-kickoff-stage']")) {
    stageSeenEver = true;
  }
});
seenWatch.observe(document.documentElement, { subtree: true, childList: true });

window.__welcomeKickoff = {
  onSubscribed: () => {
    rail.handlers?.onSubscribed({ recovered: false });
  },
  deliverOpener: () => {
    rail.handlers?.onMessage({
      type: "message.new",
      v: 1,
      ts: Date.now(),
      seq: restMessages.length + 1,
      payload: {
        id: OPENER_ID,
        channel_id: CH,
        seq: restMessages.length + 1,
        hlc_ts: Date.now(),
        hlc_count: 0,
        author_member_id: AGENT,
        type: "text",
        body: "시작할까요? 이 워크스페이스에서 같이 일해요.",
        state: "sent",
        created_at_ms: Date.now(),
      },
    } as never);
  },
  stageSeenEver: () => stageSeenEver,
};

declare global {
  interface Window {
    __welcomeKickoffOpts?: {
      directoryDelayMs?: number;
      backlogAgent?: boolean;
      reducedMotion?: boolean;
    };
    __welcomeKickoff: {
      onSubscribed: () => void;
      deliverOpener: () => void;
      stageSeenEver: () => boolean;
    };
  }
}
