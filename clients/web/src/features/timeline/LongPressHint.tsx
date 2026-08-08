import { useCallback, useSyncExternalStore } from "react";

// =============================================================================
// 폰에서 액션이 있다는 사실 (B11 R2 H4).
//
// **문제.** 폰의 진입점은 길게 누르기 하나이고, 제스처는 보이지 않는다. 액션
// 열은 hover가 있는 기기에만 있고(tokens.css `pointer-only`), 반응이 없는
// 메시지에는 칩 줄도 없다. 그래서 폰에는 "여기서 무언가 할 수 있다"고 말하는
// 것이 화면에 하나도 없었다.
//
// **왜 행마다 버튼을 두지 않았나.** 손가락 타깃은 44px이다. 한 줄짜리 메시지가
// 32px인 목록에서 행마다 44px 컨트롤을 얹으면 한 화면에 들어가던 메시지 수가
// 눈에 띄게 줄고, 그것도 스무 번 반복되는 ⋯로 줄어든다. 밀도는 이 제품이 가진
// 것 중 하나다.
//
// **그래서 한 번만 말한다.** 컴포저 위 한 줄, 손가락 기기에서만. 길게 누르기를
// 한 번 쓰면 그 줄은 스스로 사라진다 — 배운 사람에게 계속 가르치지 않는 것이
// "과설명 금지"의 실무적인 뜻이다. 직접 닫아도 같다. 어느 쪽이든 이 기기에서는
// 다시 나오지 않는다.
// =============================================================================

const STORAGE_KEY = "momo.timeline.long-press-learned";

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

/**
 * 이 기기는 이제 제스처를 안다. 시트가 실제로 열린 순간과 사람이 줄을 닫은
 * 순간, 두 곳에서 불린다.
 */
export function rememberLongPressLearned(): void {
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
export function forgetLongPressLearned(): void {
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

export function LongPressHint() {
  const known = useSyncExternalStore(
    subscribe,
    () => learned,
    () => true
  );
  const dismiss = useCallback(() => rememberLongPressLearned(), []);
  if (known) return null;
  return (
    <p
      // `touch-only`: hover가 있는 기기는 행의 ⋯를 보고 있으므로 이 줄이 할 말이
      // 없다. 같은 축(hover)으로 가르는 것이 이 배치의 규칙이다.
      className="touch-only flex items-center justify-between gap-2 border-t border-line px-4 text-meta text-ink-muted"
      data-testid="long-press-hint"
    >
      메시지를 길게 누르면 답글·반응·고치기
      <button
        type="button"
        onClick={dismiss}
        data-testid="long-press-hint-dismiss"
        className="tap-target shrink-0 rounded-sm px-2 underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        닫기
      </button>
    </p>
  );
}
