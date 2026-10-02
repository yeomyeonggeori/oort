// =============================================================================
// 독 배지 수 (#3339). 단일 출처는 `useNeedsMeCount`다: 승인 + 응답 필요 칸 + 안 읽은
// 멘션. 여기서 다시 세지 않는다. 이 함수가 하는 일은 두 가지뿐이다.
//   - 「독 배지」 스위치가 꺼졌으면 0
//   - 「안 읽은 DM도 합산」(기본 끔)이 켜졌으면 그 수를 더한다
// 기본 설정에서는 needsMe 수와 정확히 같다(시험이 못박는다).
// =============================================================================

export function dockBadgeCount(
  needsMeTotal: number,
  prefs: { dockBadge: boolean; dockDm: boolean },
  unreadDms: number
): number {
  if (!prefs.dockBadge) return 0;
  return needsMeTotal + (prefs.dockDm ? Math.max(0, unreadDms) : 0);
}
