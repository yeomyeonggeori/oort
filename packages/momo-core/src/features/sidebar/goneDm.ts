import type { ChannelLabelKind } from "../workspace/directory";
import { composedUnreadCount, type UnreadCountInput } from "../readState/model";

// =============================================================================
// 나간 멤버와의 대화는 사이드바에서 기본으로 접어 둔다 (#4252, 성재 2026-10-20·22:
// 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」).
//
// ## 사실
//
// 상대가 명부에 없으면(나감·정지·은퇴·꺼 둔 개인 에이전트) DM 은 「나간 멤버」라는 이름으로 남는다.
// 기록을 지키려고 채널은 지우지 않는다. 지금까지 그 대화는 목록에 영영 있었고, X 로 닫은 것은 그 기기
// 로컬 원장(`sidebarDmClosure.ts`)에만 적혀 다른 기기·데이터 초기화 뒤에는 도로 보였다. 서버 계약을
// 건드리지 않고(기기 간 닫기 동기화는 #4226~#4228) 낼 수 있는 규칙이 이 파일이다.
//
// ## 규칙: 웹과 폰이 이 한 함수를 읽는다
//
// 상대가 명부에 없고(`labelKind === "gone"`) 안 읽은 것이 없으면 숨긴다. 「나간 멤버와의 대화 N개」
// 줄이 접힌 대화를 센다. 숨김은 목록의 진열일 뿐이다: ⌘K·검색은 숨긴 대화도 연다.
//
//   * `gone` 만 후보다. 명부를 아직 못 받은 「불러오는 중」(`pending`)은 절대 숨기지 않는다. 명부가
//     오기 전의 한 프레임에 DM 이 전부 사라졌다 돌아오고 N 이 깜빡이면 안 된다.
//   * 지금 열려 있는 DM 은 숨기지 않는다. 보고 있는 대화가 목록에서 사라지면 자기가 어디에 있는지
//     모른다(닫기 원장과 같은 이유). 다른 곳으로 옮겨 가면 접힌다.
//   * 안 읽은 **사람이 읽을** 메시지나 멘션이 있으면 보인다(이슈 AC 「안 읽은 사람 메시지」). 숫자는 **행이 그리는 값
//     그대로**다(합성 안 읽음, ADR-0178 D3): 행의 알약과 숨김이 같은 사실에서 출발한다. 그런데 안 읽음은 기계 메시지(작업
//     상태·영수증, `isAmbientMessage`)도 센다. 꺼 둔 에이전트의 DM 은 끈 직후 그런 줄이 안 읽음으로 쌓여 있어서, 숫자만 보면
//     「추방했는데 왜 자꾸 떠요」가 그대로다. 그래서 안 읽음이 있는 후보만 안 읽은 쪽을 **한 번** 읽어 가른다
//     (`goneUnreadProbeAfterSeq` → 호출부가 읽는다 → `GoneUnreadVerdict`). 판정은 이렇게 돈다:
//       - 사람이 읽을 것이 있다(`human`) · 못 읽었다(`error`) · 확인할 메시지 읽기 대상이 아니다(멘션, 사람이 직접 한
//         「여기부터 안 읽음」, 판정을 안 준 호출) -> 보인다. 모를 때 숨기는 쪽이 최악이다.
//       - 기계 메시지뿐이다(`ambient`) · 아직 읽는 중이다(`pending`) -> 접힌다. 읽는 중에 깜빡이며 나타나지 않는다.
//   * 읽음 투영이 오는 중이면 접힌 채로 둔다(기본이 숨김이라 조용한 쪽이다). 못 읽었으면 **보인다**:
//     안 읽은 것이 있는지 모를 때 숨기는 쪽이 최악이다(닫기 원장의 `dmHiddenByClosure`와 같은 갈래).
//   * **명부를 믿을 수 있을 때만** 접는다. 「나간 멤버」는 「명부에 없다」의 다른 말이라, 명부가 틀리면 멀쩡한
//     대화가 나간 멤버가 된다. 틀리는 길이 둘 있다: 명부 조회가 실패했는데 명부 도착 판정만 참인 경우(비어
//     있는 명부 앞에서는 모든 DM 이 「나간 멤버」다 - `rosterLoaded`), 그리고 서버가 한 번에 200 명까지만
//     주는 명부가 한도에서 잘린 경우(`rosterIsComplete`). 둘 다 접지 않는 쪽으로 진다.
//
// 닫기 원장과의 관계: 원장은 사람이 X 로 닫은 대화를 먼저 거르고, 이 규칙은 **그 뒤에 남은** 대화에만
// 건다. 둘은 서로의 입력이 아니다.
// =============================================================================

/**
 * 서버 read-state 투영이 어디까지 왔는가. 쿼리의 세 플래그에서 갈라 읽는다: 한 번 읽은 뒤의
 * 배경 재조회 실패는 `ready` 다(손에 든 투영이 있다). 위험한 것은 「한 번도 못 읽었다」 하나다.
 */
export type ReadProjectionPhase = "loading" | "error" | "ready";

export function readProjectionPhase(query: {
  isPending: boolean;
  isError?: boolean;
  data?: unknown;
}): ReadProjectionPhase {
  if (query.isPending) return "loading";
  if (query.isError === true && query.data === undefined) return "error";
  return "ready";
}

/**
 * 서버 명부는 한 번에 이만큼까지만 준다(`ROSTER_LIMIT_DEFAULT`, 클라는 한도를 올려 달라고 하지 않는다). 명부가
 * 이 수에 닿으면 뒤쪽 멤버가 잘려 나갔을 수 있어, 그 멤버와의 DM 이 「나간 멤버」로 읽힌다.
 */
export const ROSTER_PAGE_SIZE = 200;

/** 명부가 한도에서 잘리지 않았다고 믿을 수 있는가. 한도에 닿았으면 모른다. */
export function rosterIsComplete(memberCount: number): boolean {
  return memberCount < ROSTER_PAGE_SIZE;
}

/**
 * 명부를 받았나. 쿼리의 세 플래그에서 갈라 읽는다(`readProjectionPhase` 와 같은 문법): 오는 중이거나, 한 번도
 * 못 받은 채 실패했으면 아니다. 받은 뒤의 배경 재조회 실패는 손에 든 명부가 있어 `true` 다.
 */
export function rosterLoaded(query: {
  isPending: boolean;
  isError?: boolean;
  data?: unknown;
}): boolean {
  if (query.isPending) return false;
  return !(query.isError === true && query.data === undefined);
}

/**
 * 이 DM 을 사이드바에서 숨기는가(나간 멤버와의 대화). 규칙과 근거는 머리말에 있다.
 *
 * 입력은 행이 이미 아는 것뿐이다: `labelKind` 는 `channelLabelParts(...).kind` 그대로이고, 두 숫자는
 * 행의 알약이 그리는 값(열려 있는 DM 은 0 으로 접힌 값)이다.
 */
export function dmHiddenAsGone(input: {
  labelKind: ChannelLabelKind;
  /** 명부를 믿을 수 있나(`rosterIsComplete`). 잘렸을 수 있으면 「없다」가 「나갔다」가 아니다. */
  rosterComplete: boolean;
  unreadCount: number;
  mentionCount: number;
  /** 지금 보고 있는 DM 인가. */
  isOpen: boolean;
  phase: ReadProjectionPhase;
  /**
   * 안 읽은 쪽의 판정(머리말). 생략하면 모른다: 안 읽음이 있으면 보인다. 안 읽음이 없으면 쓰지 않는다.
   */
  unreadVerdict?: GoneUnreadVerdict;
}): boolean {
  if (input.labelKind !== "gone") return false;
  if (!input.rosterComplete) return false;
  if (input.isOpen) return false;
  if (input.phase === "error") return false;
  if (input.phase === "loading") return true;
  if (input.mentionCount > 0) return false;
  if (input.unreadCount <= 0) return true;
  return input.unreadVerdict === "ambient" || input.unreadVerdict === "pending";
}

/**
 * 안 읽은 쪽을 읽은 결과. `human` 사람이 읽을 메시지가 있다 · `ambient` 기계 메시지뿐이다 · `pending` 읽는 중이다 ·
 * `error` 못 읽었다.
 */
export type GoneUnreadVerdict = "human" | "ambient" | "pending" | "error";

/**
 * 이 DM 의 안 읽음이 사람이 읽을 것인지 **메시지를 읽어 가려야** 하는가. 가려야 하면 그 쪽을 읽을 기준 seq(`after`:
 * 이 seq **뒤**의 메시지)를, 아니면 `null` 을 준다. 웹과 폰의 훅이 같은 후보를 고르도록 규칙은 여기 한 곳이다.
 *
 * 가릴 필요가 없는 것: 후보가 아닌 DM(상대가 있다 · 명부를 못 믿는다 · 열려 있다 · 투영이 아직/못 왔다 - 이때는 메시지를
 * 읽어 봐야 쓸 곳이 없다), 안 읽음이 없는 DM(그냥 접힌다), 멘션이 있는 DM(사람이 부른 것), 사람이 직접 한 「여기부터 안 읽음」
 * 표시가 있는 DM(사람의 뜻이라 항상 보인다 - `effectiveUnreadStartSeq` 가 표시를 안 읽음의 시작으로 접는다).
 */
export function goneUnreadProbeAfterSeq(input: {
  labelKind: ChannelLabelKind;
  rosterComplete: boolean;
  isOpen: boolean;
  phase: ReadProjectionPhase;
  read: (UnreadCountInput & { mentionCount: number }) | null | undefined;
}): number | null {
  if (input.labelKind !== "gone") return null;
  if (!input.rosterComplete) return null;
  if (input.isOpen) return null;
  if (input.phase !== "ready") return null;
  const read = input.read;
  if (!read) return null;
  if (read.mentionCount > 0) return null;
  if (read.markedUnreadBeforeSeq != null) return null;
  if (composedUnreadCount(read) <= 0) return null;
  return read.lastReadSeq;
}

/**
 * 한 후보의 쿼리 상태에서 판정을 가른다(`readProjectionPhase` 와 같은 문법). 웹·폰의 `useQueries` 가 같은 함수를 읽는다.
 * `data` 는 「사람이 읽을 메시지가 있는가」(`pageHasHumanMessage`)다.
 */
export function goneUnreadVerdict(query: {
  isPending: boolean;
  isError?: boolean;
  data?: boolean;
}): GoneUnreadVerdict {
  if (query.isPending) return "pending";
  if (query.isError === true || query.data === undefined) return "error";
  return query.data ? "human" : "ambient";
}

/**
 * 후보들의 판정을 한 문자열로 접는다(`useQueries` 의 `combine` 결과). 원시값이라 판정이 같으면 참조가 같아서 소비자가 불필요하게
 * 다시 계산하지 않는다. id 는 소문자 uuid 라 `:`·`|` 를 품지 않는다.
 */
export function goneUnreadSignature(
  parts: ReadonlyArray<{ id: string; verdict: GoneUnreadVerdict }>
): string {
  return parts.map((part) => `${part.id}:${part.verdict}`).join("|");
}

/**
 * `goneUnreadSignature` 를 소문자 id -> 판정 맵으로 푼다. 웹과 폰의 훅이 같은 함수를 읽는다.
 *
 * **이미 한 번 가른 DM 은 새 쪽이 오는 동안 이전 판정을 유지한다**: 새 메시지가 오면 쿼리 키(안 읽음의 범위)가 바뀌어 다시
 * `pending` 이 되는데, 그때 사람이 읽을 안 읽음으로 보이던 DM 이 잠깐 접혔다 돌아오는 깜빡임이 없어야 한다. `settled` 는
 * 호출부가 렌더 사이에 들고 있는 기억이다. 유지는 **계속 후보인 DM** 의 키가 바뀌는 동안만이다: 다 읽어 후보에서 빠진 DM 은
 * 잊는다(나중에 새 안 읽음이 오면 새로 가른다). 못 읽은 `error` 는 유지하지 않는다(보이는 쪽이라 깜빡임이 없다).
 */
export function resolveGoneUnreadVerdicts(
  signature: string,
  settled: Map<string, "human" | "ambient">
): Map<string, GoneUnreadVerdict> {
  const verdicts = new Map<string, GoneUnreadVerdict>();
  for (const part of signature === "" ? [] : signature.split("|")) {
    const cut = part.lastIndexOf(":");
    const id = part.slice(0, cut);
    const verdict = part.slice(cut + 1) as GoneUnreadVerdict;
    if (verdict === "human" || verdict === "ambient") {
      settled.set(id, verdict);
      verdicts.set(id, verdict);
    } else if (verdict === "pending") {
      verdicts.set(id, settled.get(id) ?? "pending");
    } else {
      verdicts.set(id, verdict);
    }
  }
  for (const id of Array.from(settled.keys())) {
    if (!verdicts.has(id)) settled.delete(id);
  }
  return verdicts;
}

/** DM 구역 끝의 조용한 줄. 접힌 나간 멤버 DM 의 수를 센다. */
export function goneDmDisclosureLabel(count: number): string {
  return `나간 멤버와의 대화 ${count}개`;
}
