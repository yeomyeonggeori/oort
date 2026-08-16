import type { Message, MessageAttachment, PinnedMessageWire } from "./api";
import { num, str } from "./wire";


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
     * ADR-0148 — the quote target's id, and **only** the id.
     *
     * `momo_messaging::build_broadcast_payload` refuses to put the quoted body
     * here and says why: an outbox row is written once and replayed forever, so
     * embedding the text would mint exactly the snapshot 규칙 3 forbids. The
     * resolved quote is a read projection (`Message.replyTo`), which is why a
     * live-arriving quote is resolved against the rows the client already holds
     * (`features/timeline/quote.ts` `resolveQuote`) rather than by a fetch.
     */
    reply_to_id?: string | null;
    /**
     * Server-decided message properties, forwarded verbatim by the relay
     * (server `MessageRoutes.broadcastPayload`, omitted when empty). This is
     * where `mention_member_ids` and the approval fields live, so a live frame
     * carries the same facts the REST page does.
     */
    props?: Record<string, unknown>;
    /**
     * B11 — present on `message.edited`, which carries the whole row. `state`
     * alone says *that* it was edited; without the stamp a live edit and a
     * reloaded one would disagree about when, and the row's "수정됨" label is
     * hung off exactly this value.
     */
    edited_at_ms?: number | null;
    deleted_at_ms?: number | null;
    /**
     * ADR-0151 — 이 프레임이 나르는 첨부. `reply_to_id` 와 정반대 결정이고,
     * 서버가 왜 반대인지 자기 자리에 적어 뒀다(`build_broadcast_payload`):
     * 인용은 계속 변하는 것을 가리키는 포인터라 outbox 행에 박제하면 거짓말이
     * 되지만, 첨부 행은 complete 된 순간 이름·mime·크기가 불변이고 다른 메시지로
     * 옮겨 붙지도 못한다. 그래서 한 번 쓰이고 영원히 재생되는 행에 실려도 참이다.
     *
     * 안쪽 키는 REST 와 같은 camelCase 다(서버 테스트가 그것을 단정한다).
     * 첨부가 없는 메시지에는 키 자체가 없다.
     */
    attachments?: unknown;
  };
}

/**
 * B11 — the tombstone frame. Deliberately carries **only** the id: a delete that
 * re-broadcast its body would put the erased text back on every connected
 * client's wire, which is the one thing the delete existed to prevent.
 *
 * The receiver therefore cannot build a `Message` out of this frame; it must
 * mark the row it already holds. That is why this is a separate handler rather
 * than another `payloadToMessage` shape — see `applyTombstone`.
 */
export interface MessageDeletedEvent {
  type: "message.deleted";
  v: number;
  ts: number;
  seq: number;
  payload: { message_id: string };
}

/**
 * B11 — one member's reaction moving one way.
 *
 * `seq` is the **target message's**, reused rather than minted: a reaction is
 * not a message and must not advance any cursor. Ids arrive UPPERCASE (the
 * server builds them from Swift's `uuidString`, unlike the lowercase ids in a
 * message payload), so every consumer folds case.
 */
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

/** Narrow a publication to the tombstone frame, or `null`. */
export function asMessageDeletedFrame(
  data: unknown
): MessageDeletedEvent | null {
  const frame = data as MessageDeletedEvent | undefined;
  if (!frame || frame.type !== "message.deleted") return null;
  if (typeof frame.payload?.message_id !== "string") return null;
  return frame;
}

/**
 * 이슈 #1112 — a message being pinned or unpinned in its channel.
 *
 * `seq` is the **target message's**, reused rather than minted, for the same
 * reason the reaction frame reuses it: a pin is not a message and must not mark
 * the channel unread for everyone.
 *
 * The asymmetry between the two payloads is deliberate and load-bearing.
 * `message.pinned` carries the **whole list entry**, so a header list applies
 * the frame and lands on exactly the state a re-read of `GET …/pins` would have
 * given it — that is what makes the list live without a refetch.
 * `message.unpinned` carries the id alone, because removal needs no projection
 * and re-broadcasting a body on the way out is the mistake the tombstone frame
 * exists to avoid.
 *
 * There is no `message.unpinned` when a *deleted* message loses its pin: the
 * server sweeps the row and the client drops the entry on `message.deleted`,
 * because one event should not arrive as two frames.
 *
 * Ids here are **lowercase** — unlike the reaction frame's. Pin is a new surface
 * with no shipped Swift client to keep compatible, so it uses the API's normal
 * casing; consumers fold anyway, which is what makes that difference invisible.
 */
export interface MessagePinnedEvent {
  type: "message.pinned";
  v: number;
  ts: number;
  seq: number;
  payload: PinnedWirePayload;
}

/** The `message.pinned` payload — snake_case like every broadcast payload. */
export interface PinnedWirePayload {
  message_id: string;
  channel_id: string;
  seq: number;
  author_member_id: string;
  type: string;
  state: string;
  body: string | null;
  created_at_ms: number;
  pinned_by: string;
  pinned_at_ms: number;
}

export interface MessageUnpinnedEvent {
  type: "message.unpinned";
  v: number;
  ts: number;
  seq: number;
  payload: { message_id: string; channel_id: string };
}

export type PinEvent = MessagePinnedEvent | MessageUnpinnedEvent;

/**
 * Narrow a publication to a pin frame, or `null`.
 *
 * The `message.pinned` branch validates **every field the list draws**, not just
 * the id: a frame missing `pinned_at_ms` would sort as `undefined` and sit at
 * the top of the header list forever. A half-decoded pin is worse than a dropped
 * one, because a dropped one is repaired by the next cold load.
 */
export function asPinFrame(data: unknown): PinEvent | null {
  const frame = data as PinEvent | undefined;
  if (!frame) return null;
  if (frame.type === "message.unpinned") {
    const payload = frame.payload;
    if (!payload || typeof payload.message_id !== "string") return null;
    return frame;
  }
  if (frame.type !== "message.pinned") return null;
  const payload = frame.payload;
  if (
    !payload ||
    typeof payload.message_id !== "string" ||
    typeof payload.channel_id !== "string" ||
    typeof payload.seq !== "number" ||
    typeof payload.author_member_id !== "string" ||
    typeof payload.pinned_by !== "string" ||
    typeof payload.pinned_at_ms !== "number" ||
    typeof payload.created_at_ms !== "number"
  ) {
    return null;
  }
  return frame;
}

/** Narrow a publication to a reaction frame, or `null`. */
export function asReactionFrame(data: unknown): ReactionEvent | null {
  const frame = data as ReactionEvent | undefined;
  if (!frame) return null;
  if (frame.type !== "reaction.added" && frame.type !== "reaction.removed") {
    return null;
  }
  const payload = frame.payload;
  if (
    !payload ||
    typeof payload.message_id !== "string" ||
    typeof payload.member_id !== "string" ||
    typeof payload.emoji !== "string" ||
    (payload.action !== "added" && payload.action !== "removed")
  ) {
    return null;
  }
  return frame;
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
  // ADR-0148. `replyTo` is deliberately NOT set here — the frame has no quoted
  // body to set it from, and inventing one would be the snapshot the ADR bans.
  if (typeof p.reply_to_id === "string") message.replyToId = p.reply_to_id;
  if (p.props && typeof p.props === "object") message.props = p.props;
  if (typeof p.edited_at_ms === "number") message.editedAtMs = p.edited_at_ms;
  if (typeof p.deleted_at_ms === "number") message.deletedAtMs = p.deleted_at_ms;
  const attachments = attachmentsFromWire(p.attachments);
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

/**
 * 프레임이 실어 온 첨부 배열 → 화면이 쓰는 배열.
 *
 * 한 건이라도 형상이 어긋나면 **그 건만** 버린다. 배열째 버리면 파일 셋 중 하나가
 * 이상하다는 이유로 나머지 둘까지 화면에서 사라지고, 통째로 믿으면 `undefined`
 * 이름이 카드에 찍힌다. `wire.ts` 의 헬퍼들이 서 있는 규율과 같다: 도착한 것을
 * 서술하되 던지지 않는다.
 */
export function attachmentsFromWire(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const parsed: MessageAttachment[] = [];
  let dropped = 0;
  for (const entry of value) {
    const id = str(entry, "id");
    const name = str(entry, "name");
    const mime = str(entry, "mime");
    const sizeBytes = num(entry, "sizeBytes");
    if (
      id === undefined ||
      name === undefined ||
      mime === undefined ||
      sizeBytes === undefined
    ) {
      dropped += 1;
      continue;
    }
    parsed.push({ id, name, mime, sizeBytes });
  }
  // 화면에는 말하지 않지만 **개발자 채널에는 흔적을 남긴다** (리뷰 N-D).
  //
  // 사람에게 알리지 않는 판단은 그대로다: 이것은 사용자의 행위가 아니라 서버
  // 형상의 오류이고, 받는 쪽에게 애초에 「보낸 줄 아는 파일」이 아니다. 하지만
  // 계약이 어긋났다는 사실 자체는 누군가 알아야 하고, 아무 데도 안 남으면 그것을
  // 알 방법이 없다. 값은 싣지 않는다 — 파일 이름은 사람이 쓴 것이다.
  if (dropped > 0) {
    console.warn(`[momo] dropped ${dropped} malformed attachment(s) from a frame`);
  }
  return parsed;
}

/**
 * 이슈 #1112 — the `message.pinned` payload as the REST list entry.
 *
 * The twin of {@link payloadToMessage}, and it exists for the identical reason:
 * the wire speaks snake_case and the rest of the app speaks camelCase, and a
 * second converter written at each call site is how the two projections drift
 * until a live pin and a cold-loaded one draw differently.
 */
export function pinnedPayloadToWire(
  p: PinnedWirePayload
): PinnedMessageWire {
  return {
    messageId: p.message_id,
    channelId: p.channel_id,
    seq: p.seq,
    authorMemberId: p.author_member_id,
    type: p.type,
    state: p.state,
    body: p.body ?? null,
    createdAtMs: p.created_at_ms,
    pinnedBy: p.pinned_by,
    pinnedAtMs: p.pinned_at_ms,
  };
}

export function centrifugoChannelName(
  workspaceId: string,
  channelId: string
): string {
  return `ch:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`;
}

// ---- 휘발 신호 레일 (ADR-0149 / goal B3 W2) ---------------------------------
// `typing:ws<workspace>.<channel>` 는 **영속 채널과 이름만으로 구별되는** 별도
// 네임스페이스다(가드 1). 그 분리에 얹힌 사실 셋:
//
//   - `history_size: 0` (infra/centrifugo.json). 재접속이 어제의 작성 중을 되살리면
//     유령이 되므로, 재생할 것이 아예 없다. 그래서 이 레일에는 replay gate가 필요
//     없고 `recoverable`/`positioned`를 요구할 이유도 없다.
//   - **seq가 없다.** 휘발 신호는 `message.seq`를 소비하지 않는다(불변식 4). 키가
//     빠져 있고 null이 아닌 이유도 그것이다 — seq로 정렬하는 소비자가 이것을 구멍으로
//     오해할 수 없다.
//   - 구독 인가는 `ch:`와 **같은 술어**다(`routes::realtime::parse_channel`이
//     `EPHEMERAL_NAMESPACE`를 `ch`/`dm`와 같은 arm에 둔다). 그래서 이 채널을 볼 수
//     있는 사람은 그 채널의 메시지를 볼 수 있는 사람과 정확히 같은 집합이다.

/** 「작성 중」 한 건. 서버가 `momo_ephemeral::EphemeralSignal::data`로 만든 그 형상. */
export interface TypingFrame {
  type: "ephemeral.typing";
  v: number;
  ts: number;
  payload: {
    workspace_id: string;
    channel_id: string;
    /** **사람**의 member id. 에이전트는 이 레일을 타지 않는다(ADR-0149 범위). */
    member_id: string;
    /** 밀리초. 구독자가 이 시각에 스스로 잊는다 — 가드 4의 클라 계약 전부다. */
    expires_at: number;
  };
}

/**
 * 발행을 「작성 중」으로 좁힌다. v0가 여는 신호는 하나뿐이고(ADR-0149 범위), 그래서
 * 이 좁힘도 하나만 통과시킨다: 새 휘발 신호가 생기면 서버의 enum과 이 함수가 **함께**
 * 늘어야 하고, 그 둘이 리뷰에 걸리는 것이 가드 2의 클라 쪽 절반이다.
 */
export function asTypingFrame(data: unknown): TypingFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<TypingFrame>;
  if (frame.type !== "ephemeral.typing") return null;
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (
    !payload ||
    typeof payload.workspace_id !== "string" ||
    typeof payload.channel_id !== "string" ||
    typeof payload.member_id !== "string" ||
    typeof payload.expires_at !== "number"
  ) {
    return null;
  }
  // 이미 만료된 신호를 통과시키지 않는다. 값이 과거인 신호는 그릴 수 없는 신호이고,
  // 그것을 명부에 넣으면 다음 sweep까지 한 번 깜박인다.
  if (typeof frame.ts !== "number") return null;
  return frame as TypingFrame;
}

export function centrifugoTypingChannelName(
  workspaceId: string,
  channelId: string
): string {
  return `typing:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`;
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

/**
 * The **boundary event** of a control window (ADR-0004 증보 3 D3 · LIVE-3/4).
 *
 * Built by `momo_t3::display_control::control_window_payload`, and it carries
 * exactly what that ADR clause allows to leave the workspace: 정지 시각,
 * 재개 시각, and why it ended. There is deliberately no `grantee` — who is at
 * the keyboard is a fact for the audit log, which is scoped to people entitled
 * to names, and this envelope goes to every member of the channel. The same
 * count-only discipline `WorkSessionObserverFrame` keeps one boundary over.
 *
 * It is emitted for **every** window, including one opened straight against the
 * REST route with no UI involved. A surface that only drew windows it opened
 * itself would go quiet in exactly the case a reader most needs the truth: the
 * agent is stopped and nothing on screen says why.
 */
export interface WorkSessionControlFrame {
  type: "work.session.control";
  v: number;
  ts: number;
  seq?: number;
  payload: {
    session_id: string;
    state: "opened" | "closed";
    started_at: number;
    ended_at?: number;
    end_reason?: string;
  };
}

export function asWorkSessionControlFrame(
  data: unknown
): WorkSessionControlFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Partial<WorkSessionControlFrame>;
  if (frame.type !== "work.session.control") return null;
  const payload = frame.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.session_id !== "string") return null;
  if (payload.state !== "opened" && payload.state !== "closed") return null;
  // 정지 시각 is the one field with no sensible default: a boundary event that
  // cannot say when control began is not a weaker event, it is one this client
  // has no contract with.
  if (typeof payload.started_at !== "number") return null;
  return frame as WorkSessionControlFrame;
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
      /**
       * B11 — optional so the notification rail, which has nothing to say about
       * a message being withdrawn, is not forced to declare that it ignores it.
       * The timeline supplies both.
       */
      onMessageDeleted?: (event: MessageDeletedEvent) => void;
      onReaction?: (event: ReactionEvent) => void;
      /** 이슈 #1112 — optional for the same reason as the two above. */
      onPin?: (event: PinEvent) => void;
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
      /**
       * A control window opened or closed (ADR-0004 증보 3 D3 · LIVE-4).
       *
       * Optional, like `onReaction` and `onPin` above and for the same reason:
       * a surface that does not draw the boundary must not be forced to invent
       * an empty handler. Unlike `onObserver` the frame's own numbers ARE the
       * fact a reader wants — 정지 시각 and 재개 시각 are what the ADR entitles
       * an agent (and here a person) to learn, and there is no projection on
       * the session list that carries them, so re-reading Postgres would answer
       * with the same silence the frame just broke.
       */
      onControl?: (frame: WorkSessionControlFrame) => void;
      /** A replayed or non-recovered (re)subscribe: heal from REST instead. */
      onResync: () => void;
    }
  ) => () => void;
  /**
   * 「작성 중」을 본다 (ADR-0149).
   *
   * **새 소켓이 아니다.** 기존 클라이언트의 같은 refcount를 타고 채널 하나를 더
   * 구독할 뿐이다. 구독은 **보이는 채널만** 걸어야 한다: 휘발 신호는 채널마다
   * 사람마다 3초에 한 번씩 오므로, 사이드바의 모든 채널을 구독하면 읽지도 않을
   * 프레임이 방 수 x 타이피스트 수만큼 들어온다.
   *
   * `onResync`가 없는 것이 이 레일의 성질이다: 되살릴 과거가 없다
   * (`history_size: 0`). 끊긴 동안의 작성 중은 이미 만료됐으므로 복구할 것이 없고,
   * 재구독 뒤 첫 신호가 곧 현재 상태다.
   */
  subscribeTyping: (
    workspaceId: string,
    channelId: string,
    handlers: { onTyping: (frame: TypingFrame) => void }
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
