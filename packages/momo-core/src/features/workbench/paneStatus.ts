import { statusFromPhase, type SessionPhaseInput, type SessionStatus } from "./sessionList";

// =============================================================================
// 칸 상태 판정 (#2776, 제안서 §3.4, ADR-0190 D2·D4-b 출처 규칙).
//
// 입력은 둘뿐이다.
//   1. 칸 생명주기: 프로세스 단계와 종료 코드(`statusFromPhase`, #2856).
//   2. 하네스가 스스로 낸 구조 신호(`PaneSignal`): Claude Code hook, Codex
//      `notify`. 데스크탑 셸이 앱 전용 Unix 소켓으로 받아 닫힌 목록으로 줄인다
//      (`clients/desktop/src-tauri/src/pane_signal.rs`).
//
// **PTY 출력은 입력이 아니다.** 화면에 「permission」이나 「Allow?」가 찍혀도
// 상태는 바뀌지 않는다. 출력 내용을 읽으면 raw가 요약의 모양으로 새어 나간다
// (ADR-0190 D4-b 「긁지 않는다」). 소스 시험이 이 모듈의 import를 잠근다.
//
// OSC 제목은 여기서 판정에 쓰지 않는다: #2776 스파이크에서 Claude Code의 제목
// 머리 글자는 작업 중(◐·◑)과 그 밖(✳)만 가르고, 「허락을 기다림」과 「쉼」은 같은
// ✳였다. hook이 그보다 먼저, 더 정확히 말한다. 제목은 칸 이름으로만 쓴다
// (`LocalSessionView.title`). 셸 칸 안에서 사람이 띄운 하네스(hook 배선 없음)에
// 제목 머리 글자를 쓰는 것은 후속으로 남긴다(PR 본문 REMAINING).
// =============================================================================

/**
 * 하네스 구조 신호의 닫힌 목록. 셸 칸에는 오지 않는다(hook을 내는 프로그램이
 * 없다). 데스크탑이 이 밖의 값을 보내면 무시한다(`parsePaneSignal`).
 *
 * | 신호 | Claude Code 2.1.28x hook | Codex 0.156 `notify` |
 * |---|---|---|
 * | `ready` | SessionStart | 없음 |
 * | `working` | UserPromptSubmit, PostToolUse (+ 기다리는 칸에 사람이 입력) | 없음 |
 * | `waiting-permission` | PermissionRequest, Notification `permission_prompt` | 없음(승인 유형이 오지 않는다) |
 * | `waiting-input` | Notification `elicitation_dialog`(스파이크에서 관측 못 함) | 없음 |
 * | `turn-done` | Stop | `agent-turn-complete`(제목 짓기 곁가지 턴은 뺀다) |
 */
export type PaneSignal = "ready" | "working" | "waiting-permission" | "waiting-input" | "turn-done";

export const PANE_SIGNALS: readonly PaneSignal[] = [
  "ready",
  "working",
  "waiting-permission",
  "waiting-input",
  "turn-done",
];

/** 닫힌 목록 밖의 값은 null. 데스크탑과 웹 사이의 경계에서 한 번 더 거른다. */
export function parsePaneSignal(value: unknown): PaneSignal | null {
  return typeof value === "string" && (PANE_SIGNALS as readonly string[]).includes(value)
    ? (value as PaneSignal)
    : null;
}

export interface PaneStatusInput {
  phase: SessionPhaseInput | null;
  exitCode: number | null;
  exitSignal: string | number | null;
  /** 이 프로세스에서 받은 마지막 하네스 신호. 다시 시작하면 null로 돌아간다. */
  signal: PaneSignal | null;
}

/**
 * 칸 하나의 상태. 생명주기가 먼저다: 끝난 프로세스는 마지막 신호가 무엇이었든
 * 「끝남」이나 「멈춤」이다. 살아 있는 프로세스는 신호가 있으면 신호를 따르고,
 * 없으면 「실행 중」이다(셸 칸은 늘 이 경우다: 프롬프트에서 쉬는지 명령을
 * 돌리는지 알려 주는 구조 신호가 없다. 추측하지 않는다).
 */
export function derivePaneStatus(input: PaneStatusInput): SessionStatus {
  const life = statusFromPhase(input.phase, input.exitCode, input.exitSignal);
  if (input.phase !== "running" || input.signal === null) return life;
  switch (input.signal) {
    case "ready":
      return "idle";
    case "working":
      return "running";
    case "waiting-permission":
    case "waiting-input":
      return "waiting";
    case "turn-done":
      return "done";
  }
}

/** 칸 머리 바닥 띠의 한 줄(시안 ① `.pwait`). 「나를 기다림」일 때만 있다. */
export function waitingLine(signal: PaneSignal | null): string | null {
  if (signal === "waiting-permission") return "실행 허락을 기다려요";
  if (signal === "waiting-input") return "답을 기다려요";
  return null;
}

// ---- 알림 --------------------------------------------------------------------

/** 인박스·OS 알림으로 가는 상태(제안서 §3.4: 「나를 기다림」과 「끝남」만). */
export type AttentionStatus = Extract<SessionStatus, "waiting" | "done">;

export function isAttention(status: SessionStatus): status is AttentionStatus {
  return status === "waiting" || status === "done";
}

export interface PaneAttention {
  paneId: string;
  status: AttentionStatus;
}

/**
 * 이전 판정과 지금 판정을 비교해 **새로** 「나를 기다림」이나 「끝남」이 된 칸만
 * 돌려준다. 같은 상태가 다시 계산돼도(다시 그리기, 다른 칸의 변화) 알림은 한 번이다.
 * 이전 판정에 없던 칸(방금 연 칸)은 「실행 중」에서 온 것으로 본다.
 */
export function attentionTransitions(
  previous: ReadonlyMap<string, SessionStatus>,
  next: ReadonlyMap<string, SessionStatus>
): PaneAttention[] {
  const out: PaneAttention[] = [];
  for (const [paneId, status] of next) {
    if (!isAttention(status)) continue;
    if (previous.get(paneId) === status) continue;
    out.push({ paneId, status });
  }
  return out;
}

export interface AttentionNotifyContext {
  /** 앱 창이 앞에 있고 포커스를 가졌다. */
  windowFocused: boolean;
  /** 이 칸이 지금 화면에 보이고 격자의 활성 칸이다. */
  paneInView: boolean;
}

/**
 * OS 알림을 띄울까. 보고 있는 칸이 바뀐 것은 알리지 않는다: 사람이 이미 그
 * 화면을 보고 있다. 권한이 없으면 띄우는 쪽(`showNotification`)이 조용히 넘긴다.
 */
export function shouldNotifyAttention(ctx: AttentionNotifyContext): boolean {
  return !(ctx.windowFocused && ctx.paneInView);
}

export interface AttentionCopy {
  title: string;
  body: string;
}

/**
 * 알림 문구. 칸 번호와 칸 이름(OSC 제목이나 프로그램 이름)만 싣는다. 하네스가
 * hook에 실어 보낸 글(권한 요청 본문 등)은 소켓에서 이미 버렸다.
 */
export function attentionCopy(
  attention: AttentionStatus,
  pane: { index: number; name: string },
  signal: PaneSignal | null
): AttentionCopy {
  const where = `${pane.index}번 칸 · ${pane.name}`;
  if (attention === "waiting") {
    return { title: "나를 기다림", body: `${where}: ${waitingLine(signal) ?? "입력을 기다려요"}` };
  }
  return { title: "끝남", body: `${where}: 작업이 끝났어요` };
}

// ---- ⌃⇧J ---------------------------------------------------------------------

/**
 * 다음 「나를 기다림」 칸. 격자 순서(`ids`)로 지금 칸 다음부터 한 바퀴 돈다.
 * 지금 칸만 기다리면 그 칸이다. 없으면 null.
 */
export function nextWaitingPane(
  ids: readonly string[],
  statusOf: (paneId: string) => SessionStatus | undefined,
  focused: string | null
): string | null {
  const start = focused === null ? -1 : ids.indexOf(focused);
  for (let step = 1; step <= ids.length; step++) {
    const id = ids[(start + step + ids.length) % ids.length]!;
    if (statusOf(id) === "waiting") return id;
  }
  return null;
}
