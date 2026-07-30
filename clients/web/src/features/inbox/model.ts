import type { Approval, AgentRun, Message } from "@/lib/api";
import { uuidEq } from "@/lib/api";
import type { FilterTabsSpec } from "@/features/common/FilterTabs";

// =============================================================================
// Inbox / activity model (R-1 §2), pure. Everything the two surfaces render is
// derived here from server projections, so the rows can be asserted without a
// DOM and neither surface can quietly invent a field the API never sent.
//
// Reading this as: inbox + agent activity feed for internal team users on
// web+Tauri, density 7/10, motion 2/10.
//
// Every row is one sentence in the shape "{who} {verb} {object} → {outcome}"
// (R-1 §공통계약). `outcome` stays null while nothing has been decided; absence
// is never promoted to failure (ADR-0132), so an expired approval reads 만료됨
// and a timed-out run reads 응답 없음, not 오류.
// =============================================================================

export type InboxFilter = "needs-action" | "mentions" | "agents";

export const INBOX_FILTERS: InboxFilter[] = [
  "needs-action",
  "mentions",
  "agents",
];

export function filterLabel(filter: InboxFilter): string {
  if (filter === "needs-action") return "결정 대기";
  if (filter === "mentions") return "멘션";
  return "에이전트";
}

/** Parse a `?filter=` value, falling back to the action-first default tab. */
export function parseFilter(raw: string | null): InboxFilter {
  return INBOX_FILTERS.includes(raw as InboxFilter)
    ? (raw as InboxFilter)
    : "needs-action";
}

/** Stable element ids so tab and panel can point at each other (ARIA tabs). */
export function tabId(filter: InboxFilter): string {
  return `inbox-tab-${filter}`;
}

export function panelId(filter: InboxFilter): string {
  return `inbox-panel-${filter}`;
}

/**
 * 이 표면의 필터 어휘 한 벌 (shared FilterTabs). 라벨과 id 규칙이 컨트롤 안이
 * 아니라 모델에 있는 이유는 두 번째 호출자가 생겼기 때문이다: 작업 흐름도 같은
 * 탭 컨트롤을 쓰고, 어휘만 다르다.
 *
 * `testId`가 `tabId`인 것은 우연이 아니라 기존 계약이다. 이 표면의 탭은 처음부터
 * 엘리먼트 id와 같은 문자열을 test id로 썼고, 게이트와 e2e가 그 문자열을 잡는다.
 */
export const INBOX_FILTER_TABS: FilterTabsSpec<InboxFilter> = {
  label: "인박스 필터",
  values: INBOX_FILTERS,
  labelFor: filterLabel,
  tabId,
  panelId,
  testId: tabId,
};

export type FeedTone = "warn" | "accent" | "agent" | "muted";
export type OutcomeTone = "ok" | "danger" | "warn" | "muted";

export interface FeedItem {
  key: string;
  kind: "approval" | "mention" | "run";
  tone: FeedTone;
  /**
   * Who acted, as a display token (`@handle` for agents, the name for people).
   * It is a separate field, not glued into the sentence, for two reasons: the
   * agent identity color (design-taste-web §9) applies to this token alone, and
   * a Korean subject particle that follows an arbitrary handle would have to be
   * guessed. Every `predicate` below therefore starts after the subject.
   */
  actor: string;
  actorIsAgent: boolean;
  /** "{verb} {object}", ending in a finished Korean sentence. */
  predicate: string;
  /** Quoted message body or a typed field line. Never raw JSON. */
  detail?: string;
  /** "→ {outcome}" label, or null while the ledger has decided nothing. */
  outcome: string | null;
  outcomeTone: OutcomeTone;
  /** Extra safety note rendered beside the outcome (irreversible actions). */
  note?: string;
  channelId: string;
  channelLabel: string;
  /** Timeline anchor. Only present when the projection carries a seq. */
  seq?: number;
  /** Resolved clock label; empty when the projection carries no timestamp. */
  timeLabel: string;
  /** Sort key. Pending rows sort ahead of settled ones regardless. */
  sortAtMs: number;
  pending: boolean;
  /** "왜 이게 여기 왔는지" (P10), rendered as the row tooltip. */
  reason: string;
  /** Agent rows: the human accountable for the agent (ADR-0131). */
  managedBy?: string;
}

// ---- time --------------------------------------------------------------

/** Elapsed label: 방금 / 12분 전 / 3시간 전 / 2일 전. */
export function relativeLabel(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

/** Deadline label for a pending approval: 3분 후 만료 / 기한 지남. */
export function deadlineLabel(expiresAtMs: number, nowMs: number): string {
  const minutes = Math.round((expiresAtMs - nowMs) / 60_000);
  if (minutes <= 0) return "기한 지남";
  if (minutes < 60) return `${minutes}분 후 만료`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 후 만료`;
  return `${Math.round(hours / 24)}일 후 만료`;
}

// ---- mentions ----------------------------------------------------------

/**
 * Member ids the SERVER decided were mentioned, stored on the message at insert
 * time (`ReadStateMentions`). The client never re-parses the body: handles and
 * display names change, the recorded decision does not.
 */
export function mentionMemberIds(message: Message): string[] {
  const raw = message.props?.["mention_member_ids"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

/** Ids cross the wire in mixed case (Swift upper, PG lower): compare loosely. */
export function mentionsMember(message: Message, memberId: string): boolean {
  return mentionMemberIds(message).some((id) => uuidEq(id, memberId));
}

export interface ActorNames {
  /** Display name, or a short id stub when the roster has not resolved it. */
  name: string;
  handle?: string;
  isAgent: boolean;
  /** Owner display name for an agent. */
  ownerName?: string;
}

/** Agents are addressed by handle, people by name (R-1 §3 row anatomy). */
export function actorToken(actor: ActorNames): string {
  return actor.isAgent && actor.handle ? `@${actor.handle}` : actor.name;
}

export function mentionItem(
  message: Message,
  actor: ActorNames,
  channelLabel: string,
  nowMs: number
): FeedItem {
  const body = (message.body ?? "").trim();
  return {
    key: `mention:${message.id}`,
    kind: "mention",
    tone: "accent",
    actor: actorToken(actor),
    actorIsAgent: actor.isAgent,
    predicate: "회원님을 불렀습니다",
    detail: body.length > 0 ? body : undefined,
    outcome: null,
    outcomeTone: "muted",
    channelId: message.channelId,
    channelLabel,
    seq: message.seq,
    timeLabel: relativeLabel(message.createdAtMs, nowMs),
    sortAtMs: message.createdAtMs,
    pending: false,
    reason: "메시지에 회원님이 포함되어 서버가 멘션으로 기록했습니다.",
    managedBy: actor.isAgent ? actor.ownerName : undefined,
  };
}

// ---- approvals ---------------------------------------------------------

const APPROVAL_OUTCOME: Record<
  Approval["status"],
  { label: string | null; tone: OutcomeTone }
> = {
  pending: { label: null, tone: "muted" },
  approved: { label: "승인됨", tone: "ok" },
  rejected: { label: "거절됨", tone: "danger" },
  // Absence is not failure: an unanswered request ran out of time (ADR-0132).
  expired: { label: "만료됨", tone: "warn" },
  cancelled: { label: "취소됨", tone: "muted" },
};

export function approvalItem(
  approval: Approval,
  actor: ActorNames,
  channelLabel: string,
  nowMs: number
): FeedItem {
  const outcome = APPROVAL_OUTCOME[approval.status];
  const pending = approval.status === "pending";
  // The projection carries no created_at, so a pending row shows its deadline
  // (the number that actually matters) and a settled row shows when it was
  // decided. Nothing is guessed from the client clock.
  const timeLabel = pending
    ? approval.expiresAtMs === undefined
      ? ""
      : deadlineLabel(approval.expiresAtMs, nowMs)
    : approval.decidedAtMs === undefined
      ? ""
      : relativeLabel(approval.decidedAtMs, nowMs);
  return {
    key: `approval:${approval.id}`,
    kind: "approval",
    tone: pending ? "warn" : "muted",
    actor: actorToken(actor),
    actorIsAgent: actor.isAgent,
    predicate: `${actionTypeLabel(approval.actionType)} 허가를 요청했습니다`,
    detail: approval.decisionReason ?? undefined,
    outcome: outcome.label,
    outcomeTone: outcome.tone,
    note: approval.isReversible === false ? "되돌릴 수 없음" : undefined,
    channelId: approval.channelId,
    channelLabel,
    timeLabel,
    sortAtMs: approval.decidedAtMs ?? approval.expiresAtMs ?? 0,
    pending,
    reason: pending
      ? "에이전트가 실행 전에 사람의 허가를 요청했고, 회원님이 이 채널의 멤버입니다."
      : "승인 원장에 기록된 결정입니다.",
    managedBy: actor.ownerName,
  };
}

// ---- agent runs --------------------------------------------------------

const RUN_OUTCOME: Record<
  AgentRun["status"],
  { label: string | null; tone: OutcomeTone }
> = {
  queued: { label: null, tone: "muted" },
  running: { label: null, tone: "muted" },
  awaiting_approval: { label: "승인 대기", tone: "warn" },
  paused: { label: "멈춤", tone: "warn" },
  succeeded: { label: "완료", tone: "ok" },
  failed: { label: "실패", tone: "danger" },
  cancelled: { label: "취소됨", tone: "muted" },
  // Silence is stalled, never an error story we did not observe.
  timed_out: { label: "응답 없음", tone: "warn" },
};

const RUN_LIVE: AgentRun["status"][] = [
  "queued",
  "running",
  "awaiting_approval",
  "paused",
];

export function isLiveRun(run: AgentRun): boolean {
  return RUN_LIVE.includes(run.status);
}

/** Work title, as the server validated it. Absent input renders no object. */
export function runTitle(run: AgentRun): string | undefined {
  const title = run.input?.["title"];
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : undefined;
}

export function runItem(
  run: AgentRun,
  actor: ActorNames,
  channelLabel: string,
  nowMs: number
): FeedItem {
  const outcome = RUN_OUTCOME[run.status];
  const live = isLiveRun(run);
  const title = runTitle(run);
  const atMs = run.finishedAtMs ?? run.startedAtMs ?? run.createdAtMs;
  return {
    key: `run:${run.id}`,
    kind: "run",
    tone: "agent",
    actor: actorToken(actor),
    actorIsAgent: actor.isAgent,
    // The title is quoted BEFORE 작업 so the particle stays fixed (작업을).
    predicate: title ? `"${title}" 작업을 실행했습니다` : "작업을 실행했습니다",
    detail: `${run.stepCount}/${run.maxSteps} 단계`,
    outcome: outcome.label,
    outcomeTone: outcome.tone,
    channelId: run.channelId,
    channelLabel,
    timeLabel: relativeLabel(atMs, nowMs),
    sortAtMs: atMs,
    pending: live,
    reason: "에이전트 작업 실행 기록입니다.",
    managedBy: actor.ownerName,
  };
}

// ---- ordering ----------------------------------------------------------

/**
 * Live rows first (they are the ones still asking for something), then settled
 * rows newest first. Ties break on the key so the order is total and a rerender
 * cannot shuffle two rows that share a timestamp.
 */
export function orderFeed(items: FeedItem[]): FeedItem[] {
  return items.slice().sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    if (a.pending && b.pending) {
      // Soonest deadline first: 0 means "no deadline recorded", so it goes last.
      const left = a.sortAtMs === 0 ? Number.MAX_SAFE_INTEGER : a.sortAtMs;
      const right = b.sortAtMs === 0 ? Number.MAX_SAFE_INTEGER : b.sortAtMs;
      if (left !== right) return left - right;
      return a.key < b.key ? -1 : 1;
    }
    if (a.sortAtMs !== b.sortAtMs) return b.sortAtMs - a.sortAtMs;
    return a.key < b.key ? -1 : 1;
  });
}

/** 3R M4: 와이어 액션 타입을 사용자 문장 어휘로. 미지의 타입은 원문 유지(정직 폴백). */
export function actionTypeLabel(actionType: string): string {
  const known: Record<string, string> = {
    "work.spawn": "작업 실행",
    "work.exec": "명령 실행",
    "workspace.file_write_and_reindex": "파일 쓰기와 재색인",
    "message.send": "메시지 전송",
  };
  return known[actionType] ?? actionType;
}
