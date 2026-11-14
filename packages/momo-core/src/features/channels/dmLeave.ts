import { ApiError, type Channel, type ReadState } from "../../lib/api";
import type { MessageKey } from "../../i18n/generated/messages";
import type { MessageService } from "../../i18n/types";
import type { ScheduledMessage } from "../scheduled/types";
import type { ReadProjectionPhase } from "../sidebar/goneDm";
import { failPending, removePending, type PendingMessage } from "../timeline/model";
import { idKey, memberFor, type Directory } from "../workspace/directory";

// =============================================================================
// 1:1 「대화 나가기」의 코어 (ADR-0177 증보 2026-11-14 D16·D18·D20·D21·D22, #5824).
//
// 웹·데스크탑·폰이 같은 판정을 쓴다. 화면 배치(메뉴 자리·확인 창 모양·끝난 뒤 이동)는 화면 칸의 일이고, 여기는 그 화면들이
// 부를 **판정과 낱말 키와 순서**뿐이다. 순수하다: 저장소·시계·네트워크가 없다(API 함수 `leaveDm` 은 `lib/api`).
//
//   옛 서버 판별(D21)        `dmLeaveMode`         GET 읽음 투영 행에 `history_from_seq` 키가 있는가(값이 null 이어도)
//   내미는가(D20·D21)        `dmLeaveOffered`      사람끼리의 1:1 + 새 서버 + 투영 준비. 안 읽음·별표와 무관
//   내가 본 seq(D16)         `dmLeaveSeenSeq`      투영의 latest_seq 와 실시간으로 받은 seq 중 큰 쪽
//   응답 갈래(D16·D21)       `settleDmLeaveFailure` 405·501 은 이 워크스페이스에서 접고(404 는 그 대화 하나), 무엇이든 실패 문장 하나
//   확인 창(D21)             `dmLeaveConfirmCopy`  제목 · 줄들(예약 N개 줄은 N>0 일 때만) · 단추 둘
//   성공 뒤(D17 기기 줄)     `runDmLeaveCleanup`   투영 행에 하한 쓰기 → 이력·스레드·검색·받은함 캐시 → 초안·답글 초안 → 첨부 트레이 → 못 보낸 글
//   하한 아래 발행물(D22-3)  `isBelowHistoryFloor` 실시간으로 다시 온 나가기 전 발행물을 버린다
//   보내기 재시도(D17)       `pendingAfterSendFailure` 409 `message_before_leave` 는 실패 행이 아니라 조용히 지운다
// =============================================================================

type Format = MessageService["formatMessage"];

// ---- 낱말 (D21, ADR-0213 사전 `channels.json`) ---------------------------------------------------------------

export type DmLeaveKey = Extract<MessageKey, `channels.dmLeave.${string}`>;

/**
 * 「대화 나가기」의 사전 키 표. 문구는 `i18n/catalogs/<언어>/channels.json` 에 있다. 화면이 키 문자열을 손으로 적지 않게 하는
 * 표이고, `satisfies` 가 사전과 갈라지면 컴파일을 멈춘다.
 *
 *   action            메뉴 항목 이름(행동 표 `leave-dm`)
 *   confirmTitle      확인 창 제목. 값 `name`(상대의 표시 이름)
 *   confirmBody       본문 1. 값 `name`
 *   confirmRevive     본문 2
 *   confirmFinal      본문 3 「나간 뒤에는 되돌릴 수 없어요.」
 *   confirmScheduled  본문 4 - 예약이 있을 때만. 값 `count`(`dmLeaveScheduledCount`)
 *   cancel · confirm  단추 둘. 「나가기」는 위험색, 기본 초점은 「취소」(화면 몫)
 *   done              성공 뒤 한 줄 알림(되돌리기 단추 없음)
 *   failed            실패 한 줄. 아무것도 바뀌지 않는다
 */
export const DM_LEAVE_KEYS = {
  action: "channels.dmLeave.action",
  confirmTitle: "channels.dmLeave.confirmTitle",
  confirmBody: "channels.dmLeave.confirmBody",
  confirmRevive: "channels.dmLeave.confirmRevive",
  confirmFinal: "channels.dmLeave.confirmFinal",
  confirmScheduled: "channels.dmLeave.confirmScheduled",
  cancel: "channels.dmLeave.cancel",
  confirm: "channels.dmLeave.confirm",
  done: "channels.dmLeave.done",
  failed: "channels.dmLeave.failed",
} as const satisfies Record<string, DmLeaveKey>;

// ---- 옛 서버 판별 (D21) ----------------------------------------------------------------------------------------

/**
 *   server   이 서버가 나가기를 싣는다(GET 행에 `history_from_seq` 키가 있다).
 *   legacy   행은 있는데 아무도 그 키를 말하지 않는다, 또는 나가기 경로가 405·501 로 접혔다(404 는 접지 않는다 - 아래 `dmLeaveFailure`).
 *   unknown  투영이 없거나 행이 0 개다 - 증거가 없다.
 * 되돌릴 수 없는 동작이라 `server` 일 때만 내민다(모르면 닫힌다).
 */
export type DmLeaveMode = "server" | "legacy" | "unknown";

/** 나가기 경로가 「그런 경로 없다」고 답해 이 세션에서 접은 워크스페이스(소문자 id). */
const foldedAbsent = new Set<string>();

export function foldDmLeaveAbsent(workspaceId: string): void {
  foldedAbsent.add(workspaceId.toLowerCase());
}

export function dmLeaveFolded(workspaceId: string): boolean {
  return foldedAbsent.has(workspaceId.toLowerCase());
}

/** 시험 전용. */
export function resetDmLeaveFoldForTest(): void {
  foldedAbsent.clear();
}

/**
 * 읽음 투영이 하한을 싣는가 - **보임 판정의 입력**(`dmReadFacts` 의 `serverCarriesLeave`)은 이것으로 정한다. 판별은 키의 **있음**이다:
 * `history_from_seq: null` 도 싣는 것이다. `PUT read-state` 응답과 실시간 프레임에는 이 키가 없으므로 `GET` 행으로만 가른다(호출부의
 * 병합이 값을 지켜야 한다). 나가기 경로의 접기(`foldDmLeaveAbsent`)를 보지 **않는다**: 접기는 메뉴를 내밀지 않게 할 뿐이고, 이미 나간
 * 대화의 하한은 투영이 싣는 한 계속 판정에 들어가야 한다(D18).
 */
export function readProjectionCarriesLeave(rows: readonly ReadState[] | undefined): boolean {
  return rows !== undefined && rows.some((row) => row.historyFromSeq !== undefined);
}

/**
 * 이 서버에 나가기를 **내미는가**의 판별(D21). 투영이 하한을 싣고(`readProjectionCarriesLeave`), 이 워크스페이스에서 나가기 경로가
 * 접히지 않았을 때 `server` 다. 보임 판정에는 이것이 아니라 `readProjectionCarriesLeave` 를 쓴다.
 */
export function dmLeaveMode(input: {
  workspaceId: string;
  rows: readonly ReadState[] | undefined;
}): DmLeaveMode {
  if (dmLeaveFolded(input.workspaceId)) return "legacy";
  const rows = input.rows;
  if (rows === undefined || rows.length === 0) return "unknown";
  return readProjectionCarriesLeave(rows) ? "server" : "legacy";
}

// ---- 내미는가 (D20·D21) ----------------------------------------------------------------------------------------

/**
 * 사람끼리의 1:1 인가 - 클라이언트가 아는 사실로 D20 을 다시 잰다(서버가 마지막 말을 한다: 범위 밖이면 409).
 *
 *   * DM 이고 보관되지 않았다.
 *   * `group:`·`admitted:` 키가 아니다(그룹 DM 과 에이전트가 앉은 1:1 은 밖).
 *   * 참여자가 정확히 둘이고 나도 그중 하나다.
 *   * 나도 상대도 명부에 있는 사람이다. 상대가 명부에 없으면(나간 멤버·명부 미완) 내밀지 않는다 - 나간 상대의 DM 은 D11 대로
 *     다 읽으면 저절로 숨는다. 상대가 정지 상태여도 참여 행이 남아 있어 대상이다.
 */
export function isPersonToPersonDm(
  channel: Pick<Channel, "kind" | "archivedAtMs" | "dmKey" | "memberIds">,
  directory: Directory,
  selfMemberId: string
): boolean {
  if (channel.kind !== "dm" || channel.archivedAtMs !== undefined) return false;
  const dmKey = channel.dmKey ?? "";
  if (dmKey.startsWith("group:") || dmKey.startsWith("admitted:")) return false;
  const ids = channel.memberIds ?? [];
  if (ids.length !== 2) return false;
  const self = idKey(selfMemberId);
  if (!ids.some((id) => idKey(id) === self)) return false;
  if (memberFor(directory, selfMemberId)?.kind !== "human") return false;
  const peer = memberFor(directory, ids.find((id) => idKey(id) !== self));
  return peer !== null && peer.kind === "human" && peer.status !== "deleted";
}

export interface DmLeaveOfferInput {
  mode: DmLeaveMode;
  /** 읽음 투영. 나가기는 `seenSeq` 를 적어야 하므로 준비된 뒤에만 내민다. */
  phase: ReadProjectionPhase;
  channel: Pick<Channel, "kind" | "archivedAtMs" | "dmKey" | "memberIds">;
  directory: Directory;
  selfMemberId: string;
}

/**
 * 이 DM 에 「대화 나가기」를 내미는가. 행동 표에는 `channelActionAvailability` 의 `canLeaveDm` 으로 넘긴다.
 * 안 읽음·별표·섹션과 무관하다(D21 - 확인 창이 있어서). 옛 서버(`legacy`)와 모르는 서버(`unknown`)에서는 메뉴 항목이 없다.
 */
export function dmLeaveOffered(input: DmLeaveOfferInput): boolean {
  return (
    input.mode === "server" &&
    input.phase === "ready" &&
    isPersonToPersonDm(input.channel, input.directory, input.selfMemberId)
  );
}

// ---- 내가 본 seq 와 하한 (D16·D18·D22) --------------------------------------------------------------------------

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `PUT …/dm-leave` 의 `seenSeq`: 이 대화에 대해 클라이언트가 **들고 있는 가장 큰 seq** 다 - 읽음 투영 행의 `latestSeq` 와
 * 실시간으로 받은 그 방 메시지의 seq 중 큰 쪽(D16). 서버 시각으로 자르지 않는 까닭은 확인 창을 보는 사이에 온 글이 묻히지 않게
 * 하려는 것이다.
 */
export function dmLeaveSeenSeq(
  read: Pick<ReadState, "latestSeq"> | undefined,
  observedSeq?: number | null
): number {
  const projected = isSeq(read?.latestSeq) ? read.latestSeq : 0;
  const observed = isSeq(observedSeq) ? observedSeq : 0;
  return Math.max(projected, observed);
}

/** 204 직후 이 기기가 아는 하한. 서버의 하한은 `GREATEST(기존, LEAST(seenSeq, 마지막 seq) + 1)` 이라 이보다 낮지 않다. */
export function historyFloorAfterLeave(seenSeq: number): number {
  return seenSeq + 1;
}

/** 두 하한 중 높은 쪽. `null`·`undefined` 는 하한 없음이다. 하한은 내려가지 않는다(D16). */
export function higherHistoryFloor(
  a: number | null | undefined,
  b: number | null | undefined
): number | null {
  const left = isSeq(a) && a > 0 ? a : null;
  const right = isSeq(b) && b > 0 ? b : null;
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * 실시간 프레임을 그리지 않는가(D22 한계 3 가운데 클라이언트 몫): 하한 아래 seq 는 화면에 그리지 않는다. 반응·고정·링크 카드·지움
 * 프레임은 대상 메시지의 seq 를 다시 쓰므로 같은 판정을 받는다. seq 가 없는 프레임과 하한이 없는 대화는 통과한다.
 */
export function isBelowHistoryFloor(
  seq: number | null | undefined,
  floor: number | null | undefined
): boolean {
  if (!isSeq(seq) || floor === null || floor === undefined) return false;
  return seq < floor;
}

/**
 * 나가기 성공 뒤 이 대화의 읽음 투영 행. 서버가 같은 트랜잭션에서 한 일을 캐시에 미리 적는다(D16-3·4·5): 하한, 읽음 위치
 * `하한 − 1`, 숨김 `하한 − 1`, 「여기부터 안 읽음」 지움. 다음 `GET read-state` 가 통째로 바꾼다. 그 사이에도 3a 가 이 대화를
 * 숨기고, 실시간 판정이 하한을 읽는다.
 */
export function readStateAfterLeave(row: ReadState, seenSeq: number): ReadState {
  const floor = higherHistoryFloor(row.historyFromSeq, historyFloorAfterLeave(seenSeq)) ?? 1;
  const lastReadSeq = Math.max(row.lastReadSeq, floor - 1);
  const closedAtSeq = Math.max(isSeq(row.closedAtSeq) ? row.closedAtSeq : 0, floor - 1);
  const nothingAbove = row.latestSeq <= lastReadSeq;
  return {
    ...row,
    historyFromSeq: floor,
    closedAtSeq,
    lastReadSeq,
    unreadCount: Math.max(0, row.latestSeq - lastReadSeq),
    mentionCount: nothingAbove ? 0 : row.mentionCount,
    markedUnreadBeforeSeq: null,
  };
}

// ---- 응답 갈래 (D16·D21) ---------------------------------------------------------------------------------------

export const DM_LEAVE_UNAVAILABLE_CODE = "dm_leave_unavailable";

/**
 *   absent       405·501 - 이 서버에 나가기 경로가 없다. 이 워크스페이스에서 메뉴를 접는다(닫기 경로의 `closureRouteAbsent` 와 같은 집합).
 *   missing      404 - 그 대화가 없다(참여자 아님·DM 아님·보관됨). 메뉴는 이 투영이 키로 경로를 증명한 뒤에만 서므로, 그 뒤의 404 는
 *                「경로 없음」이 아니라 그 대화 하나의 실패다. 접지 않는다 - 호출부가 채널·투영을 다시 받는다(#5824 검수 r1 M3).
 *   unavailable  409 `dm_leave_unavailable` - 서버가 본 그 방은 사람끼리 1:1 이 아니다(이 기기의 사실이 낡았다).
 *   failed       그 밖(네트워크·5xx·403·400). 아무것도 바뀌지 않았다.
 * 넷 모두 화면에는 같은 한 줄(`DM_LEAVE_KEYS.failed`)이다.
 */
export type DmLeaveFailure = "absent" | "missing" | "unavailable" | "failed";

/** 나가기 경로가 「이 서버에 그런 경로 없다」고 답하는 상태 코드. 404 는 들지 않는다(위 `missing`). */
const DM_LEAVE_ROUTE_ABSENT_STATUSES: readonly number[] = [405, 501];

export function dmLeaveFailure(error: unknown): DmLeaveFailure {
  if (error instanceof ApiError) {
    if (DM_LEAVE_ROUTE_ABSENT_STATUSES.includes(error.status)) return "absent";
    if (error.status === 404) return "missing";
    if (error.status === 409 && error.code === DM_LEAVE_UNAVAILABLE_CODE) return "unavailable";
  }
  return "failed";
}

/**
 * 실패를 갈라 적용한다: `absent`(405·501) 면 이 워크스페이스의 나가기를 접는다(메뉴 항목이 사라진다). `missing`(404)은 접지 않는다.
 * 화면 문구는 늘 `failed` 키다.
 */
export function settleDmLeaveFailure(workspaceId: string, error: unknown): DmLeaveFailure {
  const failure = dmLeaveFailure(error);
  if (failure === "absent") foldDmLeaveAbsent(workspaceId);
  return failure;
}

// ---- 확인 창 (D21) --------------------------------------------------------------------------------------------

/**
 * 확인 창의 「예약해 둔 메시지 N개」. 서버는 그 방의 내 예약 중 `pending` 과 `failed` 를 같이 취소하므로 둘 다 센다(엔진-1 인계
 * 「정할 것」 4). 입력은 내 예약 목록(`listAllScheduledMessages(ws, { channelId, status: "open" })` 의 결과 등)이다.
 */
export function dmLeaveScheduledCount(
  rows: readonly Pick<ScheduledMessage, "channelId" | "status">[],
  channelId: string
): number {
  const key = idKey(channelId);
  return rows.filter(
    (row) => idKey(row.channelId) === key && (row.status === "pending" || row.status === "failed")
  ).length;
}

export interface DmLeaveConfirmCopy {
  title: string;
  /** 본문 줄들, 차례대로. 예약 줄은 N > 0 일 때만 끝에 선다. */
  lines: string[];
  cancel: string;
  /** 위험색 단추. */
  confirm: string;
}

/** 확인 창의 낱말 전부. `name` 은 상대의 표시 이름(`dmPeer(...).displayName`)이다. */
export function dmLeaveConfirmCopy(
  format: Format,
  input: { name: string; scheduledCount: number }
): DmLeaveConfirmCopy {
  const lines = [
    format(DM_LEAVE_KEYS.confirmBody, { name: input.name }),
    format(DM_LEAVE_KEYS.confirmRevive),
    format(DM_LEAVE_KEYS.confirmFinal),
  ];
  if (input.scheduledCount > 0) {
    lines.push(format(DM_LEAVE_KEYS.confirmScheduled, { count: input.scheduledCount }));
  }
  return {
    title: format(DM_LEAVE_KEYS.confirmTitle, { name: input.name }),
    lines,
    cancel: format(DM_LEAVE_KEYS.cancel),
    confirm: format(DM_LEAVE_KEYS.confirm),
  };
}

// ---- 성공 뒤 (D17 「기기 캐시·쓰던 초안」 줄) --------------------------------------------------------------------

/**
 * 나가기 204 뒤 이 기기가 지우는 것. 코어는 저장소를 만지지 않는다 - 화면이 자기 캐시·초안 저장소로 이 문을 채운다(웹 초안은
 * `features/chat/draftStore.ts` 의 API). 이 대화의 것만 지운다.
 *
 * 답글 초안·스레드의 첨부 트레이는 열쇠가 뿌리 글 id 라서 채널 id 하나로는 찾을 수 없다(#5824 검수 r1 M4). 그래서 입력에
 * `rootIds` - 화면이 `PUT` **전에** 모은 그 대화의 뿌리 글 id(열려 있던 이력·스레드 캐시·저장소가 채널과 함께 적어 둔 것) - 를
 * 받아 두 단계에 넘긴다. `PUT` 뒤에는 서버가 하한 아래 뿌리를 내려 주지 않아 다시 모을 길이 없다.
 */
export interface DmLeaveCleanupPort {
  /** 읽음 투영 캐시의 그 행을 바꾼다(`readStateAfterLeave`). 행이 없으면 아무것도 하지 않는다. */
  updateReadRow(channelId: string, update: (row: ReadState) => ReadState): void;
  /** 그 대화의 이력과 스레드 캐시를 버린다. */
  dropTimeline(channelId: string): void;
  /** 검색 결과 캐시에서 그 대화의 결과를 버린다. */
  dropSearchResults(channelId: string): void;
  /** 받은함 캐시에서 그 대화의 항목을 버린다. */
  dropInboxItems(channelId: string): void;
  /** 그 대화에 쓰던 초안(대화 입력칸)과 그 대화의 답글 초안(`rootIds` 마다)을 지운다. */
  clearDrafts(channelId: string, rootIds: readonly string[]): void;
  /** 그 대화의 첨부 트레이(대화 입력칸 · 스레드 입력칸)를 비운다. */
  clearAttachmentTrays(channelId: string, rootIds: readonly string[]): void;
  /** 그 대화의 보내지 못한 글(실패 행과 그 기록)을 지운다(D17 기기 줄 - 나가기 전 대화의 글이다). */
  forgetFailedSends(channelId: string): void;
}

export type DmLeaveCleanupStep = keyof DmLeaveCleanupPort;

/** 차례: 사이드바가 바로 숨도록 투영 행이 먼저, 그다음 캐시, 마지막에 이 기기에만 있는 글. */
export const DM_LEAVE_CLEANUP_STEPS: readonly DmLeaveCleanupStep[] = [
  "updateReadRow",
  "dropTimeline",
  "dropSearchResults",
  "dropInboxItems",
  "clearDrafts",
  "clearAttachmentTrays",
  "forgetFailedSends",
];

export interface DmLeaveCleanupInput {
  channelId: string;
  seenSeq: number;
  /** `PUT` 전에 모은 그 대화의 뿌리 글 id. 없으면 빈 목록(대화 입력칸의 것만 지운다). */
  rootIds?: readonly string[];
}

/**
 * 나가기 성공 뒤 정리를 차례대로 돌린다. 한 단계가 던져도 나머지는 돈다(저장소 하나의 오류가 캐시를 남기지 않게). 던진 단계를
 * 돌려준다 - 비어 있으면 다 지웠다. 서버 쪽은 이미 끝났으므로(204) 이 결과로 실패 문장을 내지 않는다.
 */
export function runDmLeaveCleanup(port: DmLeaveCleanupPort, input: DmLeaveCleanupInput): DmLeaveCleanupStep[] {
  const failed: DmLeaveCleanupStep[] = [];
  const rootIds = [...new Set((input.rootIds ?? []).map((id) => id.toLowerCase()))];
  for (const step of DM_LEAVE_CLEANUP_STEPS) {
    try {
      if (step === "updateReadRow") {
        port.updateReadRow(input.channelId, (row) => readStateAfterLeave(row, input.seenSeq));
      } else if (step === "clearDrafts" || step === "clearAttachmentTrays") {
        port[step](input.channelId, rootIds);
      } else {
        port[step](input.channelId);
      }
    } catch {
      failed.push(step);
    }
  }
  return failed;
}

// ---- 보내기 재시도 (D17 쓰기 길 표) ------------------------------------------------------------------------------

export const MESSAGE_BEFORE_LEAVE_CODE = "message_before_leave";

/** 같은 `client_msg_id` 로 다시 보낸 글이 이미 하한 아래에 저장돼 있었다(409 `message_before_leave`). */
export function isMessageBeforeLeave(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === MESSAGE_BEFORE_LEAVE_CODE;
}

/**
 * 보내기 시도 하나가 실패했을 때 대기 목록. 409 `message_before_leave` 면 그 행을 **조용히 지운다**(실패 행으로 남기지 않는다 -
 * 그 글은 나가기 전 대화의 것이다). `dropped` 가 참이면 호출부는 실패 기록·이 기기의 못 보낸 글 저장도 하지 않는다. 그 밖은
 * 지금까지처럼 `failPending` 이다.
 */
export function pendingAfterSendFailure(
  list: PendingMessage[],
  clientMsgId: string,
  error: unknown
): { list: PendingMessage[]; dropped: boolean } {
  if (isMessageBeforeLeave(error)) return { list: removePending(list, clientMsgId), dropped: true };
  return { list: failPending(list, clientMsgId), dropped: false };
}
