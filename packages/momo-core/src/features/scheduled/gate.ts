import { isRetryableIssue, sendBlockReason, type AttachmentDraft } from "../attachments/model";
import { containsSecretKey } from "../chat/secretKey";
import { SCHEDULED_COPY } from "./copy";
import { SCHEDULED_PENDING_LIMIT } from "./types";

// =============================================================================
// 예약 단추의 보내기 전 판정 (ADR-0208 D16, UI 명세 0.4, #4237).
//
// **예약은 보내기와 같은 보내기 전 판정을 같은 함수로 거친다.** 보내기 단추를 막는 일(첨부가 올라가는
// 중이거나 실패했다·보낼 글이 없다)과 글을 막는 일(키 모양)은 보내기 쪽의 판정 함수
// (`sendBlockReason`·`containsSecretKey`)가 한다. 예약 경로가 그 판정을 건너뛰거나 베끼면 보내기에서는
// 막히는 글이 예약으로는 나가는 길이 생기고, 서버는 첨부 한 건의 거절에 메시지째 롤백한다.
//
// 이 파일은 그 판정을 부르고 **사유를 하나로 고른다**. 한 번에 한 가지, 아래 표의 순서대로 위가 먼저다
// (명세 0.4 표와 같다). 입력은 호출하는 입력창이 이미 아는 사실이고, 이 함수는 시계도 플랫폼도 읽지
// 않는다.
// =============================================================================

/** 지금 글과 첨부 트레이만 본 준비 상태. 보내기의 `canSend`와 예약이 같은 판정을 쓰는 자리다. */
export type ContentReadiness = "ready" | "empty" | "attachUploading" | "attachFailed";

/**
 * 첨부가 올라가는 중이면 `attachUploading`, 실패한 첨부가 있으면 `attachFailed`(서버가 첨부 한 건의
 * 거절에 메시지째 롤백하므로 본문이 있어도 못 보낸다), 글도 첨부도 없으면 `empty`, 아니면 `ready`다.
 * 글이 비어도 첨부가 올라가 있으면 보낼 수 있다(파일만 보내는 메시지).
 */
export function contentReadiness(
  text: string,
  drafts: readonly AttachmentDraft[]
): ContentReadiness {
  const block = sendBlockReason([...drafts]);
  if (block === "uploading") return "attachUploading";
  if (block === "failed") return "attachFailed";
  return text.trim().length > 0 || drafts.length > 0 ? "ready" : "empty";
}

/** 예약 단추를 막는 사유. 한 번에 하나이고 이 순서대로 위가 먼저다. */
export type ScheduleBlock =
  | "offline"
  | "unavailable"
  | "command"
  | "personalCall"
  | "quote"
  | "attachUploading"
  | "attachFailed"
  | "empty";

export interface ScheduleGateInput {
  /**
   * 이 서버가 예약을 하는가. 첫 목록 요청이 404이면 `false`이고 입구를 세션 동안 세우지 않는다
   * (`isScheduledAbsent`). 5xx·네트워크 오류는 장애라 `true`로 둔다.
   */
  offered: boolean;
  offline: boolean;
  /** 앞선 쓰기가 503 `scheduler_disabled`였다(`isSchedulerDisabled`). 입구는 서되 흐리다. */
  schedulerDisabled: boolean;
  text: string;
  attachments: readonly AttachmentDraft[];
  /** `/` 명령을 쓰는 중이다(웹은 `parseSlashCommand`, 폰은 명령 파싱 또는 슬래시 목록). */
  commandDraft: boolean;
  /** 지금 보내면 내 개인 에이전트 호출이 되는 글이다(`personalCallTarget` + 호출부의 조건). */
  personalCall: boolean;
  quoting: boolean;
  /** 내 대기 예약 수(한도 판정). */
  pendingCount: number;
  /** 모델 지정(`routing`)이 켜져 있다. 예약은 되지만 모델 지정은 담기지 않는다. */
  routingSet: boolean;
}

/** 이유 줄(한 문장, 입력창의 한 줄 슬롯)과 다음 행동 줄(`title`·낭독). */
export interface ScheduleReasonLines {
  reason: string;
  next: string | null;
}

export interface ScheduleGate {
  /** `hidden`이면 단추를 세우지 않는다(이 서버에는 예약이 없다). */
  entry: "hidden" | "shown";
  /** 막는 사유. 없으면 메뉴가 열린다. */
  block: ScheduleBlock | null;
  /**
   * 막는 사유의 두 줄. **오프라인은 `null`이다**: 입력창의 이유는 앱이 이미 세운 오프라인 줄이 말하고
   * 예약용 문장을 따로 만들지 않는다(톤이 다른 두 줄이 나란히 서지 않게). 대화상자와 시트는
   * `SCHEDULED_COPY.dialog.offline`을 쓴다.
   */
  lines: ScheduleReasonLines | null;
  /** 대기 50개. 메뉴는 열리고 항목이 흐리며 한도 문장이 메뉴 맨 위에 선다. */
  limitReached: boolean;
  /** 글이 키처럼 보인다. 단추는 켜져 있고, 고르면 기존 키 차단 줄이 선다(첫 문장만 `secretKey.lead`). */
  secretKey: boolean;
  /** 메뉴 안내 줄 「모델 지정은 예약에 담기지 않아요」를 보인다. */
  routingNote: boolean;
}

/** 첨부 실패의 다음 행동 줄: 다시 올릴 수 있는 실패가 있으면 「다시 올리거나 지우면」, 없으면 「지우면」. */
function attachFailedNext(drafts: readonly AttachmentDraft[]): string {
  const retryable = drafts.some(
    (draft) => draft.status === "failed" && draft.issue !== undefined && isRetryableIssue(draft.issue)
  );
  return retryable
    ? SCHEDULED_COPY.disabled.attachFailed.nextRetry
    : SCHEDULED_COPY.disabled.attachFailed.nextRemove;
}

function linesFor(block: ScheduleBlock, drafts: readonly AttachmentDraft[]): ScheduleReasonLines | null {
  const copy = SCHEDULED_COPY.disabled;
  switch (block) {
    case "offline":
      return null;
    case "unavailable":
      return copy.unavailable;
    case "command":
      return copy.command;
    case "personalCall":
      return copy.personalCall;
    case "quote":
      return copy.quote;
    case "attachUploading":
      return copy.attachUploading;
    case "attachFailed":
      return { reason: copy.attachFailed.reason, next: attachFailedNext(drafts) };
    case "empty":
      return { reason: copy.empty.reason, next: null };
  }
}

/**
 * 예약 단추의 판정. 사유의 순서는 명세 0.4 표와 같다:
 * 오프라인 → 서버가 예약을 껐다 → 명령 → 개인 에이전트 호출 → 인용 → 첨부 올리는 중 → 첨부 실패 → 보낼 내용 없음.
 * 한도(50)와 키 글은 단추를 막지 않는 사유라 따로 둔다.
 */
export function scheduleGate(input: ScheduleGateInput): ScheduleGate {
  if (!input.offered) {
    return {
      entry: "hidden",
      block: null,
      lines: null,
      limitReached: false,
      secretKey: false,
      routingNote: false,
    };
  }
  const readiness = contentReadiness(input.text, input.attachments);
  let block: ScheduleBlock | null = null;
  if (input.offline) block = "offline";
  else if (input.schedulerDisabled) block = "unavailable";
  else if (input.commandDraft) block = "command";
  else if (input.personalCall) block = "personalCall";
  else if (input.quoting) block = "quote";
  else if (readiness === "attachUploading") block = "attachUploading";
  else if (readiness === "attachFailed") block = "attachFailed";
  else if (readiness === "empty") block = "empty";
  return {
    entry: "shown",
    block,
    lines: block === null ? null : linesFor(block, input.attachments),
    limitReached: input.pendingCount >= SCHEDULED_PENDING_LIMIT,
    secretKey: containsSecretKey(input.text),
    routingNote: input.routingSet,
  };
}

/**
 * `title`·`aria-describedby`에 싣는 문장 「이유. 다음 행동.」. 문장이 둘이면 각 문장 끝에 마침표를 달고
 * 하나면 달지 않는다(명세 0.1). 이유가 없으면(오프라인) `null`이다.
 */
export function scheduleBlockTitle(lines: ScheduleReasonLines | null): string | null {
  if (lines === null) return null;
  return lines.next === null ? lines.reason : `${lines.reason}. ${lines.next}.`;
}
