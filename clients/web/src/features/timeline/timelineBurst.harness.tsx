import { createElement, type ReactElement } from "react";
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

/**
 * Chromium burst probe. Not a product route. Mounts the shipped Timeline +
 * useTimeline so same-tick cap / scrolled-up leftover / jump-latest play
 * counts come off real virtuoso geometry, not jsdom stubbed scrollHeight.
 */

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

type ChannelHandlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];

const rail: { handlers: ChannelHandlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: ChannelHandlers) => {
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

function restMessage(seq: number): Message {
  return {
    id: `0199aaaa-0000-7000-8000-0000000001${String(seq).padStart(2, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `히스토리 행 ${seq}`,
    state: "sent",
    createdAtMs: seq,
  };
}

type HarnessOpts = { history: number };

function readOpts(): HarnessOpts {
  const given = window.__timelineBurstOpts;
  return { history: given?.history ?? 8 };
}

const opts = readOpts();
const restMessages: Message[] = Array.from({ length: opts.history }, (_, i) =>
  restMessage(i + 1)
);

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

function BurstTimeline(): ReactElement {
  const timeline = useTimeline(realtime, WS, CH, ME);
  window.__timelineBurstIsPlay = timeline.isPlayEntrance;
  const directory = makeDirectory([member()]);
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory,
    status: timeline.status === "error" ? "error" : "ready",
    reachedStart: true,
    isPlayEntrance: timeline.isPlayEntrance,
    onEntranceConsumed: timeline.consumeEntrance,
    capUnmountedArrivals: timeline.capUnmountedArrivals,
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

const root = document.getElementById("root");
if (!root) throw new Error("timeline burst harness missing #root");
createRoot(root).render(wrap(createElement(BurstTimeline)));

let arrivalStarts = 0;
document.addEventListener(
  "animationstart",
  (event) => {
    if (event.animationName === "motion-enter-conversation") {
      arrivalStarts += 1;
    }
  },
  true
);

function frame(id: string, seq: number, body: string) {
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
      body,
      state: "sent",
      created_at_ms: Date.now(),
    },
  } as never;
}

window.__timelineBurst = {
  onSubscribed: () => {
    rail.handlers?.onSubscribed({ recovered: false });
  },
  deliverLive: (ids, seqStart, body) => {
    ids.forEach((id, i) => {
      rail.handlers?.onMessage(frame(id, seqStart + i, `${body} ${i + 1}`));
    });
  },
  arrivalStarts: () => arrivalStarts,
  playCount: (ids) =>
    ids.filter((id) => window.__timelineBurstIsPlay?.(id)).length,
  playIds: (ids) => ids.filter((id) => window.__timelineBurstIsPlay?.(id)),
};

declare global {
  interface Window {
    __timelineBurstOpts?: { history?: number };
    __timelineBurst: {
      onSubscribed: () => void;
      deliverLive: (ids: readonly string[], seqStart: number, body: string) => void;
      arrivalStarts: () => number;
      playCount: (ids: readonly string[]) => number;
      playIds: (ids: readonly string[]) => string[];
    };
    __timelineBurstIsPlay?: (id: string) => boolean;
  }
}
