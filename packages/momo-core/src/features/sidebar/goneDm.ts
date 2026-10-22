import type { ChannelLabelKind } from "../workspace/directory";

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
//   * 안 읽은 메시지나 멘션이 있으면 보인다. 숫자는 **행이 그리는 값 그대로**다(합성 안 읽음, ADR-0178
//     D3). 행의 알약과 숨김이 같은 사실을 말한다. 나간 상대는 자격이 폐기돼 새 메시지를 쌓을 길이
//     거의 없으므로 기계 메시지(`dmRevival`의 `isAmbientMessage`)를 따로 가르지 않는다. 읽으면 접힌다.
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
}): boolean {
  if (input.labelKind !== "gone") return false;
  if (!input.rosterComplete) return false;
  if (input.isOpen) return false;
  if (input.phase === "error") return false;
  if (input.phase === "loading") return true;
  return input.unreadCount <= 0 && input.mentionCount <= 0;
}

/** DM 구역 끝의 조용한 줄. 접힌 나간 멤버 DM 의 수를 센다. */
export function goneDmDisclosureLabel(count: number): string {
  return `나간 멤버와의 대화 ${count}개`;
}
