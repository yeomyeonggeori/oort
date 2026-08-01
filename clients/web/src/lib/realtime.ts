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

// ---- agent progress rail (AX-5 / MOMO-613) ---------------------------------
// `agent:ws<workspace>.<channel>.<agentMember>` is the exact-channel observable
// progress namespace (research/11-agent-runtime/14, verified by
// scripts/verify_agent_live_channel.sh): the subscribe proxy authorises it only
// when the observer AND the target agent are both active members of that exact
// channel, which is why one subscription is needed per (channel, agent) pair
// rather than one per channel.
//
// Two payload facts, measured against momowebqa rather than assumed:
//   - ids arrive in MIXED case. `run_id` is a Swift `uuidString` (UPPERCASE)
//     while `channel_id` comes back lowercase, so every comparison downstream
//     folds case (agentRail.ts `keyOf`).
//   - `agent.partial` carries NO `agent_member_id`. The delta is attributed to
//     the agent whose channel it arrived on, which the subscription already
//     knows; deriving it from the run id would need a status frame that may not
//     have arrived yet.

/** Run lifecycle (`run_status`) as the worker publishes it. */
export type AgentRunStatusWire =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Stream phase (`phase`) as the worker publishes it. */
export type AgentPhaseWire =
  | "queued"
  | "thinking"
  | "streaming"
  | "done"
  | "error";

export interface AgentStatusEvent {
  type: "agent.status";
  v: number;
  ts: number;
  payload: {
    run_id: string;
    agent_member_id: string;
    channel_id: string;
    phase: AgentPhaseWire;
    run_status: AgentRunStatusWire;
    /** Tool name behind the current step. Internal vocabulary, never rendered. */
    detail?: string;
    reserved_micro_usd?: number;
    spent_micro_usd?: number;
  };
}

export interface AgentPartialEvent {
  type: "agent.partial";
  v: number;
  ts: number;
  payload: {
    run_id: string;
    channel_id: string;
    message_id?: string;
    /** Appended slice of the streaming answer. */
    text_delta?: string;
    /** The full text so far (worker convenience field). */
    text?: string;
    tool_call_id?: string;
    tool_call_name?: string;
    tool_call_args?: unknown;
    tool_call_args_truncated?: boolean;
    spent_micro_usd?: number;
  };
}

export type AgentProgressEvent = AgentStatusEvent | AgentPartialEvent;

export function centrifugoAgentChannelName(
  workspaceId: string,
  channelId: string,
  agentMemberId: string
): string {
  return `agent:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}.${agentMemberId.toUpperCase()}`;
}

/** Subset of the centrifuge subscribed context the replay gate reads. */
export interface SubscribedRecoveryContext {
  recovered?: boolean;
  hasRecoveredPublications?: boolean;
}

/**
 * Tells replayed publications apart from live ones.
 *
 * The `agent` namespace recovers WHATEVER THE CLIENT ASKS FOR: infra/centrifugo.json
 * gives it `force_recovery: true` with 100 frames of 24h history, and a live
 * subscribe against momowebqa comes back `recoverable:true positioned:true` even
 * for a subscription created with both flags off. Measured on 2026-07-25: after
 * a 25s disconnect that spanned a whole @kim-intern turn, the resubscribe
 * answered `recovered:true` and replayed all 8 frames of that finished turn.
 *
 * centrifuge-js flushes those recovered publications synchronously, immediately
 * after it emits `subscribed` (`Subscription._handleSubscribeResult`). So the
 * gate raises on that event and lowers on the next microtask: it covers exactly
 * the replayed batch, and nothing that arrives later can be mistaken for it.
 * `schedule` is the seam that lets a test drive the lowering by hand.
 */
export function createReplayGate(schedule: (task: () => void) => void = queueMicrotask) {
  let replaying = false;
  return {
    onSubscribed(ctx: SubscribedRecoveryContext): void {
      if (ctx.recovered !== true && ctx.hasRecoveredPublications !== true) return;
      replaying = true;
      schedule(() => {
        replaying = false;
      });
    },
    isReplaying(): boolean {
      return replaying;
    },
  };
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

// ---- work session rail (AX-3 / MOMO-618) -----------------------------------
// Work sessions publish on the CHANNEL namespace, not the agent one: the server
// builds both frames with `ch:ws<ws>.<channel>` (WorkSessionRoutes
// `lifecyclePayload` / `acpEventPayload`), so watching a session is watching the
// channel it lives in. Two frame families arrive there beyond message.new:
//
//   - `work.session.started` / `work.session.ended`, the ledger lifecycle;
//   - the projected ACP event, whose `data.type` is the RAW event name
//     (`agent.status`, `agent.partial`, `approval.requested`,
//     `approval.decided`) and whose payload carries `work_session_id`. That
//     field is the discriminator against the identically named frames on the
//     agent namespace, which are about `agent_run` and carry no session id.
//
// Measured against momowebqa on 2026-07-26 (host-signed PATCH round trip):
// `run_id` inside a work-session ACP payload is the WORK SESSION id, not an
// agent_run id. The server enforces it (`validatedACPEvent` requires
// `run_id == work_session_id == {session}`), so it must never be handed to
// /agent-runs/{run}/cancel; that call answers 404, as verified.

export type WorkSessionACPType =
  | "agent.status"
  | "agent.partial"
  | "approval.requested"
  | "approval.decided";

export interface WorkSessionLifecycleFrame {
  type: "work.session.started" | "work.session.ended";
  v: number;
  ts: number;
  seq: number;
  payload: {
    session_id: string;
    channel_id: string;
    root_message_id: string;
    member_id: string;
    host_id: string;
    tool: string;
    label: string;
    started_at?: number;
    ended_at?: number;
    exit_code?: number;
    end_reason?: string;
    resumed_from_session_id?: string;
  };
}

export type WorkSessionToolTransitionType =
  | "work.session.idle"
  | "work.session.resumed-to-running";

/**
 * A tool completion or restart inside one still-live work session
 * (ADR-0139 D1). Swift emits every UUID through `uuidString`, so these ids are
 * uppercase on the wire; callers compare them through `uuidEq`.
 */
export interface WorkSessionToolTransitionFrame {
  type: WorkSessionToolTransitionType;
  v: number;
  ts: number;
  seq: number;
  payload: {
    session_id: string;
    channel_id: string;
    root_message_id: string;
    member_id: string;
    host_id: string;
    status: "idle" | "running";
    exit_code?: number;
    idle_at?: number;
    resumed_at?: number;
  };
}

export interface WorkSessionACPFrame {
  type: WorkSessionACPType;
  v: number;
  ts: number;
  seq: number;
  payload: {
    work_session_id: string;
    run_id: string;
    channel_id: string;
    event_id: string;
    message_id: string;
    root_message_id: string;
  } & Record<string, unknown>;
}

/**
 * Observer count projection (ADR-0126 D1, `TerminalAttachRoutes.observerPayload`).
 * Published on the same channel when an observer capability is issued, and the
 * payload is deliberately two fields: the session and the count. It says nothing
 * about WHO, so nothing here can grow into an attendance list.
 */
export interface WorkSessionObserverFrame {
  type: "work.session.observer";
  v: number;
  ts: number;
  seq: number;
  payload: {
    session_id: string;
    observer_count: number;
  };
}

export function asWorkSessionObserverFrame(
  data: unknown
): WorkSessionObserverFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<WorkSessionObserverFrame>;
  if (frame.type !== "work.session.observer") return null;
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.session_id !== "string") return null;
  if (typeof payload.observer_count !== "number") return null;
  return frame as WorkSessionObserverFrame;
}

const WORK_ACP_TYPES: ReadonlySet<string> = new Set<WorkSessionACPType>([
  "agent.status",
  "agent.partial",
  "approval.requested",
  "approval.decided",
]);

/** A publication carrying a projected ACP event for a work session. */
export function asWorkSessionACPFrame(
  data: unknown
): WorkSessionACPFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<WorkSessionACPFrame>;
  if (typeof frame.type !== "string" || !WORK_ACP_TYPES.has(frame.type)) {
    return null;
  }
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.work_session_id !== "string") return null;
  return frame as WorkSessionACPFrame;
}

/** A publication carrying a work-session lifecycle transition. */
export function asWorkSessionLifecycleFrame(
  data: unknown
): WorkSessionLifecycleFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<WorkSessionLifecycleFrame>;
  if (
    frame.type !== "work.session.started" &&
    frame.type !== "work.session.ended"
  ) {
    return null;
  }
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.session_id !== "string") return null;
  return frame as WorkSessionLifecycleFrame;
}

const WORK_TOOL_TRANSITION_TYPES: ReadonlySet<string> =
  new Set<WorkSessionToolTransitionType>([
    "work.session.idle",
    "work.session.resumed-to-running",
  ]);

/**
 * A publication carrying a live-session tool transition. Every field is
 * checked before the frame reaches React: a string/number inversion returns
 * null rather than creating a plausible but wrong state.
 */
export function asWorkSessionToolTransitionFrame(
  data: unknown
): WorkSessionToolTransitionFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<WorkSessionToolTransitionFrame>;
  if (
    typeof frame.type !== "string" ||
    !WORK_TOOL_TRANSITION_TYPES.has(frame.type) ||
    typeof frame.v !== "number" ||
    typeof frame.ts !== "number" ||
    typeof frame.seq !== "number"
  ) {
    return null;
  }
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (
    !payload ||
    typeof payload.session_id !== "string" ||
    typeof payload.channel_id !== "string" ||
    typeof payload.root_message_id !== "string" ||
    typeof payload.member_id !== "string" ||
    typeof payload.host_id !== "string" ||
    typeof payload.status !== "string" ||
    (payload.exit_code !== undefined && typeof payload.exit_code !== "number")
  ) {
    return null;
  }
  if (frame.type === "work.session.idle") {
    if (payload.status !== "idle" || typeof payload.idle_at !== "number") {
      return null;
    }
    if (payload.resumed_at !== undefined) return null;
  } else {
    if (
      payload.status !== "running" ||
      typeof payload.resumed_at !== "number"
    ) {
      return null;
    }
    if (payload.idle_at !== undefined) return null;
  }
  return frame as WorkSessionToolTransitionFrame;
}

// ---- huddle lifecycle rail (ADR-0122 / MOMO-643) ---------------------------
// Huddles use underscore event names because those are the Core/server contract,
// not a web-side spelling choice. Their channel publication is only an
// invalidation hint: participant display names remain a REST projection, so a
// started/changed frame asks the caller to refetch instead of inventing rows
// from participant_member_ids.

export type HuddleEventType =
  | "huddle_started"
  | "huddle_participants_changed"
  | "huddle_ended";

export interface HuddleLifecycleFrame {
  type: HuddleEventType;
  v: number;
  ts: number;
  payload: {
    huddle_id: string;
    channel_id: string;
    participant_member_ids: string[];
  };
}

const HUDDLE_EVENT_TYPES: ReadonlySet<string> = new Set<HuddleEventType>([
  "huddle_started",
  "huddle_participants_changed",
  "huddle_ended",
]);

/**
 * A publication carrying a huddle transition, or null for every malformed
 * field. This deliberately matches the defensive work-session parsers beside
 * it: a type inversion never escapes into the UI as a plausible event.
 */
export function asHuddleLifecycleFrame(
  data: unknown
): HuddleLifecycleFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<HuddleLifecycleFrame>;
  if (typeof frame.type !== "string" || !HUDDLE_EVENT_TYPES.has(frame.type)) {
    return null;
  }
  if (typeof frame.v !== "number" || typeof frame.ts !== "number") return null;
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (
    !payload ||
    typeof payload.huddle_id !== "string" ||
    typeof payload.channel_id !== "string" ||
    !Array.isArray(payload.participant_member_ids) ||
    !payload.participant_member_ids.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return frame as HuddleLifecycleFrame;
}

// ---- provider cascade rail (ADR-0135 D1 / MOMO-622) -------------------------
// A turn that fell over to the next provider publishes ONE frame per transition
// on the CHANNEL namespace, beside the message rail (AgentWorker
// `cascadeFallbackBroadcastPayload`). "조용한 전환 금지" is the whole reason it
// exists: cost and governance moved to a different provider, and the person who
// asked for the turn is entitled to know.
//
// Three facts about this frame, all from the worker that writes it:
//   - it carries NO `seq` and no Centrifugo version, because it is not a
//     message and claims no place in the channel's order;
//   - `run_id` is a Swift `uuidString` (UPPERCASE) and can be null when the
//     fallback happened before a run row existed, so every comparison folds
//     case and a null id is dropped rather than guessed;
//   - the payload carries redacted endpoint LABELS (host:port), never a base
//     URL and never a bearer (ADR-0004 evidence rule).
//
// Unlike the agent progress rail this one does NOT gate replays. The `ch:`
// namespace is recoverable, so a reconnect replays the gap, and that is wanted
// here: a fallback is a durable fact about a finished turn, not a running
// clock, and the outbox already keys one row per (run, transition) so the same
// transition dedupes on `${runId}:${from}-${to}` instead of stacking.

export interface CascadeFallbackFrame {
  type: "provider.cascade.fallback";
  v: number;
  ts: number;
  payload: {
    channel_id: string;
    run_id: string | null;
    /** Cascade position that failed. 0 is the operator's provider link. */
    from: number;
    /** Cascade position that served the turn instead. */
    to: number;
    /** Machine label (`provider_unreachable`, …), never user copy. */
    reason: string;
    from_endpoint_label: string;
    to_endpoint_label: string;
  };
}

export function asCascadeFallbackFrame(
  data: unknown
): CascadeFallbackFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<CascadeFallbackFrame>;
  if (frame.type !== "provider.cascade.fallback") return null;
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  if (typeof payload.from !== "number" || typeof payload.to !== "number") {
    return null;
  }
  if (typeof payload.reason !== "string") return null;
  return frame as CascadeFallbackFrame;
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
  /**
   * Watch one agent's progress inside one channel (`agent.status` /
   * `agent.partial`). Same refcount as `subscribeChannel`, so two surfaces may
   * watch the same agent without either ending the other's feed.
   */
  subscribeAgent: (
    workspaceId: string,
    channelId: string,
    agentMemberId: string,
    handlers: { onEvent: (event: AgentProgressEvent) => void }
  ) => () => void;
  /**
   * Watch the work sessions of one channel. Shares the channel subscription
   * with `subscribeChannel` (same refcount), and drops replayed publications
   * instead of folding them in: see `subscribeWorkSession` below.
   */
  subscribeWorkSession: (
    workspaceId: string,
    channelId: string,
    handlers: {
      onLifecycle: (frame: WorkSessionLifecycleFrame) => void;
      onToolTransition: (frame: WorkSessionToolTransitionFrame) => void;
      onAcpEvent: (frame: WorkSessionACPFrame) => void;
      /** An observer capability was issued: re-read the count from Postgres. */
      onObserver: (frame: WorkSessionObserverFrame) => void;
      /** A replayed or non-recovered (re)subscribe: heal from REST instead. */
      onResync: () => void;
    }
  ) => () => void;
  /**
   * Watch provider cascade transitions in one channel (ADR-0135 D1). Shares the
   * channel subscription with `subscribeChannel` through the same refcount.
   */
  subscribeCascade: (
    workspaceId: string,
    channelId: string,
    handlers: { onFallback: (frame: CascadeFallbackFrame) => void }
  ) => () => void;
  /**
   * Watch huddle lifecycle changes in one channel. The publication is an
   * invalidation signal; the caller re-reads the active REST projection for
   * names and joined timestamps.
   */
  subscribeHuddle: (
    workspaceId: string,
    channelId: string,
    handlers: {
      onLifecycle: (frame: HuddleLifecycleFrame) => void;
      onResync: () => void;
    }
  ) => () => void;
  /**
   * Re-dial now, on a person's request (goal B8 B2).
   *
   * centrifuge already reconnects on its own with a backoff that reaches 20s,
   * so this is not "reconnect for me" (it is already trying) but "try again
   * NOW": someone who has just fixed their VPN, their wifi or the server should
   * not sit through the remainder of a 20s sleep to find out. `disconnect()`
   * first because `connect()` on a client that is already in its reconnect loop
   * is a no-op; the pair is what actually restarts the backoff at zero.
   *
   * Subscriptions survive it. They are the client's own objects and re-subscribe
   * on the next connect, so the timeline heals through the same recovered /
   * backfill path a spontaneous reconnect takes.
   */
  reconnect: () => void;
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
