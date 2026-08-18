import { useSyncExternalStore } from "react";

// =============================================================================
// 키 배치 설명은 배운 사람에게 계속 하지 않는다 (U4-f · 진단 M-7).
//
// 진단의 한 문장: *"두 번째 메시지부터는 읽을 필요 없는 문장이 계속 있다."*
// 컴포저 아래 「Enter로 보내기 · Shift+Enter로 줄바꿈」(#1384 전까지는 쉼표로
// 이어져 있었다 — 표기는 이제 코어 `composerCopy.ts` 가 든다)은 넓은 뷰포트에서 상시로
// 서 있었다. 그 줄이 처음 필요한 이유는 진짜다 — goal B8이 ↵의 뜻을 줄바꿈에서
// 전송으로 바꿨고, 바뀐 키가 어디로 갔는지는 그 자리에서 말해야 한다. 그러나
// 그것은 **한 번 배우면 되는 사실**이고, 이 앱은 이미 같은 종류의 결정을 한 번
// 내려 두었다(`timeline/LongPressHint.tsx`: 제스처를 한 번 쓰면 줄이 사라진다).
//
// 그래서 같은 기계를 쓴다. 다른 것은 「배웠다」의 정의뿐이다:
//
//   * 롱프레스 힌트는 **그 제스처를 실제로 쓴 순간** 배웠다고 친다.
//   * 여기서는 **Enter로 한 번 보낸 순간**이다. 버튼으로 보낸 것은 세지 않는다 —
//     그 사람은 키가 어디 있는지 아직 모르고, 이 줄은 정확히 그 사람을 위한 것이다.
//
// 줄을 사람이 직접 닫는 문은 두지 않는다. 롱프레스 힌트에 닫기가 있는 이유는 그
// 줄이 컴포저 위 **한 겹**을 통째로 차지하기 때문이고, 이 줄은 이미 있던 힌트
// 줄의 한 조각이라 닫기 버튼을 붙이면 안내보다 컨트롤이 커진다.
//
// DM 힌트(「멘션 없이 바로 말하면 …가 답합니다」)는 이 규칙 밖이다. 그것은 키
// 배치가 아니라 **이 방의 성질**이고, 방마다 다르므로 한 번 배워서 끝나지 않는다.
// =============================================================================

const STORAGE_KEY = "momo.composer.send-key-learned";

function read(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // 사파리 프라이빗 모드는 저장소 접근 자체를 던진다. 기억하지 못하는 것은
    // 한 줄을 한 번 더 보는 것이지 앱이 서지 못하는 것이 아니다.
    return false;
  }
}

let learned = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 기기는 이제 ↵가 전송이라는 것을 안다. Enter로 보낸 그 자리에서 불린다. */
export function rememberSendLearned(): void {
  if (learned) return;
  learned = true;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, "1");
    }
  } catch {
    /* 위와 같다: 기억하지 못해도 이번 세션 동안은 사라진 채로 있다 */
  }
  for (const listener of listeners) listener();
}

/** 테스트와 캡처가 초기 상태로 돌리기 위한 문. */
export function forgetSendLearned(): void {
  learned = false;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* 위와 같다 */
  }
  for (const listener of listeners) listener();
}

/**
 * 이 기기에 아직 키 배치 설명이 필요한가.
 *
 * 서버 스냅샷이 `true`인 것은 의도다: 서버에서 그린 첫 프레임은 「모른다」쪽으로
 * 서야, 배운 적 없는 사람이 첫 화면에서 그 줄을 본다.
 */
export function useSendHintNeeded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !learned,
    () => true
  );
}
