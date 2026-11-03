import type { AgentRunLedgerEvent } from "../../lib/api";
import { isUntakenHumanRun, uncollectedDeadlineMs } from "./runWaiting";
import { healthAnchors, WORK_DWELL_AFTER_MS, WORK_QUIET_AFTER_MS } from "./workHealth";
import type { ServerRunFacts } from "./workingSignal";

// =============================================================================
// 작업 기록 시트의 마감 (#4658). 시계가 없는 표면은 열린 run을 그리는 동안 **초마다 다시 그리지 않는다**(입력창 레일 #4620과 같은
// 규칙): 화면의 글은 초가 아니라 **사실**이 바뀔 때 다시 그린다.
//
//   · 새 사실이 오는 것(원장 프레임·진행 읽기·30초 다시 읽기)은 스토어가 이미 다시 그리게 한다.
//   · **시간만으로** 사실이 바뀌는 순간은 여기서 계산하고, 표면이 그 순간에 **한 번만** 다시 그린다:
//       - 아무도 가져가지 않은 요청이 유예(5분)를 넘는 때 — 낱말이 「대기 1번째」에서 「아직 받지 않았어요」로 바뀐다.
//       - 시트가 분 단위로 말하는 숫자가 한 칸 오르는 때 — 「n분째 기다려요」「n분째 · 마지막 보고 m분 전」「같은 단계에 n분째」.
//         1분이 안 된 구간은 숫자 없이 「방금」·「중」으로 말하므로(`minutesOnly`) 초 때문에 다시 그릴 일은 없다.
//       - 조용함(마지막 보고 5분 뒤)과 머문 시간(가장 새 단계 10분 뒤)의 문턱을 넘는 때.
//
// 끝난 run의 글(걸린 시간·단계 시각)은 변하지 않으므로 마감이 없다. 이 파일은 **어떤 phase에서 어떤 글이 시간을 읽는가**의 표다:
// 글을 만드는 쪽(`runPhaseDetail`·`runDurationBreakdown`·`workHealth`)이 바뀌면 이 표도 같이 바뀌어야 하고, 시험이 두 쪽을 맞대어
// 「마감 전에는 글이 같고 마감에 글이 바뀐다」를 잰다.
// =============================================================================

const MINUTE = 60_000;

/**
 * `anchorMs`에서 센 분 숫자가 **다음에** 오르는 순간(`nowMs`보다 뒤). 닻이 아직 미래(서버 시계가 앞섬)이면 그 닻의 순간이다.
 * 경계는 포함이다: 정확히 `anchor + n분`에 불리면 그 순간의 숫자가 이미 올라 있으므로 다음 칸을 돌려준다.
 */
export function nextMinuteMarkMs(anchorMs: number, nowMs: number): number {
  if (anchorMs > nowMs) return anchorMs;
  return anchorMs + (Math.floor((nowMs - anchorMs) / MINUTE) + 1) * MINUTE;
}

/**
 * 시간이 시트의 사실을 바꾸는 **가장 이른 순간**(ms). 없으면 null. 그 순간은 항상 `nowMs`보다 뒤다 — 지난 마감은 이미 그린 글이
 * 말하고 있다.
 *
 *   queued              유예 마감(사람이 부른 요청만) · 「n분째 기다려요」(요청 시각)
 *   claimed             「n분 전에 가져감」(가져간 시각) 또는 소식이 끊긴 뒤 「n분째 소식이 없어요」(마지막 보고)
 *   running             「n분째」(시작 시각) · 「마지막 보고 n분 전」(마지막 보고) · 조용함 문턱 · 머문 시간
 *                       (건강 신호의 시간 신호는 연결이 살아 있을 때만 센다 — `workHealth`)
 *   awaiting_approval   걸린 시간 줄의 「작업 n분째」(시작 시각)
 */
export function nextRunDeadlineMs(input: {
  facts: ServerRunFacts;
  events: readonly AgentRunLedgerEvent[];
  nowMs: number;
  /** 실시간 연결이 살아 있는가(건강 신호의 시간 신호가 서는 조건). */
  live: boolean;
}): number | null {
  const { facts, events, nowMs, live } = input;
  let next: number | null = null;
  const consider = (at: number | undefined): void => {
    if (at === undefined || !Number.isFinite(at) || at <= nowMs) return;
    if (next === null || at < next) next = at;
  };
  const minuteMarks = (anchorMs: number | undefined): void => {
    if (anchorMs !== undefined && Number.isFinite(anchorMs)) {
      consider(nextMinuteMarkMs(anchorMs, nowMs));
    }
  };
  switch (facts.phase) {
    case "queued":
      if (isUntakenHumanRun(facts)) consider(uncollectedDeadlineMs(facts.queuedAtMs));
      minuteMarks(facts.queuedAtMs);
      break;
    case "claimed":
      minuteMarks(
        facts.leaseState === "stale" ? (facts.lastEventAtMs ?? facts.claimedAtMs) : facts.claimedAtMs
      );
      break;
    case "running": {
      minuteMarks(facts.startedAtMs);
      minuteMarks(facts.lastEventAtMs);
      if (live) {
        const { lastReportAtMs, stageAtMs } = healthAnchors(facts, events);
        if (lastReportAtMs !== undefined) consider(lastReportAtMs + WORK_QUIET_AFTER_MS);
        if (stageAtMs !== undefined) {
          consider(stageAtMs + WORK_DWELL_AFTER_MS);
          // 문턱을 넘은 뒤 「같은 단계에 n분째」는 분마다 한 칸 오른다.
          if (nowMs - stageAtMs >= WORK_DWELL_AFTER_MS) minuteMarks(stageAtMs);
        }
      }
      break;
    }
    case "awaiting_approval":
    case "paused":
      minuteMarks(facts.startedAtMs);
      break;
    default:
      break;
  }
  return next;
}
