import { ApiError, uuidEq, type RosterMember } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { groupDirectory, type DirectoryGroups } from "../directory/model";

// =============================================================================
// 채널에 멤버 추가 model (검수 #2). "멤버 초대하기"가 워크스페이스 초대 링크
// 생성기(/settings)로 보내던 막다른 길을, 채널에 사람을 넣는 실제 행동으로
// 바꾼다. 재료는 이미 있다: 로스터(fetchRoster)의 각 행이 자기 channelIds를
// 들고 있으므로, "이 사람이 이 채널에 있나"는 서버에 다시 묻지 않고 그 목록으로
// 답한다 — ChatShell의 memberSummary가 헤더 인원수를 세는 바로 그 방식이다.
//
// 여기 있는 것은 전부 순수 함수다. 다이얼로그의 목록(누구를 보이고 누구를
// 이미-멤버로 표시할지), 낙관적 갱신(추가하면 그 자리에서 채널에 들어간
// 것으로 보이기), 실패 문구가 전부 테스트 가능한 한 조각으로 여기 모인다.
// =============================================================================

/**
 * 이 멤버가 이미 이 채널에 있는가. 로스터 행이 자기 channelIds를 들고 오므로
 * 서버에 다시 묻지 않는다. `uuidEq`인 이유는 늘 같다: id가 두 응답(/roster와
 * 채널 목록)에서 서로 다른 대소문자로 오기 때문이다.
 */
export function isChannelMember(
  member: RosterMember,
  channelId: string
): boolean {
  return member.channelIds.some((id) => uuidEq(id, channelId));
}

/**
 * 로스터를 "이 채널에 추가할 사람 고르기" 목록으로. 나를 뺀 모두를 사람과
 * 에이전트로 나누고 검색어로 좁힌다(디렉터리와 같은 groupDirectory 규칙:
 * 이름 OR 핸들, 한글 우선 정렬).
 *
 * 이미 채널에 있는 사람도 목록에 남긴다 — 빼지 않는다. 방금 [추가]를 누른 행이
 * 커서 밑에서 사라지는 대신 그 자리에서 "멤버"로 바뀌게 하려는 것이고(낙관적
 * 갱신), 그래야 누가 이미 있는지도 한눈에 보인다. 행 각각이 이미-멤버인지는
 * `isChannelMember`로 판정한다.
 */
export function channelMemberCandidates(
  members: RosterMember[],
  selfMemberId: string,
  query: string
): DirectoryGroups {
  const others = members.filter((m) => !uuidEq(m.id, selfMemberId));
  return groupDirectory(others, query);
}

/**
 * 내가 이 채널에 넣을 수 있는 사람이 하나라도 있나(내가 아니고, 아직 채널에
 * 없는 사람). 빈 상태를 두 갈래로 가르는 데 쓴다: 워크스페이스에 다른 멤버가
 * 아예 없는 경우와, 있지만 전부 이미 이 채널에 있는 경우.
 */
export function hasAddableMembers(
  members: RosterMember[],
  channelId: string,
  selfMemberId: string
): boolean {
  return members.some(
    (m) => !uuidEq(m.id, selfMemberId) && !isChannelMember(m, channelId)
  );
}

/**
 * 멤버 하나가 채널에 추가된 뒤의 로스터. 그 멤버의 channelIds에 채널이 들어가고
 * channelCount가 하나 오른다. 멱등하다: 이미 채널에 있는 멤버를 다시 넣으면
 * 목록을 그대로 돌려주므로, 두 번 눌러도 두 번 세지 않는다(addChannelMember의
 * upsert 계약과 같은 안전성).
 *
 * 입력 배열을 건드리지 않는다(map으로 새 배열을 만든다). 그래서 훅은 이 함수를
 * 부르기 전의 배열을 스냅샷으로 쥐고 있다가, 요청이 실패하면 그대로 되돌린다
 * (롤백) — 스냅샷이 변형되지 않았음이 보장된다.
 */
export function withChannelMemberAdded(
  members: RosterMember[],
  channelId: string,
  memberId: string
): RosterMember[] {
  return members.map((m) => {
    if (!uuidEq(m.id, memberId)) return m;
    if (isChannelMember(m, channelId)) return m;
    return {
      ...m,
      channelIds: [...m.channelIds, channelId],
      channelCount: m.channelCount + 1,
    };
  });
}

/**
 * 추가가 거절됐을 때의 한 문장. 행 아래 인라인으로 붙는다(토스트 아님).
 *
 * 404가 "채널 없음/보관됨"인 이유: addChannelMember는 보관되지 않은 공개·비공개
 * 채널만 받고 DM에는 404로 답한다. 이 모달은 실제 채널에서만 열리므로, 여기서의
 * 404는 그 사이 채널이 보관되었거나 사라졌다는 뜻이다.
 */
export function addChannelMemberFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "멤버를 추가할 권한이 없습니다. 워크스페이스 오너나 관리자에게 요청하세요.";
    }
    if (error.status === 404) {
      return "이 채널에는 멤버를 추가할 수 없습니다. 채널이 보관되었거나 사라졌을 수 있습니다.";
    }
    if (error.status === 429) {
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    }
  }
  if (error instanceof NetworkError) {
    // 전송 계층이 이미 "아무도 답하지 않았다"의 문구(시간 초과 대 도달 불가,
    // 초 단위 데드라인 포함)를 쓴다. 한 실패에 두 어휘를 두지 않는다.
    return `멤버를 추가하지 못했습니다. ${error.message}`;
  }
  return "멤버를 추가하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
}
