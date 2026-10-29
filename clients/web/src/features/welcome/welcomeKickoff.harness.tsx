import {
  createElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
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
  holdKickoffForFreshSignup,
  peekKickoffSettled,
  subscribeFirstRun,
} from "./firstRunGate";
import { shouldMountPhoneLinkCard } from "./phoneLinkCard";
import { PhoneLinkChannelCard } from "./PhoneLinkChannelCard";
import { markPhoneLinkCardPending } from "./phoneLinkCardStore";
import { useWelcomeKickoff } from "./useWelcomeKickoff";
import { WelcomeKickoffStage } from "./WelcomeKickoffStage";

/**
 * UX-R2b / #2817 Chromium probe. Not a product route. Mounts the shipped
 * Timeline + useTimeline + useWelcomeKickoff chain, and below it the same
 * composition ChatShell has above the composer: the kickoff band, then the
 * 「폰에서도」 card (#2818) behind `shouldMountPhoneLinkCard`. Timestamps come
 * off the product wiring, not a test that adds classes itself.
 *
 * It cannot import ChatShell (Session + channel queries + shell chrome); the
 * ChatShell binding is guarded by arrivalWiring.test.ts.
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
  /**
   * 참이면 명부가 시험이 `releaseDirectory()` 를 부를 때까지 「불러오는 중」으로 선다. 예전에는 마운트 때 시작하는 실시간
   * 타이머(`directoryDelayMs`)였다: 시험의 관찰 창은 마운트 뒤 `onSubscribed` 왕복이 끝나야 시작하는데, 부하에서 그 사이가
   * 벌어지면 타이머가 관찰 창 안에서 터져 「명부가 풀리기 전에는 띠가 없다」가 거짓으로 빨개졌다(#4708).
   */
  holdDirectory: boolean;
  backlogAgent: boolean;
};

function readOpts(): HarnessOpts {
  const given = window.__welcomeKickoffOpts;
  return {
    holdDirectory: Boolean(given?.holdDirectory),
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

/**
 * 명부의 문. `release` 는 화면이 서면 자리를 잡고, 그 전에 `releaseDirectory()` 가 불렸으면 자리를 잡는 순간 바로 연다.
 * `settled` 는 풀린 명부가 화면(React 커밋)에 닿았다는 신호다: 시험은 이 신호 뒤에 「이후에도 띠가 없다」를 몇 프레임 지켜본다.
 */
const directoryGate: {
  releasedEarly: boolean;
  release: (() => void) | null;
  settled: boolean;
} = { releasedEarly: false, release: null, settled: false };

function WelcomeTimeline(): ReactElement {
  const [directory, setDirectory] = useState(
    opts.holdDirectory ? emptyDirectory : fullDirectory
  );
  const [directoryStatus, setDirectoryStatus] = useState<
    "pending" | "success" | "error"
  >(opts.holdDirectory ? "pending" : "success");
  useEffect(() => {
    if (!opts.holdDirectory) return;
    const open = () => {
      setDirectory(fullDirectory);
      setDirectoryStatus("success");
    };
    directoryGate.release = open;
    if (directoryGate.releasedEarly) open();
    return () => {
      directoryGate.release = null;
    };
  }, []);
  useEffect(() => {
    if (opts.holdDirectory && directoryStatus === "success") {
      directoryGate.settled = true;
    }
  }, [directoryStatus]);
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
  const kickoffSettled = useSyncExternalStore(
    subscribeFirstRun,
    peekKickoffSettled,
    peekKickoffSettled
  );
  const phoneCard = shouldMountPhoneLinkCard({
    channel: { kind: "public", name: "general" },
    kickoffPhase: welcome.phase,
    kickoffSettled,
  });
  return createElement(
    "div",
    { className: "flex h-full flex-col" },
    createElement(
      "div",
      { className: "relative min-h-0 flex-1" },
      createElement(Timeline, {
        messages: timeline.state.messages,
        directory,
        status: timeline.status === "error" ? "error" : "ready",
        reachedStart: true,
        channelKind: "public",
        channelName: "general",
        isPlayEntrance: timeline.isPlayEntrance,
        onEntranceConsumed: timeline.consumeEntrance,
        welcomePhase: welcome.phase,
        welcomeHoldWriteAction: welcome.holdWriteAction,
      })
    ),
    welcome.phase === "hidden"
      ? null
      : createElement(WelcomeKickoffStage, {
          phase: welcome.phase,
          reducedMotion: welcome.reducedMotion,
          speaker: welcome.speaker,
          onExitComplete: welcome.onExitComplete,
        }),
    phoneCard ? createElement(PhoneLinkChannelCard, { workspaceId: WS }) : null
  );
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

// recordFreshSignupFirstRun's order: pending card, fresh marker, kickoff hold.
markPhoneLinkCardPending(WS);
markFreshSignup({ workspaceId: WS, memberId: ME });
holdKickoffForFreshSignup();

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
  releaseDirectory: () => {
    directoryGate.releasedEarly = true;
    directoryGate.release?.();
  },
  directorySettled: () => directoryGate.settled,
};

declare global {
  interface Window {
    __welcomeKickoffOpts?: {
      holdDirectory?: boolean;
      backlogAgent?: boolean;
      reducedMotion?: boolean;
    };
    __welcomeKickoff: {
      onSubscribed: () => void;
      deliverOpener: () => void;
      stageSeenEver: () => boolean;
      /** `holdDirectory` 로 세운 명부를 푼다. */
      releaseDirectory: () => void;
      /** 푼 명부가 화면에 커밋됐는가. */
      directorySettled: () => boolean;
    };
  }
}
