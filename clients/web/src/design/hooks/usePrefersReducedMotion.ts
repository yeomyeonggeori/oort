import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * OS 「동작 줄이기」를 다시 그리는 값으로 읽는다. 설정이 앱이 떠 있는 동안 바뀌어도
 * 따라간다. 온보딩 전환(`transitionFor`)과 코메토 표정 모션(#2807)이 같은 값을 본다.
 * matchMedia가 없는 환경(서버 렌더·옛 jsdom)은 false다.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(QUERY);
      mq.addEventListener("change", onStoreChange);
      return () => mq.removeEventListener("change", onStoreChange);
    },
    () =>
      typeof window !== "undefined" && !!window.matchMedia
        ? window.matchMedia(QUERY).matches
        : false,
    () => false
  );
}
