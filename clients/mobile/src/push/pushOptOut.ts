import {useSyncExternalStore} from 'react';

import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';

// =============================================================================
// 「이 폰으로는 푸시를 받지 않는다」 — 사람이 껐다는 기억 (#3924, ADR-0204 D1).
//
// 프로필 시트의 「푸시 알림」 스위치는 이 폰의 것이다. 끄면 서버의 이 기기 토큰이
// 무효가 되고(`revokeOwnDevice`), 여기에 **사람이 껐다**가 남는다. `PushProvider` 는
// 이 값이 지금 로그인한 멤버의 것이면 다음 실행에도 이 기기를 다시 등록하지 않는다.
// 이 기억이 없으면 껐던 폰이 앱을 다시 켜는 순간 스스로 등록해 스위치가 거짓말이 된다.
//
// ## 무엇을 기억하는가
//
// OS 가 거부했다는 사실은 여기에 없다. 그것은 iOS 가 들고 있고 `permissionStatus.ts` 가
// 읽는다. 여기에는 사람이 **앱 안에서** 한 선택 하나만 있다. 스위치가 켜져 보이는 조건은
// 「OS 허용 **그리고** 사람이 끄지 않음」이다.
//
// ## 값은 멤버 id 다
//
// 불리언이 아니다. 세션이 로그아웃 없이 끝나는 길(토큰 만료)에서는 이 값이 지워지지
// 않는다. 그 폰에 다른 사람이 들어오면 앞 사람의 「껐다」가 그 사람의 알림을 막는다 —
// 멤버 id 를 같이 적으면 그 사람에게는 껐던 적이 없는 폰이다. 명시적 로그아웃은
// 어느 쪽이든 지운다(`clearPushOptOut`).
//
// ## 읽는 쪽이 둘이다
//
// 스위치(프로필 시트)와 등록(`PushProvider`)이 같은 값을 본다. 등록 효과는 이 값이
// 바뀌면 다시 돌아야 한다(껐다 켠 폰이 앱을 다시 켜지 않고도 등록하려면), 그래서
// 읽기만이 아니라 구독도 있다.
// =============================================================================

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 이 멤버가 이 폰의 푸시를 껐는가. */
export function isPushOptedOut(memberId: string): boolean {
  return nonSecretStore().getString(NON_SECRET_KEYS.pushOptOut) === memberId;
}

/**
 * 사람이 스위치로 껐다(`true`) / 다시 켰다(`false`).
 *
 * 다시 켤 때는 **자기 값만** 지운다. 다른 멤버의 값이 남아 있으면 그 사람의 기억이고
 * (이 키는 한 폰에 하나다), 이 호출이 지울 것이 아니다.
 */
export function setPushOptedOut(memberId: string, optedOut: boolean): void {
  const store = nonSecretStore();
  if (optedOut) {
    store.set(NON_SECRET_KEYS.pushOptOut, memberId);
  } else if (isPushOptedOut(memberId)) {
    store.remove(NON_SECRET_KEYS.pushOptOut);
  } else {
    return;
  }
  emit();
}

/** 로그아웃이 지운다 — 누가 껐든. 다음 로그인은 처음 보는 폰처럼 등록한다. */
export function clearPushOptOut(): void {
  const store = nonSecretStore();
  if (store.getString(NON_SECRET_KEYS.pushOptOut) === undefined) return;
  store.remove(NON_SECRET_KEYS.pushOptOut);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 이 멤버가 껐는가 — 바뀌면 다시 그린다. 스냅샷은 불리언이라 `useSyncExternalStore` 가
 * 요구하는 「같은 상태면 같은 값」을 그대로 지킨다.
 */
export function usePushOptedOut(memberId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isPushOptedOut(memberId),
    () => false,
  );
}
