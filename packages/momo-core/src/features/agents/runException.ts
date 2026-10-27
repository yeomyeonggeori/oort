import type { AgentLiveness, AgentRunProgress } from "../../lib/api";
import {
  endReasonText,
  runPhaseLabel,
  serverFactsOf,
} from "./runPhase";
import { DOORBELL_FAILED_TEXT } from "./runLedger";
import { RUN_STATUS_WOKEN_FAILED, type DoorbellFact } from "./runStatusLine";
import {
  isUncollected,
  isUntakenHumanRun,
  routineWaitText,
  uncollectedDeadlineMs,
  uncollectedReason,
  UNCOLLECTED_WORD,
  type RoutineHint,
} from "./runWaiting";

// =============================================================================
// 타임라인에 남기는 「예외」 한 줄의 판정 (#4619, owner 10-26 「ㄱㄱ」: #4577 권장 D).
//
// 평소의 진행(받음 → 가져감 → 작업 중 → 답)은 입력창 레일과 메시지의 작은 칩이 말한다.
// 대화 본 줄에 따로 줄을 세우는 것은 **사람이 움직여야 할 수 있는 상태**뿐이다:
//
//   아직 받지 않았어요  사람이 부른 요청을 아무도 가져가지 않은 채 유예를 넘었다(서버가 그래서 끝낸 것 포함)
//   깨우는 신호가 닿지 않음  아직 아무도 가져가지 않았는데 깨우는 신호(도어벨)마저 닿지 않았다
//   실패        서버가 `failed`로 끝냈다
//   시간 초과   서버가 가져간 뒤 `timed_out`으로 끝냈다(신호 소실 포함)
//
// 이 모듈은 아무것도 새로 판정하지 않는다. 입력은 서버가 파생한 run 사실이고, 낱말은 이미 있는 것을
// 읽는다. 같은 상태를 표면마다 다른 낱말로 부르면 사람이 둘을 다른 상태로 읽는다. 웹과 폰이 같은
// 말을 하도록 코어에 둔다.
//
// ## 아무도 가져가지 않은 일은 한 판정·한 낱말이다 (planner 결정 1)
//
// 홈 카드·작업 패널·이 줄·메시지 머리의 칩·입력창 레일은 **같은 함수**(`runWaiting.isUncollected`: 기본
// 5분, 예상 확인 시각을 알면 그 시각)로 「아직 받지 않았어요」를 정하고 **같은 낱말**(`UNCOLLECTED_WORD`)로
// 부른다. 한때 대화 줄·칩은 2분·「못 가져감」, 홈 카드는 5분·「아직 받지 않았어요」로 갈라져, 같은 run이 한
// 화면에서 두 시각에 두 이름으로 바뀌었다. 열려 있든(유예를 넘은 대기) 서버가 그래서 끝냈든
// (`unclaimed_expired`·`woken_not_collected`) 같은 낱말이고, 칩이 `UNCLAIMED_END_REASONS`를 읽는다.
// 교차 시험(`runExceptionChipParity.test`)이 줄·칩·카드의 판정과 낱말을 한 시각에 맞대어 붙든다.
//
// 칩과의 관계는 이렇다: 줄이 「아직 받지 않았어요」이면 칩도 같은 낱말이고, 줄이 「실패」이면 칩도
// 「실패」다. 줄이 「깨우는 신호가 닿지 않음」인 run의 칩은 아직 **진행 낱말**(「받음」)이다 — 그것은
// 경보가 아니라 원인 설명이고, 유예를 넘으면 줄도 칩도 「아직 받지 않았어요」가 되며 깨우는 신호 실패는
// 줄의 이유 문장으로 남는다. 서버가 가져가고 나서 끝낸 시간 초과·신호 소실은 칩이 큰 범주(「실패」)로,
// 이 줄이 구체 낱말(`runPhase`의 「시간 초과」·「신호 소실」)로 말한다.
//
// 이 줄의 글자에는 **초 단위 숫자가 없다**. 경과를 말하지 않는다: 줄은 서고 나면 가만히 있고,
// 시계가 돌지 않으니 다시 그릴 이유도 없다. 예외가 아닌 것(승인 대기·일시 정지·가져간 뒤 조용함)은
// 여기서 null이다 — 승인은 카드가, 나머지는 레일과 작업 패널이 말한다.
// =============================================================================

/**
 * 서버가 「아무도 가져가지 않아 끝냈다」고 쓰는 종료 코드. `timed_out`으로 끝나지만 에이전트가 일을
 * 한 적이 없으므로 시간 초과(일하다 멈춤)가 아니라 **가져가지 않은 일**이다. 칩도 같은 목록을 읽는다.
 */
export const UNCLAIMED_END_REASONS: ReadonlySet<string> = new Set([
  "unclaimed_expired",
  "woken_not_collected",
]);

/**
 * 아직 유예 안에 있는 대기 run들 중 **가장 이른 마감**(ms). 없으면 null.
 *
 * 표면은 이 시각에 한 번 다시 그리면 「받음」이 「아직 받지 않았어요」로 바뀐다. 매초 다시 그리지 않아도
 * 된다: 줄도 칩도 경과를 말하지 않으므로 시계가 필요한 것은 이 한 순간뿐이다.
 */
export function nextUncollectedDeadlineMs(
  runs: readonly AgentRunProgress[],
  nowMs: number,
  routineFor?: (memberId: string) => Pick<RoutineHint, "expectedCheckAtMs"> | undefined,
  graceMs?: number
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

export type RunExceptionKind = "uncollected" | "wake_failed" | "failed" | "timed_out";

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
  /**
   * 줄이 말하는 낱말: 「아직 받지 않았어요」(`UNCOLLECTED_WORD`)·「깨우는 신호가 닿지 않음」
   * (`RUN_STATUS_WOKEN_FAILED`, 폰이 쓰는 그 낱말) 또는 `runPhase` 어휘(실패·시간 초과·신호 소실).
   */
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
  /**
   * 원장이 말하는 깨우는 신호의 사실(`doorbellFactOf`). 아직 못 읽었거나 행이 없으면 undefined/null.
   * 지어내지 않는다: 모르면 「깨우는 신호가 닿지 않음」 줄은 서지 않는다.
   */
  doorbell?: DoorbellFact | null;
}

/**
 * 한 run이 타임라인 예외 줄을 얻는가. 아니면 null이다.
 *
 * 이유 문장의 순서(아직 받지 않았어요): 루틴 박자를 알면 그 말(「다음 확인 때 가져가요」), 아니면 원장이
 * 깨우는 신호가 닿지 않았다고 말하면 그 말, 아니면 서버의 생존 판정에 근거가 있을 때만 「연결이 꺼져
 * 있을 수 있어요」, 그 밖에는 이유를 붙이지 않는다. 끝난 run의 이유는 서버가 쓴 닫힌 종료 코드에서만
 * 나온다(모르는 코드는 문장을 만들지 않는다).
 *
 * 「깨우는 신호가 닿지 않음」은 **아직 아무도 가져가지 않은**(`queued`) 사람의 요청에만 선다. 이미
 * 가져간 run은 신호가 닿았든 아니든 에이전트가 일을 잡았으므로 경보가 아니다(원장의 신호 행은 대기 중에
 * 찍히고, 가져간 뒤의 실패는 이 run과 무관한 다른 요청의 신호일 수 있다).
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
      if (!isUntakenHumanRun(facts)) return null;
      const doorbellFailed = context.doorbell?.failed === true;
      const waitReason =
        context.routine !== undefined
          ? routineWaitText(context.routine)
          : undefined;
      if (isUncollected(facts, nowMs, context.routine, context.graceMs)) {
        const reason =
          waitReason ??
          (doorbellFailed ? DOORBELL_FAILED_TEXT : uncollectedReason(context.liveness));
        return {
          ...base,
          kind: "uncollected",
          headline: UNCOLLECTED_WORD,
          ...(reason !== undefined ? { reason } : {}),
          open: true,
          actions: ["wake", "cancel", "settings"],
        };
      }
      if (doorbellFailed) {
        const reason = waitReason ?? uncollectedReason(context.liveness);
        return {
          ...base,
          kind: "wake_failed",
          headline: RUN_STATUS_WOKEN_FAILED,
          ...(reason !== undefined ? { reason } : {}),
          open: true,
          actions: ["wake", "cancel", "settings"],
        };
      }
      return null;
    }
    case "failed":
    case "timed_out": {
      const reason = endReasonText(progress.endReason);
      // 서버가 「아무도 가져가지 않아」 끝낸 run은 일하다 멈춘 것이 아니다: 열린 「아직 받지 않았어요」와 같은 낱말이다.
      if (
        progress.phase === "timed_out" &&
        progress.endReason !== undefined &&
        UNCLAIMED_END_REASONS.has(progress.endReason)
      ) {
        return {
          ...base,
          kind: "uncollected",
          headline: UNCOLLECTED_WORD,
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

/** 줄 전체를 한 문장으로(툴팁·보조기술·시험): 「달무리봇: 아직 받지 않았어요 · 다음 확인 때 가져가요(보통 15분 안)」. */
export function runExceptionText(
  name: string,
  exception: Pick<RunException, "headline" | "reason">
): string {
  return exception.reason === undefined
    ? `${name}: ${exception.headline}`
    : `${name}: ${exception.headline} · ${exception.reason}`;
}
