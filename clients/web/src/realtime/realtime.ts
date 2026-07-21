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
interface MessageEventPayload {
  id: string;
  channel_id: string;
  seq: number;
  type: string;
  body?: string | null;
  author_member_id: string;
  hlc_ts: number;
  hlc_count: number;
  props?: Record<string, unknown> | null;
  state?: "sent" | "edited" | "deleted" | "failed";
  created_at_ms?: number;
  edited_at_ms?: number | null;
  deleted_at_ms?: number | null;
}

interface MessageEvent<T extends "message.new" | "message.edited"> {
  type: T;
  v: number;
  ts: number;
  seq: number;
  payload: MessageEventPayload;
}

export type MessageNewEvent = MessageEvent<"message.new">;
export type MessageEditedEvent = MessageEvent<"message.edited">;

export interface MessageDeletedEvent {
  type: "message.deleted";
  v: number;
  ts: number;
  seq: number;
  payload: { message_id: string };
}

export interface ReactionEvent {
  type: "reaction.added" | "reaction.removed";
  v: number;
  ts: number;
  seq: number;
  payload: {
    action: "added" | "removed";
    message_id: string;
    member_id: string;
    emoji: string;
  };
}

/** Channel-scoped approval decision/expiry broadcast. */
type ApprovalEventType =
  | "approval.decided"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired";
export type ApprovalEvent = {
  [Type in ApprovalEventType]: {
    type: Type;
    v: number;
    ts: number;
    payload: {
      approval_id: string;
      channel_id: string;
      status: string;
    };
  };
}[ApprovalEventType];

export type ChannelRealtimeEvent =
  | MessageNewEvent
  | MessageEditedEvent
  | MessageDeletedEvent
  | ReactionEvent
  | ApprovalEvent;

export interface ChannelSubscriptionHandlers {
  /** Fired on (re)subscribe; `recovered:false` requires a REST backfill. */
  onSubscribed: (recovered: boolean) => void;
  onPublication: (event: ChannelRealtimeEvent) => void;
}

/**
 * read_state event envelope on the personal channel (ADR-0109). The server
 * bakes it in ReadStateRoutes.broadcastPayload; UUID fields are Swift
 * uuidString (UPPERCASE) — compare case-insensitively.
 */
export interface ReadStateEvent {
  type: string;
  v: number;
  ts: number;
  payload: {
    workspace_id: string;
    member_id: string;
    channel_id: string;
    last_read_seq: number;
    latest_seq: number;
    unread_count: number;
    mention_count: number;
  };
}

export interface ReadStateSubscriptionHandlers {
  /** `recovered:false` requires a bulk read-state GET to re-baseline. */
  onSubscribed: (recovered: boolean) => void;
  onPublication: (event: ReadStateEvent) => void;
}

export interface RealtimeHandle {
  subscribeChannel: (
    workspaceId: string,
    channelId: string,
    handlers: ChannelSubscriptionHandlers
  ) => () => void;
  subscribeReadState: (
    memberId: string,
    handlers: ReadStateSubscriptionHandlers
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

/**
 * Personal read-state channel (Centrifugo user-limited `user:` namespace).
 * The member-id spelling is the server's, verbatim: the outbox row is baked
 * with Swift `UUID.uuidString` (UPPERCASE) in
 * server/Sources/MomoServer/Routes/ReadStateRoutes.swift:227
 * (`personalChannel`), and Centrifugo only authorizes a user-limited
 * subscribe when the `#<user>` part byte-matches the connection JWT `sub` —
 * which the server also mints as `memberID.uuidString` (UPPERCASE,
 * server/Sources/MomoServer/Auth/JWT.swift:172). Hence toUpperCase().
 */
export function readStateChannelName(memberId: string): string {
  return `user:read-state#${memberId.toUpperCase()}`;
}

export function createRealtime(
  realtimeWebSocketUrl: string,
  onStatus: (status: RealtimeStatus) => void
): RealtimeHandle {
  const client = new Centrifuge(realtimeWebSocketUrl, {
    getToken: fetchRealtimeToken,
    // centrifuge-js uses jittered exponential backoff inside these bounds.
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
    handlers: ChannelSubscriptionHandlers
  ): () => void {
    const name = centrifugoChannelName(workspaceId, channelId);
    let sub: Subscription | null =
      client.getSubscription(name) ??
      client.newSubscription(name, { recoverable: true, positioned: true });

    const onSubscribed = (ctx: { recovered?: boolean }) => {
      handlers.onSubscribed(ctx.recovered === true);
    };
    const onPublication = (ctx: { data?: unknown }) => {
      const event = ctx.data as ChannelRealtimeEvent | undefined;
      if (
        event &&
        (event.type === "message.new" ||
          event.type === "message.edited" ||
          event.type === "message.deleted" ||
          event.type === "reaction.added" ||
          event.type === "reaction.removed" ||
          event.type === "approval.decided" ||
          event.type === "approval.approved" ||
          event.type === "approval.rejected" ||
          event.type === "approval.expired") &&
        event.payload
      ) {
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

  function subscribeReadState(
    memberId: string,
    handlers: ReadStateSubscriptionHandlers
  ): () => void {
    const name = readStateChannelName(memberId);
    let sub: Subscription | null =
      client.getSubscription(name) ?? client.newSubscription(name);

    const onSubscribed = (ctx: { recovered?: boolean }) => {
      handlers.onSubscribed(ctx.recovered === true);
    };
    const onPublication = (ctx: { data?: unknown }) => {
      const event = ctx.data as ReadStateEvent | undefined;
      if (event && event.type === "read_state" && event.payload) {
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
    subscribeReadState,
    dispose: () => {
      client.disconnect();
    },
  };
}
