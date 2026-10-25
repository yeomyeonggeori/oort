import type { Message, ReadState } from "../../lib/api";
import { threadRollup, uuidEq } from "../../lib/api";
import { effectiveUnreadStartSeq } from "../readState/model";
import { attachmentPreviewLine } from "../attachments/model";
import type { FilterTabsSpec } from "../common/filterTabs";
import type { InboxWireKind, ServerInboxItem } from "./serverInbox";
import {
  actorToken,
  relativeLabel,
  type ActorNames,
  type FeedItem,
} from "./model";

// =============================================================================
// 인박스 = 나와 관련된 것의 목록 (#3663, 원천 교체 #3684/ADR-0199). 메일함·알림함처럼
// 한 줄 한 줄이 「누가, 어디서, 무슨 일로 나를 찾았는가」를 말하고, 오른쪽 패널이 그
// 맥락을 연다.
//
// 이 파일은 순수 판정이다. 항목의 원천은 둘이고, 화면은 어느 쪽이든 같은 모양
// (MailboxEntry)만 본다.
//
// ## 서버 투영 (정본, `serverEntry`)
//
// 서버가 `GET /inbox`로 「나와 관련된 것」을 기억해서 준다(ADR-0199). 종류는
// 답글(reply: 내 글에 답·인용), 멘션, 스레드, DM이고, 읽은 항목도 30일 동안 목록에
// 남는다. 읽음은 **항목마다** 서버가 가진다: 항목을 읽어도 채널 읽음 위치는 움직이지
// 않고, 채널에서 읽으면 그 안의 항목이 함께 읽음이 된다(한 방향).
//
// ## 구 서버 후퇴 (`dmEntry`·`mentionEntry`·`threadEntry`·`composeMailbox`)
//
// 인박스 투영이 없는 서버(v0.1.20 이하)는 `GET /inbox`가 404다. 그때만 이미 있는 네 가지
// 읽기 계약을 클라이언트에서 모은다.
//
//   DM       DM 채널의 최근 메시지 페이지 + 채널 read-state(읽음/안 읽음 둘 다 보인다)
//   멘션     read-state.mention_count 뒤의 메시지 중 서버가 기록한 멘션(안 읽은 것만)
//   스레드   내가 쓴 글의 `thread` 롤업(last_reply_seq)이 읽음 기준 뒤에 있는 것
//   처리할 일 대기 중 승인(`GET …/approvals?status=pending`)
//
// 후퇴 경로의 읽음 기준은 채널 커서 하나다(ADR-0178 D3). 안 읽음은 언제나
// `effectiveUnreadStartSeq(readState)` 이후인가로만 판정하고, 한 항목을 읽음으로
// 표시하면 같은 채널의 그 앞 메시지도 함께 읽음이 된다.
//
// 어느 경로든 처리할 일(승인)은 서버 투영에 저장되지 않는 상태 사실이라 따로 합친다.
// 클라이언트가 채널을 훑어 역사를 만들지 않는다(P7): 후퇴 경로가 읽은 멘션과 내가 답만
// 한 스레드를 못 보여 주는 것은 알려진 한계이고, 서버 경로가 그것을 채운다.
// =============================================================================

export type MailboxKind = "dm" | "mention" | "reply" | "thread" | "task";

export type MailboxFilter =
  | "all"
  | "unread"
  | "mention"
  | "reply"
  | "dm"
  | "thread"
  | "task";

export const MAILBOX_FILTERS: readonly MailboxFilter[] = [
  "all",
  "unread",
  "mention",
  "reply",
  "dm",
  "thread",
  "task",
];

const FILTER_LABEL: Record<MailboxFilter, string> = {
  all: "전체",
  unread: "안 읽음",
  mention: "멘션",
  reply: "답글",
  dm: "DM",
  thread: "스레드",
  task: "처리할 일",
};

export function mailboxFilterLabel(filter: MailboxFilter): string {
  return FILTER_LABEL[filter];
}

export function parseMailboxFilter(raw: string | null): MailboxFilter {
  return MAILBOX_FILTERS.includes(raw as MailboxFilter)
    ? (raw as MailboxFilter)
    : "all";
}

export function mailboxTabId(filter: MailboxFilter): string {
  return `inbox-tab-${filter}`;
}

export function mailboxPanelId(filter: MailboxFilter): string {
  return `inbox-panel-${filter}`;
}

export const MAILBOX_FILTER_TABS: FilterTabsSpec<MailboxFilter> = {
  label: "인박스 필터",
  values: MAILBOX_FILTERS,
  labelFor: mailboxFilterLabel,
  tabId: mailboxTabId,
  panelId: mailboxPanelId,
  testId: mailboxTabId,
};

export interface MailboxEntry {
  /** 목록 안에서 유일한 키. 채널이 같아도 종류가 다르면 다른 항목이다. */
  key: string;
  kind: MailboxKind;
  channelId: string;
  /** 사람이 읽는 채널 이름 (DM은 상대 이름). */
  channelLabel: string;
  /** 「DM · 서연」 / 「멘션 · #workbench」 / 「스레드 · #workbench」 / 「처리할 일」. */
  typeLabel: string;
  /** 아바타와 한 줄의 주어. 에이전트면 `@handle`. */
  actor: string;
  actorMemberId?: string;
  actorIsAgent: boolean;
  /** 본문 한 줄. 비어 있으면 빈 문자열이 아니라 `undefined`가 아닌 설명 문장이 온다. */
  preview: string;
  atMs: number;
  timeLabel: string;
  unread: boolean;
  /** DM·스레드에서 안 읽은 메시지 수(서버 커서 산술). 0이면 숫자 없음. */
  unreadCount: number;
  /** 타임라인 앵커와 읽음 커서를 옮길 위치. */
  seq?: number;
  messageId?: string;
  /** 스레드 항목의 루트 메시지 id. 답장은 이 루트로 보낸다. */
  rootId?: string;
  /** 스레드 항목: 내 글(루트)의 본문 한 줄. 패널이 맥락 맨 위에 둔다. */
  rootPreview?: string;
  /** 처리할 일이면 결정 컨트롤을 그릴 승인 행. */
  task?: FeedItem;
  /** 「왜 이게 여기 왔는지」. */
  reason: string;
  /**
   * 서버 투영 항목의 id. 있으면 읽음은 `PUT …/inbox/{id}/read`이고 채널 읽음 위치는
   * 움직이지 않는다. 없으면(후퇴 경로) 채널 커서가 읽음 기준이다.
   */
  itemId?: string;
  /** 서버가 붙인 사유 전부(우선순위 순). 필터는 종류가 아니라 이 사유로 건다. */
  reasons?: readonly MailboxKind[];
  /** 답글 항목: 내가 쓴 글(인용된 글)의 본문 한 줄. */
  quotedPreview?: string;
  quotedDeleted?: boolean;
}

// ---- 읽음 -------------------------------------------------------------

/** 이 채널 상태에서 `seq`가 안 읽은 쪽인가. 합성은 `effectiveUnreadStartSeq` 한 곳. */
export function isUnreadSeq(
  readState: ReadState | undefined,
  seq: number
): boolean {
  if (!readState) return false;
  return seq >= effectiveUnreadStartSeq(readState);
}

function unreadCountOf(readState: ReadState | undefined): number {
  if (!readState) return 0;
  const start = effectiveUnreadStartSeq(readState);
  return Math.max(0, readState.latestSeq - start + 1);
}

// ---- 빌더 -------------------------------------------------------------

function bodyLine(message: Message): string {
  if (message.state === "deleted") return "삭제된 메시지예요.";
  const body = (message.body ?? "").trim().replace(/\s+/g, " ");
  if (body.length > 0) return body;
  // 글 없이 사진·파일만 보낸 메시지(#4294): 「내용 없는 메시지」가 아니라 무엇이 왔는지 말한다.
  return attachmentPreviewLine(message.attachments) ?? "내용 없는 메시지예요.";
}

function isConversational(message: Message): boolean {
  return message.type === "text" && message.rootId === undefined;
}

/**
 * DM 한 건. 최근 페이지에서 가장 새 대화형 메시지를 대표로 삼는다.
 *
 * 마지막 말이 내 것이어도 항목은 남는다: 메일함의 「대화」처럼 읽은 DM도 목록에서
 * 사라지지 않는다. 그때는 상대의 마지막 말이 아니라 내 말이므로 「나:」로 구분한다.
 */
export function dmEntry(input: {
  channelId: string;
  channelLabel: string;
  readState: ReadState | undefined;
  messages: readonly Message[];
  selfMemberId: string;
  actorFor: (memberId: string) => ActorNames;
  nowMs: number;
}): MailboxEntry | null {
  const candidates = input.messages.filter(isConversational);
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (b.seq > a.seq ? b : a));
  const mine = uuidEq(latest.authorMemberId, input.selfMemberId);
  const actor = input.actorFor(latest.authorMemberId);
  const unreadCount = unreadCountOf(input.readState);
  // 읽음 판정은 채널 커서 하나다. 내 말이 대표여도 그 뒤에 안 읽은 것이 있을 수는 없다.
  const unread = !mine && isUnreadSeq(input.readState, latest.seq);
  return {
    key: `dm:${input.channelId.toLowerCase()}`,
    kind: "dm",
    channelId: input.channelId,
    channelLabel: input.channelLabel,
    typeLabel: `DM · ${input.channelLabel}`,
    actor: mine ? "나" : actorToken(actor),
    actorMemberId: latest.authorMemberId,
    actorIsAgent: !mine && actor.isAgent,
    preview: mine ? `나: ${bodyLine(latest)}` : bodyLine(latest),
    atMs: latest.createdAtMs,
    timeLabel: relativeLabel(latest.createdAtMs, input.nowMs),
    unread,
    unreadCount: unread ? unreadCount : 0,
    seq: latest.seq,
    messageId: latest.id,
    reason: mine
      ? "내가 보낸 마지막 말이 있는 DM이에요."
      : "DM으로 온 메시지예요.",
  };
}

/** 멘션 한 건. 서버가 기록한 멘션만 온다(`mention_member_ids`). 안 읽은 것뿐이다. */
export function mentionEntry(
  message: Message,
  actor: ActorNames,
  channelLabel: string,
  nowMs: number
): MailboxEntry {
  return {
    key: `mention:${message.id}`,
    kind: "mention",
    channelId: message.channelId,
    channelLabel,
    typeLabel: `멘션 · ${channelLabel}`,
    actor: actorToken(actor),
    actorMemberId: message.authorMemberId,
    actorIsAgent: actor.isAgent,
    preview: bodyLine(message),
    atMs: message.createdAtMs,
    timeLabel: relativeLabel(message.createdAtMs, nowMs),
    unread: true,
    unreadCount: 0,
    seq: message.seq,
    messageId: message.id,
    ...(message.rootId === undefined ? {} : { rootId: message.rootId }),
    reason: "메시지에서 나를 불러 서버가 멘션으로 기록했어요.",
  };
}

/**
 * 내 글에 달린 새 답글. 내가 쓴 루트의 롤업이 읽음 기준 뒤에 있을 때만 항목이 된다.
 *
 * 롤업에는 마지막 답글의 본문이 없다. 본문을 이미 받아 둔 답글(`lastReply`)이 있으면
 * 그 한 줄을, 아니면 루트 본문을 보여 주고 「답글 N개」로 이유를 말한다.
 */
export function threadEntry(input: {
  root: Message;
  channelLabel: string;
  readState: ReadState | undefined;
  lastReply: Message | undefined;
  selfMemberId: string;
  actorFor: (memberId: string) => ActorNames;
  nowMs: number;
}): MailboxEntry | null {
  const rollup = threadRollup(input.root);
  if (rollup === null) return null;
  if (!uuidEq(input.root.authorMemberId, input.selfMemberId)) return null;
  if (!isUnreadSeq(input.readState, rollup.lastReplySeq)) return null;
  const reply = input.lastReply;
  const replyAuthor = reply ? input.actorFor(reply.authorMemberId) : undefined;
  const actor = replyAuthor ? actorToken(replyAuthor) : "스레드";
  return {
    key: `thread:${input.root.id}`,
    kind: "thread",
    channelId: input.root.channelId,
    channelLabel: input.channelLabel,
    typeLabel: `스레드 · ${input.channelLabel}`,
    actor,
    ...(reply ? { actorMemberId: reply.authorMemberId } : {}),
    actorIsAgent: replyAuthor?.isAgent ?? false,
    preview: reply
      ? bodyLine(reply)
      : `내 글에 답글 ${rollup.replyCount}개: ${bodyLine(input.root)}`,
    atMs: rollup.lastReplyAtMs,
    timeLabel: relativeLabel(rollup.lastReplyAtMs, input.nowMs),
    unread: true,
    unreadCount: 0,
    seq: rollup.lastReplySeq,
    messageId: input.root.id,
    rootId: input.root.id,
    rootPreview: bodyLine(input.root),
    reason: "내가 쓴 글에 새 답글이 달렸어요.",
  };
}

/** 처리할 일 한 건: 결정을 기다리는 승인. 결정할 수 있는 행(`approvalId`)만 온다. */
export function taskEntry(item: FeedItem, nowMs: number): MailboxEntry | null {
  if (item.approvalId === undefined || !item.pending) return null;
  return {
    key: item.key,
    kind: "task",
    channelId: item.channelId,
    channelLabel: item.channelLabel,
    typeLabel: "처리할 일 · 승인 요청",
    actor: item.actor,
    actorIsAgent: item.actorIsAgent,
    preview: item.predicate,
    atMs: item.sortAtMs > 0 ? item.sortAtMs : nowMs,
    timeLabel: item.timeLabel,
    unread: true,
    unreadCount: 0,
    ...(item.seq === undefined ? {} : { seq: item.seq }),
    ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
    task: item,
    reason: item.reason,
  };
}

// ---- 서버 투영 항목 -----------------------------------------------------

const SERVER_KIND: Record<InboxWireKind, Exclude<MailboxKind, "task">> = {
  reply_to_me: "reply",
  mention: "mention",
  thread_reply: "thread",
  dm: "dm",
};

const SERVER_TYPE_LABEL: Record<Exclude<MailboxKind, "task">, string> = {
  reply: "답글",
  mention: "멘션",
  thread: "스레드",
  dm: "DM",
};

const SERVER_REASON: Record<Exclude<MailboxKind, "task">, string> = {
  reply: "내 글에 답하거나 인용했어요.",
  mention: "메시지에서 나를 불렀어요.",
  thread: "내가 참여한 스레드에 새 답글이 달렸어요.",
  dm: "DM으로 온 메시지예요.",
};

function previewLine(preview: string, deleted: boolean): string {
  if (deleted) return "삭제된 메시지예요.";
  const text = preview.trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : "내용 없는 메시지예요.";
}

/** 서버 와이어 종류(`reply_to_me`…)를 화면 종류로. */
export function mailboxKindOfWire(kind: InboxWireKind): MailboxKind {
  return SERVER_KIND[kind];
}

/**
 * 서버 투영 한 건. 안 읽음은 `readAt`이 비었는지로만 판정한다(손으로 seq를 비교하지
 * 않는다). 읽은 항목도 그대로 항목이다 — 목록에서 사라지지 않는다.
 */
export function serverEntry(
  item: ServerInboxItem,
  input: {
    channelLabel: string;
    actor: ActorNames;
    nowMs: number;
  }
): MailboxEntry {
  const kind = SERVER_KIND[item.kind];
  const quoted = item.quotedMessage;
  return {
    key: `inbox:${item.id.toLowerCase()}`,
    itemId: item.id,
    kind,
    reasons: item.reasons.map((reason) => SERVER_KIND[reason]),
    channelId: item.channel.id,
    channelLabel: input.channelLabel,
    typeLabel: `${SERVER_TYPE_LABEL[kind]} · ${input.channelLabel}`,
    actor: actorToken(input.actor),
    actorMemberId: item.actorMemberId,
    actorIsAgent: input.actor.isAgent,
    preview: previewLine(item.message.preview, item.message.deleted),
    atMs: item.createdAtMs,
    timeLabel: relativeLabel(item.createdAtMs, input.nowMs),
    unread: item.readAtMs === null,
    unreadCount: 0,
    seq: item.message.seq,
    messageId: item.message.id,
    ...(item.rootId === undefined ? {} : { rootId: item.rootId }),
    ...(quoted === undefined
      ? {}
      : {
          quotedPreview: previewLine(quoted.preview, quoted.deleted),
          quotedDeleted: quoted.deleted,
        }),
    reason: SERVER_REASON[kind],
  };
}

// ---- 오른쪽 패널 맥락 창 (#3694) ----------------------------------------

/** 항목 메시지 앞뒤로 보여 줄 개수. 긴 채널이어도 패널은 몇 개만 연다. */
export const CONTEXT_BEFORE = 4;
export const CONTEXT_AFTER = 2;

/**
 * 패널에 보일 메시지와 항목 메시지(`targetIndex`)를 정한다. `messages`는 seq 오름차순.
 *
 * `window: true`면 항목 메시지를 가운데 두고 앞 `CONTEXT_BEFORE`·뒤 `CONTEXT_AFTER`개만
 * 남긴다. 페이지에 항목 메시지가 없으면(삭제·범위 밖) 자르지 않고 `targetIndex`는 -1이다 —
 * 없는 위치를 아는 척 스크롤하지 않는다. `window: false`는 DM·스레드처럼 받은 대화를
 * 통째로 보일 때다(자르지 않고 위치만 알려 준다).
 */
export function contextWindow<T extends { id: string; seq: number }>(
  messages: readonly T[],
  target: { messageId?: string; seq?: number },
  options: { window: boolean }
): { rows: T[]; targetIndex: number } {
  const byId =
    target.messageId === undefined
      ? -1
      : messages.findIndex((m) => uuidEq(m.id, target.messageId as string));
  const index =
    byId >= 0
      ? byId
      : target.seq === undefined
        ? -1
        : messages.findIndex((m) => m.seq === target.seq);
  if (index < 0) return { rows: [...messages], targetIndex: -1 };
  if (!options.window) return { rows: [...messages], targetIndex: index };
  const from = Math.max(0, index - CONTEXT_BEFORE);
  const to = Math.min(messages.length, index + CONTEXT_AFTER + 1);
  return { rows: messages.slice(from, to), targetIndex: index - from };
}

// ---- 모으기·거르기·세기 ---------------------------------------------------

/**
 * 한 목록으로 모은다. DM 채널에서 온 멘션은 DM 항목이 이미 말하므로 접는다(같은
 * 사건이 두 줄로 보이면 안 읽음 수가 이중으로 센다). 같은 키는 한 번만.
 */
export function composeMailbox(input: {
  dms: readonly (MailboxEntry | null)[];
  mentions: readonly MailboxEntry[];
  threads: readonly (MailboxEntry | null)[];
  tasks: readonly (MailboxEntry | null)[];
  dmChannelIds: ReadonlySet<string>;
}): MailboxEntry[] {
  const seen = new Set<string>();
  const out: MailboxEntry[] = [];
  const push = (entry: MailboxEntry | null) => {
    if (entry === null || seen.has(entry.key)) return;
    seen.add(entry.key);
    out.push(entry);
  };
  input.tasks.forEach(push);
  input.dms.forEach(push);
  input.threads.forEach(push);
  for (const entry of input.mentions) {
    if (input.dmChannelIds.has(entry.channelId.toLowerCase())) continue;
    push(entry);
  }
  return orderMailbox(out);
}

/** 처리할 일이 먼저, 그다음 최신순. 같은 시각이면 키로 고정해 깜빡이지 않게 한다. */
export function orderMailbox(entries: readonly MailboxEntry[]): MailboxEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.kind === "task") !== (b.kind === "task")) {
      return a.kind === "task" ? -1 : 1;
    }
    if (b.atMs !== a.atMs) return b.atMs - a.atMs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function matchesMailboxFilter(
  entry: MailboxEntry,
  filter: MailboxFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return entry.unread;
  // 서버 항목은 사유가 여럿일 수 있다(멘션이면서 인용 답). 서버 필터와 같은 기준이다.
  return (entry.reasons ?? [entry.kind]).includes(filter);
}

export function filterMailbox(
  entries: readonly MailboxEntry[],
  filter: MailboxFilter
): MailboxEntry[] {
  return entries.filter((entry) => matchesMailboxFilter(entry, filter));
}

/**
 * 탭 배지: 그 필터 안의 「안 읽음」 수. 전체·종류 탭 모두 같은 규칙이다. 서버 경로에서는
 * 읽어 온 쪽만 센 수라 전체 수로 쓰지 않는다(서버의 `unreadCount`가 전체 수다).
 */
export function mailboxCounts(
  entries: readonly MailboxEntry[]
): Record<MailboxFilter, number> {
  const counts: Record<MailboxFilter, number> = {
    all: 0,
    unread: 0,
    mention: 0,
    reply: 0,
    dm: 0,
    thread: 0,
    task: 0,
  };
  for (const entry of entries) {
    if (!entry.unread) continue;
    counts.all += 1;
    counts.unread += 1;
    for (const kind of new Set(entry.reasons ?? [entry.kind])) {
      counts[kind] += 1;
    }
  }
  return counts;
}

/** 서버가 센 멘션 수로 이 항목들이 전부 담겼는지(캡 때문에 잘렸는지) 말한다. */
export function mentionsTruncated(
  entries: readonly MailboxEntry[],
  serverMentionCount: number
): boolean {
  const have = entries.filter((e) => e.kind === "mention").length;
  return serverMentionCount > have;
}

/** 항목을 읽음으로 보낼 때 커서를 옮길 seq. 앵커가 없으면 옮기지 않는다. */
export function readTargetSeq(entry: MailboxEntry): number | null {
  return entry.seq === undefined ? null : entry.seq;
}

/** 스크린리더가 한 줄로 읽는 문장: (안 읽음일 때만 「안 읽음」) 종류 · 보낸 이 · 시각 · 미리보기. */
export function entryAriaLabel(entry: MailboxEntry): string {
  const unread = entry.unread
    ? entry.unreadCount > 1
      ? `안 읽음 ${entry.unreadCount}개, `
      : "안 읽음, "
    : "";
  return `${unread}${entry.typeLabel}, ${entry.actor}, ${entry.timeLabel}, ${entry.preview}`;
}
