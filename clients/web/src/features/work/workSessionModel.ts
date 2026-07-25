import { uuidEq, type Message, type WorkHost, type WorkSession } from "@/lib/api";
import type { WorkSessionACPFrame, WorkSessionACPType } from "@/lib/realtime";

// =============================================================================
// Work session model (AX-3 / MOMO-618): every rule the 작업 세션 panel renders,
// as pure functions the tests can pin.
//
// The web sees ONLY the server projection of an ACP session, never the raw ACP
// stream the mac work console reads. That projection is deliberately narrow
// (WorkSessionRoutes.validatedACPEvent): the allowed keys are
//   agent.status       phase, run_status, detail, tool_call_name, has_plan,
//                      plan, terminal_event, exit_code
//   agent.partial      text_delta
//   approval.requested action, action_type, status, options
//   approval.decided   action, status, option_id
// and anything whose key CONTAINS command/output/cwd/path/raw/env/_meta is
// rejected outright. So `MomoACPSessionCard`'s `_meta.acp.toolCallId` grammar
// has no web equivalent: there are no per-call ids here, and a tool call is
// identified by its position in the stream. Every rule below is built from what
// the projection actually carries, measured on momowebqa 2026-07-26.
//
// The event bodies the SERVER writes for these rows are English strings
// ("Approval requested", "ACP session update"), so nothing here renders
// `message.body` for a typed row: the copy is derived from the typed props.
// `agent.partial` is the exception and the only agent-AUTHORED text.
// =============================================================================

/** The four states a projected step can be in (reference survey §3-A). */
export type WorkRowState = "running" | "pending" | "done" | "error";

export type WorkRowKind = "tool" | "note" | "message" | "approval" | "lifecycle";

export interface WorkSessionEvent {
  /** `event_id`, mixed case across REST and realtime; fold before comparing. */
  eventId: string;
  type: WorkSessionACPType;
  sessionId: string;
  /** Server clock (`event_ts` / frame `ts`). */
  atMs: number;
  /** Channel seq, the ordering authority when both sources are merged. */
  seq?: number;
  payload: Record<string, unknown>;
}

export interface WorkPlanItem {
  content: string;
  status: "completed" | "in_progress" | "pending";
}

export interface WorkEventRow {
  id: string;
  kind: WorkRowKind;
  state: WorkRowState;
  atMs: number;
  /** One line, past tense once it is over, present tense while it runs. */
  headline: string;
  /** The host-authored detail line, when there is one. */
  detail?: string;
  /** Raw tool name. Internal vocabulary: disclosure only, never a headline. */
  toolName?: string;
}

export interface FoldedSession {
  rows: WorkEventRow[];
  /** The most recent plan the agent published, or an empty list. */
  plan: WorkPlanItem[];
  /** Server clock of the newest event, or null when none has arrived. */
  lastEventAtMs: number | null;
}

// ---- session status ---------------------------------------------------------

export type WorkSessionStatusKey = "running" | "orphaned" | "done" | "failed";

export interface WorkSessionStatus {
  key: WorkSessionStatusKey;
  label: string;
}

/**
 * Four session states out of three server ones. `ended` splits on the exit
 * code, which is the only place the ledger says a session finished badly; an
 * `ended` row with no code at all is a clean end, not a silent failure.
 *
 * `orphaned` keeps the mac wording (호스트 연결 끊김) rather than being folded
 * into 오류: the session is not known to have failed, its host went away, and
 * those are different facts to the person deciding whether to resume.
 */
export function workSessionStatus(session: WorkSession): WorkSessionStatus {
  if (session.status === "running") return { key: "running", label: "실행 중" };
  if (session.status === "orphaned") {
    return { key: "orphaned", label: "호스트 연결 끊김" };
  }
  if (typeof session.exitCode === "number" && session.exitCode !== 0) {
    return { key: "failed", label: "오류로 종료" };
  }
  return { key: "done", label: "종료됨" };
}

export const ROW_STATE_LABEL: Readonly<Record<WorkRowState, string>> = {
  running: "진행 중",
  pending: "대기",
  done: "완료",
  error: "실패",
};

/** Newest first, running sessions ahead of finished ones. */
export function sortSessions(sessions: readonly WorkSession[]): WorkSession[] {
  const rank = (s: WorkSession) => (s.status === "running" ? 0 : s.status === "orphaned" ? 1 : 2);
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || b.startedAtMs - a.startedAtMs
  );
}

// ---- tool vocabulary --------------------------------------------------------

type Tense = "present" | "past" | "failed";

interface ToolPhrase {
  present: string;
  past: string;
  failed: string;
}

/**
 * Past tense by default, present progressive while it is running, and a third
 * branch when it failed (reference survey §3-A: Editing → Edited → Edit failed).
 * The match is on substrings because the tool name is whatever the host's
 * harness calls it (`read_file`, `Read`, `fs.read`), and the projection gives
 * no other classifier.
 */
const TOOL_PHRASES: ReadonlyArray<readonly [readonly string[], ToolPhrase]> = [
  [
    ["edit", "write", "patch", "apply", "create_file"],
    { present: "파일 고치는 중", past: "파일 고침", failed: "파일 고치기 실패" },
  ],
  [
    ["delete", "remove", "rm"],
    { present: "파일 지우는 중", past: "파일 지움", failed: "파일 지우기 실패" },
  ],
  [
    ["move", "rename"],
    { present: "파일 옮기는 중", past: "파일 옮김", failed: "파일 옮기기 실패" },
  ],
  [
    ["read", "cat", "view_file", "open_file"],
    { present: "파일 읽는 중", past: "파일 읽음", failed: "파일 읽기 실패" },
  ],
  [
    ["shell", "bash", "exec", "command", "terminal", "run_"],
    { present: "명령 실행 중", past: "명령 실행함", failed: "명령 실행 실패" },
  ],
  [
    ["search", "grep", "glob", "find"],
    { present: "검색하는 중", past: "검색함", failed: "검색 실패" },
  ],
  [
    ["fetch", "http", "web", "url", "browse"],
    { present: "웹에서 가져오는 중", past: "웹에서 가져옴", failed: "가져오기 실패" },
  ],
  [
    ["todo", "plan", "task"],
    { present: "할 일 갱신 중", past: "할 일 갱신함", failed: "할 일 갱신 실패" },
  ],
  [
    ["image", "screenshot", "vision"],
    { present: "이미지 보는 중", past: "이미지 봄", failed: "이미지 열기 실패" },
  ],
  [
    ["think", "reason"],
    { present: "생각하는 중", past: "생각함", failed: "생각 중단됨" },
  ],
];

const DEFAULT_TOOL_PHRASE: ToolPhrase = {
  present: "도구 실행 중",
  past: "도구 실행함",
  failed: "도구 실행 실패",
};

export function toolPhrase(toolName: string | undefined, state: WorkRowState): string {
  const tense: Tense =
    state === "done" ? "past" : state === "error" ? "failed" : "present";
  const name = (toolName ?? "").toLowerCase();
  for (const [needles, phrase] of TOOL_PHRASES) {
    if (needles.some((needle) => name.includes(needle))) return phrase[tense];
  }
  return DEFAULT_TOOL_PHRASE[tense];
}

// ---- event parsing ----------------------------------------------------------

const ACP_TYPES: ReadonlySet<string> = new Set([
  "agent.status",
  "agent.partial",
  "approval.requested",
  "approval.decided",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * One projected ACP event out of a thread reply. Returns null for anything
 * else in the thread, which includes the human replies a shared excerpt
 * creates: those belong to the channel thread, not to the event stream.
 */
export function parseWorkSessionEvent(message: Message): WorkSessionEvent | null {
  const props = message.props;
  if (!props || props.kind !== "work_session_event") return null;
  if (props.schema !== "momo.work_session.acp_event.v1") return null;
  const type = asString(props.event_type);
  const eventId = asString(props.event_id);
  const payload = asRecord(props.event);
  if (!type || !ACP_TYPES.has(type) || !eventId || !payload) return null;
  const sessionId = asString(payload.work_session_id);
  if (!sessionId) return null;
  const atMs =
    typeof props.event_ts === "number" ? props.event_ts : message.hlcTs;
  return {
    eventId,
    type: type as WorkSessionACPType,
    sessionId,
    atMs,
    seq: message.seq,
    payload,
  };
}

/** The same record out of a live publication. */
export function eventFromFrame(frame: WorkSessionACPFrame): WorkSessionEvent {
  return {
    eventId: frame.payload.event_id,
    type: frame.type,
    sessionId: frame.payload.work_session_id,
    atMs: frame.ts,
    seq: frame.seq,
    payload: frame.payload,
  };
}

function orderKey(event: WorkSessionEvent): number {
  return event.seq ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Merge the REST page with whatever arrived live, deduped by event id (folded,
 * because REST hands back an UPPERCASE uuid and the frame a mixed-case one) and
 * ordered by `seq`. The REST row wins a tie: it is the durable one and it is
 * the one that carries a seq for certain.
 */
export function mergeEvents(
  durable: readonly WorkSessionEvent[],
  live: readonly WorkSessionEvent[]
): WorkSessionEvent[] {
  const byId = new Map<string, WorkSessionEvent>();
  for (const event of live) byId.set(event.eventId.toLowerCase(), event);
  for (const event of durable) byId.set(event.eventId.toLowerCase(), event);
  return [...byId.values()].sort(
    (a, b) => orderKey(a) - orderKey(b) || a.atMs - b.atMs
  );
}

/** Events belonging to one session (ids cross the wire in mixed case). */
export function eventsForSession(
  events: readonly WorkSessionEvent[],
  sessionId: string
): WorkSessionEvent[] {
  return events.filter((event) => uuidEq(event.sessionId, sessionId));
}

// ---- folding ----------------------------------------------------------------

function planFrom(value: unknown): WorkPlanItem[] {
  if (!Array.isArray(value)) return [];
  const out: WorkPlanItem[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    if (!item) continue;
    const content = asString(item.content) ?? asString(item.title);
    if (!content) continue;
    const status = asString(item.status);
    out.push({
      content,
      status:
        status === "completed" || status === "in_progress" ? status : "pending",
    });
  }
  return out;
}

/**
 * Fold the event stream into rendered rows.
 *
 * The state rules are the ones the projection can actually prove:
 *   - only a session the SERVER still calls `running` may own a `running` row,
 *     and only its newest tool row;
 *   - an approval that has not been decided is `pending`, and so is the tool
 *     row it interrupted, because that call has not happened yet;
 *   - a rejected approval is `error`, and so is the tool row it stopped;
 *   - everything else is `done`.
 *
 * A non-zero session exit code is deliberately NOT painted onto the last tool
 * row: the ledger says the session failed, not which step did, and inventing
 * the attribution is the false story the four states exist to avoid.
 */
export function foldSessionEvents(
  events: readonly WorkSessionEvent[],
  session: Pick<WorkSession, "status">
): FoldedSession {
  const rows: WorkEventRow[] = [];
  let plan: WorkPlanItem[] = [];
  let lastEventAtMs: number | null = null;
  /** Index of the tool row an approval would be interrupting. */
  let openToolIndex: number | null = null;
  /** Index of the approval row still waiting for a decision. */
  let pendingApprovalIndex: number | null = null;

  for (const event of events) {
    lastEventAtMs =
      lastEventAtMs === null ? event.atMs : Math.max(lastEventAtMs, event.atMs);
    const payload = event.payload;

    if (event.type === "agent.status") {
      const terminal = asString(payload.terminal_event);
      const detail = asString(payload.detail);
      const nextPlan = planFrom(payload.plan);
      if (nextPlan.length > 0) plan = nextPlan;

      if (terminal === "created" || terminal === "ended") {
        rows.push({
          id: event.eventId,
          kind: "lifecycle",
          state: "done",
          atMs: event.atMs,
          headline: terminal === "created" ? "세션을 시작함" : "세션을 끝냄",
          ...(detail ? { detail } : {}),
        });
        continue;
      }
      const toolName = asString(payload.tool_call_name);
      if (toolName) {
        rows.push({
          id: event.eventId,
          kind: "tool",
          state: "done",
          atMs: event.atMs,
          headline: toolPhrase(toolName, "done"),
          toolName,
          ...(detail ? { detail } : {}),
        });
        openToolIndex = rows.length - 1;
        continue;
      }
      rows.push({
        id: event.eventId,
        kind: "note",
        state: "done",
        atMs: event.atMs,
        headline: detail ?? "진행 상황을 알림",
      });
      continue;
    }

    if (event.type === "agent.partial") {
      const text = asString(payload.text_delta);
      if (!text) continue;
      rows.push({
        id: event.eventId,
        kind: "message",
        state: "done",
        atMs: event.atMs,
        headline: text,
      });
      continue;
    }

    if (event.type === "approval.requested") {
      rows.push({
        id: event.eventId,
        kind: "approval",
        state: "pending",
        atMs: event.atMs,
        headline: "승인을 요청함",
      });
      pendingApprovalIndex = rows.length - 1;
      if (openToolIndex !== null) {
        // The interrupted call has not happened yet, so it goes back to the
        // present tense as well as to the 대기 chip: "명령 실행함" beside a 대기
        // chip claims the very thing the approval is holding up.
        const tool = rows[openToolIndex];
        rows[openToolIndex] = {
          ...tool,
          state: "pending",
          headline: toolPhrase(tool.toolName, "pending"),
        };
      }
      continue;
    }

    // approval.decided
    const decided = asString(payload.status);
    const approved = decided === "approved";
    if (pendingApprovalIndex !== null) {
      rows[pendingApprovalIndex] = {
        ...rows[pendingApprovalIndex],
        state: approved ? "done" : "error",
        headline: approved ? "승인받음" : "승인 거부됨",
        atMs: event.atMs,
      };
      pendingApprovalIndex = null;
    } else {
      rows.push({
        id: event.eventId,
        kind: "approval",
        state: approved ? "done" : "error",
        atMs: event.atMs,
        headline: approved ? "승인받음" : "승인 거부됨",
      });
    }
    if (openToolIndex !== null) {
      const tool = rows[openToolIndex];
      const state: WorkRowState = approved ? "done" : "error";
      rows[openToolIndex] = {
        ...tool,
        state,
        headline: toolPhrase(tool.toolName, state),
      };
      if (!approved) openToolIndex = null;
    }
  }

  // The newest tool row is present tense only while the SERVER still calls the
  // session running and nothing is parked on a decision.
  if (
    session.status === "running" &&
    pendingApprovalIndex === null &&
    openToolIndex !== null &&
    rows[openToolIndex].state === "done"
  ) {
    const tool = rows[openToolIndex];
    rows[openToolIndex] = {
      ...tool,
      state: "running",
      headline: toolPhrase(tool.toolName, "running"),
    };
  }

  return { rows, plan, lastEventAtMs };
}

// ---- liveness ---------------------------------------------------------------

/**
 * Claude Code's survival signal, ported: past ten seconds without a new frame a
 * running session's clock changes color rather than going quiet, so a long step
 * reads as "still alive" instead of "hung". It is never applied to a session
 * the server no longer calls running, where the elapsed clock is history.
 */
export const SLOW_STEP_MS = 10_000;

/**
 * `lastSignalAtMs` is the last moment this client KNOWS something arrived, and
 * null means it does not know. A surface that has not read the session's thread
 * (the list rows, which only hold what the rail delivered) passes null and gets
 * no tone change: silence you never listened for is not silence.
 */
export function isSlowStep(
  session: Pick<WorkSession, "status">,
  lastSignalAtMs: number | null,
  nowMs: number
): boolean {
  if (session.status !== "running") return false;
  if (lastSignalAtMs === null) return false;
  return nowMs - lastSignalAtMs > SLOW_STEP_MS;
}

// ---- host trust (X-11 fail-closed) -----------------------------------------

export type WorkHostTrust = "local" | "remote" | "unknown";

/**
 * Which relay is behind a session, and therefore how much of its silence we are
 * allowed to interpret. `app` hosts are the local ACP path that is landed and
 * measured. Anything else is a remote workd/cloud host whose normalised ACP
 * relay is still in flight (X-11 / MOMO-546), and a host the registry does not
 * name at all is not evidence of anything. Both non-local answers are drawn
 * fail-closed: the panel states that the stream is unverified rather than
 * rendering an empty event list as a quiet session.
 */
export function workHostTrust(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): WorkHostTrust {
  if (!hosts) return "unknown";
  const host = hosts.find((candidate) => uuidEq(candidate.id, session.hostId));
  if (!host) return "unknown";
  return host.type === "app" ? "local" : "remote";
}

export function workHostName(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): string | null {
  const host = hosts?.find((candidate) => uuidEq(candidate.id, session.hostId));
  return host?.displayName ?? null;
}

// ---- peek + excerpt ---------------------------------------------------------

/** The last few rows, newest last: what a peek shows without leaving the list. */
export function peekRows(rows: readonly WorkEventRow[], count = 3): WorkEventRow[] {
  return rows.slice(Math.max(0, rows.length - count));
}

/** The single line a list row carries under the session label. */
export function lastLine(rows: readonly WorkEventRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === "lifecycle") continue;
    return row.detail && row.kind === "tool"
      ? `${row.headline} ${row.detail}`
      : row.headline;
  }
  return null;
}

/** Excerpt line count offered by default; the mac console offers 80 lines. */
export const EXCERPT_LINE_LIMIT = 80;

/**
 * The text a share starts from: the session label, then the rendered lines the
 * panel is showing. It is EDITABLE before it is sent, because the person
 * sharing is the last check on what lands in the channel ledger, exactly as the
 * mac excerpt sheet works.
 */
export function composeExcerpt(
  session: Pick<WorkSession, "label">,
  rows: readonly WorkEventRow[],
  limit = EXCERPT_LINE_LIMIT
): string {
  const lines = rows
    .slice(Math.max(0, rows.length - limit))
    .map((row) =>
      row.detail && row.kind === "tool"
        ? `${row.headline}: ${row.detail}`
        : row.headline
    );
  return [`세션 발췌: ${session.label}`, "", ...lines].join("\n");
}

// ---- panel scope ------------------------------------------------------------

export type WorkScope = "channel" | "all";

/**
 * The scope label is shown at all times, never only when it is unusual. The
 * reference implementation says why in its own source: an all-channels pane can
 * look "wrong" without it, because it is indistinguishable from a channel pane
 * that is showing the wrong channel.
 */
export function scopeSessions(
  sessions: readonly WorkSession[],
  scope: WorkScope,
  channelId: string | null
): WorkSession[] {
  if (scope === "all" || channelId === null) return [...sessions];
  return sessions.filter((session) => uuidEq(session.channelId, channelId));
}

/**
 * Channels worth holding a live subscription for: the open one first, then the
 * channels of running sessions. Capped, because one subscription per channel is
 * a real cost and a workspace may have hundreds; what the cap leaves out is
 * reported rather than hidden (the same grammar the sidebar uses for the agent
 * turn pill).
 */
export const MAX_WORK_CHANNEL_SUBSCRIPTIONS = 8;

export function workChannelsToWatch(
  sessions: readonly WorkSession[],
  openChannelId: string | null,
  cap = MAX_WORK_CHANNEL_SUBSCRIPTIONS
): { watched: string[]; uncovered: string[] } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (id: string) => {
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(id);
  };
  if (openChannelId !== null) push(openChannelId);
  for (const session of sessions) {
    if (session.status === "running") push(session.channelId);
  }
  return { watched: ordered.slice(0, cap), uncovered: ordered.slice(cap) };
}
