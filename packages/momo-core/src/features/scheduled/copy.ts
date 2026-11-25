import type { MessageKey } from "../../i18n/generated/messages";
import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
import { takesFinalForm } from "../../lib/koreanParticle";
import { REMINDER_UNKNOWN_CHANNEL_KEY } from "../reminders/model";
import type { ScheduledFailureReason } from "./types";

// =============================================================================
// 예약 메시지 문구표 (UI 명세 3절, ADR-0208 부록 B, #4237).
//
// 사전의 문장은 UI 명세의 표를 **그대로** 옮긴 것이다. 웹과 폰이 같은 상수를
// 쓴다(디자인 시스템 README 1절: 문장·토큰·코어 로직만 공유하고 뷰는 각자). 값을
// 바꿀 때는 명세를 먼저 고친다 — 시험(`copy.test.ts`)이 명세의 표를 문장 단위로
// 고정한다.
//
// - 해요체, 줄표 금지, 사과·느낌표·이모지 금지, 홍보 낱말 금지. 진행 낱말은
//   「명사 + 중」이다(`예약 중`, `저장 중`. `예약하는 중`은 `progress_word` 위반).
//   코어는 `design_preflight_core.mjs`가 hard-zero로 잰다.
// - 문장은 이 파일에 없다. 문구는 i18n 사전(`scheduled.*`, 공용 낱말은 `common.*`)에 있고 이 표는 그 **키**다
//   (#6058). 화면이 그릴 때 `formatMessage(키, 값)`로 지금 언어의 문장을 만든다. `{n}`·`{장소}`·`{시각}` 같은
//   자리는 사전의 ICU 인자(`{count}`·`{place}`·`{when}`)라서 값을 빠뜨리면 타입이 막는다.
// - 서버가 돌려주는 `error.message`는 영어라서 화면에 보이지 않는다. 상태와
//   `error.code`로 3.3의 문장을 고른다(`errors.ts`).
// - 오프라인일 때 입력창의 이유는 이 표의 키가 아니라 앱의 기존
//   `COMPOSER_OFFLINE_COPY`다(명세 0.4). 대화상자와 시트만 `dialog.offline`을 쓴다.
// =============================================================================

/**
 * 예약 화면이 그리는 문장의 키와 값. 이 칸의 키(`scheduled.*`)와 공용 낱말(`common.*`)만 담아, 화면의
 * `formatMessage(ref.key, ref.values as never)`가 전체 키 합집합을 풀지 않게 좁힌다.
 */
export type ScheduledRef = MessageRef<Extract<MessageKey, `scheduled.${string}` | `common.${string}`>>;

/** 값이 없는 문장의 키(위와 같은 범위). */
export type ScheduledPlainKey = Extract<PlainMessageKey, `scheduled.${string}` | `common.${string}`>;

/** `{장소}`: 채널은 `channel`, DM·그룹 DM은 `dm`, 스레드는 `thread`(명세 0.1). 사전의 `{place}` 선택 인자다. */
export type PlaceWord = "channel" | "dm" | "thread";

/** 실패 사유·오류 문장의 `{장소}`는 채널 또는 대화다(권한은 채널에 매인다, 명세 3.2). */
export type ErrorPlaceWord = "channel" | "dm";

/** 채널 종류와 스레드 여부로 `{장소}` 낱말을 고른다. */
export function placeWord(input: {
  kind: "public" | "private" | "dm" | undefined;
  thread?: boolean;
}): PlaceWord {
  if (input.thread === true) return "thread";
  return input.kind === "dm" ? "dm" : "channel";
}

/** 오류 문장용: 스레드도 그 채널·대화의 멤버십이므로 채널 또는 대화로 읽는다. */
export function errorPlaceWord(kind: "public" | "private" | "dm" | undefined): ErrorPlaceWord {
  return kind === "dm" ? "dm" : "channel";
}

/** 이름을 못 읽는 행(나간 비공개 채널 등)의 라벨. 리마인더와 같은 낱말을 쓴다(명세 0.1). */
export const SCHEDULED_UNKNOWN_CHANNEL_KEY = REMINDER_UNKNOWN_CHANNEL_KEY;

/** DM 행의 라벨 「{이름}과의 대화」. 과/와는 받침으로 가려 `josa`로 넘긴다(한국어 값만 쓴다, 명세 0.1). */
export function dmConversationLabel(name: string): MessageRef<"scheduled.dm.conversationLabel"> {
  return {
    key: "scheduled.dm.conversationLabel",
    values: { name, josa: takesFinalForm(name) ? "final" : "other" },
  } as MessageRef<"scheduled.dm.conversationLabel">;
}

export const SCHEDULED_COPY = {
  trigger: {
    label: "scheduled.trigger.label",
    hint: "scheduled.trigger.hint",
  },
  disabled: {
    empty: {
      reason: "scheduled.disabled.emptyReason",
    },
    quote: {
      reason: "scheduled.disabled.quoteReason",
      next: "scheduled.disabled.quoteNext",
    },
    command: {
      reason: "scheduled.disabled.commandReason",
      next: "scheduled.disabled.commandNext",
    },
    personalCall: {
      reason: "scheduled.disabled.personalCallReason",
      next: "scheduled.disabled.personalCallNext",
    },
    attachUploading: {
      reason: "scheduled.disabled.attachUploadingReason",
      next: "scheduled.disabled.attachUploadingNext",
    },
    attachFailed: {
      reason: "scheduled.disabled.attachFailedReason",
      nextRetry: "scheduled.disabled.attachFailedNextRetry",
      nextRemove: "scheduled.disabled.attachFailedNextRemove",
    },
    unavailable: {
      reason: "scheduled.disabled.unavailableReason",
      next: "scheduled.disabled.unavailableNext",
    },
    limit: "scheduled.disabled.limit",
  },
  secretKey: {
    lead: "scheduled.secretKey.lead",
  },
  menu: {
    custom: "scheduled.menu.custom",
    customDetail: "scheduled.menu.customDetail",
    zone: "scheduled.menu.zone",
    routingNote: "scheduled.menu.routingNote",
  },
  preset: {
    tomorrow: "scheduled.preset.tomorrow",
    nextMonday: "scheduled.preset.nextMonday",
  },
  dialog: {
    offline: "scheduled.dialog.offline",
    title: "scheduled.dialog.title",
    titleChange: "scheduled.dialog.titleChange",
    titleRearm: "scheduled.dialog.titleRearm",
    description: "scheduled.dialog.description",
    date: "scheduled.dialog.date",
    time: "scheduled.dialog.time",
    preview: "scheduled.dialog.preview",
    commit: "scheduled.dialog.commit",
    commitChange: "scheduled.dialog.commitChange",
    cancel: "common.action.cancel",
    saving: "scheduled.dialog.saving",
    errSoon: "scheduled.dialog.errSoon",
    errFar: "scheduled.dialog.errFar",
    errInvalid: "scheduled.dialog.errInvalid",
  },
  status: {
    scheduled: "scheduled.status.scheduled",
    sentNow: "scheduled.status.sentNow",
  },
  banner: {
    pending: "scheduled.banner.pending",
    failed: "scheduled.banner.failed",
    action: "scheduled.banner.action",
  },
  nav: {
    label: "scheduled.nav.label",
    badgeLabel: "scheduled.nav.badgeLabel",
  },
  list: {
    title: "scheduled.list.title",
    count: "scheduled.list.count",
    sectionFailed: "scheduled.list.sectionFailed",
    sectionPending: "scheduled.list.sectionPending",
    when: "scheduled.list.when",
    soon: "scheduled.list.soon",
    sending: "common.state.sending",
    attachments: "scheduled.list.attachments",
    filter: "scheduled.list.filter",
    filterAction: "scheduled.list.filterAction",
    copyFailed: {
      reason: "scheduled.list.copyFailedReason",
      next: "scheduled.list.copyFailedNext",
    },
  },
  action: {
    sendNow: "scheduled.action.sendNow",
    change: "scheduled.action.change",
    rearm: "scheduled.action.rearm",
    review: "scheduled.action.review",
    edit: "scheduled.action.edit",
    copy: "scheduled.action.copy",
    delete: "scheduled.action.delete",
    rowMenu: "scheduled.action.rowMenu",
  },
  lock: {
    reason: "scheduled.lock.reason",
  },
  error: {
    tooLate: "scheduled.error.tooLate",
  },
  review: {
    title: "scheduled.review.title",
    body: "scheduled.review.body",
    attachments: "scheduled.review.attachments",
    close: "common.action.close",
    bodyLabel: "scheduled.review.bodyLabel",
    when: "scheduled.review.when",
  },
  edit: {
    title: "scheduled.edit.title",
    attachNote: "scheduled.edit.attachNote",
    commit: "scheduled.edit.commit",
    saving: "common.state.saving",
  },
  delete: {
    title: "scheduled.delete.title",
    body: "scheduled.delete.body",
    confirm: "scheduled.delete.confirm",
    pending: "scheduled.delete.pending",
  },
  empty: {
    title: "scheduled.empty.title",
    bodyWeb: "scheduled.empty.bodyWeb",
    bodyPhone: "scheduled.empty.bodyPhone",
    action: "scheduled.empty.action",
  },
  load: {
    error: "scheduled.load.error",
    retry: "common.action.reload",
  },
  offline: {
    list: "scheduled.offline.list",
  },
  errors: {
    tooSoon: "scheduled.dialog.errSoon",
    tooFar: "scheduled.dialog.errFar",
    emptyMessage: "scheduled.errors.emptyMessage",
    createBadRequest: "scheduled.errors.createBadRequest",
    createForbidden: "scheduled.errors.createForbidden",
    createNotFound: "scheduled.errors.createNotFound",
    attachmentReserved: "scheduled.errors.attachmentReserved",
    attachmentUnusable: "scheduled.errors.attachmentUnusable",
    alreadySent: "scheduled.errors.alreadySent",
    busyEdit: "scheduled.errors.busyEdit",
    busyAct: "scheduled.errors.busyAct",
    rowNotFound: "scheduled.errors.rowNotFound",
    rateLimited: "scheduled.errors.rateLimited",
    unknownCreate: "scheduled.errors.unknownCreate",
    unknownEdit: "scheduled.errors.unknownEdit",
    unknownDelete: "scheduled.errors.unknownDelete",
    unknownSendNow: "scheduled.errors.unknownSendNow",
    otherCreate: "scheduled.errors.otherCreate",
    otherWrite: "scheduled.errors.otherWrite",
  },
} as const satisfies Record<string, unknown>;

/** 실패 사유 한 건의 두 줄(명세 3.2): 이유 줄과 다음 행동 줄. 화면이 `formatMessage(line.key, line.values)`로 그린다. */
export interface FailureLines {
  reason: ScheduledRef;
  next: ScheduledRef;
}

/**
 * 실패 사유 → 두 줄. `{장소}`는 채널 또는 대화다. 사유가 없거나 모르는 값이면
 * `not_allowed`와 같이 읽는다(`types.ts`의 `readFailureReason`과 같은 판단).
 */
export function failureLines(
  reason: ScheduledFailureReason | undefined,
  place: ErrorPlaceWord
): FailureLines {
  switch (reason) {
    case "sessions_ended":
      return {
        reason: { key: "scheduled.failure.sessionsEndedReason" },
        next: { key: "scheduled.failure.sessionsEndedNext" },
      };
    case "author_inactive":
      return {
        reason: { key: "scheduled.failure.authorInactiveReason" },
        next: { key: "scheduled.failure.authorInactiveNext" },
      };
    case "missed":
      return {
        reason: { key: "scheduled.failure.missedReason" },
        next: { key: "scheduled.failure.missedNext" },
      };
    case "send_error":
      return {
        reason: { key: "scheduled.failure.sendErrorReason" },
        next: { key: "scheduled.failure.sendErrorNext" },
      };
    case "not_member":
      return {
        reason: { key: "scheduled.failure.notMemberReason", values: { place } },
        next: { key: "scheduled.failure.notMemberNext", values: { place } },
      };
    case "root_unavailable":
      return {
        reason: { key: "scheduled.failure.rootUnavailableReason" },
        next: { key: "scheduled.failure.rootUnavailableNext", values: { place } },
      };
    case "attachment_unavailable":
      return {
        reason: { key: "scheduled.failure.attachmentUnavailableReason" },
        next: { key: "scheduled.failure.attachmentUnavailableNext" },
      };
    case "not_allowed":
    case undefined:
      return {
        reason: { key: "scheduled.failure.notAllowedReason", values: { place } },
        next: { key: "scheduled.failure.notAllowedNext" },
      };
  }
}
