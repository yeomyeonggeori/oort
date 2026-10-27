import type { AgentLiveness, AgentLivenessState } from "../../lib/api";
import { livenessView } from "./liveness";
import { runPhaseDetail, runPhaseLabel } from "./runPhase";
import type { ServerRunFacts } from "./workingSignal";

// =============================================================================
// runWaiting: 아무도 가져가지 않은 채 오래 머무는 「사람이 부른 일」을 정직하게 말한다
// (ADR-0200 증보 3 E6, #4285 — 서버 짝은 #4284 `woken_not_collected`).
//
// 2026-10-23·24 성재의 폰 캡처 둘: 홈 카드의 「대기 1번째 · 5시간째 기다려요」, DM 아래의
// 「grok: 대기 1번째 17시간째 기다려요」. 둘 다 서버가 말한 사실(대기 1번째, 5시간)이었지만
// 사람은 「에이전트가 곧 가져간다」로 읽었다. 에이전트는 깨어나 ping만 보내고 받은편지함을
// 읽지 않았고, 서버는 그것을 D4 `woken_not_collected`로 이미 알고 있었다. 화면이 그 판정을
// 말하지 않은 것이 문제다.
//
// 이 모듈은 아무것도 새로 판정하지 않는다. 입력은 서버의 run 사실(`ServerRunFacts`)과
// 서버의 생존 판정(`AgentLiveness`, D4)뿐이고, 출력은 그 둘의 번역이다. 웹·폰의 홈 카드와
// 대화 아래 활동 줄이 같은 말을 하도록 코어에 둔다.
//
// ## 무엇을 바꾸나
//
//   1. 낱말: 사람이 부른 run이 아무에게도 가져가지 않은 채(`phase=queued`) N분을 넘으면
//      「대기 n번째」 대신 「아직 받지 않았어요」.
//   2. 근거 줄: 에이전트에게 D4 경고 라벨이 있으면 그 문구를 **맨 앞**에, 경과 시간은 뒤에.
//      라벨이 서는 때는 N과 무관하다(응답 없음 3시간인 에이전트에게 방금 보낸 요청에도
//      그 사실이 먼저 보인다). 라벨이 없으면 근거 줄은 전과 같다.
//   3. 이유 한 문장: 연결을 의심할 근거가 서버 판정에 있는 외부 에이전트에게만
//      「연결이 꺼져 있을 수 있어요」. 근거가 없는 상태(살아 있는데 일을 안 가져가는
//      에이전트, 호출이 거절된 에이전트)에는 그 문장이 거짓이라 붙이지 않는다.
//
// ## 이 판정 밖에 둔 것
//
//   - 가져간(`claimed`) run: 에이전트가 일을 잡았다. 「가져감」과 그 뒤의 「소식이 없어요」는
//     기존 규칙(`runPhaseDetail`)이 말한다.
//   - 시스템 작업(`system`, 환영 run): 부른 사람이 없다. 「아직 받지 않았어요」는 기다리는
//     사람이 있을 때의 말이다. 홈 카드는 이 run을 싣지 않는다(각 표면의 몫).
// =============================================================================

/**
 * 사람이 부른 run이 가져가는 이 없이 이 시간을 넘으면 「아직 받지 않았어요」로 말한다.
 *
 * 5분은 서버 D4의 `woken_grace`(`hosted_liveness.rs`)와 같은 값이다. 서버가 처음으로
 * 「깨웠지만 아직 안 가져감」을 붙일 수 있는 때와 같은 순간에 화면의 낱말이 바뀌어야 둘이
 * 서로를 반박하지 않는다. 서버가 run을 끝내는 때는 30분이다(E2 `woken_not_collected`).
 *
 * **이 값이 유일한 기본 유예다** (#4619 planner 결정 1). 홈 카드·작업 패널·대화 아래 예외 줄·
 * 메시지 머리의 칩이 모두 이 값을 쓴다. 한때 대화 줄·칩만 2분이었으나 같은 run이 한 화면에서
 * 표면마다 다른 시각에 「받지 않음」으로 바뀌는 것은 두 사건처럼 읽혔다.
 */
export const UNCOLLECTED_AFTER_MS = 5 * 60_000;

/**
 * 「아직 받지 않았어요」: **아무도 가져가지 않은 일의 유일한 낱말**이다. 홈 카드의 오른쪽 낱말, 작업
 * 패널의 머리 칩, 대화 아래 예외 줄의 머리말, 메시지 머리의 칩이 모두 이 상수를 읽는다(#4619 planner
 * 결정 1: 세 표면의 낱말을 하나로). 「대기 n번째」를 대신한다.
 */
export const UNCOLLECTED_WORD = "아직 받지 않았어요";

/**
 * 에이전트의 확인 박자(#4621 「확인 박자 추정」, ADR-0200 증보). 루틴형 에이전트는 실시간으로
 * 연결돼 있지 않고 정해진 간격으로 깨어나 일을 가져간다 — 그래서 「연결이 꺼져 있을 수 있어요」는
 * 사실이 아니라 「다음 확인을 기다리는 중」이 사실이다.
 *
 * 값은 서버가 파생해 내려준다. 이 타입은 그 모양을 받을 자리일 뿐이고, 서버 필드가 아직 없는
 * 동안 표면은 `undefined`를 넘긴다(지어내지 않는다).
 */
export interface RoutineHint {
  /** 평소 확인 간격(분). */
  typicalMinutes: number;
  /** 다음 확인 예상 시각(서버 시계, ms). 모르면 없다. */
  expectedCheckAtMs?: number;
}

/**
 * 분 수를 「15분」「2시간」으로. 「보통 N분 안」은 **상한**을 말하는 문장이라 올림이다(14.2분을
 * 「14분 안」이라 하면 어긋나는 날이 있다). 1분 아래는 1분이다: 0을 지어내지 않는다.
 */
function minutesText(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  if (m < 60) return `${m}분`;
  return `${Math.ceil(m / 60)}시간`;
}

/**
 * 루틴형 에이전트에게 요청이 닿았을 때 대신 하는 말. 「연결이 꺼져 있을 수 있어요」와 「일하는 곳 ·
 * 연결 안 됨」을 갈아 끼운다. 컴포저 맥락 띠와 예외 줄이 같은 문장을 쓰도록 한 곳에 둔다.
 */
export function routineWaitText(routine: Pick<RoutineHint, "typicalMinutes">): string {
  return `다음 확인 때 가져가요(보통 ${minutesText(routine.typicalMinutes)} 안)`;
}

/**
 * 이 run이 「아직 받지 않았어요」로 올라가는 시각(ms). **모든 표면이 이 함수 하나로 마감을 정한다.**
 *
 * 기본은 `queuedAtMs + graceMs`(5분). 에이전트의 **예상 확인 시각을 알면 그 시각이 이긴다**(#4619
 * planner 결정 1, 이슈 D 「#4621의 예상 확인 시각이 있으면 그 뒤」): 15분 박자 에이전트에게 5분 만에
 * 경보를 올리는 것도, 1분 박자 에이전트를 5분 동안 조용히 두는 것도 사실과 어긋난다.
 *
 * 다만 **이 run이 들어온 뒤의 시각만** 이 run이 기다리는 박자다. 예상 시각이 `queuedAtMs` 이전(낡은
 * 값)이거나 유한하지 않으면 무시하고 기본 유예로 돌아간다 — 낡은 값이 run을 들어오자마자 「받지
 * 않음」으로 만드는 거짓 경보를 막는 유일한 가드다. 확인 시각 앞뒤의 허용 오차는 그 값을 내려주는
 * 쪽(#4621)이 정한다.
 */
export function uncollectedDeadlineMs(
  queuedAtMs: number,
  routine?: Pick<RoutineHint, "expectedCheckAtMs">,
  graceMs: number = UNCOLLECTED_AFTER_MS
): number {
  const expected = routine?.expectedCheckAtMs;
  if (expected !== undefined && Number.isFinite(expected) && expected > queuedAtMs) {
    return expected;
  }
  return queuedAtMs + graceMs;
}

/**
 * 외부(호스티드) 에이전트의 연결을 의심할 근거가 서버 판정에 있을 때만 붙는 이유.
 * 단정이 아니라 가능성이다 — 서버는 연결이 꺼졌다고 알린 적이 없고(`inactive`가 아니다)
 * 신호가 없거나 깨웠는데 가져가지 않았다는 사실만 안다.
 */
export const CONNECTION_MAYBE_OFF_SENTENCE = "연결이 꺼져 있을 수 있어요";

/**
 * 이 낱말들에서 「연결이 꺼져 있을 수 있어요」가 서는 이유(서버 판정 → 근거):
 *
 *   woken_not_collected  깨우는 신호는 닿았는데 가져가지 않았다 — 실행기가 꺼져 있을 수 있다
 *   unresponsive         오랫동안(60분 넘게) 아무 신호가 없다
 *   quiet                20분 넘게 새 신호가 없다
 *
 * 서지 않는 상태와 이유:
 *
 *   inactive             이미 「연결이 꺼져 있어요」가 근거 줄 맨 앞에 선다(사실이다, 가능성이 아니다)
 *   work_waiting         신호는 60분 안에 있다 — 살아 있는데 일을 안 가져간다
 *   error                oort가 에이전트의 호출을 거절했다 — 연결이 아니라 자격의 문제다
 *   alive_idle·responsive  최근 신호가 있다
 */
const CONNECTION_DOUBT_STATES: ReadonlySet<AgentLivenessState> = new Set([
  "woken_not_collected",
  "unresponsive",
  "quiet",
]);

/** 서버가 알린 run이 부른 사람 없는 시스템 작업(환영)인가. */
export function isSystemRun(
  facts: Pick<ServerRunFacts, "system"> | null | undefined
): boolean {
  return facts?.system === true;
}

/**
 * 사람이 부른 run이고 아직 아무도 가져가지 않았는가(`phase=queued`). 가져간(`claimed`)
 * run은 아니다 — 에이전트가 일을 잡았으므로 「받지 않았어요」는 거짓이다.
 */
export function isUntakenHumanRun(
  facts: ServerRunFacts | null | undefined
): facts is ServerRunFacts {
  return facts !== null && facts !== undefined && facts.phase === "queued" && !isSystemRun(facts);
}

/**
 * 사람이 부른 run이 가져가는 이 없이 마감(`uncollectedDeadlineMs`: 기본 5분, 예상 확인 시각을 알면 그
 * 시각)을 넘었는가. 경계는 포함이다(`now == 마감`이면 넘은 것).
 *
 * **이것이 「아직 받지 않았어요」를 정하는 유일한 판정이다** — 홈 카드·작업 패널(`runStateWord`·
 * `queuedWaitCopy`), 대화 아래 예외 줄(`runException`), 메시지 머리의 칩(`triggerChip`), 입력창
 * 레일(`activityRail`)이 모두 이 함수를 부른다. 시험 `runException.parity`가 네 표면을 같은 시각으로
 * 맞대어 판정과 낱말이 같은지 붙든다.
 */
export function isUncollected(
  facts: ServerRunFacts | null | undefined,
  nowMs: number,
  routine?: Pick<RoutineHint, "expectedCheckAtMs">,
  graceMs: number = UNCOLLECTED_AFTER_MS
): boolean {
  return (
    isUntakenHumanRun(facts) &&
    nowMs >= uncollectedDeadlineMs(facts.queuedAtMs, routine, graceMs)
  );
}

/**
 * 한 run의 상태 낱말 — 카드의 오른쪽 낱말·작업 패널의 머리 칩과 run 목록 칩·폰 기록 시트의 칩이 모두
 * 이 함수 하나로 고른다. 사람이 부른 요청이 가져가는 이 없이 마감을 넘었으면 「아직 받지 않았어요」,
 * 아니면 서버가 말한 낱말(`runPhaseLabel`: 대기 n번째 · 가져감 · 진행 중 · 승인 대기 · 끝).
 * 시계(`nowMs`)를 안 주면 서버의 낱말 그대로다.
 *
 * 낱말을 고르는 자리를 하나로 둔 이유: 같은 run을 한 화면에서 두 낱말로 말하면 사람은 다른 일로
 * 읽는다. 「취소」가 서는 패널의 머리 칩은 「아직 받지 않았어요」인데 바로 아래 목록 칩이 「대기 1번째」이던
 * 것이 design-review #4285 r1 H5다.
 */
export function runStateWord(
  facts: ServerRunFacts,
  nowMs?: number,
  routine?: Pick<RoutineHint, "expectedCheckAtMs">
): string {
  if (nowMs !== undefined && isUncollected(facts, nowMs, routine)) return UNCOLLECTED_WORD;
  return runPhaseLabel(facts);
}

/**
 * 근거 줄 맨 앞에 서는 생존 문구. 서버의 경고 라벨(`livenessView`의 `warn`)과 연결이 꺼진
 * 상태(`inactive`: 「왜 안 가져가나」에 대한 가장 직접적인 답이다)만이다.
 *
 * `short`는 사이드바처럼 좁은 자리용이다(「안 가져감」). 모르는 상태(`undefined`)와 호스티드가
 * 아니라는 답(`null`)에는 문구가 없다 — 지어내지 않는다.
 */
export function waitingLead(
  liveness: Pick<AgentLiveness, "state" | "lastSignalAtMs"> | null | undefined,
  nowMs: number,
  form: "text" | "short" = "text"
): string | undefined {
  if (liveness === null || liveness === undefined) return undefined;
  const view = livenessView(liveness, nowMs);
  if (view.tone !== "warn" && liveness.state !== "inactive") return undefined;
  return form === "short" ? view.short : view.text;
}

/** 「연결이 꺼져 있을 수 있어요」가 서는가. 외부 에이전트(`liveness` 있음)의 서버 판정에 근거가 있을 때만. */
export function uncollectedReason(
  liveness: Pick<AgentLiveness, "state"> | null | undefined
): string | undefined {
  if (liveness === null || liveness === undefined) return undefined;
  return CONNECTION_DOUBT_STATES.has(liveness.state)
    ? CONNECTION_MAYBE_OFF_SENTENCE
    : undefined;
}

export interface QueuedWaitCopy {
  /** N분을 넘었는가. 낱말이 바뀌고, 홈 카드가 「취소」를 내는 조건이다. */
  uncollected: boolean;
  /** 한 낱말. 넘었으면 「아직 받지 않았어요」, 아니면 서버가 말한 「대기 n번째」. */
  word: string;
  /** 근거 줄: 생존 문구(있으면 맨 앞) · 「n째 기다려요」 · 「에이전트 앞에 m건」. */
  detail: string | undefined;
  /** 이유 한 문장. N을 넘었고 서버 판정에 근거가 있을 때만. */
  reason: string | undefined;
}

/**
 * 사람이 부른 채 아직 아무도 가져가지 않은 run의 말. 그 밖의 run(가져감·시스템 작업·모르는
 * run)에는 null이다 — 부르는 쪽이 기존 규칙을 그대로 쓴다.
 */
export function queuedWaitCopy({
  facts,
  nowMs,
  liveness,
  form = "text",
  routine,
}: {
  facts: ServerRunFacts | null | undefined;
  nowMs: number;
  /** 에이전트의 서버 생존 판정. 모르면(읽는 중) undefined, 호스티드가 아니면 null. */
  liveness?: Pick<AgentLiveness, "state" | "lastSignalAtMs"> | null;
  form?: "text" | "short";
  /**
   * 에이전트의 확인 박자(#4621). 알면 마감이 그 예상 확인 시각이 되고(`uncollectedDeadlineMs`), 이유는
   * 「다음 확인 때 가져가요」로 말한다. 모르면 undefined(지어내지 않는다) — 폰·웹 모두 서버 필드가 오기 전까지
   * 넘기지 않는다.
   */
  routine?: RoutineHint;
}): QueuedWaitCopy | null {
  if (!isUntakenHumanRun(facts)) return null;
  const uncollected = isUncollected(facts, nowMs, routine);
  const pieces = [waitingLead(liveness, nowMs, form), runPhaseDetail(facts, nowMs)];
  const detail = pieces
    .filter((piece): piece is string => piece !== undefined && piece !== "")
    .join(" · ");
  return {
    uncollected,
    word: runStateWord(facts, nowMs, routine),
    detail: detail === "" ? undefined : detail,
    reason: uncollected
      ? routine !== undefined
        ? routineWaitText(routine)
        : uncollectedReason(liveness)
      : undefined,
  };
}
