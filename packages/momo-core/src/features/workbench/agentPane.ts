import { uuidEq, type WorkSession } from "../../lib/api";
import {
  foldSessionEvents,
  type WorkEventRow,
  type WorkPlanItem,
  type WorkSessionEvent,
} from "../work/workSessionModel";
import type { SessionStatus } from "./sessionList";

// =============================================================================
// A 칸 진행 뷰 모델 (#2779, 작업 공간 #9, 제안서 §3.3 (4), ADR-0188 D3·D4·D5).
//
// 에이전트 작업 레인(A) 세션 하나를 격자 칸에 그릴 때의 규칙을 순수 함수로 둔다.
// 원천은 서버가 정화한 ACP 투영(`workSessionModel.ts` 머리말)뿐이다. raw 바이트,
// 명령 줄, 경로는 서버가 이미 거부한다. 여기서 더하는 것은 셋이다.
//
// 1. tool-call 카드의 종류(읽음·수정·실행·변경·검색·도구). 도구 이름은 내부 어휘라
//    화면에 쓰지 않고, 종류와 한국어 문구로만 옮긴다.
// 2. 권한 카드. 폰 경로 제약(ADR-0188 D5)을 데스크탑 칸에도 그대로 건다:
//    「이번 한 번」(`allow_once`)과 「거부하고 지시」(`reject_once`)만 보인다.
//    「항상 허용」·bypass·자동 모드 선택지는 받더라도 버린다. 버튼은 host 소유자
//    (= 세션 소유자)에게만 있다(D3). 결정은 사람이 버튼을 눌렀을 때만 만든다.
// 3. 표시 정화(D5): 보이지 않는 문자·방향 제어 무력화, 필드당 3,500자 앞뒤 남기고
//    자르기, 알아보는 자격 문자열 가리기. 잘린 미리보기로는 허락할 수 없다.
//
// 모르는 이벤트 종류나 잘못된 값은 던지지 않고 한 줄 폴백으로 센다.
// =============================================================================

// ---- 표시 정화 (ADR-0188 D5) ------------------------------------------------

/** 필드당 상한. 넘으면 앞뒤를 남기고 가운데를 자른다. */
export const SANITIZE_FIELD_MAX = 3_500;

/**
 * 보이지 않는 문자와 방향 제어. 지우지 않고 보이는 표지로 바꾼다: 지우면 「무엇이
 * 숨어 있었는가」라는 사실도 사라진다. C0·C1 제어 문자도 같다(줄바꿈·탭 제외).
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/**
 * 알아보는 자격 문자열. 모양을 알아볼 뿐인 보조 방어다(ADR-0188 §8 「인식되는
 * 자격 문자열을 가린다」는 보조 방어). 협조하는 모델이 쪼개면 막지 못한다.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export const CREDENTIAL_MASK = "[가림]";

export interface SanitizedText {
  text: string;
  /** 3,500자를 넘어 가운데를 잘랐다. */
  truncated: boolean;
  /** 자른 글자 수. */
  omitted: number;
  /** 가린 자격 문자열 수. */
  masked: number;
  /** 무력화한 보이지 않는 문자 수. */
  neutralized: number;
}

function codepointMark(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return `‹U+${cp.toString(16).toUpperCase().padStart(4, "0")}›`;
}

export function sanitizeDisplayText(
  input: unknown,
  max: number = SANITIZE_FIELD_MAX
): SanitizedText {
  const raw = typeof input === "string" ? input : "";
  let neutralized = 0;
  let masked = 0;
  let text = raw.replace(INVISIBLE, (ch) => {
    neutralized += 1;
    return codepointMark(ch);
  });
  for (const pattern of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, (_match, bearer?: string) => {
      masked += 1;
      return typeof bearer === "string" && /^bearer$/i.test(bearer)
        ? `${bearer} ${CREDENTIAL_MASK}`
        : CREDENTIAL_MASK;
    });
  }
  const chars = Array.from(text);
  if (chars.length <= max) {
    return { text, truncated: false, omitted: 0, masked, neutralized };
  }
  const keep = Math.floor(max / 2);
  const omitted = chars.length - keep * 2;
  return {
    text: `${chars.slice(0, keep).join("")}\n… ${omitted.toLocaleString("en-US")}자 생략 …\n${chars
      .slice(chars.length - keep)
      .join("")}`,
    truncated: true,
    omitted,
    masked,
    neutralized,
  };
}

// ---- tool-call 카드 종류 ----------------------------------------------------

export type ToolCardKind = "read" | "edit" | "execute" | "diff" | "search" | "fetch" | "other";

export const TOOL_CARD_KIND_LABEL: Readonly<Record<ToolCardKind, string>> = {
  read: "읽음",
  edit: "수정",
  execute: "실행",
  diff: "변경",
  search: "검색",
  fetch: "가져옴",
  other: "도구",
};

/**
 * 도구 이름을 카드 종류로. 순서가 규칙이다: `diff`가 `edit`보다, `edit`가
 * `read`보다 먼저다(`apply_diff`는 변경, `read_file`은 읽음). 바늘은
 * `workSessionModel.toolPhrase`와 같은 어휘다.
 */
const KIND_NEEDLES: ReadonlyArray<readonly [ToolCardKind, readonly string[]]> = [
  ["diff", ["diff"]],
  ["edit", ["edit", "write", "patch", "apply", "create_file", "delete", "remove", "move", "rename"]],
  ["execute", ["shell", "bash", "exec", "command", "terminal", "run_"]],
  ["search", ["search", "grep", "glob", "find"]],
  ["fetch", ["fetch", "http", "web", "url", "browse"]],
  ["read", ["read", "cat", "view_file", "open_file"]],
];

export function toolCardKind(toolName: unknown): ToolCardKind {
  if (typeof toolName !== "string" || toolName === "") return "other";
  const name = toolName.toLowerCase();
  for (const [kind, needles] of KIND_NEEDLES) {
    if (needles.some((needle) => name.includes(needle))) return kind;
  }
  return "other";
}

// ---- 권한 카드 --------------------------------------------------------------

/** 칸에 보일 수 있는 선택지 둘뿐(ADR-0188 D5 폰 경로 제약을 그대로). */
export type PermissionChoiceKind = "allow_once" | "reject_once";

export interface PermissionChoice {
  kind: PermissionChoiceKind;
  optionId: string;
}

export interface PendingPermission {
  /** 요청 이벤트 id(결정이 가리키는 것). */
  requestEventId: string;
  atMs: number;
  /** 요청이 멈춰 세운 도구의 종류와 문구. 없으면 null. */
  tool: { kind: ToolCardKind; headline: string } | null;
  /** 요청이 멈춰 세운 도구의 요약(정화 뒤). 없으면 null. */
  preview: SanitizedText | null;
  allow: PermissionChoice | null;
  reject: PermissionChoice | null;
  /** 받았지만 칸이 보이지 않는 선택지 수(항상 허용·모르는 종류 등). */
  hiddenOptions: number;
}

const OPTION_ID_MAX = 128;

function choiceFrom(raw: unknown): PermissionChoice | "hidden" | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const optionId = item.option_id;
  if (typeof optionId !== "string" || optionId === "" || optionId.length > OPTION_ID_MAX) {
    return null;
  }
  // `kind`가 정확히 둘 중 하나일 때만. 이름(`name`)으로 추측하지 않는다: 「Allow
  // once」라는 이름표를 단 `allow_always`를 이번 한 번으로 그리는 것이 곧 사고다.
  if (item.kind === "allow_once" || item.kind === "reject_once") {
    return { kind: item.kind, optionId };
  }
  return "hidden";
}

/**
 * 결정되지 않은 마지막 권한 요청. 결정(`approval.decided`)이 뒤에 오면 없다.
 * 세션이 끝났거나 호스트가 끊겼으면 요청도 죽은 것이다(D5: 재시작·종료·revoke 때
 * 대기 중인 승인은 취소된다).
 */
export function pendingPermission(
  events: readonly WorkSessionEvent[],
  session: Pick<WorkSession, "status">
): PendingPermission | null {
  if (session.status !== "running" && session.status !== "idle") return null;
  let pending: PendingPermission | null = null;
  let lastTool: { name: string; detail: string | undefined } | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (event.type === "agent.status") {
      const name = payload.tool_call_name;
      if (typeof name === "string" && name !== "") {
        lastTool = {
          name,
          detail: typeof payload.detail === "string" && payload.detail !== "" ? payload.detail : undefined,
        };
      }
      continue;
    }
    if (event.type === "approval.requested") {
      const options = Array.isArray(payload.options) ? payload.options : [];
      let allow: PermissionChoice | null = null;
      let reject: PermissionChoice | null = null;
      let hidden = 0;
      for (const raw of options) {
        const choice = choiceFrom(raw);
        if (choice === null || choice === "hidden") {
          hidden += 1;
          continue;
        }
        if (choice.kind === "allow_once" && allow === null) allow = choice;
        else if (choice.kind === "reject_once" && reject === null) reject = choice;
        else hidden += 1;
      }
      const kind = lastTool ? toolCardKind(lastTool.name) : null;
      pending = {
        requestEventId: event.eventId,
        atMs: event.atMs,
        tool: lastTool && kind ? { kind, headline: PERMISSION_ASK[kind] } : null,
        preview: lastTool?.detail !== undefined ? sanitizeDisplayText(lastTool.detail) : null,
        allow,
        reject,
        hiddenOptions: hidden,
      };
      continue;
    }
    if (event.type === "approval.decided") {
      pending = null;
    }
  }
  return pending;
}

/** 권한 카드의 한 줄 질문(도구 종류별). */
export const PERMISSION_ASK: Readonly<Record<ToolCardKind, string>> = {
  read: "파일을 읽어도 될까요?",
  edit: "파일을 고쳐도 될까요?",
  execute: "명령을 실행해도 될까요?",
  diff: "변경을 적용해도 될까요?",
  search: "검색해도 될까요?",
  fetch: "웹에서 가져와도 될까요?",
  other: "도구를 써도 될까요?",
};

/**
 * 허락 버튼을 누를 수 있는가. 미리보기가 잘렸으면 안 된다(D5 「잘린 미리보기는
 * 펼치기 전에는 허용할 수 없다」). 이 칸은 잘린 가운데를 받아 올 길이 없다(소유자
 * 전용 전체 미리보기 조회는 서버 권한 다리와 함께 온다). 그래서 「펼치기」로 풀 수
 * 없고, 거부하거나 전체를 볼 수 있는 곳에서 결정한다.
 */
export function canAllow(permission: PendingPermission): boolean {
  if (permission.allow === null) return false;
  if (permission.preview?.truncated) return false;
  return true;
}

// ---- 답장 방식 --------------------------------------------------------------

/** 답장 기본은 다음 차례 예약, 끼어들기는 명시 버튼(ADR-0188 D4). */
export type ReplyMode = "queue" | "interrupt";

export const DEFAULT_REPLY_MODE: ReplyMode = "queue";

// ---- 칸 모델 ----------------------------------------------------------------

export interface AgentToolCard {
  id: string;
  kind: ToolCardKind;
  kindLabel: string;
  state: WorkEventRow["state"];
  headline: string;
  atMs: number;
  /** 소유자만 펼쳐 보는 요약(정화 뒤). 없으면 펼칠 것이 없다. */
  detail: SanitizedText | null;
}

export type AgentFeedItem =
  | { type: "tool"; card: AgentToolCard }
  | {
      type: "line";
      id: string;
      kind: "note" | "message" | "approval" | "lifecycle";
      state: WorkEventRow["state"];
      atMs: number;
      text: SanitizedText;
    };

export interface AgentPaneModel {
  sessionId: string;
  /** 목표 한 줄(세션 이름표). */
  goal: string;
  harness: string;
  hostName: string | null;
  status: SessionStatus;
  statusLabel: string;
  plan: WorkPlanItem[];
  planDone: number;
  feed: AgentFeedItem[];
  permission: PendingPermission | null;
  /** 보는 사람이 host 소유자(= 세션 소유자)인가. 권한 버튼·원문·지시가 여기 달린다. */
  viewerIsOwner: boolean;
  /** 이 칸이 읽은 것보다 스레드가 길다(오래된 쪽만 들고 있다). */
  truncated: boolean;
  /** 모르는 종류이거나 값이 잘못되어 건너뛴 진행 수. */
  skipped: number;
}

export interface AgentPaneInput {
  session: WorkSession;
  events: readonly WorkSessionEvent[];
  truncated: boolean;
  /** 투영을 읽다 버린 `work_session_event` 수(모르는 종류·잘못된 봉투). */
  skipped?: number;
  viewerMemberId: string;
  hostName: string | null;
}

/**
 * 세션 상태를 목록·칸 머리의 상태 어휘로. 결정되지 않은 권한 요청은 소유자에게
 * 「나를 기다림」이다. 다른 사람에게는 그 요청이 보이지 않으므로(D5) 실행 중이다.
 */
export function agentSessionStatus(
  session: Pick<WorkSession, "status">,
  permissionPending: boolean,
  viewerIsOwner: boolean
): SessionStatus {
  if (session.status === "running" || session.status === "idle") {
    if (permissionPending && viewerIsOwner) return "waiting";
  }
  switch (session.status) {
    case "running":
      return "running";
    case "idle":
      return "review";
    case "ended":
      return "done";
    case "orphaned":
      return "stopped";
    default:
      return "idle";
  }
}

const AGENT_STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  waiting: "나를 기다림",
  running: "실행 중",
  review: "검토 대기",
  idle: "대기",
  done: "끝남",
  stopped: "호스트 연결 끊김",
};

const KNOWN_TYPES = new Set(["agent.status", "agent.partial", "approval.requested", "approval.decided"]);

/** 값이 잘못된 이벤트를 걸러 센다. 던지지 않는다. */
function wellFormed(event: WorkSessionEvent): boolean {
  if (!KNOWN_TYPES.has(event.type)) return false;
  if (typeof event.payload !== "object" || event.payload === null) return false;
  if (!Number.isFinite(event.atMs)) return false;
  const p = event.payload;
  if (event.type === "agent.status") {
    if (p.tool_call_name !== undefined && typeof p.tool_call_name !== "string") return false;
    if (p.detail !== undefined && typeof p.detail !== "string") return false;
    if (p.plan !== undefined && !Array.isArray(p.plan)) return false;
  }
  if (event.type === "agent.partial" && typeof p.text_delta !== "string") return false;
  if (event.type === "approval.requested" && !Array.isArray(p.options)) return false;
  return true;
}

export function agentPaneModel(input: AgentPaneInput): AgentPaneModel {
  const { session } = input;
  const own = input.events.filter((event) => uuidEq(event.sessionId, session.id));
  const valid = own.filter(wellFormed);
  const skipped = (input.skipped ?? 0) + (own.length - valid.length);
  const folded = foldSessionEvents(valid, session, input.truncated);
  const viewerIsOwner = uuidEq(session.memberId, input.viewerMemberId);
  const pending = pendingPermission(valid, session);
  // 소유자가 아니면 요청이 있다는 사실과 도구 종류만 남긴다. 미리보기와 선택지는
  // 소유자 전용이다(D5). 선택지가 없으니 버튼을 그릴 재료도 없다.
  const permission =
    pending && !viewerIsOwner
      ? { ...pending, preview: null, allow: null, reject: null, hiddenOptions: 0 }
      : pending;
  const status = agentSessionStatus(session, permission !== null, viewerIsOwner);

  const feed: AgentFeedItem[] = folded.rows.map((row) => {
    if (row.kind === "tool") {
      const kind = toolCardKind(row.toolName);
      return {
        type: "tool",
        card: {
          id: row.id,
          kind,
          kindLabel: TOOL_CARD_KIND_LABEL[kind],
          state: row.state,
          headline: row.headline,
          atMs: row.atMs,
          detail: row.detail ? sanitizeDisplayText(row.detail) : null,
        },
      };
    }
    return {
      type: "line",
      id: row.id,
      kind: row.kind,
      state: row.state,
      atMs: row.atMs,
      text: sanitizeDisplayText(row.headline),
    };
  });

  return {
    sessionId: session.id,
    goal: sanitizeDisplayText(session.label, 200).text || "이름 없는 작업",
    harness: sanitizeDisplayText(session.tool, 64).text,
    hostName: input.hostName ? sanitizeDisplayText(input.hostName, 64).text : null,
    status,
    statusLabel: AGENT_STATUS_LABEL[status],
    plan: folded.plan.map((item) => ({ ...item, content: sanitizeDisplayText(item.content, 500).text })),
    planDone: folded.plan.filter((item) => item.status === "completed").length,
    feed,
    permission,
    viewerIsOwner,
    truncated: input.truncated,
    skipped,
  };
}

/** 권한 카드가 소유자가 아닌 사람에게 보이는 문장. */
export function permissionWaitingLine(ownerName: string | null): string {
  return ownerName ? `${ownerName}의 확인을 기다려요` : "소유자의 확인을 기다려요";
}

// ---- 칸 ↔ 세션 묶기(이 기기) ------------------------------------------------

/**
 * 격자 칸 하나가 어느 A 세션을 그리는가. 이 기기 localStorage에 둔다(배치와 같은
 * 자리, ADR-0174 「외양=이 기기」). 서버에 올리지 않는다.
 */
export type AgentPaneBindings = Readonly<Record<string, string>>;

export const AGENT_PANE_BINDINGS_KEY = "momo.web.workbench.agentPanes.v1";

const PANE_ID = /^p[0-9]{1,4}$/;
const SESSION_ID = /^[0-9A-Fa-f-]{8,64}$/;

export function parseAgentPaneBindings(raw: string | null): AgentPaneBindings {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [pane, session] of Object.entries(value as Record<string, unknown>)) {
      if (PANE_ID.test(pane) && typeof session === "string" && SESSION_ID.test(session)) {
        out[pane] = session;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function bindAgentPane(
  bindings: AgentPaneBindings,
  paneId: string,
  sessionId: string
): AgentPaneBindings {
  return { ...bindings, [paneId]: sessionId };
}

export function unbindAgentPane(bindings: AgentPaneBindings, paneId: string): AgentPaneBindings {
  if (!(paneId in bindings)) return bindings;
  const next = { ...bindings };
  delete next[paneId];
  return next;
}

/** 지금 배치에 없는 칸의 묶음을 치운다. */
export function pruneAgentPanes(
  bindings: AgentPaneBindings,
  livePaneIds: readonly string[]
): AgentPaneBindings {
  const live = new Set(livePaneIds);
  let changed = false;
  const next: Record<string, string> = {};
  for (const [pane, session] of Object.entries(bindings)) {
    if (live.has(pane)) next[pane] = session;
    else changed = true;
  }
  return changed ? next : bindings;
}

/**
 * 칸에 열 수 있는 A 세션: 내가 소유한, 아직 끝나지 않은 세션. 이미 칸에 열린
 * 세션은 빼지 않는다(같은 세션을 두 칸에 여는 것은 거부하지 않고 표시만 한다).
 * 정렬은 목록과 같다: 나를 기다림은 권한 요청을 읽어야 알 수 있으므로 여기서는
 * 실행 중 → 대기 → 최근.
 */
export function openableAgentSessions(
  sessions: readonly WorkSession[],
  viewerMemberId: string
): WorkSession[] {
  const rank = (s: WorkSession) => (s.status === "running" ? 0 : s.status === "idle" ? 1 : 2);
  return sessions
    .filter(
      (s) =>
        uuidEq(s.memberId, viewerMemberId) &&
        (s.status === "running" || s.status === "idle" || s.status === "orphaned")
    )
    .sort((a, b) => rank(a) - rank(b) || b.startedAtMs - a.startedAtMs);
}

export type { WorkPlanItem, WorkEventRow };
