import { Centrifuge } from "centrifuge";
import type { Subscription } from "centrifuge";
import { fetchRealtimeToken } from "../api/client";

// =============================================================================
// Realtime subscription rail (transport-only; Postgres stays the SoT).
//
//   - The websocket address is EXCLUSIVELY the `realtimeWebSocketUrl` the
//     server returned at login (ADR-0110). Never derived from the API origin.
//   - Connection auth: short-lived Centrifugo connection JWT from
//     POST /v1/auth/realtime-token (getToken below handles issue + re-issue).
//   - Channel subscriptions carry NO client-side token: Centrifugo's
//     subscribe proxy calls the server back, which re-validates membership
//     and credential liveness on every attempt (MOMO-300). We only attempt.
//   - WEBSOCKET TRANSPORT ONLY: the serving CSP allows connect-src 'self' +
//     wss://REALTIME_DOMAIN and nothing else (infra/prod/Caddyfile). Passing
//     a single URL string to Centrifuge keeps the client on the websocket
//     transport; do NOT add HTTP-based fallback transports without updating
//     the Caddyfile CSP and scripts/web_serving_smoke.sh in the same PR.
//   - Ordering authority is message.seq. Realtime delivery is best-effort:
//     any gap or failed recovery is healed through REST `?after=<seq>`
//     backfill (the subscriber below reports `recovered` so the timeline can
//     run that catch-up).
// =============================================================================

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

/** message.new event envelope published by the relay (L4 §5.2). */
export interface MessageNewEvent {
  type: string;
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
  };
}

export interface ChannelSubscriptionHandlers {
  /** Fired on (re)subscribe; `recovered:false` requires a REST backfill. */
  onSubscribed: (recovered: boolean) => void;
  onPublication: (event: MessageNewEvent) => void;
}

export interface RealtimeHandle {
  subscribeChannel: (
    workspaceId: string,
    channelId: string,
    handlers: ChannelSubscriptionHandlers
  ) => () => void;
  dispose: () => void;
}

/**
 * Centrifugo channel name for a workspace channel. The relay publishes with
 * Swift's UUID.uuidString (UPPERCASE) and Centrifugo channel names are
 * case-sensitive, so the mixed-case ids from PG JSON must be uppercased.
 */
export function centrifugoChannelName(
  workspaceId: string,
  channelId: string
): string {
  return `ch:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`;
}

export function createRealtime(
  realtimeWebSocketUrl: string,
  onStatus: (status: RealtimeStatus) => void
): RealtimeHandle {
  const client = new Centrifuge(realtimeWebSocketUrl, {
    getToken: fetchRealtimeToken,
  });

  client.on("connecting", () => onStatus("connecting"));
  client.on("connected", () => onStatus("connected"));
  client.on("disconnected", () => onStatus("disconnected"));
  client.connect();

  function subscribeChannel(
    workspaceId: string,
    channelId: string,
    handlers: ChannelSubscriptionHandlers
  ): () => void {
    const name = centrifugoChannelName(workspaceId, channelId);
    let sub: Subscription | null =
      client.getSubscription(name) ?? client.newSubscription(name);

    const onSubscribed = (ctx: { recovered?: boolean }) => {
      handlers.onSubscribed(ctx.recovered === true);
    };
    const onPublication = (ctx: { data?: unknown }) => {
      const event = ctx.data as MessageNewEvent | undefined;
      if (event && event.type === "message.new" && event.payload) {
        handlers.onPublication(event);
      }
    };

    sub.on("subscribed", onSubscribed);
    sub.on("publication", onPublication);
    sub.subscribe();

    return () => {
      if (!sub) return;
      sub.off("subscribed", onSubscribed);
      sub.off("publication", onPublication);
      sub.unsubscribe();
      client.removeSubscription(sub);
      sub = null;
    };
  }

  return {
    subscribeChannel,
    dispose: () => {
      client.disconnect();
    },
  };
}
