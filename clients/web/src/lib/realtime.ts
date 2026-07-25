import { Centrifuge, type Subscription } from "centrifuge";
import { fetchRealtimeToken, type Message } from "./api";
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
    root_id?: string | null;
    /**
     * Server-decided message properties, forwarded verbatim by the relay
     * (server `MessageRoutes.broadcastPayload`, omitted when empty). This is
     * where `mention_member_ids` and the approval fields live, so a live frame
     * carries the same facts the REST page does.
     */
    props?: Record<string, unknown>;
  };
}

/**
 * A realtime frame as the rest of the app sees messages. Shared by the timeline
 * and the notification rail so a live row and a REST row are the same object
 * shape — a second converter is how the two drift apart.
 *
 * `created_at_ms` is NOT in the broadcast envelope, so the local clock stands in
 * for the grouping label only; ordering is `seq` and the server time the
 * notification rail reads is `hlc_ts`.
 */
export function payloadToMessage(p: MessageNewEvent["payload"]): Message {
  const message: Message = {
    id: p.id,
    channelId: p.channel_id,
    seq: p.seq,
    hlcTs: p.hlc_ts,
    hlcCount: p.hlc_count,
    authorMemberId: p.author_member_id,
    type: (p.type as Message["type"]) ?? "text",
    body: p.body ?? undefined,
    state: (p.state as Message["state"]) ?? "sent",
    createdAtMs: p.created_at_ms ?? Date.now(),
  };
  if (typeof p.root_id === "string") message.rootId = p.root_id;
  if (p.props && typeof p.props === "object") message.props = p.props;
  return message;
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
  /**
   * Watch one channel. Callers are independent: the timeline and the desktop
   * notification rail both want the open channel, and neither can end the
   * other's feed (see the refcount below).
   */
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

  // One Centrifugo subscription per channel, shared by however many callers
  // want it, torn down when the last one lets go. Without the count the first
  // caller to unmount would unsubscribe a channel the other is still reading —
  // which is exactly what happens when the notification rail and the open
  // timeline watch the same channel and the user changes route.
  const shared = new Map<string, { sub: Subscription; refs: number }>();

  function subscribeChannel(
    workspaceId: string,
    channelId: string,
    handlers: {
      onSubscribed: (recovered: boolean) => void;
      onMessage: (event: MessageNewEvent) => void;
    }
  ): () => void {
    const name = centrifugoChannelName(workspaceId, channelId);
    let entry = shared.get(name);
    if (!entry) {
      const sub =
        client.getSubscription(name) ??
        client.newSubscription(name, { recoverable: true, positioned: true });
      entry = { sub, refs: 0 };
      shared.set(name, entry);
    }
    entry.refs += 1;
    const sub = entry.sub;

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

    let released = false;
    return () => {
      if (released) return; // a double cleanup must not release someone else's ref
      released = true;
      sub.off("subscribed", onSubscribed);
      sub.off("publication", onPublication);
      const current = shared.get(name);
      if (!current || current.sub !== sub) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      shared.delete(name);
      sub.unsubscribe();
      client.removeSubscription(sub);
    };
  }

  return {
    subscribeChannel,
    dispose: () => {
      shared.clear();
      client.disconnect();
    },
  };
}
