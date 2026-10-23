import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { SCHEDULED_COPY, failureLines, type ErrorPlaceWord } from "./copy";
import { isScheduledFailureReason } from "./types";

// =============================================================================
// 서버 오류 → 사람이 읽는 문장 (UI 명세 3.3, ADR-0208 부록 A, #4237).
//
// 서버의 `error.message`는 영어이고 다시 쓰일 수 있다. 화면은 **상태와 `error.code`**로
// 문장을 고른다(기존 `replyFailureMessage`와 같은 방식). 코드는 `ApiError.code`로
// 도착한다(`lib/api`의 `authedRequest`가 버리지 않는다).
//
// 404가 둘이다:
//  - **목록**의 404는 「이 서버에는 예약이 없다」(구서버)이고 입구를 세우지 않는다
//    (`isScheduledAbsent`, 명세 0.6). 5xx·네트워크 오류는 없는 서버가 아니라 장애다.
//  - 고치기·지우기·지금 보내기의 404는 「그 예약을 찾을 수 없다」(남의 것·이미 취소됨)다.
// 그래서 요청 헬퍼는 404를 삼키지 않고 던지고, 목록 호출부만 `isScheduledAbsent`로 묻는다.
// =============================================================================

/**
 * 쓰기 연산. 고치기 계열은 PATCH 하나지만 문장이 갈린다(명세 3.3):
 * `edit`(글 고치기), `change`(시간 바꾸기), `rearm`(보내지 못한 행을 다시 걸기).
 */
export type ScheduledOp = "create" | "edit" | "change" | "rearm" | "delete" | "sendNow";

/** 이 서버에는 예약이 없다: 목록 요청의 404. **목록 호출에서만** 묻는다. */
export function isScheduledAbsent(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** 운영자가 예약을 껐다: 쓰기의 503 `scheduler_disabled`. 입구는 서되 흐리게 한다(명세 0.6). */
export function isSchedulerDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === "scheduler_disabled";
}

/** 오류 줄. `next`는 다음 행동 줄이 따로 있는 문장(503)만 갖는다. */
export interface ScheduledErrorLine {
  text: string;
  next?: string;
}

const TIME_OPS: readonly ScheduledOp[] = ["create", "edit", "change", "rearm"];

/**
 * 오류 한 건의 문장. `place`는 채널 또는 대화다(권한은 채널에 매인다).
 *
 * 응답을 받지 못한 오류(`NetworkError`)는 서버가 요청을 받았는지 모른다. 「하지 못했어요」라고
 * 단정하지 않고 「확인하지 못했어요」로 말한다(명세 0.5의 5번). 생성은 같은 `clientRequestId`로
 * 다시 누르면 안전하다.
 */
export function scheduledErrorLine(
  op: ScheduledOp,
  error: unknown,
  place: ErrorPlaceWord
): ScheduledErrorLine {
  const copy = SCHEDULED_COPY.errors;
  const generic = (): ScheduledErrorLine => ({
    text: op === "create" ? copy.otherCreate : copy.otherWrite,
  });

  if (error instanceof NetworkError) {
    switch (op) {
      case "create":
        return { text: copy.unknownCreate };
      case "edit":
      case "change":
      case "rearm":
        return { text: copy.unknownEdit };
      case "delete":
        return { text: copy.unknownDelete };
      case "sendNow":
        return { text: copy.unknownSendNow };
    }
  }
  if (!(error instanceof ApiError)) return generic();

  const { status, code } = error;
  if (status === 429) return { text: copy.rateLimited };

  if (status === 503 && code === "scheduler_disabled" && op !== "delete") {
    return {
      text: SCHEDULED_COPY.disabled.unavailable.reason,
      next: SCHEDULED_COPY.disabled.unavailable.next,
    };
  }

  if (status === 400) {
    if (code === "send_at_too_soon" && TIME_OPS.includes(op)) return { text: copy.tooSoon };
    if (code === "send_at_too_far" && TIME_OPS.includes(op)) return { text: copy.tooFar };
    if (code === "empty_message" && (op === "create" || op === "edit")) {
      return { text: copy.emptyMessage };
    }
    if (code === undefined && op === "create") return { text: copy.createBadRequest };
    return generic();
  }

  if (status === 403) {
    return op === "create" ? { text: copy.createForbidden(place) } : generic();
  }

  if (status === 404) {
    return op === "create" ? { text: copy.createNotFound } : { text: copy.rowNotFound };
  }

  if (status === 409) {
    if (code === "scheduled_already_sent") return { text: copy.alreadySent };
    if (code === "pending_limit_reached" && (op === "create" || op === "rearm")) {
      return { text: SCHEDULED_COPY.disabled.limit };
    }
    if (code === "attachment_reserved" && op === "create") {
      return { text: copy.attachmentReserved };
    }
    if (code === undefined && op === "create") return { text: copy.attachmentUnusable };
    if (code === "scheduled_too_late" && (op === "edit" || op === "change")) {
      return { text: SCHEDULED_COPY.error.tooLate };
    }
    if (code === "scheduled_busy") {
      if (op === "edit" || op === "change" || op === "rearm") return { text: copy.busyEdit };
      if (op === "delete" || op === "sendNow") return { text: copy.busyAct };
      return generic();
    }
    // 지금 보내기가 거절됐다: 코드가 행이 이제 갖는 실패 사유다(3.2의 이유 줄).
    if (op === "sendNow" && code !== undefined && isScheduledFailureReason(code)) {
      return { text: failureLines(code, place).reason };
    }
    return generic();
  }

  return generic();
}
