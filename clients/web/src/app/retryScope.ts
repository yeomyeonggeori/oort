import type { QueryClient } from "@tanstack/react-query";

// =============================================================================
// 렌더 오류 경계의 "다시 시도"가 무엇을 되돌릴 수 있는지.
//
// 재시도는 입력을 바꿔야 의미가 있다 — remount만 하면 staleTime(30s) 안에서는
// 재조회조차 없어 같은 데이터로 다시 던진다. 그렇다고 필터 없이 전부 되돌리면
// 반대 실수가 된다: 설정 한 판을 고치려는 클릭이 사이드바의 채널·로스터·미읽음을
// 함께 비워, 멀쩡했던 표면이 한 왕복 동안 자기 정체를 잘못 말한다(측정됨).
//
// 그래서 범위는 "실패한 표면이 소유한 것"까지다. 정책이 한 곳에 있어야 두 경계가
// 서로 다르게 흘러가지 않는다.
// =============================================================================

/**
 * 사이드바가 사는 데이터 — `features/workspace/useWorkspace.ts`의
 * `useChannels`(:87) · `useDirectory`(:70) · `useReadStates`(:102) 셋뿐이다.
 * 어떤 라우트의 실패도 이걸 버릴 권한은 없다.
 *
 * `inbox-mentions`는 여기 있으면 안 된다: 사이드바가 아니라 `useInbox`의
 * `useMentions`, 즉 InboxRoute가 소유한다. 그걸 셸로 분류하면 멘션 데이터
 * 때문에 던진 인박스가 재시도로 **자기를 던지게 만든 캐시를 보존**해, 이
 * 라우트에서만 "재시도는 입력을 바꿔야 한다"가 조용히 깨진다.
 */
export const SHELL_QUERY_KEYS: ReadonlySet<string> = new Set([
  "channels",
  "roster",
  "read-state",
]);

/** 설정 쿼리는 전부 ["settings", ...] 접두를 쓴다. */
export function resetSettingsQueries(client: QueryClient): void {
  void client.resetQueries({ queryKey: ["settings"] });
}

/** 라우트 실패: 셸이 소유한 것만 남기고 되돌린다. */
export function resetRouteQueries(client: QueryClient): void {
  void client.resetQueries({
    predicate: (query) => !SHELL_QUERY_KEYS.has(String(query.queryKey[0])),
  });
}
