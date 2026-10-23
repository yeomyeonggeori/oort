import { SCHEDULED_COPY, failureLines, type ErrorPlaceWord, type PlaceWord } from "./copy";
import { formatScheduledAt } from "./presets";
import {
  SCHEDULED_EDIT_LOCK_MS,
  type ScheduledFailureReason,
  type ScheduledMessage,
} from "./types";

// =============================================================================
// 예약 목록·배너·사이드바 알약·행 동작의 판정 (UI 명세 1.5~1.8·0.6, ADR-0208 D8·D9, #4237).
//
// 순수 함수다. 시계는 `nowMs`로 받고(직접 읽지 않는다), 열린 행(`pending` + `failed`)의 목록을
// 입력으로 받는다. 웹의 목록 화면·입력창 배너·사이드바 줄과 폰의 시트·배너·프로필 줄이 **같은
// 함수**로 같은 답을 얻는다.
// =============================================================================

/** 폰이 마감 뒤 재조회하는 여유: 틱 5초 + 처리 여유(명세 0.6). 마감이 지난 행이 보냈는지 실패했는지를 거기서 안다. */
export const SCHEDULED_REFETCH_GRACE_MS = 35_000;

function idKey(id: string): string {
  return id.toLowerCase();
}

export function isOpenRow(row: ScheduledMessage): boolean {
  return row.status === "pending" || row.status === "failed";
}

/**
 * 「내용 확인」을 거쳐야 하는 행: 로그인이 끝나서 멈춘 예약이다. 탈취된 세션이 심은 예약이 계정을
 * 되찾은 뒤에 한 번 눌러 나가면 멈춘 의미가 없으므로(ADR-0208 D14), 이 행은 본문 전체를 보여 주는
 * 확인을 거친 뒤에만 지금 보내기·다시 예약을 한다.
 */
export function needsReview(row: ScheduledMessage): boolean {
  return row.status === "failed" && row.failureReason === "sessions_ended";
}

/** 서버 정렬과 같은 키셋: 보낼 시각, 같으면 id. */
export function compareScheduled(a: ScheduledMessage, b: ScheduledMessage): number {
  if (a.sendAtMs !== b.sendAtMs) return a.sendAtMs - b.sendAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---- 구획·개수 ---------------------------------------------------------------------------

export interface ScheduledSections {
  /** 보내지 못함. 위에 선다(사람이 할 일이 먼저다). */
  failed: ScheduledMessage[];
  /** 보낼 예정. 마감 임박순이다. */
  pending: ScheduledMessage[];
}

/** 목록의 두 구획. 구획이 비면 제목도 없다(호출하는 쪽이 길이로 판정한다). */
export function scheduledSections(rows: readonly ScheduledMessage[]): ScheduledSections {
  const sorted = rows.filter(isOpenRow).sort(compareScheduled);
  return {
    failed: sorted.filter((row) => row.status === "failed"),
    pending: sorted.filter((row) => row.status === "pending"),
  };
}

/** 화면에 서는 행의 순서: 보내지 못함이 먼저, 그다음 보낼 예정(마감 임박순). 초점 이동이 이 순서를 쓴다. */
export function scheduledDisplayOrder(rows: readonly ScheduledMessage[]): string[] {
  const { failed, pending } = scheduledSections(rows);
  return [...failed, ...pending].map((row) => row.id);
}

export interface ScheduledTotals {
  /** 「내 예약 {n}개」의 n: 대기 + 실패. */
  total: number;
  pending: number;
  failed: number;
}

export function scheduledTotals(rows: readonly ScheduledMessage[]): ScheduledTotals {
  const pending = rows.filter((row) => row.status === "pending").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  return { total: pending + failed, pending, failed };
}

/** 한 곳: 채널 입력창은 채널만, 스레드 입력창은 채널과 `rootId`다. */
export interface ScheduledPlace {
  channelId: string;
  rootId?: string;
}

/**
 * 그 곳의 열린 행. **채널 화면은 그 채널의 것 전부**(스레드 답글 예약 포함)를 세고, **스레드 패널은 그
 * 스레드(`rootId`)의 것만** 센다(명세 1.6). 채널 배너의 「보기」가 채널로 거른 목록을 열므로 배너의
 * 개수와 그 목록의 행 수가 같다.
 */
export function rowsInPlace(
  rows: readonly ScheduledMessage[],
  place: ScheduledPlace
): ScheduledMessage[] {
  const channel = idKey(place.channelId);
  const root = place.rootId === undefined ? undefined : idKey(place.rootId);
  return rows.filter(
    (row) =>
      isOpenRow(row) &&
      idKey(row.channelId) === channel &&
      (root === undefined || (row.rootId !== undefined && idKey(row.rootId) === root))
  );
}

/** 입력창 위 배너. 실패가 하나라도 있으면 실패 한 줄만 선다(대기 배너 대신). 0개면 `null`. */
export type ScheduledBanner =
  | { tone: "failed"; count: number }
  | { tone: "pending"; count: number };

export function scheduledBanner(
  rows: readonly ScheduledMessage[],
  place: ScheduledPlace
): ScheduledBanner | null {
  const here = rowsInPlace(rows, place);
  const failed = here.filter((row) => row.status === "failed").length;
  if (failed > 0) return { tone: "failed", count: failed };
  const pending = here.length;
  return pending > 0 ? { tone: "pending", count: pending } : null;
}

/** 배너 문장. `place`는 채널·대화·스레드다. 실패 어조의 문장은 장소를 말하지 않는다(명세 1.6). */
export function bannerLine(banner: ScheduledBanner, place: PlaceWord): string {
  return banner.tone === "failed"
    ? SCHEDULED_COPY.banner.failed(banner.count)
    : SCHEDULED_COPY.banner.pending(place, banner.count);
}

/**
 * 사이드바 「예약됨」 줄. 보낼 예정 또는 보내지 못함이 있을 때만 선다. **보내지 못한 예약이 있으면 알약에
 * 그 수**를 단다(점이 아니다). 대기 개수는 달지 않는다(알약의 뜻을 흐리지 않는다, 명세 1.1).
 */
export interface ScheduledNavEntry {
  visible: boolean;
  /** 잉크 알약의 수. 0이면 알약이 없다. */
  failedCount: number;
  /** 알약의 낭독 이름 「보내지 못한 예약 {n}개」. 알약이 없으면 `null`. */
  badgeLabel: string | null;
}

export function scheduledNavEntry(rows: readonly ScheduledMessage[]): ScheduledNavEntry {
  const { total, failed } = scheduledTotals(rows);
  return {
    visible: total > 0,
    failedCount: failed,
    badgeLabel: failed > 0 ? SCHEDULED_COPY.nav.badgeLabel(failed) : null,
  };
}

// ---- 마감 경계 ------------------------------------------------------------------------------

/** 편집이 닫히는 시각. 서버가 판정하고 `editableUntilMs`는 힌트다(없으면 `sendAtMs - 30초`로 읽는다). */
export function editableUntilMs(row: ScheduledMessage): number {
  return row.editableUntilMs ?? row.sendAtMs - SCHEDULED_EDIT_LOCK_MS;
}

/**
 * 행의 국면.
 *  - `waiting`: 보낼 예정, 아직 고칠 수 있다.
 *  - `soon`: 마감 30초 안. 시각 줄은 「곧 보내요」이고 「시간 바꾸기」·「고치기」가 흐리다.
 *  - `sending`: `sendAtMs`가 지났는데 아직 `pending`. 시각 줄은 「보내는 중」이다.
 *  - `failed`: 보내지 못함.
 * 「지금 보내기」·「지우기」는 어느 국면에서나 보내기 전까지 된다(ADR-0208 D9).
 */
export type ScheduledPhase = "waiting" | "soon" | "sending" | "failed";

export function rowPhase(row: ScheduledMessage, nowMs: number): ScheduledPhase {
  if (row.status === "failed") return "failed";
  if (nowMs >= row.sendAtMs) return "sending";
  if (nowMs >= editableUntilMs(row)) return "soon";
  return "waiting";
}

/**
 * 열려 있는 대화상자가 보는 잠금. 행이 마감 30초 안에 들면 저장을 잠그고(`tooLate`), 행이 스토어에서
 * 사라졌거나 닫혔으면(이미 보냄·지움) 저장을 잠근다(`gone`). 실패 행은 시각과 무관하게 열려 있다.
 */
export function editLock(
  row: ScheduledMessage | undefined,
  nowMs: number
): "open" | "tooLate" | "gone" {
  if (row === undefined || !isOpenRow(row)) return "gone";
  if (row.status === "failed") return "open";
  return nowMs >= editableUntilMs(row) ? "tooLate" : "open";
}

/**
 * 다음에 화면의 상태가 바뀌는 시각(에포크 밀리초)과 그 전의 한 번. 열린 대기 행의 `editableUntilMs`와
 * `sendAtMs` 중 지금보다 뒤인 가장 이른 값이고, 없으면 `null`이다. 웹은 `setTimeout`을 이 값까지만
 * 걸고(경계에서 한 번), 폰은 `useNow`가 1분 주기라 이 값으로 경계용 타이머를 따로 둔다(명세 0.6).
 */
export function nextScheduledBoundaryMs(
  rows: readonly ScheduledMessage[],
  nowMs: number
): number | null {
  let next: number | null = null;
  for (const row of rows) {
    if (row.status !== "pending") continue;
    for (const boundary of [editableUntilMs(row), row.sendAtMs]) {
      if (boundary > nowMs && (next === null || boundary < next)) next = boundary;
    }
  }
  return next;
}

/** 폰의 재조회 시각: 대기 행은 `sendAtMs` 35초 뒤. 대기가 아니면 `null`. */
export function scheduledRefetchAtMs(row: ScheduledMessage): number | null {
  return row.status === "pending" ? row.sendAtMs + SCHEDULED_REFETCH_GRACE_MS : null;
}

// ---- 행의 문장 -------------------------------------------------------------------------------

/**
 * 보낼 예정 행의 시각 줄: 「내일 오전 9:00에 보내요」 · 마감 30초 안 「곧 보내요」 · 지난 뒤 「보내는 중」.
 * 보내지 못한 행은 시각 줄 대신 사유 줄을 쓰므로(`failureLines`) 빈 문자열이다.
 */
export function rowWhenLine(row: ScheduledMessage, nowMs: number): string {
  switch (rowPhase(row, nowMs)) {
    case "waiting":
      return SCHEDULED_COPY.list.when(formatScheduledAt(row.sendAtMs, nowMs).full);
    case "soon":
      return SCHEDULED_COPY.list.soon;
    case "sending":
      return SCHEDULED_COPY.list.sending;
    case "failed":
      return "";
  }
}

/** 미리보기: 줄바꿈과 겹친 공백을 한 칸으로 접은 글. 첨부만 있는 행은 빈 문자열이다. */
export function scheduledPreview(row: ScheduledMessage): string {
  return (row.body ?? "").replace(/\s+/g, " ").trim();
}

export function attachmentCount(row: ScheduledMessage): number {
  return row.attachments?.length ?? 0;
}

/** 행의 첨부 칩 「첨부 {n}개」. 첨부가 없으면 `null`. */
export function attachmentChipLine(row: ScheduledMessage): string | null {
  const count = attachmentCount(row);
  return count > 0 ? SCHEDULED_COPY.list.attachments(count) : null;
}

/** 「내용 확인」 대화상자의 첨부 줄 「첨부 2개: 일정.pdf, 변경목록.csv」. 첨부가 없으면 `null`. */
export function reviewAttachmentsLine(row: ScheduledMessage): string | null {
  const attachments = row.attachments ?? [];
  if (attachments.length === 0) return null;
  return SCHEDULED_COPY.review.attachments(
    attachments.length,
    attachments.map((attachment) => attachment.name)
  );
}

/**
 * 행의 낭독 이름. 보낼 예정 「{채널}, {미리보기}, {보낼 시각}에 보내요」(마감 30초 안·지난 뒤에는 시각
 * 대신 「곧 보내요」·「보내는 중」), 보내지 못함 「{채널}, {미리보기}, {사유}」다(명세 1.7).
 */
export function rowAriaName(
  row: ScheduledMessage,
  channelLabel: string,
  nowMs: number,
  place: ErrorPlaceWord
): string {
  const preview = scheduledPreview(row);
  const head = preview === "" ? channelLabel : `${channelLabel}, ${preview}`;
  if (row.status === "failed") return `${head}, ${failureLines(row.failureReason, place).reason}`;
  const phase = rowPhase(row, nowMs);
  const tail =
    phase === "waiting"
      ? SCHEDULED_COPY.list.when(formatScheduledAt(row.sendAtMs, nowMs).aria)
      : rowWhenLine(row, nowMs);
  return `${head}, ${tail}`;
}

/** `⋯`의 이름: 행마다 구별되게 채널과 보낼 시각을 싣는다. */
export function rowMenuAriaName(row: ScheduledMessage, channelLabel: string, nowMs: number): string {
  return SCHEDULED_COPY.action.rowMenu(channelLabel, formatScheduledAt(row.sendAtMs, nowMs).aria);
}

// ---- 행 동작 ----------------------------------------------------------------------------------

export type ScheduledActionId =
  | "sendNow"
  | "change"
  | "rearm"
  | "review"
  | "edit"
  | "copy"
  | "delete";

export interface ScheduledRowActions {
  /**
   * 행에 바로 보이는 단추, 주된 것이 앞이다. 보내지 못한 행만 갖는 명시된 예외다(「행 동작은 상시 버튼이
   * 아니다」, 명세 1.8). 보낼 예정 행은 비어 있다.
   */
  inline: ScheduledActionId[];
  /** `⋯` 메뉴(폰은 동작 시트)의 전체. 서버가 마지막에 다시 판정한다. */
  menu: ScheduledActionId[];
  /** 흐리게 두는 동작(마감 30초 안의 「시간 바꾸기」·「고치기」). 이유는 `lock.reason`이다. */
  locked: ScheduledActionId[];
  /** 고치기 대화상자에 시각 칸이 서는가. `sessions_ended` 행은 시각 칸이 없다(되살리는 길은 내용 확인 하나다). */
  editHasTime: boolean;
}

/** 지금 보내거나 다시 예약하는 것이 정상 복구인 사유: 서버가 쉬었거나 일시 오류가 이어진 경우다. */
const REVIVABLE: readonly ScheduledFailureReason[] = ["missed", "send_error"];

/**
 * 행에 서는 동작. **`sessions_ended` 행은 「지금 보내기」·「다시 예약」이 `⋯`에도 없다**: 본문 전체를 보인
 * 확인(「내용 확인」) 안에서만 서버를 부른다. 되살릴 수 있는 사유(`missed`·`send_error`)는 행에
 * 「지금 보내기」·「다시 예약」이 보이고, 나머지 사유는 「내용 복사」만 보인다.
 */
export function rowActions(row: ScheduledMessage, nowMs: number): ScheduledRowActions {
  if (row.status === "pending") {
    const locked: ScheduledActionId[] = rowPhase(row, nowMs) === "waiting" ? [] : ["change", "edit"];
    return {
      inline: [],
      menu: ["sendNow", "change", "edit", "delete"],
      locked,
      editHasTime: true,
    };
  }
  if (row.status !== "failed") {
    return { inline: [], menu: [], locked: [], editHasTime: false };
  }
  if (needsReview(row)) {
    return {
      inline: ["review"],
      menu: ["review", "edit", "copy", "delete"],
      locked: [],
      editHasTime: false,
    };
  }
  const reason = row.failureReason;
  const revivable = reason !== undefined && REVIVABLE.includes(reason);
  return {
    inline: revivable ? ["sendNow", "rearm"] : ["copy"],
    menu: ["sendNow", "rearm", "edit", "copy", "delete"],
    locked: [],
    editHasTime: true,
  };
}

/** 동작의 단추 문구. */
export function actionLabel(id: ScheduledActionId): string {
  const copy = SCHEDULED_COPY.action;
  switch (id) {
    case "sendNow":
      return copy.sendNow;
    case "change":
      return copy.change;
    case "rearm":
      return copy.rearm;
    case "review":
      return copy.review;
    case "edit":
      return copy.edit;
    case "copy":
      return copy.copy;
    case "delete":
      return copy.delete;
  }
}

/**
 * 행이 사라질 때의 초점 규칙(명세 1.7): 다음 행의 첫 컨트롤, 다음 행이 없으면 앞 행, 행이 하나도
 * 없으면 목록 제목이다. 호출하는 쪽이 지우기 전의 순서 있는 id 목록을 준다.
 */
export function focusAfterRemoval(
  orderedIds: readonly string[],
  removedId: string
): { kind: "row"; id: string } | { kind: "title" } {
  const key = idKey(removedId);
  const index = orderedIds.findIndex((id) => idKey(id) === key);
  if (index === -1) return { kind: "title" };
  const next = orderedIds[index + 1] ?? orderedIds[index - 1];
  return next === undefined ? { kind: "title" } : { kind: "row", id: next };
}
