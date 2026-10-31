import { useEffect, useState } from "react";

/**
 * 동작 줄이기 선호. `ExpressionImage` 안의 같은 훅은 밖으로 내보내지 않은 지역 함수라
 * 여기 한 벌을 둔다. 값은 CSS 미디어 쿼리와 같은 질문(`prefers-reduced-motion`)에 답하고,
 * 바뀌면 따라간다.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const change = () => setReduce(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduce;
}
