import { createElement, useState, type ReactElement } from "react";
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
 * 옛 쪽 읽기 시험대(#5662). 제품 경로가 아니다. 실제 `Timeline` + `useTimeline` 을 `ChatShell` 과 같은 선으로 잇고
 * (`onStartReached = loadOlder`, `reachedStart`, 옛 쪽 실패 줄), 가짜 `fetch` 가 대화 셋을 답한다:
 * - `general` — 메시지 0개(머리말 한 줄). 로그인 뒤 첫 화면 자리.
 * - `long` — 300줄. 첫 쪽 50줄, `before=` 마다 50줄.
 * - `short` — 첫 쪽이 4줄인데 더 옛 글이 있다(`nextBefore`). 진입 직후 이미 맨 위에 닿은 대화.
 * 시험은 `window.__timelineOlder` 로 대화를 바꾸고, 다음 옛 쪽 읽기를 망 오류로 끊고, 옛 쪽 읽기 기록을 읽는다.
 */

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const CHANNELS = {
  general: "00000000-0000-7000-8000-00000000c001",
  long: "00000000-0000-7000-8000-00000000c002",
  short: "00000000-0000-7000-8000-00000000c003",
} as const;
type ChannelName = keyof typeof CHANNELS;
const TOTAL: Record<ChannelName, number> = { general: 0, long: 300, short: 120 };
const HEAD: Record<ChannelName, number> = { general: 0, long: 50, short: 4 };
const PAGE = 50;

const realtime = {
  subscribeChannel: () => () => undefined,
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
    displayName: "Dohyun Kim",
    handle: "dohyun-kim",
    role: "member",
    channelCount: 3,
    channelIds: Object.values(CHANNELS),
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function message(name: ChannelName, seq: number): Message {
  const channel = CHANNELS[name];
  return {
    id: `0199bbbb-0000-7000-8000-${channel.slice(-4)}${String(seq).padStart(8, "0")}`,
    channelId: channel,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: [name, seq].join(" "),
    state: "sent",
    // 1분 간격 — 묶음이 줄마다 머리를 세워 줄 높이가 고르다.
    createdAtMs: 1_762_000_000_000 + seq * 60_000,
  };
}

/** `before` 아래(없으면 맨 끝부터) `limit` 줄. 내림차순, 더 옛 줄이 있으면 `nextBefore`. */
function page(name: ChannelName, before: number | null, limit: number) {
  const top = before === null ? TOTAL[name] : before - 1;
  const low = Math.max(1, top - limit + 1);
  const messages: Message[] = [];
  for (let seq = top; seq >= low; seq -= 1) messages.push(message(name, seq));
  return { messages, ...(low > 1 && messages.length > 0 ? { nextBefore: low } : {}) };
}

type OlderRequest = { at: number; channel: ChannelName; before: number; outcome: "ok" | "failed" | "pending" };

const control = {
  failOlder: 0,
  olderDelayMs: 60,
  headDelayMs: 0,
  requests: [] as OlderRequest[],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "https://example.test");
  const match = /\/channels\/([0-9a-f-]+)\/messages$/.exec(url.pathname);
  if (match) {
    const name = (Object.keys(CHANNELS) as ChannelName[]).find((key) => CHANNELS[key] === match[1]);
    if (!name) return json({ messages: [] });
    if (url.searchParams.has("after")) return json({ messages: [] });
    const beforeParam = url.searchParams.get("before");
    if (beforeParam === null) {
      if (control.headDelayMs > 0) await sleep(control.headDelayMs);
      return json(page(name, null, HEAD[name]));
    }
    const entry: OlderRequest = {
      at: Math.round(performance.now()),
      channel: name,
      before: Number(beforeParam),
      outcome: "pending",
    };
    control.requests.push(entry);
    await sleep(control.olderDelayMs);
    if (control.failOlder > 0) {
      control.failOlder -= 1;
      entry.outcome = "failed";
      // 브라우저의 망 오류와 같은 모양(`fetch` 가 TypeError 로 거부한다).
      throw new TypeError("Failed to fetch");
    }
    entry.outcome = "ok";
    return json(page(name, Number(beforeParam), Number(url.searchParams.get("limit") ?? PAGE)));
  }
  if (url.pathname.includes("/reactions") || url.pathname.includes("/pins") || url.pathname.includes("/unfurls")) {
    return json({ reactions: [], pins: [], unfurls: [] });
  }
  return json({});
};

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "Seojun Lee", handle: "seojun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const directory = makeDirectory([member()]);
let switchChannel: (name: ChannelName) => void = () => undefined;

function OlderTimeline(): ReactElement {
  const [name, setName] = useState<ChannelName>(
    (new URLSearchParams(window.location.search).get("start") as ChannelName | null) ?? window.__timelineOlderStart ?? "general"
  );
  switchChannel = setName;
  const timeline = useTimeline(realtime, WS, CHANNELS[name], ME);
  // `ChatShell` 과 같은 선(#5662: 옛 쪽 실패 줄과 그 「다시 시도」까지).
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory,
    // `batchEntry`: 대화를 바꿀 때 「로딩」을 그리지 않는다 — 첫 쪽이 한 프레임 안에 와 엔진이 로딩과 준비됨을 한 번에 그린 경우
    // (#5641 검수 K2, WebKit 1280 · 900 실측)를 늘 만든다. 그때 가상 목록은 앞 대화의 인스턴스를 그대로 쓴다.
    status: window.__timelineOlderBatchEntry && timeline.status === "loading" ? "ready" : timeline.status,
    channelKind: "public",
    channelName: name,
    pending: timeline.pending,
    echoPins: timeline.echoPins,
    serverOffsetMs: timeline.serverOffsetMs,
    reachedStart: timeline.reachedStart,
    onStartReached: timeline.loadOlder,
    onRetry: timeline.reload,
    olderFailed: timeline.olderFailed,
    onRetryOlder: timeline.retryOlder,
  });
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const rootNode = document.getElementById("root");
if (!rootNode) throw new Error("timeline older harness missing #root");
createRoot(rootNode).render(
  createElement(
    MemoryRouter,
    null,
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(QueryClientProvider, { client }, createElement(OlderTimeline))
      )
    )
  )
);

window.__timelineOlder = {
  open: (name) => switchChannel(name),
  failNextOlder: (count) => {
    control.failOlder = count;
  },
  setDelays: ({ head, older }) => {
    if (head !== undefined) control.headDelayMs = head;
    if (older !== undefined) control.olderDelayMs = older;
  },
  requests: () => control.requests.map((entry) => ({ ...entry })),
};

declare global {
  interface Window {
    __timelineOlderStart?: ChannelName;
    __timelineOlderBatchEntry?: boolean;
    __timelineOlder: {
      open: (name: ChannelName) => void;
      failNextOlder: (count: number) => void;
      setDelays: (delays: { head?: number; older?: number }) => void;
      requests: () => OlderRequest[];
    };
  }
}
