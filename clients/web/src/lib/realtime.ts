import { Centrifuge, type Subscription } from "centrifuge";
import { fetchRealtimeToken } from "./api";

// =============================================================================
// Realtime rail (transport-only; Postgres is the SoT). Mirrors the ADR-0119
// client contract:
//   - the WS address is EXCLUSIVELY the login `realtimeWebSocketUrl` (ADR-0110);
//   - the connection JWT comes from POST /v1/auth/realtime-token (getToken);
//   - channel subscriptions are recoverable+positioned so a reconnect replays
//     missed publications with ctx.recovered; when NOT recovered the caller
//     heals via REST `?after=<seq>` backfill, and the resume gate exercises both;
//   - Centrifugo channel names are case-sensitive and the relay bakes UUIDs as
//     Swift UUID.uuidString (UPPERCASE), so ids must be uppercased.
// =============================================================================

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

export interface MessageNewEvent {
  type: "message.new" | "message.edited";
  v: number;
  ts: number;
  seq: number;
  payload: {
    id: string;
    channel_id: string;
    seq: number;
    type: string;
    body?: string | null;
    author_member_id: string;
    hlc_ts: number;
    hlc_count: number;
    created_at_ms?: number;
    state?: string;
  };
}

export function centrifugoChannelName(
  workspaceId: string,
  channelId: string
): string {
  return `ch:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`;
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
 * PRESERVED in production: this rewrite fires ONLY when the page itself is on a
 * loopback origin (i.e. local dev), and only to swap a `.local`/bare-host for
 * the loopback the page is already served from. Any real (non-loopback) deploy
 * is untouched. The proper fix is server-side: return a browser-resolvable host
 * for the target environment (tracked as a spike finding, not fixed here).
 */
export function resolveSpikeRealtimeUrl(url: string): string {
  if (typeof window === "undefined") return url;
  const pageHost = window.location.hostname;
  const onLoopback =
    pageHost === "127.0.0.1" ||
    pageHost === "localhost" ||
    pageHost === "::1";
  if (!onLoopback) return url; // production: verbatim (ADR-0110)
  try {
    const u = new URL(url);
    const h = u.hostname;
    const targetIsLoopback =
      h === "127.0.0.1" || h === "localhost" || h === "::1";
    if (!targetIsLoopback) {
      u.hostname = pageHost; // e.g. <machine>.local -> 127.0.0.1
      return u.toString();
    }
  } catch {
    /* leave malformed URLs untouched */
  }
  return url;
}

export interface RealtimeHandle {
  subscribeChannel: (
    workspaceId: string,
    channelId: string,
    handlers: {
      onSubscribed: (recovered: boolean) => void;
      onMessage: (event: MessageNewEvent) => void;
    }
  ) => () => void;
  dispose: () => void;
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

  client.on("connecting", () => onStatus("connecting"));
  client.on("connected", () => onStatus("connected"));
  client.on("disconnected", () => onStatus("disconnected"));
  client.connect();

  function subscribeChannel(
    workspaceId: string,
    channelId: string,
    handlers: {
      onSubscribed: (recovered: boolean) => void;
      onMessage: (event: MessageNewEvent) => void;
    }
  ): () => void {
    const name = centrifugoChannelName(workspaceId, channelId);
    let sub: Subscription | null =
      client.getSubscription(name) ??
      client.newSubscription(name, { recoverable: true, positioned: true });

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
      }
    };

    sub.on("subscribed", onSubscribed);
    sub.on("publication", onPublication);
    if (sub.state !== "subscribed") sub.subscribe();

    return () => {
      if (!sub) return;
      sub.off("subscribed", onSubscribed);
      sub.off("publication", onPublication);
      sub.unsubscribe();
      client.removeSubscription(sub);
      sub = null;
    };
  }

  return { subscribeChannel, dispose: () => client.disconnect() };
}
