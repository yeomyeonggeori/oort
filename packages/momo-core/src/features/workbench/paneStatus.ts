import { attachParticle } from "../../lib/koreanParticle";
import {
  SESSION_STATUS_LABEL,
  statusFromPhase,
  type SessionPhaseInput,
  type SessionStatus,
} from "./sessionList";

// =============================================================================
// 칸 상태 판정 (#2776, 제안서 §3.4, ADR-0190 D2·D4-b 출처 규칙).
//
// 입력은 둘뿐이다.
//   1. 칸 생명주기: 프로세스 단계와 종료 코드(`statusFromPhase`, #2856).
//   2. 하네스가 스스로 낸 구조 신호(`PaneSignal`). 두 길로 온다.
//      - hook: Claude Code hook, Codex `notify`. 데스크탑 셸이 앱 전용 Unix
//        소켓으로 받아 닫힌 목록으로 줄인다(`clients/desktop/src-tauri/src/pane_signal.rs`).
//      - 보고(#5579): 하네스가 자기 터미널에 쓴 OSC 7501 상태 보고(Program Status
//        Protocol 0.4). 데스크탑 셸의 `program_status.rs`가 하네스 칸에서만 읽어
//        `state`·`kind` 두 낱말로 줄인다. 두 길을 합치는 규칙은 `applyPaneSignalEvent`.
//
// **PTY 출력은 입력이 아니다.** 화면에 「permission」이나 「Allow?」가 찍혀도
// 상태는 바뀌지 않는다. 출력 내용을 읽으면 raw가 요약의 모양으로 새어 나간다
// (ADR-0190 D4-b 「긁지 않는다」). 예외는 OSC 7501 하나다: 프로그램이 자기 상태를
// 공개 규격의 구조로 말한 것이지 화면 글이 아니고, 그것도 데스크탑이 닫힌 낱말로
// 줄인 뒤에만 여기 온다. 웹은 출력에서 아무것도 읽지 않는다. 소스 시험이 이 모듈의
// import를 잠근다.
//
// OSC 제목은 여기서 판정에 쓰지 않는다: #2776 스파이크에서 Claude Code의 제목
// 머리 글자는 작업 중(◐·◑)과 그 밖(✳)만 가르고, 「허락을 기다림」과 「쉼」은 같은
// ✳였다. hook이 그보다 먼저, 더 정확히 말한다. 제목은 칸 이름으로만 쓴다
// (`LocalSessionView.title`). 셸 칸 안에서 사람이 띄운 하네스(hook 배선 없음)에
// 제목 머리 글자를 쓰는 것은 후속으로 남긴다(PR 본문 REMAINING).
// =============================================================================

/**
 * 하네스 구조 신호의 닫힌 목록. 셸 칸에는 오지 않는다(hook을 내는 프로그램이
 * 없고, OSC 7501은 하네스 칸에서만 읽는다). 데스크탑이 이 밖의 값을 보내면
 * 무시한다(`parsePaneSignal`).
 *
 * | 신호 | Claude Code 2.1.28x hook | Codex 0.156 `notify` | OSC 7501 보고(#5579) |
 * |---|---|---|---|
 * | `ready` | SessionStart | 없음 | `idle` |
 * | `working` | UserPromptSubmit, PostToolUse (+ 기다리는 칸에 사람이 입력) | 없음 | `working` |
 * | `waiting-permission` | PermissionRequest, Notification `permission_prompt` | 없음(승인 유형이 오지 않는다) | `blocked` + `kind=permission` |
 * | `waiting-input` | Notification `elicitation_dialog`(스파이크에서 관측 못 함) | 없음 | `blocked` + `question`·`auth`·없음 |
 * | `turn-done` | Stop | `agent-turn-complete`(제목 짓기 곁가지 턴은 뺀다) | `done` |
 * | `turn-failed` | 없음 | 없음 | `error` |
 *
 * `turn-failed`(보고의 `error`)는 실패한 턴이다(design-review #5584 H1). 수명·정렬·알림은
 * 「끝남」과 같고(규격이 `done`과 같은 수명을 주고, 프로그램은 살아서 다음 지시를 기다린다)
 * 상태 어휘도 `done` 그대로지만, 화면은 성공 모양(초록 체크·「작업이 끝났어요」)으로 그리지
 * 않는다: 표지는 「실패」(`derivePaneMark`). 「멈춤」은 칸의 프로세스가 멈춘 것이라 쓰지
 * 않는다. hook에는 이 신호가 없다(Claude `Stop`·Codex `agent-turn-complete`는 턴이 어떻게
 * 끝났든 온다). 보고의 `clear`는 신호가 아니라 거둠이다(`PaneSignalEvent.signal === null`).
 */
export type PaneSignal =
  | "ready"
  | "working"
  | "waiting-permission"
  | "waiting-input"
  | "turn-done"
  | "turn-failed";

export const PANE_SIGNALS: readonly PaneSignal[] = [
  "ready",
  "working",
  "waiting-permission",
  "waiting-input",
  "turn-done",
  "turn-failed",
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
    case "turn-failed":
      return "done";
  }
}

// ---- 표지: 실패한 턴 (design-review #5584 H1) ------------------------------------

/**
 * 칸 표지·칩·알림 제목이 그리는 열쇠. 상태 어휘(`SessionStatus`)는 닫힌 그대로 두고, 그 위에
 * `failed` 하나를 더한다: 프로그램이 턴이 실패했다고 보고한(OSC 7501 `error`) 살아 있는 칸이다.
 * 상태로는 `done`이라 정렬·묶기·알림 수명이 「끝남」과 같고, 모양과 글자만 실패를 말한다
 * (빨간 ✕ = 「멈춤」의 표지, 글자 「실패」 = 팀 보드의 실패 낱말).
 */
export type PaneMark = SessionStatus | "failed";

/** 표지 글자. 「실패」는 팀 보드가 실패한 일에 쓰는 낱말 그대로다(`teamBoard.stateChipLabel`). */
export const PANE_MARK_LABEL: Readonly<Record<PaneMark, string>> = {
  ...SESSION_STATUS_LABEL,
  failed: "실패",
};

/** 실패한 턴의 표지인가. */
export function isFailedMark(mark: PaneMark | undefined): boolean {
  return mark === "failed";
}

/** 세션 목록 줄(`SessionRow.failed`)의 표지. */
export function rowMark(row: { status: SessionStatus; failed?: boolean }): PaneMark {
  return row.failed ? "failed" : row.status;
}

/** 칸 하나의 표지. 생명주기가 이기는 것은 `derivePaneStatus`와 같다(끝난 프로세스는 실패가 아니다). */
export function derivePaneMark(input: PaneStatusInput): PaneMark {
  const status = derivePaneStatus(input);
  return status === "done" && input.phase === "running" && input.signal === "turn-failed" ? "failed" : status;
}

/**
 * 공유 요약(S1)에 싣는 상태. 서버의 파생 상태 목록(ADR-0190 D4-b, `work_share.rs`
 * `DERIVED_STATES`)에 실패가 아직 없어서, 실패한 턴은 `idle`(대기: 프로그램이 살아서 다음
 * 지시를 기다린다)로 싣는다. `done`으로 실으면 팀 보드가 초록 체크 「끝남」으로 그린다. 무슨
 * 일이 있었는지는 단계 표지(「턴 실패」)가 말한다. 목록에 `failed`를 더하는 것은 후속이다.
 */
export function sharedPaneState(input: PaneStatusInput): SessionStatus {
  return derivePaneMark(input) === "failed" ? "idle" : derivePaneStatus(input);
}

/**
 * 칸 상태가 그 프로그램의 말일 때 출처 한 줄(ADR-0220 「에이전트 보고」, ADR-0190 증보
 * 「출처를 표시한다」). hook이든 OSC 7501 보고든 그 프로그램이 스스로 한 말이다. 생명주기만으로
 * 정한 상태(신호 없음·프로세스 종료)에는 붙이지 않는다.
 */
export function paneStatusSource(input: PaneStatusInput, programName: string): string | null {
  if (input.phase !== "running" || input.signal === null) return null;
  return `${attachParticle(programName, "subject")} 알린 상태예요`;
}

/** 칸 머리 바닥 띠의 한 줄(시안 ① `.pwait`). 「응답 필요」일 때만 있다. */
export function waitingLine(signal: PaneSignal | null): string | null {
  if (signal === "waiting-permission") return "실행 허락을 기다려요";
  if (signal === "waiting-input") return "답을 기다려요";
  return null;
}

// ---- 두 길 합치기 (#5579) -------------------------------------------------------

/**
 * 신호가 온 길. `hook`: 하네스가 띄운 hook 프로세스가 앱 전용 소켓으로 보낸 줄.
 * `report`: 하네스가 자기 터미널에 쓴 OSC 7501 상태 보고. 둘 다 그 프로그램이 스스로
 * 한 말(ADR-0220 「에이전트 보고」)이다. 서버가 잰 사실과 섞지 않는다.
 */
export type PaneSignalFrom = "hook" | "report";

/**
 * 칸 신호 채널의 한 통(데스크탑 `pane_signal.rs` `PaneSignalEvent`와 같은 모양).
 * `signal`이 null이면 프로그램이 보고를 거뒀다(`state=clear`). report에서만 온다.
 */
export interface PaneSignalEvent {
  from: PaneSignalFrom;
  signal: PaneSignal | null;
}

/**
 * 채널 값을 사건으로 읽는다. `{ from, signal }` 모양만 받고, 맨 신호 문자열은 hook으로
 * 읽는다(#2776의 모양. 캡처 흉내와 그 시험이 아직 쓴다). 닫힌 목록 밖은 null.
 */
export function parsePaneSignalEvent(value: unknown): PaneSignalEvent | null {
  if (typeof value === "string") {
    const signal = parsePaneSignal(value);
    return signal === null ? null : { from: "hook", signal };
  }
  if (typeof value !== "object" || value === null) return null;
  const { from, signal } = value as { from?: unknown; signal?: unknown };
  if (from !== "hook" && from !== "report") return null;
  if (signal === null) return from === "report" ? { from, signal: null } : null;
  const parsed = parsePaneSignal(signal);
  return parsed === null ? null : { from, signal: parsed };
}

/** 칸 하나의 신호 상태. 프로세스를 다시 띄우면 `NO_PANE_SIGNAL`로 돌아간다. */
export interface PaneSignalState {
  /** 칸 상태를 정하는 신호. null = 없음(생명주기만 본다). */
  signal: PaneSignal | null;
  /** 이 프로세스가 OSC 7501 보고를 한 번이라도 보냈다. 그 뒤로는 보고만 따른다. */
  reports: boolean;
}

export const NO_PANE_SIGNAL: PaneSignalState = { signal: null, reports: false };

/**
 * 신호 하나를 칸 상태에 합친다. 우선순위는 이렇다.
 *
 * 1. **보고가 온 칸은 보고만 따른다.** 그 프로세스가 OSC 7501을 한 번 보내면, 그 뒤의
 *    hook은 버린다. 보고는 그 프로그램의 상태 전부라서 거부·중단도 `working`·`idle`로
 *    오지만, hook은 사건 몇 개뿐이고 늦게도 온다. Claude `Notification permission_prompt`는
 *    5~6초 뒤에 오므로, 그사이 사람이 허락했으면 「응답 필요」를 되살린다. Codex는 첫
 *    그림에서 `idle`을 보고하므로 그 칸의 `notify`(agent-turn-complete)는 곧 덧말이 된다.
 * 2. **같은 길 안에서는 마지막 것이 이긴다.** 보고의 거둠(`signal: null`)은 신호를 비운다.
 *
 * 두 길이 같은 기다림을 겹쳐 말해도 판정(`derivePaneStatus`)이 같으므로
 * `attentionTransitions`는 「응답 필요」·「끝남」을 한 번만 낸다.
 *
 * 수명(규격은 `working`·`blocked`·`idle`을 새 셸 프롬프트에서 지우지만 oort는 프롬프트를
 * 읽지 않는다): 새 보고나 거둠이 지금 것을 갈아 끼운다. 프로세스가 끝나면 생명주기가
 * 칸을 정한다(`derivePaneStatus`). `done`·`error`는 프로그램이 갈아 끼울 때까지 남는다:
 * Codex는 사람이 그 칸에 키·붙여넣기·클릭을 하면 스스로 `idle`을 보고한다. 칸을 보면
 * 인박스 줄은 내려간다(`paneAttention`).
 */
export function applyPaneSignalEvent(state: PaneSignalState, event: PaneSignalEvent): PaneSignalState {
  if (event.from === "report") return { signal: event.signal, reports: true };
  if (state.reports || event.signal === null) return state;
  return { signal: event.signal, reports: false };
}

/**
 * 사람이 칸에 입력했다. hook만 있는 칸의 「응답 필요」는 「실행 중」으로 푼다: Claude
 * Code는 거부·중단에 hook을 내지 않는다(#2776 스파이크 실측). 보고하는 칸은 그대로 둔다:
 * 답을 받은 프로그램이 스스로 보고한다(Codex는 허락 키에 `working`). 입력은 읽지 않는다.
 */
export function afterPersonInput(state: PaneSignalState): PaneSignalState {
  if (state.reports) return state;
  if (state.signal !== "waiting-permission" && state.signal !== "waiting-input") return state;
  return { signal: "working", reports: false };
}

// ---- 알림 --------------------------------------------------------------------

/** 인박스·OS 알림으로 가는 상태(제안서 §3.4: 「응답 필요」과 「끝남」만). */
export type AttentionStatus = Extract<SessionStatus, "waiting" | "done">;

export function isAttention(status: SessionStatus): status is AttentionStatus {
  return status === "waiting" || status === "done";
}

/** 알림이 되는 표지: 「응답 필요」·「끝남」, 그리고 「끝남」의 실패 모양 「실패」. */
export type AttentionMark = AttentionStatus | "failed";

export function isAttentionMark(mark: PaneMark): mark is AttentionMark {
  return mark === "failed" || isAttention(mark);
}

/** 표지가 속한 알림 상태. 실패한 턴은 「끝남」의 수명을 따른다. */
export function attentionStatusOf(mark: AttentionMark): AttentionStatus {
  return mark === "failed" ? "done" : mark;
}

export interface PaneAttention {
  paneId: string;
  /** 새로 된 표지. 「끝남」과 「실패」는 서로 다른 전이다(실패가 끝남의 알림에 묻히지 않는다). */
  status: AttentionMark;
}

/**
 * 이전 판정과 지금 판정을 비교해 **새로** 「응답 필요」·「끝남」·「실패」가 된 칸만
 * 돌려준다. 같은 표지가 다시 계산돼도(다시 그리기, 다른 칸의 변화) 알림은 한 번이다.
 * 이전 판정에 없던 칸(방금 연 칸)은 「실행 중」에서 온 것으로 본다. 상태(`SessionStatus`)만
 * 넘기는 호출도 그대로 쓴다(그때는 「실패」가 오지 않는다).
 */
export function attentionTransitions(
  previous: ReadonlyMap<string, PaneMark>,
  next: ReadonlyMap<string, PaneMark>
): PaneAttention[] {
  const out: PaneAttention[] = [];
  for (const [paneId, mark] of next) {
    if (!isAttentionMark(mark)) continue;
    if (previous.get(paneId) === mark) continue;
    out.push({ paneId, status: mark });
  }
  return out;
}

export interface AttentionNotifyContext {
  /** 앱 창이 앞에 있고 포커스를 가졌다. */
  windowFocused: boolean;
  /** 이 칸이 지금 화면에 보이고 격자의 활성 칸이다. */
  paneInView: boolean;
  /**
   * 이 멤버의 **알림 일시 중지**(서버 규칙)가 켜져 있다 (#4197). 메시지 배너와 같은 말이다
   * (`notifications/model.ts` 의 `NotifyContext.paused`): 서버가 마지막으로 답한 값 그대로이고,
   * 비어 있으면 일시 중지가 아니다. 칸은 서버에 올라가지 않지만(ADR-0190 D2) 설정 문구가 「알림 일시
   * 중지」를 이 워크스페이스의 **모든** 알림을 멈추는 것으로 약속하므로 로컬 칸 배너도 그 아래에 선다
   * (그 약속에 아직 못 미치는 배너 길목은 웹 `notifications/serverPause.ts` 머리에 적혀 있다).
   */
  paused?: boolean;
}

/**
 * OS 알림을 띄울까. 보고 있는 칸이 바뀐 것은 알리지 않는다: 사람이 이미 그
 * 화면을 보고 있다. 권한이 없으면 띄우는 쪽(`showNotification`)이 조용히 넘긴다.
 *
 * 알림 일시 중지가 켜져 있으면 어느 칸도 알리지 않는다. 이것은 **OS 배너만**의 판정이다 —
 * 인박스의 「이 기기의 칸」 줄과 배지는 이 함수를 거치지 않고, 일시 중지에도 그대로 쌓인다
 * (별개 원장, ADR-0124 D2).
 */
export function shouldNotifyAttention(ctx: AttentionNotifyContext): boolean {
  if (ctx.paused) return false;
  return !(ctx.windowFocused && ctx.paneInView);
}

export interface AttentionCopy {
  title: string;
  body: string;
}

/**
 * 인박스 줄과 OS 알림 본문의 한 문장. 「실패」는 무슨 일이 있었는지를 말한다(정본 §4 오류
 * 상태): 프로그램이 오류를 알리고 턴이 끝났다. 칸은 살아 있으니 「멈췄어요」가 아니다.
 */
export function attentionLine(mark: AttentionMark, signal: PaneSignal | null): string {
  if (mark === "waiting") return waitingLine(signal) ?? "입력을 기다려요";
  if (mark === "failed") return "오류로 끝났어요";
  return "작업이 끝났어요";
}

/** 사이드바 「작업」 줄의 점이 말하는 것(점은 글자가 없어 읽기 도구에 이 말을 준다). */
export const PANE_UNSEEN_LABEL = {
  done: "아직 안 본 끝난 세션이 있어요",
  failed: "오류로 끝난 세션이 있어요",
} as const;

/**
 * 알림 문구. 칸 번호와 칸 이름(OSC 제목이나 프로그램 이름)만 싣는다. 하네스가
 * hook에 실어 보낸 글(권한 요청 본문 등)은 소켓에서 이미 버렸다. 제목은 표지 글자다.
 */
export function attentionCopy(
  attention: AttentionMark,
  pane: { index: number; name: string },
  signal: PaneSignal | null
): AttentionCopy {
  const where = `${pane.index}번 칸 · ${pane.name}`;
  return { title: PANE_MARK_LABEL[attention], body: `${where}: ${attentionLine(attention, signal)}` };
}

// ---- ⌃⇧J ---------------------------------------------------------------------

/**
 * 다음 「응답 필요」 칸. 격자 순서(`ids`)로 지금 칸 다음부터 한 바퀴 돈다.
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
