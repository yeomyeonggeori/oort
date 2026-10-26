import type { AgentLiveness, AgentRunProgress } from "../../lib/api";
import {
  endReasonText,
  runPhaseLabel,
  serverFactsOf,
} from "./runPhase";
import { isUntakenHumanRun, uncollectedReason } from "./runWaiting";
import type { ServerRunFacts } from "./workingSignal";

// =============================================================================
// 타임라인에 남기는 「예외」 한 줄의 판정 (#4619, owner 10-26 「ㄱㄱ」: #4577 권장 D).
//
// 평소의 진행(받음 → 가져감 → 작업 중 → 답)은 입력창 레일과 메시지의 작은 칩이 말한다.
// 대화 본 줄에 따로 줄을 세우는 것은 **사람이 움직여야 할 수 있는 상태**뿐이다:
//
//   못 가져감   사람이 부른 요청을 아무도 가져가지 않은 채 유예를 넘었다(서버가 그래서 끝낸 것 포함)
//   실패        서버가 `failed`로 끝냈다
//   시간 초과   서버가 가져간 뒤 `timed_out`으로 끝냈다(신호 소실 포함)
//
// 이 모듈은 아무것도 새로 판정하지 않는다. 입력은 서버가 파생한 run 사실이고, 유예와 낱말만
// 여기서 정한다. 같은 상태를 표면마다 다른 낱말로 부르면 사람이 둘을 다른 상태로 읽는다. 웹과 폰이
// 같은 말을 하도록 코어에 둔다.
//
// ## 같은 행의 칩과 같은 낱말이다 (`triggerChip`)
//
// 메시지 머리의 칩과 이 줄은 **한 행에 함께 선다**. 둘이 같은 run을 다른 낱말로 부르면(칩은
// 「못 가져감」, 줄은 「시간 초과」) 읽는 사람은 두 사건으로 읽는다. 그래서 「아무도 가져가지 않은
// 일」은 열려 있든(유예를 넘은 대기) 서버가 그래서 끝냈든(`unclaimed_expired`·`woken_not_collected`)
// 한 낱말 `UNCOLLECTED_HEADLINE`(「못 가져감」)이고, 칩이 이 상수를 읽는다. 홈 카드·작업 패널의
// 「아직 받지 않았어요」(#4285)는 **다른 표면**의 말이다: 거기는 5분 뒤의 낱말이고 이 줄·칩은 2분
// 뒤의 낱말이다. 교차 시험(`runExceptionChipParity.test`)이 이 줄과 칩의 낱말을 함께 붙든다.
// 실패는 두 곳이 같은 낱말(`runPhase`의 「실패」)이다. 서버가 가져가고 나서 끝낸 시간 초과·신호 소실은
// 칩이 큰 범주(「실패」)로, 이 줄이 구체 낱말(`runPhase`의 「시간 초과」·「신호 소실」)로 말한다.
//
// 이 줄의 글자에는 **초 단위 숫자가 없다**. 경과를 말하지 않는다: 줄은 서고 나면 가만히 있고,
// 시계가 돌지 않으니 다시 그릴 이유도 없다. 예외가 아닌 것(승인 대기·일시 정지·가져간 뒤 조용함)은
// 여기서 null이다 — 승인은 카드가, 나머지는 레일과 작업 패널이 말한다.
// =============================================================================

/** 「아무도 가져가지 않은 일」의 낱말. 이 줄과 메시지 머리의 칩이 함께 읽는다(위 머리말). */
export const UNCOLLECTED_HEADLINE = "못 가져감";

/**
 * 서버가 「아무도 가져가지 않아 끝냈다」고 쓰는 종료 코드. `timed_out`으로 끝나지만 에이전트가 일을
 * 한 적이 없으므로 시간 초과(일하다 멈춤)가 아니라 **가져가지 않은 일**이다. 칩도 같은 목록을 읽는다.
 */
export const UNCLAIMED_END_REASONS: ReadonlySet<string> = new Set([
  "unclaimed_expired",
  "woken_not_collected",
]);

/**
 * 못 가져감 유예: 예상 확인 시각을 모를 때 이 시간이 지나야 예외 줄이 선다.
 *
 * 기존 `UNCOLLECTED_AFTER_MS`(5분, 서버 D4 `woken_grace`와 같은 값)와 **일부러 다르다**: 그쪽은
 * 홈 카드·작업 패널의 낱말이 「대기 n번째」에서 「아직 받지 않았어요」로 바뀌는 때이고, 이쪽은
 * 대화 본 줄에 줄을 세우는 때다(#4619 계약: 예상 확인 시각이 있으면 그것, 없으면 2분).
 * 두 값이 갈라진 것은 계약이 정한 것이며, 하나로 합칠지는 owner 결정이다.
 */
export const UNCOLLECTED_GRACE_MS = 2 * 60_000;

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
 * 이 run이 「못 가져감」으로 올라가는 시각(ms).
 *
 * 예상 확인 시각이 유예보다 **뒤**면 그 시각까지 기다린다(계약: 예상 확인 시각이 있으면 그것).
 * 유예 전에는 어떤 경우에도 올리지 않는다: 확인이 곧이라는 예측은 지터를 안고 있어서, 그 순간
 * 곧바로 경고하면 에이전트가 몇 초 늦게 가져가는 평범한 경우가 매번 깜박이는 거짓 경보가 된다.
 * 이 하한 덕에 run이 들어오기 전의 낡은 예상 시각(그 run이 기다린 박자가 아니다)도 자연히 유예로
 * 돌아간다.
 */
export function uncollectedDeadlineMs(
  queuedAtMs: number,
  routine?: Pick<RoutineHint, "expectedCheckAtMs">,
  graceMs: number = UNCOLLECTED_GRACE_MS
): number {
  const floor = queuedAtMs + graceMs;
  const expected = routine?.expectedCheckAtMs;
  return expected === undefined ? floor : Math.max(floor, expected);
}

/**
 * 사람이 부른 run이 가져가는 이 없이 유예를 넘었는가. 경계는 포함이다(`now == 마감`이면 예외):
 * 기존 `isUncollected`와 같은 방향이다.
 */
export function isUncollectedPastGrace(
  facts: ServerRunFacts | null | undefined,
  nowMs: number,
  routine?: Pick<RoutineHint, "expectedCheckAtMs">,
  graceMs: number = UNCOLLECTED_GRACE_MS
): boolean {
  return (
    isUntakenHumanRun(facts) &&
    nowMs >= uncollectedDeadlineMs(facts.queuedAtMs, routine, graceMs)
  );
}

/**
 * 아직 유예 안에 있는 대기 run들 중 **가장 이른 마감**(ms). 없으면 null.
 *
 * 표면은 이 시각에 한 번 다시 그리면 「받음」이 「못 가져감」으로 바뀐다. 매초 다시 그리지 않아도
 * 된다: 줄도 칩도 경과를 말하지 않으므로 시계가 필요한 것은 이 한 순간뿐이다.
 */
export function nextUncollectedDeadlineMs(
  runs: readonly AgentRunProgress[],
  nowMs: number,
  routineFor?: (memberId: string) => Pick<RoutineHint, "expectedCheckAtMs"> | undefined,
  graceMs: number = UNCOLLECTED_GRACE_MS
): number | null {
  let next: number | null = null;
  for (const run of runs) {
    if (run.phase !== "queued") continue;
    const facts = serverFactsOf(run);
    if (!isUntakenHumanRun(facts)) continue;
    const deadline = uncollectedDeadlineMs(
      facts.queuedAtMs,
      routineFor?.(run.agentMemberId),
      graceMs
    );
    if (deadline <= nowMs) continue;
    if (next === null || deadline < next) next = deadline;
  }
  return next;
}

export type RunExceptionKind = "uncollected" | "failed" | "timed_out";

/**
 * 줄이 내놓을 수 있는 행동. 모델은 **후보**만 말하고, 되는지는 표면이 정한다(권한·연결·API 유무):
 * 되지 않는 행동을 죽은 버튼으로 세우지 않는다.
 *
 *   wake      다시 깨우기(owner/admin, 켜진 호스티드 연결)
 *   cancel    취소(아직 열려 있는 run)
 *   settings  에이전트 설정 열기
 *
 * 「진행 과정 열기」(작업 패널)는 후보가 아니라 **모든 예외 줄의 기본**이다: 줄의 글이 곧 그 입구다.
 * 끝난 run(실패·시간 초과)에는 되돌릴 행동이 없어 후보가 비어 있다.
 */
export type RunExceptionAction = "wake" | "cancel" | "settings";

export interface RunException {
  kind: RunExceptionKind;
  runId: string;
  agentMemberId: string;
  triggerMessageId?: string;
  /** 줄이 말하는 낱말: 「못 가져감」(`UNCOLLECTED_HEADLINE`) 또는 `runPhase` 어휘(실패·시간 초과·신호 소실). */
  headline: string;
  /** 이유 한 문장. 근거가 없으면 없다(지어내지 않는다). */
  reason?: string;
  /** 서버가 아직 열린 run이라고 말한다: 취소가 의미 있다. */
  open: boolean;
  actions: readonly RunExceptionAction[];
}

export interface RunExceptionContext {
  graceMs?: number;
  /** 에이전트의 확인 박자(#4621). 모르면 undefined. */
  routine?: RoutineHint;
  /** 서버의 생존 판정(D4). 아직 모르면 undefined, 호스티드가 아니면 null. */
  liveness?: Pick<AgentLiveness, "state"> | null;
}

/**
 * 한 run이 타임라인 예외 줄을 얻는가. 아니면 null이다.
 *
 * 이유 문장의 순서: 루틴 박자를 알면 그 말(「다음 확인 때 가져가요」), 아니면 서버의 생존 판정에
 * 근거가 있을 때만 「연결이 꺼져 있을 수 있어요」, 그 밖에는 이유를 붙이지 않는다. 끝난 run의
 * 이유는 서버가 쓴 닫힌 종료 코드에서만 나온다(모르는 코드는 문장을 만들지 않는다).
 */
export function runException(
  progress: AgentRunProgress,
  nowMs: number,
  context: RunExceptionContext = {}
): RunException | null {
  const facts = serverFactsOf(progress);
  const base = {
    runId: progress.id,
    agentMemberId: progress.agentMemberId,
    ...(progress.triggerMessageId !== undefined
      ? { triggerMessageId: progress.triggerMessageId }
      : {}),
  };
  switch (progress.phase) {
    case "queued": {
      if (!isUncollectedPastGrace(facts, nowMs, context.routine, context.graceMs)) {
        return null;
      }
      const reason =
        context.routine !== undefined
          ? routineWaitText(context.routine)
          : uncollectedReason(context.liveness);
      return {
        ...base,
        kind: "uncollected",
        headline: UNCOLLECTED_HEADLINE,
        ...(reason !== undefined ? { reason } : {}),
        open: true,
        actions: ["wake", "cancel", "settings"],
      };
    }
    case "failed":
    case "timed_out": {
      const reason = endReasonText(progress.endReason);
      // 서버가 「아무도 가져가지 않아」 끝낸 run은 일하다 멈춘 것이 아니다: 열린 못 가져감과 같은 낱말이다.
      if (
        progress.phase === "timed_out" &&
        progress.endReason !== undefined &&
        UNCLAIMED_END_REASONS.has(progress.endReason)
      ) {
        return {
          ...base,
          kind: "uncollected",
          headline: UNCOLLECTED_HEADLINE,
          ...(reason !== undefined ? { reason } : {}),
          open: false,
          actions: [],
        };
      }
      return {
        ...base,
        kind: progress.phase === "failed" ? "failed" : "timed_out",
        headline: runPhaseLabel(facts),
        ...(reason !== undefined ? { reason } : {}),
        open: false,
        actions: [],
      };
    }
    default:
      return null;
  }
}

/** 줄 전체를 한 문장으로(툴팁·보조기술·시험): 「달무리봇: 못 가져감 · 다음 확인 때 가져가요(보통 15분 안)」. */
export function runExceptionText(
  name: string,
  exception: Pick<RunException, "headline" | "reason">
): string {
  return exception.reason === undefined
    ? `${name}: ${exception.headline}`
    : `${name}: ${exception.headline} · ${exception.reason}`;
}
