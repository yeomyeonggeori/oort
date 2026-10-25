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
 */
export const UNCOLLECTED_AFTER_MS = 5 * 60_000;

/** 카드의 오른쪽 낱말·활동 줄의 꼬리. 「대기 n번째」를 대신한다. */
export const UNCOLLECTED_WORD = "아직 받지 않았어요";

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

/** 사람이 부른 run이 가져가는 이 없이 `UNCOLLECTED_AFTER_MS`를 넘었는가. */
export function isUncollected(
  facts: ServerRunFacts | null | undefined,
  nowMs: number
): boolean {
  return isUntakenHumanRun(facts) && nowMs - facts.queuedAtMs >= UNCOLLECTED_AFTER_MS;
}

/**
 * 한 run의 상태 낱말 — 카드의 오른쪽 낱말·작업 패널의 머리 칩과 run 목록 칩·폰 기록 시트의 칩이 모두
 * 이 함수 하나로 고른다. 사람이 부른 요청이 가져가는 이 없이 N분을 넘었으면 「아직 받지 않았어요」,
 * 아니면 서버가 말한 낱말(`runPhaseLabel`: 대기 n번째 · 가져감 · 진행 중 · 승인 대기 · 끝).
 * 시계(`nowMs`)를 안 주면 서버의 낱말 그대로다.
 *
 * 낱말을 고르는 자리를 하나로 둔 이유: 같은 run을 한 화면에서 두 낱말로 말하면 사람은 다른 일로
 * 읽는다. 「취소」가 서는 패널의 머리 칩은 「아직 받지 않았어요」인데 바로 아래 목록 칩이 「대기 1번째」이던
 * 것이 design-review #4285 r1 H5다.
 */
export function runStateWord(facts: ServerRunFacts, nowMs?: number): string {
  if (nowMs !== undefined && isUncollected(facts, nowMs)) return UNCOLLECTED_WORD;
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
}: {
  facts: ServerRunFacts | null | undefined;
  nowMs: number;
  /** 에이전트의 서버 생존 판정. 모르면(읽는 중) undefined, 호스티드가 아니면 null. */
  liveness?: Pick<AgentLiveness, "state" | "lastSignalAtMs"> | null;
  form?: "text" | "short";
}): QueuedWaitCopy | null {
  if (!isUntakenHumanRun(facts)) return null;
  const uncollected = isUncollected(facts, nowMs);
  const pieces = [waitingLead(liveness, nowMs, form), runPhaseDetail(facts, nowMs)];
  const detail = pieces
    .filter((piece): piece is string => piece !== undefined && piece !== "")
    .join(" · ");
  return {
    uncollected,
    word: runStateWord(facts, nowMs),
    detail: detail === "" ? undefined : detail,
    reason: uncollected ? uncollectedReason(liveness) : undefined,
  };
}
