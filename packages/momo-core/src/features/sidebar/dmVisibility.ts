import type { ReadProjectionPhase } from "./goneDm";

// =============================================================================
// DM 보임 판정 - 웹·폰이 읽는 **한 함수** (ADR-0177 증보 D8, #4228).
//
// 한 DM 이 사이드바에 서는가를 이 파일 한 곳이 정한다. 입력은 서버가 읽음 투영(`GET read-state`)에 실은 두 사실
// (`closedAtSeq`·`latestReadableSeq`)과 행이 이미 아는 값뿐이고, 위에서부터 **처음 맞는 줄**이 답이다.
//
//   # 조건                                                         결과
//   1 isOpen                                                       보임 (보는 대화는 목록에서 사라지지 않는다)
//   2 phase = error                                                보임 (모를 때 숨기는 쪽이 최악이다)
//   3 phase = loading                                              직전 판정 유지 (hold)
//   4 starredOrSectioned                                           보임 (D1 의 명시적 의도. 이런 DM 에는 닫기를 내밀지 않는다)
//   5 markedUnreadBeforeSeq ≠ null 또는 mentionCount > 0           보임 (사람이 직접 남긴 신호)
//   6 counterpart = gone 이고 latestReadableSeq ≤ lastReadSeq      숨김 (나간 상대, 안 읽은 것 없음 - 명시적 닫기·되살림보다 먼저)
//   7 closedAtSeq ≠ null 이고 latestReadableSeq ≤ closedAtSeq      숨김 (명시적 닫기)
//   8 closedAtSeq ≠ null 이고 latestReadableSeq > closedAtSeq      보임 (닫은 뒤 읽을 메시지가 옴 - 되살림)
//   9 그 밖                                                        보임
//
// ## `closedAtSeq` 는 세 상태다 - `undefined` 를 `null` 로 바꾸지 않는다
//
//   number     내가 그 seq 에서 닫았다.
//   null       투영이 「안 닫았다」고 말했다.
//   undefined  이 응답이 말하지 않았다(옛 서버, `PUT read-state` 응답).
//
// `undefined` 를 `null` 로 읽으면 닫은 DM 이 되살아난다. 그래서 6번 뒤에서 `undefined` 는 3번과 같이 **직전 판정 유지**다
// (`hold`). 6번은 이 값을 읽지 않으므로 그 앞에서 정해지는 줄은 영향이 없다.
//
// `counterpart = unknown`(명부 미완·미수신)이면 6번을 적용하지 않는다. 비어 있는 명부 앞에서 모든 DM 이 「나간 멤버」가
// 되는 것을 막는다.
//
// ## 결과가 `hold` 인 이유
//
// 이 함수는 순수하다: 「직전」이 무엇인지 모른다. 호출부가 마지막 판정(또는 마지막 투영의 캐시로 다시 돌린 판정)을 들고 있다가
// `hold` 를 그것으로 바꾼다. 들고 있는 것이 없으면(재설치 직후의 첫 페인트) 투영이 올 때까지 판정을 미룬다(골격).
// =============================================================================

export type DmCounterpart = "present" | "gone" | "unknown";

export type DmVisibility = "shown" | "hidden" | "hold";

/** D8 표의 줄 번호. 「닫은 대화」 목록이 6(나간 상대)과 7(명시적 닫기)을 가르는 데도 쓴다. */
export type DmVisibilityRule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface DmVisibilityInput {
  /** 지금 보고 있는 DM 인가. */
  isOpen: boolean;
  /** 별표했거나 커스텀 섹션에 넣은 DM 인가. */
  starredOrSectioned: boolean;
  /** 내가 닫은 seq. 세 상태(위 머리말). */
  closedAtSeq: number | null | undefined;
  /** 사람이 읽을 마지막 seq(기계 메시지는 세지 않는다). */
  latestReadableSeq: number;
  lastReadSeq: number;
  /** 사람이 직접 한 「여기부터 안 읽음」. `null` 이면 없다. */
  markedUnreadBeforeSeq: number | null;
  mentionCount: number;
  counterpart: DmCounterpart;
  phase: ReadProjectionPhase;
}

export interface DmVisibilityVerdict {
  visibility: DmVisibility;
  rule: DmVisibilityRule;
}

function verdict(visibility: DmVisibility, rule: DmVisibilityRule): DmVisibilityVerdict {
  return { visibility, rule };
}

export function dmVisibility(input: DmVisibilityInput): DmVisibilityVerdict {
  if (input.isOpen) return verdict("shown", 1);
  if (input.phase === "error") return verdict("shown", 2);
  if (input.phase === "loading") return verdict("hold", 3);
  if (input.starredOrSectioned) return verdict("shown", 4);
  if (input.markedUnreadBeforeSeq !== null || input.mentionCount > 0) {
    return verdict("shown", 5);
  }
  if (input.counterpart === "gone" && input.latestReadableSeq <= input.lastReadSeq) {
    return verdict("hidden", 6);
  }
  // 이 응답이 닫힘을 말하지 않았다: 안 닫았다는 뜻이 아니다. 직전 판정을 유지한다.
  if (input.closedAtSeq === undefined) return verdict("hold", 3);
  if (input.closedAtSeq !== null) {
    return input.latestReadableSeq <= input.closedAtSeq ? verdict("hidden", 7) : verdict("shown", 8);
  }
  return verdict("shown", 9);
}

/**
 * 이 DM 에 닫기를 내미는가 - 호버 X 와 행 메뉴 「대화 닫기」가 **같은 한 함수**를 읽는다(D7).
 *
 *   * 읽음 투영이 준비된 뒤에만: 닫을 때 `seenSeq` 로 적을 최신 seq 가 있어야 한다.
 *   * 안 읽은 메시지(멘션 포함)가 있으면 내밀지 않는다(2026-10-17 소유자 결정).
 *   * 별표했거나 커스텀 섹션에 넣은 DM 에는 내밀지 않는다. 그 대신 「별표를 먼저 빼요」로 안내한다(`dmCloseBlockedByStar`).
 */
export function dmCloseOffered(input: {
  phase: ReadProjectionPhase;
  unreadCount: number;
  mentionCount: number;
  starredOrSectioned: boolean;
}): boolean {
  return (
    input.phase === "ready" &&
    input.unreadCount <= 0 &&
    input.mentionCount <= 0 &&
    !input.starredOrSectioned
  );
}

/** 닫기를 내밀지 않은 이유가 별표·섹션뿐인가 - 그때만 「별표를 먼저 빼요」 안내가 선다. */
export function dmCloseBlockedByStar(input: {
  phase: ReadProjectionPhase;
  unreadCount: number;
  mentionCount: number;
  starredOrSectioned: boolean;
}): boolean {
  return (
    input.starredOrSectioned &&
    dmCloseOffered({ ...input, starredOrSectioned: false })
  );
}

/** D7 이 닫기를 막는 DM 에 건네는 안내. */
export const DM_CLOSE_STAR_FIRST_HINT = "별표를 먼저 빼요";

/**
 * 「⋯ › 닫은 대화」 목록에 들어가는가(D11): 숨겨진 DM 중 명시적 닫기(7)와 나간 상대(6)만이다. 지금 사이드바에 보이는
 * 대화는 넣지 않는다.
 */
export function dmClosedListReason(rule: DmVisibilityRule): "closed" | "gone" | null {
  if (rule === 7) return "closed";
  if (rule === 6) return "gone";
  return null;
}

// ---- 「⋯ › 닫은 대화」 문구 (D11). 웹 다이얼로그와 폰 시트가 같은 낱말을 쓴다. ----------------------------------------

/** DM 구역 머리의 「⋯」 메뉴 항목이자 목록의 제목. */
export const DM_CLOSED_LIST_LABEL = "닫은 대화";

/** 목록 행의 동작. 닫은 DM 을 다시 연다. */
export const DM_REOPEN_LABEL = "다시 열기";

/** 목록 머리의 한 줄. 닫기는 지우기가 아니라는 것과 돌아오는 조건을 말한다. */
export const DM_CLOSED_LIST_HINT =
  "닫은 대화와 나간 멤버와의 대화예요. 닫은 대화는 새 메시지가 오면 사이드바에 돌아와요.";

/** 목록 행의 이유 줄. `closed` 는 내가 닫았고, `gone` 은 상대가 나갔다. */
export function dmClosedReasonLabel(reason: "closed" | "gone"): string {
  return reason === "closed" ? "내가 닫았어요" : "상대가 나갔어요";
}

/** 목록이 비었을 때 메뉴가 말하는 한 줄(항목이 없는 메뉴는 문이 아니다). */
export const DM_CLOSED_LIST_EMPTY = "닫은 대화가 없어요.";
