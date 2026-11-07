import {useSyncExternalStore} from 'react';
import {unfurlHeightMemory} from '../../storage/measureMemory';

// =============================================================================
// 링크 카드 묶음이 차지하던 높이를 기억한다 (#5451).
//
// 링크가 든 메시지의 카드는 방을 열고 **한 번 더 읽어야** 온다(`useMessageUnfurls` — 메시지마다 한 번). 읽기가 끝나기 전에는 그 줄에 카드가 없고,
// 끝나면 줄이 카드만큼 자라서 위 줄들이 밀렸다(들어올 때마다). 같은 메시지의 카드 묶음이 지난번에 차지한 높이를 기억해 두었다가, 카드가 오기 전에 그만큼
// 비워 두면 카드가 와도 높이가 같다. 처음 보는 메시지는 기억이 없어 그대로 자란다(한 번만 — 다음부터 기억한다).
//
// 읽었더니 보여 줄 카드가 없으면 기억을 지운다(`forgetUnfurlHeight`) — 빈 자리가 영영 남지 않게. 기억하는 것은 **메시지 id → 높이 숫자 하나**뿐이다.
// =============================================================================

const key = (messageId: string): string => messageId.toLowerCase();

/** 카드 묶음의 높이(pt)를 기억한다. 0·유한하지 않은 값은 받지 않는다. */
export function rememberUnfurlHeight(messageId: string, height: number): void {
  if (!(Number.isFinite(height) && height > 0)) return;
  unfurlHeightMemory.set(key(messageId), [Math.round(height * 100) / 100]);
}

/** 이 메시지의 카드는 없다 — 기억한 자리를 지운다. */
export function forgetUnfurlHeight(messageId: string): void {
  unfurlHeightMemory.delete(key(messageId));
}

/** 이 메시지의 카드 묶음이 차지하던 높이. 모르면 `null`. */
export function unfurlReserveFor(messageId: string): number | null {
  const remembered = unfurlHeightMemory.get(key(messageId));
  return remembered === null ? null : remembered[0];
}

/** 위 값을 구독한다 — 기억이 바뀌면(지워지면) 그 줄의 빈 자리도 따라간다. `messageId` 가 없으면 항상 `null`. */
export function useUnfurlReserve(messageId: string | undefined): number | null {
  return useSyncExternalStore(
    unfurlHeightMemory.subscribe,
    () => (messageId === undefined ? null : unfurlReserveFor(messageId)),
  );
}
