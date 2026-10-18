import type { AgentRunLedgerEvent, AgentRunProgress } from "../../lib/api";
import { doorbellFailed } from "./runLedger";
import {
  isOpenRunPhase,
  runPhaseDetail,
  runPhaseLabel,
  serverFactsOf,
} from "./runPhase";

// =============================================================================
// 보낸 메시지 아래 상태 한 줄 (#3824).
//
//   받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 → 결과
//
// 사람이 에이전트를 부른 뒤 가장 먼저 묻는 것은 「닿았나?」이고, 그 다음이 「어디서
// 시간이 가나?」다. 이 줄은 서버가 아는 사실로 그 둘에 답한다. 웹·데스크탑·폰이 같은
// 낱말을 쓰도록 core에 둔다.
//
// 지나간 단계만 적는다. 아직 오지 않은 단계를 회색으로 미리 그리지 않는다 — 「가져감」이
// 영영 오지 않는 run(만료·취소)에서 그 회색 글자는 약속처럼 읽힌다. 단계를 건너뛴
// run(관리형 에이전트는 깨우는 신호가 없다)은 그 단계를 빼고 잇는다.
//
// 「깨우는 신호 보냄」은 원장의 `doorbell_rung` 행이 있을 때만 선다. 그 행을 싣지 않는
// 옛 서버에서는 이 단계가 없고, 나머지는 그대로다.
// =============================================================================

export type RunStatusStepKey =
  | "received"
  | "woken"
  | "claimed"
  | "working"
  | "approval"
  | "paused"
  | "result";

export interface RunStatusStep {
  key: RunStatusStepKey;
  text: string;
}

/** 원장에서 읽은 깨우는 신호의 사실. 원장을 못 읽었거나 행이 없으면 null. */
export interface DoorbellFact {
  /** 가장 최근 신호의 시각. */
  lastAtMs: number;
  /** 가장 최근 신호가 닿지 않았다. */
  failed: boolean;
  count: number;
}

export interface RunStatusLine {
  runId: string;
  agentMemberId: string;
  steps: RunStatusStep[];
  /** 지금 단계의 근거 한 줄(「12분째 · 마지막 보고 1분 전」「3분 12초 걸림」). */
  detail?: string;
  /** 끝났다. 표면이 시계를 멈춘다. */
  ended: boolean;
  /** 사람이 할 일이 있다(승인 대기). 표면이 경고색을 쓴다. */
  needsHuman: boolean;
}

export const RUN_STATUS_RECEIVED = "받았어요";
export const RUN_STATUS_WOKEN = "깨우는 신호 보냄";
export const RUN_STATUS_WOKEN_FAILED = "깨우는 신호가 닿지 않음";
export const RUN_STATUS_CLAIMED = "가져감";
export const RUN_STATUS_WORKING = "작업 중";

/** 원장에서 깨우는 신호만 추린다. 없으면 null. */
export function doorbellFactOf(
  events: readonly AgentRunLedgerEvent[] | null | undefined
): DoorbellFact | null {
  if (events === null || events === undefined) return null;
  let last: AgentRunLedgerEvent | undefined;
  let count = 0;
  for (const event of events) {
    if (event.kind !== "doorbell_rung") continue;
    count += 1;
    if (last === undefined || event.createdAtMs >= last.createdAtMs) last = event;
  }
  if (last === undefined) return null;
  return { lastAtMs: last.createdAtMs, failed: doorbellFailed(last.code), count };
}

/** 한 run의 상태 줄. */
export function runStatusLine(
  progress: AgentRunProgress,
  doorbell: DoorbellFact | null,
  nowMs: number
): RunStatusLine {
  const facts = serverFactsOf(progress);
  const open = isOpenRunPhase(progress.phase);
  const steps: RunStatusStep[] = [{ key: "received", text: RUN_STATUS_RECEIVED }];
  if (doorbell !== null) {
    steps.push({
      key: "woken",
      text: doorbell.failed ? RUN_STATUS_WOKEN_FAILED : RUN_STATUS_WOKEN,
    });
  }
  const pastClaim =
    progress.claimedAtMs !== undefined ||
    progress.startedAtMs !== undefined ||
    progress.phase === "claimed" ||
    progress.phase === "running" ||
    progress.phase === "awaiting_approval" ||
    progress.phase === "paused";
  if (pastClaim) steps.push({ key: "claimed", text: RUN_STATUS_CLAIMED });
  if (
    progress.phase === "running" ||
    progress.phase === "awaiting_approval" ||
    progress.phase === "paused"
  ) {
    steps.push({ key: "working", text: RUN_STATUS_WORKING });
  }
  if (progress.phase === "awaiting_approval") {
    steps.push({ key: "approval", text: runPhaseLabel(facts) });
  }
  if (progress.phase === "paused") {
    steps.push({ key: "paused", text: runPhaseLabel(facts) });
  }
  if (!open) steps.push({ key: "result", text: runPhaseLabel(facts) });
  // 대기 중인 줄은 「앞에 m건」을 함께 말한다: 깨웠는데도 안 가져가는 이유가 그것일 수 있다.
  const detail = runPhaseDetail(facts, nowMs);
  return {
    runId: progress.id,
    agentMemberId: progress.agentMemberId,
    steps,
    ...(detail !== undefined ? { detail } : {}),
    ended: !open,
    needsHuman: progress.phase === "awaiting_approval",
  };
}

/** 줄 전체를 한 문장으로(보조기술·시험·좁은 표면). */
export function runStatusText(line: RunStatusLine): string {
  const chain = line.steps.map((step) => step.text).join(" → ");
  return line.detail === undefined ? chain : `${chain} · ${line.detail}`;
}

/**
 * 이 run의 영수증 줄을 메시지 아래에 남기는가 (#4020).
 *
 * 평소의 「받았어요 → 가져감 → 완료 · 48초 걸림」은 메시지마다 붙으면 소음이다. 진행은
 * 컴포저 위 「답하는 중」 한 줄이 말하고, 끝난 일은 답 메시지가 말한다. 그래서 대화
 * 타임라인의 본 줄에는 **사람이 알아야 하는 상태**만 남긴다.
 *
 *   남긴다  실패 · 시간 초과(신호 소실 포함) · 승인 대기 · 일시 정지 ·
 *           가져간 뒤 소식이 끊김(lease stale) · 깨우는 신호가 닿지 않음
 *   뺀다    대기 · 가져감 · 작업 중 · 완료 · 취소됨
 *
 * 취소됨을 뺀다: 취소는 사람이 직접 한 일이라 알릴 새 소식이 아니고, 중단 영수증이
 * 따로 있다. 진행을 따로 보는 곳(작업 패널·기록 시트)은 이 판정과 무관하게 그대로다.
 */
export function keepsRunReceipt(
  progress: AgentRunProgress,
  doorbell: DoorbellFact | null
): boolean {
  switch (progress.phase) {
    case "failed":
    case "timed_out":
    case "awaiting_approval":
    case "paused":
      return true;
    case "claimed":
      return progress.leaseState === "stale" || doorbell?.failed === true;
    case "queued":
      return doorbell?.failed === true;
    default:
      return false;
  }
}

/**
 * 메시지 id → 그 메시지가 일으킨 run들. 목록(타임라인)이 한 번 계산해 행에 넘긴다:
 * 행마다 스토어를 구독하면 아무 run이나 바뀔 때 화면의 모든 줄이 다시 그려진다.
 * 같은 메시지가 여러 에이전트를 불렀으면 먼저 생긴 run이 위다.
 */
export function runsByTriggerMessage(
  rows: readonly AgentRunProgress[]
): ReadonlyMap<string, readonly AgentRunProgress[]> {
  const out = new Map<string, AgentRunProgress[]>();
  for (const row of rows) {
    if (row.triggerMessageId === undefined) continue;
    const key = row.triggerMessageId.toLowerCase();
    const list = out.get(key);
    if (list === undefined) out.set(key, [row]);
    else list.push(row);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  }
  return out;
}

/**
 * 원장을 읽어 깨우는 신호를 확인할 가치가 있는 run인가: 아직 시작 전이다(대기·가져감).
 * 작업이 시작된 run의 단계는 `phase`만으로 말할 수 있고, 이미 읽은 원장은 표면의
 * 캐시가 들고 있다. 처음 본 때 이미 진행 중이던 run에는 「깨우는 신호」 단계를 짐작해
 * 넣지 않는다.
 */
export function wantsDoorbellFact(progress: Pick<AgentRunProgress, "phase">): boolean {
  return progress.phase === "queued" || progress.phase === "claimed";
}
