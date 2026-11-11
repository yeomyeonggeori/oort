// =============================================================================
// 독 배지 수 (#3339). 단일 출처는 `useNeedsMeCount`다: 승인 + 응답 필요 칸 + 안 읽은
// 멘션. 여기서 다시 세지 않는다. 이 함수가 하는 일은 두 가지뿐이다.
//   - 「독 배지」 스위치가 꺼졌으면 0
//   - 「새 DM도 독 배지에 세기」(기본 켬, #5660)가 켜졌으면 폰이 울리는 DM의 안 읽은 수(코어 `pushAlikeDmUnread`)를 더한다
// DM 스위치를 끈 사람에게는 needsMe 수와 정확히 같다(시험이 못박는다).
// =============================================================================

export function dockBadgeCount(
  needsMeTotal: number,
  prefs: { dockBadge: boolean; dockDms: boolean },
  unreadDms: number
): number {
  if (!prefs.dockBadge) return 0;
  return needsMeTotal + (prefs.dockDms ? Math.max(0, unreadDms) : 0);
}
