import { ApiError } from "../../lib/api";
import type { MembershipRole } from "../../lib/api";
import { serverSaysAbsent } from "../capabilities/serverSurfaces";
import {
  MEMORY_ITEM_KINDS,
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemOrigin,
  type MemoryItemStatus,
  type MemoryProposal,
} from "./model";

// =============================================================================
// 「기억해 둘게요」 제안 카드 + 기억 브라우저의 표현 규칙 (ADR-0196 D9 · D12 V3/V4,
// #3170). 화면(웹 #3170, 폰 #3171)이 같은 문장과 같은 판정을 읽도록 한 자리에 둔다.
//
// 세 가지가 이 파일을 붙든다.
//
//   1. 클라이언트는 권한을 만들지 않는다. 손님(워크스페이스 역할)만 미리 읽기
//      전용으로 그리고, 채널 역할이 손님인 경우·모르는 id는 서버의 403이 두 번째
//      벽이다. 403과 404는 「권한 없음」과 「없음」을 구분해 말하지 않는다.
//   2. 잊기 문구는 「다시는 나타나지 않는다」를 약속하지 않는다. 이미 만들어진
//      요약에는 다시 만들어질 때까지 남아 있을 수 있다(D9 증보, 보안 검수 M-5).
//   3. 서버 어휘(`origin`, 이벤트 `action`)는 화면에 그대로 나오지 않는다.
// =============================================================================

// ---- 어휘 -------------------------------------------------------------------

export const MEMORY_KIND_LABEL: Readonly<Record<MemoryItemKind, string>> = {
  decision: "결정",
  fact: "사실",
  commitment: "약속",
  preference: "선호",
  procedure: "절차",
};

export function memoryKindLabel(kind: MemoryItemKind): string {
  return MEMORY_KIND_LABEL[kind];
}

export const MEMORY_ORIGIN_LABEL: Readonly<Record<MemoryItemOrigin, string>> = {
  extracted: "자동으로 찾았어요",
  confirmed: "사람이 확인했어요",
  curated: "사람이 고쳐 썼어요",
  synthesized: "여러 기억을 합쳐 만들었어요",
};

export function memoryOriginLabel(origin: MemoryItemOrigin): string {
  return MEMORY_ORIGIN_LABEL[origin];
}

/** 원장 사건의 이름. 모르는 값은 서버 어휘를 그대로 노출하지 않고 일반 문장으로 접는다. */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  created: "만들어졌어요",
  confirmed: "사람이 확인했어요",
  edited: "고쳐 썼어요",
  merged: "비슷한 기억과 합쳐졌어요",
  superseded: "새 버전으로 바뀌었어요",
  retired: "더 이상 쓰지 않아요",
  served: "에이전트 답에 실렸어요",
  withheld: "이 채널이라 싣지 않았어요",
};

export const MEMORY_EVENT_FALLBACK = "기록이 남았어요";

export function memoryEventLabel(action: string): string {
  return EVENT_LABEL[action] ?? MEMORY_EVENT_FALLBACK;
}

export const MEMORY_STATUS_OPTIONS: ReadonlyArray<{
  value: MemoryItemStatus;
  label: string;
}> = [
  { value: "active", label: "지금 쓰는 기억" },
  { value: "history", label: "지난 버전" },
  { value: "all", label: "전체" },
];

export const MEMORY_KIND_OPTIONS: ReadonlyArray<{
  value: MemoryItemKind;
  label: string;
}> = MEMORY_ITEM_KINDS.map((value) => ({ value, label: MEMORY_KIND_LABEL[value] }));

export function isMemoryKind(value: string | null | undefined): value is MemoryItemKind {
  return MEMORY_ITEM_KINDS.some((kind) => kind === value);
}

export function isMemoryStatus(value: string | null | undefined): value is MemoryItemStatus {
  return value === "active" || value === "history" || value === "all";
}

// ---- 누가 무엇을 하나 --------------------------------------------------------

/**
 * 워크스페이스 역할이 손님이면 결정·편집·잊기를 미리 접는다. 채널 역할이 손님인 사람은
 * 여기서 알 수 없어서 서버의 403이 막는다(그때 카드는 읽기 전용으로 바뀐다).
 */
export function memberMayWriteMemory(role: MembershipRole | undefined): boolean {
  return role !== "guest";
}

/** 새 버전이 없고 내려가지도 않은 항목만 고치거나 잊을 수 있다(그 밖은 서버가 409). */
export function isCurrentMemoryItem(
  item: Pick<MemoryItem, "retiredAtMs" | "supersededById">
): boolean {
  return item.retiredAtMs === undefined && item.supersededById === undefined;
}

// ---- 제안 카드 ---------------------------------------------------------------

export const PROPOSAL_HEADING = "기억해 둘게요";
export const PROPOSAL_NOT_SAVED_YET =
  "기억하기를 누르기 전에는 아무것도 저장되지 않아요.";
export const PROPOSAL_ACCEPT_LABEL = "기억하기";
export const PROPOSAL_REJECT_LABEL = "아니요";
export const PROPOSAL_SELF_ACCEPT_WARNING =
  "내가 부탁한 답에서 나온 제안이에요. 근거를 한 번 더 확인해 주세요.";
export const PROPOSAL_GUEST_READONLY =
  "손님은 기억을 결정할 수 없어요. 제안 내용만 볼 수 있어요.";
export const PROPOSAL_EVIDENCE_HEADING = "근거 메시지";
export const PROPOSAL_EVIDENCE_LOADING = "원본을 불러오고 있어요.";
export const PROPOSAL_EVIDENCE_UNAVAILABLE = "원본을 불러오지 못했어요.";
export const PROPOSAL_EVIDENCE_GONE = "지워졌거나 볼 수 없는 메시지예요.";
export const PROPOSAL_ACCEPTED = "기억했어요.";
export const PROPOSAL_REJECTED = "기억하지 않기로 했어요.";
export const PROPOSAL_OPEN_MEMORY = "기억 보기";
export const PROPOSAL_UNKNOWN_MEMBER = "알 수 없는 멤버";

export function proposalByLine(agentName: string): string {
  return `${agentName}의 제안이에요`;
}

export type ProposalErrorKind = "forbidden" | "conflict" | "failed";

export interface ProposalErrorView {
  kind: ProposalErrorKind;
  message: string;
  /** 서버의 현재 상태를 다시 읽어야 하는가 (이미 결정됐거나 만료된 경우). */
  refetch: boolean;
}

export const PROPOSAL_FORBIDDEN_MESSAGE =
  "이 제안은 내가 결정할 수 없어요. 손님이거나, 볼 수 없는 제안이에요.";
export const PROPOSAL_CONFLICT_MESSAGE =
  "이미 다른 분이 처리했거나 기간이 지났어요. 지운 내용이라 기억할 수 없는 경우도 있어요. 지금 상태를 다시 불러왔어요.";
export const PROPOSAL_FAILED_MESSAGE =
  "처리하지 못했어요. 연결을 확인하고 다시 시도해 주세요.";

/**
 * accept/reject의 실패를 카드 상태로 옮긴다. 403은 「권한 없음」과 「모르는 id」가 같은
 * 답이라 어느 쪽인지 말하지 않는다. 409는 이미 결정됨·만료·억제(잊은 내용)·근거 변경
 * 전부를 한 문장으로 말한다.
 */
export function proposalDecisionError(error: unknown): ProposalErrorView {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return { kind: "forbidden", message: PROPOSAL_FORBIDDEN_MESSAGE, refetch: false };
    }
    if (error.status === 409) {
      return { kind: "conflict", message: PROPOSAL_CONFLICT_MESSAGE, refetch: true };
    }
  }
  return { kind: "failed", message: PROPOSAL_FAILED_MESSAGE, refetch: false };
}

export interface ProposalCardModel {
  /** 수락·거절 버튼을 그리는가. */
  canDecide: boolean;
  /** 읽기 전용일 때의 이유. `canDecide`가 true면 null. */
  readOnlyReason: string | null;
  /** 자기 수락 경고를 그리는가. 경고일 뿐 막지 않는다(요청자에게 특권도 금지도 없다). */
  warnSelfAccept: boolean;
}

export function deriveProposalCard(input: {
  proposal: Pick<MemoryProposal, "status" | "callerIsRequester">;
  role: MembershipRole | undefined;
}): ProposalCardModel {
  const pending = input.proposal.status === "pending";
  const mayWrite = memberMayWriteMemory(input.role);
  return {
    canDecide: pending && mayWrite,
    readOnlyReason: pending && !mayWrite ? PROPOSAL_GUEST_READONLY : null,
    warnSelfAccept: pending && input.proposal.callerIsRequester,
  };
}

/**
 * 근거 메시지를 「이 채널의 seq 구간」으로 한 번에 읽을 수 있는가. 근거는 최대 8개이고
 * 보통 한 대화 안이라 한 번의 페이지 읽기로 끝나지만, 멀리 떨어지면 낭비이므로 구간이
 * 이 값을 넘으면 개별로 읽는다.
 */
export const EVIDENCE_RANGE_MAX = 60;

export function evidenceSeqRange(seqs: readonly number[]): { after: number; limit: number } | null {
  if (seqs.length === 0) return null;
  const low = Math.min(...seqs);
  const high = Math.max(...seqs);
  const span = high - low + 1;
  if (span > EVIDENCE_RANGE_MAX) return null;
  return { after: low - 1, limit: span };
}

// ---- 브라우저 ----------------------------------------------------------------

export const BROWSER_TITLE = "기억";
export const BROWSER_LEAD =
  "팀이 기억해 두기로 한 것들이에요. 내가 볼 수 있는 기억만 나와요.";
export const BROWSER_SEARCH_LABEL = "기억 검색";
export const BROWSER_SEARCH_PLACEHOLDER = "기억 내용 검색";
export const BROWSER_SEARCH_NOTE =
  "검색 결과는 관련도 순이고, 최대 50개까지 보여요.";
export const BROWSER_ALL_CHANNELS = "모든 채널";
export const BROWSER_ALL_KINDS = "모든 종류";
export const BROWSER_PERSONAL_SPACE = "개인 공간";
export const BROWSER_EMPTY_HEADLINE = "아직 기억이 없어요.";
export const BROWSER_EMPTY_DETAIL =
  "채널에서 에이전트가 「기억해 둘게요」를 제안하고 누군가 기억하기를 누르면 여기에 쌓여요.";
export const BROWSER_NO_MATCH_HEADLINE = "조건에 맞는 기억이 없어요.";
export const BROWSER_NO_MATCH_DETAIL = "필터를 바꾸거나 다른 말로 검색해 보세요.";
export const BROWSER_LOAD_ERROR = "기억을 불러오지 못했어요.";
export const BROWSER_LOAD_MORE = "더 보기";
export const BROWSER_PICK_ONE = "왼쪽에서 기억을 고르면 자세히 볼 수 있어요.";
export const BROWSER_BACK_TO_LIST = "목록으로";
export const BROWSER_PAUSED_NOTICE =
  "내 기억 일시정지가 켜져 있어서 새 기억을 모으지 않아요. 이미 있는 기억은 그대로 보여요.";
export const BROWSER_PAUSED_LINK = "설정에서 바꾸기";
export const BROWSER_GUEST_READONLY =
  "손님은 기억을 읽을 수만 있어요. 고치거나 잊는 건 멤버만 할 수 있어요.";
export const BROWSER_NOT_CURRENT =
  "지난 버전이라 고치거나 잊을 수 없어요. 최신 버전에서 해 주세요.";
export const BROWSER_OPEN_NEWER = "최신 버전 보기";
export const BROWSER_OPEN_ITEM_GONE = "없는 기억이거나 볼 수 없는 기억이에요.";

export const DETAIL_EVIDENCE_HEADING = "근거 메시지";
export const DETAIL_EVIDENCE_EMPTY = "연결된 근거 메시지가 없어요.";
export const DETAIL_HISTORY_HEADING = "이력";
export const DETAIL_HISTORY_EMPTY = "남은 기록이 없어요.";
export const DETAIL_HISTORY_ERROR = "이력을 불러오지 못했어요.";
export const DETAIL_EVIDENCE_NOTE = "근거를 누르면 원본 메시지로 이동해요.";

export function editedByLine(memberName: string | null, atLabel: string | null): string {
  const who = memberName ?? "알 수 없는 멤버";
  return atLabel === null ? `고친 사람 ${who}` : `고친 사람 ${who} · ${atLabel}`;
}

export const EDIT_LABEL = "고치기";
export const EDIT_SAVE = "저장";
export const EDIT_CANCEL = "취소";
export const EDIT_FIELD_LABEL = "기억 내용";
export const EDIT_NOTICE =
  "고치면 예전 글은 이력에 남아요. 내용을 아예 없애려면 「잊기」를 써요.";
export const EDIT_MAX_CHARS = 600;
export const EDIT_SAVED = "고쳤어요. 예전 글은 이력에 남았어요.";

export function editCharCount(text: string): string {
  return `${[...text].length}/${EDIT_MAX_CHARS}`;
}

/** 저장 가능한 글인가. 서버의 22023(같은 글)과 별개로 빈 글·길이만 미리 거른다. */
export function editDraftProblem(draft: string, original: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === "") return "내용을 적어 주세요.";
  if ([...trimmed].length > EDIT_MAX_CHARS) return `${EDIT_MAX_CHARS}자까지 적을 수 있어요.`;
  if (trimmed === original.trim()) return "바뀐 내용이 없어요.";
  return null;
}

export const FORGET_LABEL = "잊기";
export const FORGET_TITLE = "이 기억을 잊을까요?";
/**
 * 약속하지 않는 문장: 지운 항목과 이전 버전은 바로 사라지지만, 이미 만들어진 요약은
 * 다시 만들어질 때까지 그 내용을 들고 있을 수 있다(ADR-0196 D9 증보).
 */
export const FORGET_DESCRIPTION =
  "이 기억을 지워요. 이미 만들어진 요약에는 다시 만들어질 때까지 남아 있을 수 있어요.";
export const FORGET_IRREVERSIBLE = "지운 기억은 되돌릴 수 없어요.";
export const FORGET_CONFIRM = "잊기";
export const FORGET_CANCEL = "취소";
export const FORGET_BUSY = "지우는 중";

export function forgottenNotice(count: number): string {
  return count > 1
    ? `잊었어요. 이전 버전까지 ${count}개를 지웠어요.`
    : "잊었어요.";
}

export type ItemWriteAction = "edit" | "forget";

export interface ItemWriteErrorView {
  message: string;
  /** 목록·상세를 다시 읽어야 하는가. */
  refetch: boolean;
  /** 이 항목이 더는 없다(또는 볼 수 없다). 상세를 닫는다. */
  gone: boolean;
}

export const ITEM_FORBIDDEN_MESSAGE = "손님은 기억을 고치거나 잊을 수 없어요.";
export const ITEM_CONFLICT_MESSAGE =
  "그 사이 새 버전이 생겼거나 내려간 기억이에요. 지금 상태를 다시 불러왔어요.";
export const ITEM_EDIT_REFUSED_MESSAGE =
  "저장하지 못했어요. 바뀐 내용이 있는지, 저장할 수 있는 글인지 확인해 주세요.";
export const ITEM_WRITE_FAILED_MESSAGE =
  "처리하지 못했어요. 연결을 확인하고 다시 시도해 주세요.";

/**
 * 편집·잊기의 실패. 404는 「없음」과 「볼 수 없음」이 같은 답이라 한 문장이다. 422는
 * 「바뀐 게 없음」과 「숨은 쌍둥이가 있음」이 같은 답이라 이유를 좁혀 말하지 않는다.
 */
export function itemWriteError(error: unknown, action: ItemWriteAction): ItemWriteErrorView {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return { message: ITEM_FORBIDDEN_MESSAGE, refetch: false, gone: false };
    }
    if (error.status === 404) {
      return { message: BROWSER_OPEN_ITEM_GONE, refetch: true, gone: true };
    }
    if (error.status === 409) {
      return { message: ITEM_CONFLICT_MESSAGE, refetch: true, gone: false };
    }
    if (error.status === 422 && action === "edit") {
      return { message: ITEM_EDIT_REFUSED_MESSAGE, refetch: false, gone: false };
    }
  }
  return { message: ITEM_WRITE_FAILED_MESSAGE, refetch: false, gone: false };
}

/**
 * 읽기 실패. 목록의 404는 서버에 경로가 없다는 뜻이고, 상세의 404는 그 항목이 없거나
 * 볼 수 없다는 뜻이다(둘은 구분되지 않는다). 그래서 어느 쪽을 읽었는지 받는다.
 */
export function itemReadError(
  error: unknown,
  scope: "list" | "detail"
): {
  kind: "absent" | "gone" | "failed";
  message: string;
} {
  if (scope === "detail" && error instanceof ApiError && error.status === 404) {
    return { kind: "gone", message: BROWSER_OPEN_ITEM_GONE };
  }
  if (serverSaysAbsent(error)) {
    return { kind: "absent", message: "이 서버는 아직 팀 기억을 지원하지 않아요." };
  }
  return { kind: "failed", message: BROWSER_LOAD_ERROR };
}
