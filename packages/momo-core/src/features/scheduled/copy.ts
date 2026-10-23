import { particleFor } from "../../lib/koreanParticle";
import { REMINDER_UNKNOWN_CHANNEL_LABEL } from "../reminders/model";
import type { ScheduledFailureReason } from "./types";

// =============================================================================
// 예약 메시지 문구표 (UI 명세 3절, ADR-0208 부록 B, #4237).
//
// 이 파일의 문장은 UI 명세의 표를 **그대로** 옮긴 것이다. 웹과 폰이 같은 상수를
// 쓴다(디자인 시스템 README 1절: 문장·토큰·코어 로직만 공유하고 뷰는 각자). 값을
// 바꿀 때는 명세를 먼저 고친다 — 시험(`copy.test.ts`)이 명세의 표를 문장 단위로
// 고정한다.
//
// - 해요체, 줄표 금지, 사과·느낌표·이모지 금지, 홍보 낱말 금지. 진행 낱말은
//   「명사 + 중」이다(`예약 중`, `저장 중`. `예약하는 중`은 `progress_word` 위반).
//   코어는 `design_preflight_core.mjs`가 hard-zero로 잰다.
// - `{n}`·`{장소}`·`{시각}`은 템플릿 문자열을 내보내지 않고 함수로 둔다. 호출하는
//   쪽이 자리표시를 치환하다가 빠뜨리는 길을 없앤다.
// - 서버가 돌려주는 `error.message`는 영어라서 화면에 보이지 않는다. 상태와
//   `error.code`로 3.3의 문장을 고른다(`errors.ts`).
// - 오프라인일 때 입력창의 이유는 이 표의 키가 아니라 앱의 기존
//   `COMPOSER_OFFLINE_COPY`다(명세 0.4). 대화상자와 시트만 `dialog.offline`을 쓴다.
// =============================================================================

/** `{장소}`: 채널은 「채널」, DM·그룹 DM은 「대화」, 스레드는 「스레드」(명세 0.1). */
export type PlaceWord = "채널" | "대화" | "스레드";

/** 실패 사유·오류 문장의 `{장소}`는 채널 또는 대화다(권한은 채널에 매인다, 명세 3.2). */
export type ErrorPlaceWord = "채널" | "대화";

/** 채널 종류와 스레드 여부로 `{장소}` 낱말을 고른다. */
export function placeWord(input: {
  kind: "public" | "private" | "dm" | undefined;
  thread?: boolean;
}): PlaceWord {
  if (input.thread === true) return "스레드";
  return input.kind === "dm" ? "대화" : "채널";
}

/** 오류 문장용: 스레드도 그 채널·대화의 멤버십이므로 채널 또는 대화로 읽는다. */
export function errorPlaceWord(kind: "public" | "private" | "dm" | undefined): ErrorPlaceWord {
  return kind === "dm" ? "대화" : "채널";
}

/** 이름을 못 읽는 행(나간 비공개 채널 등)의 라벨. 리마인더와 같은 낱말을 쓴다(명세 0.1). */
export const SCHEDULED_UNKNOWN_CHANNEL_LABEL = REMINDER_UNKNOWN_CHANNEL_LABEL;

/** DM 행의 라벨 「{이름}과의 대화」. 조사는 코어 `koreanParticle`이 고른다(명세 0.1). */
export function dmConversationLabel(name: string): string {
  return `${name}${particleFor(name, "with")}의 대화`;
}

export const SCHEDULED_COPY = {
  trigger: {
    label: "예약해서 보내기",
    /** 폰: 길게 누르기 힌트. 막힌 이유가 있으면 이 문장으로 덮어쓰지 않는다(명세 2.2). */
    hint: "길게 눌러 예약",
  },

  /** 비활성 사유(명세 0.4). 이유 줄은 입력창의 한 줄에, 다음 행동 줄은 `title`·낭독에 실린다. */
  disabled: {
    empty: { reason: "보낼 내용을 쓰면 예약할 수 있어요" },
    quote: {
      reason: "인용 답장은 예약할 수 없어요",
      next: "인용을 지우면 예약할 수 있어요",
    },
    command: {
      reason: "명령은 예약할 수 없어요",
      next: "명령을 지우면 예약할 수 있어요",
    },
    personalCall: {
      reason: "개인 에이전트 호출은 예약할 수 없어요",
      next: "호출을 빼면 예약할 수 있어요",
    },
    attachUploading: {
      reason: "파일이 올라가는 중이에요",
      next: "끝나면 예약할 수 있어요",
    },
    attachFailed: {
      reason: "올리지 못한 파일이 있어요",
      nextRetry: "다시 올리거나 지우면 예약할 수 있어요",
      nextRemove: "지우면 예약할 수 있어요",
    },
    unavailable: {
      reason: "이 서버에서는 예약을 쓸 수 없어요",
      next: "관리자에게 물어보세요",
    },
    /** 대기 50개. 메뉴 안에서 말한다(`error.limit`과 같은 문장). */
    limit: "예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.",
  },

  secretKey: {
    /** 기존 키 차단 줄의 첫 문장만 바뀐다. 나머지는 `SECRET_KEY_BLOCK_COPY`를 그대로 쓴다. */
    lead: "키는 채팅에 붙여 넣지 마세요. 이 메시지는 예약하지 않았어요.",
  },

  menu: {
    custom: "직접 고르기…",
    /** 폰 메뉴 행의 보조 줄. */
    customDetail: "날짜와 시간을 골라요",
    zone: (zoneLabel: string) => `${zoneLabel} 기준이에요`,
    routingNote: "모델 지정은 예약에 담기지 않아요",
  },

  preset: {
    tomorrow: "내일",
    nextMonday: "다음 주 월요일",
  },

  dialog: {
    /** 대화상자·시트 안의 오프라인 한 줄. 오류 줄 자리에 서고 「예약하기」는 흐리다. */
    offline: "연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.",
    title: "보낼 시각 고르기",
    titleChange: "보낼 시각 바꾸기",
    titleRearm: "다시 예약하기",
    description: "고른 시각에 이 메시지를 보내요. 내 기기가 꺼져 있어도 보내요.",
    date: "날짜",
    time: "시간",
    preview: (when: string) => `${when}에 보내요`,
    commit: "예약하기",
    commitChange: "변경하기",
    cancel: "취소",
    saving: "예약 중",
    errSoon: "1분 뒤부터 예약할 수 있어요",
    errFar: "120일 안에서 골라 주세요",
    errInvalid: "날짜와 시간을 확인해 주세요",
  },

  status: {
    /** 응답의 `sendAtMs`로 그린 시각을 넣는다(명세 0.5). */
    scheduled: (when: string) => `${when}에 보낼게요`,
    sentNow: "메시지를 보냈어요",
  },

  banner: {
    pending: (place: PlaceWord, count: number) => `이 ${place}에 예약된 메시지 ${count}개`,
    failed: (count: number) => `예약한 메시지 ${count}개를 보내지 못했어요`,
    action: "보기",
  },

  nav: {
    label: "예약됨",
    badgeLabel: (count: number) => `보내지 못한 예약 ${count}개`,
  },

  list: {
    title: "예약됨",
    count: (count: number) => `내 예약 ${count}개`,
    sectionFailed: "보내지 못함",
    sectionPending: "보낼 예정",
    when: (when: string) => `${when}에 보내요`,
    soon: "곧 보내요",
    sending: "보내는 중",
    attachments: (count: number) => `첨부 ${count}개`,
    /** `{장소 이름}`: 채널은 「#일반」, DM은 「김인턴과의 대화」처럼 호출하는 쪽이 만든 라벨. */
    filter: (placeLabel: string) => `${placeLabel} 예약만 보고 있어요`,
    filterAction: "모두 보기",
  },

  action: {
    sendNow: "지금 보내기",
    change: "시간 바꾸기",
    rearm: "다시 예약",
    review: "내용 확인",
    edit: "고치기",
    copy: "내용 복사",
    delete: "지우기",
    /** `⋯`의 이름은 행마다 구별되게 채널과 시각을 싣는다. */
    rowMenu: (channelLabel: string, when: string) => `${channelLabel}, ${when} 예약 동작`,
  },

  lock: {
    /** 마감 30초 안의 「시간 바꾸기」·「고치기」가 흐린 이유. */
    reason: "곧 보내서 바꿀 수 없어요",
  },

  error: {
    tooLate: "곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요.",
  },

  review: {
    title: "내용을 확인해 주세요",
    body: "로그인이 끝나서 멈춘 예약이에요. 내가 쓴 글이 맞는지 확인한 뒤에 보내 주세요.",
    attachments: (count: number, names: readonly string[]) =>
      `첨부 ${count}개: ${names.join(", ")}`,
    close: "닫기",
    bodyLabel: "예약한 메시지 본문",
    when: (when: string) => `${when}에 보내려던 예약이에요`,
  },

  edit: {
    title: "예약한 메시지 고치기",
    attachNote: "첨부는 바꿀 수 없어요. 바꾸려면 지우고 다시 예약해 주세요.",
    commit: "저장하기",
    saving: "저장 중",
  },

  delete: {
    title: "예약을 지울까요?",
    body: "지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요.",
    confirm: "지우기",
    pending: "지우는 중",
  },

  empty: {
    title: "예약한 메시지가 없어요",
    bodyWeb: "메시지를 쓰고 보내기 옆 화살표에서 시각을 고르면 예약돼요",
    bodyPhone: "보내기 단추를 길게 누르면 예약할 수 있어요",
    action: "대화로 돌아가기",
  },

  load: {
    error: "예약 목록을 불러오지 못했어요",
    retry: "다시 불러오기",
  },

  offline: {
    list: "연결이 없어요. 연결되면 예약을 바꿀 수 있어요.",
  },

  /**
   * 서버 오류 → 문장(명세 3.3). 연산·상태·코드로 문장을 고르는 일은 `errors.ts`가 한다.
   * 여기는 문장 자체다.
   */
  errors: {
    tooSoon: "1분 뒤부터 예약할 수 있어요",
    tooFar: "120일 안에서 골라 주세요",
    emptyMessage: "보낼 글이나 첨부를 넣어 주세요",
    createBadRequest:
      "첨부 개수나 답하려는 메시지를 확인해 주세요. 첨부는 20개까지, 같은 파일은 한 번만 넣을 수 있어요.",
    createForbidden: (place: ErrorPlaceWord) =>
      `이 ${place}에 예약할 수 없어요. 들어가 있는 ${place}인지, 첨부가 내 파일인지 확인해 주세요.`,
    createNotFound: "답하려던 메시지나 첨부를 찾을 수 없어요. 내용을 확인하고 다시 해 주세요.",
    attachmentReserved:
      "이 파일은 다른 예약에 쓰이고 있어요. 다른 파일을 고르거나 그 예약을 지워 주세요.",
    attachmentUnusable: "첨부한 파일을 쓸 수 없어요. 다시 올려 주세요.",
    alreadySent: "이미 보냈어요",
    busyEdit: "지금 보내는 중이라 바꿀 수 없어요. 잠시 뒤에 다시 해 주세요.",
    busyAct: "지금 보내는 중이에요. 잠시 뒤에 목록을 새로 불러와 주세요.",
    rowNotFound: "예약을 찾을 수 없어요. 이미 지워졌을 수 있어요.",
    rateLimited: "요청이 너무 많아요. 잠시 뒤에 다시 해 주세요.",
    unknownCreate: "예약됐는지 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요.",
    unknownEdit: "바뀌었는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요.",
    unknownDelete: "지워졌는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요.",
    unknownSendNow: "보냈는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요.",
    otherCreate: "예약하지 못했어요. 다시 해 주세요.",
    otherWrite: "처리하지 못했어요. 목록을 새로 불러와 다시 해 주세요.",
  },
} as const;

/** 실패 사유 한 건의 두 줄(명세 3.2): 이유 줄과 다음 행동 줄. */
export interface FailureLines {
  reason: string;
  next: string;
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
        reason: "로그인이 끝나서 예약을 멈췄어요",
        next: "내용을 확인하고 보내거나 다시 예약해 주세요",
      };
    case "author_inactive":
      return {
        reason: "계정이 정지돼 있어서 보내지 못했어요",
        next: "정지가 풀린 뒤에 다시 예약해 주세요",
      };
    case "missed":
      return {
        reason: "예약한 시각이 많이 지나서 보내지 않았어요",
        next: "지금 보내거나 다시 예약할 수 있어요",
      };
    case "send_error":
      return {
        reason: "서버 문제로 보내지 못했어요",
        next: "잠시 뒤에 지금 보내기로 다시 해 볼 수 있어요",
      };
    case "not_member":
      return {
        reason: `이 ${place}에서 나가서 보내지 못했어요`,
        next: `${place}에 다시 들어간 뒤에 보낼 수 있어요`,
      };
    case "root_unavailable":
      return {
        reason: "답하려던 메시지가 지워져서 보내지 못했어요",
        next: `내용을 복사해서 ${place}에 새로 보내 주세요`,
      };
    case "attachment_unavailable":
      return {
        reason: "첨부한 파일을 쓸 수 없어서 보내지 못했어요",
        next: "파일을 다시 올려서 새로 예약해 주세요",
      };
    case "not_allowed":
    case undefined:
      return {
        reason: `이 ${place}의 규칙 때문에 보내지 못했어요`,
        next: "관리자에게 물어보세요",
      };
  }
}
