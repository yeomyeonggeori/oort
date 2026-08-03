import type { Approval, AgentRun, Message } from "../../lib/api";
import { uuidEq } from "../../lib/api";
import type { FilterTabsSpec } from "../common/filterTabs";

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

/**
 * 이 서버에서 실제로 답이 오는 탭만 (goal B12).
 *
 * 세 탭 중 둘은 승인 원장 위에 서 있다: 결정 대기는 `GET …/approvals`가 전부이고,
 * 에이전트는 그 원장에 작업 실행 기록을 얹는다. 둘 다 이 서버에 없으므로 그
 * 탭들은 **언제나 빈 목록**이 된다. 빈 목록은 "결정할 것이 없다"로 읽히는데
 * 그것은 우리가 모르는 사실이다. 그래서 탭 자체를 세우지 않는다.
 *
 * 멘션은 남는다. 그 탭은 read-state 투영과 메시지 읽기 위에 서 있고 둘 다 이
 * 서버에 있다.
 *
 * 판정을 인자로 받는 이유: 이 클라이언트의 테스트는 DOM 없이 돌고, 어떤 탭이
 * 남는가는 계약이라 못으로 박을 수 있어야 한다.
 */
export function availableInboxFilters(
  provides: (surface: "approvals" | "agentRunHistory") => boolean
): InboxFilter[] {
  return INBOX_FILTERS.filter((filter) => {
    if (filter === "needs-action") return provides("approvals");
    if (filter === "agents") {
      return provides("approvals") || provides("agentRunHistory");
    }
    return true;
  });
}

/**
 * 「에이전트」 탭은 **두 원장 위에** 서 있고, 지금은 그 중 하나만 답한다
 * (goal W-AP1 2R H1 → M-AP1 3R N-B에서 core로 승격).
 *
 * 승인 원장과 작업 실행 기록 둘이다. 이 서버는 앞의 것만 답하고 뒤의 것은 읽는
 * 경로가 없다(경로가 POST 전용이라 GET은 405). 그런데 화면은 승인 기록만 담긴
 * 목록을 그려 놓고, 비어 있으면 "조용한 게 정상입니다"라고 말했다. 절반이 보이지
 * 않는다는 사실을 삼킨 문장이라 사용자는 에이전트가 아무 일도 하지 않았다고
 * 읽는다 — 우리가 모르는 사실이다.
 *
 * 그래서 반쪽인 동안에는 그 사실을 먼저 말한다. 목록은 그대로 남긴다: 있는
 * 절반을 감추는 것은 반대 방향의 같은 거짓말이다.
 *
 * **판정이 여기 사는 이유**는 두 클라이언트가 같은 답을 해야 하기 때문이다. 웹이
 * 먼저 자기 파일(`features/inbox/approvalsPanel.ts`)에서 닫았고, 모바일이 같은
 * 자리를 열면서 두 벌이 될 뻔했다. 두 벌이 되는 순간 한쪽만 고쳐지는 날이 온다 —
 * `availableInboxFilters`가 바로 위에서 같은 이유로 같은 모양을 하고 있다.
 */
export function agentsFeedPartial(
  provides: (surface: "agentRunHistory") => boolean
): boolean {
  return !provides("agentRunHistory");
}

/**
 * Parse a `?filter=` value, falling back to the first tab this server can serve.
 *
 * 기본값이 상수가 아니라 **남은 탭의 첫 번째**인 것이 goal B12의 수정이다. 예전
 * 기본값은 `needs-action`이었고, 그 탭이 죽은 서버에서 인박스는 열자마자 영영
 * 비어 있는 목록에 착지했다. 앱에서 가장 자주 열리는 표면이 가장 먼저 거짓말을
 * 하고 있었다는 뜻이다.
 */
export function parseFilter(
  raw: string | null,
  available: InboxFilter[] = INBOX_FILTERS
): InboxFilter {
  const fallback = available[0] ?? "mentions";
  if (!INBOX_FILTERS.includes(raw as InboxFilter)) return fallback;
  const parsed = raw as InboxFilter;
  return available.includes(parsed) ? parsed : fallback;
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
  /**
   * 이 행동을 되돌릴 수 있다고 **서버가 명시적으로 말했는가** (goal M-AP1 2R B1).
   *
   * 판정은 fail-closed다: `true`는 서버가 `isReversible: true`를 실었을 때만이고,
   * 필드가 없거나 `false`면 `false`다. 예전 규칙은 `!== false`였고, 그래서 이
   * 서버의 모든 승인이 "되돌릴 수 있음"으로 그려졌다 — 서버는 이 필드를 아예
   * 보내지 않는데(`dto.rs:2210-2212`: absent = unknown, never reversible), v0의
   * 유일한 툴 `work.session.end`는 **비가역인 것이 선정 사유**다
   * (`crates/momo-agent/src/tools.rs:33-38`: T3 정산이 봉인되고 호스트 상태가
   * 사라진다). 모르는 것을 안전한 쪽으로 읽는 규칙이 아니라 위험한 쪽으로 읽는
   * 규칙이었던 셈이고, 그 방향의 오답은 사람이 되돌릴 수 없는 것을 되돌릴 수
   * 있다고 믿고 누르는 것이다.
   */
  reversible?: boolean;
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
  /**
   * 대기 중인데 **기한이 이미 지난** 행 (goal M-AP1 2R M4).
   *
   * 이 상태에서 결정을 보내면 서버는 그것을 승인/거부가 아니라 **만료로 확정**한다
   * (`routes/approvals.rs:584` `settle_expired` — 409 + status `expired`). 그래서
   * 확정 문장이 "승인하면 …"이라고 말하면 그것은 일어나지 않을 일이다.
   */
  deadlinePassed?: boolean;
  /** "왜 이게 여기 왔는지" (P10), rendered as the row tooltip. */
  reason: string;
  /** Agent rows: the human accountable for the agent (ADR-0131). */
  managedBy?: string;
  /**
   * 승인 원장의 행 id. 결정할 수 있는 행에만 있다 (goal B5.3b D-5).
   *
   * `key`에서 잘라 쓰지 않고 따로 싣는 이유: `key`는 이 목록 안에서만 유일하면
   * 되는 렌더 키이고, 이것은 `POST …/approvals/{id}/decision`의 경로 조각이다.
   * 두 역할이 한 문자열에 묶여 있으면 키의 형태를 바꾸는 순간 결정이 다른 행으로
   * 날아간다. 대기 중인 승인 행에만 존재하므로, 그 밖의 행에는 결정 컨트롤이
   * 붙을 자리가 아예 없다.
   */
  approvalId?: string;
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
  // fail-closed: 서버가 명시적으로 가역이라고 말한 것만 가역이다 (2R B1).
  const reversible = approval.isReversible === true;
  const deadlinePassed =
    pending &&
    approval.expiresAtMs !== undefined &&
    approval.expiresAtMs <= nowMs;
  return {
    key: `approval:${approval.id}`,
    kind: "approval",
    ...(pending ? { approvalId: approval.id } : {}),
    tone: pending ? "warn" : "muted",
    actor: actorToken(actor),
    actorIsAgent: actor.isAgent,
    predicate: `${approvalActionLabel(
      approval.actionType,
      approval.toolName
    )} 허가를 요청했습니다`,
    detail: approval.decisionReason ?? undefined,
    outcome: outcome.label,
    outcomeTone: outcome.tone,
    note: reversible ? undefined : "되돌릴 수 없음",
    reversible,
    ...(deadlinePassed ? { deadlinePassed: true } : {}),
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

/**
 * `action_type` = `tool_call`인 승인의 갈래 이름. 사람에게 할 말이 아니다.
 *
 * 이 서버가 승인 원장에 쓰는 action_type은 **언제나 이것**이고
 * (`crates/momo-agent/src/tools.rs:82`), 무엇을 허가하는지는 payload의 툴 이름에만
 * 있다. 그래서 이 문자열이 화면에 닿으면 그것은 언제나 결함이다.
 */
const TOOL_CALL_ACTION = "tool_call";

/** 이 서버가 실행할 수 있는 툴의 사람 이름 (`tools.rs`의 CATALOG와 1:1). */
const TOOL_LABELS: Record<string, string> = {
  "work.session.end": "작업 세션 종료",
};

/**
 * 행 제목이 될 한 마디 (goal M-AP1 2R B2).
 *
 * 규칙은 셋이고 순서가 곧 정직성의 순서다:
 *
 *   1. 아는 툴이면 그 툴이 **하는 일**을 우리말로. (`work.session.end` →
 *      「작업 세션 종료」)
 *   2. 모르는 툴이면 **툴 이름 원문**. 지어낸 설명보다 낫다 — 사람은 최소한
 *      무엇을 검색해야 하는지 알게 된다.
 *   3. 툴 이름조차 없으면 갈래만 남으므로 갈래를 **우리말로** 말한다. 어떤
 *      경우에도 `tool_call`이라는 원장 내부 식별자는 화면에 내보내지 않는다.
 */
export function approvalActionLabel(
  actionType: string,
  toolName?: string
): string {
  if (actionType === TOOL_CALL_ACTION) {
    if (toolName === undefined) return "에이전트 도구 실행";
    return TOOL_LABELS[toolName] ?? toolName;
  }
  // 툴 이름이 실려 있으면 그것이 더 구체적인 진실이다.
  if (toolName !== undefined) return TOOL_LABELS[toolName] ?? toolName;
  return actionTypeLabel(actionType);
}
