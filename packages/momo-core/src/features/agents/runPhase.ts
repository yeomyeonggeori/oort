import type {
  AgentRunPhase,
  AgentRunProgress,
} from "../../lib/api";
import { ongoingSpan, runTookText, runWorkingText } from "./runDuration";
import type {
  AgentTurnState,
  AgentWorkingSignal,
  ServerRunFacts,
} from "./workingSignal";

// =============================================================================
// runPhase: 서버가 파생해 내려준 run 상태(ADR-0200 D1)를 사람의 낱말로 옮기는
// 순수 함수들. 두 클라이언트(웹·폰)와 모든 표면(사이드바 알약, 컴포저 활동 줄,
// 작업 패널 머리)이 같은 말을 하도록 한 곳에 둔다.
//
// 이 모듈은 아무것도 추정하지 않는다. 입력이 서버의 `phase`·`leaseState`·
// `endReason`이고, 출력은 그것의 번역이다. 그래서 「신호 소실」이라는 낱말은
// **서버가 `lease_abandoned`로 끝냈다고 알릴 때만** 나온다. 이전에는 클라이언트
// 시계(`now − lastActivity > 90s`)가 그 낱말을 정했고, 에이전트가 11분 뒤에
// 정상적으로 가져가는 run을 55초에 소실로 그렸다.
//
// 상태 어휘(성재 결재, ADR-0200): 대기 n번째 / 가져감 / 진행 단계 / 승인 대기 /
// 끝(사유). 「승인 대기」는 #3751이 카드·알약에 이미 쓴 낱말 그대로다.
// =============================================================================

/** 아직 끝나지 않은 phase. 끝난 run은 신호를 세우지 않는다. */
export function isOpenRunPhase(phase: AgentRunPhase): boolean {
  return (
    phase === "queued" ||
    phase === "claimed" ||
    phase === "running" ||
    phase === "awaiting_approval" ||
    phase === "paused"
  );
}

/** 열린 phase를 턴 상태로. 끝난 phase는 null. */
export function turnStateOfPhase(phase: AgentRunPhase): AgentTurnState | null {
  switch (phase) {
    case "queued":
    case "claimed":
      return "queued";
    case "running":
      return "working";
    case "awaiting_approval":
    case "paused":
      return "awaiting_approval";
    default:
      return null;
  }
}

/** 서버 응답 한 줄에서 표면이 읽는 사실만 뽑는다. */
export function serverFactsOf(progress: AgentRunProgress): ServerRunFacts {
  return {
    phase: progress.phase,
    leaseState: progress.leaseState,
    queuedAtMs: progress.createdAtMs,
    ...(progress.queuePosition !== undefined
      ? { queuePosition: progress.queuePosition }
      : {}),
    ...(progress.aheadTotal !== undefined ? { aheadTotal: progress.aheadTotal } : {}),
    ...(progress.claimedAtMs !== undefined ? { claimedAtMs: progress.claimedAtMs } : {}),
    ...(progress.latestStage !== undefined ? { latestStage: progress.latestStage } : {}),
    ...(progress.lastEventAtMs !== undefined
      ? { lastEventAtMs: progress.lastEventAtMs }
      : {}),
    ...(progress.approvalId !== undefined ? { approvalId: progress.approvalId } : {}),
    ...(progress.approvalExpiresAtMs !== undefined
      ? { approvalExpiresAtMs: progress.approvalExpiresAtMs }
      : {}),
    ...(progress.endReason !== undefined ? { endReason: progress.endReason } : {}),
    ...(progress.startedAtMs !== undefined ? { startedAtMs: progress.startedAtMs } : {}),
    ...(progress.finishedAtMs !== undefined
      ? { finishedAtMs: progress.finishedAtMs }
      : {}),
    ...(progress.system === true ? { system: true as const } : {}),
  };
}

/**
 * 서버 판정 한 줄을 열린 턴 신호로. 끝난 run은 null이다.
 *
 * `lastActivityAtMs`는 서버가 마지막으로 알려 준 시각이다. 정렬과 병합의 기준일
 * 뿐 만료 기준이 아니다(`isStaleSignal`은 `server`가 있으면 시계를 보지 않는다).
 * `startedAtMs`는 **진행이 실제로 시작된 시각**만 쓴다. 대기한 시간을 작업 중
 * 시계로 세지 않는다.
 */
export function signalFromProgress(
  progress: AgentRunProgress
): AgentWorkingSignal | null {
  const state = turnStateOfPhase(progress.phase);
  if (state === null) return null;
  const facts = serverFactsOf(progress);
  const headline =
    state === "working" && progress.latestStage !== undefined
      ? progress.latestStage.trim()
      : "";
  return {
    memberId: progress.agentMemberId,
    channelId: progress.channelId,
    state,
    source: "run",
    runId: progress.id,
    ...(progress.startedAtMs !== undefined && state === "working"
      ? { startedAtMs: progress.startedAtMs }
      : {}),
    headlines: headline === "" ? [] : [headline],
    lastActivityAtMs:
      progress.lastEventAtMs ?? progress.claimedAtMs ?? progress.updatedAtMs,
    server: facts,
  };
}

// ---- 낱말 ------------------------------------------------------------------

/**
 * 경과를 「n분」으로. 1분 미만이면 undefined다: 「0분」이나 「방금째」 같은 숫자를
 * 지어내지 않고, 부르는 쪽이 그 문장 조각을 통째로 뺀다.
 */
export function elapsedSpan(sinceMs: number, nowMs: number): string | undefined {
  const minutes = Math.floor(Math.max(0, nowMs - sinceMs) / 60_000);
  if (minutes < 1) return undefined;
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

/** 요청 고리의 낱말 정본. 칩·카드·인박스가 그대로 읽어요. */
export const REQUEST_WORD = {
  thinking: "생각 중",
  approval: "승인 필요",
  executing: "실행 중",
  done: "끝",
  declined: "거부",
  expired: "만료",
  failed: "실패",
  cancelled: "취소",
} as const;

export const APPROVAL_EXPIRED_SENTENCE = "승인을 기다리다 만료됐어요";

export function approvalEndState(code: string | undefined): "declined" | "expired" | null {
  if (code === "approval_rejected") return "declined";
  if (code === "approval_expired") return "expired";
  return null;
}

/** 서버가 쓴 닫힌 종료 코드 → 사람의 문장. 모르는 코드는 문장을 만들지 않는다. */
const END_REASON_TEXT: Record<string, string> = {
  approval_expired: APPROVAL_EXPIRED_SENTENCE,
  approval_rejected: "거부됐어요",
  unclaimed_expired: "아무도 가져가지 않아 끝냈어요",
  // ADR-0200 증보 3 E4(#4284): 초인종이 닿았는데 가져가지 않아 30분 뒤 서버가 끝낸 run.
  woken_not_collected: "깨웠지만 가져가지 않아 끝냈어요",
  lease_abandoned: "가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요",
  agent_error: "에이전트가 오류로 끝냈어요",
  cancelled_by_member: "멤버가 취소했어요",
  // 서버의 사람 중단 경로가 쓰는 코드(`routes/agent_runs.rs` CANCEL_ERROR_CODE).
  human_cancelled: "사람이 중단했어요",
};

/** 종료 사유 문장. 모르는 코드(서버가 클라보다 앞서감)는 undefined다. */
export function endReasonText(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return END_REASON_TEXT[code];
}

/** 서버가 정말로 「소식 끊김」이라고 알렸는가. 「신호 소실」의 유일한 근거다. */
export function isSignalLostByServer(facts: ServerRunFacts): boolean {
  return facts.endReason === "lease_abandoned";
}

/**
 * 한 낱말 라벨. 알약·헤더 칩이 이 문자열을 그대로 쓴다.
 *
 *   queued              대기 n번째 (순번이 없으면 대기 중)
 *   claimed             가져감
 *   running             작업 중
 *   awaiting_approval   승인 대기
 *   paused              일시 정지
 *   끝                  완료 / 실패 / 취소됨 / 시간 초과, 서버가 소식 끊김으로
 *                       끝냈으면 신호 소실
 */
export function runPhaseLabel(facts: ServerRunFacts): string {
  const approvalEnd = !isOpenRunPhase(facts.phase) ? approvalEndState(facts.endReason) : null;
  if (approvalEnd !== null) return REQUEST_WORD[approvalEnd];
  switch (facts.phase) {
    case "queued":
      return facts.queuePosition !== undefined
        ? `대기 ${facts.queuePosition}번째`
        : "대기 중";
    case "claimed":
      return "가져감";
    case "running":
      // 사이드바 알약·컴포저 줄이 이미 쓰는 「작업 중」과 같은 낱말이다. 같은
      // 상태를 표면마다 다른 낱말로 부르면 사람이 둘을 다른 상태로 읽는다
      // (design-review U1 M-3). 에이전트가 보고한 단계는 근거 줄이 말한다.
      return "작업 중";
    case "awaiting_approval":
      return REQUEST_WORD.approval;
    case "paused":
      return "일시 정지";
    case "succeeded":
      return "완료";
    case "failed":
      return "실패";
    case "cancelled":
      return "취소됨";
    case "timed_out":
      return isSignalLostByServer(facts) ? "신호 소실" : "시간 초과";
  }
}

/**
 * 라벨 옆에 붙는 한 줄(근거). 서버가 알려 준 사실만 쓴다.
 *
 *   queued   「n초째 기다려요 · 에이전트 앞에 m건」(초부터 센다)
 *   claimed  「n분 전에 가져감」, lease가 만료됐으면 「가져간 뒤 n분째 소식이 없어요」
 *   running  「12분째 · 마지막 보고 1분 전」(`runDuration.runWorkingText`)
 *   끝       「3분 12초 걸림」 + 종료 사유 문장(`runDuration.runTookText`)
 *
 * lease 만료는 「끊김」이 아니다. 에이전트는 돌아올 수 있으므로 「소식이 없어요」
 * 까지만 말한다(ADR-0200 D1).
 */
export function runPhaseDetail(
  facts: ServerRunFacts,
  nowMs: number,
  options: { omitAhead?: boolean } = {}
): string | undefined {
  switch (facts.phase) {
    case "queued": {
      const parts: string[] = [];
      // 초부터 말한다(#3824): 보낸 지 10초 된 요청에 아무 말도 없으면 사람은 요청이
      // 닿았는지부터 의심한다.
      // 1초가 안 됐으면 「1초 미만째」가 아니라 「방금 들어왔어요」다.
      const waited = ongoingSpan(nowMs - facts.queuedAtMs);
      parts.push(waited === undefined ? "방금 들어왔어요" : `${waited}째 기다려요`);
      if (
        options.omitAhead !== true &&
        facts.aheadTotal !== undefined &&
        facts.aheadTotal > 0
      ) {
        parts.push(`에이전트 앞에 ${facts.aheadTotal}건`);
      }
      return parts.length === 0 ? undefined : parts.join(" · ");
    }
    case "claimed": {
      const since = facts.lastEventAtMs ?? facts.claimedAtMs;
      if (facts.leaseState === "stale") {
        const span = since === undefined ? undefined : elapsedSpan(since, nowMs);
        return span === undefined
          ? "가져간 뒤 소식이 없어요"
          : `가져간 뒤 ${span}째 소식이 없어요`;
      }
      const span =
        facts.claimedAtMs === undefined
          ? undefined
          : elapsedSpan(facts.claimedAtMs, nowMs);
      return span === undefined ? undefined : `${span} 전에 가져감`;
    }
    case "running":
      // 「12분째 · 마지막 보고 1분 전」(#3824). 모르는 시각은 「모름」이다.
      return runWorkingText(facts, nowMs);
    case "awaiting_approval":
    case "paused":
      return undefined;
    default: {
      // 「3분 12초 걸림 · 멤버가 취소했어요」. 사유는 닫힌 코드일 때만 붙는다.
      const reason = endReasonText(facts.endReason);
      const took = runTookText(facts);
      return reason === undefined ? took : `${took} · ${reason}`;
    }
  }
}
