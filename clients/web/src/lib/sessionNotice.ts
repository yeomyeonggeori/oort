// =============================================================================
// 로그인 화면이 말해 줄 두 가지 (#5221, #5201 S-C, 감사 문서 §2.1·§5).
//
// 웹·데스크탑은 지금까지 둘 다 **말없이** 로그인 화면으로 갔다. 폰은 둘 다 문장이 있었다.
//   - 로그인 만료: 리프레시가 거절돼 세션이 끝났다. 세션을 비우는 순간 `authExpired`도 같이 꺼지므로(`clearSession`),
//     화면이 읽을 사실은 **비우기 전에** 여기 남겨야 한다.
//   - 콜드 스타트에 서버가 안 닿음: 저장된 로그인은 그대로인데 복원이 끝나지 못했다(응답 없음, 또는 느려서 시간 예산이
//     지났다). 로그인 폼은 정직한 다음 걸음이지만 「저장된 로그인은 그대로 있다」는 말이 없었다.
//
// 메모리에만 둔다(저장 없음): 새로고침하면 사실이 다시 만들어진다. 불리언 둘이고 문장은 화면이 사전에서 가져온다.
// =============================================================================

let expired = false;
let unreachable = false;
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

/** 로그인했거나 로그아웃했거나 복원이 끝났다: 두 안내 모두 걷는다. */
export function clearSessionNotices(): void {
  if (!expired && !unreachable) return;
  expired = false;
  unreachable = false;
  notify();
}
