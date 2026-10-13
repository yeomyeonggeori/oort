import type {
  AgentRunPhase,
  AgentRunProgress,
} from "../../lib/api";
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

/** 서버가 쓴 닫힌 종료 코드 → 사람의 문장. 모르는 코드는 문장을 만들지 않는다. */
const END_REASON_TEXT: Record<string, string> = {
  approval_expired: "승인이 만료됐어요",
  unclaimed_expired: "아무도 가져가지 않아 끝냈어요",
  lease_abandoned: "가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요",
  agent_error: "에이전트가 오류로 끝냈어요",
  cancelled_by_member: "멤버가 취소했어요",
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
 *   running             진행 중
 *   awaiting_approval   승인 대기
 *   paused              일시 정지
 *   끝                  완료 / 실패 / 취소됨 / 시간 초과, 서버가 소식 끊김으로
 *                       끝냈으면 신호 소실
 */
export function runPhaseLabel(facts: ServerRunFacts): string {
  switch (facts.phase) {
    case "queued":
      return facts.queuePosition !== undefined
        ? `대기 ${facts.queuePosition}번째`
        : "대기 중";
    case "claimed":
      return "가져감";
    case "running":
      return "진행 중";
    case "awaiting_approval":
      return "승인 대기";
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
 *   queued   「미수령 n분 · 에이전트 앞에 m건」
 *   claimed  「n분 전에 가져감」, lease가 만료됐으면 「가져간 뒤 n분째 소식이 없어요」
 *   running  「마지막 보고 n분 전」
 *   끝       종료 사유 문장
 *
 * lease 만료는 「끊김」이 아니다. 에이전트는 돌아올 수 있으므로 「소식이 없어요」
 * 까지만 말한다(ADR-0200 D1).
 */
export function runPhaseDetail(
  facts: ServerRunFacts,
  nowMs: number
): string | undefined {
  switch (facts.phase) {
    case "queued": {
      const parts: string[] = [];
      const waited = elapsedSpan(facts.queuedAtMs, nowMs);
      if (waited !== undefined) parts.push(`미수령 ${waited}`);
      if (facts.aheadTotal !== undefined && facts.aheadTotal > 0) {
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
    case "running": {
      const span =
        facts.lastEventAtMs === undefined
          ? undefined
          : elapsedSpan(facts.lastEventAtMs, nowMs);
      return span === undefined ? undefined : `마지막 보고 ${span} 전`;
    }
    case "awaiting_approval":
    case "paused":
      return undefined;
    default:
      return endReasonText(facts.endReason);
  }
}
