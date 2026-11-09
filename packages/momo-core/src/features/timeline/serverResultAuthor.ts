import type { Member } from "../../lib/api";

// =============================================================================
// 서버 결과 카드·칩은 작성자 종류와 함께 읽는다 (#5577, #5566 후속 2).
//
// 다음은 서버·워커가 **에이전트 멤버의 이름으로** 쓰는 사실이다. 작성자가 사람인 정상 행은 없다.
//   - 턴 기록: 「에이전트 실행 결과」 카드(`agentCardModel` 의 turn 갈래), 그 카드가 물들이는 diff·산출물
//     상태 칩, 제공자 전환 줄과 기억 영수증이 매달리는 「정착한 턴 기록」(`cascadeModel.turnRecordRunId`).
//     게이트웨이(`agent_gateway.rs` `timeline_props`)와 워커(`success_props`·`failure_props`)가 쓴다.
//   - 도우미 답의 꼬리: 「팀 AI · 모델」 칩·찾아본 것·출처(`teamAiReply`)와 「Hermes 도움」 칩
//     (`teamAiDelegation`). 도우미는 평범한 `member.kind='agent'` 다(ADR-0101).
//
// 그 표지(`source`·`schema`·`status`·`error_code` …)는 메시지 props 의 평범한 칸이다. 서버가 REST·웹훅에서
// 서버 값을 걸러도(`messages.rs` `is_server_provenance_entry`) 이미 저장된 행이 남고, `status`·`error` 처럼
// 너무 흔해 서버가 가져갈 수 없는 칸도 있다. 그래서 화면은 **작성자가 에이전트일 때만** 이 카드·칩을 세운다
// (ADR-0220 P1 「자기 보고를 확인된 값처럼 표시」 금지와 같은 줄이다).
//
// 작성자 종류는 메시지 props 가 아니라 워크스페이스 멤버 목록에서 온다: 화면이
// `memberFor(directory, message.authorMemberId)?.kind` 를 넘긴다. 모르면(목록이 아직 없음·목록에 없는 멤버)
// 그리지 않는다 — 닫힌 쪽이 기본이라, 넘기기를 잊은 새 호출자는 개발 중에 바로 드러난다.
// =============================================================================

/** 메시지 작성자의 멤버 종류. 늘 멤버 목록에서 읽는다(메시지 props 에서 읽지 않는다). */
export type AuthorKind = Member["kind"];

/** 서버 결과 카드·칩을 세울 수 있는 작성자인가: 에이전트 멤버뿐이다. 모르면 아니다. */
export function isAgentAuthored(authorKind: AuthorKind | null | undefined): boolean {
  return authorKind === "agent";
}
