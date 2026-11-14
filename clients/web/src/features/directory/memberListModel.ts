import type { MembershipRole, RosterMember } from "@momo/core/lib/api";
import {
  groupDirectory,
  matchesQuery,
  normalizeQuery,
  profileEmail,
  type DirectoryGroups,
} from "@momo/core/features/directory/model";

// =============================================================================
// 멤버 탭의 이메일 규칙 (#5782, owner 2026-11-13 「각 인원들 메일주소도 저기랑 멤버 탭에서 보고 싶어」).
//
// 서버 명부는 이미 `email` 을 싣는다(openapi `RosterMember.email`). 누가 **보는가**는 화면의 가림이다:
// 워크스페이스 멤버 모두에게 보이고 **게스트 시점에서는 보이지 않는다**(owner 2026-11-14 「나머진 다
// 추천으로」 — 제안서 12번 「정해야 하는 것 1」의 추천). 서버는 지금 게스트에게도 칸을 싣는다(ADR-0219 D3 의
// 미구현 조각) — 게스트에게서 빼는 일은 서버가 해야 진짜 경계가 된다.
//
// 판정은 코어 `profileEmail` 하나다(#5780) — 멤버 프로필 창·폰 프로필 시트와 같은 함수를 쓴다.
// =============================================================================

/** 이 보는 사람이 이메일로 찾을 수 있는가 — 검색 칸의 자리 글과 「찾지 못함」 문장이 이것을 따른다. */
export function canSearchByEmail(viewerRole: MembershipRole | undefined): boolean {
  return viewerRole !== undefined && viewerRole !== "guest";
}

/** 멤버 탭의 묶음. 코어 묶음(사람·에이전트)에 「정지됨」이 더해진다(#5781). */
export interface MemberListGroups extends DirectoryGroups {
  /**
   * 정지된 사람, 이름 차례. 소유자·관리자의 명부에만 실린다(#5814) — 멤버·게스트 시점에는 늘 비어 있다. 활성 사람 사이에
   * 섞지 않고 맨 아래 따로 선다: `people` 과 머리 수(`countLabel`의 「사람 N」)는 활성 사람만이다(서버 `humanCount` 와 같은 뜻).
   */
  suspended: RosterMember[];
}

/**
 * 멤버 탭의 묶음: 이름·핸들(코어 `matchesQuery`) **또는** 이 보는 사람에게 보이는 이메일로 찾는다.
 * 이메일 찾기는 `profileEmail` 을 거친다 — 게스트가 남의 주소를 쳐서 줄이 걸리면 화면에서 가린 주소가
 * 검색 칸으로 새어 나간다.
 *
 * `total` 은 좁히기 전 명부 수 그대로다(스켈레톤·빈 상태·머리 수가 그 값을 읽는다).
 */
export function groupMemberList(
  members: RosterMember[],
  rawQuery: string,
  viewerRole: MembershipRole | undefined
): MemberListGroups {
  const query = normalizeQuery(rawQuery);
  const hit =
    query === ""
      ? members
      : members.filter(
          (member) =>
            matchesQuery(member, query) ||
            (profileEmail(viewerRole, member)?.toLowerCase().includes(query) ?? false)
        );
  const groups = groupDirectory(hit, "");
  return {
    ...groups,
    people: groups.people.filter((member) => member.status !== "suspended"),
    suspended: groups.people.filter((member) => member.status === "suspended"),
    total: members.length,
  };
}
