// =============================================================================
// 세션 세대: 로그아웃·만료·복원 거절·세션 끝이 올리는 값 (ADR-0218 §14 M2.5, R2-L3).
//
// 다른 탭의 진행 중 다운로드가 로그아웃이 지운 칸을 되살려 쓰지 못하게, 저장소는 **쓰기 직전과 쓴 직후** 이 값이 칸을 열 때와 같은지 본다.
// **탭 사이에 공유되는 값이어야 한다**(R2-L3): 그래서 `localStorage`의 한 값이다. 탭마다 메모리에 두면 다른 탭의 늦은 쓰기를 막지 못한다.
// `localStorage`를 쓸 수 없으면(`null`) 디스크 저장소를 켜지 않는다(닫힌 쪽).
//
// 잎(leaf): 앱 모듈을 import하지 않는다. 비밀이 아니다(그냥 바뀌었다는 표지).
// =============================================================================

const GENERATION_KEY = "oort.expressions.disk.generation.v1";

function fresh(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // 아래의 대체 값을 쓴다.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 지금 세대. 한 번도 없었으면 만든다. `localStorage`를 못 쓰면 `null`. */
export function ensureSessionGeneration(): string | null {
  try {
    const current = localStorage.getItem(GENERATION_KEY);
    if (current !== null && current !== "") return current;
    const created = fresh();
    localStorage.setItem(GENERATION_KEY, created);
    return created;
  } catch {
    return null;
  }
}

/** 지금 세대를 **만들지 않고** 읽는다(없거나 못 읽으면 `null`). */
export function readSessionGeneration(): string | null {
  try {
    const current = localStorage.getItem(GENERATION_KEY);
    return current === null || current === "" ? null : current;
  } catch {
    return null;
  }
}

/** 세대를 올린다(세션이 끝났다). 어떤 실패도 던지지 않는다. */
export function bumpSessionGeneration(): void {
  try {
    localStorage.setItem(GENERATION_KEY, fresh());
  } catch {
    // 못 쓰는 환경에서는 디스크 저장소도 켜지지 않았다.
  }
}
