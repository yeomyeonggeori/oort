import { Centrifuge, type Subscription } from "centrifuge";
import { fetchRealtimeToken } from "@momo/core/lib/api";
import {
  asCascadeFallbackFrame,
  asHuddleLifecycleFrame,
  asMessageDeletedFrame,
  asReactionFrame,
  asWorkSessionACPFrame,
  asWorkSessionLifecycleFrame,
  asWorkSessionObserverFrame,
  asWorkSessionToolTransitionFrame,
  centrifugoAgentChannelName,
  centrifugoChannelName,
  createReplayGate,
  type AgentProgressEvent,
  type CascadeFallbackFrame,
  type HuddleLifecycleFrame,
  type MessageDeletedEvent,
  type MessageNewEvent,
  type ReactionEvent,
  type RealtimeHandle,
  type RealtimeStatus,
  type SubscribedRecoveryContext,
  type WorkSessionACPFrame,
  type WorkSessionLifecycleFrame,
  type WorkSessionObserverFrame,
  type WorkSessionToolTransitionFrame,
} from "@momo/core/lib/realtimeEvents";
import { apiBase } from "./serverBase";

// =============================================================================
// Realtime TRANSPORT (goal RN-C1 / ADR-0137 D3).
//
// The frame vocabulary this file used to carry — every event interface, every
// `as*Frame` narrowing, the replay gate, the channel-name builders and the
// `RealtimeHandle` interface itself — now lives in
// `@momo/core/lib/realtimeEvents`, because none of it knows what a socket is.
// What stayed is the half that does: the centrifuge client, and the loopback
// rewrite that reads `window.location`.
//
// Re-exported wholesale so every existing `@/lib/realtime` import keeps
// resolving to the same names. This module is the web IMPLEMENTATION of the
// core's `RealtimeHandle` port; RN will supply its own with the same interface.
// =============================================================================

export * from "@momo/core/lib/realtimeEvents";

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * The host the REST client is actually talking to: the chosen/built-in server
 * base when there is one, otherwise the page's own origin (same-origin mode).
 */
function restHost(pageHost: string, base: string): string {
  if (base === "") return pageHost;
  try {
    return new URL(base).hostname;
  } catch {
    return pageHost;
  }
}

/**
 * SPIKE-ONLY (MOMO-595 finding): momowebqa's login returns an mDNS host
 * (`ws://<machine>.local:28001/...`). Chrome's WebSocket resolver hangs on that
 * `.local` name in this dev environment (raw connect: 127.0.0.1 opens in
 * ~270ms, `<machine>.local` never resolves), so the realtime rail never
 * connects in the browser. node/ping/curl resolve it fine, so this is a
 * webview-specific gap.
 *
 * ADR-0110 ("use the login-returned WS address verbatim, never derive it") is
 * PRESERVED: the rewrite fires ONLY when the REST base itself is loopback, i.e.
 * this client is talking to a server on this machine, and only to swap a
 * `.local`/bare-host for that same loopback.
 *
 * The anchor is the REST base, NOT the page origin (P2, MOMO-604). Inside the
 * Tauri shell the page is always served from `tauri://localhost`, so keying off
 * the page would have read every desktop session as "local dev" and rewritten a
 * real remote WS host down to localhost. A desktop client pointed at a remote
 * server now gets the login-returned address verbatim, which is the rule.
 *
 * The proper fix remains server-side: return a browser-resolvable host for the
 * target environment (tracked as a spike finding, not fixed here).
 */
export function resolveSpikeRealtimeUrl(
  url: string,
  options: { pageHost?: string; base?: string } = {}
): string {
  const pageHost =
    options.pageHost ??
    (typeof window === "undefined" ? "" : window.location.hostname);
  if (pageHost === "") return url;
  const base = options.base ?? apiBase();
  if (!isLoopbackHost(restHost(pageHost, base))) {
    return url; // production / remote server: verbatim (ADR-0110)
  }
  try {
    const u = new URL(url);
    if (!isLoopbackHost(u.hostname)) {
      u.hostname = restHost(pageHost, base); // e.g. <machine>.local -> 127.0.0.1
      return u.toString();
    }
  } catch {
    /* leave malformed URLs untouched */
  }
  return url;
}

export function createRealtime(
  realtimeWebSocketUrl: string,
  onStatus: (status: RealtimeStatus) => void
): RealtimeHandle {
  const client = new Centrifuge(realtimeWebSocketUrl, {
    getToken: fetchRealtimeToken,
    minReconnectDelay: 500,
    maxReconnectDelay: 20_000,
  });

  // `connecting` means two different things to a reader and only one thing to
  // centrifuge-js. Before the first `connected` it is the opening handshake, and
  // "연결 중" is the honest word. After it, it is the reconnect loop the client
  // enters on every drop, and it stays there for as long as the network is gone:
  // `disconnected` is emitted only when the SERVER closes the session on
  // purpose. Reporting both as "연결 중" is why a real 40s socket drop showed no
  // offline banner at all (measured): ChatShell gates the banner on
  // `disconnected`, which never arrived. Once we have been connected, not being
  // connected is being disconnected, and every rail-down surface (the banner,
  // the sidebar pill, the composer bar, the clocks) keys off that one fact.
  let everConnected = false;
  client.on("connecting", () =>
    onStatus(everConnected ? "disconnected" : "connecting")
  );
  client.on("connected", () => {
    everConnected = true;
    onStatus("connected");
  });
  client.on("disconnected", () => onStatus("disconnected"));
  client.connect();

  // One Centrifugo subscription per channel, shared by however many callers
  // want it, torn down when the last one lets go. Without the count the first
  // caller to unmount would unsubscribe a channel the other is still reading —
  // which is exactly what happens when the notification rail and the open
  // timeline watch the same channel and the user changes route.
  const shared = new Map<string, { sub: Subscription; refs: number }>();

  /**
   * Refcounted attach to one Centrifugo channel. `wire` registers the caller's
   * handlers and returns the matching detach, so the ownership rule lives in
   * one place for both the message rail and the agent progress rail.
   */
  function attach(
    name: string,
    options: { recoverable: boolean; positioned: boolean },
    wire: (sub: Subscription) => () => void
  ): () => void {
    let entry = shared.get(name);
    if (!entry) {
      const sub =
        client.getSubscription(name) ?? client.newSubscription(name, options);
      entry = { sub, refs: 0 };
      shared.set(name, entry);
    }
    entry.refs += 1;
    const sub = entry.sub;
    const detach = wire(sub);
    if (sub.state !== "subscribed") sub.subscribe();

    let released = false;
    return () => {
      if (released) return; // a double cleanup must not release someone else's ref
      released = true;
      detach();
      const current = shared.get(name);
      if (!current || current.sub !== sub) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      shared.delete(name);
      sub.unsubscribe();
      client.removeSubscription(sub);
    };
  }

  function subscribeChannel(
    workspaceId: string,
    channelId: string,
    handlers: {
      onSubscribed: (recovered: boolean) => void;
      onMessage: (event: MessageNewEvent) => void;
      onMessageDeleted?: (event: MessageDeletedEvent) => void;
      onReaction?: (event: ReactionEvent) => void;
    }
  ): () => void {
    return attach(
      centrifugoChannelName(workspaceId, channelId),
      { recoverable: true, positioned: true },
      (sub) => {
        const onSubscribed = (ctx: { recovered?: boolean }) =>
          handlers.onSubscribed(ctx.recovered === true);
        const onPublication = (ctx: { data?: unknown }) => {
          const event = ctx.data as MessageNewEvent | undefined;
          if (
            event &&
            (event.type === "message.new" || event.type === "message.edited") &&
            event.payload
          ) {
            handlers.onMessage(event);
            return;
          }
          // B11 — the two interaction frames. They ride the same channel as the
          // message they annotate and reuse its `seq`, so they arrive here in
          // order behind it rather than on a rail of their own.
          const tombstone = asMessageDeletedFrame(ctx.data);
          if (tombstone) {
            handlers.onMessageDeleted?.(tombstone);
            return;
          }
          const reaction = asReactionFrame(ctx.data);
          if (reaction) handlers.onReaction?.(reaction);
        };
        sub.on("subscribed", onSubscribed);
        sub.on("publication", onPublication);
        return () => {
          sub.off("subscribed", onSubscribed);
          sub.off("publication", onPublication);
        };
      }
    );
  }

  function subscribeAgent(
    workspaceId: string,
    channelId: string,
    agentMemberId: string,
    handlers: { onEvent: (event: AgentProgressEvent) => void }
  ): () => void {
    // Asked for without recovery, unlike the message rail: progress is an
    // ephemeral projection of a run Postgres already owns, so a gap is nothing
    // to heal. The server does not honour that request (`agent` is
    // force_recovery in infra/centrifugo.json), which is why the flags alone
    // would have been a comment rather than a defence, and why the replay gate
    // below does the actual work: a reconnect after a laptop sleep replays every
    // frame of turns that finished minutes ago, and folding those in would put a
    // dead turn back on the sidebar with a fresh clock.
    return attach(
      centrifugoAgentChannelName(workspaceId, channelId, agentMemberId),
      { recoverable: false, positioned: false },
      (sub) => {
        const gate = createReplayGate();
        const onSubscribed = (ctx: SubscribedRecoveryContext) =>
          gate.onSubscribed(ctx);
        const onPublication = (ctx: { data?: unknown }) => {
          if (gate.isReplaying()) return;
          const event = ctx.data as AgentProgressEvent | undefined;
          if (
            event &&
            (event.type === "agent.status" || event.type === "agent.partial") &&
            event.payload
          ) {
            handlers.onEvent(event);
          }
        };
        sub.on("subscribed", onSubscribed);
        sub.on("publication", onPublication);
        return () => {
          sub.off("subscribed", onSubscribed);
          sub.off("publication", onPublication);
        };
      }
    );
  }

  function subscribeWorkSession(
    workspaceId: string,
    channelId: string,
    handlers: {
      onLifecycle: (frame: WorkSessionLifecycleFrame) => void;
      onToolTransition: (frame: WorkSessionToolTransitionFrame) => void;
      onAcpEvent: (frame: WorkSessionACPFrame) => void;
      onObserver: (frame: WorkSessionObserverFrame) => void;
      onResync: () => void;
    }
  ): () => void {
    // The SAME options the message rail asks for, because this is the same
    // Centrifugo channel and `attach` shares one subscription between them: a
    // second set of flags here would be a flag nobody reads, since whichever
    // caller arrives first creates the subscription.
    //
    // Which is exactly why the replay gate is not optional. The `ch:` namespace
    // IS recoverable, so a reconnect after a sleep replays every publication of
    // the gap, including the ACP frames of turns that ended minutes ago. Folding
    // those in would put a finished turn back on screen with a running clock,
    // which is the MOMO-789 blocker. Replayed frames are dropped and `onResync`
    // asks the caller to re-read Postgres instead, which is the only surface
    // that can answer "what is true now".
    return attach(
      centrifugoChannelName(workspaceId, channelId),
      { recoverable: true, positioned: true },
      (sub) => {
        const gate = createReplayGate();
        const onSubscribed = (ctx: SubscribedRecoveryContext) => {
          gate.onSubscribed(ctx);
          handlers.onResync();
        };
        const onPublication = (ctx: { data?: unknown }) => {
          if (gate.isReplaying()) return;
          const lifecycle = asWorkSessionLifecycleFrame(ctx.data);
          if (lifecycle) {
            handlers.onLifecycle(lifecycle);
            return;
          }
          const transition = asWorkSessionToolTransitionFrame(ctx.data);
          if (transition) {
            handlers.onToolTransition(transition);
            return;
          }
          const observer = asWorkSessionObserverFrame(ctx.data);
          if (observer) {
            handlers.onObserver(observer);
            return;
          }
          const acp = asWorkSessionACPFrame(ctx.data);
          if (acp) handlers.onAcpEvent(acp);
        };
        sub.on("subscribed", onSubscribed);
        sub.on("publication", onPublication);
        return () => {
          sub.off("subscribed", onSubscribed);
          sub.off("publication", onPublication);
        };
      }
    );
  }

  function subscribeCascade(
    workspaceId: string,
    channelId: string,
    handlers: { onFallback: (frame: CascadeFallbackFrame) => void }
  ): () => void {
    // The SAME flags the message rail asks for, because `attach` hands back the
    // one subscription this channel already has; whichever caller arrives first
    // creates it. No replay gate: see the note above the frame type.
    return attach(
      centrifugoChannelName(workspaceId, channelId),
      { recoverable: true, positioned: true },
      (sub) => {
        const onPublication = (ctx: { data?: unknown }) => {
          const frame = asCascadeFallbackFrame(ctx.data);
          if (frame) handlers.onFallback(frame);
        };
        sub.on("publication", onPublication);
        return () => {
          sub.off("publication", onPublication);
        };
      }
    );
  }

  function subscribeHuddle(
    workspaceId: string,
    channelId: string,
    handlers: {
      onLifecycle: (frame: HuddleLifecycleFrame) => void;
      onResync: () => void;
    }
  ): () => void {
    return attach(
      centrifugoChannelName(workspaceId, channelId),
      { recoverable: true, positioned: true },
      (sub) => {
        const gate = createReplayGate();
        const onSubscribed = (ctx: SubscribedRecoveryContext) => {
          gate.onSubscribed(ctx);
          // REST owns current liveness. This also heals a non-recovered gap.
          handlers.onResync();
        };
        const onPublication = (ctx: { data?: unknown }) => {
          if (gate.isReplaying()) return;
          const frame = asHuddleLifecycleFrame(ctx.data);
          if (frame) handlers.onLifecycle(frame);
        };
        sub.on("subscribed", onSubscribed);
        sub.on("publication", onPublication);
        return () => {
          sub.off("subscribed", onSubscribed);
          sub.off("publication", onPublication);
        };
      }
    );
  }

  return {
    subscribeChannel,
    subscribeAgent,
    subscribeWorkSession,
    subscribeCascade,
    subscribeHuddle,
    reconnect: () => {
      client.disconnect();
      client.connect();
    },
    dispose: () => {
      shared.clear();
      client.disconnect();
    },
  };
}
