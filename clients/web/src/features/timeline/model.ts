import type {
  Channel,
  Message,
  RequestRouting,
  RosterMember,
} from "@/lib/api";
import { uuidEq } from "@/lib/api";

// =============================================================================
// Timeline ordering model (pure). `seq` is the ONLY ordering authority, never
// arrival time, never createdAtMs. Both REST history (descending pages) and
// realtime publications (best-effort, possibly out of order or duplicated) are
// folded into one strictly-ascending-by-seq array, deduped by seq.
//
// This module is shared by the UI (Timeline.tsx) and the seq gate
// (gates/gate-seq.mjs re-implements the identical fold in JS and asserts the
// invariant), so the gate proves the same ordering the user sees.
//
// R-1 §3 adds the render-side derivation on top of that fold: author grouping,
// day separators, the unread boundary, and the reconnect recovery marker. All
// of it is pure and keyed by seq, so tests assert it without mounting a DOM.
// =============================================================================

export interface TimelineState {
  /** Strictly ascending by seq, deduped. Oldest first (render top→bottom). */
  messages: Message[];
  /** Smallest seq loaded, pass as `before` for older history. */
  oldestSeq: number | null;
  /** Largest seq loaded, pass as `after` for realtime-gap backfill. */
  newestSeq: number | null;
}

export function emptyTimeline(): TimelineState {
  return { messages: [], oldestSeq: null, newestSeq: null };
}

// ---- empty surface copy (R-1 §3 빈 상태) ------------------------------------
//
// A channel and a DM are empty for different reasons and have different next
// steps, so they cannot share one line of copy. A channel can gain members, so
// its empty state invites you to bring them. A 1:1 DM cannot: the server fixes
// the participant pair by dmKey (openapi `openDm`), so offering "사람 추가"
// there would be an action the product does not have. What is left in a DM is
// the thing the composer below already does, so the empty state names the
// person and hands focus to the composer instead of inventing a second door.

export interface EmptyChannelCopy {
  headline: string;
  detail: string;
  /** Members can still be added here, so the invite action is offered. */
  invitable: boolean;
}

const DM_DETAIL = "여기 쓴 메시지는 둘만 봅니다. 참여자는 이 둘로 고정됩니다.";

export function emptyChannelCopy(
  kind: Channel["kind"] | null | undefined,
  peer: Pick<RosterMember, "displayName" | "kind"> | null
): EmptyChannelCopy {
  if (kind !== "dm") {
    // R-1 §3 asked for [사람 추가] and [에이전트 추가] as equal buttons, to say
    // that adding an agent is not the lesser path. Two buttons on one handler
    // said it twice and did it once, and this client has no agent-creation
    // surface to send the second one to, so the equality moved into the copy
    // and the surface offers the single action it can actually perform.
    return {
      headline: "이 채널을 함께 시작하세요.",
      detail: "멤버를 초대하면 사람과 에이전트가 같은 자격으로 함께 일합니다.",
      invitable: true,
    };
  }
  if (!peer) {
    // Roster not loaded yet: name nothing rather than name the wrong thing.
    return {
      headline: "다이렉트 메시지를 시작하세요.",
      detail: DM_DETAIL,
      invitable: false,
    };
  }
  return {
    headline:
      peer.kind === "agent"
        ? `${peer.displayName}님에게 첫 일을 맡겨보세요.`
        : `${peer.displayName}님과의 대화를 시작하세요.`,
    detail: DM_DETAIL,
    invitable: false,
  };
}

/** Binary-search insertion index for `seq` in an ascending array. */
function lowerBound(messages: Message[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Merge a batch (any order, may overlap existing) into ascending-by-seq order.
 * Last write wins per seq (realtime edits/tombstones replace history rows).
 *
 * Canonical name per R-1 §공통계약: history pages, realtime publications and
 * `?after` backfill all land here, so a reconnect reconciles by seq instead of
 * appending blindly.
 */
export function reconcileMessages(
  state: TimelineState,
  batch: Message[]
): TimelineState {
  if (batch.length === 0) return state;
  const next = state.messages.slice();
  for (const msg of batch) {
    const idx = lowerBound(next, msg.seq);
    if (idx < next.length && next[idx].seq === msg.seq) {
      next[idx] = msg; // replace duplicate seq (edit/tombstone/re-fetch)
    } else {
      next.splice(idx, 0, msg);
    }
  }
  return {
    messages: next,
    oldestSeq: next.length ? next[0].seq : null,
    newestSeq: next.length ? next[next.length - 1].seq : null,
  };
}

/** Live-append alias of {@link reconcileMessages} (R-1 §공통계약 vocabulary). */
export const mergeMessages = reconcileMessages;

/**
 * Mark one message as deleted **in place** (B11).
 *
 * Keyed by id, not by seq, because the id is all a `message.deleted` frame
 * carries — and it carries only that on purpose: a tombstone that re-broadcast
 * its body would put the erased text back on every connected client.
 *
 * The row stays in the array and keeps its seq. Removing it is the tempting
 * shortcut and the wrong one: `seq` is both the ordering authority and the
 * recovery cursor, so a message that vanishes leaves a gap indistinguishable
 * from one this client failed to receive, and the next reconnect would set out
 * to heal it.
 *
 * Returns the same state when nothing matched, so a tombstone for a message this
 * client never loaded costs no render.
 */
export function applyTombstone(
  state: TimelineState,
  messageId: string,
  deletedAtMs?: number
): TimelineState {
  const idx = state.messages.findIndex((msg) => uuidEq(msg.id, messageId));
  if (idx === -1) return state;
  const existing = state.messages[idx];
  if (existing.state === "deleted") return state;
  const next = state.messages.slice();
  next[idx] = {
    ...existing,
    state: "deleted",
    body: undefined,
    deletedAtMs: deletedAtMs ?? existing.deletedAtMs ?? Date.now(),
  };
  return { ...state, messages: next };
}

// ---- message action affordances (B11) --------------------------------------
//
// The server is the authority: it answers 403 to anyone but the author and 400
// on a tombstone. These predicates decide only what to *show*, and they are
// deliberately separate from the requests — an action that is visible but always
// fails teaches people to distrust the UI, and one that is hidden where the
// server would have allowed it is a feature nobody finds.

/**
 * A deleted or failed message is nobody's to act on, its author's included.
 * `failed` is a client-side state for a send that never landed, so there is no
 * server row behind it to edit.
 */
function isActionable(message: Message): boolean {
  return message.state !== "deleted" && message.state !== "failed";
}

/**
 * Only the author, and only while the message is live. Mirrors the server's
 * "only the message author may edit": an admin cannot rewrite what someone else
 * said, because a permission model that allowed it would make every quoted
 * message deniable.
 */
export function canEditMessage(
  message: Message,
  myMemberId: string | undefined
): boolean {
  if (!isActionable(message)) return false;
  // Only plain text has an editable body. A tool result or an artifact card is
  // a projection of something else, so "editing" it would edit nothing.
  if (message.type !== "text") return false;
  return uuidEq(message.authorMemberId, myMemberId);
}

/** The same authority as {@link canEditMessage}, without the text-only rule. */
export function canDeleteMessage(
  message: Message,
  myMemberId: string | undefined
): boolean {
  if (!isActionable(message)) return false;
  return uuidEq(message.authorMemberId, myMemberId);
}

/**
 * Anyone in the channel may react to a live message — no authorship gate, and no
 * agent branch: an agent member is reacted to exactly like a person.
 */
export function canReactToMessage(message: Message): boolean {
  return isActionable(message);
}

/**
 * Replies hang off a **root**, and momo threads are one level deep (Slack's
 * model): the server refuses a `rootId` that is itself a reply with "thread root
 * must be a top-level message". Offering 답글 on a reply would be an action that
 * always fails.
 */
export function canReplyToMessage(message: Message): boolean {
  return isActionable(message) && !message.rootId;
}

/** What a row may offer, all four answers together. */
export interface MessageActionAvailability {
  reply: boolean;
  react: boolean;
  edit: boolean;
  delete: boolean;
}

/**
 * True when at least one action is on offer. A row with none gets no hover bar
 * and no long-press at all — an empty sheet is worse than no sheet, because it
 * costs the gesture and answers nothing.
 */
export function hasAnyAction(available: MessageActionAvailability): boolean {
  return (
    available.reply || available.react || available.edit || available.delete
  );
}

/** True iff messages are strictly ascending by seq with no duplicates. */
export function isStrictlyOrdered(messages: Message[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].seq <= messages[i - 1].seq) return false;
  }
  return true;
}

// ---- render derivation (R-1 §3) --------------------------------------------

/** Author group window: a new header after 5 minutes of the same author. */
export const AUTHOR_GROUP_WINDOW_MS = 300_000;

/** The two fields grouping depends on; a pending row has them before it has a seq. */
export type GroupingRow = Pick<Message, "authorMemberId" | "createdAtMs">;

/** Local-day key, used for the day separator and to force a group break. */
export function dayKey(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * A message starts a new author group when the author changes, when more than
 * AUTHOR_GROUP_WINDOW_MS passed since the previous message, or across a day
 * boundary. Continuation rows drop the header for density (Slack convention).
 */
export function startsAuthorGroup(
  previous: GroupingRow | undefined,
  current: GroupingRow
): boolean {
  if (!previous) return true;
  if (!uuidEq(previous.authorMemberId, current.authorMemberId)) return true;
  if (current.createdAtMs - previous.createdAtMs > AUTHOR_GROUP_WINDOW_MS) {
    return true;
  }
  return dayKey(previous.createdAtMs) !== dayKey(current.createdAtMs);
}

// ---- 멈춘 에이전트 알림 접기 (goal P3 1-2) -----------------------------------
//
// 서버는 멈춘 에이전트를 부를 때마다 시스템 한 줄을 남긴다: `type: "system"`,
// `props.kind = "agent_paused"`, 그리고 그 줄을 부른 메시지의 id
// (MessageRoutes.swift `insertPausedMentionSystemLine` / mention.rs
// `paused_mention_props`). 1:1 DM에서는 사람이 쓰는 **모든** 메시지가 상대
// 에이전트를 부르므로, 다섯 번 말하면 똑같은 문장이 다섯 줄 쌓인다.
//
// 접는 것은 여기, 렌더 파생에서만 한다. 서버의 paused 경로도, `messages` 배열도
// 건드리지 않는다 — 배열에서 지우면 seq에 구멍이 생기고 그 구멍은 이 클라이언트가
// 받지 못한 것과 구별되지 않아 다음 재연결이 그것을 메우러 나선다(applyTombstone
// 주석과 같은 이유다).
//
// 없애는 것은 반복이지 정보가 아니다. 살아남는 줄은 **마지막** 것이라 사람이 방금
// 보낸 메시지 바로 밑에 앉고, 그래서 "왜 답이 없지"의 답은 언제나 가장 최근 질문
// 옆에 있다. 접힌 개수는 그 줄이 자기 옆에 적으므로 몇 번이 응답 없이 지나갔는지도
// 화면에 남는다.
//
// 접기를 멈추는 세 자리가 있고, 셋 다 "그 둘은 같은 말이 아니다"라는 한 가지
// 이유에서 나온다:
//   1. 사이에 그 에이전트가 **말했다** — 정지가 풀렸다가 다시 걸린 것이므로 뒤의
//      알림은 반복이 아니라 새 소식이다.
//   2. 두 알림을 부른 사람이 **다르다** — 채널에서 A와 B가 각각 멘션한 모양이다.
//      각 알림은 자기를 부른 멘션 옆에 남아야지, 남의 멘션 밑으로 끌려가면 안 된다.
//   3. 사이에 **날이 바뀌었다** — 접으면 알림이 다른 날짜 구분선 아래로 옮겨
//      앉는다. 타임라인이 이미 선을 그은 자리를 렌더 파생이 넘을 수는 없다.

/** 서버가 이 시스템 줄에 붙이는 표식 (Swift :1602 / mention.rs). */
export const PAUSED_NOTICE_KIND = "agent_paused";

function propString(
  props: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 이 행이 「에이전트 일시정지」 알림이면 그 에이전트의 member id, 아니면 null.
 *
 * `props.agent_member_id`가 정본이고 작성자는 대비책이다. 서버는 이 줄을 그
 * 에이전트 자신의 이름으로 쓰므로 둘은 같은 값이지만, 비교는 언제나 `uuidEq`가
 * 한다 — Swift는 UUID를 대문자로 내고 이 두 키만 소문자로 쓰기 때문에, 한 응답
 * 안에서도 대소문자가 갈린다.
 */
export function pausedNoticeAgentId(message: Message): string | null {
  if (message.type !== "system") return null;
  if (propString(message.props, "kind") !== PAUSED_NOTICE_KIND) return null;
  return propString(message.props, "agent_member_id") ?? message.authorMemberId;
}

/** 어떤 알림이 접혔고, 살아남은 알림이 몇 개를 대신하는가. */
export interface PausedNoticeFold {
  /** 접혀서 그려지지 않는 알림의 seq. */
  suppressed: Set<number>;
  /** 살아남은 알림의 seq → 그것이 대신하는 알림 수. 2 이상일 때만 들어 있다. */
  repeats: Map<number, number>;
}

export function emptyPausedNoticeFold(): PausedNoticeFold {
  return { suppressed: new Set(), repeats: new Map() };
}

/**
 * 알림을 부른 메시지의 작성자. 서버가 알림에 적어 둔 `source_message_id`가
 * 정본이고, 그 메시지가 아직 안 실린 페이지에 있으면 바로 윗행으로 물러선다
 * (서버는 멘션 바로 다음 seq에 알림을 쓴다).
 *
 * 못 찾으면 null이고, null은 "다른 사람"으로 친다 — 모르면 접지 않는 쪽이 안전한
 * 방향이다. 접기는 되돌릴 수 있지만 남의 멘션 밑으로 끌려간 알림은 오독이다.
 */
function noticeTriggerAuthor(
  notice: Message,
  previousRow: Message | undefined,
  bySourceId: Map<string, Message>
): string | null {
  const sourceId = propString(notice.props, "source_message_id");
  const source = sourceId ? bySourceId.get(sourceId.toLowerCase()) : undefined;
  if (source) return source.authorMemberId;
  return previousRow?.authorMemberId ?? null;
}

/**
 * 연속된 「일시정지」 알림을 마지막 하나로 접는다. 순수 함수이고, 입력 배열은
 * 그대로 둔다 — 접기는 {@link buildTimelineItems}가 그리는 순간에만 일어난다.
 */
export function foldPausedNotices(messages: Message[]): PausedNoticeFold {
  const fold = emptyPausedNoticeFold();
  if (messages.length === 0) return fold;

  const bySourceId = new Map<string, Message>();
  for (const message of messages) bySourceId.set(message.id.toLowerCase(), message);

  // 묶음을 먼저 **모으고**, 접는 것은 그다음이다. 세면서 접으면 "지금까지 몇
  // 개"가 진행 중인 묶음 안에 들어가야 하는데, 그 값이 다음 판단의 입력이 되는
  // 순간 읽기와 쓰기가 한 변수에서 만난다. 두 단계로 나누면 각 단계는 한 방향만
  // 본다: 위는 어디서 끊기는지만, 아래는 모인 것을 어떻게 그릴지만.
  const runs: Message[][] = [];
  let current: Message[] = [];
  /** 열린 묶음이 말하고 있는 에이전트와, 그를 부른 사람. */
  let runAgent: string | null = null;
  let runTrigger: string | null = null;
  let previousRow: Message | undefined;

  for (const message of messages) {
    const agentId = pausedNoticeAgentId(message);
    if (agentId === null) {
      // 그 에이전트가 말했다 → 정지가 풀렸던 것이므로 묶음을 끊는다 (①).
      if (runAgent !== null && uuidEq(message.authorMemberId, runAgent)) {
        runs.push(current);
        current = [];
        runAgent = null;
        runTrigger = null;
      }
      previousRow = message;
      continue;
    }

    const trigger = noticeTriggerAuthor(message, previousRow, bySourceId);
    const last = current[current.length - 1];
    const continues =
      last !== undefined &&
      runAgent !== null &&
      uuidEq(runAgent, agentId) &&
      runTrigger !== null &&
      trigger !== null &&
      uuidEq(runTrigger, trigger) && // ②
      dayKey(last.createdAtMs) === dayKey(message.createdAtMs); // ③

    if (!continues) {
      if (current.length > 0) runs.push(current);
      current = [];
      runAgent = agentId;
      runTrigger = trigger;
    }
    current.push(message);
    previousRow = message;
  }
  if (current.length > 0) runs.push(current);

  // 한 묶음에서 살아남는 것은 마지막 하나뿐이고, 그 하나가 묶음의 크기를 진다.
  // 혼자인 묶음은 접을 것이 없으므로 아무 표시도 남기지 않는다.
  for (const run of runs) {
    if (run.length < 2) continue;
    for (const notice of run.slice(0, -1)) fold.suppressed.add(notice.seq);
    fold.repeats.set(run[run.length - 1].seq, run.length);
  }
  return fold;
}

/**
 * A reconnect that healed a gap. `seq` is the newest seq confirmed present
 * after the heal, which is exactly what the marker states to the user: no
 * clock skew, no "since 5 seconds ago" guess (R-1 §3, momo 우위).
 */
export interface RecoveryMarker {
  /** Stable key, monotonic per session. */
  id: string;
  /** Newest seq confirmed present after the resubscribe healed the gap. */
  seq: number;
  /** Whether the transport replayed the gap, or REST `?after` backfill did. */
  source: "replay" | "backfill";
}

// ---- optimistic insert (M10, R-1 §3 "로컬 echo → seq 도착 시 reconcile") -----
//
// A message the user just sent has no seq yet: the server mints it inside the
// write transaction (REST -> PG -> outbox -> relay). Since seq is the ONLY
// ordering authority in this module, a local echo must never be given a fake
// one. Pending rows therefore live OUTSIDE the seq array, as a tail overlay
// appended after the confirmed stream, and the confirmed array keeps its
// strictly-ascending-by-seq invariant untouched (the seq gate re-implements
// that fold and would catch any violation).
//
// Settlement, i.e. how a pending row is replaced by its confirmed twin:
//   1. the POST response carries clientMsgId AND seq, so the sender always
//      learns the exact identity of its own message (the strong path);
//   2. but the realtime `message.new` frame does NOT carry client_msg_id
//      (MessageRoutes.broadcastPayload: id/seq/type/body/author/hlc/root only),
//      and it can beat the POST response back to this client. During that
//      window the confirmed row is already on screen while the pending row is
//      still waiting, which is exactly the duplicate this fold removes.
//
// So settlement is decided by the render fold, on content the realtime frame
// does carry: same author, same body, and a seq ABOVE the newest one that
// existed when the send started. That last clause is what keeps an older
// identical message ("네") from swallowing a fresh send. Each confirmed message
// settles at most one pending row, oldest first, so sending the same text twice
// still shows two rows and settles them one at a time.

export interface PendingMessage {
  /** Idempotency key (L4 §3.1). Stable across retries of the same attempt. */
  clientMsgId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  createdAtMs: number;
  /** newestSeq at the moment the send started; the echo must land above it. */
  sinceSeq: number | null;
  status: "sending" | "failed";
  /**
   * The composer's per-request model/effort override for THIS send (ADR-0134
   * D1). Absent for every send that inherits, which is every send that predates
   * this field. It rides the row so a retry replays the choice the person made:
   * dropping it would send a different request under the same idempotency key.
   */
  routing?: RequestRouting;
}

/** True when `message` is the server's echo of `pending`. */
export function confirmsPending(
  message: Message,
  pending: PendingMessage
): boolean {
  if (message.type !== "text") return false;
  if (message.state === "deleted") return false;
  if (pending.sinceSeq !== null && message.seq <= pending.sinceSeq) return false;
  if (!uuidEq(message.authorMemberId, pending.authorMemberId)) return false;
  return (message.body ?? "") === pending.body;
}

/**
 * The pending rows that are still unconfirmed against this message array, in
 * send order. One confirmed message settles at most one pending row.
 */
export function unsettledPending(
  messages: Message[],
  pending: PendingMessage[]
): PendingMessage[] {
  if (pending.length === 0) return pending;
  const open = pending.slice();
  for (const message of messages) {
    const index = open.findIndex((p) => confirmsPending(message, p));
    if (index >= 0) open.splice(index, 1);
    if (open.length === 0) break;
  }
  return open;
}

// ---- pending list transitions (pure, so the hook holds no logic) ------------

export function addPending(
  list: PendingMessage[],
  pending: PendingMessage
): PendingMessage[] {
  return [...list, pending];
}

export function removePending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.filter((p) => p.clientMsgId !== clientMsgId);
}

/** The send attempt failed. The row stays put and offers a retry (R-1 §3). */
export function failPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "failed" } : p
  );
}

/**
 * Retry a failed row. The clientMsgId is deliberately REUSED: a failed POST
 * may still have committed on the server (a dropped response, a timeout), and
 * the idempotency key is exactly what turns that ambiguity into a guarantee.
 * Re-sending with the same key returns the original message instead of writing
 * a second one, which is what makes the duplicate count zero here.
 */
export function retryPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "sending" } : p
  );
}

export type TimelineItem =
  | { kind: "day"; key: string; atMs: number }
  | { kind: "unread"; key: string; count: number }
  | { kind: "recovery"; key: string; seq: number; source: "replay" | "backfill" }
  | {
      kind: "message";
      key: string;
      message: Message;
      startsGroup: boolean;
      /**
       * 이 행이 「일시정지」 알림이고 앞선 같은 알림들을 대신하고 있을 때, 자기를
       * 포함해 몇 개를 대신하는지 (2 이상). 그 외의 행에는 없다.
       */
      pausedRepeat?: number;
    }
  | { kind: "pending"; key: string; pending: PendingMessage; startsGroup: boolean };

export interface BuildItemsOptions {
  /** Server read cursor (P7). The divider sits above the first newer message. */
  lastReadSeq?: number | null;
  /** Server unread count for the channel; rendered on the divider. */
  unreadCount?: number;
  /** Reconnect markers, each anchored after the seq it recovered up to. */
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes of messages this client sent, still awaiting their seq. */
  pending?: PendingMessage[];
}

/**
 * Fold the ascending message array into the render stream: day separators, the
 * unread boundary, reconnect markers, and author-group flags.
 */
export function buildTimelineItems(
  messages: Message[],
  options: BuildItemsOptions = {}
): TimelineItem[] {
  const {
    lastReadSeq = null,
    unreadCount = 0,
    recoveryMarkers = [],
    pending = [],
  } = options;
  const items: TimelineItem[] = [];
  let previous: Message | undefined;
  let unreadPlaced = false;
  // A divider cuts the visual thread of an author group, so the row on the far
  // side of it must re-introduce its author. Without this the first row under
  // "새 메시지 3개" or "재연결됨" is anonymous whenever the same author happens
  // to continue across the line, which is exactly when the reader is least able
  // to infer who is speaking. Day dividers need no flag: a day boundary already
  // forces a group through startsAuthorGroup.
  let dividerAbove = false;

  // Markers anchor AFTER the newest loaded message at or below their seq, so
  // "seq N까지 복구" reads as a line drawn under everything it confirmed.
  const markersBySeq = new Map<number, RecoveryMarker[]>();
  for (const marker of recoveryMarkers) {
    let anchor: number | null = null;
    for (const message of messages) {
      if (message.seq <= marker.seq) anchor = message.seq;
      else break;
    }
    if (anchor === null) continue; // nothing loaded at or below it yet
    const list = markersBySeq.get(anchor);
    if (list) list.push(marker);
    else markersBySeq.set(anchor, [marker]);
  }

  // 반복된 「일시정지」 알림은 마지막 하나만 그린다. 배열이 아니라 이 스트림에서만
  // 빠지므로 seq도, 커서도, 재연결 복구도 접기를 모른다.
  const pausedFold = foldPausedNotices(messages);

  for (const message of messages) {
    // 그리지 않을 행은 날짜 구분선도 저자 묶음도 만들지 않는다: `previous`는
    // 언제나 **화면에 남은** 직전 행이어야 접힌 자리에 빈 헤더가 생기지 않는다.
    if (pausedFold.suppressed.has(message.seq)) continue;
    if (
      !previous ||
      dayKey(previous.createdAtMs) !== dayKey(message.createdAtMs)
    ) {
      items.push({
        kind: "day",
        key: `day-${dayKey(message.createdAtMs)}`,
        atMs: message.createdAtMs,
      });
    }
    if (
      !unreadPlaced &&
      lastReadSeq !== null &&
      unreadCount > 0 &&
      message.seq > lastReadSeq
    ) {
      items.push({
        kind: "unread",
        key: `unread-${lastReadSeq}`,
        count: unreadCount,
      });
      unreadPlaced = true;
      dividerAbove = true;
    }
    items.push({
      kind: "message",
      key: `m-${message.seq}`,
      message,
      startsGroup: dividerAbove || startsAuthorGroup(previous, message),
      pausedRepeat: pausedFold.repeats.get(message.seq),
    });
    dividerAbove = false;
    for (const marker of markersBySeq.get(message.seq) ?? []) {
      items.push({
        kind: "recovery",
        key: `r-${marker.id}`,
        seq: marker.seq,
        source: marker.source,
      });
      dividerAbove = true;
    }
    previous = message;
  }

  // Pending rows close the stream: they are always the newest thing the user
  // did, and they carry no seq to be sorted by. A row whose confirmed twin is
  // already in `messages` is dropped here, which is where "중복 0" is enforced
  // regardless of whether the POST response or the realtime frame won the race.
  let previousRow: GroupingRow | undefined = previous;
  for (const row of unsettledPending(messages, pending)) {
    items.push({
      kind: "pending",
      key: `p-${row.clientMsgId}`,
      pending: row,
      startsGroup: dividerAbove || startsAuthorGroup(previousRow, row),
    });
    dividerAbove = false;
    previousRow = row;
  }
  return items;
}
