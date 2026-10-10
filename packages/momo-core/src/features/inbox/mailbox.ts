import type { Message, ReadState } from "../../lib/api";
import { threadRollup, uuidEq } from "../../lib/api";
import { effectiveUnreadStartSeq } from "../readState/model";
import type { FilterTabsSpec } from "../common/filterTabs";
import {
  actorToken,
  relativeLabel,
  type ActorNames,
  type FeedItem,
} from "./model";

// =============================================================================
// 인박스 = 나와 관련된 것의 목록 (#3663). 메일함·알림함처럼 한 줄 한 줄이
// 「누가, 어디서, 무슨 일로 나를 찾았는가」를 말하고, 오른쪽 패널이 그 맥락을 연다.
//
// 이 파일은 순수 판정이다. 서버에 「인박스」 라우트는 없다 — 항목의 원천은 이미 있는
// 네 가지 읽기 계약이고, 여기서는 그 결과를 한 모양(MailboxEntry)으로 모으기만 한다.
//
//   DM       DM 채널의 최근 메시지 페이지 + 채널 read-state(읽음/안 읽음 둘 다 보인다)
//   멘션     read-state.mention_count 뒤의 메시지 중 서버가 기록한 멘션(안 읽은 것만)
//   스레드   내가 쓴 글의 `thread` 롤업(last_reply_seq)이 읽음 기준 뒤에 있는 것
//   처리할 일 대기 중 승인(`GET …/approvals?status=pending`)
//
// ## 읽음 기준은 하나다 (ADR-0178 D3)
//
// 서버의 읽음은 채널당 커서 하나다. 항목마다 읽음을 따로 갖지 않는다. 그래서 「안
// 읽음」은 언제나 `effectiveUnreadStartSeq(readState)` 이후인가로만 판정하고(손으로
// `seq > lastReadSeq`를 쓰지 않는다), 한 항목을 읽음으로 표시하면 같은 채널의 그
// 앞 메시지도 함께 읽음이 된다. 화면 문구가 그 사실을 말한다.
//
// ## 없는 것을 지어내지 않는다
//
// 읽은 멘션·내가 답만 한 스레드·내게 배정된 작업은 서버가 기억하는 사실이 아니다.
// 클라이언트가 채널을 훑어 역사를 만들지 않는다(P7). 그 부분은 서버 인박스 투영
// 후속 이슈의 몫이다 — 이 모델은 있는 사실만 담고 비어 있으면 비어 있다고 말한다.
// =============================================================================

export type MailboxKind = "dm" | "mention" | "thread" | "task";

export type MailboxFilter =
  | "all"
  | "unread"
  | "mention"
  | "dm"
  | "thread"
  | "task";

export const MAILBOX_FILTERS: readonly MailboxFilter[] = [
  "all",
  "unread",
  "mention",
  "dm",
  "thread",
  "task",
];

const FILTER_LABEL: Record<MailboxFilter, string> = {
  all: "전체",
  unread: "안 읽음",
  mention: "멘션",
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
  if (message.state === "deleted") return "삭제된 메시지입니다.";
  const body = (message.body ?? "").trim().replace(/\s+/g, " ");
  if (body.length > 0) return body;
  if ((message.attachments?.length ?? 0) > 0) return "첨부 파일을 보냈습니다.";
  return "내용 없는 메시지입니다.";
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
      ? "회원님이 보낸 마지막 말이 있는 DM 대화입니다."
      : "DM으로 회원님에게 온 메시지입니다.",
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
    reason: "메시지에 회원님이 포함되어 서버가 멘션으로 기록했습니다.",
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
    reason: "회원님이 쓴 글에 새 답글이 달렸습니다.",
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
    task: item,
    reason: item.reason,
  };
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
  return entry.kind === filter;
}

export function filterMailbox(
  entries: readonly MailboxEntry[],
  filter: MailboxFilter
): MailboxEntry[] {
  return entries.filter((entry) => matchesMailboxFilter(entry, filter));
}

/** 탭 배지: 그 필터 안의 「안 읽음」 수. 전체·종류 탭 모두 같은 규칙이다. */
export function mailboxCounts(
  entries: readonly MailboxEntry[]
): Record<MailboxFilter, number> {
  const counts: Record<MailboxFilter, number> = {
    all: 0,
    unread: 0,
    mention: 0,
    dm: 0,
    thread: 0,
    task: 0,
  };
  for (const entry of entries) {
    if (!entry.unread) continue;
    counts.all += 1;
    counts.unread += 1;
    counts[entry.kind] += 1;
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

/** 스크린리더가 한 줄로 읽는 문장: 안 읽음 · 종류 · 보낸 이 · 시각 · 미리보기. */
export function entryAriaLabel(entry: MailboxEntry): string {
  const unread = entry.unread
    ? entry.unreadCount > 1
      ? `안 읽음 ${entry.unreadCount}개, `
      : "안 읽음, "
    : "";
  return `${unread}${entry.typeLabel}, ${entry.actor}, ${entry.timeLabel}, ${entry.preview}`;
}
