// 알림 규칙 질의의 열쇠 (#2899). 설정 › 알림이 읽고 쓰는 캐시 한 칸이고, 사이드바의
// 프로필 메뉴도 이 열쇠를 **무효화**한다: 방해 금지를 고르거나 풀면 서버가 같은
// 트랜잭션에서 알림 일시 중지를 켜거나 되돌리므로(ADR-0124 증보 2 「묶어」), 설정의
// 스위치가 옛 값을 그리지 않게 하려면 두 자리가 같은 열쇠를 써야 한다. 한 글자라도 다르면
// 「메뉴에서 바꿨는데 설정은 옛 값」이 된다. 폰은 같은 열쇠를 `selfStatus.ts` 에 갖는다.
export const notificationRulesQueryKey = (workspaceId: string) =>
  ["settings", "notification-rules", workspaceId] as const;
