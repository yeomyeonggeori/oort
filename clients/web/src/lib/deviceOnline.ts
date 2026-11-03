/**
 * 기기가 아는 온라인 여부(`navigator.onLine`). 모르면 `null`: 모르면 오프라인이라 말하지 않는다. 실패의 원인을 가를 때
 * (`@momo/core/features/connection/failure`) 그 순간의 값을 넘긴다. 화면이 구독하는 값(`useBrowserOffline`)이 아니라
 * 지금 한 번 읽는 값이다.
 */
export function deviceOnlineNow(): boolean | null {
  return globalThis.navigator?.onLine ?? null;
}
