import type { Message } from "../../lib/api";
import {
  COMPLETION_CHECK_SEVERITY,
  completionCheckCounts,
  completionReportCard,
  type CompletionCheckOutcome,
  type CompletionOutcome,
  type CompletionReportCard,
} from "../timeline/completionReportCard";

// =============================================================================
// 세션의 검증 상태 (UXC-C / 커서 웹 ADE 벤치마크 §3-C)
//
// 「이 세션은 검증됐는가」를 세션 표면이 한 칸으로 말할 수 있게 하는 판정이다.
// 새 어휘도 새 원장도 아니다 — 완료 리포트 카드가 이미 게이트 결과를 네 낱말과
// 네 톤으로 갈라 뒀고(`completionReportCard`), 여기서는 그 표를 **한 세션 단위로**
// 접기만 한다.
//
// ## 데이터 원천: 그 세션의 스레드에 실제로 남은 리포트
//
// 세션은 채널 카드 하나(`rootMessageId`)를 갖고 그 **스레드가 세션의 원장**이다 —
// 진행 내역이 거기 쌓이고, 발췌 공유도 거기로 쓴다. 그러므로 그 스레드에 남은
// `completion_report` 메시지는 링크를 지어내지 않고도 이 세션의 것임이 증명된다.
// 세션에서 에이전트 run 으로 가는 서버 경로는 없으므로(`WorkSessionDetail` 머리말)
// 채널 본문에 남은 리포트를 이 세션의 것이라 주장하지 않는다. 그런 리포트가 이
// 표면에 서야 한다면 그것은 새 read-model 이고, 표시 규칙이 아니라 별도 티켓이다.
//
// ## 없는 것을 이야기로 승격하지 않는다 (ADR-0132)
//
// 세 자리에서 **판정이 없다**(`null`)를 낸다. 「미검증」이라는 낱말은 어디에도
// 만들지 않는다 — 리포트가 없는 것은 검증에 실패한 것이 아니라 이 세션이 아직
// 아무 말도 하지 않은 것이다:
//
//   1. 스레드에 리포트가 하나도 없다.
//   2. 리포트는 있으나 게이트 표가 비었다. `completionOutcome([])` 은 「완료」이고,
//      그 낱말을 게이트 한 칸 없는 리포트 위에 세우면 화면이 하지 않은 검증을
//      통과라고 말한다.
//   3. 부르는 쪽이 스레드를 **다 읽지 못했다**(절단). 그때 없는 것은 정확히 가장
//      최근 리포트라, 접힌 판정은 지난 이야기다.
// =============================================================================

/** 세션 스레드에서 발견된 완료 리포트 하나. */
export interface SessionCompletionReport {
  card: CompletionReportCard;
  /** 채널 seq — 어느 리포트가 최신인가의 정본(`message.seq`). */
  seq: number;
  /** 서버 시각. seq 가 같을 때만 쓰이는 보조 순서. */
  atMs: number;
}

/**
 * 이 스레드 답글이 완료 리포트인가. 파싱은 코어 계약을 **그대로** 부르고
 * (`completionReportCard`) 여기서는 순서에 쓸 두 숫자만 얹는다.
 *
 * 지워진 메시지는 리포트가 아니다: 거둬들인 보고가 계속 세션의 상태를 주장하면,
 * 화면은 사람이 이미 취소한 말을 대신 하고 있게 된다.
 */
export function sessionCompletionReport(
  message: Message
): SessionCompletionReport | null {
  if (message.state === "deleted") return null;
  const card = completionReportCard(message.props);
  if (card === null) return null;
  return { card, seq: message.seq, atMs: message.hlcTs };
}

/** 세션 한 칸이 말하는 검증 상태. */
export interface SessionVerification {
  /** 카드 머리와 같은 판정 — 실패가 하나라도 있는가(`completionOutcome`). */
  outcome: CompletionOutcome;
  /** 결과별 게이트 수. 코어 집계 그대로(`completionCheckCounts`). */
  counts: Readonly<Record<CompletionCheckOutcome, number>>;
  /** 칩이 말할 한 칸: 표에서 **가장 나쁜** 결과. */
  lead: CompletionCheckOutcome;
  /** 그 결과의 게이트 수. */
  leadCount: number;
  /** 이 판정을 실은 리포트의 서버 시각. */
  atMs: number;
}

/**
 * 어휘 전체를 심각한 순으로. 순회 순서를 고정해 두는 이유는 `Object.keys` 가
 * 계약이 아니기 때문이다 — 순서가 우연이면 접기의 답도 우연이 된다.
 */
const COMPLETION_CHECK_ORDER: readonly CompletionCheckOutcome[] = [
  "fail",
  "unknown",
  "pending",
  "pass",
  "skip",
];

/**
 * 이 세션이 지금 말하는 검증 상태. 여러 리포트가 남았으면 **가장 최근 것**이다
 * (세션은 여러 번 끝날 수 있고, 두 번째 리포트는 첫 번째를 갱신한다).
 *
 * 접는 방향은 카드의 그것과 같다: 한 칸만 그릴 수 있으면 **가장 나쁜 칸**을
 * 그린다(`COMPLETION_CHECK_SEVERITY` — 웹 표의 겹친 셀이 실패를 앞에 세우는 그
 * 순위 그대로). 실패는 어떤 접기로도 사라지지 않는다는 것이 그 순위의 계약이고,
 * 한 칸으로 접을 때야말로 그 계약이 필요하다.
 */
export function latestSessionVerification(
  reports: readonly SessionCompletionReport[]
): SessionVerification | null {
  let newest: SessionCompletionReport | null = null;
  for (const report of reports) {
    if (
      newest === null ||
      report.seq > newest.seq ||
      (report.seq === newest.seq && report.atMs > newest.atMs)
    ) {
      newest = report;
    }
  }
  if (newest === null) return null;
  const counts = completionCheckCounts(newest.card.gates);
  let lead: CompletionCheckOutcome | null = null;
  for (const outcome of COMPLETION_CHECK_ORDER) {
    if (counts[outcome] === 0) continue;
    if (
      lead === null ||
      COMPLETION_CHECK_SEVERITY[outcome] < COMPLETION_CHECK_SEVERITY[lead]
    ) {
      lead = outcome;
    }
  }
  // 게이트 표가 빈 리포트는 검증에 대해 아무 말도 하지 않았다(머리말 2).
  if (lead === null) return null;
  return {
    outcome: newest.card.outcome,
    counts,
    lead,
    leadCount: counts[lead],
    atMs: newest.atMs,
  };
}

