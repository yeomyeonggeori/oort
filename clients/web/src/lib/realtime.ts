import { Centrifuge, type Subscription } from "centrifuge";
import { fetchRealtimeToken } from "./api";
import { apiBase } from "./serverBase";

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
