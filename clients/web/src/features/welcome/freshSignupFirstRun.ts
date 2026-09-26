import type { LoginResponse } from "@momo/core/lib/api";
import { markFirstAgentPending } from "./firstAgentStore";
import { markFreshSignup } from "./freshSignup";
import { holdKickoffForFreshSignup } from "./firstRunGate";
import { markPhoneLinkCardPending } from "./phoneLinkCardStore";

// =============================================================================
// first-run 마커 기록 (#2301).
//
// 로그인 뒤 first-run 이 읽는 마커는 넷이고(폰 연결 카드는 게이트가 아니라 첫 대화
// 채널이 읽는다, #2818), 쓰는 곳은
// invite-join(ConnectPage)과 셀프호스트 claim(ClaimPage) 둘이다. 두 경로가 이
// 파일의 함수 하나를 부른다 — claim 이 markFreshSignup 하나만 찍어 kickoff-hold ·
// first-agent · phone-link 가 전부 스킵됐던 결함이 다시 갈라지지 않게. 순서는
// invite-join 이 처음 찍던 순서 그대로다.
// =============================================================================

/**
 * 모든 join 이 찍는 pending 둘: 폰 연결 카드(ADR-0180 D7 → ADR-0193 D7, 게이트가
 * 아니라 첫 대화 채널 카드) · 첫 에이전트(#2216).
 */
export function recordFirstRunPending(workspaceId: string): void {
  markPhoneLinkCardPending(workspaceId);
  markFirstAgentPending(workspaceId);
}

/**
 * 멤버가 새로 생긴 세션(invite-join `createdMember` · claim)이 찍는 넷.
 * 킥오프 홀드는 fresh-signup 마커와 짝이다 — `peekKickoffSettled()` 가 마커
 * 부재를 settled 로 읽으므로 홀드만 걸면 게이트는 홀드를 보지 못한다.
 */
export function recordFreshSignupFirstRun(session: LoginResponse): void {
  recordFirstRunPending(session.member.workspaceId);
  markFreshSignup({
    workspaceId: session.member.workspaceId,
    memberId: session.member.id,
  });
  holdKickoffForFreshSignup();
}
