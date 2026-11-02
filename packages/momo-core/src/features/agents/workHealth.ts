import type { AgentRunLedgerEvent } from "../../lib/api";
import type { MessageService } from "../../i18n/types";
import { agentActivityRows } from "./workReport";
import type { ServerRunFacts } from "./workingSignal";

// =============================================================================
// 건강 신호 (#4657, A1-U2): 「지금 잘 하고 있나」를 **서버가 적어 둔 사실**로만 말한다. 판정하지 않는다:
// 「잘」의 품질은 oort가 모르고, 에이전트가 보고를 안 하면 「n분째 보고 없음」까지만 말한다(ADR-0200 D1·D4:
// 클라이언트 TTL로 소식 끊김을 지어내지 않는다). 폰 시트(#4658)가 같은 함수를 부른다.
//
// 신호는 다섯이고 모두 **분 단위 또는 개수**다(초 단위 숫자 없음).
//   조용함   run이 `running`인데 마지막 보고(서버 `last_event_at`)가 5분 넘게 없다.
//   머문 시간 가장 새 `stage`가 10분 넘게 그대로다(같은 단계에 n분째).
//   실패     에이전트가 실패로 알린 활동 수(에이전트 자기 보고이고, 칸의 꼬리표가 그 출처를 말한다).
//   거절     서버가 기록한 승인 거절 수(`approval_decided`, 닫힌 코드 `rejected`).
//   재시도   oort가 잰 호출 중, 같은 도구가 실패한 직후 다시 불린 횟수.
//
// - **시간 신호는 연결이 살아 있을 때만 센다**(`live`). 끊긴 화면의 「n분 전」은 우리 시계가 혼자 흘러간 숫자이고
//   그 사이의 보고는 못 읽었다: 끊기면 「마지막으로 확인된 상태」(셸 배너)가 말하고 이 줄은 개수만 남긴다.
// - 문턱(5분·10분)은 [추정]이다. 에이전트 보고 박자는 규약이지 서버가 강제하지 않고(60초로 당긴 것은 새
//   루틴뿐이고 이전 루틴은 5분이다), 에이전트가 박자를 알려 주는 서버 필드도 아직 없다(ADR-0200 증보 7 7-R).
//   그래서 5분 안의 침묵은 어느 박자에서도 평소로 보고 그 밖만 「조용해요」라고 말한다.
// =============================================================================

/** 마지막 보고가 이만큼 없으면 「조용해요」. 이전 루틴의 박자(5분) 안에서는 말하지 않는다. */
export const WORK_QUIET_AFTER_MS = 5 * 60_000;

/** 가장 새 단계가 이만큼 그대로면 「같은 단계에 n분째」. 긴 단계가 평소일 수 있어 한 박자 넉넉하게 둔다. */
export const WORK_DWELL_AFTER_MS = 10 * 60_000;

export interface WorkHealth {
  /** 조용한 분(5 이상). 조용하지 않으면 null. */
  quietMinutes: number | null;
  /** 같은 단계에 머문 분(10 이상). 아니면 null. */
  dwellMinutes: number | null;
  /** 에이전트가 실패로 알린 활동 수(활동 하나가 한 번). */
  failedActivities: number;
  /** 서버가 기록한 승인 거절 수. */
  rejectedApprovals: number;
  /** 같은 oort 도구가 실패한 직후 다시 불린 횟수. */
  retries: number;
}

export interface WorkHealthInput {
  facts: Pick<ServerRunFacts, "phase" | "lastEventAtMs">;
  events: readonly AgentRunLedgerEvent[];
  nowMs: number;
  /** 실시간 연결이 살아 있는가. 아니면 시간 신호는 서지 않는다. */
  live: boolean;
}

function wholeMinutes(ms: number): number {
  return Math.floor(Math.max(0, ms) / 60_000);
}

/** 이 run이 세어 둔 재시도 수: 도구별로 직전 호출이 실패였던 호출을 센다(시각순, 같은 시각은 받은 순서). */
function retryCount(events: readonly AgentRunLedgerEvent[]): number {
  const calls = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "tool_call" && event.tool !== undefined)
    .sort((a, b) => a.event.createdAtMs - b.event.createdAtMs || a.index - b.index);
  const lastFailed = new Map<string, boolean>();
  let retries = 0;
  for (const { event } of calls) {
    const tool = event.tool as string;
    if (lastFailed.get(tool) === true) retries += 1;
    lastFailed.set(tool, event.code !== undefined && event.code !== "ok");
  }
  return retries;
}

export function workHealth(input: WorkHealthInput): WorkHealth {
  const { facts, events, nowMs, live } = input;
  const running = facts.phase === "running";
  // 마지막 보고: 서버 진행 읽기의 값과 원장의 가장 새 행 중 늦은 쪽(원장이 더 새로울 수 있다). 깨움 줄은 서버가
  // `last_event_at`에서도 뺀다(ADR-0200 F9).
  const stamps = events.filter((event) => event.kind !== "doorbell_rung").map((event) => event.createdAtMs);
  if (facts.lastEventAtMs !== undefined) stamps.push(facts.lastEventAtMs);
  const lastReportAt = stamps.length === 0 ? undefined : Math.max(...stamps);
  const stageAt = events
    .filter((event) => event.kind === "stage")
    .reduce<number | undefined>(
      (best, event) => (best === undefined || event.createdAtMs > best ? event.createdAtMs : best),
      undefined
    );
  return {
    quietMinutes:
      live && running && lastReportAt !== undefined && nowMs - lastReportAt >= WORK_QUIET_AFTER_MS
        ? wholeMinutes(nowMs - lastReportAt)
        : null,
    dwellMinutes:
      live && running && stageAt !== undefined && nowMs - stageAt >= WORK_DWELL_AFTER_MS
        ? wholeMinutes(nowMs - stageAt)
        : null,
    failedActivities: agentActivityRows(events, true).filter((row) => row.status === "failed").length,
    rejectedApprovals: events.filter(
      (event) => event.kind === "approval_decided" && event.code === "rejected"
    ).length,
    retries: retryCount(events),
  };
}

type Format = MessageService["formatMessage"];

/**
 * 건강 줄의 문장: 「조용해요 · 마지막 보고 8분 전 · 같은 단계에 12분째 · 실패한 활동 1」. 말할 신호가 없으면
 * null이다(줄이 서지 않는다: 「문제 없음」을 지어내지 않는다).
 */
export function workHealthLine(health: WorkHealth, formatMessage: Format): string | null {
  const clauses: string[] = [];
  if (health.quietMinutes !== null) {
    clauses.push(formatMessage("timeline.workHealth.quiet", { minutes: health.quietMinutes }));
  }
  if (health.dwellMinutes !== null) {
    clauses.push(formatMessage("timeline.workHealth.dwell", { minutes: health.dwellMinutes }));
  }
  if (health.failedActivities > 0) {
    clauses.push(formatMessage("timeline.workHealth.failedActivities", { count: health.failedActivities }));
  }
  if (health.rejectedApprovals > 0) {
    clauses.push(formatMessage("timeline.workHealth.rejectedApprovals", { count: health.rejectedApprovals }));
  }
  if (health.retries > 0) {
    clauses.push(formatMessage("timeline.workHealth.retries", { count: health.retries }));
  }
  return clauses.length === 0 ? null : clauses.join(" · ");
}
