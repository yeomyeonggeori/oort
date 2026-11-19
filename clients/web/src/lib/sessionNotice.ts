// =============================================================================
// 로그인 화면이 말해 줄 두 가지 (#5221, #5201 S-C, 감사 문서 §2.1·§5).
//
// 웹·데스크탑은 지금까지 둘 다 **말없이** 로그인 화면으로 갔다. 폰은 둘 다 문장이 있었다.
//   - 로그인 만료: 리프레시가 거절돼 세션이 끝났다. 세션을 비우는 순간 `authExpired`도 같이 꺼지므로(`clearSession`),
//     화면이 읽을 사실은 **비우기 전에** 여기 남겨야 한다.
//   - 콜드 스타트에 서버가 안 닿음: 저장된 로그인은 그대로인데 복원이 끝나지 못했다(응답 없음, 또는 느려서 시간 예산이
//     지났다). 로그인 폼은 정직한 다음 걸음이지만 「저장된 로그인은 그대로 있다」는 말이 없었다.
//
//   - 서버를 바꿔 앞 서버의 로그인을 끝냈다(#5816): 저장된 로그인이 있는 채 다른 서버로 바꾸면 그 로그인은 앞 서버에서 끝난다.
//     그때는 「저장된 로그인은 그대로」가 사실이 아니므로 그 안내를 걷고, 어느 서버의 로그인이 끝났는지를 남긴다.
//
// 메모리에만 둔다(저장 없음): 새로고침하면 사실이 다시 만들어진다. 문장은 화면이 사전에서 가져온다.
// =============================================================================

let expired = false;
let unreachable = false;
/** 서버를 바꿔 로그인을 끝낸 앞 서버의 주소. 없으면 null. */
let switchedFrom: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeSessionNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionExpiredNotice(): boolean {
  return expired;
}

export function getBootUnreachableNotice(): boolean {
  return unreachable;
}

export function getServerSwitchSignedOutNotice(): string | null {
  return switchedFrom;
}

/** 로그인이 만료돼 세션이 비워진다. 비우기 **전에** 부른다. */
export function markSessionExpiredNotice(): void {
  if (expired) return;
  expired = true;
  notify();
}

/** 저장된 로그인은 남아 있는데 복원이 끝나지 못했다. */
export function markBootUnreachableNotice(): void {
  if (unreachable) return;
  unreachable = true;
  notify();
}

/**
 * 저장된 로그인이 있는 채 서버를 바꿔 그 로그인을 앞 서버(`previousBase`)에서 끝냈다. 저장된 로그인이 더는 없으니 다른 두 안내는 걷는다.
 * 새로 로그인할 때(`clearSessionNotices`)까지 남는다: 복원이 「아무것도 남지 않음」으로 끝나도 이 사실은 그대로다.
 */
export function markServerSwitchSignedOutNotice(previousBase: string): void {
  if (switchedFrom === previousBase && !expired && !unreachable) return;
  switchedFrom = previousBase;
  expired = false;
  unreachable = false;
  notify();
}

/** 로그인했거나 로그아웃했거나 복원이 끝났다: 만료·서버 안 닿음 안내를 걷는다. `keepServerSwitch`면 서버를 바꿔 끝낸 사실은 남긴다. */
export function clearSessionNotices(options: { keepServerSwitch?: boolean } = {}): void {
  const dropSwitch = !options.keepServerSwitch && switchedFrom !== null;
  if (!expired && !unreachable && !dropSwitch) return;
  expired = false;
  unreachable = false;
  if (dropSwitch) switchedFrom = null;
  notify();
}
