import { uuidEq, type Message, type WorkHost, type WorkSession } from "../../lib/api";
import type { WorkSessionACPFrame, WorkSessionACPType } from "../../lib/realtimeEvents";

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
  /**
   * The host-authored summary line, rendered as written.
   *
   * This is a deliberate contract, not an oversight. SKILL §9 keeps tool
   * arguments and paths opaque, and the enforcement point for that is the
   * SERVER: `validatedACPEvent` rejects any payload key containing
   * command/output/cwd/path/raw/env/_meta outright, so `detail` is the one
   * summary field a host is allowed to author. The client has no second
   * classifier that could tell an allowed summary from a leaked argument, and
   * inventing one here would either drop legitimate summaries or give a false
   * assurance about strings the server already vetted. So the panel renders
   * what the projection hands it and the redaction stays where it can be
   * enforced. A host that writes a path into `detail` is a host bug, and the
   * fix belongs in the projection, not in a regex on this side.
   */
  detail?: string;
  /**
   * Raw tool name (`read_file`, `fs.read`). Internal vocabulary, so it never
   * reaches a rendered string or a tooltip: it exists only to classify the row
   * into Korean copy via `toolPhrase`.
   */
  toolName?: string;
}

export interface FoldedSession {
  rows: WorkEventRow[];
  /** The most recent plan the agent published, or an empty list. */
  plan: WorkPlanItem[];
  /** Server clock of the newest event, or null when none has arrived. */
  lastEventAtMs: number | null;
}

// ---- timeline completion notice -------------------------------------------

export interface WorkSessionIdleNotice {
  sessionId: string;
  ownerMemberId: string;
  eventLabel: "대기 전환";
}

/**
 * The durable channel reply written with a running -> idle transition.
 * Everything else remains an ordinary system message. IDs are returned as
 * written because Swift sends uppercase UUIDs and the consumer compares them
 * case-insensitively through `uuidEq`.
 */
export function workSessionIdleNotice(
  message: Message
): WorkSessionIdleNotice | null {
  const props = message.props;
  if (
    message.type !== "system" ||
    typeof message.rootId !== "string" ||
    !props ||
    props.kind !== "work_session_idle" ||
    typeof props.session_id !== "string" ||
    props.session_id === "" ||
    typeof props.owner_member_id !== "string" ||
    props.owner_member_id === ""
  ) {
    return null;
  }
  return {
    sessionId: props.session_id,
    ownerMemberId: props.owner_member_id,
    eventLabel: "대기 전환",
  };
}

// ---- session status ---------------------------------------------------------

export type WorkSessionStatusKey =
  | "running"
  | "idle"
  | "unavailable"
  | "orphaned"
  | "done"
  | "unknown";

export interface WorkSessionStatus {
  key: WorkSessionStatusKey;
  label: string;
}

/**
 * `exitCode` is ADR-0139's last tool result, not a session-ending result. It
 * therefore never decides whether an `ended` session failed.
 *
 * `orphaned` keeps the mac wording (호스트 연결 끊김) rather than being folded
 * into 오류: the session is not known to have failed, its host went away, and
 * those are different facts to the person deciding whether to resume.
 */
export function workSessionStatus(
  session: Pick<WorkSession, "exitCode"> & { status: string }
): WorkSessionStatus {
  if (session.status === "running") return { key: "running", label: "실행 중" };
  if (session.status === "idle") {
    return { key: "idle", label: "완료 · 대기 중" };
  }
  if (session.status === "orphaned") {
    return { key: "orphaned", label: "호스트 연결 끊김" };
  }
  if (session.status === "ended") {
    return { key: "done", label: "종료됨" };
  }
  return { key: "unknown", label: "상태 확인 필요" };
}

export const ROW_STATE_LABEL: Readonly<Record<WorkRowState, string>> = {
  running: "진행 중",
  pending: "대기",
  done: "완료",
  error: "실패",
};

/** Newest first, running sessions ahead of finished ones. */
export function sortSessions(sessions: readonly WorkSession[]): WorkSession[] {
  const rank = (s: WorkSession) =>
    s.status === "running"
      ? 0
      : s.status === "idle"
        ? 1
        : s.status === "orphaned"
          ? 2
          : 3;
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
    { present: "검색 중", past: "검색함", failed: "검색 실패" },
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
 * A non-zero `exitCode` is deliberately NOT painted onto the last tool row:
 * ADR-0139 defines it as the last tool result, not a session failure and not
 * proof that this projected step produced it.
 *
 * `truncated` says the thread was longer than the panel read, so the newest
 * rows are the ones MISSING. Every "this is what is happening now" promotion
 * below is then switched off: the last row we hold is the last row we FETCHED,
 * and calling a step that ended a thousand events ago 진행 중 is the same
 * invented attribution, one page further back.
 */
export function foldSessionEvents(
  events: readonly WorkSessionEvent[],
  session: Pick<WorkSession, "status">,
  truncated = false
): FoldedSession {
  const rows: WorkEventRow[] = [];
  let plan: WorkPlanItem[] = [];
  let lastEventAtMs: number | null = null;
  /** Index of the tool row an approval would be interrupting. */
  let openToolIndex: number | null = null;
  /** Index of the approval row still waiting for a decision. */
  let pendingApprovalIndex: number | null = null;
  /** Index of the streamed message row the next delta appends to. */
  let openMessageIndex: number | null = null;

  for (const event of events) {
    lastEventAtMs =
      lastEventAtMs === null ? event.atMs : Math.max(lastEventAtMs, event.atMs);
    const payload = event.payload;
    // Anything that is not another slice of the same answer closes the run of
    // deltas: the next `agent.partial` starts a new message.
    if (event.type !== "agent.partial") openMessageIndex = null;

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
      // An `agent.status` with no terminal event, no tool call and no detail
      // carries nothing a row could say: a plan-only frame is already fully
      // rendered by the 계획 block above it, and "진행 상황을 알림" beside a
      // clock is a line of zero information competing with the real steps.
      if (!detail) continue;
      rows.push({
        id: event.eventId,
        kind: "note",
        state: "done",
        atMs: event.atMs,
        headline: detail,
      });
      continue;
    }

    if (event.type === "agent.partial") {
      const text = asString(payload.text_delta);
      if (!text) continue;
      // The projection carries ONE slice per event (`text_delta`, <= 4096B,
      // and there is no cumulative `text` field), and a host emits one per
      // transcript chunk, up to 200 for a single answer. Rendering a row per
      // slice chops the answer mid-word into a column of fragments and, worse,
      // writes those fragments into the channel ledger when the excerpt is
      // shared. Consecutive deltas are therefore ONE message row: the clock is
      // the first delta's, the text is the whole answer so far.
      if (openMessageIndex !== null) {
        const open = rows[openMessageIndex];
        rows[openMessageIndex] = { ...open, headline: open.headline + text };
        continue;
      }
      rows.push({
        id: event.eventId,
        kind: "message",
        state: "done",
        atMs: event.atMs,
        headline: text,
      });
      openMessageIndex = rows.length - 1;
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

  // EXACTLY ONE row may be present tense, and only while the SERVER still calls
  // the session running and the tail we hold is the real tail (`truncated`).
  //
  // An open run of deltas wins it: the agent is writing its answer right now,
  // and the tool call it wrote after is over by definition. `openToolIndex` is
  // left standing all the same, because it is also what an approval parks on.
  const live = !truncated && session.status === "running";
  if (live && openMessageIndex !== null) {
    rows[openMessageIndex] = { ...rows[openMessageIndex], state: "running" };
  } else if (
    live &&
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
 *
 * The host's `online` flag is not part of this judgement, and `workHostOnline`
 * below records the measurement behind that split.
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

/**
 * Whether the registry has heard from this session's host lately, or null when
 * it has no answer (hosts not loaded, or a host id the registry does not know).
 *
 * `online` is deliberately NOT folded into `workHostTrust`, and the reason is
 * measured rather than assumed. Exactly one server path writes it: the signed
 * heartbeat (`WorkHostRoutes`, `UPDATE work_host SET last_seen_at`, a 90 second
 * window). The ACP relay that carries every event this panel renders is a
 * different endpoint and never touches that column. On momowebqa 2026-07-26 all
 * 8 registered hosts answer `online: false` with `lastSeenAtMs: null`,
 * including the host that had just relayed 15 `agent.partial` events into the
 * session on screen. Gating relay trust on it would therefore paint a visibly
 * streaming session as unverified, which is the opposite of fail-closed.
 *
 * What a heartbeat CAN honestly carry is a claim about the future: an empty
 * step list under "에이전트가 첫 단계를 보고하면 여기에 한 줄씩 쌓입니다"
 * promises steps that a host nobody has heard from may never send. That is the
 * one place this answer is used, and only while the ledger still calls the
 * session running, because for a finished session the host's heartbeat now says
 * nothing about the events it already delivered.
 */
export function workHostOnline(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): boolean | null {
  const host = hosts?.find((candidate) => uuidEq(candidate.id, session.hostId));
  return host ? host.online : null;
}

// `canReattachWorkSession` LIVED HERE and is gone on purpose (ADR-0154 D3 /
// #1137). It answered "may this session be reattached?" with
//
//     (running | idle) && workHostOnline(...) === true
//
// and both halves were wrong against the server that decides the same thing
// (`momo-t3::reattach::SessionReattachState::verdict`, measured 2026-08-07):
//
//   - it GATED on `online`, which the server deliberately excludes and which
//     the note above `workHostOnline` already measured as untrustworthy — so a
//     session you could return to was routinely offered no way back;
//   - it never looked at `remoteAttachAvailable` or the host's revocation,
//     which are the two inputs the server actually uses.
//
// The rule now lives in ONE place, `features/work/sessionHandoff.ts`
// (`sessionVerdict` / `sessionHandoffVerb`), which replicates the server's
// branch exactly and keeps the heartbeat where the server puts it: advisory.
// Nothing is re-exported under the old name — a wrapper would let a caller keep
// asking the question in the vocabulary that caused the drift, and this file's
// whole argument (see `workSessionResumeTargets`) is that eligibility is asked
// in one place.

/**
 * Explicit targets for an orphaned lineage resume. This mirrors the accepted
 * server boundary and the mac console: the dead source host is excluded, and
 * another member's private host is never offered.
 *
 * The parameter is structural rather than `Pick<WorkSession, …>` because the
 * workstream run projection (ADR-0143) describes the same Run with a widened
 * `status`, and eligibility has to be asked in ONE place: a second copy of this
 * rule beside the goal layer is how two surfaces start offering different hosts
 * for the same act.
 */
export function workSessionResumeTargets(
  session: { hostId: string; status: string },
  hosts: readonly WorkHost[],
  viewerMemberId: string
): WorkHost[] {
  if (session.status !== "orphaned") return [];
  return hosts
    .filter(
      (host) =>
        host.revokedAtMs === undefined &&
        host.online &&
        !uuidEq(host.id, session.hostId) &&
        (host.scope === "workspace" ||
          uuidEq(host.ownerMemberId, viewerMemberId))
    )
    .sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName, "ko");
      return byName === 0
        ? a.id.toLowerCase().localeCompare(b.id.toLowerCase())
        : byName;
    });
}

/**
 * Status shown on a continuity row. The ledger remains authoritative:
 * heartbeat loss changes only the presentation of `running`, never the
 * session's stored state.
 */
export function workSessionContinuityStatus(
  session: WorkSession,
  hosts: readonly WorkHost[] | undefined
): WorkSessionStatus {
  if (
    (session.status === "running" || session.status === "idle") &&
    workHostOnline(session, hosts) === false
  ) {
    return { key: "unavailable", label: "호스트 응답 없음" };
  }
  return workSessionStatus(session);
}

/**
 * The copy under "아직 진행 내역이 없습니다" for a session whose thread came
 * back empty. A running session on a host the registry has not heard from gets
 * the fact instead of the promise (see `workHostOnline`).
 */
export function emptyStepsDetail(
  session: Pick<WorkSession, "hostId" | "status">,
  hosts: readonly WorkHost[] | undefined
): string {
  if (
    (session.status === "running" || session.status === "idle") &&
    workHostOnline(session, hosts) === false
  ) {
    return "이 호스트에서 최근 신호를 받은 기록이 없습니다. 새 단계가 도착하지 않을 수 있습니다.";
  }
  if (session.status === "idle") {
    return "마지막 실행은 끝났고 호스트가 같은 터미널을 열어 두고 있습니다.";
  }
  return "에이전트가 첫 단계를 보고하면 여기에 한 줄씩 쌓입니다.";
}

// ---- peek + excerpt ---------------------------------------------------------

/** The last few rows, newest last: what a peek shows without leaving the list. */
export function peekRows(rows: readonly WorkEventRow[], count = 3): WorkEventRow[] {
  return rows.slice(Math.max(0, rows.length - count));
}

/**
 * The single line a list row carries under the session label. A message row now
 * holds a whole streamed answer, newlines included, and a row is one line: the
 * text is flattened here rather than being handed to a `truncate` span that
 * would silently decide the same thing at render time.
 */
export function lastLine(rows: readonly WorkEventRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === "lifecycle") continue;
    const text =
      row.detail && row.kind === "tool"
        ? `${row.headline} ${row.detail}`
        : row.headline;
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat === "") continue;
    return flat;
  }
  return null;
}

/** Excerpt row count offered by default; the mac console offers 80 lines. */
export const EXCERPT_LINE_LIMIT = 80;

/**
 * The text a share starts from: the session label, then the rendered rows the
 * panel is showing. It is EDITABLE before it is sent, because the person
 * sharing is the last check on what lands in the channel ledger, exactly as the
 * mac excerpt sheet works.
 *
 * What it takes is one entry per ROW, which is why the delta accumulation in
 * `foldSessionEvents` is a data rule and not a display one: before it, a shared
 * excerpt wrote the agent's answer into the channel ledger sliced at whatever
 * byte the transport happened to cut, permanently.
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

export type WorkScope = "channel" | "all" | "mine";

/**
 * The scope label is shown at all times, never only when it is unusual. The
 * reference implementation says why in its own source: an all-channels pane can
 * look "wrong" without it, because it is indistinguishable from a channel pane
 * that is showing the wrong channel.
 */
export function scopeSessions(
  sessions: readonly WorkSession[],
  scope: WorkScope,
  channelId: string | null,
  viewerMemberId?: string
): WorkSession[] {
  if (scope === "mine") {
    return sessions.filter(
      (session) =>
        session.status !== "ended" &&
        uuidEq(session.memberId, viewerMemberId)
    );
  }
  if (scope === "all" || channelId === null) return [...sessions];
  return sessions.filter((session) => uuidEq(session.channelId, channelId));
}

/**
 * Channels worth holding a live subscription for: the open one first, then the
 * channels of running or idle sessions. Capped, because one subscription per channel is
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
    if (session.status === "running" || session.status === "idle") {
      push(session.channelId);
    }
  }
  return { watched: ordered.slice(0, cap), uncovered: ordered.slice(cap) };
}
