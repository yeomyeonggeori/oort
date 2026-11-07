import { ApiError } from "../../lib/api";
import type { RestOutcome } from "../../lib/http";
import type { PendingMessage } from "../timeline/model";
import { bundleMayPost } from "../expressions/sendBundle";
import { judgeAutoResend } from "./autoResend";
import { CONNECTION_KEYS as K, type ConnectionPlainKey } from "./copyKeys";
import { causeOfFailure } from "./failure";

// =============================================================================
// 보내지 못한 글의 장부 (#5221, #5201 S-C, 결정 ⑤).
//
// 실패한 전송 행(`PendingMessage`, 폰과 나눠 쓴다)은 건드리지 않고, 행 곁에 **실패의 기록**을 둔다: 어떤
// 실패였나(원인 한 줄), 처음 실패한 때, 저절로 다시 보낸 횟수. 순수하다: 시계는 인자이고 저장·타이머가
// 없다. 언제 부르는지(연결이 돌아왔다는 신호)는 화면 훅이 정한다.
//
// 자동 재전송의 판정(어떤 실패를, 몇 번, 얼마 동안)은 S-A의 `judgeAutoResend` 하나다. 이 파일은 그것을
// 부르기만 하고 상한 숫자를 다시 적지 않는다. 손으로 다시 보내는 것은 상한에 세지 않고 상한을 되돌리지도
// 않는다: 3회·5분은 **자동**에 대한 상한이고, 그 뒤는 사람이 정한다.
// =============================================================================

/**
 * 원인 한 줄의 종류.
 *   offline   기기가 꺼져 있을 때 응답이 없었다.
 *   server    응답이 없었거나 길 위의 장비가 낸 5xx다(서버에 닿지 못함).
 *   rejected  서버가 직접 답하고 거절했다. 자동으로 다시 보내지 않는다.
 * 어느 것도 아니면(알 수 없는 오류) `null`이고 화면은 원인 없이 「전송 실패」만 말한다.
 */
export type SendFailureKind = "offline" | "server" | "rejected";

export function sendFailureKind(failure: unknown, deviceOnline: boolean | null): SendFailureKind | null {
  const cause = causeOfFailure(failure, deviceOnline);
  if (cause === "deviceOffline") return "offline";
  if (cause === "serverUnreachable") return "server";
  return failure instanceof ApiError ? "rejected" : null;
}

/** 원인 한 줄의 사전 키. 문장 조각을 잇지 않고 종류마다 완결된 문장이다. */
export function sendFailureReasonKey(kind: SendFailureKind): ConnectionPlainKey {
  switch (kind) {
    case "offline":
      return K.sendReasonOffline;
    case "server":
      return K.sendReasonServer;
    case "rejected":
      return K.sendReasonRejected;
  }
}

export interface SendFailureRecord {
  /** 마지막 시도가 던진 것. 자동 재전송 판정이 종류를 읽는다. */
  readonly failure: unknown;
  readonly kind: SendFailureKind | null;
  /** 이 글이 처음 보내지 못한 때(epoch ms). 다시 실패해도 바뀌지 않는다. */
  readonly firstFailedAt: number;
  /** 이 글을 저절로 다시 보낸 횟수(손으로 보낸 것은 세지 않는다). */
  readonly autoAttempts: number;
}

/** 시도 하나가 실패로 끝났다. `automatic`이면 자동 재전송이 한 번 더 쓰인 것이다. */
export function recordSendFailure(
  previous: SendFailureRecord | undefined,
  failure: unknown,
  deviceOnline: boolean | null,
  now: number,
  automatic: boolean
): SendFailureRecord {
  return {
    failure,
    kind: sendFailureKind(failure, deviceOnline),
    firstFailedAt: previous?.firstFailedAt ?? now,
    autoAttempts: (previous?.autoAttempts ?? 0) + (automatic ? 1 : 0),
  };
}

/**
 * 지금 저절로 다시 보낼 행의 열쇠, 보낸 순서대로. 실패(`failed`)한 행 중 기록이 있고 판정이 「보낸다」인 것만이다.
 * 기록이 없는 행(새로고침 뒤 되살린 행)은 자동 대상이 아니다: 처음 실패한 때를 몰라 5분을 셀 수 없다.
 */
export function pickAutoResends(
  rows: readonly Pick<PendingMessage, "clientMsgId" | "status" | "after">[],
  records: ReadonlyMap<string, SendFailureRecord>,
  now: number
): string[] {
  const picked: string[] = [];
  for (const row of rows) {
    if (row.status !== "failed") continue;
    // 이모티콘과 글 묶음의 둘째는 앞 메시지가 확정되기 전에는 고르지 않는다(#5453): 앞이 자동 재전송 상한에 닿았어도 뒤가 앞지르지 않는다.
    if (!bundleMayPost(row, rows)) continue;
    const record = records.get(row.clientMsgId);
    if (record === undefined) continue;
    const verdict = judgeAutoResend({
      failure: record.failure,
      attempts: record.autoAttempts,
      firstFailedAt: record.firstFailedAt,
      now,
    });
    if (verdict.resend) picked.push(row.clientMsgId);
  }
  return picked;
}

/**
 * 지금 이 행은 못 보낸 행인가 / 보내는 중인가. 화면 훅이 상태 낱말을 직접 적지 않게 한다(웹 직접 문구 장부는 낱말
 * 하나짜리 문자열도 문구로 센다. 판정은 코어에 한 벌).
 */
export function isFailedRow(row: Pick<PendingMessage, "status">): boolean {
  return row.status === "failed";
}

export function isSendingRow(row: Pick<PendingMessage, "status">): boolean {
  return row.status === "sending";
}

/**
 * 「모두 다시 보내기」가 이 실패 뒤에도 다음 글로 이어 가나. 서버가 직접 거절한 글이면 이어 간다(서버는 닿았고 다음 글은
 * 받을 수 있다). 네트워크로 또 실패했거나 이유를 모르면 멈춘다: 뒤의 글이 앞의 글을 앞지르지 않게 한다.
 */
export function resendAllContinuesAfter(record: SendFailureRecord | undefined): boolean {
  return record?.kind === "rejected";
}

/**
 * 「연결이 돌아왔다」는 신호 하나: 서버가 **답했다**(응답이 왔고 5xx가 아니다). 5xx 응답이나 응답 없음은 아니다.
 * S-A 모델이 「서버에 닿지 못함」을 풀 때 보는 사실과 같다.
 */
export function isServerAnswer(outcome: RestOutcome): boolean {
  return outcome.kind === "response" && outcome.status < 500;
}

/** 연결이 돌아왔다는 브라우저 사건과, 페이지를 떠나는 사건의 이름. 화면 훅이 구독한다. */
export const BROWSER_ONLINE_EVENT = "online";
export const PAGE_LEAVE_EVENT = "pagehide";
